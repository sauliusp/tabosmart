import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "qa/ui-refresh");
await fs.mkdir(output, { recursive: true });
const report = {
  checks: [],
  accessibility: [],
  screenshots: [],
  errors: [],
  ai: "AI naming is simulated. Tab inventory and actions use real browser APIs in an isolated profile.",
};
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<title>Garden studio ${req.url.includes("materials") ? "materials" : req.url.includes("budget") ? "budget" : "design notes"}</title><h1>Local QA fixture</h1>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp("/tmp/tabosmart-design-");
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  viewport: { width: 1440, height: 1000 },
  args: [
    `--disable-extensions-except=${root}/extension`,
    `--load-extension=${root}/extension`,
    "--disable-background-networking",
  ],
});
const worker =
  context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", (e) => report.errors.push(e.message));
await page.addInitScript(() => {
  Object.defineProperty(globalThis, "LanguageModel", {
    configurable: true,
    value: {
      availability: async () => "available",
      create: async () => ({
        destroy() {},
        prompt: async (text) =>
          text.includes("UNTRUSTED_GROUP_METADATA_JSON")
            ? "Studio design"
            : "0",
      }),
    },
  });
});
const rpc = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) => chrome.runtime.sendMessage({ type, ...args }),
    { type, args },
  );
const check = (name, value) => {
  report.checks.push({ name, passed: !!value });
  assert(value, name);
};
async function shot(name) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (!document.querySelector("dialog").open)
      document.querySelector("main").focus({ preventScroll: true });
  });
  await page.locator("#toast").evaluate((el) => (el.hidden = true));
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  report.screenshots.push(`${name}.png`);
}
async function audit(name) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  report.accessibility.push({
    name,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  });
  check(`${name}: no accessibility violations`, !result.violations.length);
  check(
    `${name}: no horizontal overflow`,
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
}
const nav = async (view) => {
  await page
    .locator(
      `#navigation [data-view="${view}"], .sidebar-bottom [data-view="${view}"]`,
    )
    .first()
    .click();
};
async function awaitInventory(expected) {
  await page.waitForFunction(
    (expected) =>
      Number(document.querySelector("#tab-count").textContent) === expected,
    expected,
  );
  const live = await page.evaluate(
    async () =>
      (await chrome.tabs.query({})).filter(
        (t) => !t.incognito && /^https?:/.test(t.url),
      ).length,
  );
  assert.equal(live, expected);
}
try {
  await page.goto(
    `chrome-extension://${new URL(worker.url()).host}/index.html`,
  );
  await page.locator("#main h1").waitFor();
  await page.evaluate(() => {
    globalThis.__counts = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) =>
      send(...args).then((r) => {
        if (r.tabs)
          __counts.push({
            type: args[0].type,
            count: r.tabs.length,
            rev: r.snapshotRevision,
          });
        return r;
      });
  });
  await shot("first-install");
  await audit("First install");
  await page.locator("#dismiss-disclosure").click();
  await shot("empty");
  await page.evaluate(async (base) => {
    for (const suffix of ["/design", "/materials", "/budget", "/design"])
      await chrome.tabs.create({ url: base + suffix, active: false });
  }, base);
  await page.waitForFunction(async () => {
    const s = await chrome.runtime.sendMessage({ type: "snapshot" });
    return (
      s.tabs.length === 4 &&
      s.suggestions.some((s) => s.type === "group") &&
      s.suggestions.some((s) => s.type === "duplicate")
    );
  });
  await page.locator("#refresh").click();
  await page.waitForFunction(() => !!document.querySelector(".ai-name-badge"));
  await shot("suggestions");
  await audit("Suggestions");
  const snap = await rpc("snapshot");
  const group = snap.suggestions.find((s) => s.type === "group");
  await page.locator(`[data-review="${group.id}"]`).click();
  check(
    "Exactly one AI icon in the name editor",
    (await page.locator(".name-field svg").count()) === 1,
  );
  check(
    "AI provenance has readable text",
    (await page.locator("#review-name-provenance").innerText()) ===
      "AI suggested",
  );
  const inputBox = await page.locator("#group-name").boundingBox(),
    buttonBox = await page.locator("#ai-name").boundingBox();
  check(
    "Rename action and input share a vertical center",
    Math.abs(
      inputBox.y + inputBox.height / 2 - buttonBox.y - buttonBox.height / 2,
    ) < 1,
  );
  await shot("group-review");
  await audit("Group review");
  // Change inventory while a review is open; close must reconcile the underlying list.
  await page.evaluate(
    async (base) => chrome.tabs.create({ url: base + "/extra", active: false }),
    base,
  );
  await awaitInventory(5);
  await page.locator("dialog [data-close-dialog]").click();
  await nav("tabs");
  await page.locator("#tab-search").waitFor();
  check(
    "Closing review renders current inventory",
    (await page.locator("#main .tab-row").count()) === 5,
  );
  await shot("open-tabs");
  await audit("Open tabs");
  await page.locator("#main [data-tab-check]").first().check();
  await page.locator("#review-selected").click();
  const duringReview = await page.evaluate(
    async (base) =>
      chrome.tabs.create({ url: base + "/during-tab-review", active: false }),
    base,
  );
  await awaitInventory(6);
  await page.locator("dialog [data-close-dialog]").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#main .tab-row").length === 6,
  );
  check(
    "Open tabs list refreshes after dismissing a review without navigating",
    (await page.locator("#main .tab-row").count()) === 6,
  );
  await page.evaluate(async (id) => chrome.tabs.remove(id), duringReview.id);
  await awaitInventory(5);
  await page.locator("#tab-search").fill("not-a-real-title");
  check(
    "Search explains filtered count",
    await page
      .locator(".tab-scope")
      .innerText()
      .then((t) => t.startsWith("0 of 5")),
  );
  await shot("search-empty");
  await page.locator("#tab-search").fill("");
  await nav("settings");
  const added = await page.evaluate(
    async (base) =>
      chrome.tabs.create({ url: base + "/settings-change", active: false }),
    base,
  );
  await awaitInventory(6);
  check(
    "Navigation count updates while Settings is open",
    (await page.locator("#tab-count").innerText()) === "6",
  );
  await page.evaluate(async (id) => chrome.tabs.remove(id), added.id);
  await awaitInventory(5);
  check(
    "Navigation count removes closed tabs while Settings is open",
    (await page.locator("#tab-count").innerText()) === "5",
  );
  await shot("settings");
  await audit("Settings");
  await rpc("save", {
    tabIds: [snap.tabs[0].id],
    expectedTabs: [snap.tabs[0]],
  });
  await page.locator("#refresh").click();
  await nav("saved");
  await shot("saved");
  await audit("Saved");
  const savedAdded = await page.evaluate(
    async (base) =>
      chrome.tabs.create({ url: base + "/saved-change", active: false }),
    base,
  );
  await awaitInventory(6);
  check(
    "Navigation count updates while Saved is open",
    (await page.locator("#tab-count").innerText()) === "6",
  );
  await page.evaluate(async (id) => chrome.tabs.remove(id), savedAdded.id);
  await awaitInventory(5);
  await nav("suggestions");
  const fresh = await rpc("snapshot");
  const duplicate = fresh.suggestions.find((s) => s.type === "duplicate");
  await page.locator(`[data-review="${duplicate.id}"]`).click();
  await shot("duplicate-review");
  await audit("Duplicate review");
  await page.locator("dialog [data-tab-check]").first().check();
  await page.locator("#close-selected").click();
  await shot("close-confirmation");
  await audit("Close confirmation");
  await page.locator("#confirm-close").click();
  await nav("recovery");
  await shot("recovery");
  await audit("Recovery");
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of [
      "suggestions",
      "tabs",
      "saved",
      "recovery",
      "settings",
    ]) {
      await nav(view);
      await audit(`${view} at ${width}px`);
      if (width === 390) await shot(`narrow-${view}`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("suggestions");
  const narrow = await rpc("snapshot");
  const ng = narrow.suggestions.find((s) => s.type === "group");
  await page.locator(`[data-review="${ng.id}"]`).click();
  await shot("narrow-group-review");
  await audit("Narrow group review");
  await page.locator("dialog [data-close-dialog]").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav("settings");
  await page.locator("#toggle-ai").click();
  await nav("suggestions");
  const off = await rpc("snapshot");
  await page
    .locator(
      `[data-review="${off.suggestions.find((s) => s.type === "group").id}"]`,
    )
    .click();
  check(
    "AI off explains unavailable Rename",
    await page
      .locator("#name-help")
      .innerText()
      .then((t) => t.includes("Enable local AI")),
  );
  await shot("ai-off-review");
  await page.locator("dialog [data-close-dialog]").click();
  await nav("settings");
  await page.locator("#toggle-observation").click();
  await nav("tabs");
  check(
    "Paused count does not claim zero tabs",
    (await page.locator("#tab-count").innerText()) === "–",
  );
  await shot("paused");
  await audit("Paused");
  check("No page exceptions", !report.errors.length);
} catch (e) {
  report.failure = e.stack;
  report.debug = await page.locator("body").innerText();
  report.inventory = await page.evaluate(async () => ({
    tabs: await chrome.tabs.query({}),
    counts: __counts,
  }));
  await shot("failure");
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await context.close();
  await new Promise((r) => server.close(r));
  await fs.rm(profile, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        checks: report.checks.length,
        failed: report.checks.filter((c) => !c.passed),
        failure: report.failure,
      },
      null,
      2,
    ),
  );
}
