// MV3 service worker (do not use URL.createObjectURL — not available here).
importScripts("config_utils.js", "window_utils.js", "native_client.js");

const BUILD_ID = "1.120.0";
let activeRun = null;
let jobStarted = false;
let downloadUiSuppressed = false;
const ENABLE_DOWNLOAD_UI_SUPPRESSION = true;
const runDownloadIds = new Set();
let pendingRunEnd = false;
let activeRunContext = null;

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
  if (!activeRun) {
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
      downloadRelativeDir:
        message.downloadRelativeDir !== undefined &&
        message.downloadRelativeDir !== null
          ? String(message.downloadRelativeDir)
          : "",
      filenamePrefix: message.filenamePrefix || "",
      useNativeDownload: Boolean(message.useNativeDownload),
      targetDir: String(message.targetDir || ""),
    };
    if (activeRun.useNativeDownload) {
      connectNativeHost(activeRun.targetDir)
        .then(() => sendResponse({ ok: true, native: true }))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }
    beginDownloadUiSuppression().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "RUN_END") {
    activeRun = null;
    pendingRunEnd = true;
    const context = activeRunContext;
    activeRunContext = null;
    const finish = async () => {
      if (context?.useNativeDownload) {
        disconnectNativeHost();
        pendingRunEnd = false;
        return;
      }
      await waitForRunDownloadsToFinish().catch(() => {});
      if (context?.needsRelocate) {
        await requestRelocateFromContext(context).catch(() => {});
      }
      pendingRunEnd = false;
      await endDownloadUiSuppression();
    };
    finish().catch(() => {
      pendingRunEnd = false;
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "RUN_CONTEXT") {
    activeRunContext = {
      needsRelocate: Boolean(message.needsRelocate),
      useNativeDownload: Boolean(message.useNativeDownload),
      stagingDir: String(message.stagingDir || ""),
      targetDir: String(message.targetDir || ""),
      launcherPort: Number(message.launcherPort || 8765),
      filenamePrefix: String(message.filenamePrefix || ""),
    };
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "START_RUN") {
    jobStarted = false;
    startRunJob()
      .then(() => sendResponse({ ok: true, build: BUILD_ID }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }
  if (message?.type === "PING") {
    sendResponse({ ok: true, build: BUILD_ID });
    return true;
  }
  if (message?.type === "DOWNLOAD_URL") {
    saveAttachmentViaNativeOrChrome(message.url, message.filename)
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

async function createAutomationWindow(url, _config) {
  return openAutomationTab(url);
}

async function closeAutomationWindow(windowId) {
  await releaseAutomationWindow(windowId);
}

async function startRunJob() {
  if (jobStarted) {
    return;
  }
  jobStarted = true;

  let config;
  let port = 8765;

  try {
    config = await loadConfig();
  } catch (error) {
    await reportStatus(8765, {
      ok: false,
      error: `Config load failed: ${String(error?.message || error)}`,
      stage: "finished",
    });
    jobStarted = false;
    return;
  }

  try {
    port = config.launcher_port || 8765;
    await beginDownloadUiSuppression();
    await reportStatus(port, { ok: true, stage: "extension_ready", build: BUILD_ID });

    const processed = Array.isArray(config.processed_email_ids)
      ? config.processed_email_ids
      : [];
    await chrome.storage.local.set({
      runtime_config: normalizeDownloadConfig(config),
      processed_email_ids: processed,
    });

    const tabId = await findTargetGmailTabId();
    let result;
    try {
      result = await runOnTab(tabId, config);
    } catch (error) {
      result = {
        ok: false,
        error: String(error?.message || error),
        downloaded: 0,
      };
    }
    if (Number(result?.downloaded || 0) > 0) {
      await waitForActiveDownloads(120000);
      await sleep(1500);
      await requestRelocate(port, config);
    }
    await reportStatus(port, {
      ...result,
      stage: "finished",
      build: BUILD_ID,
      save_dir: config.configured_download_dir,
    });
    await sleep(1000);
  } catch (error) {
    await reportStatus(port, {
      ok: false,
      error: String(error?.message || error),
      downloaded: 0,
      stage: "finished",
      build: BUILD_ID,
    });
  } finally {
    await endDownloadUiSuppression();
    jobStarted = false;
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

async function runOnTab(tabId, config) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "EXECUTE_RUN" });
      if (result) {
        return result;
      }
    } catch (_error) {
      await sleep(2500);
    }
  }
  throw new Error("Could not communicate with Gmail content script.");
}

async function loadConfig() {
  const response = await fetch(chrome.runtime.getURL("config.runtime.json"));
  if (!response.ok) {
    throw new Error("Failed to read config.runtime.json");
  }
  const raw = await response.json();
  if (!raw.account_email) {
    throw new Error("account_email is required in config.runtime.json");
  }
  return normalizeDownloadConfig(raw);
}

async function reportStatus(port, payload) {
  const finalPayload = { ...payload, stage: payload.stage || "finished" };
  try {
    await fetch(`http://127.0.0.1:${port}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(finalPayload),
    });
  } catch (_error) {
    // Launcher persists status when it receives this POST.
  }
}

function shouldUseNativeDownload() {
  return Boolean(activeRun?.useNativeDownload);
}

async function saveAttachmentViaNativeOrChrome(url, filename) {
  if (!url) {
    return false;
  }
  if (shouldUseNativeDownload()) {
    return saveAttachmentViaNative(url, filename);
  }
  return downloadAttachmentUrl(url, filename);
}

async function saveAttachmentViaNative(url, filename) {
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

async function downloadAttachmentUrl(url, filename) {
  if (!url) {
    return false;
  }
  await beginDownloadUiSuppression();
  const relativePath = joinRelative(
    activeRun?.downloadRelativeDir ?? "",
    buildPrefixedFilename(filename)
  );
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename: relativePath,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          resolve(false);
          return;
        }
        runDownloadIds.add(downloadId);
        resolve(true);
      }
    );
  });
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

async function requestRelocate(port, config) {
  if (!config?.needs_relocate) {
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/relocate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        staging_dir: config.staging_dir || "",
        target_dir: config.configured_download_dir || "",
      }),
    });
  } catch (_error) {
    // Launcher may not be running if the extension was triggered outside run_downloader.bat.
  }
}

async function waitForActiveDownloads(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inProgress = await chrome.downloads.search({ state: "in_progress" });
    if (!inProgress.length) {
      return;
    }
    await sleep(500);
  }
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

async function requestRelocateFromContext(context) {
  if (!context?.needsRelocate) {
    return;
  }
  const stagingDir = String(context.stagingDir || "");
  const targetDir = String(context.targetDir || "");
  if (!stagingDir || !targetDir) {
    return;
  }
  await fetch(`http://127.0.0.1:${context.launcherPort || 8765}/relocate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      staging_dir: stagingDir,
      target_dir: targetDir,
      filename_prefix: String(context.filenamePrefix || ""),
    }),
  });
}
