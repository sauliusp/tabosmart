import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createState,
  observeTabs,
  makeSnapshot,
  fingerprint,
  sanitizeSettings,
  hydrateState,
} from "../extension/core.mjs";
import {
  discoverMetadataGroups,
  namingPlan,
  titleLanguage,
} from "../extension/topic-evidence.mjs";
const T = 1800000000000;
const tab = (id, title, url = `https://source${id}.test/`, extra = {}) => ({
  id,
  title,
  url,
  windowId: 1,
  groupId: -1,
  pinned: false,
  audible: false,
  active: false,
  incognito: false,
  ...extra,
});
const publicPages = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/public-news-metadata.json", import.meta.url),
  ),
).pages;
const portals = () =>
  publicPages
    .slice(0, 4)
    .map((p, i) => tab(i + 1, p.title || "Alfa.lt", p.url));
function snapshot(tabs, patch = {}, facts = {}) {
  const s = createState(T);
  s.settings = { ...s.settings, enabled: true, ...patch };
  observeTabs(s, tabs, T);
  return { s, result: makeSnapshot(s, tabs, T, facts) };
}

test("public news titles support a category while opaque portal brands do not", () => {
  const groups = snapshot(portals()).result.suggestions;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].signal, "category");
  assert.deepEqual(groups[0].tabIds, [1, 2, 4]);
  assert.equal(groups[0].proposedName, "Naujienos");
  assert.equal(
    snapshot(portals().map((t) => ({ ...t, title: new URL(t.url).hostname })))
      .result.suggestions.length,
    0,
  );
});
test("unfamiliar domains and uncatalogued subjects group through real Unicode anchors", () => {
  const tabs = [
    tab(1, "Zephyr acoustic metamaterials experiments"),
    tab(2, "Zephyr acoustic metamaterials fabrication"),
    tab(3, "Zephyr acoustic metamaterials measurements"),
  ];
  const { s, result } = snapshot(tabs);
  assert.deepEqual(result.suggestions[0].tabIds, [1, 2, 3]);
  assert.equal(result.suggestions[0].signal, "title");
  s.dismissed[result.suggestions[0].fingerprint] = T;
  assert.equal(makeSnapshot(s, tabs, T).suggestions.length, 0);
});
test("generic words never manufacture relationships across arbitrary domains", () => {
  const tabs = [
    tab(1, "Latest update official website"),
    tab(2, "New page home dashboard"),
    tab(3, "Aktuelle Seite mehr lesen"),
    tab(4, "Accueil nouvelles lire plus"),
  ];
  assert.equal(snapshot(tabs).result.suggestions.length, 0);
});
test("lexical groups retain native protections windows and history ranking", () => {
  const tabs = [
    tab(1, "Zephyr acoustic materials"),
    tab(2, "Zephyr acoustic experiments"),
    tab(3, "Zephyr acoustic measurements"),
  ];
  for (const extra of [
    { pinned: true },
    { audible: true },
    { incognito: true },
    { groupId: 7 },
    { windowId: 2 },
  ]) {
    assert.deepEqual(
      snapshot([{ ...tabs[0], ...extra }, ...tabs.slice(1)]).result
        .suggestions[0].tabIds,
      [2, 3],
    );
  }
  const { s } = snapshot(tabs);
  s.protectedUrls[tabs[0].url] = T;
  assert.deepEqual(makeSnapshot(s, tabs, T).suggestions[0].tabIds, [2, 3]);
  const facts = {
    [tabs[0].url]: { visits: 20, recentVisits: 10, lastVisitTime: T - 1 },
  };
  assert.match(
    snapshot(tabs, {}, facts).result.suggestions[0].historyReason,
    /20 available browser visits/,
  );
});
test("language policy is explicit and does not depend on a country suffix", () => {
  assert.equal(namingPlan(portals()).modelEligible, false);
  const tabs = [
    tab(1, "The materials for your project", "https://a.lt/"),
    tab(2, "How the project works", "https://b.lt/"),
  ];
  assert.equal(namingPlan(tabs).language, "en");
  assert.equal(namingPlan(tabs, "lt").modelEligible, false);
  assert.equal(namingPlan(tabs, "de").language, "de");
  assert.equal(titleLanguage("日本のニュースと料理"), "ja");
  assert.equal(titleLanguage("Новости и политика"), "unsupported");
});
test("Unicode matching preserves Lithuanian accented project words and gathers the whole coherent cluster", () => {
  const tabs = [
    tab(1, "Ąžuolų slėnis statybų planai"),
    tab(2, "Ąžuolų slėnis biudžetas"),
    tab(3, "Ąžuolų slėnis medžiagos"),
    tab(4, "Visai kitas projektas"),
  ];
  const g = snapshot(tabs).result.suggestions[0];
  assert.deepEqual(g.tabIds, [1, 2, 3]);
  assert.match(g.proposedName, /Ąžuolų slėnis/);
  assert.match(g.reason, /Ąžuolų/);
});
test("accent normalization matches decomposed text without displaying broken ASCII fragments", () => {
  const tabs = [
    tab(1, "Ąžuolų slėnis projektas"),
    tab(2, "Ąžuolų slėnis darbai".normalize("NFD")),
  ];
  const g = snapshot(tabs).result.suggestions[0];
  assert.deepEqual(g.tabIds, [1, 2]);
  assert.match(g.proposedName, /Ąžuolų/);
});
test("Japanese title segmentation works without spaces or English tokens", () => {
  const tabs = [
    tab(1, "京都旅行計画"),
    tab(2, "京都旅行予約"),
    tab(3, "京都旅行写真"),
  ];
  const groups = snapshot(tabs).result.suggestions;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tabIds, [1, 2, 3]);
  assert.match(groups[0].proposedName, /京都/);
});
test("coherent title clusters do not grow through a transitive chain", () => {
  const tabs = [
    tab(1, "Aurora telescope mirror"),
    tab(2, "Aurora telescope optics"),
    tab(3, "Telescope optics camera"),
    tab(4, "Optics camera sensor"),
  ];
  const groups = snapshot(tabs).result.suggestions;
  assert.ok(groups.every((g) => g.tabIds.length < 4));
  assert.ok(!groups.some((g) => g.tabIds.includes(1) && g.tabIds.includes(4)));
});
test("valid naming preferences persist while invalid and prototype names are rejected", () => {
  let settings = sanitizeSettings({ groupNameLanguage: "lt" });
  assert.equal(settings.groupNameLanguage, "lt");
  assert.equal(
    hydrateState({ version: 1, settings }, T).settings.groupNameLanguage,
    "lt",
  );
  for (const choice of ["xx", "toString", "__proto__", null, {}])
    assert.equal(
      sanitizeSettings({ groupNameLanguage: choice }, settings)
        .groupNameLanguage,
      "lt",
    );
});
test("one-word same-site evidence remains separate across hosts in one window", () => {
  const tabs = [
    tab(1, "Alpha studio basalt", "https://alpha.test/plans"),
    tab(2, "Alpha studio linen", "https://alpha.test/materials"),
    tab(3, "Beta studio mango", "https://beta.test/plans"),
    tab(4, "Beta studio cobalt", "https://beta.test/materials"),
  ];
  const groups = snapshot(tabs).result.suggestions;
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((g) => g.tabIds),
    [
      [1, 2],
      [3, 4],
    ],
  );
});
