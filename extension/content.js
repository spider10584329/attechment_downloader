const AUTO_RUN_DEBOUNCE_MS = 1200;
let autoRunTimer = null;
let autoRunInFlight = false;
const attemptedMessageIds = new Set();
let lastInteractedMessageNode = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FETCH_ATTACHMENT_BYTES") {
    fetchAttachmentBytes(message.url)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }
  if (message?.type !== "EXECUTE_RUN") {
    return false;
  }

  executeRun()
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: String(error?.message || error),
        downloaded: 0,
        stage: "finished",
      })
    );

  return true;
});

function sanitizeProcessedIds(processedList) {
  const threadId = getThreadIdFromUrl();
  return (Array.isArray(processedList) ? processedList : []).filter((entry) => {
    const value = String(entry || "").trim();
    if (!value) {
      return false;
    }
    if (threadId && (value === threadId || isThreadLevelId(value, threadId))) {
      return false;
    }
    return true;
  });
}

async function executeRun(options = {}) {
  const stored = await chrome.storage.local.get([
    "processed_email_ids",
  ]);
  const sanitizedProcessed = sanitizeProcessedIds(stored.processed_email_ids);
  if (sanitizedProcessed.length !== (stored.processed_email_ids || []).length) {
    await chrome.storage.local.set({ processed_email_ids: sanitizedProcessed });
  }
  // Always re-read the runtime file so path changes in config.runtime.json
  // are applied immediately in auto mode.
  const config = normalizeDownloadConfig(await loadConfig());
  await chrome.storage.local.set({ runtime_config: config });

  try {
    const result = await runDownloader(
      config,
      sanitizedProcessed,
      options
    );
    return { ...result, stage: "finished" };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      downloaded: 0,
      stage: "finished",
    };
  } finally {
    chrome.runtime.sendMessage({ type: "RUN_END" });
  }
}

async function writeAutoRunStatus(payload) {
  try {
    await chrome.storage.local.set({
      last_auto_run_status: {
        at: new Date().toISOString(),
        url: window.location.href,
        ...payload,
      },
    });
  } catch (_error) {
    // Diagnostics should never block downloader logic.
  }
}

function scheduleAutoRun(reason) {
  if (autoRunTimer) {
    clearTimeout(autoRunTimer);
  }
  autoRunTimer = setTimeout(() => {
    autoRunTimer = null;
    void maybeAutoRun(reason);
  }, AUTO_RUN_DEBOUNCE_MS);
}

async function maybeAutoRun(reason) {
  const forceRun = reason === "click" || reason === "mousedown";
  if (autoRunInFlight) {
    await writeAutoRunStatus({
      ok: false,
      phase: "guard",
      reason,
      message: "Skipped: another auto run is in progress.",
    });
    return;
  }
  if (isLoginPage()) {
    await writeAutoRunStatus({
      ok: false,
      phase: "guard",
      reason,
      message: "Skipped: Gmail login page is open.",
    });
    return;
  }
  if (!isOpenedEmailView()) {
    await writeAutoRunStatus({
      ok: false,
      phase: "guard",
      reason,
      message: "Skipped: opened email view not detected.",
    });
    return;
  }
  const storedIds = await chrome.storage.local.get(["processed_email_ids"]);
  const processedSet = new Set(sanitizeProcessedIds(storedIds.processed_email_ids));
  const targetMessage = selectTargetMessageNode(processedSet);
  const messageId = extractOpenedEmailId(targetMessage);
  if (!messageId) {
    await writeAutoRunStatus({
      ok: false,
      phase: "guard",
      reason,
      message: "Skipped: no message id could be extracted.",
    });
    return;
  }
  if (!forceRun && processedSet.has(messageId)) {
    await writeAutoRunStatus({
      ok: true,
      phase: "guard",
      reason,
      messageId,
      message: "Skipped: message already processed.",
    });
    return;
  }
  if (!forceRun && attemptedMessageIds.has(messageId)) {
    await writeAutoRunStatus({
      ok: true,
      phase: "guard",
      reason,
      messageId,
      message: "Skipped: message already handled in this tab session.",
    });
    return;
  }

  autoRunInFlight = true;
  try {
    const result = await executeRun({ force: forceRun });
    if (result?.ok) {
      attemptedMessageIds.add(messageId);
    }
    await writeAutoRunStatus({
      ok: Boolean(result?.ok),
      phase: "run",
      reason,
      messageId,
      downloaded: Number(result?.downloaded || 0),
      resultMessage: result?.message || "",
      error: result?.error || "",
    });
    if (!result?.ok) {
      console.debug("Auto download skipped/failed:", result?.message || result?.error || "");
    }
  } catch (error) {
    await writeAutoRunStatus({
      ok: false,
      phase: "run",
      reason,
      messageId,
      error: String(error?.message || error),
    });
  } finally {
    autoRunInFlight = false;
  }
}

function initAutoDownloader() {
  void writeAutoRunStatus({
    ok: true,
    phase: "boot",
    reason: "content_script_loaded",
    message: "Auto downloader initialized on this Gmail tab.",
  });

  window.addEventListener("hashchange", () => {
    lastInteractedMessageNode = null;
    scheduleAutoRun("hashchange");
  });
  window.addEventListener("popstate", () => scheduleAutoRun("popstate"));
  window.addEventListener("focus", () => scheduleAutoRun("focus"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleAutoRun("visible");
    }
  });

  const observer = new MutationObserver(() => scheduleAutoRun("dom"));
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const mailRelated = target.closest(
        [
          "tr.zA", // mail row in list
          "[data-message-id]",
          "[data-legacy-message-id]",
          "h2.hP", // opened mail subject
          "div.aQH",
          "div.aZo",
          "div.ii.gt",
        ].join(",")
      );
      const messageContainer = normalizeMessageContainer(mailRelated);
      if (messageContainer) {
        lastInteractedMessageNode = messageContainer;
      }
      if (mailRelated) {
        scheduleAutoRun("click");
      }
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      const target = event.target;
      const hit = target instanceof Element
        ? target.closest("tr.zA, [role='main'], [data-message-id], [data-legacy-message-id], div.adn.ads")
        : null;
      const messageContainer = normalizeMessageContainer(hit);
      if (messageContainer) {
        lastInteractedMessageNode = messageContainer;
      }
      if (hit) {
        scheduleAutoRun("mousedown");
      }
    },
    true
  );

  // Gmail is a heavy SPA and some transitions do not reliably emit a single
  // deterministic event. Lightweight polling closes those gaps.
  setInterval(() => scheduleAutoRun("poll"), 2000);

  scheduleAutoRun("init");
}

async function loadConfig() {
  const url = chrome.runtime.getURL("config.runtime.json");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Failed to load config.runtime.json");
  }
  return normalizeDownloadConfig(await response.json());
}

async function runDownloader(config, processedList, options = {}) {
  if (isLoginPage()) {
    throw new Error(
      "Gmail login page detected. Close Chrome completely, then run launcher with your signed-in profile."
    );
  }

  await waitFor(() => document.readyState === "complete", 30000).catch(() => {});
  await waitForEmailOpen(30000);

  if (!isOpenedEmailView()) {
    return {
      ok: false,
      downloaded: 0,
      message:
        "Open the target Gmail email first, then run downloader again. Inbox/list view is not supported.",
      debug: describePageState(),
    };
  }

  const processed = new Set(processedList);
  const targetMessage = selectTargetMessageNode(processed);
  let emailId = extractOpenedEmailId(targetMessage);
  const detected = buildDetectedEmailFromOpenedEmail(emailId, targetMessage);

  if (targetMessage) {
    await ensureMessageExpanded(targetMessage);
    const refreshedId = extractOpenedEmailId(targetMessage);
    if (refreshedId) {
      emailId = refreshedId;
      detected.email_id = emailId;
    }
  }

  if (emailId && processed.has(emailId) && !Boolean(options.force)) {
    return {
      ok: true,
      downloaded: 0,
      message: "Opened email already processed.",
      email_id: emailId,
      detected_email: detected,
    };
  }

  const subject =
    document.querySelector("h2.hP")?.innerText?.trim() ||
    detected.subject ||
    "(no-subject)";
  detected.subject = subject;
  const timestamp = formatTimestamp(new Date());
  const filenamePrefix = `${timestamp}__${sanitizePart(subject).slice(0, 70)}`;

  const useNativeDownload = Boolean(config?.use_native_download);
  const runStart = await sendRunStart(
    resolveRunDownloadRelativeDir(config),
    filenamePrefix,
    {
      useNativeDownload,
      targetDir: String(config?.configured_download_dir || ""),
    }
  );
  if (!runStart?.ok) {
    return {
      ok: false,
      downloaded: 0,
      message: "Could not initialize extension download context.",
      error: runStart?.error || "RUN_START failed.",
      email_id: emailId || subject,
      subject,
      detected_email: detected,
      debug: describePageState(targetMessage || document),
    };
  }
  await sendRunContext(config, filenamePrefix, useNativeDownload);

  let targets = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    targets = await collectAttachmentTargetsAsync(targetMessage || document);
    if (targets.length > 0) {
      break;
    }
    await sleep(2000);
  }

  if (targets.length === 0) {
    return {
      ok: false,
      downloaded: 0,
      message: "Could not locate attachments in the opened email.",
      email_id: emailId || subject,
      subject,
      detected_email: detected,
      debug: describePageState(),
    };
  }

  let downloaded = 0;
  const openedEmailId = emailId || "";

  for (const target of targets) {
    try {
      if (target.kind === "url") {
        const ok = await requestUrlDownload(target.url, target.filename);
        if (ok) {
          downloaded += 1;
        }
      } else if (target.kind === "click") {
        target.element.scrollIntoView({ block: "center" });
        target.element.click();
        downloaded += 1;
        await sleep(3500);
      }
    } catch (_error) {
      // Continue with remaining attachments.
    }
  }

  if (downloaded > 0) {
    processed.add(openedEmailId);
    await chrome.storage.local.set({
      processed_email_ids: Array.from(processed),
    });
  }

  if (downloaded === 0) {
    return {
      ok: false,
      downloaded: 0,
      message: "Attachments were found but none could be downloaded.",
      email_id: openedEmailId,
      subject,
      detected_email: detected,
      attachment_candidates: targets.length,
      debug: describePageState(),
    };
  }

  return {
    ok: true,
    downloaded,
    email_id: openedEmailId,
    subject,
    account_email: config.account_email,
    save_dir: config.configured_download_dir,
    attachment_candidates: targets.length,
    attachment_sources: targets.map((t) => t.source || t.kind),
    detected_email: detected,
  };
}

function buildDetectedEmail(row, emailId) {
  const meta = extractRowMeta(row);
  return {
    sender: meta.sender,
    sender_email: meta.sender_email,
    subject: meta.subject,
    date: meta.date,
    is_read: meta.is_read,
    email_id: emailId || "",
    list_position: 1,
    search_note:
      "Newest row matching: to:<account> -cc:<account> has:attachment (read or unread)",
  };
}

function extractRowMeta(row) {
  const senderEmailEl = row.querySelector("span[email]");
  const sender =
    row.querySelector(".yW .yP")?.getAttribute("name") ||
    row.querySelector(".bA4")?.innerText?.trim() ||
    row.querySelector(".yW")?.innerText?.trim() ||
    senderEmailEl?.getAttribute("email") ||
    "(unknown sender)";

  const subject =
    row.querySelector(".bog")?.innerText?.trim() ||
    row.querySelector(".bqe")?.innerText?.trim() ||
    "(no subject)";

  const date =
    row.querySelector("td.xY span")?.innerText?.trim() ||
    row.querySelector(".xY")?.innerText?.trim() ||
    "(unknown date)";

  const isUnread = row.classList.contains("zE");

  return {
    sender,
    sender_email: senderEmailEl?.getAttribute("email") || "",
    subject,
    date,
    is_read: !isUnread,
  };
}

function extractEmailId(row) {
  const attrs = [
    row.getAttribute("data-legacy-thread-id"),
    row.getAttribute("data-thread-id"),
    row.querySelector("[data-legacy-thread-id]")?.getAttribute(
      "data-legacy-thread-id"
    ),
    row.querySelector("[data-thread-id]")?.getAttribute("data-thread-id"),
  ];
  for (const value of attrs) {
    if (value) {
      return value;
    }
  }
  const text = row.innerText?.trim();
  return text ? text.slice(0, 160) : "";
}

function openEmailRow(row) {
  const link = row.querySelector("a[href]");
  if (link instanceof HTMLAnchorElement && link.href) {
    try {
      const target = new URL(link.href);
      if (target.origin === window.location.origin && target.hash) {
        if (window.location.hash !== target.hash) {
          history.pushState(null, "", target.hash);
        }
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        return;
      }
    } catch (_error) {
      // Fall back to a DOM click below.
    }
  }

  row.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
  );
  if (link instanceof HTMLElement) {
    link.click();
  }
}

async function waitForEmailOpen(timeoutMs) {
  await waitFor(
    () =>
      Boolean(
        document.querySelector("h2.hP") ||
          document.querySelector("div.aQH") ||
          document.querySelector("div.aZo") ||
          document.querySelector('[data-message-id]')
      ),
    timeoutMs
  ).catch(() => {});
  await sleep(4000);
}

function isOpenedEmailView() {
  if (isLoginPage()) {
    return false;
  }
  if (document.querySelector("h2.hP")) {
    return true;
  }
  if (document.querySelector("[data-message-id]")) {
    return true;
  }
  if (document.querySelector("[data-legacy-message-id]")) {
    return true;
  }
  if (document.querySelector("div.adn.ads")) {
    return true;
  }
  const hash = window.location.hash || "";
  return /#(?:inbox|all|sent|starred|important|search)\/[^/?#]+/i.test(hash);
}

function getThreadIdFromUrl() {
  const hash = window.location.hash || "";
  const match = hash.match(/#(?:inbox|all|sent|starred|important|search)\/([^/?#]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]).trim() : "";
}

function isThreadLevelId(value, threadId = getThreadIdFromUrl()) {
  const id = String(value || "").trim();
  if (!id || !threadId) {
    return false;
  }
  const normalized = id.replace(/^#msg-f:/i, "").replace(/^msg-f:/i, "");
  return id === threadId || normalized === threadId;
}

function isMessageLevelId(value) {
  const id = String(value || "").trim();
  if (!id) {
    return false;
  }
  if (id.startsWith("#msg-f:") || id.startsWith("msg-f:")) {
    return true;
  }
  if (id.startsWith("#msg-att:") || id.startsWith("msg-att:")) {
    return true;
  }
  if (id.startsWith("#msg") || id.startsWith("msg-")) {
    return !isThreadLevelId(id);
  }
  if (/^\d{12,}$/.test(id)) {
    return !isThreadLevelId(id);
  }
  return false;
}

function readMessageIdFromElement(element) {
  if (!(element instanceof HTMLElement)) {
    return "";
  }
  const messageIdAttr = element.getAttribute("data-message-id");
  if (isMessageLevelId(messageIdAttr)) {
    return String(messageIdAttr).trim();
  }

  const legacyId = element.getAttribute("data-legacy-message-id");
  if (isMessageLevelId(legacyId)) {
    return String(legacyId).trim();
  }

  for (const child of element.querySelectorAll("[data-message-id]")) {
    const childId = child.getAttribute("data-message-id");
    if (childId && (childId.startsWith("#msg-f:") || childId.startsWith("msg-f:"))) {
      return String(childId).trim();
    }
  }
  for (const child of element.querySelectorAll("[data-message-id], [data-legacy-message-id]")) {
    const childId =
      child.getAttribute("data-message-id") ||
      child.getAttribute("data-legacy-message-id");
    if (isMessageLevelId(childId)) {
      return String(childId).trim();
    }
  }
  return "";
}

function readMessageIdFromAttachments(scopeRoot) {
  if (!(scopeRoot instanceof HTMLElement)) {
    return "";
  }
  const links = scopeRoot.querySelectorAll(
    'a[href*="view=att"], a[href*="realattid="], a[href*="attid="], a[href*="permmsgid="]'
  );
  let permmsgid = "";
  const realAttIds = [];

  for (const link of links) {
    if (!(link instanceof HTMLAnchorElement) || !link.href) {
      continue;
    }
    try {
      const url = new URL(link.href);
      const msgParam =
        url.searchParams.get("permmsgid") ||
        url.searchParams.get("simpl") ||
        "";
      if (msgParam && !permmsgid) {
        const match = msgParam.match(/msg-f:([^&]+)/i);
        if (match?.[1]) {
          permmsgid = `#msg-f:${match[1]}`;
        } else if (msgParam.startsWith("#msg-f:") || msgParam.startsWith("msg-f:")) {
          permmsgid = msgParam.startsWith("#") ? msgParam : `#${msgParam}`;
        }
      }
      const realattid = url.searchParams.get("realattid");
      if (realattid) {
        realAttIds.push(realattid);
      }
    } catch (_error) {
      // Ignore invalid URLs.
    }
  }

  if (permmsgid && isMessageLevelId(permmsgid)) {
    return permmsgid;
  }
  if (realAttIds.length) {
    const unique = [...new Set(realAttIds)].sort();
    return `#msg-att:${unique.join(",")}`;
  }

  for (const link of links) {
    if (!(link instanceof HTMLAnchorElement) || !link.href) {
      continue;
    }
    try {
      const url = new URL(link.href);
      const attid = url.searchParams.get("attid") || url.searchParams.get("realattid");
      if (attid) {
        return `#msg-att:${attid}`;
      }
    } catch (_error) {
      // Ignore invalid URLs.
    }
  }
  return "";
}

function normalizeMessageContainer(node) {
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  let current = node;
  for (let depth = 0; depth < 14 && current; depth += 1) {
    if (readMessageIdFromElement(current)) {
      return current;
    }
    if (current.classList.contains("adn") && current.classList.contains("ads")) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function extractOpenedEmailId(targetMessage) {
  if (!(targetMessage instanceof HTMLElement)) {
    return "";
  }
  const fromNode = readMessageIdFromElement(targetMessage);
  if (fromNode) {
    return fromNode;
  }
  return readMessageIdFromAttachments(targetMessage);
}

function buildDetectedEmailFromOpenedEmail(emailId, targetMessage) {
  const scopeRoot = targetMessage || document;
  const senderEmailEl = scopeRoot.querySelector("span[email]");
  const sender =
    scopeRoot.querySelector("h3.iw .gD")?.getAttribute("name") ||
    scopeRoot.querySelector("h3.iw .gD")?.innerText?.trim() ||
    scopeRoot.querySelector(".gD")?.innerText?.trim() ||
    senderEmailEl?.getAttribute("email") ||
    "(unknown sender)";
  const subject =
    document.querySelector("h2.hP")?.innerText?.trim() || "(no subject)";
  const date =
    scopeRoot.querySelector("span.g3")?.getAttribute("title") ||
    scopeRoot.querySelector("span.g3")?.innerText?.trim() ||
    "(unknown date)";

  return {
    sender,
    sender_email: senderEmailEl?.getAttribute("email") || "",
    subject,
    date,
    is_read: null,
    email_id: emailId || "",
    list_position: null,
    search_note: "Using currently opened Gmail email tab.",
  };
}

function getMessageBodyRoots(scopeRoot = document) {
  const roots = Array.from(
    scopeRoot.querySelectorAll("div.a3s.aiL, div.a3s, div.ii.gt")
  );
  if (roots.length > 0) {
    return roots;
  }
  return Array.from(scopeRoot.querySelectorAll("[data-message-id] div.a3s"));
}

function collectAttachmentTargets() {
  return findFileAttachmentUrls();
}

async function collectAttachmentTargetsAsync(scopeRoot = document) {
  const seen = new Set();
  const targets = [];
  const clickFallbackTargets = [];

  const addTarget = (target) => {
    const key = targetKey(target);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push(target);
  };

  // File attachments (PDF, DOC, ZIP, etc.) live in Gmail's attachment bar, not the body.
  for (const item of findFileAttachmentUrls(scopeRoot)) {
    addTarget(item);
  }

  const fileChipTargets = await collectFileChipTargets(scopeRoot);
  for (const item of fileChipTargets) {
    if (item.kind === "click") {
      clickFallbackTargets.push(item);
    } else {
      addTarget(item);
    }
  }

  // Inline embedded images inside the message body.
  const inlineTargets = await collectInlineImageTargets(scopeRoot);
  for (const item of inlineTargets) {
    if (item.kind === "click") {
      clickFallbackTargets.push(item);
    } else {
      addTarget(item);
    }
  }

  // Last-resort fallback: only use click targets when URL/API targets are missing.
  if (!targets.length) {
    for (const item of clickFallbackTargets) {
      addTarget(item);
    }
  }

  return targets;
}

function targetKey(target) {
  if (target.filename) {
    return `file:${String(target.filename).toLowerCase()}`;
  }
  if (target.kind === "url") {
    try {
      const url = new URL(target.url);
      const attid = url.searchParams.get("attid") || url.searchParams.get("realattid");
      if (attid) {
        return `attid:${attid}`;
      }
    } catch (_error) {
      // Ignore invalid URLs.
    }
    return `url:${target.url}`;
  }
  if (target.element) {
    return `click:${target.element.outerHTML.slice(0, 160)}`;
  }
  return String(Math.random());
}

async function collectInlineImageTargets(scopeRoot = document) {
  const targets = [];
  const images = findInlineImagesInMessage(scopeRoot);

  for (const img of images) {
    const fimgLink = findFimgLinkForImage(img, scopeRoot);
    const srcUrl = img.currentSrc || img.src || "";
    const filename = guessImageFilename(img);

    if (fimgLink) {
      targets.push({
        kind: "url",
        url: fimgLink,
        filename,
        source: "inline-image-fimg",
      });
    } else if (srcUrl && isDownloadableImageUrl(srcUrl)) {
      targets.push({
        kind: "url",
        url: srcUrl,
        filename,
        source: "inline-image-src",
      });
    }

    const hoverButton = await revealDownloadOnHover(img);
    if (hoverButton) {
      targets.push({
        kind: "click",
        element: hoverButton,
        filename,
        source: "inline-image-hover",
      });
    }
  }
  return targets;
}

function getFileAttachmentRoots(scopeRoot = document) {
  const roots = new Set();
  const selectors = ["div.aQH", "div.aYZ", "div.adn", "[data-message-id]"];
  for (const selector of selectors) {
    for (const node of scopeRoot.querySelectorAll(selector)) {
      if (
        node.querySelector(
          'a[href*="view=att"], div.aZo, span.aV3, span.aSa, div[aria-label*="Download attachment"]'
        )
      ) {
        roots.add(node);
      }
    }
  }
  for (const chip of scopeRoot.querySelectorAll("div.aQH div.aZo, div.aZo")) {
    roots.add(chip);
  }
  return Array.from(roots);
}

function findFileAttachmentUrls(scopeRoot = document) {
  const results = [];
  const seen = new Set();
  const selectors = [
    'a[href*="view=att"]',
    'a[href*="disp=safe"]',
    'a[href*="realattid="]',
    'a[download]',
  ];

  const searchIn = (root) => {
    for (const selector of selectors) {
      for (const link of root.querySelectorAll(selector)) {
        if (!(link instanceof HTMLAnchorElement)) {
          continue;
        }
        const href = link.href || link.getAttribute("href") || "";
        if (!href || href.startsWith("javascript:")) {
          continue;
        }
        if (href.includes("view=fimg")) {
          continue;
        }
        if (!href.includes("mail.google.com") && !link.hasAttribute("download")) {
          continue;
        }
        if (seen.has(href)) {
          continue;
        }
        seen.add(href);
        results.push({
          kind: "url",
          url: href,
          filename: extractFilenameFromLink(link),
          source: "file-url",
        });
      }
    }
  };

  for (const root of getFileAttachmentRoots(scopeRoot)) {
    searchIn(root);
  }

  // Fallback: file links can exist outside div.a3s but still be missed by roots above.
  searchIn(scopeRoot);
  return results;
}

async function collectFileChipTargets(scopeRoot = document) {
  const targets = [];
  const chips = Array.from(
    scopeRoot.querySelectorAll("div.aQH div.aZo, div.aQH div.aQv, div.aZo")
  ).filter((chip, index, all) => all.indexOf(chip) === index);

  for (const chip of chips) {
    if (!(chip instanceof HTMLElement) || !isVisible(chip)) {
      continue;
    }

    const filename = extractChipFilename(chip);
    const link = chip.querySelector('a[href*="view=att"], a[href*="disp=safe"]');
    if (link instanceof HTMLAnchorElement && link.href) {
      targets.push({
        kind: "url",
        url: link.href,
        filename,
        source: "file-chip-url",
      });
      continue;
    }

    chip.scrollIntoView({ block: "center" });
    triggerHover(chip);
    await sleep(500);

    const downloadButton = findDownloadButtonInChip(chip);
    if (downloadButton) {
      targets.push({
        kind: "click",
        element: downloadButton,
        filename,
        source: "file-chip-hover",
      });
    }
  }
  return targets;
}

function extractChipFilename(chip) {
  const text =
    chip.querySelector("span.aV3")?.innerText?.trim() ||
    chip.querySelector("span.aSa")?.innerText?.trim() ||
    chip.querySelector(".aV3")?.innerText?.trim() ||
    chip.querySelector("[download]")?.getAttribute("download") ||
    "";
  if (text) {
    return sanitizePart(text);
  }

  const label = chip.getAttribute("aria-label") || "";
  const match = label.match(/(?:Download attachment|Attachment)\s*[:\s]*(.+)/i);
  if (match?.[1]) {
    return sanitizePart(match[1].trim());
  }
  return "attachment.bin";
}

function findDownloadButtonInChip(chip) {
  const selectors = [
    'div[aria-label*="Download attachment"]',
    'div[aria-label^="Download "]',
    'span[data-tooltip="Download"]',
    'span[data-tooltip*="Download"]',
    'div[data-tooltip="Download"]',
    'div[data-tooltip*="Download"]',
    'div[role="button"][aria-label*="Download"]',
    "div.aQw",
  ];

  for (const selector of selectors) {
    const nodes = Array.from(chip.querySelectorAll(selector)).filter(
      (node) => node instanceof HTMLElement && isVisible(node)
    );
    for (const node of nodes) {
      const label = getElementLabel(node);
      if (/download/i.test(label) || selector.includes("aQw")) {
        return node;
      }
    }
  }
  return findDownloadButtonNear(chip);
}

function findFileAttachmentDownloadButtons(scopeRoot = document) {
  const downloadNeedle = /download attachment|download all|download/i;
  const roots = getFileAttachmentRoots(scopeRoot);
  if (roots.length === 0) {
    roots.push(scopeRoot instanceof HTMLElement ? scopeRoot : document.body);
  }

  const selectors = [
    'div[aria-label*="Download attachment"]',
    'div[aria-label*="Download all"]',
    'div[command="files"] div[role="button"]',
    'div.aQH [role="button"][aria-label*="Download"]',
    'div.aZo [role="button"][aria-label*="Download"]',
  ];

  const seen = new Set();
  const results = [];

  for (const root of roots) {
    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          continue;
        }
        const label = getElementLabel(node);
        if (!downloadNeedle.test(label)) {
          continue;
        }
        const key = node.outerHTML.slice(0, 160);
        if (!seen.has(key)) {
          seen.add(key);
          results.push(node);
        }
      }
    }
  }
  return results;
}

function findInlineImagesInMessage(scopeRoot = document) {
  const images = [];
  for (const body of getMessageBodyRoots(scopeRoot)) {
    const imgs = Array.from(body.querySelectorAll("img")).filter((img) => {
      if (!(img instanceof HTMLImageElement)) {
        return false;
      }
      const src = img.currentSrc || img.src || "";
      if (!src || src.startsWith("data:")) {
        return false;
      }
      if (
        src.includes("cleardot.gif") ||
        src.includes("/logo_gmail") ||
        src.includes("favicon")
      ) {
        return false;
      }
      const rect = img.getBoundingClientRect();
      return rect.width >= 64 && rect.height >= 64;
    });
    images.push(...imgs);
  }
  return images;
}

function isDownloadableImageUrl(url) {
  return (
    url.includes("googleusercontent.com") ||
    url.includes("mail.google.com") ||
    url.includes("view=fimg") ||
    /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(url)
  );
}

function guessImageFilename(img) {
  const alt = sanitizePart(img.getAttribute("alt") || "");
  if (alt && alt !== "unknown") {
    return `${alt}.png`;
  }
  try {
    const url = new URL(img.currentSrc || img.src);
    const last = url.pathname.split("/").pop() || "";
    if (last.includes(".")) {
      return sanitizePart(last);
    }
  } catch (_error) {
    // Ignore invalid URLs.
  }
  return "inline_image.png";
}

function findFimgLinkForImage(img, scopeRoot = document) {
  const container =
    img.closest("a[href*='view=fimg']") ||
    img.closest("div")?.querySelector("a[href*='view=fimg']") ||
    img.parentElement?.querySelector("a[href*='view=fimg']");
  if (container instanceof HTMLAnchorElement && container.href) {
    return container.href;
  }
  for (const body of getMessageBodyRoots(scopeRoot)) {
    const links = Array.from(body.querySelectorAll("a[href*='view=fimg']"));
    if (links.length === 1) {
      return links[0].href;
    }
  }
  return null;
}

async function revealDownloadOnHover(img) {
  img.scrollIntoView({ block: "center" });
  await sleep(300);

  const rect = img.getBoundingClientRect();
  const hoverPoints = [
    [rect.left + rect.width * 0.85, rect.top + rect.height * 0.85],
    [rect.left + rect.width * 0.5, rect.top + rect.height * 0.5],
    [rect.left + rect.width * 0.5, rect.top + rect.height * 0.9],
  ];

  for (const [x, y] of hoverPoints) {
    const hit = document.elementFromPoint(x, y);
    if (hit instanceof HTMLElement) {
      triggerHover(hit);
    }
    triggerHover(img);
    await sleep(600);

    const button = findDownloadButtonNear(img);
    if (button) {
      return button;
    }
  }

  const candidates = [
    img.closest("div.aSS"),
    img.closest("div.a8X"),
    img.closest("div.aYr"),
    img.parentElement,
    img,
  ].filter(Boolean);

  for (const container of candidates) {
    triggerHover(container);
    await sleep(500);
    const button = findDownloadButtonNear(container);
    if (button) {
      return button;
    }
  }
  return null;
}

function triggerHover(element) {
  for (const type of ["mouseenter", "mouseover", "mousemove"]) {
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
  }
}

function findDownloadButtonNear(container) {
  const scopes = [container];
  let parent = container.parentElement;
  for (let depth = 0; depth < 6 && parent; depth += 1) {
    scopes.push(parent);
    parent = parent.parentElement;
  }

  const selectors = [
    'div[data-tooltip="Download"]',
    'span[data-tooltip="Download"]',
    'div[aria-label="Download"]',
    'div[role="button"][aria-label="Download"]',
    'div[data-tooltip*="Download"]',
    'div[aria-label*="Download"]',
  ];

  for (const scope of scopes) {
    for (const selector of selectors) {
      const nodes = Array.from(scope.querySelectorAll(selector)).filter(
        (node) => node instanceof HTMLElement && isVisible(node)
      );
      for (const node of nodes) {
        const label = getElementLabel(node);
        if (/^download$/i.test(label.trim()) || /download/i.test(label)) {
          return node;
        }
      }
    }
  }
  return null;
}

function extractFilenameFromLink(link) {
  const downloadName = link.getAttribute("download");
  if (downloadName) {
    return sanitizePart(downloadName);
  }
  const label =
    link.getAttribute("aria-label") ||
    link.getAttribute("data-tooltip") ||
    link.innerText ||
    "";
  const match = String(label).match(
    /(?:Download attachment|Download|attachment)\s*[:\s]*(.+)/i
  );
  if (match?.[1]) {
    return sanitizePart(match[1].trim());
  }
  try {
    const url = new URL(link.href);
    const name = url.pathname.split("/").pop();
    if (name && name.includes(".")) {
      return sanitizePart(name);
    }
  } catch (_error) {
    // Ignore invalid URLs.
  }
  return "attachment.bin";
}

function getElementLabel(element) {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("data-tooltip") ||
    element.getAttribute("title") ||
    element.innerText ||
    ""
  );
}

function describePageState(scopeRoot = document) {
  const bodies = getMessageBodyRoots(scopeRoot);
  const inlineImages = findInlineImagesInMessage(scopeRoot);
  const fileUrls = findFileAttachmentUrls(scopeRoot);
  return {
    url: window.location.href,
    rows: document.querySelectorAll("tr.zA").length,
    subjectVisible: Boolean(document.querySelector("h2.hP")),
    messageBodies: bodies.length,
    inlineImages: inlineImages.length,
    fileAttachmentRoots: getFileAttachmentRoots(scopeRoot).length,
    fileAttachmentChips: scopeRoot.querySelectorAll("div.aQH div.aZo, div.aZo").length,
    fileAttachmentUrls: fileUrls.length,
    attachmentAreas: document.querySelectorAll("div.aQH, div.aZo").length,
    attLinks: document.querySelectorAll('a[href*="view=att"]').length,
    fimgLinks: document.querySelectorAll('a[href*="view=fimg"]').length,
  };
}

function getThreadMessageContainers() {
  const seen = new Set();
  const containers = [];
  const add = (node) => {
    const normalized = normalizeMessageContainer(node);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    containers.push(normalized);
  };

  for (const node of document.querySelectorAll("[data-message-id], [data-legacy-message-id]")) {
    add(node);
  }
  for (const node of document.querySelectorAll("div.adn.ads")) {
    add(node);
  }
  return containers;
}

function isMessageExpanded(node) {
  if (!(node instanceof HTMLElement) || !isVisible(node)) {
    return false;
  }
  const body = node.querySelector("div.a3s, div.ii.gt");
  return Boolean(body && isVisible(body));
}

function hasAttachmentInMessage(node) {
  return Boolean(
    node.querySelector(
      'a[href*="view=att"], a[href*="realattid="], a[href*="view=fimg"], div.aZo, div.aQH, img'
    )
  );
}

function findExpandControl(messageNode) {
  const selectors = [
    'span[data-tooltip="Show trimmed content"]',
    'div[aria-label*="Show trimmed content"]',
    'div[aria-label*="Expand"]',
    "div.adP",
    "span.adL",
  ];
  for (const selector of selectors) {
    const el = messageNode.querySelector(selector);
    if (el instanceof HTMLElement && isVisible(el)) {
      return el;
    }
  }
  return null;
}

async function ensureMessageExpanded(messageNode) {
  if (!(messageNode instanceof HTMLElement)) {
    return;
  }
  if (isMessageExpanded(messageNode)) {
    return;
  }
  const expandControl = findExpandControl(messageNode);
  if (!expandControl) {
    return;
  }
  expandControl.scrollIntoView({ block: "center" });
  expandControl.click();
  await sleep(1500);
  await waitFor(
    () => isMessageExpanded(messageNode) || hasAttachmentInMessage(messageNode),
    5000
  ).catch(() => {});
}

function selectTargetMessageNode(processedSet = new Set()) {
  const messages = getThreadMessageContainers();
  if (!messages.length) {
    return null;
  }

  const withAttachment = messages.filter((node) => hasAttachmentInMessage(node));

  if (lastInteractedMessageNode) {
    const normalized = normalizeMessageContainer(lastInteractedMessageNode);
    if (normalized && hasAttachmentInMessage(normalized)) {
      const id = extractOpenedEmailId(normalized);
      if (!id || !processedSet.has(id)) {
        return normalized;
      }
    }
  }

  const expandedWithAttachment = withAttachment.filter(isMessageExpanded);
  for (let i = expandedWithAttachment.length - 1; i >= 0; i -= 1) {
    const candidate = expandedWithAttachment[i];
    const id = extractOpenedEmailId(candidate);
    if (id && !processedSet.has(id)) {
      return candidate;
    }
  }

  for (let i = withAttachment.length - 1; i >= 0; i -= 1) {
    const candidate = withAttachment[i];
    const id = extractOpenedEmailId(candidate);
    if (id && !processedSet.has(id)) {
      return candidate;
    }
  }

  return messages[messages.length - 1];
}

function requestUrlDownload(url, filename) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "DOWNLOAD_URL", url, filename },
      (response) => resolve(Boolean(response?.ok))
    );
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

async function fetchAttachmentBytes(url) {
  const response = await fetch(String(url || ""), { credentials: "include" });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const buffer = await response.arrayBuffer();
  return {
    ok: true,
    base64: arrayBufferToBase64(buffer),
    size: buffer.byteLength,
  };
}

function sendRunStart(downloadRelativeDir, filenamePrefix, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: false, error: "RUN_START timeout (service worker not responding)." });
    }, 5000);

    chrome.runtime.sendMessage(
      {
        type: "RUN_START",
        downloadRelativeDir,
        filenamePrefix,
        useNativeDownload: Boolean(options.useNativeDownload),
        targetDir: String(options.targetDir || ""),
      },
      (response) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || "RUN_START failed." });
          return;
        }
        resolve(response || { ok: true });
      }
    );
  });
}

function sendRunContext(config, filenamePrefix, useNativeDownload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "RUN_CONTEXT",
        needsRelocate: useNativeDownload ? false : Boolean(config?.needs_relocate),
        useNativeDownload: Boolean(useNativeDownload),
        stagingDir: String(config?.staging_dir || ""),
        targetDir: String(config?.configured_download_dir || ""),
        launcherPort: Number(config?.launcher_port || 8765),
        filenamePrefix: String(filenamePrefix || ""),
      },
      () => resolve()
    );
  });
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isLoginPage() {
  return window.location.href.includes("accounts.google.com");
}

function sanitizePart(value) {
  return (
    String(value).replace(/[<>:"/\\|?*]+/g, "_").replace(/^_+|_+$/g, "") ||
    "unknown"
  );
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve(true);
          return;
        }
      } catch (_error) {
        // Keep waiting.
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for Gmail UI."));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

initAutoDownloader();
