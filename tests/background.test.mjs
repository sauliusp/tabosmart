import test from "node:test";
import assert from "node:assert/strict";
import {
  createBackend,
  STORAGE_KEY,
  installListeners,
  EVALUATION_ALARM,
  MAINTENANCE_ALARM,
} from "../extension/background.mjs";
import { DAY, createState } from "../extension/core.mjs";
import { discoveryKey } from "../extension/group-discovery.mjs";

const T = 1_800_000_000_000;
const copy = (value) => structuredClone(value);
const tab = (id, patch = {}) => ({
  id,
  url: `https://example.test/${id}`,
  title: `Example ${id}`,
  windowId: 1,
  groupId: -1,
  index: id,
  active: false,
  pinned: false,
  audible: false,
  incognito: false,
  ...patch,
});
function fixture(initial = [tab(1), tab(2), tab(3)], local = {}, session = {}) {
  let tabs = copy(initial),
    clock = T,
    nextId = 100,
    nextTimer = 1;
  const timers = new Map(),
    alarms = new Map();
  const calls = [],
    toolbarCalls = [],
    failures = {
      remove: new Set(),
      create: new Set(),
      kept: new Set(),
      storage: false,
      pinOnGet: null,
      query: false,
    };
  let nativeGroups = [];
  const event = () => ({
    listeners: [],
    addListener(fn) {
      this.listeners.push(fn);
    },
    removeListener(fn) {
      this.listeners = this.listeners.filter((listener) => listener !== fn);
    },
  });
  const api = {
    storage: {
      local: {
        async get(key) {
          return { [key]: copy(local[key]) };
        },
        async set(value) {
          calls.push(["persist"]);
          if (failures.storage) throw new Error("Storage full");
          Object.assign(local, copy(value));
        },
        async setAccessLevel() {},
      },
      session: {
        async get(key) {
          return { [key]: session[key] };
        },
        async set(value) {
          Object.assign(session, copy(value));
        },
      },
    },
    tabs: {
      async query(filter = {}) {
        calls.push(["query"]);
        if (failures.query) throw new Error("Browser temporarily unavailable");
        return copy(
          tabs.filter(
            (item) =>
              filter.windowId === undefined ||
              item.windowId === filter.windowId,
          ),
        );
      },
      async get(id) {
        if (failures.pinOnGet === id)
          tabs.find((t) => t.id === id).pinned = true;
        const item = tabs.find((t) => t.id === id);
        if (!item) throw new Error("No tab");
        return copy(item);
      },
      async remove(id) {
        calls.push(["remove", id]);
        if (failures.remove.has(id))
          throw new Error("Chrome could not close this tab");
        if (!failures.kept.has(id)) tabs = tabs.filter((t) => t.id !== id);
      },
      async create(props) {
        calls.push(["create", copy(props)]);
        if (failures.create.has(props.url))
          throw new Error("Could not open URL");
        const item = tab(nextId++, props);
        tabs.push(item);
        return copy(item);
      },
      async update(id, patch) {
        const item = tabs.find((t) => t.id === id);
        if (!item) throw new Error("No tab");
        Object.assign(item, patch);
        calls.push(["update", id, patch]);
        return copy(item);
      },
      async group({ tabIds, createProperties, groupId }) {
        calls.push(["group", tabIds, createProperties, groupId]);
        tabs
          .filter((t) => tabIds.includes(t.id))
          .forEach((t) => {
            t.groupId = groupId ?? 55;
          });
        return groupId ?? 55;
      },
      onActivated: event(),
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onReplaced: event(),
      onAttached: event(),
      onDetached: event(),
      onMoved: event(),
    },
    windows: {
      async update(id, patch) {
        calls.push(["window", id, patch]);
      },
      async create(props) {
        const item = tab(nextId++, { url: props.url, windowId: 9 });
        tabs.push(item);
        return { id: 9, tabs: [copy(item)] };
      },
      onCreated: event(),
      onRemoved: event(),
      onFocusChanged: event(),
    },
    tabGroups: {
      async query() {
        return copy(nativeGroups);
      },
      async update(id, props) {
        calls.push(["groupUpdate", id, props]);
        const group = nativeGroups.find((g) => g.id === id);
        if (group) Object.assign(group, props);
        else
          nativeGroups.push({
            id,
            windowId: tabs.find((t) => t.groupId === id)?.windowId,
            ...props,
          });
      },
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onMoved: event(),
    },
    runtime: {
      id: "test-id",
      getURL: (path) => `chrome-extension://test-id/${path}`,
      async sendMessage(message) {
        calls.push(["notify", message]);
      },
      onMessage: event(),
      onStartup: event(),
      onInstalled: event(),
      onConnect: event(),
    },
    action: {
      onClicked: event(),
      async setIcon(value) {
        toolbarCalls.push(["icon", copy(value)]);
      },
      async setTitle(value) {
        toolbarCalls.push(["title", copy(value)]);
      },
      async setBadgeText(value) {
        toolbarCalls.push(["badge", copy(value)]);
      },
      async setBadgeBackgroundColor(value) {
        toolbarCalls.push(["badgeColor", copy(value)]);
      },
      async setBadgeTextColor(value) {
        toolbarCalls.push(["textColor", copy(value)]);
      },
    },
    alarms: {
      async get(name) {
        return alarms.get(name);
      },
      async create(name, props) {
        alarms.set(name, copy(props));
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: event(),
    },
  };
  const backend = (options = {}) =>
    createBackend(api, {
      now: () => clock,
      setTimer: (fn, delay) => {
        const timerId = nextTimer++;
        timers.set(timerId, { fn, delay });
        return timerId;
      },
      clearTimer: (timerId) => timers.delete(timerId),
      ...options,
    });
  return {
    api,
    backend,
    calls,
    toolbarCalls,
    event,
    failures,
    setNativeGroups: (groups) => {
      nativeGroups = copy(groups);
    },
    local,
    session,
    timers,
    alarms,
    runTimers: async () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) await timer.fn();
    },
    setTime: (value) => {
      clock = value;
    },
    mutate: (fn) => fn(tabs),
    tabs: () => copy(tabs),
  };
}
async function enabled(f) {
  const b = f.backend();
  const r = await b.handle({ type: "settings", patch: { enabled: true } });
  assert.equal(r.ok, true);
  return b;
}

test("fresh installation starts local observation and history preference with a dismissible disclosure", async () => {
  const f = fixture(),
    b = f.backend();
  const first = await b.handle({ type: "snapshot" });
  assert.equal(first.ok, true);
  assert.equal(first.settings.enabled, true);
  assert.equal(first.settings.historyEnabled, true);
  assert.equal(first.settings.aiEnabled, true);
  assert.equal(first.settings.aiPreferenceSource, "default");
  assert.equal(first.consentAt, T);
  assert.equal(first.installDisclosure, true);
  assert.equal(first.tabs.length, 3);
  assert.equal(first.evaluationSummary.webTabsChecked, 3);
  assert.equal(Object.keys(f.local[STORAGE_KEY].observations).length, 3);
  assert.equal(f.alarms.get(MAINTENANCE_ALARM).periodInMinutes, 15);
  const dismissed = await b.handle({ type: "dismissDisclosure" });
  assert.equal(dismissed.installDisclosure, false);
  assert.equal(dismissed.settings.enabled, true);
  assert.equal(
    (await f.backend().handle({ type: "cachedSnapshot" })).installDisclosure,
    false,
  );
});

test("persisted pause gates query and metadata, blocks events, and starts fresh on resume", async () => {
  const f = fixture(undefined, { [STORAGE_KEY]: createState(T) }),
    b = f.backend();
  const first = await b.handle({ type: "snapshot" });
  await b.observe(1);
  assert.equal(first.settings.enabled, false);
  assert.deepEqual(first.tabs, []);
  assert.equal(f.calls.filter((c) => c[0] === "query").length, 0);
  assert.deepEqual(f.local[STORAGE_KEY].observations, {});
  await b.handle({ type: "settings", patch: { enabled: true } });
  assert.equal(f.local[STORAGE_KEY].consentAt, T);
  await b.handle({ type: "settings", patch: { enabled: false } });
  const count = f.calls.length;
  f.setTime(T + 10 * DAY);
  await b.observe(1);
  await b.handle({ type: "snapshot" });
  assert.equal(f.calls.length, count);
  const resumed = await b.handle({
    type: "settings",
    patch: { enabled: true },
  });
  assert.equal(resumed.tabs[0].inactivityDays, 0);
  assert.equal(
    resumed.suggestions.some((s) => s.type === "inactive"),
    false,
  );
});

test("state survives worker recreation and browser restart retains exact-URL evidence with a grace period", async () => {
  const f = fixture([tab(1)]),
    b = await enabled(f);
  f.setTime(T + 8 * DAY);
  const resumed = await f.backend().handle({ type: "snapshot" });
  assert.equal(resumed.suggestions[0].type, "inactive");
  for (const key of Object.keys(f.session)) delete f.session[key];
  f.mutate((tabs) => {
    tabs[0].id = 90;
  });
  const restartBackend = f.backend();
  const restarted = await restartBackend.handle({ type: "snapshot" });
  assert.equal(restarted.tabs[0].inactivityDays, 8);
  assert.equal(restarted.tabs[0].firstSeenThisSessionAt, T + 8 * DAY);
  assert.equal(restarted.tabs[0].historySource, "prior-session-url");
  assert.equal(restarted.suggestions.length, 0);
  f.setTime(T + 8 * DAY + 5 * 60_000);
  const settled = await restartBackend.handle({ type: "snapshot" });
  assert.equal(settled.suggestions[0].type, "inactive");
  assert.match(settled.suggestions[0].reason, /URLs.*reopened or changed/);
});

test("close requires confirmation and stable displayed URL identity", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  assert.equal(
    (await b.handle({ type: "close", tabIds: [1], expectedTabs: snap.tabs }))
      .code,
    "CONFIRMATION_REQUIRED",
  );
  assert.equal(
    (await b.handle({ type: "close", tabIds: [1], confirmed: true })).code,
    "REVIEW_REQUIRED",
  );
  f.mutate((tabs) => {
    tabs[0].url = "https://new.test";
  });
  assert.equal(
    (
      await b.handle({
        type: "close",
        tabIds: [1],
        expectedTabs: snap.tabs,
        confirmed: true,
      })
    ).code,
    "STALE",
  );
  assert.equal(
    f.calls.some((c) => c[0] === "remove"),
    false,
  );
});

test("close writes recovery first, retains partial failures, and rechecks safety per item", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  f.failures.remove.add(2);
  f.failures.pinOnGet = 3;
  const start = f.calls.length;
  const result = await b.handle({
    type: "close",
    tabIds: [1, 2, 3],
    expectedTabs: snap.tabs,
    confirmed: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.action.closed, [1]);
  assert.deepEqual(
    result.action.failed.map((x) => x.tabId),
    [2, 3],
  );
  assert.equal(
    result.recovery[0].tabs.find((t) => t.sourceTabId === 1).status,
    "closed",
  );
  assert.equal(
    result.recovery[0].tabs.find((t) => t.sourceTabId === 2).status,
    "not-closed",
  );
  const performed = f.calls.slice(start),
    firstRemove = performed.findIndex((c) => c[0] === "remove");
  assert.ok(performed.slice(0, firstRemove).some((c) => c[0] === "persist"));
  assert.equal(
    performed.some((c) => c[0] === "remove" && c[1] === 3),
    false,
  );
  const restored = await b.handle({
    type: "restore",
    kind: "recovery",
    id: result.action.id,
  });
  assert.equal(restored.action.restored.length, 1);
  assert.equal(restored.action.skipped.length, 2);
});

test("storage failure aborts all closure and Chrome retaining a tab is not claimed closed", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  f.failures.storage = true;
  const failed = await b.handle({
    type: "close",
    tabIds: [1],
    expectedTabs: snap.tabs,
    confirmed: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(
    f.calls.some((c) => c[0] === "remove"),
    false,
  );
  f.failures.storage = false;
  f.failures.kept.add(1);
  const kept = await b.handle({
    type: "close",
    tabIds: [1],
    expectedTabs: snap.tabs,
    confirmed: true,
  });
  assert.equal(kept.action.closed.length, 0);
  assert.match(kept.action.failed[0].error, /kept this tab open/);
});

test("shelf save leaves tabs open and restore is per-item idempotent with retryable partial failure", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  const saved = await b.handle({
    type: "save",
    tabIds: [1, 2],
    expectedTabs: snap.tabs,
  });
  assert.equal(f.tabs().length, 3);
  assert.equal(saved.saved.length, 1);
  f.failures.create.add(snap.tabs[1].url);
  const first = await b.handle({
    type: "restore",
    id: saved.action.id,
    kind: "saved",
  });
  assert.equal(first.action.restored.length, 1);
  assert.equal(first.action.failed.length, 1);
  assert.equal(first.saved[0].tabs[0].restoredTabId, 100);
  f.failures.create.clear();
  const second = await b.handle({
    type: "restore",
    id: saved.action.id,
    kind: "saved",
  });
  assert.equal(second.action.restored.length, 1);
  assert.equal(second.action.skipped.length, 1);
  const third = await b.handle({
    type: "restore",
    id: saved.action.id,
    kind: "saved",
  });
  assert.equal(third.action.restored.length, 0);
  assert.equal(f.tabs().length, 5);
  assert.ok(
    f.calls
      .filter((c) => c[0] === "create")
      .every((c) => c[1].windowId === 1 && c[1].active === false),
  );
});

test("interrupted restore does not blindly duplicate a redirected or missing page", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  const saved = await b.handle({
    type: "save",
    tabIds: [1],
    expectedTabs: snap.tabs,
  });
  f.local[STORAGE_KEY].saved[0].tabs[0].restorePendingAt = T;
  f.mutate((tabs) => {
    tabs[0].url = "https://redirected.test/";
  });
  const result = await f
    .backend()
    .handle({ type: "restore", id: saved.action.id, kind: "saved" });
  assert.equal(result.action.restored.length, 0);
  assert.equal(result.action.failed.length, 1);
  assert.match(result.saved[0].tabs[0].error, /could not be confirmed/);
  assert.equal(
    f.calls.some((c) => c[0] === "create"),
    false,
  );
});

test("group validation preserves native groups/windows and stale suggestion membership", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  const group = snap.suggestions.find((s) => s.type === "group");
  f.mutate((tabs) => {
    tabs[2].windowId = 2;
  });
  const changed = await b.handle({
    type: "group",
    suggestionId: group.id,
    tabIds: group.tabIds,
    expectedTabs: group.tabs,
    name: "Client work",
  });
  assert.equal(changed.code, "STALE");
  assert.equal(
    f.calls.some((c) => c[0] === "group"),
    false,
  );
  f.mutate((tabs) => {
    tabs[2].windowId = 1;
  });
  const result = await b.handle({
    type: "group",
    suggestionId: group.id,
    tabIds: [1, 2],
    expectedTabs: group.tabs,
    name: "Client work",
  });
  assert.equal(result.action.groupId, 55);
  assert.equal(f.tabs()[2].groupId, -1);
  assert.deepEqual(f.calls.find((c) => c[0] === "group")[2], { windowId: 1 });
  assert.match(result.action.message, /ungroup/);
});

test("exact URL protection survives reopening and blocks close", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  const protectedResult = await b.handle({
    type: "protect",
    tabIds: [1],
    expectedTabs: snap.tabs,
    protected: true,
  });
  assert.equal(protectedResult.tabs[0].protected, true);
  const rejected = await b.handle({
    type: "close",
    tabIds: [1],
    expectedTabs: protectedResult.tabs,
    confirmed: true,
  });
  assert.equal(rejected.code, "PROTECTED");
  f.mutate((tabs) => {
    tabs[0].id = 90;
  });
  const reopened = await f.backend().handle({ type: "snapshot" });
  assert.equal(reopened.tabs.find((t) => t.id === 90).protected, true);
});

test("clearData deletes local browsing records and shelf and stops tracking immediately", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  await b.handle({ type: "save", tabIds: [1], expectedTabs: snap.tabs });
  const cleared = await b.handle({ type: "clearData" });
  assert.equal(cleared.settings.enabled, false);
  assert.equal(cleared.saved.length, 0);
  assert.deepEqual(f.local[STORAGE_KEY].observations, {});
  assert.deepEqual(cleared.tabs, []);
  assert.equal(f.tabs().length, 3);
});

test("toolbar reuses its own normal workspace and runtime rejects webpage senders", async () => {
  const f = fixture([
    tab(1, { url: "chrome-extension://test-id/index.html#shelf" }),
  ]);
  await f.backend().openWorkspace();
  assert.equal(
    f.calls.some((c) => c[0] === "create"),
    false,
  );
  assert.ok(f.calls.some((c) => c[0] === "update" && c[1] === 1));
  installListeners(f.api);
  const listener = f.api.runtime.onMessage.listeners[0];
  assert.equal(
    listener(
      { type: "close" },
      { id: "test-id", url: "https://evil.test" },
      () => {},
    ),
    false,
  );
  assert.equal(
    listener({ type: "snapshot" }, { id: "other" }, () => {}),
    false,
  );
});

test("closeWorkspace routes the trusted live sender to the helper and ignores payload tab IDs", async () => {
  const own = "chrome-extension://test-id/index.html?source=toolbar#review";
  const f = fixture([tab(1), tab(2, { url: own }), tab(3, { windowId: 2 })]);
  const b = f.backend();
  const invalid = await b.handle(
    { type: "closeWorkspace", tabId: 2 },
    { id: "test-id", url: own, tab: { id: 1 } },
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "INVALID_WORKSPACE");
  assert.equal(
    f.calls.some((call) => call[0] === "remove"),
    false,
  );
  const closed = await b.handle(
    { type: "closeWorkspace", tabId: 3 },
    { id: "test-id", url: own, tab: { id: 2 } },
  );
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  assert.equal(closed.tabId, 2);
  assert.deepEqual(
    f.calls.filter((call) => call[0] === "remove"),
    [["remove", 2]],
  );
  assert.deepEqual(
    f.tabs().map((item) => item.id),
    [1, 3],
  );
  assert.equal(
    f.calls.some((call) => call[0] === "window"),
    false,
  );
  // Workspace controls do not initialize browsing observation as a side effect.
  assert.equal(f.local[STORAGE_KEY], undefined);
});

test("runtime closeWorkspace forwards the actual sender and toolbar clicks retain invoking window", async () => {
  const own = "chrome-extension://test-id/index.html";
  const f = fixture([tab(1), tab(2, { windowId: 2 })], {
    [STORAGE_KEY]: createState(T),
  });
  const b = installListeners(f.api);
  await b.handle({ type: "cachedSnapshot" });
  assert.equal(f.api.runtime.onConnect.listeners.length, 1);
  assert.equal(f.api.action.onClicked.listeners.length, 1);
  f.api.action.onClicked.listeners[0](tab(2, { windowId: 2 }));
  await new Promise((resolve) => setImmediate(resolve));
  const workspace = f.tabs().find((item) => item.url === own);
  assert.equal(workspace.windowId, 2);
  const listener = f.api.runtime.onMessage.listeners[0];
  assert.equal(
    listener(
      { type: "closeWorkspace" },
      {
        id: "test-id",
        url: "https://example.test/",
        tab: { id: workspace.id },
      },
      () => assert.fail("Untrusted page received a response"),
    ),
    false,
  );
  const closed = await new Promise((resolve) => {
    assert.equal(
      listener(
        { type: "closeWorkspace", tabId: 1 },
        { id: "test-id", url: own, tab: { id: workspace.id } },
        resolve,
      ),
      true,
    );
  });
  assert.equal(closed.ok, true);
  assert.deepEqual(
    f.tabs().map((item) => item.id),
    [1, 2],
  );
  assert.equal(closed.focusedTabId, 2);
  assert.equal(
    f.calls.some((call) => call[0] === "window" && call[1] === 1),
    false,
  );
});

test("backend toolbar tracks actual checks, completion counts, and connected AI work", async () => {
  const f = fixture(),
    b = f.backend();
  const done = await b.handle({ type: "snapshot" });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const latest = (kind) =>
    f.toolbarCalls.findLast((call) => call[0] === kind)?.[1];
  await flush();
  assert.equal(latest("badge").text, String(done.suggestions.length));
  assert.match(latest("title").title, /1 suggestion.*Open workspace/);
  await b.schedule();
  await flush();
  assert.equal(latest("badge").text, "…");
  assert.match(latest("title").title, /tab check is queued/);
  await f.runTimers();
  await flush();
  assert.equal(latest("badge").text, "1");

  const reports = [],
    port = {
      name: "tabosmart-ai-activity",
      sender: { id: "test-id", url: "chrome-extension://test-id/index.html" },
      onMessage: f.event(),
      onDisconnect: f.event(),
      postMessage(value) {
        reports.push(value);
      },
    };
  b.connect(port);
  await flush();
  assert.ok(reports.some((value) => value.type === "requestAIActivity"));
  port.onMessage.listeners[0]({
    type: "aiActivity",
    enabled: true,
    setup: "idle",
    naming: true,
    wording: false,
  });
  await flush();
  assert.equal(latest("badge").text, "AI");
  assert.match(latest("title").title, /Generating group names locally/);
  port.onDisconnect.listeners[0]();
  await flush();
  assert.equal(latest("badge").text, "1");
  f.failures.query = true;
  assert.equal((await b.handle({ type: "snapshot" })).ok, false);
  await flush();
  assert.equal(latest("badge").text, "!");
  assert.match(
    latest("title").title,
    /latest tab check did not finish.*1 suggestion from the last completed check/,
  );
  assert.equal(
    (await b.handle({ type: "settings", patch: { enabled: false } })).ok,
    true,
  );
  await flush();
  assert.equal(latest("badge").text, "");
  assert.match(latest("title").title, /Tab observation paused/);
});

test("full recovery refuses additional close without discarding older records", async () => {
  const s = createState(T);
  s.settings.enabled = true;
  s.sessionId = "s";
  s.recovery = Array.from({ length: 100 }, (_, i) => ({
    id: `${i}`,
    tabs: [{ id: "0", url: "https://old.test", status: "closed" }],
  }));
  const f = fixture(
      [tab(1)],
      { [STORAGE_KEY]: s },
      { "tabosmart.session": "s" },
    ),
    b = f.backend();
  const snap = await b.handle({ type: "snapshot" });
  const result = await b.handle({
    type: "close",
    tabIds: [1],
    expectedTabs: snap.tabs,
    confirmed: true,
  });
  assert.equal(result.code, "STORAGE_FULL");
  assert.equal(
    f.calls.some((c) => c[0] === "remove"),
    false,
  );
  assert.equal(f.local[STORAGE_KEY].recovery.length, 100);
});

test("event bursts coalesce into one check, persist checking, and cached reads never re-evaluate", async () => {
  const f = fixture(),
    b = await enabled(f);
  const queries = f.calls.filter((c) => c[0] === "query").length;
  await Promise.all(Array.from({ length: 30 }, () => b.schedule()));
  assert.equal(f.timers.size, 1);
  assert.equal(f.calls.filter((c) => c[0] === "query").length, queries);
  assert.equal(f.local[STORAGE_KEY].evaluation.state, "checking");
  assert.equal(f.alarms.get(EVALUATION_ALARM).delayInMinutes, 0.5);
  assert.equal(f.alarms.get(MAINTENANCE_ALARM).periodInMinutes, 15);
  const checking = await b.handle({ type: "cachedSnapshot" });
  assert.equal(checking.evaluation.state, "checking");
  await f.runTimers();
  const done = await b.handle({ type: "cachedSnapshot" });
  assert.equal(done.evaluation.state, "idle");
  assert.equal(done.evaluation.checkedAt, T);
  assert.equal(f.calls.filter((c) => c[0] === "query").length, queries + 1);
  const settledCalls = f.calls.length;
  await Promise.all(
    Array.from({ length: 20 }, () => b.handle({ type: "cachedSnapshot" })),
  );
  assert.equal(f.calls.length, settledCalls);
  assert.equal(f.alarms.has(EVALUATION_ALARM), false);
  assert.equal(f.timers.size, 0);
});

test("sustained events have a bounded settle delay instead of starving checks", async () => {
  const f = fixture(),
    b = await enabled(f);
  await b.schedule();
  f.setTime(T + 1900);
  await b.schedule();
  assert.equal([...f.timers.values()][0].delay, 100);
  f.setTime(T + 2100);
  await b.schedule();
  assert.equal([...f.timers.values()][0].delay, 0);
  await f.runTimers();
  assert.equal(
    (await b.handle({ type: "cachedSnapshot" })).evaluation.state,
    "idle",
  );
});

test("pending evaluation survives a worker stop and missing alarm and reconciles automatically", async () => {
  const f = fixture(),
    b = await enabled(f);
  await b.schedule(1);
  f.timers.clear();
  f.alarms.delete(EVALUATION_ALARM);
  f.mutate((tabs) => {
    tabs.push(tab(4, { url: "https://new.test/" }));
  });
  const resumed = f.backend();
  await resumed.resume();
  assert.equal(f.alarms.has(EVALUATION_ALARM), true);
  assert.equal(
    (await resumed.handle({ type: "cachedSnapshot" })).evaluation.state,
    "checking",
  );
  await f.runTimers();
  const snap = await resumed.handle({ type: "cachedSnapshot" });
  assert.equal(snap.tabs.length, 4);
  assert.equal(snap.evaluation.state, "idle");
});

test("failed checks retain last result and expose error, then recover without touching tabs", async () => {
  const f = fixture(),
    b = await enabled(f);
  f.failures.query = true;
  await b.schedule();
  await f.runTimers();
  const failed = await b.handle({ type: "cachedSnapshot" });
  assert.equal(failed.tabs.length, 3);
  assert.equal(failed.evaluation.state, "error");
  assert.match(failed.evaluation.error, /could not finish/);
  assert.equal(
    f.calls.some((c) => ["remove", "group", "create"].includes(c[0])),
    false,
  );
  f.failures.query = false;
  await b.schedule();
  await f.runTimers();
  assert.equal(
    (await b.handle({ type: "cachedSnapshot" })).evaluation.state,
    "idle",
  );
});

test("pause cancels pending evaluation and maintenance alarms", async () => {
  const f = fixture(),
    b = await enabled(f);
  await b.schedule();
  await b.handle({ type: "settings", patch: { enabled: false } });
  assert.equal(f.timers.size, 0);
  assert.equal(f.alarms.size, 0);
  const queries = f.calls.filter((c) => c[0] === "query").length;
  await b.schedule();
  await b.resume();
  await f.runTimers();
  assert.equal(f.calls.filter((c) => c[0] === "query").length, queries);
  assert.deepEqual((await b.handle({ type: "cachedSnapshot" })).tabs, []);
});

test("all requested browser event surfaces are registered and notifications are ignored as commands", () => {
  const f = fixture();
  installListeners(f.api);
  for (const name of ["onMoved", "onReplaced", "onAttached", "onDetached"])
    assert.equal(f.api.tabs[name].listeners.length, 1);
  for (const name of ["onCreated", "onUpdated", "onRemoved", "onMoved"])
    assert.equal(f.api.tabGroups[name].listeners.length, 1);
  for (const name of ["onCreated", "onRemoved", "onFocusChanged"])
    assert.equal(f.api.windows[name].listeners.length, 1);
  assert.equal(f.api.alarms.onAlarm.listeners.length, 1);
  assert.equal(
    f.api.runtime.onMessage.listeners[0](
      { type: "snapshotChanged" },
      { id: "test-id" },
      () => {},
    ),
    false,
  );
});

test("saved list is reusable only with explicit again flag, while recovery replay is rejected", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  const saved = await b.handle({
    type: "save",
    tabIds: [1],
    expectedTabs: snap.tabs,
  });
  const args = { type: "restore", kind: "saved", id: saved.action.id };
  assert.equal((await b.handle(args)).action.count, 1);
  assert.equal((await b.handle(args)).action.count, 0);
  assert.equal((await b.handle({ ...args, again: true })).action.count, 1);
  assert.equal((await b.handle(args)).action.count, 0);
  const closed = await b.handle({
    type: "close",
    tabIds: [1],
    expectedTabs: snap.tabs,
    confirmed: true,
  });
  assert.equal(
    (
      await b.handle({
        type: "restore",
        kind: "recovery",
        id: closed.action.id,
        again: true,
      })
    ).code,
    "INVALID_REQUEST",
  );
});

test("AI defaults on in a stored paused workspace and explicit opt-out persists", async () => {
  const f = fixture(undefined, { [STORAGE_KEY]: createState(T) }),
    b = f.backend();
  const first = await b.handle({ type: "snapshot" });
  assert.equal(first.settings.aiEnabled, true);
  assert.equal(first.settings.aiPreferenceSource, "default");
  assert.equal(first.settings.enabled, false);
  assert.deepEqual(first.tabs, []);
  assert.deepEqual(first.suggestions, []);
  assert.equal(
    f.calls.some((call) => call[0] === "query"),
    false,
  );
  assert.equal(f.alarms.size, 0);
  assert.equal(f.timers.size, 0);

  const optedOut = await b.handle({
    type: "settings",
    patch: { aiEnabled: false },
  });
  assert.equal(optedOut.settings.aiEnabled, false);
  assert.equal(optedOut.settings.aiPreferenceSource, "user");
  assert.equal(optedOut.settings.enabled, false);
  assert.equal(
    f.calls.some((call) => call[0] === "query"),
    false,
  );
  const recreated = f.backend();
  const resumed = await recreated.handle({ type: "cachedSnapshot" });
  assert.equal(resumed.settings.aiEnabled, false);
  assert.equal(resumed.settings.aiPreferenceSource, "user");
  const consented = await recreated.handle({
    type: "settings",
    patch: { enabled: true, inactivityDays: 14 },
  });
  assert.equal(consented.settings.aiEnabled, false);
  assert.equal(consented.settings.aiPreferenceSource, "user");
  assert.equal(consented.settings.enabled, true);
});

test("explicit AI choice including an unchanged value is durable and erase restores a paused workspace", async () => {
  const f = fixture(),
    b = await enabled(f);
  const enabledAI = await b.handle({
    type: "settings",
    patch: { aiEnabled: true },
  });
  assert.equal(enabledAI.settings.aiEnabled, true);
  assert.equal(enabledAI.settings.aiPreferenceSource, "user");
  assert.equal(enabledAI.settings.enabled, true);
  const restarted = await f.backend().handle({ type: "cachedSnapshot" });
  assert.equal(restarted.settings.aiEnabled, true);
  assert.equal(restarted.settings.aiPreferenceSource, "user");
  await b.handle({ type: "settings", patch: { aiEnabled: false } });
  const queriesBeforeErase = f.calls.filter(
    (call) => call[0] === "query",
  ).length;
  const erased = await b.handle({ type: "clearData" });
  assert.equal(erased.settings.aiEnabled, true);
  assert.equal(erased.settings.aiPreferenceSource, "default");
  assert.equal(erased.settings.enabled, false);
  assert.equal(erased.consentAt, null);
  assert.deepEqual(erased.tabs, []);
  assert.deepEqual(erased.suggestions, []);
  assert.equal(
    f.calls.filter((call) => call[0] === "query").length,
    queriesBeforeErase,
  );
  assert.equal(f.alarms.size, 0);
  assert.equal(f.timers.size, 0);
  const afterErase = await f.backend().handle({ type: "snapshot" });
  assert.equal(afterErase.settings.aiEnabled, true);
  assert.equal(afterErase.settings.aiPreferenceSource, "default");
  assert.equal(afterErase.settings.enabled, false);
  assert.equal(
    f.calls.filter((call) => call[0] === "query").length,
    queriesBeforeErase,
  );
});

test("legacy preference migration persists its uncertainty across unrelated settings and worker reloads", async () => {
  for (const [legacySettings, expectedEnabled, expectedSource] of [
    [{ enabled: false }, true, "default"],
    [{ aiEnabled: false }, false, "legacy-unknown"],
    [{ aiEnabled: true }, true, "user"],
    [{ aiEnabled: false, aiPreferenceSource: "user" }, false, "user"],
  ]) {
    const raw = { version: 1, settings: legacySettings };
    const f = fixture([tab(1)], { [STORAGE_KEY]: raw }),
      b = f.backend();
    const migrated = await b.handle({ type: "cachedSnapshot" });
    assert.equal(migrated.settings.aiEnabled, expectedEnabled);
    assert.equal(migrated.settings.aiPreferenceSource, expectedSource);
    await b.handle({
      type: "settings",
      patch: { inactivityDays: 14, aiPreferenceSource: "user" },
    });
    const restarted = await f.backend().handle({ type: "snapshot" });
    assert.equal(restarted.settings.aiEnabled, expectedEnabled);
    assert.equal(restarted.settings.aiPreferenceSource, expectedSource);
    assert.equal(
      f.local[STORAGE_KEY].settings.aiPreferenceSource,
      expectedSource,
    );
    assert.equal(
      f.calls.some((call) => call[0] === "query"),
      false,
    );
  }
});

test("accepted grouping stays resolved after native ungroup until membership changes", async () => {
  const f = fixture(),
    b = await enabled(f),
    snap = await b.handle({ type: "snapshot" });
  const group = snap.suggestions.find((item) => item.type === "group");
  const result = await b.handle({
    type: "group",
    suggestionId: group.id,
    tabIds: group.tabIds,
    expectedTabs: group.tabs,
    name: "Example",
  });
  assert.equal(result.ok, true);
  f.mutate((tabs) => {
    tabs.forEach((t) => {
      t.groupId = -1;
    });
  });
  await b.schedule();
  await f.runTimers();
  assert.equal(
    (await b.handle({ type: "cachedSnapshot" })).suggestions.some(
      (item) => item.type === "group",
    ),
    false,
  );
  f.mutate((tabs) => {
    tabs.push(tab(4));
  });
  await b.schedule();
  await f.runTimers();
  assert.equal(
    (await b.handle({ type: "cachedSnapshot" })).suggestions.some(
      (item) => item.type === "group",
    ),
    true,
  );
});

const newsTabs = () => [
  tab(1, {
    url: "https://source-one.test/",
    title: "Lietuvos naujienos ir žinios",
    groupId: 7,
  }),
  tab(2, {
    url: "https://source-two.test/",
    title: "Naujienų portalas Lietuvoje",
    groupId: 7,
  }),
  tab(3, {
    url: "https://source-three.test/",
    title: "Žinios, kurios šviečia",
  }),
];
test("a duplicate review does not hide other valid additions to a complete existing group", async () => {
  const tabs = newsTabs();
  tabs.push(tab(4, { url: tabs[2].url, title: tabs[2].title }));
  tabs.push(
    tab(5, { url: "https://source-four.test/", title: "Naujienų portalas" }),
  );
  const f = fixture(tabs);
  f.setNativeGroups([{ id: 7, windowId: 1, title: "Naujienos" }]);
  const b = await enabled(f);
  const suggestions = (await b.handle({ type: "snapshot" })).suggestions;
  assert.ok(suggestions.some((s) => s.type === "duplicate"));
  const addition = suggestions.find((s) => s.signal === "existing-group");
  assert.deepEqual(addition.tabIds, [3, 5]);
  assert.deepEqual(
    addition.targetGroup.members.map((t) => t.id),
    [1, 2],
  );
});

test("one reviewed tab joins an existing group without changing its name or settings", async () => {
  const f = fixture(newsTabs());
  f.setNativeGroups([
    {
      id: 7,
      windowId: 1,
      title: "Mano naujienos",
      color: "red",
      collapsed: true,
    },
  ]);
  const b = await enabled(f);
  const suggestion = (await b.handle({ type: "snapshot" })).suggestions[0];
  assert.equal(suggestion.signal, "existing-group");
  assert.deepEqual(suggestion.tabIds, [3]);
  assert.equal(suggestion.nameLocked, true);
  const result = await b.handle({
    type: "group",
    suggestionId: suggestion.id,
    tabIds: [3],
    expectedTabs: suggestion.tabs,
    name: "Do not rename the destination",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.action.groupId, 7);
  assert.equal(f.tabs().find((t) => t.id === 3).groupId, 7);
  assert.equal(
    f.calls.some((call) => call[0] === "groupUpdate"),
    false,
  );
  assert.equal(
    f.local[STORAGE_KEY].groupingContext.choices[0].name,
    "Mano naujienos",
  );
  assert.equal((await f.api.tabGroups.query())[0].collapsed, true);
});

test("existing group rename and membership changes invalidate an opened review", async () => {
  for (const change of ["name", "member", "window"]) {
    const f = fixture(newsTabs());
    f.setNativeGroups([{ id: 7, windowId: 1, title: "Naujienos" }]);
    const b = await enabled(f);
    const suggestion = (await b.handle({ type: "snapshot" })).suggestions[0];
    if (change === "name")
      f.setNativeGroups([{ id: 7, windowId: 1, title: "Changed" }]);
    if (change === "member")
      f.mutate((tabs) =>
        tabs.push(tab(4, { groupId: 7, title: "News homepage" })),
      );
    if (change === "window")
      f.setNativeGroups([{ id: 7, windowId: 2, title: "Naujienos" }]);
    const result = await b.handle({
      type: "group",
      suggestionId: suggestion.id,
      tabIds: [3],
      expectedTabs: suggestion.tabs,
    });
    assert.equal(result.ok, false, change);
    assert.equal(result.code, "STALE", change);
    assert.equal(
      f.calls.some((call) => call[0] === "group"),
      false,
    );
  }
});

test("destination membership is checked again immediately before native grouping", async () => {
  const f = fixture(newsTabs());
  f.setNativeGroups([{ id: 7, windowId: 1, title: "Naujienos" }]);
  const b = await enabled(f);
  const suggestion = (await b.handle({ type: "snapshot" })).suggestions[0];
  const query = f.api.tabs.query;
  let queries = 0;
  f.api.tabs.query = async (...args) => {
    if (++queries === 2)
      f.mutate((tabs) =>
        tabs.push(tab(4, { groupId: 7, url: "https://changed.test/" })),
      );
    return query(...args);
  };
  const result = await b.handle({
    type: "group",
    suggestionId: suggestion.id,
    tabIds: [3],
    expectedTabs: suggestion.tabs,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STALE");
  assert.equal(
    f.calls.some((call) => call[0] === "group"),
    false,
  );
});

test("excluded destination members cannot be hidden to manufacture a coherent group", async () => {
  for (const extra of [
    tab(4, { groupId: 7, url: "chrome://settings/" }),
    tab(4, {
      groupId: 7,
      url: "https://recipes.test/",
      title: "Recipes",
      pinned: true,
    }),
    tab(4, { groupId: 7, url: "https://recipes.test/", title: "Recipes" }),
  ]) {
    const f = fixture([...newsTabs(), extra, tab(5, { url: extra.url })]);
    f.setNativeGroups([{ id: 7, windowId: 1, title: "Naujienos" }]);
    const b = await enabled(f);
    assert.equal(
      (await b.handle({ type: "snapshot" })).suggestions.some(
        (s) => s.targetGroup,
      ),
      false,
    );
  }
});

test("successful chosen names are recalled for new pages in the same specific workspace", async () => {
  const f = fixture([
    tab(1, {
      url: "https://work.test/projects/aurora/plans",
      title: "Planning",
    }),
    tab(2, {
      url: "https://work.test/projects/aurora/budget",
      title: "Finances",
    }),
  ]);
  const b = await enabled(f);
  const suggestion = (await b.handle({ type: "snapshot" })).suggestions[0];
  const result = await b.handle({
    type: "group",
    suggestionId: suggestion.id,
    tabIds: suggestion.tabIds,
    expectedTabs: suggestion.tabs,
    name: "Kliento darbai",
  });
  assert.equal(result.ok, true);
  f.setNativeGroups([]);
  f.mutate((tabs) =>
    tabs.forEach((t, i) => {
      t.id += 10;
      t.groupId = -1;
      t.url = `https://work.test/projects/aurora/${i ? "materials" : "timeline"}`;
    }),
  );
  const recalled = (await b.handle({ type: "snapshot" })).suggestions[0];
  assert.equal(recalled.signal, "remembered-group");
  assert.equal(recalled.proposedName, "Kliento darbai");
  assert.equal(recalled.nameLocked, true);
  await b.handle({ type: "settings", patch: { enabled: false } });
  assert.equal(f.local[STORAGE_KEY].groupingContext.choices.length, 1);
  assert.equal(
    Object.keys(f.local[STORAGE_KEY].groupingContext.current).length,
    0,
  );
  await b.handle({ type: "clearData" });
  assert.equal(f.local[STORAGE_KEY].groupingContext.choices.length, 0);
});

test("opening context comes from recorded creation events rather than a restored inventory", async () => {
  const source = tab(1, {
    url: "https://search.test/search?q=vilnius+trip",
    title: "Search",
  });
  const children = [
    tab(2, {
      url: "https://rail.test/tickets",
      title: "Traukinio bilietai",
      openerTabId: 1,
    }),
    tab(3, {
      url: "https://maps.test/place",
      title: "Stoties vieta",
      openerTabId: 1,
    }),
  ];
  const f = fixture([source, ...children]);
  const b = await enabled(f);
  assert.equal((await b.handle({ type: "snapshot" })).suggestions.length, 0);
  await b.created(children[0]);
  await b.created(children[1]);
  assert.equal((await b.handle({ type: "snapshot" })).suggestions.length, 0);
  f.setTime(T + 120_000);
  await b.created(children[0]);
  f.setTime(T + 121_000);
  await b.created(children[1]);
  const suggestions = (await b.handle({ type: "snapshot" })).suggestions;
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].signal, "opening-context");
  assert.deepEqual(suggestions[0].tabIds, [2, 3]);
});

test("privacy pause and erase work when browser queries fail", async () => {
  const f = fixture(),
    b = await enabled(f);
  f.failures.query = true;
  const paused = await b.handle({
    type: "settings",
    patch: { enabled: false },
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.settings.enabled, false);
  assert.equal((await b.handle({ type: "clearData" })).ok, true);
  assert.deepEqual(f.local[STORAGE_KEY].observations, {});
});

test("rapid activation measurement is preserved before one debounced evaluation", async () => {
  const f = fixture([tab(1), tab(2)]),
    b = await enabled(f);
  f.setTime(T + 8 * DAY);
  const queryCount = f.calls.filter((call) => call[0] === "query").length;
  await Promise.all([b.schedule(1), b.schedule(2)]);
  assert.equal(
    f.calls.filter((call) => call[0] === "query").length,
    queryCount,
  );
  assert.equal(
    f.local[STORAGE_KEY].urlHistory["https://example.test/1"].lastUsedAt,
    T + 8 * DAY,
  );
  assert.equal(
    f.local[STORAGE_KEY].urlHistory["https://example.test/2"].lastUsedAt,
    T + 8 * DAY,
  );
  assert.equal(f.timers.size, 1);
  await f.runTimers();
  const snap = await b.handle({ type: "cachedSnapshot" });
  assert.ok(
    snap.tabs.every(
      (item) => item.inactivityDays === 0 && item.visitCount === 1,
    ),
  );
});

test("explicit created event starts fresh for a reused ID and exact old URL", async () => {
  const f = fixture([tab(1)]),
    b = await enabled(f);
  f.setTime(T + 8 * DAY);
  assert.equal(
    (await b.handle({ type: "snapshot" })).tabs[0].inactivityDays,
    8,
  );
  await b.created(tab(1));
  await f.runTimers();
  const fresh = await b.handle({ type: "cachedSnapshot" });
  assert.equal(fresh.tabs[0].inactivityDays, 0);
  assert.equal(fresh.tabs[0].urlFirstObservedAt, T);
  assert.equal(fresh.tabs[0].firstSeenThisSessionAt, T + 8 * DAY);
  assert.equal(fresh.tabs[0].historySource, "current-session");
});

test("pause retains history context but resets eligibility across the next restart", async () => {
  const f = fixture([tab(1)]),
    b = await enabled(f);
  f.setTime(T + 8 * DAY);
  await b.handle({ type: "settings", patch: { enabled: false } });
  f.setTime(T + 20 * DAY);
  const resumed = await b.handle({
    type: "settings",
    patch: { enabled: true },
  });
  assert.equal(resumed.tabs[0].urlFirstObservedAt, T);
  assert.equal(resumed.tabs[0].inactivityDays, 0);
  Object.keys(f.session).forEach((key) => {
    delete f.session[key];
  });
  f.setTime(T + 21 * DAY);
  const restart = f.backend();
  await restart.handle({ type: "snapshot" });
  f.setTime(T + 21 * DAY + 5 * 60_000);
  const snap = await restart.handle({ type: "snapshot" });
  assert.equal(snap.tabs[0].inactivityDays, 1);
  assert.equal(
    snap.suggestions.some((item) => item.type === "inactive"),
    false,
  );
  await restart.handle({ type: "clearData" });
  assert.deepEqual(f.local[STORAGE_KEY].urlHistory, {});
});

test("window-closing evidence survives an empty query and weekend shutdown before URL reconciliation", async () => {
  const f = fixture([tab(1)]),
    b = await enabled(f);
  f.setTime(T + 8 * DAY);
  await b.handle({ type: "snapshot" });
  f.mutate((tabs) => {
    tabs.splice(0);
  });
  await b.removed(1, { isWindowClosing: true });
  await f.runTimers();
  assert.deepEqual(f.local[STORAGE_KEY].observations, {});
  assert.ok(f.local[STORAGE_KEY].windowClosures[1]);
  f.setTime(T + 11 * DAY);
  Object.keys(f.session).forEach((key) => {
    delete f.session[key];
  });
  f.mutate((tabs) => {
    tabs.push(tab(90, { url: "https://example.test/1" }));
  });
  const restarted = f.backend();
  await restarted.handle({ type: "snapshot" });
  f.setTime(T + 11 * DAY + 5 * 60_000);
  const snap = await restarted.handle({ type: "snapshot" });
  assert.equal(snap.tabs[0].historySource, "prior-session-url");
  assert.equal(snap.tabs[0].inactivityDays, 11);
  assert.equal(snap.suggestions[0].type, "inactive");
});

test("individually closed tabs do not regain old review age when reopened after restart", async () => {
  const f = fixture([tab(1)]),
    b = await enabled(f);
  f.setTime(T + 8 * DAY);
  f.mutate((tabs) => {
    tabs.splice(0);
  });
  await b.removed(1, { isWindowClosing: false });
  await f.runTimers();
  assert.deepEqual(f.local[STORAGE_KEY].windowClosures, {});
  Object.keys(f.session).forEach((key) => {
    delete f.session[key];
  });
  f.mutate((tabs) => {
    tabs.push(tab(90, { url: "https://example.test/1" }));
  });
  const snap = await f.backend().handle({ type: "snapshot" });
  assert.equal(snap.tabs[0].historySource, "current-session");
  assert.equal(snap.tabs[0].inactivityDays, 0);
  assert.equal(snap.tabs[0].urlFirstObservedAt, T);
});

test("excluded or unreadable rapid activations do not bridge surrounding co-use pairs", async () => {
  for (const interruptedId of [3, 99]) {
    const f = fixture([tab(1), tab(2), tab(3, { url: "chrome://settings" })]),
      b = await enabled(f);
    await b.schedule(1);
    f.setTime(T + 60_000);
    await b.schedule(interruptedId);
    f.setTime(T + 120_000);
    await b.schedule(2);
    assert.deepEqual(f.local[STORAGE_KEY].pairs, {});
    assert.equal(
      f.local[STORAGE_KEY].urlHistory["chrome://settings"],
      undefined,
    );
  }
});

test("100-tab summary is persisted and cached reads remain immediate and read-only during a blocked query", async () => {
  const tabs = Array.from({ length: 100 }, (_, i) =>
    tab(i + 1, { groupId: 20, url: `https://host${i}.test/` }),
  );
  const f = fixture(tabs),
    b = await enabled(f);
  const old = await b.handle({ type: "cachedSnapshot" });
  assert.equal(old.evaluationSummary.webTabsChecked, 100);
  assert.equal(old.evaluationSummary.skipped.alreadyGrouped, 100);
  assert.deepEqual(
    f.local[STORAGE_KEY].cached.evaluationSummary,
    old.evaluationSummary,
  );
  let resolveQuery,
    queried = false;
  const waitingQuery = new Promise((resolve) => {
    resolveQuery = resolve;
  });
  f.api.tabs.query = async () => {
    queried = true;
    return waitingQuery;
  };
  const scan = b.handle({ type: "snapshot" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queried, true);
  const before = copy(f.local[STORAGE_KEY]);
  const current = await b.handle({ type: "cachedSnapshot" });
  assert.equal(current.evaluation.state, "checking");
  assert.equal(current.evaluation.phase, "checking");
  assert.deepEqual(current.evaluationSummary, old.evaluationSummary);
  assert.deepEqual(f.local[STORAGE_KEY], before);
  resolveQuery(tabs);
  const completed = await scan;
  assert.equal(completed.ok, true);
  assert.equal(completed.evaluation.phase, null);
  assert.equal(completed.evaluationSummary.webTabsChecked, 100);
});

test("a real check queued behind another operation is visible without waiting for that operation", async () => {
  const f = fixture(),
    b = await enabled(f);
  let resolveWrite;
  const nativeSet = f.api.storage.local.set;
  const waiting = new Promise((resolve) => {
    resolveWrite = resolve;
  });
  let writes = 0;
  f.api.storage.local.set = async (value) => {
    if (++writes === 1) await waiting;
    return nativeSet(value);
  };
  const queriesBefore = f.calls.filter((call) => call[0] === "query").length;
  const setting = b.handle({ type: "settings", patch: { inactivityDays: 14 } });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = b.handle({ type: "snapshot" });
  const cached = await b.handle({ type: "cachedSnapshot" });
  assert.equal(cached.evaluation.state, "checking");
  assert.equal(cached.evaluation.phase, "queued");
  assert.equal(writes, 1);
  assert.equal(
    f.calls.filter((call) => call[0] === "query").length,
    queriesBefore,
  );
  resolveWrite();
  assert.equal((await setting).ok, true);
  assert.equal((await queued).ok, true);
  assert.equal(
    (await b.handle({ type: "cachedSnapshot" })).evaluation.phase,
    null,
  );
});

test("failed browser query preserves completed summary and an initial cache never invents a scan", async () => {
  const f = fixture(),
    b = f.backend();
  const beforeScan = await b.handle({ type: "cachedSnapshot" });
  assert.equal(beforeScan.settings.enabled, true);
  assert.equal(beforeScan.evaluationSummary, null);
  assert.equal(f.calls.filter((call) => call[0] === "query").length, 0);
  await b.handle({ type: "settings", patch: { enabled: true } });
  const beforeFailure = await b.handle({ type: "cachedSnapshot" });
  f.failures.query = true;
  assert.equal((await b.handle({ type: "snapshot" })).ok, false);
  const failed = await b.handle({ type: "cachedSnapshot" });
  assert.equal(failed.evaluation.state, "error");
  assert.equal(failed.evaluation.phase, null);
  assert.deepEqual(failed.evaluationSummary, beforeFailure.evaluationSummary);
  const paused = await b.handle({
    type: "settings",
    patch: { enabled: false },
  });
  assert.equal(paused.ok, true);
  assert.equal(
    (await b.handle({ type: "cachedSnapshot" })).evaluationSummary,
    null,
  );
});

test("fresh backend indexes required history asynchronously and passes exact-URL facts to ranking", async () => {
  const tabs = [
    tab(1, { url: "https://alpha.test/plans", title: "Alpha studio plans" }),
    tab(2, {
      url: "https://alpha.test/materials",
      title: "Alpha studio materials",
    }),
    tab(3, {
      url: "https://beta.test/plans",
      title: "Beta studio plans",
      windowId: 2,
    }),
    tab(4, {
      url: "https://beta.test/materials",
      title: "Beta studio materials",
      windowId: 2,
    }),
  ];
  const f = fixture(tabs),
    records = new Map(),
    jobs = new Map(),
    historyCalls = [];
  let meta,
    nextJob = 1;
  const store = {
    async get(key) {
      return copy(records.get(key));
    },
    async getMeta() {
      return copy(meta);
    },
    async setMeta(value) {
      meta = copy(value);
    },
    async commit(record, value) {
      records.set(record.key, copy(record));
      meta = copy(value);
    },
    async count() {
      return records.size;
    },
    async sweep(generation) {
      for (const [key, value] of records)
        if (value.generation !== generation) records.delete(key);
    },
    async clear() {
      records.clear();
      meta = undefined;
    },
  };
  f.api.permissions = {
    async contains(value) {
      assert.deepEqual(value, { permissions: ["history"] });
      return true;
    },
  };
  f.api.history = {
    async search(query) {
      historyCalls.push(["search", copy(query)]);
      return tabs.slice(2).map((item) => ({
        url: item.url,
        title: "Synthetic private title",
        visitCount: 5,
        lastVisitTime: T - 1000,
      }));
    },
    async getVisits({ url }) {
      historyCalls.push(["visits", url]);
      return Array.from({ length: 5 }, (_, index) => ({
        visitId: `${url}:${index}`,
        visitTime: T - 1000 - index * 60_000,
      }));
    },
  };
  const b = f.backend({
    historyOptions: {
      store,
      setTimer(fn) {
        const id = nextJob++;
        jobs.set(id, fn);
        return id;
      },
      clearTimer(id) {
        jobs.delete(id);
      },
    },
  });
  const initial = await b.handle({ type: "snapshot" });
  assert.equal(initial.ok, true);
  assert.equal(initial.settings.historyEnabled, true);
  assert.equal(initial.suggestions.length, 2);
  assert.equal(initial.suggestions[0].tabs[0].windowId, 1);
  assert.ok(["off", "indexing"].includes(initial.history.state));
  let current;
  for (let pass = 0; pass < 100; pass++) {
    for (const [id, job] of [...jobs]) {
      jobs.delete(id);
      job();
    }
    await new Promise((resolve) => setImmediate(resolve));
    current = await b.handle({ type: "cachedSnapshot" });
    if (current.history.state === "ready") break;
  }
  assert.equal(current.history.state, "ready");
  assert.equal(current.history.processedURLs, 2);
  assert.equal(current.history.analyzedVisits, 10);
  assert.equal(historyCalls.filter((call) => call[0] === "visits").length, 2);
  await f.runTimers();
  current = await b.handle({ type: "cachedSnapshot" });
  assert.equal(current.suggestions[0].tabs[0].windowId, 2);
  assert.match(
    current.suggestions[0].historyReason,
    /10 available browser visits/,
  );
  assert.equal(
    current.suggestions.some((item) => item.type === "inactive"),
    false,
  );
  for (const record of records.values()) {
    assert.match(record.key, /^[a-f0-9]{64}$/);
    assert.equal("url" in record, false);
    assert.equal("title" in record, false);
    assert.equal("visitsList" in record, false);
  }
  const historyCallsBeforePause = historyCalls.length;
  const paused = await b.handle({
    type: "settings",
    patch: { enabled: false },
  });
  assert.equal(paused.history.state, "paused");
  await b.historyChanged();
  assert.equal(historyCalls.length, historyCallsBeforePause);
  assert.equal(jobs.size, 0);
  const erased = await b.handle({ type: "clearData" });
  assert.equal(erased.ok, true);
  assert.equal(erased.history.state, "off");
  assert.equal(erased.settings.historyEnabled, false);
  assert.equal(erased.settings.enabled, false);
  assert.equal(records.size, 0);
  assert.equal(meta, undefined);
  assert.equal(historyCalls.length, historyCallsBeforePause);
});

test("history Retry recovers an enabled error but stale actions cannot bypass Pause, Erase, or history off", async () => {
  const f = fixture(),
    records = new Map(),
    jobs = new Map();
  let meta,
    next = 0,
    failSearch = true,
    searches = 0,
    permissionChecks = 0;
  const store = {
    async get(key) {
      return copy(records.get(key));
    },
    async getMeta() {
      return copy(meta);
    },
    async setMeta(value) {
      meta = copy(value);
    },
    async commit(record, value) {
      records.set(record.key, copy(record));
      meta = copy(value);
    },
    async count() {
      return records.size;
    },
    async sweep() {},
    async clear() {
      records.clear();
      meta = undefined;
    },
  };
  f.api.permissions = {
    async contains() {
      permissionChecks++;
      return true;
    },
  };
  f.api.history = {
    async search() {
      searches++;
      if (failSearch) throw new Error("Synthetic history lookup failed");
      return [];
    },
    async getVisits() {
      assert.fail("Empty synthetic history cannot require visit lookup");
    },
  };
  const b = f.backend({
    historyOptions: {
      store,
      setTimer(fn) {
        const id = ++next;
        jobs.set(id, fn);
        return id;
      },
      clearTimer(id) {
        jobs.delete(id);
      },
    },
  });
  async function settle(expected) {
    for (let turn = 0; turn < 50; turn++) {
      for (const [id, fn] of [...jobs]) {
        jobs.delete(id);
        fn();
      }
      await new Promise((resolve) => setImmediate(resolve));
      const data = await b.handle({ type: "cachedSnapshot" });
      if (data.history.state === expected) return data;
    }
    assert.fail(`History did not settle to ${expected}`);
  }
  assert.equal((await b.handle({ type: "snapshot" })).ok, true);
  await settle("error");
  failSearch = false;
  assert.equal((await b.handle({ type: "retryHistory" })).ok, true);
  await settle("ready");
  assert.equal(searches, 2);
  const transitions = [
    ["paused", { type: "settings", patch: { enabled: false } }],
    ["off", { type: "clearData" }],
    [
      "off",
      { type: "settings", patch: { enabled: true, historyEnabled: false } },
    ],
  ];
  for (const [expected, action] of transitions) {
    const changed = await b.handle(action);
    assert.equal(changed.ok, true);
    assert.equal(changed.history.state, expected);
    const before = { searches, permissionChecks };
    await b.handle({ type: "retryHistory" });
    await b.historyChanged();
    await f.runTimers();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(jobs.size, 0);
    assert.deepEqual({ searches, permissionChecks }, before);
    const current = await b.handle({ type: "cachedSnapshot" });
    assert.equal(current.history.state, expected);
    if (expected === "off") {
      assert.equal(records.size, 0);
      assert.equal(meta, undefined);
    }
  }
});

test("snapshot revisions order inventory updates across worker recreation and erasure", async () => {
  const f = fixture(),
    b = f.backend();
  const first = await b.handle({ type: "snapshot" });
  f.mutate((tabs) => tabs.push(tab(4)));
  await b.observe();
  const newer = await b.handle({ type: "cachedSnapshot" });
  assert.equal(newer.tabs.length, 4);
  assert(newer.snapshotRevision > first.snapshotRevision);
  const restarted = f.backend();
  const current = await restarted.handle({ type: "snapshot" });
  assert(current.snapshotRevision > newer.snapshotRevision);
  const erased = await restarted.handle({ type: "clearData" });
  assert(erased.snapshotRevision > current.snapshotRevision);
  assert.equal(erased.tabs.length, 0);
});

test("naming-language preference persists without translating literal shared words", async () => {
  const f = fixture([
    tab(1, { url: "https://amber.test/", title: "Ąžuolų slėnis planai" }),
    tab(2, { url: "https://birch.test/", title: "Ąžuolų slėnis biudžetas" }),
  ]);
  const b = await enabled(f);
  let snap = await b.handle({
    type: "settings",
    patch: { groupNameLanguage: "lt" },
  });
  assert.equal(snap.settings.groupNameLanguage, "lt");
  assert.match(snap.suggestions[0].proposedName, /Ąžuolų slėnis/);
  snap = await f.backend().handle({ type: "snapshot" });
  assert.equal(snap.settings.groupNameLanguage, "lt");
});

test("optional discovery is revalidated registered for review and excluded from persisted cache", async () => {
  const f = fixture([
    tab(1, {
      url: "https://xeno.test/",
      title: "Restoring a theremin oscillator",
    }),
    tab(2, {
      url: "https://yarrow.test/",
      title: "Repairing heterodyne pitch circuitry",
    }),
  ]);
  const b = await enabled(f);
  await b.handle({ type: "settings", patch: { aiEnabled: true } });
  const base = await b.handle({ type: "snapshot" });
  assert.equal(base.suggestions.length, 0);
  const group = {
    name: "Theremin restoration",
    relationship: "task",
    members: base.tabs.map((t) => ({ id: t.id, evidence: t.title })),
  };
  const enriched = await b.handle({
    type: "discoverGroups",
    key: discoveryKey(base),
    tabIds: [1, 2],
    groups: [group],
  });
  assert.equal(enriched.ok, true);
  assert.equal(enriched.suggestions[0].aiDiscovered, true);
  assert.equal(
    (await b.handle({ type: "cachedSnapshot" })).suggestions.length,
    1,
  );
  assert.equal(
    (await f.backend().handle({ type: "cachedSnapshot" })).suggestions.length,
    0,
  );
  const reviewed = await b.handle({
    type: "group",
    suggestionId: enriched.suggestions[0].id,
    tabIds: [1, 2],
    expectedTabs: enriched.tabs,
    name: "My instrument",
  });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.action.tabIds.length, 2);
});
test("discovery rejects stale inputs and preserves dismissals opt-out and group protections", async () => {
  const make = () =>
    fixture([
      tab(1, {
        url: "https://xeno.test/",
        title: "Restoring a theremin oscillator",
      }),
      tab(2, {
        url: "https://yarrow.test/",
        title: "Repairing heterodyne pitch circuitry",
      }),
    ]);
  const f = make(),
    b = await enabled(f);
  await b.handle({ type: "settings", patch: { aiEnabled: true } });
  const base = await b.handle({ type: "snapshot" }),
    group = {
      name: "Theremin restoration",
      relationship: "task",
      members: base.tabs.map((t) => ({ id: t.id, evidence: t.title })),
    };
  const message = {
    type: "discoverGroups",
    key: discoveryKey(base),
    tabIds: [1, 2],
    groups: [group],
  };
  const enriched = await b.handle(message);
  assert.equal(enriched.suggestions.length, 1);
  const dismissed = await b.handle({
    type: "dismiss",
    id: enriched.suggestions[0].id,
  });
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.suggestions.length, 0);
  assert.equal((await b.handle(message)).suggestions.length, 0);
  f.mutate((tabs) => (tabs[0].title = "Changed title"));
  assert.equal((await b.handle(message)).code, "STALE");
  await b.handle({ type: "settings", patch: { aiEnabled: false } });
  assert.equal((await b.handle(message)).code, "DISABLED");
});

test("Chrome installation listener opens the internal welcome only on fresh install", async () => {
  const f = fixture();
  installListeners(f.api);
  const installed = f.api.runtime.onInstalled.listeners[0];
  await installed({ reason: "update", previousVersion: "1.4.0" });
  assert.equal(f.calls.filter(([name]) => name === "create").length, 0);
  await installed({ reason: "install" });
  assert.deepEqual(
    f.calls.filter(([name]) => name === "create"),
    [
      [
        "create",
        { url: "chrome-extension://test-id/welcome.html", active: true },
      ],
    ],
  );
});

test("cold worker creation captures the opener before deferred state hydration", async () => {
  const source = tab(1, {
    url: "https://search.test/search?q=quiet+work",
    title: "Search",
  });
  const child = tab(2, { url: "https://notes.test/work", openerTabId: 1 });
  const f = fixture([source, child]);
  await enabled(f);
  f.setTime(T + 120_000);
  const originalGet = f.api.storage.local.get;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.api.storage.local.get = async (key) => {
    await gate;
    return originalGet(key);
  };
  const restarted = f.backend();
  const created = restarted.created(child);
  f.mutate((tabs) => {
    tabs[0].url = "https://search.test/search?q=changed";
  });
  release();
  await created;
  assert.equal(f.local[STORAGE_KEY].groupingContext.openings.length, 1);
  assert.equal(
    f.local[STORAGE_KEY].groupingContext.openings[0].sourceURL,
    source.url,
  );
});

test("erasure persists cleared local state even when history cleanup fails and can be retried", async () => {
  const f = fixture();
  let failClear = false,
    clears = 0;
  const store = {
    async getMeta() {},
    async count() {
      return 0;
    },
    async clear() {
      clears++;
      if (failClear) throw new Error("Database temporarily unavailable");
    },
  };
  const b = f.backend({ historyOptions: { store } });
  const initial = await b.handle({ type: "snapshot" });
  await b.handle({ type: "save", tabIds: [1], expectedTabs: initial.tabs });
  failClear = true;
  const cleared = await b.handle({ type: "clearData" });
  assert.equal(cleared.ok, true);
  assert.match(cleared.action.warning, /history index could not be erased/);
  assert.equal(cleared.history.state, "error");
  assert.equal(f.local[STORAGE_KEY].settings.enabled, false);
  assert.equal(f.local[STORAGE_KEY].settings.historyEnabled, false);
  assert.deepEqual(f.local[STORAGE_KEY].saved, []);
  assert.deepEqual(f.local[STORAGE_KEY].observations, {});
  const restarted = f.backend({ historyOptions: { store } });
  const after = await restarted.handle({ type: "cachedSnapshot" });
  assert.equal(after.settings.enabled, false);
  assert.deepEqual(after.saved, []);
  failClear = false;
  const retried = await restarted.handle({ type: "clearData" });
  assert.equal(retried.ok, true);
  assert.equal(retried.action.warning, undefined);
  assert.equal(retried.history.state, "off");
  assert(clears >= 2);
});

test("committed close result survives a failing post-action tab refresh", async () => {
  const f = fixture(),
    b = await enabled(f);
  const initial = await b.handle({ type: "snapshot" });
  const remove = f.api.tabs.remove;
  f.api.tabs.remove = async (id) => {
    await remove(id);
    f.failures.query = true;
  };
  const result = await b.handle({
    type: "close",
    tabIds: [1],
    expectedTabs: initial.tabs,
    confirmed: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.action.closed, [1]);
  assert.match(result.refreshWarning, /action completed/);
  assert.equal(f.local[STORAGE_KEY].recovery[0].tabs[0].status, "closed");
  assert(!f.tabs().some((t) => t.id === 1));
});

test("save results survive a failing post-commit refresh without creating another batch", async () => {
  const f = fixture(),
    b = await enabled(f);
  const initial = await b.handle({ type: "snapshot" });
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    await set(value);
    if (value[STORAGE_KEY]?.saved.length) f.failures.query = true;
  };
  const result = await b.handle({
    type: "save",
    tabIds: [1],
    expectedTabs: initial.tabs,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action.count, 1);
  assert.match(result.refreshWarning, /could not refresh/);
  assert.equal(f.local[STORAGE_KEY].saved.length, 1);
});

test("long URLs stay within Chrome local quota and an oversized save is refused before growth", async () => {
  const longTabs = Array.from({ length: 200 }, (_, i) =>
    tab(i + 1, { url: `https://long.test/${i}?q=${"x".repeat(16000)}` }),
  );
  const f = fixture(longTabs);
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async (value) => {
    assert(
      new TextEncoder().encode(JSON.stringify(value)).length < 10 * 1024 * 1024,
      "Chrome storage quota",
    );
    await set(value);
  };
  const b = await enabled(f);
  const initial = await b.handle({ type: "snapshot" });
  assert.equal(initial.ok, true);
  const first = await b.handle({
    type: "save",
    tabIds: longTabs.map((t) => t.id),
    expectedTabs: initial.tabs,
  });
  assert.equal(first.ok, true);
  const second = await b.handle({
    type: "save",
    tabIds: longTabs.map((t) => t.id),
    expectedTabs: initial.tabs,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "STORAGE_FULL");
  const after = await b.handle({ type: "cachedSnapshot" });
  assert.equal(after.saved.length, 1);
  assert.equal(after.saved[0].tabs.length, 200);
});

test("failed list removal preserves the item so the same confirmation can be retried", async () => {
  const f = fixture(),
    b = await enabled(f);
  const initial = await b.handle({ type: "snapshot" });
  const saved = await b.handle({
    type: "save",
    tabIds: [1],
    expectedTabs: initial.tabs,
  });
  f.failures.storage = true;
  const failed = await b.handle({
    type: "forget",
    kind: "saved",
    id: saved.action.id,
  });
  assert.equal(failed.ok, false);
  assert.equal((await b.handle({ type: "cachedSnapshot" })).saved.length, 1);
  f.failures.storage = false;
  const retried = await b.handle({
    type: "forget",
    kind: "saved",
    id: saved.action.id,
  });
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.saved, []);
});

test("failed save commit does not leave a phantom batch in memory for a retry", async () => {
  const f = fixture(),
    b = await enabled(f);
  const initial = await b.handle({ type: "snapshot" });
  const set = f.api.storage.local.set;
  let failOnce = true;
  f.api.storage.local.set = async (value) => {
    if (value[STORAGE_KEY]?.saved.length && failOnce) {
      failOnce = false;
      throw new Error("Temporary storage failure");
    }
    return set(value);
  };
  assert.equal(
    (await b.handle({ type: "save", tabIds: [1], expectedTabs: initial.tabs }))
      .ok,
    false,
  );
  const retry = await b.handle({
    type: "save",
    tabIds: [1],
    expectedTabs: initial.tabs,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.saved.length, 1);
});

test("failure to persist a closure result reports the closed tab and leaves the rest open", async () => {
  const f = fixture(),
    b = await enabled(f);
  const initial = await b.handle({ type: "snapshot" });
  const remove = f.api.tabs.remove;
  f.api.tabs.remove = async (id) => {
    await remove(id);
    f.failures.storage = true;
  };
  const result = await b.handle({
    type: "close",
    tabIds: [1, 2],
    expectedTabs: initial.tabs,
    confirmed: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.action.closed, [1]);
  assert.deepEqual(
    result.action.failed.map((item) => item.tabId),
    [2],
  );
  assert.match(result.action.warning, /could not save/);
  assert(f.tabs().some((t) => t.id === 2));
  assert.equal(
    f.local[STORAGE_KEY].recovery[0].tabs[0].url,
    initial.tabs[0].url,
  );
});

test("legacy user data above the new budget remains accessible to erase controls", async () => {
  const state = createState(T);
  state.settings.enabled = true;
  state.saved = [
    {
      id: "legacy",
      tabs: Array.from({ length: 600 }, (_, i) => ({
        url: `https://legacy.test/${i}?q=${"x".repeat(16000)}`,
        title: "Saved link",
      })),
    },
  ];
  const f = fixture([], { [STORAGE_KEY]: state });
  const b = f.backend();
  const cached = await b.handle({ type: "cachedSnapshot" });
  assert.equal(cached.ok, true);
  assert.equal(cached.saved[0].tabs.length, 600);
  const erased = await b.handle({ type: "clearData" });
  assert.equal(erased.ok, true);
  assert.deepEqual(f.local[STORAGE_KEY].saved, []);
  assert.equal(f.local[STORAGE_KEY].settings.enabled, false);
});
