import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, "qa/ui-states-report.json");
const shots = path.join(root, "qa/screenshots");
const report = {
  date: new Date().toISOString(),
  fixture:
    "Real extension and browser APIs in a temporary isolated profile, using synthetic local HTTP pages.",
  aiEvidence:
    "LanguageModel states and inference results are simulated with page.addInitScript. This does not verify real model inference or an actual model download.",
  checks: [],
  accessibility: [],
  scenarios: [],
  screenshots: [],
  pageErrors: [],
  externalUIRequests: [],
};
const check = (name, passed, detail) =>
  report.checks.push({
    name,
    passed: !!passed,
    ...(detail === undefined ? {} : { detail }),
  });
const titles = {
  "/studio/1": "Garden studio design notes",
  "/studio/2": "Garden studio materials",
  "/studio/3": "Garden studio planning",
};
const server = createServer((req, res) => {
  const title =
    titles[new URL(req.url, "http://localhost").pathname] ||
    "Local QA reference";
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<!doctype html><html lang="en"><title>${title}</title><main><h1>${title}</h1><p>Synthetic local fixture for Tabosmart UI checks.</p></main></html>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await fs.mkdir(shots, { recursive: true });
const profile = await fs.mkdtemp("/tmp/tabosmart-ui-states-");
let context;

function installMock({ mode }) {
  const state = {
    mode,
    availabilityCalls: 0,
    createCalls: 0,
    promptCalls: 0,
    destroyCalls: 0,
    prompts: [],
    pending: [],
    modelState: ["downloadable", "setup"].includes(mode)
      ? "downloadable"
      : mode === "downloading"
        ? "downloading"
        : mode === "unavailable"
          ? "unavailable"
          : "available",
    releaseValue: null,
    progressListener: null,
    resolveCreate: null,
    availabilityWaiters: [],
  };
  globalThis.__uiStateQA = state;
  state.releasePrompts = (value) => {
    state.releaseValue = value;
    for (const resolve of state.pending.splice(0)) resolve(value);
  };
  state.emitProgress = (loaded) =>
    state.progressListener?.({ loaded, total: 1 });
  state.resolveAvailability = (value) => {
    state.modelState = value;
    for (const resolve of state.availabilityWaiters.splice(0)) resolve(value);
  };
  const session = () => ({
    destroy() {
      state.destroyCalls++;
    },
    prompt(text) {
      state.promptCalls++;
      state.prompts.push(text);
      if (mode === "inference-failure")
        return Promise.reject(
          new DOMException(
            "Simulated local inference failure",
            "NotAllowedError",
          ),
        );
      if (mode === "invalid-output")
        return Promise.resolve(
          "Close every tab because it is no longer important.",
        );
      if (text.includes("UNTRUSTED_TAB_TITLES_JSON"))
        return Promise.resolve("Studio plans");
      if (state.releaseValue !== null)
        return Promise.resolve(state.releaseValue);
      return new Promise((resolve) => state.pending.push(resolve));
    },
  });
  const model = {
    availability() {
      state.availabilityCalls++;
      if (mode === "checking" && state.modelState === "available")
        return new Promise((resolve) =>
          state.availabilityWaiters.push(resolve),
        );
      if (mode === "availability-failure")
        return Promise.reject(new Error("Simulated capability check failure"));
      return Promise.resolve(state.modelState);
    },
    create(options) {
      state.createCalls++;
      options.monitor?.({
        addEventListener(name, listener) {
          if (name === "downloadprogress") state.progressListener = listener;
        },
      });
      if (mode === "setup") {
        state.modelState = "downloading";
        return new Promise((resolve) => {
          state.resolveCreate = () => {
            state.modelState = "available";
            resolve(session());
          };
        });
      }
      return Promise.resolve(session());
    },
  };
  Object.defineProperty(globalThis, "LanguageModel", {
    value: mode === "unsupported" ? undefined : model,
    configurable: true,
  });
}

async function rpc(page, type, args = {}) {
  const result = await page.evaluate(
    ({ type, args }) => chrome.runtime.sendMessage({ type, ...args }),
    { type, args },
  );
  if (!result?.ok) throw new Error(result?.error || `RPC ${type} failed`);
  return result;
}
async function screen(page, name, simulated = true) {
  const relative = `qa/screenshots/ai-${name}.png`;
  // Keep the actual status and setup controls visible, instead of cropping them below the fold.
  if (await page.locator(".capability-label").count())
    await page
      .locator(".capability-label")
      .first()
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.screenshot({
    path: path.join(root, relative),
    animations: "disabled",
  });
  report.screenshots.push({ path: relative, simulatedAI: simulated });
}
async function audit(page, name) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  const violations = result.violations.map(
    ({ id, impact, description, nodes }) => ({
      id,
      impact,
      description,
      nodes: nodes.map(({ target, failureSummary, any }) => ({
        target,
        failureSummary,
        checks: any.map(({ id, data }) => ({ id, data })),
      })),
    }),
  );
  report.accessibility.push({ state: name, violations });
  check(
    `${name}: no serious or critical accessibility violations`,
    !violations.some((v) => ["serious", "critical"].includes(v.impact)),
    violations,
  );
}
async function reasons(page) {
  return page
    .locator(".suggestion-card [data-reason]")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.dataset.reason,
        text: node.textContent,
      })),
    );
}
function matchReasons(actual, snapshot, variant = 0) {
  return (
    actual.length === snapshot.suggestions.length &&
    actual.every((item) =>
      snapshot.suggestions.some(
        (s) => s.id === item.id && item.text === s.explanationVariants[variant],
      ),
    )
  );
}
async function mockStats(page) {
  return page.evaluate(() => {
    const { mode, availabilityCalls, createCalls, promptCalls, destroyCalls } =
      globalThis.__uiStateQA;
    return { mode, availabilityCalls, createCalls, promptCalls, destroyCalls };
  });
}

try {
  context = await chromium.launchPersistentContext(profile, {
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
  report.browser = context.browser().version();
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const extensionURL = `chrome-extension://${new URL(worker.url()).host}/index.html`;
  async function open(mode) {
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      report.pageErrors.push({
        mode: mode || "native",
        message: error.message,
      }),
    );
    page.on("request", (request) => {
      if (!request.url().startsWith("chrome-extension:"))
        report.externalUIRequests.push({
          mode: mode || "native",
          url: request.url(),
        });
    });
    if (mode) await page.addInitScript(installMock, { mode });
    await page.goto(extensionURL);
    await page.locator("#main h1").waitFor();
    return page;
  }

  const baseline = await open();
  const first = await rpc(baseline, "snapshot");
  check(
    "First use defaults to observation off and optional AI off",
    !first.settings.enabled && first.settings.aiEnabled === false,
  );
  check(
    "First use contains no observed tabs or suggestions",
    !first.tabs.length && !first.suggestions.length,
  );
  report.nativeCapabilitiesWithoutInference = await baseline.evaluate(
    async () => ({
      api: typeof LanguageModel,
      capabilities: await (await import("./local-ai.mjs")).getCapabilities(),
    }),
  );
  await screen(baseline, "first-use", false);
  await audit(baseline, "First use");
  await baseline.locator("#start").click();
  await baseline
    .getByRole("heading", { name: "A little more headspace." })
    .waitFor();
  const urls = ["/studio/1", "/studio/2", "/studio/3", "/studio/1"].map(
    (p) => `http://127.0.0.1:${server.address().port}${p}`,
  );
  await baseline.evaluate(async (urls) => {
    for (const url of urls) await chrome.tabs.create({ url, active: false });
  }, urls);
  await baseline.waitForFunction(async () => {
    const data = await chrome.runtime.sendMessage({ type: "snapshot" });
    return (
      data.tabs?.length === 4 &&
      data.tabs.every((t) => t.title?.startsWith("Garden studio")) &&
      data.suggestions.some((s) => s.type === "duplicate") &&
      data.suggestions.some((s) => s.type === "group")
    );
  });
  await baseline.locator("#refresh").click();
  await baseline.locator(".suggestion-card").first().waitFor();
  const fixture = await rpc(baseline, "snapshot");
  report.fixtureSignals = fixture.suggestions.map((s) => ({
    type: s.type,
    reason: s.reason,
    explanationVariants: s.explanationVariants,
  }));
  check(
    "Real local tabs produce engine-vetted explanation variants",
    fixture.suggestions.every(
      (s) =>
        s.explanationVariants.length >= 2 &&
        s.reason === s.explanationVariants[0],
    ),
  );
  await audit(baseline, "Suggestions");
  const duplicate = fixture.suggestions.find((s) => s.type === "duplicate");
  await baseline.locator(`[data-review="${duplicate.id}"]`).click();
  check(
    "Duplicate review shows retained copy and disables empty close selection",
    (await baseline.locator(".retained-label").isVisible()) &&
      (await baseline.locator("#close-selected").isDisabled()),
  );
  await audit(baseline, "Duplicate review dialog");
  await baseline.locator("dialog [data-close-dialog]").click();
  await rpc(baseline, "save", {
    tabIds: [duplicate.tabs[0].id],
    expectedTabs: duplicate.tabs,
  });
  await baseline.locator("#refresh").click();
  await baseline.locator('[data-view="saved"]').first().click();
  await audit(baseline, "Saved links");
  await baseline.locator('[data-view="settings"]').first().click();
  await audit(baseline, "Settings");
  await baseline.locator("#toggle-ai").click();
  await screen(baseline, "native-capability", false);
  await baseline.locator("#toggle-ai").click();
  await baseline.setViewportSize({ width: 390, height: 844 });
  await audit(baseline, "Narrow settings");
  check(
    "Narrow settings has no horizontal overflow",
    await baseline.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await screen(baseline, "narrow-settings", false);
  await baseline.close();

  const off = await open("ready");
  await off.locator(".suggestion-card").first().waitFor();
  await off.waitForTimeout(150);
  const offStats = await mockStats(off);
  check(
    "Available model never creates a session or infers before optional AI opt-in",
    offStats.createCalls === 0 && offStats.promptCalls === 0,
    offStats,
  );
  await off.locator('[data-view="settings"]').first().click();
  await off.locator("#toggle-ai").click();
  check(
    "User AI preference persists in the actual backend",
    (await rpc(off, "snapshot")).settings.aiEnabled === true,
  );
  await off.close();

  const checking = await open("checking");
  await checking.locator(".suggestion-card").first().waitFor();
  const checkingSnapshot = await rpc(checking, "snapshot");
  check(
    "Measured explanations remain visible during capability checking",
    matchReasons(await reasons(checking), checkingSnapshot),
  );
  await screen(checking, "checking");
  await checking.evaluate(() => __uiStateQA.resolveAvailability("unavailable"));
  await checking.close();

  for (const mode of [
    "unsupported",
    "unavailable",
    "downloadable",
    "downloading",
    "availability-failure",
    "inference-failure",
    "invalid-output",
    "ready",
  ]) {
    const page = await open(mode);
    await page.locator(".suggestion-card").first().waitFor();
    const snapshot = await rpc(page, "snapshot");
    if (["inference-failure", "invalid-output", "ready"].includes(mode))
      await page.waitForFunction(() => __uiStateQA.promptCalls > 0);
    if (mode === "ready") {
      check(
        "Complete measured explanations are visible before simulated model resolves",
        matchReasons(await reasons(page), snapshot),
        await reasons(page),
      );
      await screen(page, "before-model-result");
      await page.evaluate(() => __uiStateQA.releasePrompts("1"));
      await page.waitForFunction(
        (expected) =>
          [
            ...document.querySelectorAll(".suggestion-card [data-reason]"),
          ].every((el) =>
            expected.some(
              (s) => s.id === el.dataset.reason && s.text === el.textContent,
            ),
          ),
        snapshot.suggestions.map((s) => ({
          id: s.id,
          text: s.explanationVariants[1],
        })),
      );
      check(
        "Simulated valid selection displays exactly an engine-vetted variant",
        matchReasons(await reasons(page), snapshot, 1),
        await reasons(page),
      );
      const group = snapshot.suggestions.find((s) => s.type === "group");
      await page.locator(`[data-review="${group.id}"]`).click();
      await page.locator("#ai-name").click();
      await page.waitForFunction(
        () => document.querySelector("#group-name").value === "Studio plans",
      );
      check(
        "Simulated group name remains editable in review",
        await page.locator("#group-name").isEditable(),
      );
      await page.locator("dialog [data-close-dialog]").click();
    } else {
      if (mode === "inference-failure")
        await page.waitForFunction(
          async () =>
            (await (await import("./local-ai.mjs")).getCapabilities())
              .explanations.state === "error",
        );
      if (mode === "invalid-output") await page.waitForTimeout(100);
      check(
        `${mode}: measured fallback explanations remain complete`,
        matchReasons(await reasons(page), snapshot),
        await reasons(page),
      );
      if (!["inference-failure", "invalid-output"].includes(mode))
        check(
          `${mode}: passive state does not create a model`,
          (await mockStats(page)).createCalls === 0,
        );
    }
    await page.locator('[data-view="settings"]').first().click();
    const capabilities = await page.evaluate(async () =>
      (await import("./local-ai.mjs")).getCapabilities(),
    );
    if (mode === "inference-failure") {
      check(
        "Explanation inference failure is not labeled ready in the combined UI",
        !(await page.locator("#ai-status").innerText()).includes("ready"),
        { chip: await page.locator("#ai-status").innerText(), capabilities },
      );
    }
    await screen(page, mode);
    if (["unsupported", "availability-failure", "ready"].includes(mode))
      await audit(page, `${mode} AI settings`);
    report.scenarios.push({
      mode,
      simulated: true,
      capabilities,
      calls: await mockStats(page),
    });
    await page.close();
  }

  const setup = await open("setup");
  await setup.locator('[data-view="settings"]').first().click();
  await setup.locator("#setup-ai").waitFor();
  check(
    "Simulated downloadable model waits for explicit download action",
    (await mockStats(setup)).createCalls === 0,
  );
  await setup.locator("#setup-ai").click();
  await setup.waitForFunction(
    () => typeof __uiStateQA.resolveCreate === "function",
  );
  await setup.evaluate(() => __uiStateQA.emitProgress(0.5));
  await setup.locator(".progress-note").filter({ hasText: "50%" }).waitFor();
  await screen(setup, "download-progress");
  await setup.evaluate(() => __uiStateQA.emitProgress(1));
  await setup
    .locator(".progress-note")
    .filter({ hasText: /Preparing/ })
    .waitFor();
  const preparing = await setup.evaluate(async () =>
    (await import("./local-ai.mjs")).getCapabilities(),
  );
  check(
    "100% downloaded remains preparing until model creation resolves",
    preparing.names.state === "preparing" &&
      !(await setup.locator("#ai-status").innerText()).includes("ready"),
    preparing,
  );
  const setupStatusText = await setup
    .locator(".settings-section")
    .filter({ has: setup.locator("#toggle-ai") })
    .innerText();
  check(
    "Shared setup shows preparing for both capability labels without stale download-needed status",
    preparing.explanations.state === "preparing" &&
      !setupStatusText.includes("Explanation wording: Download needed"),
    setupStatusText,
  );
  await screen(setup, "preparing");
  await audit(setup, "Preparing AI settings");
  await setup.evaluate(() => __uiStateQA.resolveCreate());
  await setup.waitForFunction(
    async () =>
      (await (await import("./local-ai.mjs")).getCapabilities()).names.state ===
      "ready",
  );
  const readyAfterSetup = await setup.evaluate(async () =>
    (await import("./local-ai.mjs")).getCapabilities(),
  );
  check(
    "Simulated setup completion is ready without claiming successful inference",
    readyAfterSetup.names.lastInferenceAt === null &&
      readyAfterSetup.explanations.lastInferenceAt === null,
  );
  await screen(setup, "setup-complete");
  report.scenarios.push({
    mode: "download-to-preparing-to-ready",
    simulated: true,
    preparing,
    readyAfterSetup,
    calls: await mockStats(setup),
  });
  await setup.close();
  check(
    "No extension UI page exceptions",
    report.pageErrors.length === 0,
    report.pageErrors,
  );
  check(
    "No extension UI network requests",
    report.externalUIRequests.length === 0,
    report.externalUIRequests,
  );
} catch (error) {
  report.fatal = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  report.passed = report.checks.filter((c) => c.passed).length;
  report.failed = report.checks.filter((c) => !c.passed).length;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
  if (report.failed || report.fatal) process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        report: path.relative(root, reportPath),
        passed: report.passed,
        failed: report.failed,
        fatal: report.fatal?.message,
        findings: report.checks.filter((c) => !c.passed),
      },
      null,
      2,
    ),
  );
}
