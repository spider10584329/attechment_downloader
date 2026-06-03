/**
 * Open a Chrome window minimized from the first frame (avoids visible-then-minimize flicker).
 */

const AUTOMATION_SHELL_KEY = "automation_window_id";

async function openMinimizedWindow(url) {
  const attempts = [
    { url, focused: false, state: "minimized", type: "normal" },
    { url, focused: false, state: "minimized", type: "popup" },
  ];

  for (const options of attempts) {
    try {
      const created = await chrome.windows.create(options);
      await ensureWindowMinimized(created.id);
      return created;
    } catch (_error) {
      // Try the next create shape.
    }
  }

  const shell = await openMinimizedBlankShell();
  const tab = await chrome.tabs.create({
    url,
    windowId: shell.id,
    active: false,
  });
  await ensureWindowMinimized(shell.id);
  return { id: shell.id, tabs: [tab] };
}

async function openMinimizedBlankShell() {
  const attempts = [
    { url: "about:blank", focused: false, state: "minimized", type: "normal" },
    { url: "about:blank", focused: false, state: "minimized", type: "popup" },
  ];

  for (const options of attempts) {
    try {
      const created = await chrome.windows.create(options);
      await ensureWindowMinimized(created.id);
      return created;
    } catch (_error) {
      // Try the next create shape.
    }
  }

  throw new Error("Could not create a minimized Chrome window.");
}

async function ensureWindowMinimized(windowId) {
  try {
    const win = await chrome.windows.get(windowId);
    if (win.state !== "minimized" || win.focused) {
      await chrome.windows.update(windowId, {
        state: "minimized",
        focused: false,
      });
    }
  } catch (_error) {
    // Window may have been closed.
  }
}

async function getAutomationShellWindow() {
  const stored = await chrome.storage.session.get(AUTOMATION_SHELL_KEY);
  const windowId = stored[AUTOMATION_SHELL_KEY];
  if (!windowId) {
    return null;
  }
  try {
    return await chrome.windows.get(windowId);
  } catch (_error) {
    await chrome.storage.session.remove(AUTOMATION_SHELL_KEY);
    return null;
  }
}

async function rememberAutomationShell(windowId) {
  await chrome.storage.session.set({ [AUTOMATION_SHELL_KEY]: windowId });
}

async function openAutomationTab(url) {
  let shell = await getAutomationShellWindow();
  if (!shell) {
    shell = await openMinimizedBlankShell();
    await rememberAutomationShell(shell.id);
  } else {
    await ensureWindowMinimized(shell.id);
  }

  const tab = await chrome.tabs.create({
    url,
    windowId: shell.id,
    active: false,
  });
  await ensureWindowMinimized(shell.id);
  return { windowId: shell.id, tabId: tab.id };
}

async function releaseAutomationWindow(windowId) {
  if (!windowId) {
    return;
  }

  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const tab of tabs) {
      if (!tab.id) {
        continue;
      }
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_error) {
        // Tab may already be gone.
      }
    }
    await chrome.tabs.create({
      windowId,
      url: "about:blank",
      active: false,
    });
    await ensureWindowMinimized(windowId);
  } catch (_error) {
    await chrome.storage.session.remove(AUTOMATION_SHELL_KEY);
  }
}
