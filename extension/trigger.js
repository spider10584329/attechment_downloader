async function closeTriggerHostTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) {
      await chrome.tabs.remove(tab.id);
    }
  } catch (_error) {
    // Tab may already be closed.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorkerReady(manifestVersion, retries = 6, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const ping = await chrome.runtime.sendMessage({ type: "PING" });
      if (!ping?.build || ping.build === manifestVersion) {
        return true;
      }
    } catch (_error) {
      // Service worker may still be waking up. Retry.
    }
    await sleep(delayMs);
  }
  return false;
}

(async () => {
  const manifest = chrome.runtime.getManifest();
  const buildKey = "extension_build_id";
  const stored = await chrome.storage.local.get(buildKey);

  if (stored[buildKey] !== manifest.version) {
    await chrome.storage.local.set({ [buildKey]: manifest.version });
  }

  const workerReady = await waitForWorkerReady(manifest.version);
  if (!workerReady) {
    console.warn("Service worker build check timed out; continuing START_RUN.");
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "START_RUN" });
    console.log("START_RUN response:", response);
  } catch (error) {
    console.error("START_RUN failed:", error);
  } finally {
    await closeTriggerHostTab();
  }
})();
