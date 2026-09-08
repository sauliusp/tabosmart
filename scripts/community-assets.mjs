import { chromium } from "playwright";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPreviewServer } from "./preview-server.mjs";
import AxeBuilder from "@axe-core/playwright";
import {
  createState,
  observeTabs,
  makeSnapshot,
  DAY,
} from "../extension/core.mjs";
const root = path.resolve(import.meta.dirname, ".."),
  out = path.join(root, "marketing/community-launch/raw");
await fs.mkdir(out, { recursive: true });
const now = Date.now(),
  state = createState(now - 15 * DAY);
state.settings.enabled = true;
state.consentAt = now - 15 * DAY;
state.settings.historyEnabled = true;
const raw = [];
function tab(domain, title, slug, extra = {}) {
  const t = {
    id: raw.length + 1,
    title,
    url: `https://${domain}/${slug}`,
    windowId: 1,
    index: raw.length,
    groupId: -1,
    active: false,
    pinned: false,
    audible: false,
    ...extra,
  };
  raw.push(t);
  return t;
}
const related = [
  tab("studio.example", "Studio refresh project overview", "studio-refresh"),
  tab("materials.example", "Studio refresh materials and finishes", "materials"),
  tab("reading.example", "Studio refresh reading corner", "reading-corner"),
  tab("ideas.example", "Studio refresh ideas to explore", "ideas"),
];
const duplicates = [
  tab("read.cv", "A considered workspace · Studio Journal", "studio-journal"),
  tab("read.cv", "A considered workspace · Studio Journal", "studio-journal"),
  tab("read.cv", "A considered workspace · Studio Journal", "studio-journal"),
];
const older = [
  tab("fieldnotes.example", "A weekend cabin by the lake", "weekend-cabin", {
    groupId: 20,
  }),
  tab("slowtravel.example", "Walking in the Dolomites", "dolomites", {
    groupId: 20,
  }),
  tab("objects.example", "The everyday carry collection", "everyday-carry", {
    groupId: 20,
  }),
];
const fillerDomains = [
  "figma.com",
  "github.com",
  "docs.google.com",
  "are.na",
  "developer.chrome.com",
  "calendar.google.com",
];
for (let i = 0; raw.length < 100; i++)
  tab(
    fillerDomains[i % 6],
    [
      "Design system references",
      "Project reference notes",
      "Product planning",
      "Visual inspiration",
      "Browser documentation",
      "Weekly schedule",
    ][i % 6],
    `saved-project-${i}`,
    { groupId: 30 + (i % 6), pinned: i < 3 },
  );
observeTabs(state, raw, now);
for (const t of raw.slice(15, 23)) state.protectedUrls[t.url] = now;
state.evaluation = {
  state: "idle",
  checkedAt: now,
  requestedAt: null,
  error: null,
};
let fixture = {
  ok: true,
  ...makeSnapshot(state, raw, now),
  history: {
    state: "ready",
    processedURLs: 12648,
    analyzedVisits: 47912,
    indexedURLs: 12648,
  },
};
fixture.saved = [
  {
    id: "example-saved-1",
    title: "3 tabs",
    createdAt: now - DAY,
    tabs: related
      .slice(0, 3)
      .map((t) => ({ ...t, id: String(t.id), status: "saved" })),
  },
  {
    id: "example-saved-2",
    title: "A weekend away",
    createdAt: now - 2 * DAY,
    tabs: older
      .slice(0, 2)
      .map((t) => ({ ...t, id: String(t.id), status: "saved" })),
  },
];
fixture.saved = fixture.saved.slice(0, 1);
const preview = await createPreviewServer(root);
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const accessibility = [],
  pageErrors = [],
  externalRequests = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.route("**/*", (route) => {
  if (new URL(route.request().url()).origin === new URL(preview.url).origin)
    return route.continue();
  externalRequests.push(route.request().url());
  return route.abort();
});
await page.addInitScript((data) => {
  window.__fixture = data;
  // Synthetic source preview only. No installed extension or actual model APIs.
  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) =>
        msg.type === "focus" ? { ok: true } : structuredClone(window.__fixture),
      onMessage: { addListener() {} },
    },
  };
}, fixture);
const capture = async (file) => {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const toast = document.querySelector("#toast");
    if (toast) toast.hidden = true;
  });
  await page.screenshot({ path: path.join(out, file) });
  const result = await new AxeBuilder({ page }).analyze();
  accessibility.push({ file, violations: result.violations });
};
try {
  await page.goto(preview.url);
  await page
    .getByRole("heading", { name: "A little more headspace." })
    .waitFor();
  await page.locator("[data-group-title]").first().waitFor();
  await capture("01-more-headspace.png");
  await page.locator(".suggestion-list").screenshot({path: path.join(out, "suggestions-detail.png")});
  const group = fixture.suggestions.find((s) => s.type === "group");
  await page.locator(`[data-review="${group.id}"]`).click();
  await page.locator("#group-name").fill("Studio refresh");
  await capture("02-groups-with-a-reason.png");
  await page.locator("[data-close-dialog]").click();
  const dup = fixture.suggestions.find((s) => s.type === "duplicate");
  await page.locator(`[data-review="${dup.id}"]`).click();
  await page.locator("dialog [data-tab-check]").first().check();
  await capture("03-duplicates-your-decision.png");
  await page.locator("[data-close-dialog]").click();
  await page.locator('[data-view="saved"]').first().click();
  await capture("04-save-the-possibility.png");
  for (const t of older) {
    state.observations[t.id].firstSeenAt = now - 15 * DAY;
    state.observations[t.id].lastUsedAt = now - 12 * DAY;
    state.observations[t.id].visitCount = 2;
    state.observations[t.id].reviewSince = now - 15 * DAY;
    state.observations[t.id].reviewNotBefore = now - 15 * DAY;
    state.urlHistory[t.url].firstObservedAt = now - 15 * DAY;
    state.urlHistory[t.url].lastUsedAt = now - 12 * DAY;
    state.urlHistory[t.url].visitCount = 2;
  }
  const oldFixture = { ...fixture, ...makeSnapshot(state, raw, now) };
  await page.evaluate((data) => (window.__fixture = data), oldFixture);
  await page.locator('[data-view="suggestions"]').first().click();
  await page.locator("#refresh").click();
  const inactive = oldFixture.suggestions.find((s) => s.type === "inactive");
  await page.locator(`[data-review="${inactive.id}"]`).click();
  await capture("05-older-tabs-a-fresh-look.png");
  await page.locator("[data-close-dialog]").click();
  // Synthetic fresh-install view, with the normal permission already granted.
  // This is a nonblocking disclosure beside immediately available suggestions.
  await page.evaluate((data) => {
    window.__fixture = {
      ...data,
      installDisclosure: true,
      history: {
        state: "indexing",
        processedURLs: 256,
        analyzedVisits: 943,
        indexedURLs: 0,
      },
    };
  }, fixture);
  await page.locator("#refresh").click();
  await capture("first-use-preview.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("workspace-close-390-preview.png");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-view="settings"]').first().click();
  await page.locator('.settings-section').filter({hasText: 'Local AI'}).last().scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(out, 'local-ai-settings.png')});
  await page.locator('[data-view="feedback"]').first().click();
  await capture('community-feedback.png');
  const brand = (
    await fs.readFile(path.join(root, "marketing/brand/mark.svg"), "utf8")
  ).replace(/<\?xml[^>]*>/, "");
  const logo = `data:image/svg+xml;base64,${Buffer.from(brand).toString("base64")}`;
  const small = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280"><rect width="440" height="280" fill="#edf2e5"/><circle cx="411" cy="280" r="161" fill="#dfe8d6"/><image href="${logo}" x="26" y="23" width="33" height="33"/><text x="69" y="47" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#263f36" letter-spacing="-1">Tabosmart.</text><text x="29" y="115" font-family="Arial,sans-serif" font-size="35" font-weight="600" fill="#263f36" letter-spacing="-1.2">Less tab clutter.</text><text x="29" y="157" font-family="Arial,sans-serif" font-size="35" font-weight="600" fill="#263f36" letter-spacing="-1.2">More headspace.</text><text x="31" y="195" font-family="Arial,sans-serif" font-size="12" fill="#5b6f53">Thoughtful suggestions. Always your call.</text><rect x="30" y="224" width="93" height="28" rx="14" fill="#304f40"/><text x="48" y="243" font-family="Arial,sans-serif" font-size="10" fill="#ffffff">Group · Review</text><rect x="132" y="224" width="78" height="28" rx="14" fill="#ffffff"/><text x="153" y="243" font-family="Arial,sans-serif" font-size="10" fill="#4b6542">Save for later</text></svg>`;
  await sharp(Buffer.from(small))
    .flatten({ background: "#edf2e5" })
    .png()
    .toFile(path.join(out, "small-promo-440x280.png"));
  const screenshot = await sharp(path.join(out, "01-more-headspace.png"))
    .resize(848, 530)
    .png()
    .toBuffer();
  const marquee = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="560"><rect width="1400" height="560" fill="#edf2e5"/><circle cx="1343" cy="370" r="540" fill="#e1ead8"/><image href="${logo}" x="58" y="48" width="43" height="43"/><text x="116" y="81" font-family="Arial,sans-serif" font-size="29" font-weight="700" fill="#263f36" letter-spacing="-1.3">Tabosmart.</text><text x="61" y="219" font-family="Arial,sans-serif" font-size="57" font-weight="600" fill="#263f36" letter-spacing="-2.4">Less tab clutter.</text><text x="61" y="286" font-family="Arial,sans-serif" font-size="57" font-weight="600" fill="#263f36" letter-spacing="-2.4">More headspace.</text><text x="65" y="344" font-family="Arial,sans-serif" font-size="18" fill="#5b6f53">Useful suggestions for the tabs you have open.</text><text x="65" y="374" font-family="Arial,sans-serif" font-size="18" fill="#5b6f53">You choose what to group, save or close.</text><rect x="64" y="437" width="266" height="36" rx="18" fill="#304f40"/><text x="84" y="460" font-family="Arial,sans-serif" font-size="13" fill="#ffffff">Your tab data stays on your device</text></svg>`;
  await sharp(Buffer.from(marquee))
    .composite([{ input: screenshot, left: 613, top: 48 }])
    .flatten({ background: "#edf2e5" })
    .png()
    .toFile(path.join(out, "marquee-1400x560.png"));
  const marqueePath = path.join(out, "marquee-1400x560.png");
  const marqueeBytes = await fs.readFile(marqueePath);
  await sharp(marqueeBytes).removeAlpha().png().toFile(marqueePath);
  const files = (await fs.readdir(out)).filter((f) => f.endsWith(".png"));
  const verified = [];
  for (const file of files) {
    const m = await sharp(path.join(out, file)).metadata();
    verified.push({
      file,
      width: m.width,
      height: m.height,
      channels: m.channels,
      size: (await fs.stat(path.join(out, file))).size,
    });
  }
  await fs.writeFile(
    path.join(out, "asset-manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        version: JSON.parse(
          await fs.readFile(path.join(root, "extension/manifest.json"), "utf8"),
        ).version,
        source:
          "Screenshots render the extension source UI in a disposable localhost HTTP preview with a synthetic runtime snapshot. No extension, real browser profile or actual model is accessed. No model is mocked as ready; optional AI is unavailable in this preview. These are visual examples, not live behavioral or AI evidence.",
        sourceHashes: Object.fromEntries(
          await Promise.all(
            [
              "app.mjs",
              "index.html",
              "styles.css",
              "core.mjs",
              "topic-evidence.mjs",
              "group-discovery.mjs",
              "proactive-discovery.mjs",
              "local-ai.mjs",
              "proactive-names.mjs",
              "ai-status-watch.mjs",
            ].map(async (file) => [
              file,
              createHash("sha256")
                .update(await fs.readFile(path.join(root, "extension", file)))
                .digest("hex"),
            ]),
          ),
        ),
        examples: {
          openTabs: raw.length,
          protectedURLs: 8,
          daysSinceRecordedURLUse: 12,
          history: {
            completedURLs: 12648,
            completedVisits: 47912,
            initialProcessedURLs: 256,
            initialAnalyzedVisits: 943,
            source:
              "Synthetic display examples only, not actual browser history",
          },
        },
        accessibility,
        pageErrors,
        externalRequests,
        storeScreenshots: files.filter((f) => /^0[1-5]-/.test(f)),
        files: verified,
      },
      null,
      2,
    ),
  );
  if (
    pageErrors.length ||
    externalRequests.length ||
    accessibility.some((item) => item.violations.length)
  )
    throw new Error("Preview QA failed; inspect asset-manifest.json");
  console.log(JSON.stringify(verified, null, 2));
} finally {
  await context.close();
  await browser.close();
  await preview.close();
}
