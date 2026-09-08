const SESSION_KEY = "tabosmart.workspaceView.v1";
const MAX_WINDOWS = 64;
const validId = (value) => Number.isInteger(value) && value >= 0;
function fault(message, code = "ACTION_FAILED") {
  return Object.assign(new Error(message), { code });
}

/**
 * Owns only the normal index.html workspace tab. Requests share one queue, so
 * rapid toolbar clicks cannot create duplicate workspaces. Browser-session
 * storage keeps tab/window IDs only; no browsing URLs or titles are persisted.
 */
export function createWorkspaceView(api) {
  const workspaceURL = api.runtime.getURL("index.html");
  const returns = new Map();
  let knownWorkspaceId = null,
    loaded = null,
    queue = Promise.resolve();
  const ownURL = (url) =>
    typeof url === "string" && url.split(/[?#]/, 1)[0] === workspaceURL;
  const regular = (tab) =>
    tab && validId(tab.id) && validId(tab.windowId) && !tab.incognito;
  const workspace = (tab) =>
    regular(tab) &&
    ownURL(tab.url) &&
    (!tab.pendingUrl || ownURL(tab.pendingUrl));
  const browsing = (tab) =>
    regular(tab) &&
    !ownURL(tab.url) &&
    (!tab.pendingUrl || tab.pendingUrl === tab.url);
  const openingWorkspace = (tab) =>
    regular(tab) && (workspace(tab) || ownURL(tab.pendingUrl));

  async function load() {
    if (!loaded)
      loaded = (async () => {
        try {
          const raw = (await api.storage?.session?.get(SESSION_KEY))?.[
            SESSION_KEY
          ];
          for (const entry of Array.isArray(raw?.returns)
            ? raw.returns.slice(-MAX_WINDOWS)
            : [])
            if (validId(entry?.windowId) && validId(entry?.tabId))
              returns.set(entry.windowId, { tabId: entry.tabId });
          if (validId(raw?.workspaceTabId))
            knownWorkspaceId = raw.workspaceTabId;
        } catch {
          /* Returning to Chrome's selected tab remains a safe fallback. */
        }
      })();
    await loaded;
  }
  async function persist() {
    try {
      await api.storage?.session?.set({
        [SESSION_KEY]: {
          returns: [...returns].map(([windowId, target]) => ({
            windowId,
            tabId: target.tabId,
          })),
          workspaceTabId: knownWorkspaceId,
        },
      });
    } catch {
      /* Session persistence is optional to opening or closing the UI. */
    }
  }
  function remember(tab) {
    if (!browsing(tab)) return;
    returns.delete(tab.windowId);
    returns.set(tab.windowId, { tabId: tab.id, url: tab.url });
    if (returns.size > MAX_WINDOWS) returns.delete(returns.keys().next().value);
  }
  async function get(tabId) {
    try {
      return await api.tabs.get(tabId);
    } catch {
      return null;
    }
  }
  function serial(task) {
    const result = queue.then(async () => {
      await load();
      return task();
    });
    queue = result.catch(() => {});
    return result;
  }
  async function requireWorkspace(sender, windowId = null) {
    if (
      sender?.id !== api.runtime.id ||
      !ownURL(sender?.url) ||
      !validId(sender?.tab?.id) ||
      sender.tab.incognito
    )
      throw fault(
        "Only the Tabosmart workspace can close itself.",
        "INVALID_WORKSPACE",
      );
    const live = await get(sender.tab.id);
    if (!workspace(live) || (windowId !== null && live.windowId !== windowId))
      throw fault(
        "This tab is no longer the Tabosmart workspace.",
        "INVALID_WORKSPACE",
      );
    return live;
  }
  async function openView(invokingTab) {
    if (invokingTab?.incognito)
      throw fault(
        "Open Tabosmart from a regular Chrome window.",
        "INVALID_WORKSPACE",
      );
    const invoking = validId(invokingTab?.id)
      ? await get(invokingTab.id)
      : null;
    if (invoking?.incognito)
      throw fault(
        "Open Tabosmart from a regular Chrome window.",
        "INVALID_WORKSPACE",
      );
    if (regular(invoking)) remember(invoking);
    const tabs = await api.tabs.query({ windowType: "normal" });
    const invokingWindowId = regular(invoking) ? invoking.windowId : null;
    const candidates = tabs
      .filter(openingWorkspace)
      .sort(
        (a, b) =>
          Number(b.windowId === invokingWindowId) -
            Number(a.windowId === invokingWindowId) ||
          Number(b.id === knownWorkspaceId) -
            Number(a.id === knownWorkspaceId) ||
          a.id - b.id,
      );
    for (const candidate of candidates) {
      const live = await get(candidate.id);
      if (!openingWorkspace(live)) continue;
      const previous = tabs.find(
        (tab) => browsing(tab) && tab.active && tab.windowId === live.windowId,
      );
      if (previous) {
        const freshPrevious = await get(previous.id);
        if (browsing(freshPrevious) && freshPrevious.windowId === live.windowId)
          remember(freshPrevious);
      }
      await api.tabs.update(live.id, { active: true });
      await api.windows.update(live.windowId, { focused: true });
      knownWorkspaceId = live.id;
      await persist();
      return { tabId: live.id, windowId: live.windowId, reused: true };
    }
    const target = regular(invoking)
      ? invoking
      : tabs.find((tab) => regular(tab) && tab.active) || tabs.find(regular);
    if (!target)
      throw fault("Open a regular Chrome window, then open Tabosmart again.");
    remember(target);
    const created = await api.tabs.create({
      url: workspaceURL,
      windowId: target.windowId,
      active: true,
    });
    if (!openingWorkspace(created) || created.windowId !== target.windowId)
      throw fault("Chrome could not open the Tabosmart workspace.");
    await api.windows.update(created.windowId, { focused: true });
    knownWorkspaceId = created.id;
    await persist();
    return { tabId: created.id, windowId: created.windowId, reused: false };
  }
  async function closeView(sender) {
    const initial = await requireWorkspace(sender);
    const windowId = initial.windowId;
    const windowTabs = await api.tabs.query({ windowId });
    let created = null;
    if (
      !windowTabs.some(
        (tab) =>
          regular(tab) && tab.windowId === windowId && tab.id !== initial.id,
      )
    ) {
      // Chrome normally closes a window when its last tab is removed. Preserve
      // this window with Chrome's default New Tab before closing only our UI.
      created = await api.tabs.create({ windowId, active: false });
      if (!browsing(created) || created.windowId !== windowId)
        throw fault(
          "Chrome could not keep this window open. The workspace was left open.",
        );
    }
    const current = await requireWorkspace(sender, windowId);
    await api.tabs.remove(current.id);
    if (knownWorkspaceId === current.id) knownWorkspaceId = null;
    const target = created
      ? { tabId: created.id, url: created.url }
      : returns.get(windowId);
    let focusedTabId = null;
    if (target) {
      const live = await get(target.tabId);
      if (
        browsing(live) &&
        live.windowId === windowId &&
        (target.url === undefined || target.url === live.url)
      ) {
        try {
          await api.tabs.update(live.id, { active: true });
          focusedTabId = live.id;
        } catch {
          /* Chrome's normal remaining-tab selection is the fallback. */
        }
      }
    }
    returns.delete(windowId);
    await persist();
    return {
      closed: true,
      tabId: current.id,
      windowId,
      focusedTabId,
      createdReturnTab: !!created,
    };
  }
  return {
    open: (invokingTab) => {
      const captured = invokingTab
        ? { id: invokingTab.id, incognito: invokingTab.incognito }
        : undefined;
      return serial(() => openView(captured));
    },
    close: (sender) => {
      const captured = {
        id: sender?.id,
        url: sender?.url,
        tab: sender?.tab
          ? { id: sender.tab.id, incognito: sender.tab.incognito }
          : undefined,
      };
      return serial(() => closeView(captured));
    },
  };
}
