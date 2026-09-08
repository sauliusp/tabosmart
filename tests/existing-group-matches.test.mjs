import test from "node:test";
import assert from "node:assert/strict";
import { discoverExistingGroupMatches } from "../extension/existing-group-matches.mjs";

const tab = (id, title, url, extra = {}) => ({
  id,
  title,
  url,
  windowId: 1,
  groupId: -1,
  ...extra,
});
const group = (id = 10, title = "My workspace", windowId = 1) => ({
  id,
  title,
  windowId,
});
const news = () => [
  tab(1, "LRT - Lietuvos naujienos", "https://lrt.lt/", { groupId: 10 }),
  tab(2, "Delfi - naujienos ir žinios", "https://delfi.lt/", { groupId: 10 }),
  tab(3, "Lrytas - naujausios naujienos", "https://lrytas.lt/"),
];
const discover = (tabs, groups = [group()]) =>
  discoverExistingGroupMatches(tabs, groups);

test("one newcomer can join a coherent existing news group using literal metadata", () => {
  const [proposal] = discover(news(), [group(10, "Naujienos")]);
  assert.deepEqual(
    proposal.tabs.map((t) => t.id),
    [3],
  );
  assert.equal(proposal.proposedName, "Naujienos");
  assert.equal(proposal.signal, "existing-group");
  assert.equal(proposal.nameLocked, true);
  assert.match(proposal.title, /Add 1 tab/);
  assert.match(proposal.reason, /Naujienos/);
  assert.match(proposal.reason, /title|metadata|categor/i);
  assert.doesNotMatch(proposal.reason, /you created|you previously grouped/i);
  assert.deepEqual(proposal.targetGroup, {
    id: 10,
    windowId: 1,
    title: "Naujienos",
    members: [
      { id: 1, url: "https://lrt.lt/" },
      { id: 2, url: "https://delfi.lt/" },
    ],
  });
});

test("a category label and bare website brands cannot establish membership", () => {
  const bare = [
    tab(1, "LRT", "https://lrt.lt/", { groupId: 10 }),
    tab(2, "Delfi", "https://delfi.lt/", { groupId: 10 }),
    tab(3, "Lrytas", "https://lrytas.lt/"),
  ];
  assert.deepEqual(discover(bare, [group(10, "Naujienos")]), []);
  assert.deepEqual(discover([...news().slice(0, 2), bare[2]]), []);
});

test("category inheritance requires two references and a coherent whole group", () => {
  assert.deepEqual(discover([news()[0], news()[2]]), []);
  assert.deepEqual(
    discover([
      ...news(),
      tab(4, "Pasta recipes", "https://recipes.example/pasta", { groupId: 10 }),
    ]),
    [],
  );
});

test("a specific repository can match one reference but a different repository cannot", () => {
  const rows = [
    tab(1, "Issue one", "https://github.com/acme/aurora/issues/1", {
      groupId: 10,
    }),
    tab(2, "Pull request", "https://github.com/acme/aurora/pull/2"),
    tab(3, "Issue three", "https://github.com/acme/other/issues/3"),
  ];
  const [proposal] = discover(rows);
  assert.deepEqual(
    proposal.tabs.map((t) => t.id),
    [2],
  );
  assert.match(proposal.reason, /aurora/i);
});

test("mixed repositories and separate Drive resources do not inherit broad host membership", () => {
  const github = [
    tab(1, "One", "https://github.com/acme/one/issues/1", { groupId: 10 }),
    tab(2, "Two", "https://github.com/acme/two/issues/1", { groupId: 10 }),
    tab(3, "Three", "https://github.com/acme/one/pull/3"),
  ];
  assert.deepEqual(discover(github), []);
  const drive = [
    tab(1, "Document", "https://docs.google.com/document/d/one/edit", {
      groupId: 10,
    }),
    tab(2, "Spreadsheet", "https://docs.google.com/spreadsheets/d/two/edit", {
      groupId: 10,
    }),
    tab(3, "Document", "https://docs.google.com/document/d/one/preview"),
  ];
  assert.deepEqual(discover(drive), []);
  assert.deepEqual(
    discover([
      tab(1, "Home", "https://example.test/", { groupId: 10 }),
      tab(2, "Login", "https://example.test/login", { groupId: 10 }),
      tab(3, "Dashboard", "https://example.test/dashboard"),
    ]),
    [],
  );
});

test("shared title words do not override a different explicit workspace resource", () => {
  const rows = [
    tab(
      1,
      "Aurora migration checklist",
      "https://github.com/acme/aurora/issues/1",
      { groupId: 10 },
    ),
    tab(
      2,
      "Aurora migration schedule",
      "https://github.com/acme/aurora/issues/2",
      { groupId: 10 },
    ),
    tab(3, "Aurora migration owners", "https://github.com/acme/other/issues/3"),
  ];
  assert.deepEqual(discover(rows), []);
});

test("specific title anchors must be shared by every reference and each newcomer", () => {
  const rows = [
    tab(1, "Aurora migration checklist", "https://one.test/a", { groupId: 10 }),
    tab(2, "Aurora migration schedule", "https://two.test/b", { groupId: 10 }),
    tab(3, "Aurora migration owners", "https://three.test/c"),
    tab(4, "Aurora skiing forecast", "https://four.test/d"),
  ];
  const [proposal] = discover(rows);
  assert.deepEqual(
    proposal.tabs.map((t) => t.id),
    [3],
  );
  assert.match(proposal.reason, /Aurora/);
  assert.match(proposal.reason, /migration/);
  assert.deepEqual(discover([rows[0], rows[2]]), []);
  assert.deepEqual(
    discover([
      ...rows,
      tab(5, "Unrelated equipment", "https://five.test/e", { groupId: 10 }),
    ]),
    [],
  );
});

test("ambiguous newcomers matching multiple current groups are suppressed", () => {
  const rows = [
    ...news(),
    tab(4, "BBC news", "https://bbc.com/", { groupId: 20 }),
    tab(5, "CNN news", "https://cnn.com/", { groupId: 20 }),
  ];
  assert.deepEqual(
    discover(rows, [group(10, "Naujienos"), group(20, "News")]),
    [],
  );
});

test("target identity captures current exact name and complete member URLs for review validation", () => {
  const rows = news();
  const before = discover(rows, [group(10, "Naujienos")])[0];
  const after = discoverExistingGroupMatches(
    rows,
    [group(10, "Mano naujienos")],
    "en",
  )[0];
  assert.equal(after.proposedName, "Mano naujienos");
  assert.equal(after.targetGroup.title, "Mano naujienos");
  assert.notDeepEqual(before.targetGroup, after.targetGroup);
  rows[0].url = "https://lrt.lt/naujienos";
  const navigated = discover(rows, [group(10, "Naujienos")])[0];
  assert.notDeepEqual(
    navigated.targetGroup.members,
    before.targetGroup.members,
  );
  assert.deepEqual(before.targetGroup.members[0], {
    id: 1,
    url: "https://lrt.lt/",
  });
});

test("matching is deterministic, does not mutate input, and never crosses windows", () => {
  const rows = news();
  const initial = structuredClone(rows);
  assert.deepEqual(discover(rows), discover([...rows].reverse()));
  assert.deepEqual(rows, initial);
  assert.deepEqual(
    discover(rows.map((t) => (t.id === 3 ? { ...t, windowId: 2 } : t))),
    [],
  );
  assert.deepEqual(discover(rows, [group(10, "News", 2)]), []);
  assert.deepEqual(discover(rows, []), []);
});

test("protected, pinned, audible, private, grouped and non-web newcomers are ineligible", () => {
  for (const extra of [
    { protected: true },
    { pinned: true },
    { audible: true },
    { incognito: true },
    { groupId: 30 },
    { url: "chrome://newtab" },
    { url: "https://user:password@lrytas.lt/" },
  ]) {
    const rows = news();
    rows[2] = { ...rows[2], ...extra };
    assert.deepEqual(discover(rows), [], JSON.stringify(extra));
  }
  const rows = news();
  rows[0].incognito = true;
  assert.deepEqual(discover(rows), []);
});

test("oversized targets are skipped without truncating the members used for coherence", () => {
  const rows = Array.from({ length: 257 }, (_, index) =>
    tab(index + 1, "Local news", `https://source-${index}.test/`, {
      groupId: 10,
    }),
  );
  rows.push(tab(300, "World news", "https://new-source.test/"));
  assert.deepEqual(discover(rows), []);
});
