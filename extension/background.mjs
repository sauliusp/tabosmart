import {
  prepareStorageState,
  assertUserDataCapacity,
} from "./storage-budget.mjs";
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
const WORKER_EPOCH_KEY = "tabosmart.workerEpoch";
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
  let snapshotRevision = 0,
    snapshotEpoch = 0;
  const persist = () => {
    state.snapshotRevision = ++snapshotRevision;
    return api.storage.local.set({ [STORAGE_KEY]: prepareStorageState(state) });
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
    // Revisions can advance without a local write. A session-scoped generation
    // lets open workspaces reject old-worker replies after an MV3 restart.
    const previousEpoch = (await api.storage.session.get(WORKER_EPOCH_KEY))[
      WORKER_EPOCH_KEY
    ];
    snapshotEpoch =
      (Number.isSafeInteger(previousEpoch) ? previousEpoch : 0) + 1;
    await api.storage.session.set({ [WORKER_EPOCH_KEY]: snapshotEpoch });
    startSession(state, sessionId, now());
    // Only trusted extension contexts can read persisted browsing metadata.
    await api.storage.local.setAccessLevel?.({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    try {
      await persist();
    } catch (error) {
      // Legacy user-owned data must remain accessible to removal/erase controls.
      if (!local[STORAGE_KEY] || error.code !== "STORAGE_FULL") throw error;
      state.evaluation = {
        ...state.evaluation,
        state: "error",
        error: error.message,
      };
    }
    await maintainAlarms();
    updateToolbar();
    void configureHistory().catch(() => {});
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
      const tabs = await api.tabs.query({ windowType: "normal" });
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
      snapshotEpoch,
      snapshotRevision,
    };
  }
  async function actionResponse(action) {
    try {
      return { ...(await snapshot()), action };
    } catch {
      return {
        ...cachedSnapshot(),
        action,
        refreshWarning:
          "The action completed, but the tab list could not refresh. Check again for the latest tabs.",
      };
    }
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
      snapshotEpoch,
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
    assertUserDataCapacity(
      { ...state, [kind]: [entry, ...state[kind]] },
      state,
    );
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
      const rawTabs = await api.tabs.query({ windowType: "normal" });
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
      return { ...enrichedSnapshot, snapshotEpoch, snapshotRevision };
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
        snapshotEpoch,
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
      const protectedUrls = { ...state.protectedUrls };
      for (const tab of tabs) {
        if (message.protected) protectedUrls[tab.url] = now();
        else delete protectedUrls[tab.url];
      }
      assertUserDataCapacity({ ...state, protectedUrls }, state);
      const previousProtectedUrls = state.protectedUrls;
      state.protectedUrls = protectedUrls;
      try {
        await persist();
      } catch (error) {
        state.protectedUrls = previousProtectedUrls;
        throw error;
      }
    } else if (type === "focus") {
      const tab = rawTabs.find((item) => item.id === message.tabId);
      if (!tab || !isWebTab(tab))
        throw fault("This tab is no longer available.", "STALE");
      await api.windows.update(tab.windowId, { focused: true });
      await api.tabs.update(tab.id, { active: true });
    } else if (type === "settings") {
      const previousState = state;
      state = structuredClone(state);
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
        state.cached = null;
        state.pendingActivationId = null;
        state.evaluation = {
          state: "idle",
          checkedAt: state.evaluation.checkedAt,
          requestedAt: null,
          error: null,
        };
      }
      try {
        await persist();
      } catch (error) {
        state = previousState;
        throw error;
      }
      if (!state.settings.enabled && timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      const warnings = [];
      try {
        await maintainAlarms();
      } catch {
        warnings.push(
          "Your preferences were saved, but Chrome could not update background scheduling.",
        );
      }
      try {
        await configureHistory();
      } catch {
        warnings.push(
          "Your preferences were saved, but history maintenance could not finish. Check the history status or try Erase local data again.",
        );
      }
      notify();
      return actionResponse({
        type,
        ...(warnings.length ? { warning: warnings.join(" ") } : {}),
      });
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
      state.sessionId = sessionId;
      await persist();
      let warning;
      if (api.history || globalThis.indexedDB || historyOptions.store) {
        try {
          await history.stop({ erase: true });
        } catch {
          warning =
            "Tabosmart’s local records were erased and observation is off, but the history index could not be erased. Try Erase local data again.";
        }
      }
      await maintainAlarms().catch(() => {});
      notify();
      return actionResponse({ type, ...(warning ? { warning } : {}) });
    } else if (type === "forget") {
      if (!["saved", "recovery"].includes(message.kind))
        throw fault("Unknown saved list.", "INVALID_REQUEST");
      const index = state[message.kind].findIndex(
        (entry) => entry.id === message.id,
      );
      if (index < 0)
        throw fault("This saved item is no longer available.", "STALE");
      const [removed] = state[message.kind].splice(index, 1);
      try {
        await persist();
      } catch (error) {
        state[message.kind].splice(index, 0, removed);
        throw error;
      }
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
      const currentTabs = await api.tabs.query({ windowType: "normal" });
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
      const warnings = [];
      try {
        if (!target)
          await api.tabGroups.update(groupId, {
            title: name,
            color: "green",
            collapsed: false,
          });
      } catch {
        warnings.push(
          "The tabs were grouped, but the name could not be set. Rename the group in Chrome.",
        );
      }
      rememberGroupingChoice(
        state.groupingContext,
        target
          ? [...currentTabs.filter((t) => t.groupId === target.id), ...tabs]
          : tabs,
        name,
        now(),
      );
      try {
        await persist();
      } catch {
        warnings.push(
          "The tabs were grouped, but Chrome could not save this choice for future suggestions.",
        );
      }
      return actionResponse({
        type,
        groupId,
        tabIds: tabs.map((tab) => tab.id),
        ...(warnings.length ? { warning: warnings.join(" ") } : {}),
        message: target
          ? `Tabs added to ${target.title}.`
          : "Tabs grouped. Use the group menu in Chrome to ungroup them.",
      });
    } else if (type === "save") {
      const tabs = await selected(message, "save", rawTabs);
      const entry = newBatch("saved", tabs);
      try {
        await persist();
      } catch (error) {
        state.saved = state.saved.filter((item) => item !== entry);
        throw error;
      }
      return actionResponse({ type, id: entry.id, count: tabs.length });
    } else if (type === "close") {
      if (message.confirmed !== true)
        throw fault(
          "Confirm closure after reviewing these tabs. Recovery restores URLs, not unsaved page state.",
          "CONFIRMATION_REQUIRED",
        );
      const tabs = await selected(message, "close", rawTabs);
      const entry = newBatch("recovery", tabs);
      // A storage failure here aborts closure. Never remove first and save later.
      try {
        await persist();
      } catch (error) {
        state.recovery = state.recovery.filter((item) => item !== entry);
        throw error;
      }
      const closed = [],
        failed = [];
      let warning;
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
        try {
          await persist();
        } catch {
          warning = `${closed.length} tabs closed. Their URLs were saved in Recovery before closing, but Chrome could not save the latest closure status. Remaining tabs were left open.`;
          for (const remaining of tabs) {
            if (
              !closed.includes(remaining.id) &&
              !failed.some((item) => item.tabId === remaining.id)
            ) {
              failed.push({
                tabId: remaining.id,
                error: "Left open because Recovery could not be updated.",
              });
              entry.tabs.find(
                (item) => item.sourceTabId === remaining.id,
              ).status = "not-closed";
            }
          }
          break;
        }
      }
      return actionResponse({
        type,
        id: entry.id,
        closed,
        failed,
        count: closed.length,
        ...(warning ? { warning } : {}),
      });
    } else if (type === "restore") {
      if (!["saved", "recovery"].includes(message.kind))
        throw fault("Unknown saved list.", "INVALID_REQUEST");
      const entryIndex = state[message.kind].findIndex(
        (item) => item.id === message.id,
      );
      let entry = state[message.kind][entryIndex];
      if (!entry)
        throw fault("This saved item is no longer available.", "STALE");
      if (message.again === true) {
        if (message.kind !== "saved")
          throw fault(
            "Recovery items cannot be replayed. Open a saved URL manually if needed.",
            "INVALID_REQUEST",
          );
        const previousEntry = entry;
        entry = structuredClone(entry);
        state[message.kind][entryIndex] = entry;
        for (const item of entry.tabs) {
          delete item.restoredAt;
          delete item.restoredTabId;
          delete item.restorePendingAt;
          delete item.error;
          item.status = "saved";
        }
        entry.lastReplayAt = now();
        try {
          await persist();
        } catch (error) {
          state[message.kind][entryIndex] = previousEntry;
          throw error;
        }
      }
      const restored = [],
        failed = [],
        skipped = [];
      let warning;
      async function saveRestoreProgress() {
        try {
          await persist();
          return true;
        } catch {
          warning =
            "Chrome could not save the latest restore status. Opened tabs remain open; remaining URLs were left unopened. Check your tabs before trying again.";
          return false;
        }
      }
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
          let open;
          try {
            open = (await api.tabs.query({ windowType: "normal" })).find(
              (tab) => isWebTab(tab) && tab.url === item.url,
            );
          } catch {
            warning =
              "Chrome could not check the open tabs. Remaining URLs were left unopened. Try again when Chrome is ready.";
            break;
          }
          if (open) {
            item.restoredAt = now();
            item.restoredTabId = open.id;
            item.status = "restored";
            delete item.error;
            skipped.push(item.id);
            if (!(await saveRestoreProgress())) break;
            continue;
          }
          if (item.restorePendingAt) {
            item.error =
              "A previous restore could not be confirmed. Check your open tabs before opening this URL manually.";
            failed.push(item.id);
            if (!(await saveRestoreProgress())) break;
            continue;
          }
        }
        const previousItem = structuredClone(item);
        item.restorePendingAt = now();
        if (!(await saveRestoreProgress())) {
          entry.tabs[entry.tabs.indexOf(item)] = previousItem;
          failed.push(item.id);
          break;
        }
        try {
          const regularWindow = (
            await api.tabs.query({ windowType: "normal" })
          ).find((tab) => !tab.incognito && Number.isInteger(tab.windowId));
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
          item.restoredTabId = tab.id;
          item.restoredAt = now();
          item.status = "restored";
          delete item.error;
          restored.push(tab.id);
        } catch (error) {
          delete item.restorePendingAt;
          item.error = error.message;
          failed.push(item.id);
        }
        // Native creation has committed. A failed checkpoint must never classify
        // the same URL as both opened and failed, or make the whole action fail.
        if (!(await saveRestoreProgress())) break;
      }
      return actionResponse({
        type,
        restored,
        failed,
        skipped,
        count: restored.length,
        ...(warning ? { warning } : {}),
      });
    } else throw fault("Unknown request.", "INVALID_REQUEST");
    return actionResponse({ type });
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
        state?.settings.enabled !== false &&
        !tab?.incognito &&
        Number.isInteger(tab?.openerTabId)
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
