// MV3 service worker (do not use URL.createObjectURL — not available here).
importScripts("config_utils.js", "native_client.js");

const BUILD_ID = "1.121.0";
let activeRun = null;
let downloadUiSuppressed = false;
const ENABLE_DOWNLOAD_UI_SUPPRESSION = true;
const runDownloadIds = new Set();
let pendingRunEnd = false;

chrome.downloads.onCreated.addListener((item) => {
  if (downloadUiSuppressed) {
    runDownloadIds.add(item.id);
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!downloadUiSuppressed) {
    return;
  }
  if (!delta?.id || !delta.state?.current) {
    return;
  }
  if (delta.state.current !== "complete" && delta.state.current !== "interrupted") {
    return;
  }
  if (!runDownloadIds.has(delta.id)) {
    return;
  }
  chrome.downloads.erase({ id: delta.id }).catch(() => {});
  runDownloadIds.delete(delta.id);
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!activeRun || activeRun.useNativeDownload) {
    return;
  }
  const relativeDir = activeRun.downloadRelativeDir ?? "";
  const original = sanitizeFilename(item.filename || "attachment.bin");
  const prefix = activeRun.filenamePrefix ? `${activeRun.filenamePrefix}__` : "";
  const relative = joinRelative(relativeDir, `${prefix}${original}`);
  suggest({
    filename: relative,
    conflictAction: "uniquify",
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_START") {
    activeRun = {
      downloadRelativeDir: "",
      filenamePrefix: String(message.filenamePrefix || ""),
      useNativeDownload: true,
      targetDir: String(message.targetDir || ""),
    };
    beginDownloadUiSuppression().catch(() => {});
    connectNativeHost(activeRun.targetDir)
      .then(() => sendResponse({ ok: true, native: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }
  if (message?.type === "RUN_END") {
    activeRun = null;
    pendingRunEnd = true;
    Promise.resolve()
      .then(() => waitForRunDownloadsToFinish())
      .catch(() => {})
      .then(() => disconnectNativeHost())
      .then(() => endDownloadUiSuppression())
      .finally(() => {
        pendingRunEnd = false;
      });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "PING") {
    sendResponse({ ok: true, build: BUILD_ID });
    return true;
  }
  if (message?.type === "DOWNLOAD_URL") {
    saveAttachmentViaNative(message.url, message.filename)
      .then((ok) => sendResponse({ ok }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => {
  ensureGmailContentScriptsInjected().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  ensureGmailContentScriptsInjected().catch(() => {});
});

async function ensureGmailContentScriptsInjected() {
  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  for (const tab of tabs) {
    if (tab.id === undefined) {
      continue;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["config_utils.js", "content.js"],
      });
    } catch (_error) {
      // Tab may be a restricted Gmail page state; ignore and continue.
    }
  }
}

async function findTargetGmailTabId() {
  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  if (!tabs.length) {
    throw new Error("No Gmail tab found. Open Gmail and the target email first.");
  }

  const openMailTab = tabs.find((tab) =>
    /#(?:inbox|all|sent|starred|important|search)\/[^/?#]+/i.test(tab.url || "")
  );
  if (openMailTab?.id !== undefined) {
    return openMailTab.id;
  }

  const activeTab = tabs.find((tab) => tab.active && tab.id !== undefined);
  if (activeTab?.id !== undefined) {
    return activeTab.id;
  }

  const first = tabs.find((tab) => tab.id !== undefined);
  if (first?.id !== undefined) {
    return first.id;
  }

  throw new Error("No usable Gmail tab id found.");
}

async function saveAttachmentViaNative(url, filename) {
  if (!url) {
    return false;
  }
  const targetDir = String(activeRun?.targetDir || "").trim();
  if (!targetDir) {
    throw new Error("Native download target_dir is missing.");
  }
  const safeName = buildPrefixedFilename(filename);
  const tabId = await findTargetGmailTabId();
  const fetched = await chrome.tabs.sendMessage(tabId, {
    type: "FETCH_ATTACHMENT_BYTES",
    url,
  });
  if (!fetched?.ok || !fetched?.base64) {
    return false;
  }
  await saveBase64ViaNative(safeName, fetched.base64, targetDir);
  return true;
}

function buildPrefixedFilename(filename) {
  const safeName = sanitizeFilename(filename || "attachment.bin");
  const prefix = activeRun?.filenamePrefix ? `${activeRun.filenamePrefix}__` : "";
  return `${prefix}${safeName}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
  return String(name).replace(/[<>:"/\\|?*]+/g, "_");
}

function joinRelative(dir, file) {
  const base = String(dir || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const name = String(file || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!base || base === ".") {
    return name;
  }
  return `${base}/${name}`;
}

async function beginDownloadUiSuppression() {
  if (!ENABLE_DOWNLOAD_UI_SUPPRESSION) {
    downloadUiSuppressed = false;
    return;
  }
  if (!chrome.downloads?.setUiOptions) {
    return;
  }
  try {
    await chrome.downloads.setUiOptions({ enabled: false });
    downloadUiSuppressed = true;
    runDownloadIds.clear();
  } catch (_error) {
    downloadUiSuppressed = false;
  }
}

async function endDownloadUiSuppression() {
  if (!ENABLE_DOWNLOAD_UI_SUPPRESSION) {
    downloadUiSuppressed = false;
    runDownloadIds.clear();
    return;
  }
  if (!downloadUiSuppressed || !chrome.downloads?.setUiOptions) {
    runDownloadIds.clear();
    return;
  }
  try {
    await chrome.downloads.setUiOptions({ enabled: true });
  } catch (_error) {
    // Another extension may still have the download UI disabled.
  }
  downloadUiSuppressed = false;
  runDownloadIds.clear();
}

async function waitForRunDownloadsToFinish(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pendingRunEnd) {
      return;
    }
    if (!runDownloadIds.size) {
      return;
    }
    const ids = [...runDownloadIds];
    const items = await chrome.downloads.search({});
    const byId = new Map(items.map((item) => [item.id, item]));
    let hasInProgress = false;
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) {
        runDownloadIds.delete(id);
        continue;
      }
      if (item.state === "in_progress") {
        hasInProgress = true;
      }
    }
    if (!hasInProgress) {
      return;
    }
    await sleep(400);
  }
}
