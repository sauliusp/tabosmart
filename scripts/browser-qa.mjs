import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
const root = path.resolve(import.meta.dirname, "..");
const checks = [],
  errors = [],
  requests = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const titles = {
    "/research/1": "Garden studio ideas | Fieldnotes",
    "/research/2": "Choosing a garden studio | Fieldnotes",
    "/research/3": "Garden studio materials | Fieldnotes",
    "/guide": "A quieter workspace | Journal",
    "/archive/1": "Walking routes for autumn",
    "/archive/2": "Weekend retreat ideas",
    "/work": "Project notes",
  };
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<!doctype html><title>${titles[u.pathname] || "Reference " + u.pathname}</title><h1>${titles[u.pathname] || "Reference page"}</h1><p>Local synthetic browser QA fixture.</p>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const profile = await fs.mkdtemp("/tmp/tabosmart-qa-");
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${root}/extension`,
    `--load-extension=${root}/extension`,
    "--no-first-run",
    "--disable-background-networking",
  ],
});
let worker =
  browser.serviceWorkers()[0] || (await browser.waitForEvent("serviceworker"));
const id = new URL(worker.url()).host;
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (!r.url().startsWith("chrome-extension:")) requests.push(r.url());
});
const rpc = (type, args = {}) =>
  page.evaluate(
    async ({ type, args }) => chrome.runtime.sendMessage({ type, ...args }),
    { type, args },
  );
const check = (name, value = true) => {
  assert(value, name);
  checks.push(name);
};
try {
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.locator(".install-disclosure").waitFor();
  await page.waitForFunction(async () =>
    (await chrome.tabs.query({})).some(
      (t) => t.url === chrome.runtime.getURL("welcome.html"),
    ),
  );
  check("Fresh installation automatically opens the bundled welcome page");
  const welcome = browser
    .pages()
    .find((p) => p.url() === `chrome-extension://${id}/welcome.html`);
  await welcome.waitForLoadState();
  check(
    "Welcome page leads with its value and workspace action",
    (await welcome
      .locator("h1")
      .innerText()
      .then((t) => t.includes("Less tab clutter."))) &&
      (await welcome
        .getByRole("link", { name: "Open my workspace", exact: false })
        .count()) === 2,
  );
  const welcomeA11y = await new AxeBuilder({ page: welcome }).analyze();
  check(
    "Welcome page has no accessibility violations",
    welcomeA11y.violations.length === 0,
  );
  await welcome.screenshot({
    path: path.join(root, "qa/screenshots/welcome.png"),
    fullPage: true,
  });
  await welcome.setViewportSize({ width: 390, height: 844 });
  check(
    "Welcome fits a narrow viewport",
    await welcome.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await welcome.screenshot({
    path: path.join(root, "qa/screenshots/welcome-mobile.png"),
    fullPage: true,
  });
  await welcome
    .getByRole("link", { name: "Settings & privacy", exact: true })
    .first()
    .click();
  await welcome
    .getByRole("heading", { name: "Your browsing, your pace.", exact: true })
    .waitFor();
  check("Welcome privacy link opens the actual extension settings");
  await welcome.close();

  const before = await rpc("snapshot");
  check(
    "Fresh installation starts after its normal required permission grant",
    before.settings.enabled &&
      before.settings.historyEnabled &&
      before.installDisclosure,
  );
  check(
    "History is a required manifest permission with no optional request",
    await page.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return (
        manifest.permissions.includes("history") &&
        !manifest.optional_permissions
      );
    }),
  );
  await page.screenshot({
    path: path.join(root, "qa/screenshots/first-use.png"),
  });
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  check(
    "Dismissing the disclosure preserves enabled observation",
    (await rpc("snapshot")).settings.enabled,
  );
  await page
    .getByRole("heading", { name: "A little more headspace." })
    .waitFor();
  await page.screenshot({ path: path.join(root, "qa/screenshots/empty.png") });
  const fixtureURLs = [
    "/research/1",
    "/research/2",
    "/research/3",
    "/guide",
    "/guide",
    "/archive/1",
    "/archive/2",
    "/work",
  ].map((x) => `http://127.0.0.1:${port}${x}`);
  const created = await page.evaluate(async (urls) => {
    const out = [];
    for (const url of urls)
      out.push(await chrome.tabs.create({ url, active: false }));
    return out;
  }, fixtureURLs);
  await Promise.all(
    created.map((t) =>
      browser
        .pages()
        .find((p) => p.url() === t.url)
        ?.waitForLoadState("load")
        .catch(() => {}),
    ),
  );
  await page.locator(".suggestion-card").first().waitFor();
  check("Browser events update visible suggestions without manual refresh");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".site-favicon")].some(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  check(
    "Suggestion favicons load through Chrome's local endpoint",
    await page
      .locator(".site-favicon")
      .evaluateAll(
        (images) =>
          images.length > 0 &&
          images.every(
            (img) =>
              new URL(img.src).protocol === "chrome-extension:" &&
              new URL(img.src).pathname === "/_favicon/",
          ),
      ),
  );

  const snap = await rpc("snapshot");
  check(
    "Real tabs produce deterministic groups and exact duplicate review",
    snap.suggestions.some((s) => s.type === "group") &&
      snap.suggestions.some((s) => s.type === "duplicate"),
  );
  check(
    "Fresh observations do not appear inactive",
    !snap.suggestions.some((s) => s.type === "inactive"),
  );
  await page.screenshot({
    path: path.join(root, "qa/screenshots/populated.png"),
  });
  const group = snap.suggestions.find((s) => s.type === "group");
  await page.locator(`[data-review="${group.id}"]`).click();
  check(
    "Group review uses website favicons",
    (await page.locator("dialog .site-favicon").count()) > 0,
  );
  await page.locator("#group-name").fill("Garden ideas");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  const nativeGroup = await page.evaluate(async () =>
    chrome.tabGroups.query({ title: "Garden ideas" }),
  );
  check(
    "Accepted suggestion creates a real native Chrome group",
    nativeGroup.length === 1,
  );
  const grouped = await rpc("snapshot");
  check(
    "Applied group is removed from suggestions",
    !grouped.suggestions.some((s) => s.id === group.id),
  );
  const dup = grouped.suggestions.find((s) => s.type === "duplicate");
  await page.locator(`[data-review="${dup.id}"]`).click();
  check(
    "Close review begins with no selection",
    await page.locator("#close-selected").isDisabled(),
  );
  await page.locator("dialog [data-tab-check]").first().check();
  await page.locator("#save-selected").click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  const saved = await rpc("snapshot");
  check(
    "Saving leaves original tab open",
    saved.tabs.some((t) => t.id === dup.tabIds[0]) && saved.saved.length === 1,
  );
  await page.locator('[data-view="saved"]').first().click();
  await page.getByRole("heading", { name: "Keep the possibility." }).waitFor();
  check(
    "Saved URLs retain local favicon lookup",
    (await page.locator(".collection .site-favicon").count()) > 0,
  );
  await page.screenshot({ path: path.join(root, "qa/screenshots/saved.png") });
  // A transient backend failure must leave the same confirmation retryable.
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failOnce = true;
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type === "forget" && failOnce) {
        failOnce = false;
        return Promise.resolve({
          ok: false,
          error: "Temporary saved-list failure",
        });
      }
      return send(message, ...args);
    };
  });
  await page.locator("[data-forget]").first().click();
  await page.locator("#confirm-general").click();
  await page.locator("dialog .error-inline").waitFor();
  check(
    "Confirmation remains open and retryable after a backend failure",
    (await page.locator("dialog").isVisible()) &&
      (await page.locator("#confirm-general").isEnabled()),
  );
  await page.locator("#confirm-general").click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  check(
    "Retrying the same confirmation removes the saved list",
    (await rpc("snapshot")).saved.length === 0,
  );
  await page.locator('[data-view="suggestions"]').first().click();
  await page.locator(`[data-review="${dup.id}"]`).click();
  await page.locator("dialog [data-tab-check]").first().check();
  await page.locator("#close-selected").click();
  await page.screenshot({
    path: path.join(root, "qa/screenshots/close-review.png"),
  });
  await page.locator("#confirm-close").click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  const closed = await rpc("snapshot");
  check(
    "Confirmed closure removes selected tab and preserves recovery URL",
    !closed.tabs.some((t) => t.id === dup.tabIds[0]) &&
      closed.recovery[0].tabs[0].url === dup.tabs[0].url,
  );
  await page.locator('[data-view="recovery"]').first().click();
  check(
    "Recovery URLs use website favicons",
    (await page.locator(".collection .site-favicon").count()) > 0,
  );
  await page.getByRole("button", { name: "Reopen URLs" }).click();
  const restored = await rpc("snapshot");
  check(
    "Recovery reopens a real URL",
    restored.recovery[0].tabs[0].restoredTabId &&
      restored.tabs.some(
        (t) => t.id === restored.recovery[0].tabs[0].restoredTabId,
      ),
  );
  const again = await rpc("restore", {
    kind: "recovery",
    id: restored.recovery[0].id,
  });
  check(
    "Repeated restore does not duplicate URL",
    again.action.restored.length === 0,
  );
  await page
    .getByRole("button", { name: "Settings & privacy", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Make yourself comfortable." })
    .waitFor();
  await page.screenshot({
    path: path.join(root, "qa/screenshots/settings-ai.png"),
  });
  const ai = await page.evaluate(async () => ({
    languageModel: typeof LanguageModel,
    capabilities: await (await import("./local-ai.mjs")).getCapabilities(),
  }));
  check(
    "AI status detected in actual extension document",
    !!ai.capabilities.names.state,
  );
  const alarms = await page.evaluate(() => chrome.alarms.getAll());
  check(
    "Automatic maintenance alarm is configured at15 minutes",
    alarms.some(
      (a) => a.name === "tabosmart.maintenance" && a.periodInMinutes === 15,
    ),
  );
  await page.getByRole("button", { name: "Pause observation" }).click();
  await page.locator('[data-view="suggestions"]').first().click();
  check(
    "Pause retains a genuine paused state",
    await page.locator(".pause-banner").isVisible(),
  );
  const paused = await rpc("snapshot");
  check(
    "Pause stops tab observations",
    !paused.settings.enabled && paused.tabs.length === 0,
  );
  await page.locator("#resume").click();
  await page.locator('[data-view="tabs"]').first().click();
  await page.locator("[data-protect]").first().click();
  const protectedSnap = await rpc("snapshot");
  check(
    "URL protection updates real state",
    protectedSnap.tabs.some((t) => t.protected),
  );
  const freshTab = protectedSnap.tabs.find(
    (t) => !t.protected && !t.active && !t.pinned && !t.audible,
  );
  const oldIdentity = { ...freshTab };
  // Identity rejection is also covered without a navigation race using a deliberately outdated displayed URL.
  const stale = await rpc("close", {
    tabIds: [freshTab.id],
    expectedTabs: [{ ...oldIdentity, url: oldIdentity.url + "?outdated" }],
    confirmed: true,
  });
  check(
    "Stale displayed identity blocks closure",
    !stale.ok && stale.code === "STALE",
  );
  await page.locator('[data-view="suggestions"]').first().click();
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await fs.writeFile(
    path.join(root, "qa/accessibility.json"),
    JSON.stringify(a11y.violations, null, 2),
  );
  check(
    "No serious or critical accessibility violations",
    !a11y.violations.some((v) => ["serious", "critical"].includes(v.impact)),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, "qa/screenshots/narrow.png") });
  check(
    "Narrow layout has no horizontal overflow",
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  check("No extension page JavaScript exceptions", errors.length === 0);
  check("Extension UI makes no network requests", requests.length === 0);
  await fs.writeFile(
    path.join(root, "qa/browser-report.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: browser.browser().version(),
        profile: "Temporary isolated profile",
        fixture: "Synthetic local HTTP pages, real Chrome extension APIs",
        checks,
        errors,
        requests,
        ai,
        accessibility: a11y.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
        })),
        realLocalInference:
          "Not attempted unless actual ready model available. Capability alone is not inference evidence.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, ai, errors, requests },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({
    path: path.join(root, "qa/screenshots/failure.png"),
  });
  console.error(error);
  await fs.writeFile(
    path.join(root, "qa/browser-failure.json"),
    JSON.stringify({ error: error.stack, checks, errors, requests }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
