import { chromium } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline/promises";

// This probe uses installed stable Chrome, not Chrome for Testing or Chromium.
// No real user profile, AI flags, policy changes, or preseeded model state.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = await mkdtemp(path.join(tmpdir(), "tabosmart-stable-ai-"));
const extensionPath = path.join(root, "extension");
const reportPath = path.join(root, "qa", "stable-ai-report.json");
const manualUI = process.argv.includes("--manual-ui");
const args = [
  `--user-data-dir=${profile}`,
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  ...(manualUI ? [] : [`--load-extension=${extensionPath}`]),
];
const report = {
  checkedAt: new Date().toISOString(),
  browser: "Installed Google Chrome stable",
  executablePath,
  extensionLoadMethod: manualUI
    ? "Normal Developer mode and Load unpacked UI"
    : "Attempted command-line sideload",
  temporaryIsolatedProfile: true,
  realUserProfileFilesAccessed: false,
  existingUserProfileModified: false,
  aiFeatureFlags: [],
  browserDefaultArgumentsOverridden: true,
  launchArguments: args.map((value) =>
    value.startsWith("--user-data-dir=")
      ? "--user-data-dir=<temporary isolated profile>"
      : value,
  ),
  extensionLoaded: false,
  extensionContextTested: false,
  modelDownloaded: false,
  actualInferenceTested: false,
  sources: [
    "https://playwright.dev/docs/chrome-extensions",
    "https://developer.chrome.com/docs/extensions/whats-new",
    "https://developer.chrome.com/docs/ai/prompt-api",
  ],
};
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: false,
    ignoreDefaultArgs: true,
    args,
    timeout: 25_000,
    viewport: { width: 1100, height: 780 },
  });
  const page = context.pages()[0] || (await context.newPage());
  const cdp = await context.newCDPSession(page);
  report.browserVersion = await cdp.send("Browser.getVersion");
  await page.goto("chrome://extensions/", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  if (manualUI) {
    console.log(
      JSON.stringify({
        status: "MANUAL_UI_READY",
        profile,
        title: await page.title(),
        url: page.url(),
        extensionPath,
      }),
    );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const response = await terminal.question(
      "Waiting for agent to load the extension through the normal Chrome UI. Send Enter or a JSON observation to probe.\n",
    );
    if (response.trim()) {
      try {
        report.manualUIObservations = JSON.parse(response);
      } catch {
        report.manualUIObservations = { note: response.slice(0, 1200) };
      }
    }
    terminal.close();
  }
  const worker =
    context
      .serviceWorkers()
      .find((item) => item.url().endsWith("/background.mjs")) ||
    (await context
      .waitForEvent("serviceworker", {
        predicate: (item) => item.url().endsWith("/background.mjs"),
        timeout: 8_000,
      })
      .catch(() => null));
  report.extensionManager = {
    url: page.url(),
    tabosmartItems: await page
      .locator("extensions-item")
      .filter({ hasText: "Tabosmart" })
      .count(),
    itemCount: await page.locator("extensions-item").count(),
    serviceWorkerURLs: context.serviceWorkers().map((item) => item.url()),
  };
  if (!worker) {
    report.outcome = manualUI
      ? "blocked-normal-ui-extension-load"
      : "blocked-extension-sideload";
    report.limitation =
      "Installed stable Chrome launched successfully but did not load Tabosmart through --load-extension. No Tabosmart extension item or background worker was present. Branded Chrome removed the command-line extension sideload route used by Playwright. This probe did not enable experimental loading workarounds or alter an existing profile.";
    if (manualUI)
      report.limitation =
        report.manualUIObservations?.blocker ||
        "The supported normal Chrome Developer mode and Load unpacked UI was attempted in an isolated profile, but no Tabosmart extension item or background worker was present after the UI attempt. See the task tool trace for the concrete UI limitation. No AI flags or existing profile changes were used.";
    report.conclusion =
      "Local AI support and inference in the installed stable Chrome extension context remain unverified. This result is an extension-loading limitation, not evidence that Chrome local AI is unsupported. Chrome for Testing results must not be substituted for this test.";
    report.nextVerification =
      "Load the unpacked extension using chrome://extensions in a separate normal Chrome profile, then check Local AI in the extension UI. Model setup must be an explicit button click. No AI feature flags are part of the normal install instructions.";
  } else {
    report.extensionLoaded = true;
    const extensionId = new URL(worker.url()).hostname;
    const ui = await context.newPage();
    await ui.goto(`chrome-extension://${extensionId}/index.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    report.extensionContextTested = true;
    report.actualCapabilities = await ui.evaluate(async () => {
      const ai = await import("./local-ai.mjs");
      return ai.getCapabilities();
    });
    if (report.actualCapabilities.names.state === "ready") {
      report.inference = await ui.evaluate(async () => {
        const ai = await import("./local-ai.mjs");
        const tabs = [
          { title: "Gardening soil guide" },
          { title: "Gardening soil preparation" },
        ];
        const reason =
          "3 ungrouped tabs are from example.test in the same window.";
        const name = await ai.suggestName(tabs);
        const explanation = await ai.enhanceExplanation({
          id: "stable-fixture",
          reason,
          tabs: [],
          explanationVariants: [
            reason,
            "This window contains 3 ungrouped tabs from example.test.",
          ],
        });
        return {
          name,
          explanation,
          capabilitiesAfter: await ai.getCapabilities(),
        };
      });
      report.actualInferenceTested = true;
      report.outcome =
        report.inference.name && report.inference.explanation
          ? "actual-inference-completed"
          : "actual-inference-attempted-with-fallback";
    } else {
      report.outcome = "actual-capability-observed-without-inference";
      report.conclusion =
        "The actual installed Chrome extension context was checked. No model download was started. The observed capability is recorded without diagnosing its cause.";
    }
  }
} catch (error) {
  report.outcome = "probe-error";
  report.error = String(error?.message || error)
    .replaceAll(profile, "<temporary isolated profile>")
    .slice(0, 1600);
  report.conclusion =
    "The stable Chrome extension-context AI test did not complete. No AI support or inference claim can be made from this probe.";
} finally {
  if (context) await context.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
  report.temporaryProfileRemoved = true;
  report.completedAt = new Date().toISOString();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outcome: report.outcome,
        extensionLoaded: report.extensionLoaded,
        version: report.browserVersion?.product,
        reportPath,
      },
      null,
      2,
    ),
  );
}
