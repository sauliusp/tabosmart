import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { deriveToolbarState } from "../extension/toolbar-state.mjs";

// Code-native static artwork. This script does not open or capture a browser.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconDir = path.join(root, "extension/icons");
const outputDir = path.join(root, "marketing/output");
await mkdir(iconDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const master = await readFile(
  path.join(root, "marketing/brand/mark.svg"),
  "utf8",
);
const work = master
  .replace('viewBox="0 0 128 128"', 'viewBox="8 8 112 112"')
  .replace(
    "</svg>",
    '<circle cx="102" cy="27" r="13" fill="#E1B86D" stroke="#263F36" stroke-width="4"/></svg>',
  );
for (const size of [16, 32]) {
  await sharp(Buffer.from(work))
    .resize(size, size)
    .png()
    .toFile(path.join(iconDir, `work-${size}.png`));
}

const core = {
  enabled: true,
  consentAt: 1,
  evaluation: { state: "idle" },
  suggestionCount: 0,
};
const examples = [
  {
    label: "Idle",
    note: "No work is being reported.",
    state: deriveToolbarState(core),
  },
  {
    label: "Checking tabs",
    note: "A real tab check is running.",
    state: deriveToolbarState({
      ...core,
      evaluation: { state: "checking", phase: "checking" },
    }),
  },
  {
    label: "Preparing local AI",
    note: "An open workspace reports setup.",
    state: deriveToolbarState(core, [
      { enabled: true, setup: "preparing", naming: false, wording: false },
    ]),
  },
  {
    label: "Reviewing history",
    note: "Available history is being indexed.",
    state: deriveToolbarState({
      ...core,
      history: { state: "indexing", processedURLs: 256, analyzedVisits: 943 },
    }),
  },
  {
    label: "Naming a group",
    note: "An actual naming request is pending.",
    state: deriveToolbarState(core, [
      { enabled: true, setup: "idle", naming: true, wording: false },
    ]),
  },
  {
    label: "Finding relationships",
    note: "An actual discovery request is pending.",
    state: deriveToolbarState(core, [
      {
        enabled: true,
        setup: "idle",
        naming: false,
        wording: false,
        discovery: true,
      },
    ]),
  },
  {
    label: "Choosing wording",
    note: "A verified wording request is pending.",
    state: deriveToolbarState(core, [
      { enabled: true, setup: "idle", naming: false, wording: true },
    ]),
  },
  {
    label: "Paused",
    note: "Tab observation is paused.",
    state: deriveToolbarState({ ...core, enabled: false }),
  },
  {
    label: "Check needs attention",
    note: "The latest tab check did not finish.",
    state: deriveToolbarState({ ...core, evaluation: { state: "error" } }),
  },
  {
    label: "Suggestions to review",
    note: "Three suggestions from a completed check.",
    state: deriveToolbarState({ ...core, suggestionCount: 3 }),
  },
];
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const wrap = (value, limit = 40) => {
  const lines = [];
  let line = "";
  for (const word of value.split(" ")) {
    if (line && `${line} ${word}`.length > limit) {
      lines.push(line);
      line = word;
    } else line += `${line ? " " : ""}${word}`;
  }
  if (line) lines.push(line);
  return lines;
};
const uri = async (file) =>
  `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
const iconURLs = {};
for (const kind of ["icon", "work"])
  for (const size of [16, 32])
    iconURLs[`${kind}-${size}`] = await uri(
      path.join(iconDir, `${kind}-${size}.png`),
    );

function illustratedAction(state, x, y) {
  const kind = state.busy ? "work" : "icon";
  const badge = state.badgeText;
  const badgeWidth = badge.length > 1 ? 34 : 24;
  return `<rect x="${x - 16}" y="${y - 13}" width="84" height="78" rx="16" fill="#F0F1EB"/>
    <image href="${iconURLs[`${kind}-32`]}" x="${x}" y="${y}" width="48" height="48"/>
    ${
      badge
        ? `<rect x="${x + 55 - badgeWidth}" y="${y + 30}" width="${badgeWidth}" height="24" rx="6" fill="${state.badgeColor}" stroke="#F0F1EB" stroke-width="2"/>
    <text x="${x + 55 - badgeWidth / 2}" y="${y + 47}" text-anchor="middle" font-size="16" font-weight="700" fill="${state.badgeTextColor}">${escape(badge)}</text>`
        : ""
    }`;
}

const cards = examples
  .map(({ label, note, state }, index) => {
    const x = 42 + (index % 3) * 378;
    const y = 142 + Math.floor(index / 3) * 275;
    const kind = state.busy ? "work" : "icon";
    return `<g>
    <rect x="${x}" y="${y}" width="358" height="255" rx="20" fill="#FEFEFB" stroke="#DADED4"/>
    <text x="${x + 24}" y="${y + 34}" font-size="19" font-weight="650">${escape(label)}</text>
    ${illustratedAction(state, x + 40, y + 66)}
    <text x="${x + 116}" y="${y + 86}" font-size="13" fill="#4E6057">${escape(note.split(" ").slice(0, 5).join(" "))}</text>
    <text x="${x + 116}" y="${y + 106}" font-size="13" fill="#4E6057">${escape(note.split(" ").slice(5).join(" "))}</text>
    <text x="${x + 116}" y="${y + 132}" font-size="11" fill="#59645A">16 px</text>
    <image href="${iconURLs[`${kind}-16`]}" x="${x + 159}" y="${y + 119}" width="16" height="16"/>
    <text x="${x + 193}" y="${y + 132}" font-size="11" fill="#59645A">32 px</text>
    <image href="${iconURLs[`${kind}-32`]}" x="${x + 236}" y="${y + 106}" width="32" height="32"/>
    ${wrap(state.title)
      .map(
        (line, i) =>
          `<text x="${x + 24}" y="${y + 169 + i * 17}" font-size="12" fill="#4E6057">${escape(line)}</text>`,
      )
      .join("")}
  </g>`;
  })
  .join("");

const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1315" viewBox="0 0 1200 1315">
  <rect width="1200" height="1315" fill="#F5F5EF"/>
  <g font-family="Arial, Helvetica, sans-serif" fill="#263F36">
    <text x="42" y="46" font-size="12" font-weight="700" letter-spacing="1.5">MOCK • STATIC DESIGN PREVIEW</text>
    <text x="42" y="91" font-size="34" font-weight="650">Tabosmart toolbar states</text>
    <text x="42" y="119" font-size="14" fill="#4E6057">Not a browser capture. Examples use the actual source state mapping; icons and badges are illustrated.</text>
    ${cards}
    <text x="42" y="1265" font-size="13" fill="#4E6057">The warm dot marks reported work. Idle, paused and completed results keep the original icon.</text>
    <text x="42" y="1289" font-size="12" fill="#4E6057">Static icons. No animation, invented progress or claim of a completed model download. Larger illustrations are 3× toolbar size.</text>
  </g>
</svg>`;
const previewPath = path.join(outputDir, "toolbar-states-preview.png");
await sharp(Buffer.from(preview)).removeAlpha().png().toFile(previewPath);

const checked = [];
for (const file of [
  path.join(iconDir, "work-16.png"),
  path.join(iconDir, "work-32.png"),
  previewPath,
]) {
  const { width, height, channels } = await sharp(file).metadata();
  checked.push({ file: path.relative(root, file), width, height, channels });
}
console.log(
  JSON.stringify(
    {
      kind: "static SVG/sharp mock, no browser capture",
      outputs: checked,
      states: examples.map(({ label, state }) => ({ label, ...state })),
    },
    null,
    2,
  ),
);
