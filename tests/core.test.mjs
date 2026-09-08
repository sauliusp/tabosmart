import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY,
  createState,
  observeTabs,
  buildSuggestions,
  fingerprint,
  makeSnapshot,
  startSession,
  validateSelection,
  sanitizeSettings,
  LIMITS,
  STARTUP_REVIEW_GRACE,
  hydrateState,
  recordActivation,
  rankSuggestions,
} from "../extension/core.mjs";

const T = 1_800_000_000_000;
const tab = (id, url = `https://site.test/${id}`, patch = {}) => ({
  id,
  url,
  title: `Page ${id}`,
  windowId: 1,
  groupId: -1,
  index: id,
  active: false,
  pinned: false,
  audible: false,
  incognito: false,
  ...patch,
});
function state() {
  const s = createState(T);
  s.settings.enabled = true;
  return s;
}
function suggestions(s, tabs, time = T) {
  const described = observeTabs(s, tabs, time);
  return buildSuggestions(described, s, time);
}

test("disabled or erased core state does not observe tabs or expose suggestions", () => {
  const s = createState(T),
    tabs = [tab(1), tab(2), tab(3)];
  assert.equal(s.settings.aiEnabled, true);
  assert.equal(s.settings.aiPreferenceSource, "default");
  assert.equal(s.settings.enabled, false);
  assert.equal(s.settings.historyEnabled, true);
  assert.deepEqual(observeTabs(s, tabs, T), []);
  assert.deepEqual(s.observations, {});
  assert.deepEqual(makeSnapshot(s, tabs, T).tabs, []);
});

test("missing AI preferences use the new default without enabling a stored paused state", () => {
  for (const raw of [
    undefined,
    { version: 1 },
    { version: 1, settings: null },
    {
      version: 1,
      settings: { aiEnabled: "false", aiPreferenceSource: "user" },
    },
  ]) {
    const s = hydrateState(raw, T);
    assert.equal(s.settings.aiEnabled, true);
    assert.equal(s.settings.aiPreferenceSource, "default");
    assert.equal(s.settings.enabled, false);
    assert.equal(s.consentAt, null);
    assert.deepEqual(observeTabs(s, [tab(1)], T), []);
  }
});

test("legacy AI preferences retain their value without inventing an opt-out", () => {
  for (const [aiEnabled, expectedSource] of [
    [false, "legacy-unknown"],
    [true, "user"],
  ]) {
    let s = hydrateState({ version: 1, settings: { aiEnabled } }, T);
    assert.equal(s.settings.aiEnabled, aiEnabled);
    assert.equal(s.settings.aiPreferenceSource, expectedSource);
    // Once migrated, ordinary worker reloads do not reinterpret the origin.
    s = hydrateState(structuredClone(s), T + DAY);
    assert.equal(s.settings.aiEnabled, aiEnabled);
    assert.equal(s.settings.aiPreferenceSource, expectedSource);
  }
});

test("known AI opt-outs survive hydration and only explicit choices replace provenance", () => {
  const s = hydrateState(
    {
      version: 1,
      settings: { aiEnabled: false, aiPreferenceSource: "user" },
    },
    T,
  );
  let settings = sanitizeSettings(
    { enabled: true, inactivityDays: 20, aiPreferenceSource: "default" },
    s.settings,
  );
  assert.equal(settings.aiEnabled, false);
  assert.equal(settings.aiPreferenceSource, "user");
  settings = sanitizeSettings({ aiEnabled: true }, settings);
  assert.equal(settings.aiEnabled, true);
  assert.equal(settings.aiPreferenceSource, "user");
  assert.equal(
    hydrateState({ version: 1, settings }, T).settings.aiPreferenceSource,
    "user",
  );

  const unknown = hydrateState(
    { version: 1, settings: { aiEnabled: false } },
    T,
  ).settings;
  assert.equal(
    sanitizeSettings({ aiEnabled: "false", maxSuggestions: 4 }, unknown)
      .aiPreferenceSource,
    "legacy-unknown",
  );
  assert.equal(
    sanitizeSettings({ aiEnabled: false }, unknown).aiPreferenceSource,
    "user",
  );
  assert.equal(
    sanitizeSettings({ aiEnabled: true }, createState(T).settings)
      .aiPreferenceSource,
    "user",
  );
});

test("cold start never assumes browsing history or old Chrome lastAccessed", () => {
  const s = state(),
    tabs = [tab(1, undefined, { lastAccessed: T - 90 * DAY })];
  assert.deepEqual(suggestions(s, tabs), []);
  assert.equal(s.observations[1].lastUsedAt, null);
  assert.equal(makeSnapshot(s, tabs, T).tabs[0].inactivityDays, 0);
  assert.deepEqual(suggestions(s, tabs, T + 6 * DAY), []);
  const [old] = suggestions(s, tabs, T + 7 * DAY);
  assert.equal(old.type, "inactive");
  assert.match(old.reason, /recorded for these URLs/);
  assert.match(old.reason, /may still be important/);
  assert.match(old.reason, /reopened or changed/);
  assert.equal(old.explanationVariants[0], old.reason);
  assert.match(
    old.explanationVariants[1],
    /at least 7 days.*may still be important/,
  );
});

test("duplicate comparison preserves query, fragment, case, and exact URL", () => {
  const s = state(),
    base = "https://example.com/report?team=1#draft";
  const tabs = [
    tab(1, base),
    tab(2, base),
    tab(3, "https://example.com/report?team=2#draft"),
    tab(4, "https://example.com/report?team=1#final"),
    tab(5, "https://example.com/Report?team=1#draft"),
  ];
  const duplicates = suggestions(s, tabs).filter(
    (item) => item.type === "duplicate",
  );
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].tabIds, [2]);
  assert.deepEqual(
    duplicates[0].retainedTabs.map((item) => item.id),
    [1],
  );
  assert.match(duplicates[0].reason, /unsaved edits/);
  assert.equal(duplicates[0].explanationVariants[0], duplicates[0].reason);
  assert.match(
    duplicates[0].explanationVariants[1],
    /2 open tabs.*unsaved edits/,
  );
});

test("close suggestions exclude active, pinned, audio, protected, incognito, and internal URLs", () => {
  const s = state();
  const tabs = [
    tab(1),
    tab(2, undefined, { active: true }),
    tab(3, undefined, { pinned: true }),
    tab(4, undefined, { audible: true }),
    tab(5),
    tab(6, undefined, { incognito: true }),
    tab(7, "chrome://settings"),
    tab(8, "https://user:password@example.com/"),
  ];
  s.protectedUrls[tabs[4].url] = T;
  observeTabs(s, tabs, T);
  const old = suggestions(s, tabs, T + 9 * DAY).filter(
    (item) => item.type === "inactive",
  );
  assert.deepEqual(
    old.flatMap((item) => item.tabIds),
    [1],
  );
  assert.equal(makeSnapshot(s, tabs, T).tabs.length, 5);
});

test("grouping stays in its original window and excludes existing groups", () => {
  const s = state();
  const tabs = [
    tab(1),
    tab(2),
    tab(3),
    tab(4, undefined, { windowId: 2 }),
    tab(5, undefined, { windowId: 2 }),
    tab(6, undefined, { groupId: 10 }),
  ];
  const groups = suggestions(s, tabs).filter((item) => item.type === "group");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tabIds, [1, 2, 3]);
  assert.equal(groups[0].signal, "site");
  assert.match(groups[0].reason, /same window/);
  assert.match(
    groups[0].explanationVariants[1],
    /3 ungrouped tabs from site.test/,
  );
});

test("cross-site grouping needs actual shared meaningful title terms", () => {
  const s = state();
  const tabs = [
    tab(1, "https://a.test/1", { title: "Japan itinerary planning guide" }),
    tab(2, "https://b.test/2", { title: "Japan itinerary travel map" }),
    tab(3, "https://c.test/3", { title: "New page home dashboard" }),
  ];
  const [group] = suggestions(s, tabs);
  assert.equal(group.signal, "title");
  assert.deepEqual(group.tabIds, [1, 2]);
  assert.match(group.reason, /japan.*itinerary/i);
  assert.match(group.explanationVariants[1], /japan.*itinerary.*same window/i);
});

test("switching within one period is insufficient and repeated independent periods can group", () => {
  const s = state(),
    tabs = [
      tab(1, "https://alpha.test/a", { title: "Invoice overview" }),
      tab(2, "https://beta.test/b", { title: "Client calendar" }),
    ];
  observeTabs(s, tabs, T, 1);
  observeTabs(s, tabs, T + 60_000, 2);
  observeTabs(s, tabs, T + 120_000, 1);
  observeTabs(s, tabs, T + 180_000, 2);
  assert.equal(suggestions(s, tabs, T + 180_000).length, 0);
  for (const offset of [20, 40]) {
    observeTabs(s, tabs, T + offset * 60_000, 1);
    observeTabs(s, tabs, T + (offset + 1) * 60_000, 2);
  }
  const [group] = suggestions(s, tabs, T + 52 * 60_000);
  assert.equal(group.signal, "repeated-use");
  assert.match(group.reason, /3 separate recorded browsing periods/);
  tabs[1].url = "https://beta.test/changed";
  assert.equal(suggestions(s, tabs, T + 53 * 60_000).length, 0);
});

test("dismissal survives title changes, time, tab order, and reopened URL identities", () => {
  const s = state(),
    tabs = [tab(1), tab(2), tab(3)];
  const [group] = suggestions(s, tabs);
  s.dismissed[group.fingerprint] = T;
  assert.equal(
    suggestions(
      s,
      [...tabs]
        .reverse()
        .map((t) => ({ ...t, title: "Renamed", id: t.id + 10 })),
      T + DAY,
    ).filter((x) => x.type === "group").length,
    0,
  );
  assert.notEqual(
    fingerprint("group", tabs),
    fingerprint("group", [...tabs, tab(4)]),
  );
});

test("worker state preserves observation but new browser session resets identity evidence", () => {
  const s = state();
  startSession(s, "session-a", T);
  observeTabs(s, [tab(1)], T);
  startSession(s, "session-a", T + DAY);
  assert.equal(s.observations[1].firstSeenAt, T);
  s.saved.push({ id: "saved" });
  s.protectedUrls["https://site.test/1"] = T;
  startSession(s, "session-b", T + 2 * DAY);
  assert.deepEqual(s.observations, {});
  assert.equal(s.saved.length, 1);
  assert.ok(s.protectedUrls["https://site.test/1"]);
});

test("selection validation rejects URL navigation, pending navigation, grouping, and changed safety", () => {
  const s = state(),
    original = tab(1);
  observeTabs(s, [original], T);
  for (const patch of [
    { url: "https://other.test/" },
    { pendingUrl: "https://other.test/" },
    { groupId: 2 },
    { windowId: 4 },
    { active: true },
    { pinned: true },
    { audible: true },
    { incognito: true },
  ]) {
    assert.throws(() =>
      validateSelection(
        [{ ...original, ...patch }],
        s,
        [1],
        [original],
        "close",
        T,
      ),
    );
  }
  assert.throws(
    () => validateSelection([original], s, [1, 1], [original], "close", T),
    /different tabs/,
  );
  assert.equal(
    validateSelection(
      [{ ...original, active: true }],
      s,
      [1],
      [original],
      "group",
      T,
    ).length,
    1,
  );
});

test("bounded records and validated settings prevent unbounded observation growth", () => {
  const s = state();
  observeTabs(
    s,
    Array.from({ length: LIMITS.observations + 20 }, (_, i) => tab(i + 1)),
    T,
  );
  assert.equal(Object.keys(s.observations).length, LIMITS.observations);
  assert.deepEqual(
    sanitizeSettings({
      inactivityDays: -20,
      maxSuggestions: 999,
      enabled: "yes",
    }),
    {
      enabled: false,
      aiEnabled: true,
      aiPreferenceSource: "default",
      historyEnabled: true,
      groupNameLanguage: "auto",
      inactivityDays: 7,
    },
  );
});

test("closing or navigating the previous active tab removes its retained transition URL", () => {
  const s = state();
  observeTabs(s, [tab(1)], T, 1);
  assert.ok(s.lastActivation[1]);
  observeTabs(s, [], T + 1000);
  assert.deepEqual(s.lastActivation, {});
  observeTabs(s, [tab(1)], T + 2000, 1);
  observeTabs(s, [tab(1, "chrome://settings")], T + 3000, 1);
  assert.deepEqual(s.lastActivation, {});
});

test("eight daily restarts preserve URL evidence without inventing current-tab age", () => {
  let s = state();
  startSession(s, "session-0", T);
  observeTabs(s, [tab(1)], T);
  for (let day = 1; day <= 8; day++) {
    const stamp = T + day * DAY;
    s = hydrateState(structuredClone(s), stamp);
    startSession(s, `session-${day}`, stamp);
    const [current] = observeTabs(
      s,
      [tab(100 + day, "https://site.test/1")],
      stamp,
    );
    assert.equal(current.firstSeenThisSessionAt, stamp);
    assert.equal(current.lastUsedAt, null);
    assert.equal(current.urlFirstObservedAt, T);
    assert.equal(current.historySource, "prior-session-url");
    assert.equal(current.inactivityDays, day);
    assert.equal(
      buildSuggestions([current], s, stamp).some(
        (item) => item.type === "inactive",
      ),
      false,
    );
    const later = observeTabs(
      s,
      [tab(100 + day, "https://site.test/1")],
      stamp + STARTUP_REVIEW_GRACE,
    );
    assert.equal(
      buildSuggestions(later, s, stamp + STARTUP_REVIEW_GRACE).some(
        (item) => item.type === "inactive",
      ),
      day >= 7,
    );
  }
  assert.equal(s.trackingSince, T);
});

test("startup history never attaches by reused tab ID or inexact URL", () => {
  const s = state();
  startSession(s, "one", T);
  const original = "https://site.test/report?team=1#draft";
  observeTabs(s, [tab(1, original)], T);
  startSession(s, "two", T + 8 * DAY);
  const [changed] = observeTabs(
    s,
    [tab(1, "https://site.test/report?team=2#draft")],
    T + 8 * DAY,
  );
  assert.equal(changed.inactivityDays, 0);
  assert.equal(changed.historySource, "current-session");
  assert.equal(changed.urlFirstObservedAt, T + 8 * DAY);
});

test("ambiguous duplicate counts on either side of restart get fresh tab baselines", () => {
  for (const [beforeCount, afterCount] of [
    [2, 1],
    [1, 2],
    [2, 2],
  ]) {
    const s = state();
    startSession(s, "one", T);
    observeTabs(
      s,
      Array.from({ length: beforeCount }, (_, i) =>
        tab(i + 1, "https://site.test/shared"),
      ),
      T,
    );
    startSession(s, "two", T + 8 * DAY);
    const current = observeTabs(
      s,
      Array.from({ length: afterCount }, (_, i) =>
        tab(i + 10, "https://site.test/shared"),
      ),
      T + 8 * DAY,
    );
    assert.ok(
      current.every(
        (item) =>
          item.inactivityDays === 0 && item.historySource === "current-session",
      ),
    );
    assert.ok(current.every((item) => item.urlFirstObservedAt === T));
  }
});

test("a URL opened after startup is fresh even when durable history is old", () => {
  const s = state();
  startSession(s, "one", T);
  observeTabs(s, [tab(1)], T);
  startSession(s, "two", T + 8 * DAY);
  observeTabs(s, [tab(10, "https://different.test/")], T + 8 * DAY);
  const reopened = observeTabs(
    s,
    [tab(10, "https://different.test/"), tab(20, "https://site.test/1")],
    T + 8 * DAY + 1000,
  ).find((item) => item.id === 20);
  assert.equal(reopened.inactivityDays, 0);
  assert.equal(reopened.urlFirstObservedAt, T);
  assert.equal(reopened.historySource, "current-session");
});

test("latest activation of any duplicate resets URL review age for every copy", () => {
  const s = state(),
    a = tab(1, "https://site.test/same"),
    b = tab(2, a.url);
  observeTabs(s, [a, b], T);
  recordActivation(s, a, T + 8 * DAY);
  const current = observeTabs(s, [a, b], T + 8 * DAY);
  assert.ok(current.every((item) => item.inactivityDays === 0));
  assert.ok(current.every((item) => item.urlLastUsedAt === T + 8 * DAY));
  assert.equal(current[1].lastUsedAt, null);
});

test("selected tabs in background windows do not refresh their URL inactivity on repeated scans", () => {
  const s = state();
  const tabs = [
    tab(1, "https://focused.test/", { active: true, windowId: 1 }),
    tab(2, "https://background.test/", { active: true, windowId: 2 }),
    tab(3, "https://background.test/", { windowId: 1 }),
  ];
  observeTabs(s, tabs, T, null, 1);
  const later = observeTabs(s, tabs, T + 9 * DAY, null, 1);
  assert.equal(later.find((t) => t.id === 1).inactivityDays, 0);
  assert.equal(later.find((t) => t.id === 1).visitCount, 1);
  assert(later.filter((t) => t.id !== 1).every((t) => t.inactivityDays === 9));
  assert(
    later.filter((t) => t.id !== 1).every((t) => t.urlLastUsedAt === null),
  );
  const focused = observeTabs(s, tabs, T + 10 * DAY, null, 2);
  assert(
    focused.filter((t) => t.id !== 1).every((t) => t.inactivityDays === 0),
  );
  assert.equal(focused.find((t) => t.id === 2).visitCount, 1);
  const unfocused = observeTabs(s, tabs, T + 12 * DAY);
  assert.equal(unfocused.find((t) => t.id === 2).inactivityDays, 2);
});

test("URL ledger survives closed tabs but expires after 90 days and has a hard cap", () => {
  const s = state();
  observeTabs(s, [tab(1)], T);
  observeTabs(s, [], T + DAY);
  assert.ok(s.urlHistory["https://site.test/1"]);
  observeTabs(s, [], T + 91 * DAY);
  assert.equal(Object.keys(s.urlHistory).length, 0);
  observeTabs(
    s,
    Array.from({ length: LIMITS.urlHistory + 50 }, (_, i) => tab(i + 1)),
    T + 92 * DAY,
  );
  assert.equal(Object.keys(s.urlHistory).length, LIMITS.urlHistory);
});

test("older stored observations migrate into durable evidence without importing browser history", () => {
  const old = createState(T);
  old.settings.enabled = true;
  old.sessionId = "old";
  delete old.urlHistory;
  delete old.reviewEpoch;
  old.observations = {
    1: {
      url: "https://site.test/1",
      firstSeenAt: T,
      lastUsedAt: T + DAY,
      lastSeenAt: T + 2 * DAY,
      visitCount: 4,
    },
  };
  const s = hydrateState(old, T + 8 * DAY);
  startSession(s, "new", T + 8 * DAY);
  const [restored] = observeTabs(
    s,
    [tab(90, "https://site.test/1")],
    T + 8 * DAY,
  );
  assert.equal(restored.urlFirstObservedAt, T);
  assert.equal(restored.urlLastUsedAt, T + DAY);
  assert.equal(restored.urlVisitCount, 4);
  assert.equal(restored.lastUsedAt, null);
  assert.equal(restored.inactivityDays, 7);
});

test("excluded activation breaks co-use evidence without retaining its URL", () => {
  const s = state();
  recordActivation(s, tab(1, "https://alpha.test/"), T);
  recordActivation(s, tab(3, "chrome://settings"), T + 60_000);
  assert.deepEqual(s.lastActivation, {});
  recordActivation(s, tab(2, "https://beta.test/"), T + 120_000);
  assert.deepEqual(s.pairs, {});
  assert.equal(s.urlHistory["chrome://settings"], undefined);
  assert.equal(s.observations[3], undefined);
});

test("100 already-grouped fresh tabs are checked with explicit zero candidates and history context", () => {
  const s = state();
  const tabs = Array.from({ length: 100 }, (_, i) =>
    tab(i + 1, `https://host${i}.test/`, { groupId: 10, title: `Page ${i}` }),
  );
  observeTabs(s, tabs, T);
  const snap = makeSnapshot(s, tabs, T);
  assert.equal(snap.tabs.length, 100);
  assert.equal(snap.suggestions.length, 0);
  assert.equal(snap.evaluationSummary.webTabsChecked, 100);
  assert.equal(snap.evaluationSummary.groupCandidates, 0);
  assert.equal(snap.evaluationSummary.skipped.alreadyGrouped, 100);
  assert.equal(snap.evaluationSummary.skipped.insufficientHistory, 100);
  assert.equal(snap.evaluationSummary.checkedAt, T);
});

test("100 unrelated new tabs do not fabricate suggestions or older URL evidence", () => {
  const s = state();
  const tabs = Array.from({ length: 100 }, (_, i) =>
    tab(i + 1, `https://host${i}.test/`, { title: `Page ${i}` }),
  );
  observeTabs(s, tabs, T);
  const summary = makeSnapshot(s, tabs, T).evaluationSummary;
  assert.equal(summary.webTabsChecked, 100);
  assert.equal(summary.groupCandidates, 0);
  assert.equal(summary.exactDuplicateExtras, 0);
  assert.equal(summary.olderURLCandidates, 0);
  assert.equal(summary.skipped.insufficientHistory, 100);
});

test("guarded counts are a unique union while individual exclusion categories may overlap", () => {
  const s = state();
  const tabs = Array.from({ length: 100 }, (_, i) =>
    tab(i + 1, `https://host${i}.test/`, {
      pinned: i < 60,
      audible: i >= 40,
      groupId: i < 10 ? 5 : -1,
    }),
  );
  for (const item of tabs.slice(20, 80)) s.protectedUrls[item.url] = T;
  observeTabs(s, tabs, T);
  const summary = makeSnapshot(
    s,
    [...tabs, { ...tab(999), incognito: true }, tab(998, "chrome://settings")],
    T,
  ).evaluationSummary;
  assert.equal(summary.webTabsChecked, 100);
  assert.equal(summary.skipped.guarded, 100);
  assert.equal(summary.skipped.pinned, 60);
  assert.equal(summary.skipped.audible, 60);
  assert.equal(summary.skipped.protected, 60);
  assert.equal(summary.skipped.alreadyGrouped, 10);
  assert.equal(summary.suggestionsShown, 0);
});

test("candidate summary exposes all reviews and preserves duplicate safety, occupancy, and dismissals", () => {
  const s = state();
  s.settings.maxSuggestions = 1;
  const tabs = [
    tab(1, "https://copy.test/same", { active: true }),
    tab(2, "https://copy.test/same"),
    tab(3, "https://copy.test/same", { pinned: true }),
    tab(4, "https://group.test/a"),
    tab(5, "https://group.test/b"),
    tab(6, "https://group.test/c"),
    ...Array.from({ length: 12 }, (_, i) =>
      tab(i + 10, `https://old${i}.test/`),
    ),
  ];
  observeTabs(s, tabs, T);
  const snap = makeSnapshot(s, tabs, T + 8 * DAY),
    summary = snap.evaluationSummary;
  assert.equal(summary.exactDuplicateSets, 1);
  assert.equal(summary.exactDuplicateExtras, 2);
  assert.equal(summary.duplicateReviewTabs, 1);
  assert.equal(summary.groupCandidates, 1);
  assert.equal(summary.olderURLCandidates, 12);
  assert.equal(summary.suggestionsShown, 3);
  assert.equal(summary.limitedCandidates, 0);
  assert.equal(
    snap.suggestions.find((item) => item.type === "inactive").tabIds.length,
    12,
  );
  assert.equal(snap.suggestions[0].type, "duplicate");
  s.dismissed[snap.suggestions[0].fingerprint] = T;
  const dismissed = makeSnapshot(s, tabs, T + 8 * DAY).evaluationSummary;
  assert.equal(dismissed.dismissedCandidates, 1);
  assert.equal(dismissed.exactDuplicateExtras, 2);
  assert.equal(dismissed.suggestionsShown, 2);
});

test("all 50 actual group candidates among 100 tabs remain available without a display cap", () => {
  const s = state();
  const tabs = Array.from({ length: 100 }, (_, i) =>
    tab(i + 1, `https://host${i}.test/`, {
      title: `Mercury${Math.floor(i / 2)} Observatory${Math.floor(i / 2)} ${i % 2 ? "Notes" : "Plan"}`,
    }),
  );
  observeTabs(s, tabs, T);
  const snap = makeSnapshot(s, tabs, T);
  assert.equal(snap.evaluationSummary.groupCandidates, 50);
  assert.equal(snap.evaluationSummary.limitedCandidates, 0);
  assert.equal(snap.evaluationSummary.suggestionsShown, 50);
  assert.equal(snap.suggestions.length, 50);
  assert.equal(
    new Set(snap.suggestions.flatMap((item) => item.tabIds)).size,
    100,
  );
});

test("removed legacy maxSuggestions values cannot silently limit discovered work", () => {
  const s = hydrateState(
    { version: 1, settings: { enabled: true, maxSuggestions: 1 } },
    T,
  );
  assert.equal("maxSuggestions" in s.settings, false);
  assert.equal(
    "maxSuggestions" in sanitizeSettings({ maxSuggestions: 1 }, s.settings),
    false,
  );
  const tabs = Array.from({ length: 36 }, (_, i) =>
    tab(i + 1, `https://window${Math.floor(i / 3)}.test/${i}`, {
      windowId: Math.floor(i / 3) + 1,
    }),
  );
  observeTabs(s, tabs, T);
  const snapshot = makeSnapshot(s, tabs, T);
  assert.equal(snapshot.suggestions.length, 12);
  assert.equal(snapshot.evaluationSummary.suggestionsShown, 12);
  assert.equal(snapshot.evaluationSummary.limitedCandidates, 0);
});

test("all old tabs remain accessible in native-action-sized reviews instead of an eight-tab sample", () => {
  const s = state();
  const tabs = Array.from({ length: 457 }, (_, i) =>
    tab(i + 1, `https://unique${i}.test/`, { windowId: (i % 4) + 1 }),
  );
  observeTabs(s, tabs, T);
  const snapshot = makeSnapshot(s, tabs, T + 8 * DAY);
  const reviews = snapshot.suggestions.filter(
    (item) => item.type === "inactive",
  );
  assert.equal(snapshot.evaluationSummary.olderURLCandidates, tabs.length);
  assert.ok(reviews.length >= 3);
  assert.ok(
    reviews.every(
      (review) => review.tabIds.length > 0 && review.tabIds.length <= 200,
    ),
  );
  assert.equal(reviews.flatMap((review) => review.tabIds).length, tabs.length);
  assert.deepEqual(
    new Set(reviews.flatMap((review) => review.tabIds)),
    new Set(tabs.map((item) => item.id)),
  );
  for (const review of reviews) {
    assert.match(review.reason, /at least 8 days/);
    assert.match(review.reason, /may have reopened or changed/);
    assert.match(review.reason, /may still be important/);
  }
});

test("large site groups batch every tab without single-tab group leftovers", () => {
  for (const count of [201, 400, 401]) {
    const s = state(),
      tabs = Array.from({ length: count }, (_, i) => tab(i + 1));
    const groups = suggestions(s, tabs).filter((item) => item.type === "group");
    assert.ok(
      groups.every(
        (group) => group.tabIds.length >= 2 && group.tabIds.length <= 200,
      ),
    );
    assert.equal(groups.flatMap((group) => group.tabIds).length, count);
    assert.equal(new Set(groups.flatMap((group) => group.tabIds)).size, count);
    for (const group of groups) {
      assert.equal(new Set(group.tabs.map((item) => item.windowId)).size, 1);
      assert.match(
        group.reason,
        new RegExp(`contains ${group.tabs.length} of those tabs`),
      );
    }
  }
});

test("large duplicate reviews expose every eligible extra while retaining a safe copy", () => {
  const s = state(),
    tabs = Array.from({ length: 452 }, (_, i) =>
      tab(i + 1, "https://exact.test/copy?query=1#fragment", {
        active: i === 0,
        pinned: i === 1,
      }),
    );
  const snapshot = makeSnapshot(s, tabs, T);
  const reviews = snapshot.suggestions.filter(
    (item) => item.type === "duplicate",
  );
  assert.equal(snapshot.evaluationSummary.exactDuplicateExtras, 451);
  assert.equal(snapshot.evaluationSummary.duplicateReviewTabs, 450);
  assert.ok(
    reviews.every(
      (review) => review.tabs.length <= 200 && review.retainedTabs[0].id === 1,
    ),
  );
  assert.deepEqual(
    new Set(reviews.flatMap((review) => review.tabIds)),
    new Set(tabs.slice(2).map((item) => item.id)),
  );
  assert.ok(
    reviews.every((review) => /unsaved edits may differ/.test(review.reason)),
  );
});

test("mixed groups, duplicate sets, and old tabs across windows are all ranked and reachable", () => {
  const s = state();
  let id = 1;
  const tabs = [];
  for (let windowId = 1; windowId <= 8; windowId++)
    for (let item = 0; item < 3; item++)
      tabs.push(
        tab(id++, `https://site${windowId}.test/${item}`, { windowId }),
      );
  for (let windowId = 10; windowId <= 12; windowId++)
    for (let item = 0; item < 3; item++)
      tabs.push(
        tab(id++, `https://duplicate${windowId}.test/same`, { windowId }),
      );
  for (let item = 0; item < 33; item++)
    tabs.push(
      tab(id++, `https://older${item}.test/`, { windowId: 20 + (item % 2) }),
    );
  observeTabs(s, tabs, T);
  const snapshot = makeSnapshot(s, tabs, T + 8 * DAY);
  assert.equal(
    snapshot.suggestions.filter((item) => item.type === "group").length,
    8,
  );
  assert.equal(
    snapshot.suggestions.filter((item) => item.type === "duplicate").length,
    3,
  );
  assert.ok(snapshot.suggestions.length > 5);
  assert.ok(
    snapshot.suggestions
      .filter((item) => item.type === "inactive")
      .flatMap((item) => item.tabIds).length >= 33,
  );
  assert.ok(
    snapshot.suggestions.every(
      (item) =>
        typeof item.rankReason === "string" && item.rankReason.length > 0,
    ),
  );
  assert.deepEqual(
    snapshot.suggestions.slice(0, 3).map((item) => item.type),
    ["duplicate", "duplicate", "duplicate"],
  );
  assert.equal(snapshot.suggestions.at(-1).type, "inactive");
});

function proposal(id, type, tabs, signal = undefined) {
  return {
    id,
    type,
    tabs,
    tabIds: tabs.map((item) => item.id),
    ...(signal ? { signal } : {}),
  };
}
test("ranking uses measured strength then review effort with stable window and tab ties", () => {
  const s = state();
  const proposals = [
    proposal("older", "inactive", [tab(90)]),
    proposal(
      "site-large",
      "group",
      [tab(20), tab(21), tab(22), tab(23)],
      "site",
    ),
    proposal(
      "site-small-later-window",
      "group",
      [
        tab(10, undefined, { windowId: 2 }),
        tab(11, undefined, { windowId: 2 }),
        tab(12, undefined, { windowId: 2 }),
      ],
      "site",
    ),
    proposal("site-small", "group", [tab(30), tab(31), tab(32)], "site"),
    proposal("title", "group", [tab(40), tab(41)], "title"),
    proposal("repeated-use", "group", [tab(50), tab(51)], "repeated-use"),
    proposal("duplicate-small", "duplicate", [tab(60)]),
    proposal("duplicate-large", "duplicate", [tab(70), tab(71), tab(72)]),
  ];
  const tabs = proposals.flatMap((item) => item.tabs);
  const expected = [
    "duplicate-large",
    "duplicate-small",
    "title",
    "repeated-use",
    "site-small",
    "site-small-later-window",
    "site-large",
    "older",
  ];
  assert.deepEqual(
    rankSuggestions(proposals, s, tabs, T).map((item) => item.id),
    expected,
  );
  assert.deepEqual(
    rankSuggestions([...proposals].reverse(), s, [...tabs].reverse(), T).map(
      (item) => item.id,
    ),
    expected,
  );
});

test("only a current exact-identity recent activation can elevate a suggestion", () => {
  const s = state();
  const currentTab = tab(1),
    otherTab = tab(2),
    oldTab = tab(3);
  const proposals = [
    proposal("duplicate", "duplicate", [otherTab]),
    proposal("site", "group", [currentTab, tab(4), tab(5)], "site"),
    proposal("older", "inactive", [oldTab]),
  ];
  const tabs = proposals.flatMap((item) => item.tabs);
  s.lastActivation = { 1: { id: 1, url: currentTab.url, at: T - 1000 } };
  let result = rankSuggestions(proposals, s, tabs, T);
  assert.equal(result[0].id, "site");
  assert.match(result[0].rankReason, /most recently used/);
  for (const entry of [
    { id: 1, url: currentTab.url, at: T - 31 * 60_000 },
    { id: 1, url: currentTab.url + "?changed", at: T - 1000 },
    { id: 99, url: currentTab.url, at: T - 1000 },
    { id: 1, url: currentTab.url, at: T + 1000 },
    { id: 3, url: oldTab.url, at: T - 1000 },
  ]) {
    s.lastActivation = { 1: entry };
    result = rankSuggestions(proposals, s, tabs, T);
    assert.equal(result[0].id, "duplicate");
    assert.equal(result.at(-1).id, "older");
  }
});

test("enabled history ranks comparable groups by available recency and recent frequency without claiming importance", () => {
  const s = state();
  s.settings.historyEnabled = true;
  const recentSmall = proposal(
    "recent-small",
    "group",
    [tab(1), tab(2), tab(3)],
    "site",
  );
  const recentFrequent = proposal(
    "recent-frequent",
    "group",
    [tab(4), tab(5), tab(6), tab(7)],
    "site",
  );
  const week = proposal("week", "group", [tab(8), tab(9), tab(10)], "site");
  const month = proposal("month", "group", [tab(11), tab(12), tab(13)], "site");
  const older = proposal(
    "older-history",
    "group",
    [tab(14), tab(15), tab(16)],
    "site",
  );
  const unknown = proposal(
    "unknown",
    "group",
    [tab(17), tab(18), tab(19)],
    "site",
  );
  const proposals = [unknown, older, week, recentSmall, month, recentFrequent];
  const tabs = proposals.flatMap((item) => item.tabs);
  const facts = {
    [tabs.find((item) => item.id === 1).url]: {
      visits: 9000,
      recentVisits: 2,
      lastVisitTime: T - 1000,
      observedAt: T,
    },
    [tabs.find((item) => item.id === 4).url]: {
      visits: 20,
      recentVisits: 10,
      lastVisitTime: T - 2 * 60_000,
      observedAt: T,
      partial: true,
    },
    [tabs.find((item) => item.id === 8).url]: {
      visits: 100,
      recentVisits: 100,
      lastVisitTime: T - 3 * DAY,
      observedAt: T,
    },
    [tabs.find((item) => item.id === 11).url]: {
      visits: 500,
      recentVisits: 500,
      lastVisitTime: T - 15 * DAY,
      observedAt: T,
    },
    [tabs.find((item) => item.id === 14).url]: {
      visits: 1000,
      recentVisits: 0,
      lastVisitTime: T - 60 * DAY,
      observedAt: T,
    },
  };
  const result = rankSuggestions(proposals, s, tabs, T, facts);
  assert.deepEqual(
    result.map((item) => item.id),
    [
      "recent-frequent",
      "recent-small",
      "week",
      "month",
      "older-history",
      "unknown",
    ],
  );
  assert.match(result[0].historyReason, /20 available browser visits/);
  assert.match(result[0].historyReason, /history analyzed so far/);
  assert.match(result[0].historyReason, /does not prove importance/);
  assert.equal(result.at(-1).historyReason, null);
});

test("history never overrides stronger grouping evidence or current exact-URL context", () => {
  const s = state();
  s.settings.historyEnabled = true;
  const proposals = [
    proposal("site", "group", [tab(1), tab(2), tab(3)], "site"),
    proposal("title", "group", [tab(4), tab(5)], "title"),
    proposal("repeated-use", "group", [tab(6), tab(7)], "repeated-use"),
    proposal("duplicate", "duplicate", [tab(8)]),
  ];
  const tabs = proposals.flatMap((item) => item.tabs);
  const facts = {
    [tabs[0].url]: {
      visits: 10_000,
      recentVisits: 1000,
      lastVisitTime: T - 1000,
    },
  };
  assert.deepEqual(
    rankSuggestions(proposals, s, tabs, T, facts).map((item) => item.id),
    ["duplicate", "title", "repeated-use", "site"],
  );
  s.lastActivation = {
    1: { id: 4, url: tabs.find((item) => item.id === 4).url, at: T - 1000 },
  };
  assert.equal(rankSuggestions(proposals, s, tabs, T, facts)[0].id, "title");
});

test("disabled, absent, unknown, or future history facts preserve deterministic ordering", () => {
  const s = state();
  s.settings.historyEnabled = false;
  const proposals = [
    proposal("first", "group", [tab(1), tab(2), tab(3)], "site"),
    proposal("second", "group", [tab(4), tab(5), tab(6)], "site"),
  ];
  const tabs = proposals.flatMap((item) => item.tabs);
  const history = {
    [tabs[3].url]: { visits: 100, recentVisits: 50, lastVisitTime: T - 1000 },
  };
  assert.deepEqual(
    rankSuggestions(proposals, s, tabs, T, history).map((item) => item.id),
    ["first", "second"],
  );
  assert.ok(
    rankSuggestions(proposals, s, tabs, T, history).every(
      (item) => item.historyReason === null,
    ),
  );
  s.settings.historyEnabled = true;
  for (const facts of [
    {},
    { [tabs[3].url + "?different"]: history[tabs[3].url] },
    {
      [tabs[3].url]: { visits: 100, recentVisits: 50, lastVisitTime: T + DAY },
    },
    { [tabs[3].url]: { visits: 0, recentVisits: 0, lastVisitTime: T - 1000 } },
  ])
    assert.deepEqual(
      rankSuggestions(proposals, s, tabs, T, facts).map((item) => item.id),
      ["first", "second"],
    );
});

test("history can inform a fresh group without inventing local observation or old-tab eligibility", () => {
  const s = state();
  s.settings.historyEnabled = true;
  const tabs = [tab(1), tab(2), tab(3)];
  const facts = Object.fromEntries(
    tabs.map((item) => [
      item.url,
      {
        visits: 100,
        recentVisits: 0,
        lastVisitTime: T - 90 * DAY,
        observedAt: T,
      },
    ]),
  );
  observeTabs(s, tabs, T);
  const snapshot = makeSnapshot(s, tabs, T, facts);
  assert.equal(snapshot.suggestions.length, 1);
  assert.equal(snapshot.suggestions[0].type, "group");
  assert.match(
    snapshot.suggestions[0].historyReason,
    /300 available browser visits/,
  );
  assert.equal(snapshot.evaluationSummary.olderURLCandidates, 0);
  assert.ok(
    snapshot.tabs.every(
      (item) => item.inactivityDays === 0 && item.urlVisitCount === 0,
    ),
  );
  assert.ok(
    Object.values(s.observations).every(
      (record) => record.firstSeenAt === T && record.lastUsedAt === null,
    ),
  );
});

test("duplicate history counts an exact URL once despite repeated copies and a retained tab", () => {
  const s = state();
  s.settings.historyEnabled = true;
  const tabs = [
    tab(1, "https://copies.test/same"),
    tab(2, "https://copies.test/same"),
    tab(3, "https://copies.test/same"),
  ];
  observeTabs(s, tabs, T);
  const snapshot = makeSnapshot(s, tabs, T, {
    [tabs[0].url]: { visits: 25, recentVisits: 4, lastVisitTime: T - 1000 },
  });
  assert.match(
    snapshot.suggestions.find((item) => item.type === "duplicate")
      .historyReason,
    /25 available browser visits/,
  );
});

test("paused snapshot does not claim a check or expose a previous summary", () => {
  const s = createState(T);
  assert.equal(makeSnapshot(s, [tab(1)], T).evaluationSummary, null);
});
