import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canGroupWholeSite,
  categoryEvidence,
  discoverStructuredGroups,
  resourceScope,
  scopeAwareTitleGroups,
} from "../extension/metadata-groups.mjs";

const tab = (id, title, url = `https://unfamiliar${id}.test/`, extra = {}) => ({
  id,
  title,
  url,
  windowId: 1,
  groupId: -1,
  ...extra,
});
const memberIds = (groups) =>
  groups.map((group) => group.tabs.map((item) => item.id));

test("stored Lithuanian news homepage titles group immediately without publisher knowledge", () => {
  const pages = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/public-news-metadata.json", import.meta.url),
    ),
  ).pages;
  const tabs = pages
    .slice(0, 4)
    .map((page, i) => tab(i + 1, page.title || "Alfa.lt", page.url));
  const result = discoverStructuredGroups(tabs);
  assert.deepEqual(memberIds(result), [[1, 2, 4]]);
  assert.equal(result[0].proposedName, "Naujienos");
  assert.equal(result[0].signal, "category");
  assert.match(result[0].reason, /category clue.*titles/);
  assert.deepEqual(
    discoverStructuredGroups(
      tabs.map((item) => ({ ...item, title: new URL(item.url).hostname })),
    ),
    [],
  );
});

test("category recognition works on unfamiliar domains and across languages", () => {
  const titles = [
    "Naujausios naujienos Lietuvoje",
    "Breaking news today",
    "Wiadomości z Polski",
    "Aktuelle Nachrichten",
    "Actualités en France",
    "Noticias del mundo",
    "Останні новини",
    "最新ニュース",
  ];
  const result = discoverStructuredGroups(
    titles.map((title, i) => tab(i + 1, title)),
  );
  assert.deepEqual(memberIds(result), [titles.map((_, i) => i + 1)]);
  assert.equal(
    discoverStructuredGroups(
      titles.map((title, i) => tab(i + 1, title)),
      "pl",
    )[0].proposedName,
    "Wiadomości",
  );
});

test("category words inside reference pages and tutorial titles do not imply a category", () => {
  const tabs = [
    tab(1, "News", "https://en.wikipedia.org/wiki/News"),
    tab(2, "How to build a news website", "https://builder.test/"),
    tab(
      3,
      "News typography tutorial",
      "https://design.test/articles/news-typography",
    ),
    tab(4, "News App API", "https://developer.test/products/news-app"),
    tab(5, "Generic headline mentioning news", "https://misc.test/article/123"),
    tab(6, "Newest update official site"),
  ];
  assert.deepEqual(discoverStructuredGroups(tabs), []);
});

test("explicit category sections support article tabs without pretending to read contents", () => {
  const tabs = [
    tab(1, "A local election result", "https://a.test/en/news/election"),
    tab(2, "A weather headline", "https://b.test/naujienos/orai"),
    tab(3, "Another headline | News | Example", "https://c.test/story/42"),
    tab(4, "Website builds improve", "https://d.test/articles/news-website"),
  ];
  const result = discoverStructuredGroups(tabs);
  assert.deepEqual(memberIds(result), [[1, 2, 3]]);
  assert.match(result[0].reason, /titles or URL sections/);
});

test("recipe and accommodation clues stay separate from news and mixed directories", () => {
  const tabs = [
    tab(1, "Receptai kiekvienai dienai"),
    tab(2, "Recipes and cooking"),
    tab(3, "Hotels in Rome"),
    tab(4, "Viešbučiai Vilniuje"),
    tab(5, "News and recipes and hotels"),
  ];
  assert.deepEqual(memberIds(discoverStructuredGroups(tabs)), [
    [1, 2],
    [3, 4],
  ]);
});

test("repository scopes separate projects on one host and preserve owners", () => {
  const tabs = [
    tab(1, "Issue", "https://github.com/acme/portal/issues/12"),
    tab(2, "Code", "https://github.com/acme/portal/tree/main?utm_source=mail"),
    tab(3, "Issue", "https://github.com/acme/catalog/issues/12"),
    tab(4, "Code", "https://github.com/acme/catalog/blob/main/readme.md"),
    tab(5, "Fork", "https://github.com/other/portal"),
    tab(6, "Search", "https://github.com/search?q=portal"),
  ];
  const result = discoverStructuredGroups(tabs);
  assert.deepEqual(memberIds(result), [
    [1, 2],
    [3, 4],
  ]);
  assert.equal(result[0].signal, "workspace");
  assert.equal(result[0].proposedName, "Acme/portal");
  assert.notEqual(resourceScope(tabs[0]).key, resourceScope(tabs[4]).key);
  assert.equal(resourceScope(tabs[5]), null);
});

test("explicit project and product paths work on unfamiliar domains", () => {
  const tabs = [
    tab(
      1,
      "Budget",
      "https://unknown.test/team/acme/projects/azuolu-slenis/budget",
    ),
    tab(
      2,
      "Plans",
      "https://unknown.test/team/acme/projects/azuolu-slenis/plans#latest",
    ),
    tab(
      3,
      "Other",
      "https://unknown.test/team/other/projects/azuolu-slenis/plans",
    ),
    tab(4, "Camera", "https://shop.test/products/camera-x/specifications"),
    tab(5, "Reviews", "https://shop.test/products/camera-x/reviews"),
    tab(
      6,
      "Project on another host",
      "https://other.test/team/acme/projects/azuolu-slenis/budget",
    ),
  ];
  assert.deepEqual(memberIds(discoverStructuredGroups(tabs)), [
    [1, 2],
    [4, 5],
  ]);
  assert.equal(resourceScope(tabs[0]).kind, "project");
  assert.equal(resourceScope(tabs[3]).kind, "product");
});

test("generic slugs numeric paths tracking and global app routes do not invent workspaces", () => {
  for (const url of [
    "https://unknown.test/article/123",
    "https://unknown.test/london/hotels",
    "https://unknown.test/projects/123",
    "https://unknown.test/projects/new",
    "https://unknown.test/projects/abcde123-1234-abcd-7890-123456abcdef",
    "https://unknown.test/?project=client",
    "https://github.com/settings/profile",
    "https://drive.google.com/drive/my-drive",
    "https://docs.google.com/document/u/0/",
    "https://unknown.test/projects/abcdefghijklmnopqrstuvwxyz1234567890%2Fother",
    "https://user:password@unknown.test/projects/client",
    "chrome://newtab/",
  ])
    assert.equal(resourceScope({ url }), null, url);
});

test("precise document identities are distinct from the whole Drive host", () => {
  const a = resourceScope({
    url: "https://docs.google.com/document/d/1LongOpaqueDocumentID123/edit",
  });
  const b = resourceScope({
    url: "https://docs.google.com/document/d/1LongOpaqueDocumentID123/preview",
  });
  const c = resourceScope({
    url: "https://docs.google.com/document/d/2OtherDocumentID123/edit",
  });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
  assert.equal(a.kind, "document");
  const publishedA = resourceScope({
    url: "https://docs.google.com/forms/d/e/published-form-one/viewform",
  });
  const publishedB = resourceScope({
    url: "https://docs.google.com/forms/d/e/published-form-two/viewform",
  });
  assert.notEqual(publishedA.key, publishedB.key);
});

test("broad site fallback is withheld for unrelated workspaces and app indexes", () => {
  assert.equal(
    canGroupWholeSite([
      tab(1, "Repo", "https://github.com/acme/one"),
      tab(2, "Repo", "https://github.com/acme/two"),
    ]),
    false,
  );
  assert.equal(
    canGroupWholeSite([
      tab(1, "Drive", "https://drive.google.com/drive/my-drive"),
    ]),
    false,
  );
  assert.equal(
    canGroupWholeSite([
      tab(1, "Project", "https://unknown.test/projects/one"),
      tab(2, "Project", "https://unknown.test/projects/two"),
    ]),
    false,
  );
  assert.equal(
    canGroupWholeSite([
      tab(1, "Article", "https://publisher.test/article/123"),
    ]),
    true,
  );
  assert.equal(canGroupWholeSite([]), false);
});

test("exported category evidence supplies direct per-tab clues for existing groups", () => {
  const [evidence] = categoryEvidence(tab(1, "Naujienos Lietuvoje"));
  assert.equal(evidence.key, "news");
  assert.equal(evidence.label, "News");
  assert.equal(evidence.category.names.lt, "Naujienos");
  assert.equal(evidence.cue, "naujienos");
  assert.deepEqual(
    categoryEvidence(tab(1, "News", "https://unknown.test/projects/news")),
    [],
  );
});

test("precise URL workspaces precede broad categories without shared members", () => {
  const result = discoverStructuredGroups([
    tab(1, "News", "https://host.test/projects/launch/docs"),
    tab(2, "News", "https://host.test/projects/launch/plan"),
    tab(3, "Latest news"),
    tab(4, "Breaking news"),
  ]);
  assert.deepEqual(memberIds(result), [
    [1, 2],
    [3, 4],
  ]);
  assert.ok(result[0].priority > result[1].priority);
});

test("each proposal respects eligibility windows and duplicate tab IDs", () => {
  const tabs = [tab(1, "News"), tab(2, "News")];
  for (const extra of [
    { pinned: true },
    { audible: true },
    { protected: true },
    { incognito: true },
    { groupId: 4 },
    { windowId: 2 },
    { url: "chrome://newtab" },
  ])
    assert.deepEqual(
      discoverStructuredGroups([{ ...tabs[0], ...extra }, tabs[1]]),
      [],
    );
  assert.deepEqual(memberIds(discoverStructuredGroups([...tabs, tabs[1]])), [
    [1, 2],
  ]);
});

test("a thousand tabs are indexed into coherent sets deterministically", () => {
  const tabs = Array.from({ length: 1000 }, (_, i) =>
    tab(
      i + 1,
      "News",
      `https://host.test/projects/project-${Math.floor(i / 5)}/item/${i}`,
    ),
  );
  const result = discoverStructuredGroups(tabs);
  assert.equal(result.length, 200);
  assert.ok(
    result.every(
      (group) => group.tabs.length === 5 && group.signal === "workspace",
    ),
  );
  assert.deepEqual(
    memberIds(discoverStructuredGroups([...tabs].reverse())),
    memberIds(result),
  );
});

test("different repository owners and routes do not become shared title topics", () => {
  assert.deepEqual(
    scopeAwareTitleGroups([
      tab(
        1,
        "Issues · acme/alpha · GitHub",
        "https://github.com/acme/alpha/issues",
      ),
      tab(
        2,
        "Issues · acme/beta · GitHub",
        "https://github.com/acme/beta/issues",
      ),
    ]),
    [],
  );
  assert.deepEqual(
    scopeAwareTitleGroups([
      tab(
        1,
        "Issue · acme/alpha · GitHub",
        "https://github.com/acme/alpha/issues/1",
      ),
      tab(
        2,
        "Issue · acme/beta · GitHub",
        "https://github.com/acme/beta/issues/2",
      ),
    ]),
    [],
  );
  assert.deepEqual(
    scopeAwareTitleGroups([
      tab(
        1,
        "Issues · acme/alpha · GitHub",
        "https://github.com/acme/alpha/issues",
      ),
      tab(
        2,
        "Issues · acme/beta · GitHub",
        "https://github.com/acme/beta/issues",
      ),
      tab(3, "Issues acme", "https://other.test/"),
    ]),
    [],
  );
});

test("cross-repository topic names and explanations use only the remaining literal anchors", () => {
  const tabs = [
    tab(
      1,
      "Issues · acme/alpha · Authentication redesign · GitHub",
      "https://github.com/acme/alpha/issues",
    ),
    tab(
      2,
      "Issues · acme/beta · Authentication redesign · GitHub",
      "https://github.com/acme/beta/issues",
    ),
  ];
  const [proposal] = scopeAwareTitleGroups(tabs);
  assert.deepEqual(proposal.anchors, ["authentication", "redesign"]);
  assert.equal(proposal.proposedName, "Authentication redesign");
  assert.equal(proposal.title, "Bring Authentication redesign together");
  assert.match(proposal.reason, /“Authentication” and “redesign”/);
  assert.doesNotMatch(proposal.reason, /Issues|acme/);
  assert.deepEqual(scopeAwareTitleGroups([...tabs].reverse()), [proposal]);
  assert.deepEqual(memberIds([proposal]), [[1, 2]]);
});

test("two genuine title anchors can link different documents without inheriting their URL routes", () => {
  const [proposal] = scopeAwareTitleGroups([
    tab(
      1,
      "Authentication redesign - Google Docs",
      "https://docs.google.com/document/d/alpha/edit",
    ),
    tab(
      2,
      "Authentication redesign - Google Docs",
      "https://docs.google.com/document/d/beta/edit",
    ),
  ]);
  assert.equal(proposal.proposedName, "Authentication redesign");
  assert.deepEqual(proposal.anchors, ["authentication", "redesign"]);
});

test("one topic word plus a workspace owner cannot bridge different projects", () => {
  assert.deepEqual(
    scopeAwareTitleGroups([
      tab(
        1,
        "Acme Authentication",
        "https://work.test/teams/acme/projects/alpha",
      ),
      tab(
        2,
        "Acme Authentication",
        "https://work.test/teams/acme/projects/beta",
      ),
    ]),
    [],
  );
});

test("ordinary cross-site titles preserve literal evidence without scope filtering", () => {
  const [proposal] = scopeAwareTitleGroups([
    tab(1, "Vilnius wooden bridges", "https://one.test/bridges"),
    tab(2, "Vilnius wooden bridges", "https://two.test/bridges"),
  ]);
  assert.equal(proposal.proposedName, "Vilnius wooden bridges");
  assert.deepEqual(proposal.anchors, ["bridges", "vilnius", "wooden"]);
  assert.match(proposal.reason, /“Vilnius” and “wooden”/);
});

test("scope-aware title proposals preserve eligibility and window boundaries", () => {
  const tabs = [
    tab(1, "Authentication redesign", "https://github.com/acme/alpha/issues"),
    tab(2, "Authentication redesign", "https://github.com/acme/beta/issues"),
  ];
  for (const extra of [
    { pinned: true },
    { audible: true },
    { protected: true },
    { incognito: true },
    { groupId: 2 },
    { windowId: 2 },
  ])
    assert.deepEqual(
      scopeAwareTitleGroups([{ ...tabs[0], ...extra }, tabs[1]]),
      [],
    );
});
