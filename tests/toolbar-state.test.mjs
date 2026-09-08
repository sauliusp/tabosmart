import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOLBAR_PORT,
  createToolbarState,
  deriveToolbarState,
  validateAIActivity,
} from "../extension/toolbar-state.mjs";

const core = (overrides = {}) => ({
  enabled: true,
  consentAt: 1000,
  evaluation: { state: "idle", phase: null },
  suggestionCount: 3,
  ...overrides,
});
const activity = (overrides = {}) => ({
  type: "aiActivity",
  setup: "idle",
  naming: false,
  wording: false,
  enabled: true,
  ...overrides,
});
function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => {
      for (const listener of [...listeners]) listener(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}
function port(overrides = {}) {
  return {
    name: TOOLBAR_PORT,
    sender: {
      id: "test-extension",
      url: "chrome-extension://test-extension/app.html",
    },
    onMessage: event(),
    onDisconnect: event(),
    posted: [],
    postMessage(message) {
      this.posted.push(message);
    },
    ...overrides,
  };
}
function browser() {
  const calls = [],
    appearance = {};
  const action = Object.fromEntries(
    [
      ["setIcon", "icon"],
      ["setTitle", "title"],
      ["setBadgeText", "badge"],
      ["setBadgeBackgroundColor", "background"],
      ["setBadgeTextColor", "foreground"],
    ].map(([method, field]) => [
      method,
      async (value) => {
        calls.push({ method, value });
        appearance[field] = value;
      },
    ]),
  );
  return {
    api: {
      action,
      runtime: {
        id: "test-extension",
        getURL: (path) => `chrome-extension://test-extension/${path}`,
      },
    },
    calls,
    appearance,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("pure mapping uses actual counts, bounded badge text, and quiet paused/start states", () => {
  assert.equal(deriveToolbarState(core()).badgeText, "3");
  assert.equal(deriveToolbarState(core()).iconPath[16], "icons/icon-16.png");
  const many = deriveToolbarState(core({ suggestionCount: 1234 }));
  assert.equal(many.badgeText, "99+");
  assert.match(many.title, /1234 suggestions/);
  assert.equal(deriveToolbarState(core({ suggestionCount: 1 })).badgeText, "1");
  assert.match(
    deriveToolbarState(core({ suggestionCount: 1 })).title,
    /1 suggestion ·/,
  );
  assert.equal(deriveToolbarState(core({ suggestionCount: 0 })).badgeText, "");
  assert.equal(
    deriveToolbarState(core({ suggestionCount: NaN })).badgeText,
    "",
  );
  for (const consentAt of [null, 1000]) {
    const paused = deriveToolbarState(core({ enabled: false, consentAt }), [
      activity({ naming: true }),
    ]);
    assert.equal(paused.state, consentAt ? "paused" : "start");
    assert.equal(paused.busy, false);
    assert.equal(paused.badgeText, "");
    assert.equal(paused.suggestionCount, 0);
    assert.doesNotMatch(paused.title, /suggestions|Generating/);
  }
});

test("core work has priority while hover text reports overlapping actual AI work", () => {
  for (const phase of ["queued", "checking"]) {
    const state = deriveToolbarState(
      core({ evaluation: { state: "checking", phase } }),
      [
        activity({ setup: "downloading", naming: true }),
        activity({ wording: true }),
      ],
    );
    assert.equal(state.state, `core-${phase}`);
    assert.equal(state.badgeText, "…");
    assert.equal(state.badgeColor, "#355D4C");
    assert.equal(state.iconPath[32], "icons/work-32.png");
    assert.match(
      state.title,
      phase === "queued" ? /check is queued/ : /Checking your tabs/,
    );
    assert.match(state.title, /Downloading the local AI model/);
    assert.match(state.title, /Generating group names locally/);
    assert.match(state.title, /Choosing explanation wording locally/);
    assert.match(state.title, /3 suggestions from the last completed check/);
  }
});

test("setup, naming and wording badges represent work; readiness alone never does", () => {
  assert.equal(deriveToolbarState(core(), [activity()]).busy, false);
  for (const [fields, state, title] of [
    [{ setup: "downloading" }, "ai-setup", /Downloading/],
    [{ setup: "preparing" }, "ai-setup", /Preparing local AI/],
    [{ naming: true }, "ai-naming", /Generating group names/],
    [{ wording: true }, "ai-wording", /Choosing explanation wording/],
  ]) {
    const result = deriveToolbarState(core(), [activity(fields)]);
    assert.equal(result.state, state);
    assert.equal(result.badgeText, "AI");
    assert.equal(result.busy, true);
    assert.match(result.title, title);
  }
  assert.equal(validateAIActivity(activity({ setup: "ready" })), null);
  assert.equal(validateAIActivity(activity({ setup: "unsupported" })), null);
});

test("history review shows measured URL counts below tab-check priority and above AI work", () => {
  for (const state of ["indexing", "updating"]) {
    const history = { state, processedURLs: 137, analyzedVisits: 500 };
    const reviewing = deriveToolbarState(core({ history }), [
      activity({ naming: true }),
    ]);
    assert.equal(reviewing.state, `history-${state}`);
    assert.equal(reviewing.badgeText, "…");
    assert.equal(reviewing.iconPath[16], "icons/work-16.png");
    assert.match(
      reviewing.title,
      /Reviewing browsing patterns · 137 URLs analyzed/,
    );
    assert.match(reviewing.title, /Generating group names locally/);
    assert.match(
      reviewing.title,
      /3 suggestions from the last completed check/,
    );
    assert.doesNotMatch(reviewing.title, /%/);
    const checking = deriveToolbarState(
      core({ history, evaluation: { state: "checking", phase: "queued" } }),
    );
    assert.equal(checking.state, "core-queued");
    assert.match(checking.title, /check is queued.*137 URLs analyzed/);
    const paused = deriveToolbarState(core({ history, enabled: false }));
    assert.equal(paused.busy, false);
    assert.doesNotMatch(paused.title, /URLs analyzed/);
  }
  for (const state of ["ready", "off", "paused", "denied", "unexpected"]) {
    const inactive = deriveToolbarState(
      core({ history: { state, processedURLs: 137 } }),
    );
    assert.equal(inactive.busy, false);
    assert.equal(inactive.badgeText, "3");
  }
  const failed = deriveToolbarState(core({ history: { state: "error" } }));
  assert.equal(failed.badgeText, "!");
  assert.match(failed.title, /Browsing-pattern review did not finish/);
});

test("a failed core check keeps its warning in the title during independent AI work", () => {
  const failed = core({ evaluation: { state: "error" } });
  const idle = deriveToolbarState(failed);
  assert.equal(idle.state, "error");
  assert.equal(idle.badgeText, "!");
  assert.equal(idle.badgeColor, "#8B4D32");
  assert.equal(idle.iconPath[16], "icons/icon-16.png");
  const active = deriveToolbarState(failed, [activity({ naming: true })]);
  assert.equal(active.badgeText, "AI");
  assert.equal(active.iconPath[16], "icons/work-16.png");
  assert.match(active.title, /latest tab check did not finish/);
  assert.match(active.title, /3 suggestions from the last completed check/);
});

test("only the exact activity schema is accepted and opt-out erases active fields", () => {
  assert.deepEqual(
    validateAIActivity(
      activity({ enabled: false, setup: "downloading", naming: true }),
    ),
    {
      enabled: false,
      setup: "idle",
      naming: false,
      wording: false,
    },
  );
  for (const value of [
    null,
    [],
    {},
    activity({ type: "availability" }),
    activity({ naming: 1 }),
    activity({ enabled: "true" }),
    activity({ unknown: true }),
    activity({ setup: "checking" }),
  ])
    assert.equal(validateAIActivity(value), null);
});

test("worker initialization clears old appearance and idle refreshes avoid redundant API writes", async () => {
  const b = browser();
  b.appearance.badge = { text: "AI" };
  b.appearance.icon = { path: { 16: "icons/work-16.png" } };
  const toolbar = createToolbarState(b.api);
  await toolbar.refresh();
  assert.deepEqual(b.appearance.badge, { text: "" });
  assert.equal(b.appearance.icon.path[16], "icons/icon-16.png");
  assert.equal(toolbar.getState().state, "start");
  const written = b.calls.length;
  await toolbar.refresh();
  assert.equal(b.calls.length, written);
});

test("views aggregate independently and disconnect removes only the lost owner's work", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api),
    first = port(),
    second = port();
  await toolbar.updateCore(core());
  const disconnectFirst = toolbar.connect(first);
  toolbar.connect(second);
  assert.deepEqual(first.posted, [{ type: "requestAIActivity" }]);
  assert.deepEqual(second.posted, [{ type: "requestAIActivity" }]);
  first.onMessage.emit(activity({ setup: "downloading" }));
  second.onMessage.emit(activity({ naming: true }));
  await toolbar.refresh();
  assert.match(b.appearance.title.title, /Downloading.*Generating/);
  disconnectFirst();
  await toolbar.refresh();
  assert.equal(toolbar.getState().state, "ai-naming");
  assert.doesNotMatch(toolbar.getState().title, /Downloading/);
  assert.equal(first.onMessage.size, 0);
  second.onDisconnect.emit();
  await toolbar.refresh();
  assert.equal(toolbar.getState().busy, false);
  assert.deepEqual(b.appearance.badge, { text: "3" });
  assert.equal(second.onDisconnect.size, 0);
});

test("untrusted, incognito, wrong-name and malformed ports cannot report activity", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api);
  await toolbar.updateCore(core());
  const invalid = [
    port({ name: "unrelated" }),
    port({
      sender: {
        id: "other",
        url: "chrome-extension://test-extension/app.html",
      },
    }),
    port({ sender: { id: "test-extension", url: "https://example.com" } }),
    port({
      sender: {
        id: "test-extension",
        url: "chrome-extension://test-extension.evil/app.html",
      },
    }),
    port({
      sender: {
        id: "test-extension",
        url: "chrome-extension://test-extension/app.html",
        tab: { incognito: true },
      },
    }),
    port({ onMessage: {} }),
  ];
  for (const p of invalid) {
    toolbar.connect(p);
    assert.equal(p.posted.length, 0);
    p.onMessage.emit?.(activity({ naming: true }));
  }
  const own = port();
  toolbar.connect(own);
  own.onMessage.emit(activity({ naming: true, progress: 0.5 }));
  await toolbar.refresh();
  assert.equal(toolbar.getState().busy, false);
});

test("pause clears reports, ignores late work, and resume requests current activity", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api),
    p = port();
  await toolbar.updateCore(core());
  toolbar.connect(p);
  p.onMessage.emit(activity({ naming: true }));
  await toolbar.refresh();
  assert.equal(toolbar.getState().busy, true);
  await toolbar.updateCore(core({ enabled: false }));
  p.onMessage.emit(activity({ setup: "preparing", naming: true }));
  await toolbar.refresh();
  assert.equal(toolbar.getState().state, "paused");
  await toolbar.updateCore(core());
  assert.equal(p.posted.length, 2);
  assert.equal(toolbar.getState().busy, false);
  p.onMessage.emit(activity({ wording: true }));
  await toolbar.refresh();
  assert.equal(toolbar.getState().state, "ai-wording");
  p.onMessage.emit(activity({ enabled: false, wording: true }));
  await toolbar.refresh();
  assert.equal(toolbar.getState().busy, false);
});

test("delayed action setters cannot let an older busy update overwrite the latest pause", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api);
  await toolbar.updateCore(core());
  const gate = deferred(),
    entered = deferred();
  const setIcon = b.api.action.setIcon;
  let concurrent = 0,
    peak = 0;
  b.api.action.setIcon = async (value) => {
    peak = Math.max(peak, ++concurrent);
    if (value.path[16].includes("work")) {
      entered.resolve();
      await gate.promise;
    }
    await setIcon(value);
    concurrent--;
  };
  const checking = toolbar.updateCore(
    core({ evaluation: { state: "checking" } }),
  );
  await entered.promise;
  const paused = toolbar.updateCore(core({ enabled: false }));
  gate.resolve();
  await Promise.all([checking, paused]);
  assert.equal(peak, 1);
  assert.equal(toolbar.getState().state, "paused");
  assert.deepEqual(b.appearance.badge, { text: "" });
  assert.equal(b.appearance.icon.path[16], "icons/icon-16.png");
  assert.match(b.appearance.title.title, /paused/);
});

test("a refresh requested as an earlier write settles still applies the newest state", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api);
  await toolbar.updateCore(core());
  const first = toolbar.updateCore(core({ suggestionCount: 4 }));
  const latest = first.then(() =>
    toolbar.updateCore(core({ suggestionCount: 12 })),
  );
  await latest;
  assert.deepEqual(b.appearance.badge, { text: "12" });
  assert.match(b.appearance.title.title, /12 suggestions/);
});

test("partial API failure retries fully even when desired state returns to the previous state", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api);
  await toolbar.updateCore(core());
  const setTitle = b.api.action.setTitle;
  let fail = true;
  b.api.action.setTitle = async (value) => {
    if (fail) {
      fail = false;
      throw new Error("private runtime details");
    }
    await setTitle(value);
  };
  assert.equal(
    await toolbar.updateCore(core({ evaluation: { state: "checking" } })),
    false,
  );
  assert.equal(b.appearance.icon.path[16], "icons/work-16.png");
  assert.match(
    toolbar.getState().writeError,
    /toolbar update could not finish/,
  );
  assert.doesNotMatch(toolbar.getState().writeError, /private/);
  assert.equal(await toolbar.updateCore(core()), true);
  assert.equal(b.appearance.icon.path[16], "icons/icon-16.png");
  assert.deepEqual(b.appearance.badge, { text: "3" });
  assert.equal(toolbar.getState().writeError, null);
});

test("a failed API write is bounded and can be retried without another state change", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api);
  await toolbar.updateCore(core());
  const setBadgeText = b.api.action.setBadgeText;
  let attempts = 0;
  b.api.action.setBadgeText = async () => {
    attempts++;
    throw new Error("temporarily unavailable");
  };
  assert.equal(await toolbar.updateCore(core({ suggestionCount: 7 })), false);
  assert.equal(attempts, 1);
  b.api.action.setBadgeText = setBadgeText;
  assert.equal(await toolbar.refresh(), true);
  assert.deepEqual(b.appearance.badge, { text: "7" });
});

test("a restarted worker requests fresh view activity instead of assuming previous work continues", async () => {
  const b = browser(),
    first = createToolbarState(b.api),
    oldPort = port();
  await first.updateCore(core());
  first.connect(oldPort);
  oldPort.onMessage.emit(activity({ setup: "downloading" }));
  await first.refresh();
  assert.deepEqual(b.appearance.badge, { text: "AI" });
  first.dispose();
  const restarted = createToolbarState(b.api),
    newPort = port();
  await restarted.updateCore(core());
  restarted.connect(newPort);
  await restarted.refresh();
  assert.deepEqual(newPort.posted, [{ type: "requestAIActivity" }]);
  assert.deepEqual(b.appearance.badge, { text: "3" });
  oldPort.onMessage.emit(activity({ naming: true }));
  newPort.onMessage.emit(activity({ setup: "preparing" }));
  await restarted.refresh();
  assert.equal(restarted.getState().state, "ai-setup");
  assert.match(restarted.getState().title, /Preparing/);
});

test("disconnect during handshake and disposal release listeners without leaving phantom work", async () => {
  const b = browser(),
    toolbar = createToolbarState(b.api);
  await toolbar.updateCore(core());
  const failed = port({
    postMessage() {
      throw new Error("disconnected");
    },
  });
  toolbar.connect(failed);
  await toolbar.refresh();
  assert.equal(failed.onMessage.size, 0);
  assert.equal(failed.onDisconnect.size, 0);
  const p = port();
  toolbar.connect(p);
  await toolbar.refresh();
  toolbar.dispose();
  const previous = b.calls.length;
  p.onMessage.emit(activity({ naming: true }));
  assert.equal(await toolbar.refresh(), false);
  assert.equal(p.onMessage.size, 0);
  assert.equal(p.onDisconnect.size, 0);
  assert.equal(b.calls.length, previous);
});

test("optional discovery has truthful work activity and clears on completion", () => {
  const core = {
    enabled: true,
    consentAt: 1,
    evaluation: { state: "idle" },
    suggestionCount: 0,
  };
  const activity = {
    type: "aiActivity",
    enabled: true,
    setup: "idle",
    naming: false,
    wording: false,
    discovery: true,
  };
  assert.equal(validateAIActivity(activity).discovery, true);
  const running = deriveToolbarState(core, [activity]);
  assert.equal(running.state, "ai-discovery");
  assert.match(running.title, /Finding possible relationships locally/);
  assert.equal(
    deriveToolbarState(core, [{ ...activity, discovery: false }]).busy,
    false,
  );
});
