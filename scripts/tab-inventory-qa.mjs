import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createState,
  observeTabs,
  makeSnapshot,
  DAY,
} from "../extension/core.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await fs.mkdtemp("/tmp/tabosmart-inventory-");
const other = path.join(temporary, "other-extension");
await fs.mkdir(other);
await fs.writeFile(
  path.join(other, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Private extension QA",
    background: { service_worker: "fixture.js" },
    version: "1.0",
  }),
);
await fs.writeFile(
  path.join(other, "private.html"),
  "<!doctype html><title>Private extension fixture</title><p>Local test only</p>",
);
await fs.writeFile(
  path.join(other, "fixture.js"),
  'chrome.runtime.onInstalled.addListener(() => {});',
);
const local = path.join(temporary, "local.html");
await fs.writeFile(
  local,
  "<!doctype html><title>Local file fixture</title><p>Local test only</p>",
);
const extensionPaths = `${root}/extension,${other}`;
const browser = await chromium.launchPersistentContext(
  path.join(temporary, "profile"),
  {
    headless: true,
    channel: "chromium",
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPaths}`,
      `--load-extension=${extensionPaths}`,
      "--no-first-run",
    ],
  },
);
const checks = [],
  errors = [];
const check = (name, condition = true) => {
  assert.ok(condition, name);
  checks.push(name);
};
try {
  const worker =
    browser.serviceWorkers().find((w) => w.url().endsWith("/background.mjs")) ||
    (await browser.waitForEvent("serviceworker", {
      predicate: (w) => w.url().endsWith("/background.mjs"),
    }));
  const id = new URL(worker.url()).host;
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/index.html`);
  const rpc = (type, args = {}) =>
    page.evaluate(
      ({ type, args }) => chrome.runtime.sendMessage({ type, ...args }),
      { type, args },
    );
  await rpc("settings", { patch: { aiEnabled: false, historyEnabled: false } });
  const otherWorker =
    browser.serviceWorkers().find((w) => w.url().endsWith("/fixture.js")) ||
    (await browser.waitForEvent("serviceworker", {
      predicate: (w) => w.url().endsWith("/fixture.js"),
    }));
  const otherId = new URL(otherWorker.url()).host;
  const fixtureURLs = [
    pathToFileURL(local).href,
    `chrome-extension://${otherId}/private.html`,
    "chrome://extensions/",
    "chrome://newtab/",
    "about:blank",
  ];
  const fixturePages = [];
  for (const url of fixtureURLs) {
    let fixture;
    if (url.startsWith(`chrome-extension://${otherId}/`)) {
      [fixture] = await Promise.all([
        browser.waitForEvent("page"),
        otherWorker.evaluate(() =>
          chrome.tabs.create({ url: "private.html", active: false }),
        ),
      ]);
      await fixture.waitForURL(url);
    } else {
      fixture = await browser.newPage();
      await fixture.goto(url);
    }
    await fixture.waitForLoadState();
    fixturePages.push(fixture);
  }
  assert.equal(await fixturePages[1].title(), "Private extension fixture");
  await page.bringToFront();
  const native = await page.evaluate(() =>
    chrome.tabs.query({ windowType: "normal" }),
  );
  const snap = await rpc("snapshot");
  check(
    "Real tab inventory equals Chrome's regular-window tab IDs",
    JSON.stringify(snap.tabs.map((t) => t.id).sort()) ===
      JSON.stringify(
        native
          .filter((t) => !t.incognito)
          .map((t) => t.id)
          .sort(),
      ),
  );
  check(
    "Local, other-extension, Chrome, new and blank pages are present",
    fixtureURLs.every((url) => snap.tabs.some((t) => t.url === url)),
  );
  check(
    "Non-web-only inventory has zero web checks and correct total",
    snap.evaluationSummary.webTabsChecked === 0 &&
      snap.evaluationSummary.openTabs === native.length,
  );
  await page.reload();
  await page.locator('[data-view="tabs"]').first().click();
  await page.waitForFunction(
    (count) =>
      Number(document.querySelector("#tab-count").textContent) === count,
    native.length,
  );
  for (const target of snap.tabs.filter((t) => fixtureURLs.includes(t.url))) {
    const row = page.locator(`.tab-row:has([data-focus="${target.id}"])`);
    check(
      `Non-web row ${target.pageType} disables selection`,
      await row.locator("input").isDisabled(),
    );
    check(
      `Non-web row ${target.pageType} hides protection`,
      (await row.locator("[data-protect]").count()) === 0,
    );
    await row.locator("[data-focus]").click();
    let focused = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      focused = await worker.evaluate(
        (id) => chrome.tabs.get(id).then((t) => t.active),
        target.id,
      );
      if (focused) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    check(`Native focus succeeds for ${target.pageType}`, focused);
    await page.bringToFront();
  }
  await page.locator("#tab-search").fill("Private extension fixture");
  await page.waitForFunction(
    () => document.querySelectorAll(".tab-row").length === 1,
  );
  check("Extension-page titles are searchable");
  await page.locator("#tab-search").fill("");
  await page.waitForFunction(
    (count) =>
      document.querySelector("#tab-search").value === "" &&
      document.querySelectorAll(".tab-row").length === count,
    native.length,
  );
  check("Clearing search restores the complete inventory");
  const fileTab = snap.tabs.find((t) => t.url === pathToFileURL(local).href);
  for (const type of ["save", "close"]) {
    const result = await rpc(type, {
      tabIds: [fileTab.id],
      expectedTabs: [fileTab],
      confirmed: true,
    });
    check(
      `Backend rejects ${type} on switch-only pages`,
      !result.ok && result.code === "STALE",
    );
  }
  await fs.mkdir(path.join(root, "qa/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "qa/screenshots/tab-inventory.png"),
    fullPage: true,
  });

  // Exercise every filter using actual engine output with synthetic old usage.
  const now = Date.now(),
    state = createState(now - 10 * DAY);
  state.settings.enabled = true;
  state.settings.aiEnabled = false;
  state.consentAt = now - 10 * DAY;
  const row = (id, url, title) => ({
    id,
    url,
    title,
    windowId: 1,
    groupId: -1,
    active: false,
    pinned: false,
    audible: false,
  });
  const rows = [
    ...[1, 2, 3].map((id) =>
      row(id, `https://garden.test/plan/${id}`, `Garden studio design ${id}`),
    ),
    ...[4, 5].map((id) =>
      row(id, "https://reference.test/exact", "Reference notes"),
    ),
    row(6, "https://archive.test/", "Annual archive"),
  ];
  observeTabs(state, rows, now - 10 * DAY);
  const synthetic = makeSnapshot(state, rows, now);
  assert.deepEqual(
    new Set(synthetic.suggestions.map((s) => s.type)),
    new Set(["group", "duplicate", "inactive"]),
  );
  const ui = await browser.newPage();
  ui.on("pageerror", (e) => errors.push(e.message));
  await ui.addInitScript((snapshot) => {
    window.qaSnapshot = {
      ...snapshot,
      ok: true,
      snapshotEpoch: "filter-fixture",
      snapshotRevision: 1,
    };
    chrome.runtime.sendMessage = async () => structuredClone(window.qaSnapshot);
  }, synthetic);
  await ui.goto(`chrome-extension://${id}/index.html`);
  await ui.locator('[role="tablist"]').waitFor();
  const assertFilter = async (type) => {
    const wanted = synthetic.suggestions
      .filter((s) => type === "all" || s.type === type)
      .map((s) => s.id);
    await ui.waitForFunction(
      ({ type, wanted }) =>
        document
          .querySelector(`#filter-${type}`)
          ?.getAttribute("aria-selected") === "true" &&
        JSON.stringify(
          [...document.querySelectorAll(".suggestion-card [data-review]")].map(
            (b) => b.dataset.review,
          ),
        ) === JSON.stringify(wanted),
      { type, wanted },
    );
    check(`Filter ${type} shows exactly the matching engine suggestions`);
  };
  await assertFilter("all");
  for (const type of ["group", "duplicate", "inactive"]) {
    await ui.locator(`.check-filter[data-suggestion-filter="${type}"]`).click();
    await assertFilter(type);
    check(
      `Count ${type} selects and focuses its tab`,
      await ui
        .locator(`#filter-${type}`)
        .evaluate((el) => el === document.activeElement),
    );
  }
  await ui.locator("#filter-all").click();
  await ui.keyboard.press("ArrowRight");
  await assertFilter("group");
  await ui.keyboard.press("End");
  await assertFilter("inactive");
  await ui.keyboard.press("Home");
  await assertFilter("all");
  await ui.locator("#filter-duplicate").click();
  await ui.locator('[data-view="tabs"]').first().click();
  await ui.locator('[data-view="suggestions"]').first().click();
  await assertFilter("duplicate");
  await ui.locator(".suggestion-card [data-review]").first().click();
  check(
    "Filtered cards still open the correct review",
    (await ui.locator("dialog").isVisible()) &&
      (await ui.locator("#dialog-title").innerText()).includes("Same URL"),
  );
  await ui.locator("dialog [data-close-dialog]").click();
  await ui.evaluate(() => {
    window.qaSnapshot.suggestions = window.qaSnapshot.suggestions.filter(
      (s) => s.type !== "duplicate",
    );
    window.qaSnapshot.snapshotRevision++;
  });
  await ui.locator("#check-again").click();
  await ui.getByRole("heading", { name: "No repeats to review." }).waitFor();
  check(
    "Refresh keeps the selected empty filter and updates its count",
    (await ui.locator("#filter-duplicate span").innerText()) === "0",
  );
  await ui.getByRole("button", { name: "Show all suggestions" }).click();
  check(
    "Empty filter can return to All",
    (await ui.locator("#filter-all").getAttribute("aria-selected")) === "true",
  );
  const a11y = await new AxeBuilder({ page: ui })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  check(
    "Suggestion filters have no accessibility violations",
    a11y.violations.length === 0,
  );
  await ui.screenshot({
    path: path.join(root, "qa/screenshots/suggestion-filters.png"),
    fullPage: true,
  });
  await ui.setViewportSize({ width: 390, height: 844 });
  check(
    "Filters fit a narrow viewport",
    await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await ui.screenshot({
    path: path.join(root, "qa/screenshots/suggestion-filters-mobile.png"),
    fullPage: true,
  });
  check("No page errors", errors.length === 0);
  console.log(
    JSON.stringify(
      {
        checks,
        errors,
        evidence:
          "Isolated Chromium with real local and private extension pages; filter scenarios use synthetic usage with real engine output.",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
