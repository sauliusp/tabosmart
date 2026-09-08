import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_LIMITS,
  createGroupingContext,
  hydrateGroupingContext,
  resetGroupingSession,
  recordOpening,
  recordContextActivation,
  reconcileGroupingContext,
  rememberGroupingChoice,
  discoverContextGroups,
} from "../extension/grouping-context.mjs";

const T = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const tab = (id, patch = {}) => ({
  id,
  windowId: 1,
  url: `https://source${id}.test/article/${id}`,
  title: `Unrelated ${id}`,
  groupId: -1,
  pinned: false,
  audible: false,
  incognito: false,
  ...patch,
});
test("oversized confirmed groups are never learned as a misleading prefix", () => {
  const context = createGroupingContext();
  const tabs = Array.from({ length: CONTEXT_LIMITS.choiceURLs + 1 }, (_, i) =>
    tab(i + 1),
  );
  assert.equal(
    rememberGroupingChoice(context, tabs, "Whole collection", T),
    false,
  );
  assert.deepEqual(context.choices, []);
  const stored = hydrateGroupingContext(
    {
      version: 1,
      choices: [
        { urls: tabs.map((t) => t.url), name: "Whole collection", at: T },
      ],
    },
    T,
  );
  assert.deepEqual(stored.choices, []);
});
test("an excluded activation interrupts an unfinished usage period without retaining its URL", () => {
  for (const excluded of [
    tab(9, { url: "chrome://settings/" }),
    tab(9, { incognito: true }),
  ]) {
    const context = createGroupingContext();
    recordContextActivation(context, tab(1), T);
    recordContextActivation(context, tab(2), T + MINUTE);
    recordContextActivation(context, excluded, T + 2 * MINUTE);
    recordContextActivation(context, tab(3), T + 3 * MINUTE);
    reconcileGroupingContext(
      context,
      [tab(1), tab(2), tab(3)],
      T + 20 * MINUTE,
    );
    assert.deepEqual(context.episodes, []);
    assert.equal(JSON.stringify(context).includes(excluded.url), false);
  }
});
function episode(context, tabs, at) {
  tabs.forEach((item, i) =>
    recordContextActivation(context, item, at + i * MINUTE),
  );
  reconcileGroupingContext(context, tabs, at + (tabs.length + 10) * MINUTE);
}
function routine(context, tabs, count = 3, at = T) {
  for (let i = 0; i < count; i++) episode(context, tabs, at + i * DAY);
}
function openingFamily(context, source = tab(10), at = T) {
  const tabs = [
    tab(1, { openerTabId: source.id }),
    tab(2, { openerTabId: source.id }),
  ];
  tabs.forEach((item, i) =>
    recordOpening(context, item, source, at + i * MINUTE),
  );
  return tabs;
}

test("first observation and repeated timer scans do not turn restored tabs into context", () => {
  const context = createGroupingContext();
  const tabs = Array.from({ length: 150 }, (_, i) =>
    tab(i + 1, { openerTabId: 999, active: i === 0 }),
  );
  for (let i = 0; i < 10; i++)
    reconcileGroupingContext(context, tabs, T + i * MINUTE);
  assert.deepEqual(discoverContextGroups(tabs, context, T + DAY), []);
  assert.equal(context.episodes.length, 0);
  assert.equal(context.openings.length, 0);
  assert.deepEqual(context.current, {});
});

test("actual sibling openings from a specific page yield a literal review proposal", () => {
  const context = createGroupingContext();
  const tabs = openingFamily(context);
  const proposals = discoverContextGroups(tabs, context, T + 3 * MINUTE);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].signal, "opening-context");
  assert.deepEqual(
    proposals[0].tabs.map((item) => item.id),
    [1, 2],
  );
  assert.match(
    proposals[0].reason,
    /same page on source10.test within five minutes/u,
  );
});

test("shared creation time alone and unrelated inbox siblings are insufficient", () => {
  const context = createGroupingContext();
  const source = tab(10, { url: "https://generic.test/mail/u/0/#inbox" });
  const tabs = openingFamily(context, source);
  assert.deepEqual(discoverContextGroups(tabs, context, T + 3 * MINUTE), []);
  const absent = createGroupingContext();
  assert.equal(recordOpening(absent, tab(1), source, T), false);
  assert.equal(
    recordOpening(absent, tab(2, { openerTabId: 99 }), source, T),
    false,
  );
  assert.deepEqual(absent.openings, []);
});

test("generic homepage siblings require corroborating title or specific resource evidence", () => {
  const context = createGroupingContext();
  const source = tab(10, { url: "https://generic.test/" });
  const tabs = [
    tab(1, {
      openerTabId: 10,
      url: "https://work.test/projects/zephyr/notes",
      title: "A",
    }),
    tab(2, {
      openerTabId: 10,
      url: "https://work.test/projects/zephyr/tasks",
      title: "B",
    }),
  ];
  tabs.forEach((item) => recordOpening(context, item, source, T));
  assert.equal(discoverContextGroups(tabs, context, T).length, 1);
  const titleContext = createGroupingContext();
  const titles = [
    tab(3, { openerTabId: 10, title: "Ąžuolų slėnis darbai" }),
    tab(4, { openerTabId: 10, title: "Ąžuolų slėnis planai" }),
  ];
  titles.forEach((item) => recordOpening(titleContext, item, source, T));
  assert.equal(discoverContextGroups(titles, titleContext, T).length, 1);
});

test("specific search queries support mixed-language openings without displaying or merging queries", () => {
  const context = createGroupingContext();
  const source = tab(10, {
    url: "https://search.test/search?q=restoring+theremin",
  });
  const tabs = [
    tab(1, { openerTabId: 10, title: "Kaip remontuoti muzikos prietaisus" }),
    tab(2, { openerTabId: 10, title: "Oscillator maintenance" }),
    tab(3, { openerTabId: 10, title: "Japanese ceramics" }),
  ];
  recordOpening(context, tabs[0], source, T);
  recordOpening(context, tabs[1], source, T + MINUTE);
  recordOpening(
    context,
    tabs[2],
    { ...source, url: "https://search.test/search?q=Japanese+ceramics" },
    T + 2 * MINUTE,
  );
  const proposals = discoverContextGroups(tabs, context, T + 3 * MINUTE);
  assert.deepEqual(
    proposals[0].tabs.map((item) => item.id),
    [1, 2],
  );
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].reason.includes("theremin"), false);
  assert.equal(proposals[0].reason.includes("q="), false);
  const generic = createGroupingContext();
  openingFamily(generic, { ...source, url: "https://search.test/search" });
  assert.deepEqual(discoverContextGroups(tabs, generic, T + 3 * MINUTE), []);
});

test("opening context captures the source URL and cannot follow a navigated child", () => {
  const context = createGroupingContext();
  const source = tab(10);
  const tabs = openingFamily(context, source);
  const changedSource = {
    ...source,
    url: "https://different.test/unrelated/page",
  };
  reconcileGroupingContext(context, [...tabs, changedSource], T + 3 * MINUTE);
  assert.ok(context.openings.every((event) => event.sourceURL === source.url));
  assert.equal(discoverContextGroups(tabs, context, T + 3 * MINUTE).length, 1);
  const changedChild = [
    { ...tabs[0], url: "https://other.test/navigation" },
    tabs[1],
  ];
  reconcileGroupingContext(context, changedChild, T + 4 * MINUTE);
  assert.equal(context.openings.length, 1);
  assert.deepEqual(
    discoverContextGroups(changedChild, context, T + 4 * MINUTE),
    [],
  );
});

test("a pending blank child may resolve once during a short grace period", () => {
  const context = createGroupingContext(),
    source = tab(10);
  const blank = tab(1, { openerTabId: 10, url: "" });
  assert.equal(recordOpening(context, blank, source, T), true);
  const loaded = { ...blank, url: "https://destination.test/article/one" };
  reconcileGroupingContext(context, [loaded], T + 10_000);
  assert.equal(context.openings[0].url, loaded.url);
  reconcileGroupingContext(
    context,
    [{ ...loaded, url: "https://destination.test/article/two" }],
    T + 20_000,
  );
  assert.equal(context.openings.length, 0);
  recordOpening(context, blank, source, T);
  reconcileGroupingContext(context, [loaded], T + 2 * MINUTE);
  assert.equal(context.openings.length, 0);
});

test("closed and reused IDs cannot resurrect opener evidence across reconciliation or session reset", () => {
  const context = createGroupingContext();
  const tabs = openingFamily(context);
  reconcileGroupingContext(context, [], T + 2 * MINUTE);
  reconcileGroupingContext(context, tabs, T + 3 * MINUTE);
  assert.deepEqual(discoverContextGroups(tabs, context, T + 3 * MINUTE), []);
  openingFamily(context);
  resetGroupingSession(context);
  assert.deepEqual(discoverContextGroups(tabs, context, T + 3 * MINUTE), []);
});

test("opening windows do not join a transitive time chain", () => {
  const context = createGroupingContext(),
    source = tab(10);
  const tabs = [1, 2, 3].map((id) => tab(id, { openerTabId: 10 }));
  tabs.forEach((item, i) =>
    recordOpening(context, item, source, T + i * 4 * MINUTE),
  );
  const proposals = discoverContextGroups(tabs, context, T + 9 * MINUTE);
  assert.equal(proposals.length, 1);
  assert.deepEqual(
    proposals[0].tabs.map((item) => item.id),
    [1, 2],
  );
});

test("three separate observed periods can recover a whole arbitrary-language routine", () => {
  const context = createGroupingContext();
  const tabs = [
    tab(1, { title: "LRT" }),
    tab(2, { title: "Delfi" }),
    tab(3, { title: "日本" }),
  ];
  routine(context, tabs);
  const proposals = discoverContextGroups(tabs, context, T + 3 * DAY);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].signal, "repeated-use");
  assert.deepEqual(
    proposals[0].tabs.map((item) => item.id),
    [1, 2, 3],
  );
  assert.match(proposals[0].reason, /3 separate recorded browsing periods/u);
});

test("repeated timer sealing and rapid alternation cannot fabricate three periods", () => {
  const context = createGroupingContext(),
    tabs = [tab(1), tab(2)];
  for (let i = 0; i < 12; i++)
    recordContextActivation(context, tabs[i % 2], T + i * 1000);
  for (let i = 0; i < 10; i++)
    reconcileGroupingContext(context, tabs, T + (11 + i) * MINUTE);
  assert.equal(context.episodes.length, 1);
  assert.deepEqual(discoverContextGroups(tabs, context, T + DAY), []);
});

test("large sequential sweeps are discarded rather than truncated into a fake small routine", () => {
  const context = createGroupingContext();
  const tabs = Array.from({ length: 20 }, (_, i) => tab(i + 1));
  routine(context, tabs);
  assert.equal(context.episodes.length, 0);
  assert.deepEqual(discoverContextGroups(tabs, context, T + 3 * DAY), []);
});

test("common interruption hubs do not bridge otherwise separate recurring sets", () => {
  const context = createGroupingContext();
  const [a, b, c, d, inbox] = [1, 2, 3, 4, 5].map((id) => tab(id));
  for (let i = 0; i < 3; i++) {
    episode(context, [a, inbox, b], T + 2 * i * DAY);
    episode(context, [c, inbox, d], T + (2 * i + 1) * DAY);
  }
  const proposals = discoverContextGroups(
    [a, b, c, d, inbox],
    context,
    T + 6 * DAY,
  );
  assert.deepEqual(
    proposals.map((p) => p.tabs.map((item) => item.id)),
    [
      [1, 2],
      [3, 4],
    ],
  );
});

test("transitive repeated pairs cannot manufacture a large connected group", () => {
  const context = createGroupingContext(),
    tabs = [tab(1), tab(2), tab(3), tab(4)];
  for (let i = 0; i < 3; i++) {
    episode(context, tabs.slice(0, 2), T + 3 * i * DAY);
    episode(context, tabs.slice(1, 3), T + (3 * i + 1) * DAY);
    episode(context, tabs.slice(2, 4), T + (3 * i + 2) * DAY);
  }
  assert.ok(
    discoverContextGroups(tabs, context, T + 9 * DAY).every(
      (p) => p.tabs.length <= 2,
    ),
  );
});

test("worker hydration preserves unfinished observations; a browser restart retains only completed evidence", () => {
  const original = createGroupingContext(),
    tabs = [tab(1), tab(2), tab(3)];
  episode(original, tabs, T);
  recordContextActivation(original, tabs[0], T + DAY);
  recordContextActivation(original, tabs[1], T + DAY + MINUTE);
  const context = hydrateGroupingContext(
    JSON.parse(JSON.stringify(original)),
    T + DAY + 2 * MINUTE,
  );
  recordContextActivation(context, tabs[2], T + DAY + 3 * MINUTE);
  reconcileGroupingContext(context, tabs, T + DAY + 15 * MINUTE);
  assert.equal(context.episodes.length, 2);
  resetGroupingSession(context);
  episode(
    context,
    tabs.map((item) => ({ ...item, id: item.id + 100 })),
    T + 2 * DAY,
  );
  assert.equal(
    discoverContextGroups(tabs, context, T + 3 * DAY)[0].signal,
    "repeated-use",
  );
});

test("context proposals respect same-window and native membership protections", () => {
  const context = createGroupingContext(),
    tabs = [tab(1), tab(2)];
  routine(context, tabs);
  for (const patch of [
    { windowId: 2 },
    { pinned: true },
    { audible: true },
    { protected: true },
    { incognito: true },
    { groupId: 8 },
  ]) {
    assert.deepEqual(
      discoverContextGroups(
        [{ ...tabs[0], ...patch }, tabs[1]],
        context,
        T + 3 * DAY,
      ),
      [],
    );
  }
});

test("confirmed exact groups are remembered without broad domain expansion", () => {
  const context = createGroupingContext();
  const tabs = [
    tab(1, { url: "https://reading.test/article/one" }),
    tab(2, { url: "https://reading.test/article/two" }),
  ];
  assert.equal(
    rememberGroupingChoice(
      context,
      tabs.map((item) => ({ ...item, groupId: 4 })),
      "My reading",
      T,
    ),
    true,
  );
  const current = [
    ...tabs,
    tab(3, { url: "https://reading.test/article/unrelated" }),
  ];
  const proposal = discoverContextGroups(current, context, T + DAY)[0];
  assert.equal(proposal.signal, "remembered-group");
  assert.equal(proposal.proposedName, "My reading");
  assert.deepEqual(
    proposal.tabs.map((item) => item.id),
    [1, 2],
  );
});

test("remembered specific resources allow changed routes but isolate tenants and resources", () => {
  const context = createGroupingContext();
  const tabs = [
    tab(1, { url: "https://work.test/projects/zephyr/notes" }),
    tab(2, { url: "https://work.test/projects/zephyr/tasks" }),
  ];
  rememberGroupingChoice(context, tabs, "Zephyr", T);
  const current = [
    tab(3, { url: "https://work.test/projects/zephyr/files" }),
    tab(4, { url: "https://work.test/projects/zephyr/milestones" }),
    tab(5, { url: "https://work.test/projects/other/files" }),
    tab(6, { url: "https://other.test/projects/zephyr/files" }),
  ];
  assert.deepEqual(
    discoverContextGroups(current, context, T + DAY)[0].tabs.map(
      (item) => item.id,
    ),
    [3, 4],
  );
});

test("remembered proposals need substantial prior membership coverage", () => {
  const context = createGroupingContext(),
    tabs = [1, 2, 3, 4].map((id) => tab(id));
  rememberGroupingChoice(context, tabs, "Four resources", T);
  assert.deepEqual(
    discoverContextGroups(tabs.slice(0, 2), context, T + DAY),
    [],
  );
  assert.equal(
    discoverContextGroups(tabs.slice(0, 3), context, T + DAY).length,
    1,
  );
});

test("exactly two of three known resources meet the coverage threshold", () => {
  const tabs = [tab(1), tab(2), tab(3)];
  const remembered = createGroupingContext();
  rememberGroupingChoice(remembered, tabs, "Three resources", T);
  assert.equal(
    discoverContextGroups(tabs.slice(0, 2), remembered, T + DAY).length,
    1,
  );
  const repeated = createGroupingContext();
  routine(repeated, tabs);
  assert.equal(
    discoverContextGroups(tabs.slice(0, 2), repeated, T + 3 * DAY).length,
    1,
  );
});

test("confirmation names update a matching choice and win duplicate proposal priority", () => {
  const context = createGroupingContext(),
    tabs = openingFamily(context);
  rememberGroupingChoice(context, tabs, "Earlier", T);
  rememberGroupingChoice(context, tabs, "My chosen name", T + MINUTE);
  assert.equal(context.choices.length, 1);
  const proposals = discoverContextGroups(tabs, context, T + 2 * MINUTE);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].signal, "remembered-group");
  assert.equal(proposals[0].proposedName, "My chosen name");
  assert.equal(proposals[0].nameLocked, true);
});

test("private, credential-bearing and non-web identities never enter context", () => {
  const context = createGroupingContext(),
    source = tab(10);
  for (const item of [
    tab(1, { incognito: true }),
    tab(1, { url: "https://user:secret@example.test/path" }),
    tab(1, { url: "chrome://settings" }),
  ]) {
    assert.equal(recordContextActivation(context, item, T), false);
    assert.equal(
      recordOpening(context, { ...item, openerTabId: 10 }, source, T),
      false,
    );
    assert.equal(
      rememberGroupingChoice(context, [item, tab(2)], "Private", T),
      false,
    );
  }
  assert.deepEqual(context, createGroupingContext());
});

test("hydration strips arbitrary fields and rejects fabricated broad scope templates", () => {
  const context = hydrateGroupingContext(
    {
      version: 1,
      historyTitles: ["Unrequested page content"],
      choices: [
        {
          at: T,
          name: "Existing",
          urls: [tab(1).url, tab(2).url],
          scopes: ["all-news-domains"],
          pageContent: "Discard",
        },
      ],
      episodes: [
        {
          startedAt: T,
          lastAt: T + MINUTE,
          urls: [tab(1).url, tab(2).url],
          title: "Discard",
        },
      ],
    },
    T + 2 * MINUTE,
  );
  assert.deepEqual(context.choices[0].scopes, []);
  assert.equal(JSON.stringify(context).includes("Discard"), false);
  assert.equal(JSON.stringify(context).includes("Unrequested"), false);
  assert.deepEqual(
    hydrateGroupingContext({ version: 99 }, T),
    createGroupingContext(),
  );
});

test("TTL and future timestamps cannot supply stale or duplicate recurring evidence", () => {
  const context = createGroupingContext(),
    tabs = [tab(1), tab(2)];
  routine(context, tabs);
  rememberGroupingChoice(context, tabs, "A choice", T);
  assert.equal(discoverContextGroups(tabs, context, T + 33 * DAY).length, 1);
  reconcileGroupingContext(context, tabs, T + 91 * DAY);
  assert.equal(context.choices.length, 0);
  assert.equal(context.episodes.length, 0);
  const rawEpisode = {
    startedAt: T,
    lastAt: T + MINUTE,
    urls: tabs.map((item) => item.url),
  };
  const loaded = hydrateGroupingContext(
    {
      version: 1,
      episodes: [
        rawEpisode,
        rawEpisode,
        rawEpisode,
        { ...rawEpisode, lastAt: T + DAY },
      ],
    },
    T + 2 * MINUTE,
  );
  assert.equal(loaded.episodes.length, 1);
  assert.deepEqual(discoverContextGroups(tabs, loaded, T + 2 * MINUTE), []);
});

test("hydrated duplicate opener IDs cannot become duplicate members, and newest confirmed names win", () => {
  const source = createGroupingContext(),
    tabs = openingFamily(source);
  rememberGroupingChoice(source, tabs, "Old", T);
  const raw = JSON.parse(JSON.stringify(source));
  raw.openings.push(raw.openings[0]);
  raw.choices.push({ ...raw.choices[0], name: "Updated", at: T + MINUTE });
  const context = hydrateGroupingContext(raw, T + 2 * MINUTE);
  assert.equal(context.openings.length, 2);
  assert.equal(context.choices.length, 1);
  assert.equal(
    discoverContextGroups(tabs, context, T + 2 * MINUTE)[0].proposedName,
    "Updated",
  );
  assert.equal(
    rememberGroupingChoice(
      context,
      [tabs[0], { ...tabs[1], windowId: 2 }],
      "Cross window",
      T,
    ),
    false,
  );
});

test("persisted context has bounded cardinality and total text size", () => {
  const choices = Array.from({ length: 100 }, (_, i) => ({
    at: T + i,
    name: `Choice ${i}`,
    urls: Array.from(
      { length: 20 },
      (_, j) => `https://source${i}.test/article/${j}/${"x".repeat(500)}`,
    ),
  }));
  const context = hydrateGroupingContext({ version: 1, choices }, T + DAY);
  assert.ok(context.choices.length <= CONTEXT_LIMITS.choices);
  assert.ok(JSON.stringify(context).length <= CONTEXT_LIMITS.textBudget);
  assert.equal(context.choices.at(-1).name, "Choice 99");
});
