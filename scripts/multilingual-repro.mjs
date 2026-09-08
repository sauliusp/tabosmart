import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import * as current from "../extension/core.mjs";
import * as previous from "../qa/releases/1.3.0/source/core.mjs";
const root = path.resolve(import.meta.dirname, "..");
const pages = JSON.parse(
  await fs.readFile(
    path.join(root, "tests/fixtures/public-news-metadata.json"),
    "utf8",
  ),
).pages;
const tabs = pages.slice(0, 4).map((p, i) => ({
  id: i + 1,
  url: p.url,
  title: p.title || "Alfa.lt",
  windowId: 1,
  groupId: -1,
  active: false,
  pinned: false,
  audible: false,
  incognito: false,
}));
const now = Date.now();
const run = (core, input) => {
  const state = core.createState(now);
  state.settings.enabled = true;
  core.observeTabs(state, input, now);
  return { snapshot: () => core.makeSnapshot(state, input, now) };
};
const before = run(previous, tabs).snapshot(),
  after = run(current, tabs).snapshot();
if (
  before.suggestions.length !== 0 ||
  after.suggestions.length !== 1 ||
  after.suggestions[0].signal !== "category" ||
  JSON.stringify(after.suggestions[0].tabIds) !== "[1,2,4]"
)
  throw Error(
    "Expected three news titles to group without including the opaque brand",
  );
const novel = [
  {
    ...tabs[0],
    url: "https://unseen-a.test/",
    title: "Restoring a vintage theremin oscillator",
  },
  {
    ...tabs[1],
    url: "https://unseen-b.test/",
    title: "Repairing heterodyne pitch circuitry",
  },
  {
    ...tabs[2],
    url: "https://unseen-c.test/",
    title: "Electrodes for contactless musical instruments",
  },
];
const novelState = current.createState(now);
novelState.settings.enabled = true;
current.observeTabs(novelState, novel, now);
const mockGroup = {
  name: "Theremin restoration",
  relationship: "task",
  members: novel.map((t) => ({ id: t.id, evidence: t.title })),
};
const deterministic = current.makeSnapshot(novelState, novel, now),
  enriched = current.makeSnapshot(novelState, novel, now, {}, [mockGroup]);
if (deterministic.suggestions.length || enriched.suggestions.length !== 1)
  throw Error("General discovery fixture failed");
const timings = [];
for (const count of [100, 500, 1000]) {
  const input = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    url: `https://source${i}.test/page`,
    title: `Project${i} Architectural${i} notes`,
    windowId: 1,
    groupId: -1,
  }));
  for (const [version, core] of [
    ["1.3.0", previous],
    ["1.4.0", current],
  ]) {
    const fixture = run(core, input),
      values = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      fixture.snapshot();
      values.push(performance.now() - start);
    }
    const warm = values.slice(1).sort((a, b) => a - b);
    timings.push({
      version,
      tabs: count,
      firstDatasetScanMs: Math.round(values[0] * 100) / 100,
      warmMedianMs: Math.round(warm[2] * 100) / 100,
      warmMaxMs: Math.round(warm[4] * 100) / 100,
    });
  }
}
const sources = [
  "core.mjs",
  "metadata-groups.mjs",
  "grouping-context.mjs",
  "existing-group-matches.mjs",
  "topic-evidence.mjs",
  "group-discovery.mjs",
  "proactive-discovery.mjs",
  "local-ai.mjs",
  "proactive-names.mjs",
];
const report = {
  version: "1.4.0",
  checkedAt: new Date().toISOString(),
  boundary:
    "Node source-only reproduction with public title references and a user-supplied Alfa.lt brand fallback because its public fetch returned403. Actual user tab titles/windows/protection/group flags were not inspected. Timings are synthetic metadata scans on this development machine, not Chrome/AI/translation latency, battery or memory benchmarks.",
  fixture: "tests/fixtures/public-news-metadata.json",
  before: {
    version: "1.3.0",
    suggestions: before.suggestions.length,
    source: "qa/releases/1.3.0/source/core.mjs",
  },
  after: {
    version: "1.4.0",
    suggestions: after.suggestions.length,
    groupedIDs: after.suggestions[0].tabIds,
    name: after.suggestions[0].proposedName,
    limitation:
      "Three informative news titles group through local category cues. Opaque Alfa title remains uncertain; Lithuanian AI discovery still uses the existing unsupported-language fallback.",
  },
  heldOutSynthetic: {
    initialGroups: deterministic.suggestions.length,
    enrichedGroups: enriched.suggestions.length,
    name: enriched.suggestions[0].proposedName,
    tabIds: enriched.suggestions[0].tabIds,
    method:
      "Synthetic validated model output supplied to the actual core. No real model-quality claim.",
  },
  metadataScanTimings: timings,
  translation: { implemented: false, benchmarked: false },
  sourceHashes: Object.fromEntries(
    await Promise.all(
      sources.map(async (file) => [
        file,
        createHash("sha256")
          .update(await fs.readFile(path.join(root, "extension", file)))
          .digest("hex"),
      ]),
    ),
  ),
};
await fs.writeFile(
  path.join(root, "qa/multilingual-reproduction.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
