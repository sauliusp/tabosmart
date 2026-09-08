import { createInstallationWelcome } from "./installation.mjs";
import {
  discoveryKey,
  validateDiscoveredGroups,
  DISCOVERY_BATCH,
} from "./group-discovery.mjs";
import { createWorkspaceView } from "./workspace-view.mjs";
import { createToolbarState } from "./toolbar-state.mjs";
import { createHistoryIndex, HISTORY_ALARM } from "./history-index.mjs";
import {
  recordOpening,
  resetGroupingSession,
  rememberGroupingChoice,
} from "./grouping-context.mjs";
import {
  createState,
  hydrateState,
  startSession,
  observeTabs,
  recordActivation,
  recordTabRemoval,
  makeSnapshot as makeCoreSnapshot,
  validateSelection,
  sanitizeSettings,
  isWebTab,
  isWebURL,
  LIMITS,
  targetGroupIdentity,
} from "./core.mjs";

export const STORAGE_KEY = "tabosmart.v1";
export const EVALUATION_ALARM = "tabosmart.evaluate";
export const MAINTENANCE_ALARM = "tabosmart.maintenance";
const SESSION_KEY = "tabosmart.session";
function fault(message, code = "ACTION_FAILED") {
  return Object.assign(new Error(message), { code });
}
function id(prefix, now) {
  return `${prefix}-${now.toString(36)}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

export function createBackend(
  api,
  {
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    settleMs = 250,
    maxWaitMs = 2000,
    historyOptions = {},
  } = {},
) {
  let state,
    ready,
    queue = Promise.resolve();
  let timer = null;
  const queuedChecks = new Map();
  const workspaceView = createWorkspaceView(api);
  const toolbar = createToolbarState(api);
  let historyFacts = {};
  let nativeGroups = [];
  async function readNativeGroups() {
    try {
      return await api.tabGroups.query({});
    } catch {
      return [];
    }
  }
  let discoveryIdentity = null,
    discoveredGroups = [],
    enrichedSnapshot = null;
  function withDiscovery(base, rawTabs) {
    const key = discoveryKey(base);
    if (key !== discoveryIdentity) {
      discoveryIdentity = key;
      discoveredGroups = [];
      enrichedSnapshot = null;
    }
    return discoveredGroups.length && state.settings.aiEnabled
      ? makeCoreSnapshot(
          state,
          rawTabs,
          base.now,
          historyFacts,
          discoveredGroups,
          nativeGroups,
        )
      : base;
  }
  function makeSnapshot(currentState, rawTabs, at, facts) {
    return withDiscovery(
      makeCoreSnapshot(currentState, rawTabs, at, facts, [], nativeGroups),
      rawTabs,
    );
  }
  const history = createHistoryIndex(api, {
    ...historyOptions,
    now,
    onChange(progress) {
      if (["off", "paused", "denied", "error"].includes(progress.state))
        historyFacts = {};
      updateToolbar();
      if (api.alarms) {
        const pending = ["indexing", "updating"].includes(progress.state);
        Promise.resolve(
          pending
            ? api.alarms.create(HISTORY_ALARM, { delayInMinutes: 0.5 })
            : api.alarms.clear(HISTORY_ALARM),
        ).catch(() => {});
      }
      notify();
      if (state?.settings.enabled)
        void serial(() => scheduleEvaluation()).catch(() => {});
    },
  });
  function updateToolbar() {
    if (!state) return;
    const current = cachedSnapshot();
    void toolbar.updateCore({
      enabled: state.settings.enabled,
      consentAt: state.consentAt,
      evaluation: current.evaluation,
      suggestionCount: current.suggestions.length,
      history: history.snapshot(),
    });
  }
  async function configureHistory() {
    historyFacts = {};
    if (api.history || globalThis.indexedDB || historyOptions.store)
      await history.configure(state.settings);
    updateToolbar();
  }
  let snapshotRevision = 0;
  const persist = () => {
    state.snapshotRevision = ++snapshotRevision;
    return api.storage.local.set({ [STORAGE_KEY]: state });
  };
  function notify() {
    updateToolbar();
    try {
      api.runtime.sendMessage?.({ type: "snapshotChanged" }).catch(() => {});
    } catch {
      /* no workspace is open */
    }
  }
  async function maintainAlarms() {
    if (!api.alarms) return;
    if (state.settings.enabled) {
      if (!(await api.alarms.get(MAINTENANCE_ALARM)))
        await api.alarms.create(MAINTENANCE_ALARM, {
          delayInMinutes: 15,
          periodInMinutes: 15,
        });
      if (
        state.evaluation.state === "checking" &&
        !(await api.alarms.get(EVALUATION_ALARM))
      )
        await api.alarms.create(EVALUATION_ALARM, { delayInMinutes: 0.5 });
    } else {
      await api.alarms.clear(MAINTENANCE_ALARM);
      await api.alarms.clear(EVALUATION_ALARM);
    }
  }
  async function initialize() {
    const local = await api.storage.local.get(STORAGE_KEY);
    state = hydrateState(local[STORAGE_KEY], now());
    snapshotRevision = Number.isSafeInteger(
      local[STORAGE_KEY]?.snapshotRevision,
    )
      ? Math.max(0, local[STORAGE_KEY].snapshotRevision)
      : 0;
    if (!local[STORAGE_KEY]) {
      // Required install permissions authorize the disclosed normal lifecycle.
      // A stored pause or erased state is never silently re-enabled.
      state.settings.enabled = true;
      state.settings.historyEnabled = true;
      state.consentAt = now();
      state.installDisclosure = true;
    }
    const session = await api.storage.session.get(SESSION_KEY);
    const sessionId = session[SESSION_KEY] || id("session", now());
    if (!session[SESSION_KEY])
      await api.storage.session.set({ [SESSION_KEY]: sessionId });
    startSession(state, sessionId, now());
    // Only trusted extension contexts can read persisted browsing metadata.
    await api.storage.local.setAccessLevel?.({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await persist();
    await maintainAlarms();
    updateToolbar();
    void configureHistory();
  }
  async function ensureReady() {
    if (!ready)
      ready = initialize().catch((error) => {
        ready = null;
        throw error;
      });
    await ready;
  }
  async function synchronize(activatedId = null) {
    if (!state.settings.enabled) return [];
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    state.evaluation = {
      ...state.evaluation,
      state: "checking",
      phase: "checking",
      requestedAt: state.evaluation.requestedAt || now(),
      error: null,
    };
    try {
      await persist();
      notify();
      const tabs = await api.tabs.query({});
      nativeGroups = await readNativeGroups();
      historyFacts = state.settings.historyEnabled
        ? await history.facts(tabs.filter(isWebTab).map((tab) => tab.url))
        : {};
      observeTabs(state, tabs, now(), activatedId ?? state.pendingActivationId);
      state.pendingActivationId = null;
      state.evaluation = {
        state: "idle",
        phase: null,
        checkedAt: now(),
        requestedAt: null,
        error: null,
      };
      const result = makeCoreSnapshot(
        state,
        tabs,
        now(),
        historyFacts,
        [],
        nativeGroups,
      );
      state.cached = {
        tabs: result.tabs,
        suggestions: result.suggestions,
        stats: result.stats,
        evaluationSummary: result.evaluationSummary,
        now: result.now,
      };
      enrichedSnapshot = withDiscovery(result, tabs);
      await persist();
      await api.alarms?.clear(EVALUATION_ALARM);
      notify();
      return tabs;
    } catch (error) {
      state.evaluation = {
        ...state.evaluation,
        state: "error",
        phase: null,
        error:
          "The latest browser check could not finish. Try again when Chrome is ready.",
      };
      try {
        await persist();
      } catch {
        /* cachedSnapshot can still expose this state */
      }
      notify();
      throw error;
    }
  }
  function serial(task, requestsCheck = false) {
    const request = requestsCheck ? {} : null;
    if (request) {
      queuedChecks.set(request, now());
      if (
        queuedChecks.size === 1 &&
        state?.settings.enabled &&
        state.evaluation.state !== "checking"
      )
        notify();
    }
    const result = queue.then(async () => {
      try {
        await ensureReady();
        if (request) queuedChecks.delete(request);
        return await task();
      } finally {
        if (request) queuedChecks.delete(request);
      }
    });
    queue = result.catch(() => {});
    return result;
  }
  async function snapshot() {
    const tabs = await synchronize();
    return {
      ...makeSnapshot(state, tabs, now(), historyFacts),
      snapshotRevision,
    };
  }
  function cachedSnapshot() {
    const cached = state.settings.enabled ? state.cached : null;
    const enriched =
      state.settings.enabled &&
      state.settings.aiEnabled &&
      cached &&
      discoveryKey({ tabs: cached.tabs, settings: state.settings }) ===
        discoveryIdentity
        ? enrichedSnapshot
        : null;
    const evaluation = { ...state.evaluation };
    if (
      state.settings.enabled &&
      queuedChecks.size &&
      evaluation.state !== "checking"
    ) {
      evaluation.state = "checking";
      evaluation.phase = "queued";
      evaluation.requestedAt = Math.min(...queuedChecks.values());
      evaluation.error = null;
    }
    return {
      snapshotRevision,
      tabs: cached?.tabs || [],
      suggestions: enriched?.suggestions || cached?.suggestions || [],
      evaluationSummary:
        enriched?.evaluationSummary || cached?.evaluationSummary || null,
      history: history.snapshot(),
      installDisclosure: state.installDisclosure === true,
      stats: cached?.stats || {
        observedTabs: 0,
        protectedTabs: 0,
        trackingSince: state.trackingSince,
      },
      saved: state.saved,
      recovery: state.recovery,
      settings: state.settings,
      consentAt: state.consentAt,
      now: cached?.now ?? now(),
      evaluation,
    };
  }
  async function scheduleEvaluation(activatedId = null, observedAt = now()) {
    if (!state.settings.enabled) return;
    if (Number.isInteger(activatedId)) {
      try {
        const tab = await api.tabs.get(activatedId);
        recordActivation(state, tab, observedAt);
      } catch {
        // An unreadable activation interrupts our measured transition chain.
        // Do not connect the surrounding tabs as if it never happened.
        state.lastActivation = {};
        state.groupingContext.current = {};
      }
      state.pendingActivationId = null;
    }
    const changed = state.evaluation.state !== "checking";
    state.evaluation = {
      ...state.evaluation,
      state: "checking",
      phase: "queued",
      requestedAt: changed ? now() : state.evaluation.requestedAt,
      error: null,
    };
    await persist();
    if (changed) {
      await api.alarms?.create(EVALUATION_ALARM, { delayInMinutes: 0.5 });
      notify();
    }
    if (timer !== null) clearTimer(timer);
    const delay = Math.max(
      0,
      Math.min(settleMs, maxWaitMs - (now() - state.evaluation.requestedAt)),
    );
    timer = setTimer(() => {
      timer = null;
      return serial(() => synchronize()).catch(() => {});
    }, delay);
  }
  function ensureCapacity(kind, count) {
    const entries = state[kind];
    if (
      entries.length >= LIMITS.batches ||
      entries.reduce((sum, entry) => sum + entry.tabs.length, 0) + count >
        LIMITS.storedTabs
    )
      throw fault(
        `Your ${kind === "saved" ? "shelf" : "recovery list"} is full. Remove an old saved item before continuing.`,
        "STORAGE_FULL",
      );
  }
  function newBatch(kind, tabs) {
    ensureCapacity(kind, tabs.length);
    const stamp = now();
    const entry = {
      id: id(kind, stamp),
      title: tabs.length === 1 ? tabs[0].title : `${tabs.length} tabs`,
      createdAt: stamp,
      tabs: tabs.map((tab, index) => ({
        id: `${index}`,
        sourceTabId: tab.id,
        url: tab.url,
        title: tab.title,
        windowId: tab.windowId,
        index: tab.index,
        status: kind === "recovery" ? "pending-close" : "saved",
      })),
    };
    state[kind].unshift(entry);
    return entry;
  }
  async function selected(message, action, rawTabs) {
    let expected = message.expectedTabs;
    if (message.suggestionId) {
      const snap = makeSnapshot(state, rawTabs, now(), historyFacts);
      const suggestion = snap.suggestions.find(
        (item) => item.id === message.suggestionId,
      );
      if (!suggestion || (action === "group" && suggestion.type !== "group"))
        throw fault(
          "This suggestion has changed. Review the updated list.",
          "STALE",
        );
      if (
        !Array.isArray(message.tabIds) ||
        message.tabIds.some((tabId) => !suggestion.tabIds.includes(tabId))
      )
        throw fault(
          "The selected tabs no longer match this suggestion.",
          "STALE",
        );
      expected ||= suggestion.tabs;
    }
    if (!expected)
      throw fault(
        "Review the selected tabs before continuing.",
        "REVIEW_REQUIRED",
      );
    return validateSelection(
      rawTabs,
      state,
      message.tabIds,
      expected,
      action,
      now(),
    );
  }
  async function action(message) {
    const type = message.type;
    if (type === "discoverGroups") {
      if (!state.settings.enabled || !state.settings.aiEnabled)
        throw fault("Local AI is off.", "DISABLED");
      const rawTabs = await api.tabs.query({});
      nativeGroups = await readNativeGroups();
      const base = makeCoreSnapshot(
        state,
        rawTabs,
        now(),
        historyFacts,
        [],
        nativeGroups,
      );
      if (message.key !== discoveryKey(base))
        throw fault("Tab metadata changed. Kept current suggestions.", "STALE");
      if (
        !Array.isArray(message.tabIds) ||
        message.tabIds.length > DISCOVERY_BATCH ||
        new Set(message.tabIds).size !== message.tabIds.length
      )
        throw fault("Invalid discovery batch.", "INVALID_REQUEST");
      const batch = base.tabs.filter((t) => message.tabIds.includes(t.id));
      if (batch.length !== message.tabIds.length)
        throw fault("Tab metadata changed.", "STALE");
      const groups = validateDiscoveredGroups(message.groups, batch);
      withDiscovery(base, rawTabs);
      const known = new Set(
        discoveredGroups.map((g) =>
          g.members
            .map((m) => m.id)
            .sort((a, b) => a - b)
            .join(","),
        ),
      );
      for (const group of groups) {
        const key = group.members
          .map((m) => m.id)
          .sort((a, b) => a - b)
          .join(",");
        if (!known.has(key)) {
          const members = new Set(group.members.map((m) => m.id));
          discoveredGroups = discoveredGroups.filter(
            (old) => !old.members.every((m) => members.has(m.id)),
          );
          discoveredGroups.push(group);
          known.add(key);
        }
      }
      enrichedSnapshot = withDiscovery(base, rawTabs);
      state.snapshotRevision = ++snapshotRevision;
      notify();
      return { ...enrichedSnapshot, snapshotRevision };
    }
    // Privacy controls must remain usable even if Chrome cannot currently answer
    // a tab query. Only actions that inspect live tabs need this preflight.
    const rawTabs = [
      "snapshot",
      "dismiss",
      "protect",
      "focus",
      "group",
      "save",
      "close",
    ].includes(type)
      ? await synchronize()
      : [];
    if (
      !state.settings.enabled &&
      ["dismiss", "protect", "focus", "group", "save", "close"].includes(type)
    )
      throw fault(
        "Start local tab assistance before using this action.",
        "DISABLED",
      );
    if (type === "snapshot")
      return {
        ...makeSnapshot(state, rawTabs, now(), historyFacts),
        snapshotRevision,
      };
    if (type === "dismiss") {
      const suggestion = makeSnapshot(
        state,
        rawTabs,
        now(),
        historyFacts,
      ).suggestions.find((item) => item.id === message.id);
      if (!suggestion)
        throw fault(
          "This suggestion has changed. Refresh to see the latest list.",
          "STALE",
        );
      state.dismissed[suggestion.fingerprint] = now();
      await persist();
    } else if (type === "protect") {
      const tabs = await selected(message, "protect", rawTabs);
      if (typeof message.protected !== "boolean")
        throw fault("Choose whether to protect these tabs.", "INVALID_REQUEST");
      for (const tab of tabs) {
        if (message.protected) state.protectedUrls[tab.url] = now();
        else delete state.protectedUrls[tab.url];
      }
      await persist();
    } else if (type === "focus") {
      const tab = rawTabs.find((item) => item.id === message.tabId);
      if (!tab || !isWebTab(tab))
        throw fault("This tab is no longer available.", "STALE");
      await api.windows.update(tab.windowId, { focused: true });
      await api.tabs.update(tab.id, { active: true });
    } else if (type === "settings") {
      const wasEnabled = state.settings.enabled;
      // An explicit boolean AI choice records user provenance; unrelated
      // settings patches preserve the hydrated preference and its origin.
      state.settings = sanitizeSettings(message.patch, state.settings);
      if (!wasEnabled && state.settings.enabled) {
        state.consentAt ||= now();
        state.trackingSince = now();
        state.reviewEpoch = now();
        // A pause is an unknown interval. Begin fresh rather than calling it inactivity.
        state.observations = {};
        state.pairs = {};
        state.lastActivation = {};
        resetGroupingSession(state.groupingContext);
        state.startupCandidates = {};
        state.startupPending = false;
        state.windowClosures = {};
      }
      if (!state.settings.enabled) {
        resetGroupingSession(state.groupingContext);
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        state.cached = null;
        state.pendingActivationId = null;
        state.evaluation = {
          state: "idle",
          checkedAt: state.evaluation.checkedAt,
          requestedAt: null,
          error: null,
        };
      }
      await persist();
      await maintainAlarms();
      await configureHistory();
      notify();
    } else if (type === "dismissDisclosure") {
      state.installDisclosure = false;
      await persist();
      return cachedSnapshot();
    } else if (type === "retryHistory") {
      if (state.settings.enabled && state.settings.historyEnabled)
        await history.retry();
      return cachedSnapshot();
    } else if (type === "clearData") {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      const sessionId = state.sessionId;
      state = createState(now());
      state.settings.historyEnabled = false;
      state.installDisclosure = false;
      historyFacts = {};
      if (api.history || globalThis.indexedDB || historyOptions.store)
        await history.stop({ erase: true });
      state.sessionId = sessionId;
      await persist();
      await maintainAlarms();
      notify();
    } else if (type === "forget") {
      if (!["saved", "recovery"].includes(message.kind))
        throw fault("Unknown saved list.", "INVALID_REQUEST");
      const index = state[message.kind].findIndex(
        (entry) => entry.id === message.id,
      );
      if (index < 0)
        throw fault("This saved item is no longer available.", "STALE");
      state[message.kind].splice(index, 1);
      await persist();
    } else if (type === "group") {
      let tabs = await selected(message, "group", rawTabs);
      const accepted = makeSnapshot(
        state,
        rawTabs,
        now(),
        historyFacts,
      ).suggestions.find((item) => item.id === message.suggestionId);
      const target = accepted?.targetGroup;
      if (
        !message.suggestionId ||
        tabs.length < (target ? 1 : 2) ||
        new Set(tabs.map((tab) => tab.windowId)).size !== 1
      )
        throw fault(
          "Choose the suggested tabs in the same window.",
          "INVALID_SELECTION",
        );
      const name =
        String(target?.title || message.name || "Related tabs")
          .trim()
          .slice(0, 80) || "Related tabs";
      const currentTabs = await api.tabs.query({});
      tabs = validateSelection(
        currentTabs,
        state,
        message.tabIds,
        tabs,
        "group",
        now(),
      );
      if (target) {
        const group = (await readNativeGroups()).find(
          (g) => g.id === target.id,
        );
        const members = currentTabs.filter((t) => t.groupId === target.id);
        if (
          !group ||
          group.windowId !== tabs[0].windowId ||
          members.some(
            (t) => !isWebTab(t) || (t.pendingUrl && t.pendingUrl !== t.url),
          ) ||
          targetGroupIdentity({ ...group, members }) !==
            targetGroupIdentity(target)
        )
          throw fault(
            "The destination group changed. Review the updated suggestion.",
            "STALE",
          );
      }
      const groupId = await api.tabs.group({
        tabIds: tabs.map((tab) => tab.id),
        ...(target
          ? { groupId: target.id }
          : { createProperties: { windowId: tabs[0].windowId } }),
      });
      // Accepting a suggestion is a resolved decision. Native ungrouping should
      // not immediately cause Tabosmart to propose the same membership again.
      if (accepted) state.dismissed[accepted.fingerprint] = now();
      try {
        if (!target)
          await api.tabGroups.update(groupId, {
            title: name,
            color: "green",
            collapsed: false,
          });
      } catch {
        return {
          ...(await snapshot()),
          action: {
            type,
            groupId,
            warning:
              "The tabs were grouped, but the name could not be set. Rename the group in Chrome.",
          },
        };
      }
      rememberGroupingChoice(
        state.groupingContext,
        target
          ? [...currentTabs.filter((t) => t.groupId === target.id), ...tabs]
          : tabs,
        name,
        now(),
      );
      await persist();
      return {
        ...(await snapshot()),
        action: {
          type,
          groupId,
          tabIds: tabs.map((tab) => tab.id),
          message: target
            ? `Tabs added to ${target.title}.`
            : "Tabs grouped. Use the group menu in Chrome to ungroup them.",
        },
      };
    } else if (type === "save") {
      const tabs = await selected(message, "save", rawTabs);
      const entry = newBatch("saved", tabs);
      await persist();
      return {
        ...(await snapshot()),
        action: { type, id: entry.id, count: tabs.length },
      };
    } else if (type === "close") {
      if (message.confirmed !== true)
        throw fault(
          "Confirm closure after reviewing these tabs. Recovery restores URLs, not unsaved page state.",
          "CONFIRMATION_REQUIRED",
        );
      const tabs = await selected(message, "close", rawTabs);
      const entry = newBatch("recovery", tabs);
      // A storage failure here aborts closure. Never remove first and save later.
      await persist();
      const closed = [],
        failed = [];
      for (const expected of tabs) {
        const item = entry.tabs.find((tab) => tab.sourceTabId === expected.id);
        try {
          validateSelection(
            [await api.tabs.get(expected.id)],
            state,
            [expected.id],
            [expected],
            "close",
            now(),
          );
          await api.tabs.remove(expected.id);
          // beforeunload may keep a tab open even when remove resolves.
          let stillOpen = false;
          try {
            await api.tabs.get(expected.id);
            stillOpen = true;
          } catch {
            /* removed */
          }
          if (stillOpen)
            throw fault(
              "Chrome kept this tab open, possibly for unsaved changes.",
            );
          item.status = "closed";
          item.closedAt = now();
          closed.push(expected.id);
        } catch (error) {
          item.status = "not-closed";
          item.error = error.message;
          failed.push({ tabId: expected.id, error: error.message });
        }
        await persist();
      }
      return {
        ...(await snapshot()),
        action: { type, id: entry.id, closed, failed, count: closed.length },
      };
    } else if (type === "restore") {
      if (!["saved", "recovery"].includes(message.kind))
        throw fault("Unknown saved list.", "INVALID_REQUEST");
      const entry = state[message.kind].find((item) => item.id === message.id);
      if (!entry)
        throw fault("This saved item is no longer available.", "STALE");
      if (message.again === true) {
        if (message.kind !== "saved")
          throw fault(
            "Recovery items cannot be replayed. Open a saved URL manually if needed.",
            "INVALID_REQUEST",
          );
        for (const item of entry.tabs) {
          delete item.restoredAt;
          delete item.restoredTabId;
          delete item.restorePendingAt;
          delete item.error;
          item.status = "saved";
        }
        entry.lastReplayAt = now();
        await persist();
      }
      const restored = [],
        failed = [],
        skipped = [];
      for (const item of entry.tabs) {
        if (
          item.restoredAt ||
          item.restoredTabId != null ||
          item.status === "not-closed"
        ) {
          skipped.push(item.id);
          continue;
        }
        if (!isWebURL(item.url)) {
          item.error = "This URL cannot be restored.";
          failed.push(item.id);
          continue;
        }
        // If a worker stopped after opening but before persisting, resolve its pending
        // intent against live URLs. This may reuse an existing copy conservatively.
        if (item.restorePendingAt || item.status === "pending-close") {
          const open = (await api.tabs.query({})).find(
            (tab) => isWebTab(tab) && tab.url === item.url,
          );
          if (open) {
            item.restoredAt = now();
            item.restoredTabId = open.id;
            item.status = "restored";
            delete item.error;
            skipped.push(item.id);
            await persist();
            continue;
          }
          if (item.restorePendingAt) {
            item.error =
              "A previous restore could not be confirmed. Check your open tabs before opening this URL manually.";
            failed.push(item.id);
            await persist();
            continue;
          }
        }
        let created = false;
        try {
          item.restorePendingAt = now();
          await persist();
          const regularWindow = (await api.tabs.query({})).find(
            (tab) => !tab.incognito && Number.isInteger(tab.windowId),
          );
          const tab = regularWindow
            ? await api.tabs.create({
                url: item.url,
                active: false,
                windowId: regularWindow.windowId,
              })
            : (
                await api.windows.create({
                  url: item.url,
                  incognito: false,
                  focused: false,
                })
              ).tabs[0];
          created = true;
          item.restoredTabId = tab.id;
          item.restoredAt = now();
          item.status = "restored";
          delete item.error;
          restored.push(tab.id);
          await persist();
        } catch (error) {
          if (!created) delete item.restorePendingAt;
          item.error = error.message;
          failed.push(item.id);
          await persist();
        }
      }
      return {
        ...(await snapshot()),
        action: { type, restored, failed, skipped, count: restored.length },
      };
    } else throw fault("Unknown request.", "INVALID_REQUEST");
    return snapshot();
  }
  return {
    handle: (message, sender) =>
      message?.type === "closeWorkspace"
        ? workspaceView
            .close(sender)
            .then((result) => ({ ok: true, ...result }))
            .catch((error) => ({
              ok: false,
              error: error.message,
              code: error.code,
            }))
        : message?.type === "cachedSnapshot"
          ? ensureReady()
              .then(() => ({ ok: true, ...cachedSnapshot() }))
              .catch((error) => ({
                ok: false,
                error: error.message,
                code: "STORAGE_UNAVAILABLE",
              }))
          : serial(async () => {
              try {
                if (!message || typeof message.type !== "string")
                  throw fault("Invalid request.", "INVALID_REQUEST");
                return {
                  ok: true,
                  ...(await action(message)),
                  history: history.snapshot(),
                  installDisclosure: state.installDisclosure === true,
                };
              } catch (error) {
                return {
                  ok: false,
                  error: error.message || "The action could not be completed.",
                  code: error.code || "ACTION_FAILED",
                };
              }
            }, ["snapshot", "dismiss", "protect", "focus", "group", "save", "close"].includes(message?.type)).catch(
              (error) => ({
                ok: false,
                error: error.message || "Local storage is unavailable.",
                code: "STORAGE_UNAVAILABLE",
              }),
            ),
    observe: (activatedId) => serial(() => synchronize(activatedId), true),
    schedule: (activatedId) => {
      const observedAt = now();
      return serial(() => scheduleEvaluation(activatedId, observedAt), true);
    },
    created: (tab) => {
      const openedAt = now();
      const sourceURLAtEvent = state?.observations[tab?.openerTabId]?.url;
      const capturedOpener =
        state?.settings.enabled && Number.isInteger(tab?.openerTabId)
          ? api.tabs.get(tab.openerTabId).catch(() => null)
          : Promise.resolve(null);
      return serial(async () => {
        if (!state.settings.enabled || tab?.incognito) return;
        // Never turn the installation/startup inventory into a fabricated
        // opening burst. Capture the opener URL now, before later navigation.
        if (
          !state.startupPending &&
          openedAt - state.sessionStartedAt >= 60_000
        ) {
          const opener = await capturedOpener;
          if (!sourceURLAtEvent || sourceURLAtEvent === opener?.url)
            recordOpening(state.groupingContext, tab, opener, openedAt);
        }
        // Startup URL matches remain explicitly uncertain. Once startup has been
        // reconciled, a creation event always starts a fresh per-tab baseline.
        if (!state.startupPending && Number.isInteger(tab?.id)) {
          delete state.observations[tab.id];
          for (const [key, pair] of Object.entries(state.pairs))
            if (pair.identities.some((item) => item.id === tab.id))
              delete state.pairs[key];
          for (const [key, last] of Object.entries(state.lastActivation))
            if (last.id === tab.id) delete state.lastActivation[key];
        }
        await scheduleEvaluation();
      }, true);
    },
    removed: (tabId, info = {}) =>
      serial(async () => {
        recordTabRemoval(state, tabId, info.isWindowClosing === true, now());
        await scheduleEvaluation();
      }, true),
    resume: () =>
      serial(async () => {
        await maintainAlarms();
        if (state.settings.enabled) await scheduleEvaluation();
      }, true),
    openWorkspace: (tab) => workspaceView.open(tab),
    connect: (port) => {
      toolbar.connect(port);
      void ensureReady()
        .then(updateToolbar)
        .catch(() => {});
    },
    historyChanged: async () => {
      await ensureReady();
      if (!state.settings.enabled || !state.settings.historyEnabled) return;
      await configureHistory();
      await history.changed();
    },
    historyRemoved: async () => {
      await ensureReady();
      await configureHistory();
      await history.removed();
    },
    historyResume: async () => {
      await ensureReady();
      await configureHistory();
      await history.changed();
    },
    historyRevoked: async () => {
      await history.revoked();
      historyFacts = {};
      notify();
    },
  };
}

export function installListeners(api) {
  const backend = createBackend(api);
  const openInstallationWelcome = createInstallationWelcome(api);
  const quiet = (promise) =>
    promise.catch(() => {
      /* retry on next event; never log browsing metadata */
    });
  api.runtime.onMessage.addListener((message, sender, respond) => {
    // Only our own extension pages can ask for actions. No externally connectable API.
    if (
      message?.type === "snapshotChanged" ||
      sender.id !== api.runtime.id ||
      sender.tab?.incognito ||
      (sender.url && !sender.url.startsWith(api.runtime.getURL("")))
    )
      return false;
    backend.handle(message, sender).then(respond);
    return true;
  });
  api.runtime.onConnect?.addListener((port) => backend.connect(port));
  api.history?.onVisited?.addListener(() => quiet(backend.historyChanged()));
  api.history?.onVisitRemoved?.addListener(() =>
    quiet(backend.historyRemoved()),
  );
  api.permissions?.onRemoved?.addListener((change) => {
    if (change.permissions?.includes("history"))
      quiet(backend.historyRevoked());
  });
  api.permissions?.onAdded?.addListener((change) => {
    if (change.permissions?.includes("history")) quiet(backend.historyResume());
  });
  api.tabs.onActivated.addListener((info) => {
    quiet(backend.schedule(info.tabId));
  });
  api.tabs.onCreated.addListener((tab) => {
    quiet(backend.created(tab));
  });
  api.tabs.onRemoved.addListener((tabId, info) => {
    quiet(backend.removed(tabId, info));
  });
  api.tabs.onUpdated.addListener((_id, change) => {
    if (
      ["url", "title", "pinned", "audible", "status", "groupId"].some(
        (key) => key in change,
      )
    )
      quiet(backend.schedule());
  });
  for (const event of ["onReplaced", "onAttached", "onDetached", "onMoved"])
    api.tabs[event]?.addListener(() => {
      quiet(backend.schedule());
    });
  for (const event of ["onCreated", "onUpdated", "onRemoved", "onMoved"])
    api.tabGroups[event]?.addListener(() => {
      quiet(backend.schedule());
    });
  for (const event of ["onCreated", "onRemoved", "onFocusChanged"])
    api.windows[event]?.addListener(() => {
      quiet(backend.schedule());
    });
  api.runtime.onStartup.addListener(() => {
    quiet(backend.resume());
  });
  api.runtime.onInstalled.addListener((details) =>
    quiet(Promise.all([backend.resume(), openInstallationWelcome(details)])),
  );
  api.alarms?.onAlarm.addListener((alarm) => {
    if ([HISTORY_ALARM, MAINTENANCE_ALARM].includes(alarm.name))
      quiet(backend.historyResume());
    if ([EVALUATION_ALARM, MAINTENANCE_ALARM].includes(alarm.name))
      quiet(backend.observe());
  });
  api.action.onClicked.addListener((tab) => {
    if (!tab?.incognito) quiet(backend.openWorkspace(tab));
  });
  quiet(backend.resume());
  return backend;
}
if (globalThis.chrome?.runtime?.onMessage && globalThis.chrome?.tabs)
  installListeners(globalThis.chrome);
