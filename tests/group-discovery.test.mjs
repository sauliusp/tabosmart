import test from "node:test";
import assert from "node:assert/strict";
import {
  discoveryKey,
  discoveryBatches,
  discoveryMetadata,
  validateDiscoveredGroups,
  validateDiscoveryHints,
} from "../extension/group-discovery.mjs";
import { createState, observeTabs, makeSnapshot } from "../extension/core.mjs";
import { createProactiveDiscovery } from "../extension/proactive-discovery.mjs";
const T = 1800000000000;
const tab = (id, title, extra = {}) => ({
  id,
  title,
  url: `https://unseen-${id}.test/private?secret=value`,
  windowId: 1,
  groupId: -1,
  ...extra,
});
const tabs = [
  tab(1, "Restoring a vintage theremin oscillator"),
  tab(2, "Repairing heterodyne pitch circuitry"),
  tab(3, "Electrodes for contactless musical instruments"),
];
const group = {
  name: "Theremin restoration",
  relationship: "task",
  members: tabs.map((t) => ({ id: t.id, evidence: t.title })),
};
const snap = (items = tabs) => ({
  tabs: items,
  suggestions: [],
  now: T,
  settings: { enabled: true, aiEnabled: true, groupNameLanguage: "auto" },
});
const context = { enabled: true, available: true, visible: true };
const tick = () => new Promise((r) => setTimeout(r, 10));
test("held-out unfamiliar topic can become a new AI proposal without a lexical candidate", () => {
  const state = createState(T);
  state.settings.enabled = true;
  observeTabs(state, tabs, T);
  assert.equal(makeSnapshot(state, tabs, T).suggestions.length, 0);
  const s = makeSnapshot(state, tabs, T, {}, [group]);
  assert.deepEqual(s.suggestions[0].tabIds, [1, 2, 3]);
  assert.equal(s.suggestions[0].aiDiscovered, true);
  assert.match(s.suggestions[0].reason, /inferred relationship/);
  state.dismissed[s.suggestions[0].fingerprint] = T;
  assert.equal(makeSnapshot(state, tabs, T, {}, [group]).suggestions.length, 0);
});
test("mixed-language subject uses real title evidence without a category dictionary", () => {
  const mixed = [
    tab(1, "The theremin oscillator restoration"),
    tab(2, "Kontaktloses Musikinstrument mit Antennen"),
    tab(3, "Réparer le circuit hétérodyne avec précision"),
  ];
  const g = {
    ...group,
    members: mixed.map((t) => ({ id: t.id, evidence: t.title })),
  };
  assert.equal(validateDiscoveredGroups([g], mixed).length, 1);
  assert.equal(discoveryBatches(snap(mixed)).flat().length, 3);
});
test("structured output rejects invented IDs evidence duplicate members and hostile labels", () => {
  for (const mutate of [
    (g) => (g.members[0].id = 999),
    (g) => (g.members[0].evidence = "invented proof"),
    (g) => (g.members[1].id = 1),
    (g) => (g.name = "<script>alert</script>"),
    (g) => (g.relationship = "urgent"),
  ]) {
    const g = structuredClone(group);
    mutate(g);
    assert.deepEqual(validateDiscoveredGroups([g], tabs), []);
  }
});
test("generic words and brand-only titles cannot support model world-knowledge guesses", () => {
  const bare = [
    tab(1, "Delfi.lt", { url: "https://delfi.lt/" }),
    tab(2, "Lrytas.lt", { url: "https://lrytas.lt/" }),
  ];
  const g = {
    ...group,
    name: "News",
    members: bare.map((t) => ({ id: t.id, evidence: t.title })),
  };
  assert.deepEqual(validateDiscoveredGroups([g], bare), []);
  const generic = [tab(1, "Latest news home"), tab(2, "Latest news home")];
  assert.deepEqual(
    validateDiscoveredGroups(
      [
        {
          ...g,
          members: generic.map((t) => ({ id: t.id, evidence: t.title })),
        },
      ],
      generic,
    ),
    [],
  );
});
test("protected private existing-group and cross-window members invalidate whole proposals", () => {
  for (const extra of [
    { protected: true },
    { pinned: true },
    { audible: true },
    { incognito: true },
    { groupId: 8 },
    { windowId: 2 },
  ]) {
    assert.deepEqual(
      validateDiscoveredGroups(
        [group],
        [{ ...tabs[0], ...extra }, ...tabs.slice(1)],
      ),
      [],
    );
  }
});
test("model payload is bounded and excludes raw URLs paths query history and arbitrary context", () => {
  const data = discoveryMetadata(
    tabs.map((t) => ({
      ...t,
      title: t.title.repeat(20),
      history: ["secret"],
      pageBody: "secret",
    })),
    T,
  );
  assert(data.every((t) => t.title.length <= 160));
  assert.doesNotMatch(JSON.stringify(data), /private|secret|pageBody|history/);
  assert.equal(
    discoveryMetadata(
      Array.from({ length: 25 }, (_, i) => tab(i, "Distinct title")),
    ),
    null,
  );
});
test("batch planning is bounded by 24 and excludes deterministic groups and unsupported languages", () => {
  const s = snap(
    Array.from({ length: 60 }, (_, i) =>
      tab(i, `The instrument component ${i}`),
    ),
  );
  s.suggestions = [{ type: "group", tabIds: [0, 1] }];
  const batches = discoveryBatches(s);
  assert.deepEqual(
    batches.map((t) => t.length),
    [24, 24, 10],
  );
  assert(!batches.flat().some((t) => t.id === 0 || t.id === 1));
  assert.equal(
    discoveryBatches(
      snap([
        tab(1, "Ąžuolų slėnio įrengimas"),
        tab(2, "Naujienų portalas Lietuvoje"),
      ]),
    ).length,
    0,
  );
});
test("cache identity follows metadata protection and language changes not superficial ordering", () => {
  const s = snap();
  assert.equal(discoveryKey(s), discoveryKey(snap([...tabs].reverse())));
  for (const extra of [
    { title: "changed" },
    { url: "https://changed.test/" },
    { protected: true },
    { groupId: 2 },
  ])
    assert.notEqual(
      discoveryKey(s),
      discoveryKey(snap([{ ...tabs[0], ...extra }, ...tabs.slice(1)])),
    );
  assert.notEqual(
    discoveryKey(s),
    discoveryKey({
      ...s,
      settings: { ...s.settings, groupNameLanguage: "de" },
    }),
  );
});
test("discovery yields initial results immediately and publishes only after completion", async () => {
  let resolve,
    calls = 0;
  const published = [];
  const c = createProactiveDiscovery({
    settleMs: 0,
    cooldownMs: 10,
    generate: () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
    publish: async (p) => published.push(p),
  });
  c.sync(snap(), context);
  assert.equal(calls, 0);
  assert.equal(published.length, 0);
  await tick();
  assert.equal(calls, 1);
  resolve([group]);
  await tick();
  assert.equal(published.length, 1);
  c.sync(snap(), context);
  await tick();
  assert.equal(calls, 1);
  c.stop();
});
test("changed tabs and an opened review abort work and suppress stale proposals", async () => {
  for (const mode of ["changed", "review", "off", "hidden"]) {
    let resolve, signal;
    const published = [];
    const c = createProactiveDiscovery({
      settleMs: 0,
      cooldownMs: 10,
      generate: (_, o) => {
        signal = o.signal;
        return new Promise((r) => (resolve = r));
      },
      publish: async (p) => published.push(p),
    });
    c.sync(snap(), context);
    await tick();
    if (mode === "changed")
      c.sync(snap([{ ...tabs[0], title: "Changed" }, ...tabs.slice(1)]), {
        ...context,
        visible: false,
      });
    else
      c.sync(snap(), {
        ...context,
        reviewing: mode === "review",
        enabled: mode !== "off",
        visible: mode !== "hidden",
      });
    assert.equal(signal.aborted, true);
    resolve([group]);
    await tick();
    assert.equal(published.length, 0);
    c.reset();
  }
});
test("all eligible batches continue automatically after bounded pass cooldowns", async () => {
  let calls = 0,
    active = 0,
    max = 0,
    last;
  const c = createProactiveDiscovery({
    settleMs: 0,
    cooldownMs: 10,
    generate: async () => {
      calls++;
      active++;
      max = Math.max(max, active);
      await tick();
      active--;
      return [];
    },
    onActivity: (v) => (last = v),
  });
  c.sync(
    snap(
      Array.from({ length: 100 }, (_, i) =>
        tab(i, `The instrument component ${i}`),
      ),
    ),
    context,
  );
  for (let i = 0; i < 16; i++) await tick();
  assert.equal(calls, 5);
  assert.equal(max, 1);
  assert.equal(last.more, false);
  c.reset();
});

test("semantic hints connect related unfamiliar tabs separated across a hundred-tab inventory", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) =>
    tab(i, `Distinct component ${i}`),
  );
  const special = [1, 51, 99];
  special.forEach((id, i) => (hundred[id].title = tabs[i].title));
  const publications = [];
  let calls = 0;
  const c = createProactiveDiscovery({
    settleMs: 0,
    cooldownMs: 1,
    generate: async (batch, options) => {
      calls++;
      options.onHints(
        batch.map((t) => ({
          id: t.id,
          concept: special.includes(t.id)
            ? "Theremin restoration"
            : `Unfamiliar${t.id}`,
          evidence: t.title,
        })),
      );
      return special.every((id) => batch.some((t) => t.id === id))
        ? [
            {
              ...group,
              members: special.map((id) => ({
                id,
                evidence: hundred[id].title,
              })),
            },
          ]
        : [];
    },
    publish: async (p) => publications.push(p),
  });
  c.sync(snap(hundred), context);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(calls, 6);
  assert.equal(publications.length, 1);
  assert.deepEqual(
    publications[0].groups[0].members.map((m) => m.id),
    special,
  );
  c.reset();
});
test("cross-batch hints reject invented evidence and generic concepts", () => {
  const hints = [
    { id: 1, concept: "Theremin restoration", evidence: tabs[0].title },
  ];
  assert.equal(validateDiscoveryHints(hints, tabs).length, 1);
  for (const patch of [
    { id: 999 },
    { evidence: "Invented quote" },
    { concept: "Research notes" },
  ])
    assert.deepEqual(
      validateDiscoveryHints([{ ...hints[0], ...patch }], tabs),
      [],
    );
});

test("an interrupted batch resumes automatically when the review closes", async () => {
  let resolve,
    calls = 0;
  const published = [];
  const controller = createProactiveDiscovery({
    settleMs: 0,
    cooldownMs: 1,
    generate: async () => {
      calls++;
      return calls === 1
        ? new Promise((r) => {
            resolve = r;
          })
        : [group];
    },
    publish: async (result) => published.push(result),
  });
  controller.sync(snap(), context);
  await tick();
  controller.sync(snap(), { ...context, reviewing: true });
  resolve([group]);
  await tick();
  assert.equal(published.length, 0);
  controller.sync(snap(), context);
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.equal(published.length, 1);
  controller.reset();
});
