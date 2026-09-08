import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPreviewServer } from "./preview-server.mjs";
import {
  createState,
  observeTabs,
  makeSnapshot,
  DAY,
} from "../extension/core.mjs";
import { rememberGroupingChoice } from "../extension/grouping-context.mjs";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, "qa/preview-integration-report.json");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "extension/manifest.json"), "utf8"),
);
const report = {
  date: new Date().toISOString(),
  sourceVersion: manifest.version,
  evidence:
    "Synthetic HTTP source integration only. The actual app, Local AI module, and watcher run from localhost; all chrome.runtime and LanguageModel interfaces are mocked by an initialization script.",
  boundary:
    "No extension was installed, no real extension URL or personal browser profile was accessed, and no actual AI model download or inference was attempted. This is not a workaround for or substitute for blocked real-Chrome verification.",
  timing:
    "Inference-timeout scenarios intercept only the module's 15-second and 30-second watchdog timers and fire them explicitly. All inference and capability results are synthetic; no real model is used.",
  sourceHashes: {},
  scenarios: [],
  checks: [],
  pageErrors: [],
  unexpectedRequests: [],
  accessibility: [],
  screenshots: [],
  engineFixtures: {},
};
for (const file of [
  "app.mjs",
  "local-ai.mjs",
  "ai-status-watch.mjs",
  "proactive-names.mjs",
  "core.mjs",
  "topic-evidence.mjs",
  "metadata-groups.mjs",
  "grouping-context.mjs",
  "existing-group-matches.mjs",
  "group-discovery.mjs",
  "proactive-discovery.mjs",
])
  report.sourceHashes[file] = createHash("sha256")
    .update(await fs.readFile(path.join(root, "extension", file)))
    .digest("hex");

// Real deterministic engine output, populated exclusively with synthetic tabs.
// UI tests never fabricate scan counts or assert a real browser was observed.
function engineFixture(kind = "actionable", groupFirst = false) {
  const now = Date.now(),
    count = kind === "empty" ? 0 : 100;
  const state = createState(now - 10 * DAY);
  state.settings.enabled = !["initial", "paused"].includes(kind);
  state.settings.aiEnabled = false;
  state.settings.aiPreferenceSource = "user";
  state.consentAt = kind === "initial" ? null : now - 10 * DAY;
  const tabs = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `Page ${index + 1}`,
    url: `https://page${index + 1}.preview.invalid/fixture`,
    windowId: 7,
    index,
    groupId: kind === "grouped" ? 42 : -1,
    pinned: false,
    active: false,
    audible: false,
    incognito: false,
  }));
  if (kind === "actionable") {
    for (const tab of tabs.slice(0, 10)) {
      tab.title = `Garden studio project ${tab.id}`;
      tab.url = `https://garden.preview.invalid/plan/${tab.id}`;
    }
    for (const tab of tabs.slice(10, 14))
      tab.url = "https://reference.preview.invalid/duplicate?exact=1#kept";
  }
  if (kind === "many")
    for (const tab of tabs) {
      const pair = Math.floor((tab.id - 1) / 2);
      tab.title = `Archive${pair} Study${pair} ${tab.id}`;
      tab.url = `https://collection${pair}.preview.invalid/${tab.id}`;
    }
  if (kind === "guarded")
    for (const tab of tabs) state.protectedUrls[tab.url] = now;
  if (groupFirst) for (const tab of tabs.slice(0, 10)) tab.groupId = 42;
  observeTabs(state, tabs, kind === "actionable" ? now - 10 * DAY : now);
  state.evaluation = {
    state: "idle",
    checkedAt: now,
    requestedAt: null,
    error: null,
  };
  const historyFacts =
    kind === "many"
      ? Object.fromEntries(
          tabs.map((tab) => [
            tab.url,
            {
              visits: tab.id,
              recentVisits: tab.id,
              lastVisitTime: now - 3600000,
              partial: false,
            },
          ]),
        )
      : {};
  const snapshot = {
    ok: true,
    ...makeSnapshot(state, tabs, now, historyFacts),
  };
  report.engineFixtures[kind + (groupFirst ? "AfterGroup" : "")] =
    snapshot.evaluationSummary;
  return snapshot;
}

const publicNews = JSON.parse(
  await fs.readFile(
    path.join(root, "tests/fixtures/public-news-metadata.json"),
    "utf8",
  ),
);
function newsFixture(
  english = false,
  preference = "auto",
  existingGroup = false,
) {
  const now = Date.now(),
    state = createState(now);
  state.settings.enabled = true;
  state.settings.groupNameLanguage = preference;
  state.settings.aiEnabled = true;
  state.consentAt = now;
  const pages = english
    ? [
        {
          url: "https://xeno-lab.test/",
          title: "Restoring a vintage theremin oscillator",
        },
        {
          url: "https://yarrow-workshop.test/",
          title: "Repairing heterodyne pitch circuitry",
        },
        {
          url: "https://zircon-design.test/",
          title: "Electrodes for contactless musical instruments",
        },
      ]
    : publicNews.pages.slice(0, 4);
  const tabs = pages.map((p, i) => ({
    id: i + 1,
    title: p.title || "Alfa.lt",
    url: p.url,
    windowId: 7,
    groupId: existingGroup && i < 2 ? 84 : -1,
    index: i,
    active: false,
    pinned: false,
    audible: false,
    incognito: false,
  }));
  observeTabs(state, tabs, now);
  state.evaluation = { state: "idle", checkedAt: now };
  const nativeGroups = existingGroup
    ? [{ id: 84, title: "Mano naujienos", windowId: 7 }]
    : [];
  return {
    ok: true,
    ...makeSnapshot(state, tabs, now, {}, [], nativeGroups),
    nativeGroups,
    history: {
      state: "ready",
      indexedURLs: tabs.length,
      processedURLs: tabs.length,
      analyzedVisits: tabs.length,
    },
  };
}

function rememberedFixture() {
  const now = Date.now(),
    state = createState(now);
  state.settings.enabled = true;
  state.settings.aiEnabled = true;
  state.settings.groupNameLanguage = "en";
  state.consentAt = now;
  const tabs = [
    {
      id: 51,
      title: "Flights to Kyoto",
      url: "https://flights.preview.invalid/kyoto",
    },
    {
      id: 52,
      title: "Map of Kyoto",
      url: "https://maps.preview.invalid/kyoto",
    },
  ].map((tab, index) => ({
    ...tab,
    windowId: 7,
    groupId: -1,
    index,
    active: false,
    pinned: false,
    audible: false,
    incognito: false,
  }));
  observeTabs(state, tabs, now);
  rememberGroupingChoice(state.groupingContext, tabs, "Autumn escape", now);
  state.evaluation = { state: "idle", checkedAt: now };
  return { ok: true, ...makeSnapshot(state, tabs, now) };
}

function installMocks({
  initialModelState,
  nameBehavior = "success",
  wordingBehavior = "success",
  virtualWatchdogs = false,
  availabilityFailure = false,
  initiallyConsented = true,
  aiEnabled = true,
  aiPreferenceSource = "default",
  holdConsent = false,
  holdNamePrompts = false,
  nameOutput = "Studio plans",
  discoveryOutput = { groups: [] },
  holdDiscovery = false,
  sourceSnapshot = null,
  holdSnapshot = false,
  groupWarning = null,
  groupSnapshot = null,
}) {
  const stamp = Date.now();
  const titles = [
    "Garden studio plans",
    "Garden studio materials",
    "Garden studio budget",
  ];
  const tabs = titles.map((title, index) => ({
    id: index + 1,
    title: `Tabosmart QA · ${title}`,
    url: `https://qa.invalid/garden-studio/${index + 1}`,
    domain: "qa.invalid",
    windowId: 7,
    index,
    groupId: -1,
    pinned: false,
    active: false,
    audible: false,
    protected: false,
    firstSeenAt: stamp,
    firstSeenThisSessionAt: stamp,
    lastUsedAt: null,
    urlLastUsedAt: null,
    urlVisitCount: 0,
    visitCount: 0,
    inactivityDays: 0,
    historySource: "current-session",
    reviewReady: true,
  }));
  const reason = "3 ungrouped tabs are from qa.invalid in the same window.";
  const alternate = "This window contains 3 ungrouped tabs from qa.invalid.";
  const suggestion = {
    id: "mock-garden-group",
    type: "group",
    signal: "site",
    title: "Bring Garden studio together",
    reason,
    explanationVariants: [reason, alternate],
    proposedName: "Garden studio",
    tabIds: tabs.map((tab) => tab.id),
    tabs,
    createdAt: stamp,
  };
  const initial = {
    ok: true,
    tabs: initiallyConsented ? tabs : [],
    suggestions: initiallyConsented ? [suggestion] : [],
    saved: initiallyConsented
      ? [
          {
            id: "mock-shelf",
            title: "Synthetic saved list",
            createdAt: stamp,
            tabs: [
              { id: "0", title: titles[0], url: tabs[0].url, status: "saved" },
            ],
          },
        ]
      : [],
    recovery: [],
    settings: {
      enabled: initiallyConsented,
      aiEnabled,
      aiPreferenceSource,
      inactivityDays: 7,
      historyEnabled: true,
    },
    consentAt: initiallyConsented ? stamp : null,
    evaluation: {
      state: "idle",
      checkedAt: stamp,
      requestedAt: null,
      error: null,
    },
    stats: {
      observedTabs: initiallyConsented ? tabs.length : 0,
      protectedTabs: 0,
      trackingSince: stamp,
    },
    now: stamp,
  };
  if (sourceSnapshot) Object.assign(initial, sourceSnapshot);
  const state = {
    snapshot: structuredClone(initial),
    originalReason: reason,
    alternateReason: alternate,
    modelState: initialModelState,
    availabilityCalls: 0,
    createCalls: 0,
    promptCalls: 0,
    destroyCalls: 0,
    abortBeforeCreateResolved: 0,
    runtimeCalls: [],
    ports: [],
    closeError: false,
    createRecords: [],
    createEvents: [],
    prompts: [],
    holdNamePrompts,
    holdConsent,
    resolveConsent: null,
    nameOutput,
    discoveryOutput,
    holdDiscovery,
    pendingDiscovery: [],
    discoveredGroups: [],
    pendingNames: [],
    promptOutput: "1",
    nameBehavior,
    wordingBehavior,
    virtualWatchdogs,
    availabilityFailure,
    watchdogs: new Map(),
    holdSnapshot,
    resolveSnapshot: null,
  };
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  let virtualTimerId = -1;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (state.virtualWatchdogs && [15_000, 30_000].includes(delay)) {
      const id = virtualTimerId--;
      state.watchdogs.set(id, { delay, callback: () => callback(...args) });
      return id;
    }
    return realSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (id) => {
    if (state.watchdogs.has(id)) state.watchdogs.delete(id);
    else realClearTimeout(id);
  };
  state.fireWatchdog = (delay) => {
    for (const [id, timer] of [...state.watchdogs])
      if (timer.delay === delay) {
        state.watchdogs.delete(id);
        timer.callback();
      }
  };
  const listeners = [];
  const cloneSnapshot = () => {
    state.snapshot.now = Date.now();
    return structuredClone(state.snapshot);
  };
  state.emitMessage = (message) =>
    listeners.forEach((listener) => listener(message));
  state.externalAIoff = () => {
    state.snapshot.settings.aiEnabled = false;
    state.snapshot.settings.aiPreferenceSource = "user";
    state.emitMessage({ type: "snapshotChanged" });
  };
  state.emitProgress = (fraction) =>
    state.createRecords
      .filter((record) => !record.resolved)
      .forEach((record) => record.progress?.({ loaded: fraction, total: 1 }));
  state.resolveCreate = () => {
    state.modelState = "available";
    for (const record of state.createRecords)
      if (!record.resolved) {
        record.resolved = true;
        record.resolve(session());
      }
  };
  state.resolveNames = (value) => {
    for (const resolve of state.pendingNames.splice(0)) resolve(value);
  };
  const session = () => ({
    destroy() {
      state.destroyCalls++;
    },
    prompt(text) {
      state.promptCalls++;
      const kind = text.includes("UNTRUSTED_DISCOVERY_METADATA_JSON")
        ? "discovery"
        : text.includes("UNTRUSTED_GROUP_METADATA_JSON")
          ? "names"
          : "explanations";
      state.prompts.push({ kind, text, consentAt: state.snapshot.consentAt });
      if (kind === "discovery") {
        if (state.holdDiscovery)
          return new Promise((resolve) => state.pendingDiscovery.push(resolve));
        return Promise.resolve(JSON.stringify(state.discoveryOutput));
      }
      if (kind === "names") {
        if (state.nameBehavior === "fail")
          return Promise.reject(
            new DOMException(
              "Synthetic naming request failure",
              "NotAllowedError",
            ),
          );
        if (state.nameBehavior === "hang") return new Promise(() => {});
        if (state.holdNamePrompts)
          return new Promise((resolve) => state.pendingNames.push(resolve));
        return Promise.resolve(state.nameOutput);
      }
      if (state.wordingBehavior === "fail")
        return Promise.reject(
          new DOMException(
            "Synthetic wording request failure",
            "NotAllowedError",
          ),
        );
      if (state.wordingBehavior === "hang") return new Promise(() => {});
      return Promise.resolve(state.promptOutput);
    },
  });
  Object.defineProperty(globalThis, "LanguageModel", {
    configurable: true,
    value: {
      availability() {
        state.availabilityCalls++;
        if (state.availabilityFailure)
          return Promise.reject(
            new Error("Synthetic passive availability check failure"),
          );
        return Promise.resolve(state.modelState);
      },
      create(options) {
        state.createCalls++;
        state.createEvents.push({
          consentAt: state.snapshot.consentAt,
          userActivation: navigator.userActivation?.isActive,
          promptCalls: state.promptCalls,
          options: { initialPrompts: options.initialPrompts },
        });
        if (state.modelState === "available") return Promise.resolve(session());
        state.modelState = "downloading";
        const record = {
          resolved: false,
          progress: null,
          resolve: null,
          signal: options.signal,
        };
        options.monitor?.({
          addEventListener(name, listener) {
            if (name === "downloadprogress") record.progress = listener;
          },
        });
        options.signal?.addEventListener("abort", () => {
          if (!record.resolved) state.abortBeforeCreateResolved++;
        });
        state.createRecords.push(record);
        // Intentionally allow late fulfillment after cancellation to test stale-result guards.
        return new Promise((resolve) => {
          record.resolve = resolve;
        });
      },
    },
  });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        connect(options) {
          const messages = [],
            messageListeners = [],
            disconnectListeners = [];
          const port = {
            name: options.name,
            messages,
            disconnected: false,
            onMessage: {
              addListener(listener) {
                messageListeners.push(listener);
              },
            },
            onDisconnect: {
              addListener(listener) {
                disconnectListeners.push(listener);
              },
            },
            postMessage(message) {
              messages.push(structuredClone(message));
            },
            request() {
              messageListeners.forEach((fn) =>
                fn({ type: "requestAIActivity" }),
              );
            },
            disconnect() {
              if (port.disconnected) return;
              port.disconnected = true;
              disconnectListeners.forEach((fn) => fn());
            },
          };
          state.ports.push(port);
          return port;
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
        },
        async sendMessage(message) {
          state.runtimeCalls.push(structuredClone(message));
          if (message.type === "snapshot" && state.holdSnapshot) {
            state.holdSnapshot = false;
            state.snapshot.evaluation = {
              ...state.snapshot.evaluation,
              state: "checking",
              phase: "queued",
              requestedAt: Date.now(),
              error: null,
            };
            state.emitMessage({ type: "snapshotChanged" });
            await new Promise((resolve) => {
              state.resolveSnapshot = resolve;
            });
          }
          if (["snapshot", "cachedSnapshot"].includes(message.type))
            return cloneSnapshot();
          if (message.type === "discoverGroups") {
            const { createState, observeTabs, makeSnapshot } =
              await import("/core.mjs");
            const { discoveryKey } = await import("/group-discovery.mjs");
            if (message.key !== discoveryKey(state.snapshot))
              return { ok: false, error: "Stale metadata" };
            const engine = createState(Date.now());
            engine.settings = {
              ...engine.settings,
              ...state.snapshot.settings,
            };
            engine.consentAt = state.snapshot.consentAt;
            observeTabs(engine, state.snapshot.tabs, Date.now());
            state.discoveredGroups.push(...message.groups);
            state.snapshot = {
              ...state.snapshot,
              ...makeSnapshot(
                engine,
                state.snapshot.tabs,
                Date.now(),
                {},
                state.discoveredGroups,
                state.snapshot.nativeGroups || [],
              ),
            };
            return cloneSnapshot();
          }
          if (message.type === "closeWorkspace")
            return state.closeError
              ? { ok: false, error: "Synthetic close failed. Try again." }
              : { ok: true, closed: true };
          if (message.type === "dismissDisclosure") {
            state.snapshot.installDisclosure = false;
            return cloneSnapshot();
          }
          if (message.type === "retryHistory") {
            state.snapshot.history = {
              state: "indexing",
              processedURLs: 0,
              analyzedVisits: 0,
              indexedURLs: 0,
            };
            return cloneSnapshot();
          }
          if (message.type === "settings") {
            if (message.patch.enabled === true && state.holdConsent) {
              await new Promise((resolve) => {
                state.resolveConsent = resolve;
              });
              state.holdConsent = false;
            }
            Object.assign(state.snapshot.settings, message.patch);
            if (message.patch.historyEnabled === false)
              state.snapshot.history = {
                state: "off",
                processedURLs: 0,
                analyzedVisits: 0,
                indexedURLs: 0,
              };
            if (typeof message.patch.aiEnabled === "boolean")
              state.snapshot.settings.aiPreferenceSource = "user";
            if (message.patch.enabled === true) {
              state.snapshot.consentAt ||= Date.now();
              state.snapshot.tabs = structuredClone(tabs);
              state.snapshot.suggestions = [structuredClone(suggestion)];
              state.snapshot.stats.observedTabs = tabs.length;
            }
            return cloneSnapshot();
          }
          if (message.type === "group") {
            const target = state.snapshot.suggestions.find(
              (suggestion) => suggestion.id === message.suggestionId,
            )?.targetGroup;
            const groupId = target?.id ?? 42;
            state.snapshot.tabs.forEach((tab) => {
              if (message.tabIds.includes(tab.id)) tab.groupId = groupId;
            });
            state.snapshot.suggestions = [];
            if (groupSnapshot) state.snapshot = structuredClone(groupSnapshot);
            return {
              ...cloneSnapshot(),
              action: {
                type: "group",
                groupId,
                tabIds: message.tabIds,
                message:
                  "Synthetic group acknowledgment. No real browser tabs changed.",
                ...(groupWarning ? { warning: groupWarning } : {}),
              },
            };
          }
          if (message.type === "clearData") {
            state.snapshot = {
              ...structuredClone(initial),
              tabs: [],
              suggestions: [],
              saved: [],
              recovery: [],
              consentAt: null,
              settings: {
                enabled: false,
                aiEnabled: true,
                aiPreferenceSource: "default",
                inactivityDays: 7,
                historyEnabled: false,
              },
              stats: {
                observedTabs: 0,
                protectedTabs: 0,
                trackingSince: Date.now(),
              },
            };
            return cloneSnapshot();
          }
          return {
            ok: false,
            error: `Unexpected mocked runtime request: ${message.type}`,
          };
        },
      },
    },
  });
  globalThis.__previewIntegrationQA = state;
}

let browser;
const preview = await createPreviewServer(root);
const allowedOrigin = new URL(preview.url).origin;
function check(scenario, name, passed, detail) {
  report.checks.push({
    scenario,
    name,
    passed: !!passed,
    ...(detail === undefined ? {} : { detail }),
  });
  if (!passed) throw new Error(name);
}
async function chip(page, text) {
  await page.waitForFunction(
    (text) => document.querySelector("#ai-status")?.textContent.includes(text),
    text,
    { timeout: 9000 },
  );
}
async function settings(page) {
  await page.locator('[data-view="settings"]').click();
}
async function beginSetup(page) {
  await settings(page);
  await page.waitForFunction(() =>
    document
      .querySelector("#setup-ai")
      ?.textContent.includes("Download local model"),
  );
  await page.locator("#setup-ai").click();
  await page.waitForFunction(
    () => globalThis.__previewIntegrationQA.createRecords.length > 0,
  );
  await page.evaluate(() =>
    globalThis.__previewIntegrationQA.emitProgress(0.25),
  );
  await chip(page, "downloading");
}
async function audit(page, name, assert) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  const violations = result.violations.map(
    ({ id, impact, description, nodes }) => ({
      id,
      impact,
      description,
      targets: nodes.map((node) => node.target),
    }),
  );
  report.accessibility.push({ name, violations });
  assert(
    "new outcome surface has no accessibility violations",
    violations.length === 0,
    violations,
  );
}
async function scenario(name, mode, run) {
  console.log(`Scenario: ${name}`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(7000);
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === allowedOrigin)
      return route.continue();
    report.unexpectedRequests.push({
      scenario: name,
      url: route.request().url(),
    });
    return route.abort();
  });
  await context.addInitScript(
    installMocks,
    typeof mode === "string"
      ? { initialModelState: mode }
      : { initialModelState: "available", ...mode },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    report.pageErrors.push({ scenario: name, error: error.message }),
  );
  const started = Date.now();
  try {
    await page.goto(preview.url);
    await page.waitForSelector(
      (typeof mode === "object" && mode.readySelector) ||
        (typeof mode === "object" && mode.initiallyConsented === false
          ? "#start"
          : ".suggestion-card"),
    );
    await run(page, (label, result, detail) =>
      check(name, label, result, detail),
    );
    report.scenarios.push({
      name,
      passed: true,
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    report.scenarios.push({
      name,
      passed: false,
      elapsedMs: Date.now() - started,
      error: error.message,
      visibleText: await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    });
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  report.browser = await browser.version();
  await scenario(
    "late inventory responses cannot replace newer tab counts",
    { sourceSnapshot: engineFixture("actionable") },
    async (page, assert) => {
      await page.evaluate(() => {
        const qa = __previewIntegrationQA;
        qa.originalTabs = structuredClone(qa.snapshot.tabs);
        qa.snapshot.snapshotRevision = 20;
        qa.snapshot.tabs = qa.originalTabs.slice(0, 98);
        qa.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForFunction(
        () => document.querySelector("#tab-count").textContent === "98",
      );
      await page.evaluate(() => {
        const qa = __previewIntegrationQA;
        qa.snapshot.snapshotRevision = 19;
        qa.snapshot.tabs = qa.originalTabs;
        qa.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForTimeout(100);
      assert(
        "older response does not restore removed tabs to the count",
        (await page.locator("#tab-count").innerText()) === "98",
      );
      await page.evaluate(() => {
        const qa = __previewIntegrationQA;
        qa.snapshot.snapshotRevision = 21;
        qa.snapshot.tabs = qa.originalTabs.slice(0, 97);
        qa.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForFunction(
        () => document.querySelector("#tab-count").textContent === "97",
      );
      assert(
        "a subsequent newer response still updates inventory",
        (await page.locator("#tab-count").innerText()) === "97",
      );
    },
  );
  await scenario(
    "restarting erased workspace separates setup gesture from metadata consent",
    {
      initialModelState: "downloadable",
      initiallyConsented: false,
      holdConsent: true,
    },
    async (page, assert) => {
      await chip(page, "setup available");
      assert(
        "fresh onboarding checks AI by default and exposes the choice",
        await page.locator("#start-ai").isChecked(),
      );
      assert(
        "before consent the welcome surface does not imply a completed or active scan",
        (await page.locator("#workspace-check").count()) === 0 &&
          (await page.locator(".suggestion-card").count()) === 0,
      );
      assert(
        "no metadata or model creation occurs before the Start gesture",
        await page.evaluate(
          () =>
            !__previewIntegrationQA.snapshot.consentAt &&
            !__previewIntegrationQA.snapshot.settings.enabled &&
            __previewIntegrationQA.snapshot.tabs.length === 0 &&
            __previewIntegrationQA.snapshot.suggestions.length === 0 &&
            __previewIntegrationQA.createCalls === 0 &&
            __previewIntegrationQA.promptCalls === 0,
        ),
      );
      await page.locator("#start").click();
      await page.waitForFunction(
        () =>
          __previewIntegrationQA.createRecords.length === 1 &&
          typeof __previewIntegrationQA.resolveConsent === "function",
      );
      assert(
        "setup begins inside the disclosed gesture before delayed consent response, without tab metadata",
        await page.evaluate(
          () =>
            __previewIntegrationQA.createEvents[0].userActivation === true &&
            __previewIntegrationQA.createEvents[0].consentAt === null &&
            __previewIntegrationQA.promptCalls === 0 &&
            __previewIntegrationQA.snapshot.tabs.length === 0 &&
            !JSON.stringify(
              __previewIntegrationQA.createEvents[0].options,
            ).includes("Garden studio"),
        ),
      );
      await page.evaluate(() => {
        __previewIntegrationQA.emitProgress(0.25);
        __previewIntegrationQA.resolveConsent();
      });
      await page.waitForSelector(".suggestion-card");
      await chip(page, "downloading");
      assert(
        "consented workspace renders deterministic names while setup continues",
        (await page.locator("[data-group-name]").innerText()) ===
          "Garden studio",
      );
      await page.evaluate(() => __previewIntegrationQA.resolveCreate());
      await page.waitForFunction(
        () =>
          document.querySelector("[data-group-name]")?.textContent ===
          "Studio plans",
      );
      assert(
        "proactive metadata requests start only after successful consent and model readiness",
        await page.evaluate(
          () =>
            __previewIntegrationQA.prompts.length > 0 &&
            __previewIntegrationQA.prompts.every(
              (prompt) => !!prompt.consentAt,
            ) &&
            __previewIntegrationQA.prompts.some(
              (prompt) =>
                prompt.kind === "names" &&
                prompt.text.includes('"signal":"site"') &&
                prompt.text.includes('"domain":"qa.invalid"'),
            ),
        ),
      );
    },
  );
  await scenario(
    "fresh onboarding can opt out and legacy ambiguous opt-out stays off",
    { initiallyConsented: false },
    async (page, assert) => {
      await chip(page, "ready");
      await page.locator("#start-ai").uncheck();
      await page.locator("#start").click();
      await page.waitForSelector(".suggestion-card");
      await chip(page, "off");
      assert(
        "onboarding opt-out persists an explicit choice and runs no model",
        await page.evaluate(
          () =>
            __previewIntegrationQA.snapshot.settings.aiEnabled === false &&
            __previewIntegrationQA.snapshot.settings.aiPreferenceSource ===
              "user" &&
            __previewIntegrationQA.createCalls === 0 &&
            __previewIntegrationQA.promptCalls === 0,
        ),
      );
    },
  );
  await scenario(
    "legacy false preference survives unrelated settings changes",
    { aiEnabled: false, aiPreferenceSource: "legacy-unknown" },
    async (page, assert) => {
      await chip(page, "off");
      assert(
        "legacy opt-out displays deterministic naming without AI provenance",
        (await page.locator("[data-group-name]").innerText()) ===
          "Garden studio" &&
          (await page.locator(".ai-name-badge").count()) === 0,
      );
      await settings(page);
      await page.locator("#inactivity-days").selectOption("14");
      await page.waitForFunction(
        () => __previewIntegrationQA.snapshot.settings.inactivityDays === 14,
      );
      assert(
        "unrelated preference edits preserve ambiguous legacy off and do no inference",
        await page.evaluate(
          () =>
            !__previewIntegrationQA.snapshot.settings.aiEnabled &&
            __previewIntegrationQA.snapshot.settings.aiPreferenceSource ===
              "legacy-unknown" &&
            __previewIntegrationQA.createCalls === 0 &&
            __previewIntegrationQA.promptCalls === 0,
        ),
      );
    },
  );
  await scenario(
    "proactive names replace immediate fallback with accessible provenance",
    { holdNamePrompts: true },
    async (page, assert) => {
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingNames.length === 1,
      );
      assert(
        "pending naming leaves an immediate unbadged fallback and measured explanation",
        await page.evaluate(
          () =>
            document.querySelector("[data-group-name]").textContent ===
              "Garden studio" &&
            document.querySelector("[data-reason]").textContent ===
              __previewIntegrationQA.originalReason &&
            !document.querySelector(".ai-name-badge"),
        ),
      );
      assert(
        "the AI activity note reflects an actual pending naming request without blocking review",
        (
          await page.locator("#workspace-check .check-ai-note").innerText()
        ).includes("AI is finding useful names") &&
          (await page.locator("[data-review]").isEnabled()),
      );
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio plans"),
      );
      await page.waitForFunction(
        () =>
          document.querySelector("[data-group-name]")?.textContent ===
          "Studio plans",
      );
      await page.waitForFunction(
        () =>
          !document
            .querySelector("#workspace-check .check-ai-note")
            ?.textContent.includes("finding useful names"),
      );
      assert(
        "automatic name updates the card with an accessible AI mark",
        (await page.locator("[data-group-title]").innerText()) ===
          "Studio plans" &&
          (await page.getByText("AI suggested", { exact: true }).count()) === 1,
      );
      await page.locator("[data-review]").click();
      assert(
        "review opens with the completed AI name and a plainly labelled Rename action",
        (await page.locator("#group-name").inputValue()) === "Studio plans" &&
          (await page.locator("#ai-name").innerText()).trim() === "Rename" &&
          (await page
            .getByRole("button", { name: "Rename with AI assistance" })
            .count()) === 1 &&
          (await page.locator('#ai-name svg[aria-hidden="true"]').count()) ===
            1,
      );
      await audit(page, "proactive AI name and Rename review control", assert);
    },
  );
  await scenario(
    "review freeze and manual edits survive late automatic and explicit names",
    { holdNamePrompts: true },
    async (page, assert) => {
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingNames.length === 1,
      );
      await page.locator("[data-review]").click();
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio plans"),
      );
      await page.waitForTimeout(100);
      assert(
        "opening review freezes the fallback against a late automatic result",
        (await page.locator("#group-name").inputValue()) === "Garden studio" &&
          (await page
            .locator("#review-name-provenance .ai-name-badge")
            .count()) === 0,
      );
      await page.locator("#ai-name").click();
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingNames.length === 1,
      );
      await page.locator("#group-name").fill("My weekend workspace");
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio materials"),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#toast")
          ?.textContent.includes("Kept your edited name"),
      );
      assert(
        "explicit Rename preserves a user edit made during inference",
        (await page.locator("#group-name").inputValue()) ===
          "My weekend workspace" &&
          (await page
            .locator("#review-name-provenance .ai-name-badge")
            .count()) === 0,
      );
    },
  );
  await scenario(
    "changed review selection and stale tab metadata reject pending names",
    { holdNamePrompts: true },
    async (page, assert) => {
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingNames.length === 1,
      );
      await page.locator("[data-review]").click();
      await page.locator("#ai-name").click();
      await page.locator('[data-tab-check="3"]').uncheck();
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio materials"),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#toast")
          ?.textContent.includes("selected tabs changed"),
      );
      assert(
        "selection changes invalidate an in-flight name instead of relabelling the review",
        (await page.locator("#group-name").inputValue()) === "Garden studio" &&
          (await page
            .locator("#review-name-provenance .ai-name-badge")
            .count()) === 0,
      );
      await page.locator("#ai-name").click();
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingNames.length === 1,
      );
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.tabs[0].url += "?changed=1";
        __previewIntegrationQA.snapshot.suggestions[0].tabs[0].title =
          "Garden studio revised plans";
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForTimeout(50);
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio materials"),
      );
      await page.waitForFunction(
        () =>
          document.querySelector("#ai-name")?.getAttribute("aria-busy") ===
          "false",
      );
      assert(
        "updated live metadata invalidates the old review name request",
        (await page.locator("#group-name").inputValue()) === "Garden studio" &&
          (await page
            .locator("#review-name-provenance .ai-name-badge")
            .count()) === 0,
      );
    },
  );
  await scenario(
    "stale proactive result and AI disable cannot relabel a current card",
    { holdNamePrompts: true },
    async (page, assert) => {
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingNames.length === 1,
      );
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.tabs[0].title =
          "Garden studio revised plans";
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForTimeout(50);
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio plans"),
      );
      await page.waitForFunction(
        () =>
          __previewIntegrationQA.prompts.filter(
            (prompt) => prompt.kind === "names",
          ).length === 2 && __previewIntegrationQA.pendingNames.length === 1,
      );
      assert(
        "old metadata result is discarded while the current proposal gets its own request",
        (await page.locator("[data-group-name]").innerText()) ===
          "Garden studio" &&
          (await page.locator(".ai-name-badge").count()) === 0,
      );
      await page.evaluate(() => __previewIntegrationQA.externalAIoff());
      await chip(page, "off");
      const creates = await page.evaluate(
        () => __previewIntegrationQA.createCalls,
      );
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio materials"),
      );
      await page.waitForTimeout(100);
      assert(
        "turning AI off invalidates pending proactive naming and removes provenance",
        (await page.locator("[data-group-name]").innerText()) ===
          "Garden studio" &&
          (await page.locator(".ai-name-badge").count()) === 0 &&
          (await page.evaluate(
            (before) => __previewIntegrationQA.createCalls === before,
            creates,
          )),
      );
    },
  );
  await scenario(
    "equivalent AI wording remains an unbadged deterministic name",
    { nameOutput: "Garden studio" },
    async (page, assert) => {
      await page.waitForFunction(
        () =>
          document.querySelector("[data-reason]")?.textContent ===
          __previewIntegrationQA.alternateReason,
      );
      assert(
        "an unchanged model name does not acquire AI provenance",
        (await page.locator("[data-group-name]").innerText()) ===
          "Garden studio" &&
          (await page.locator(".ai-name-badge").count()) === 0,
      );
      await page.locator("[data-review]").click();
      await page.locator("#ai-name").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#ai-name")?.getAttribute("aria-busy") ===
          "false",
      );
      assert(
        "manual equivalent result leaves the existing name and no AI label",
        (await page.locator("#group-name").inputValue()) === "Garden studio" &&
          (await page
            .locator("#review-name-provenance .ai-name-badge")
            .count()) === 0,
      );
    },
  );
  await scenario(
    "passive existing download becomes ready",
    "downloading",
    async (page, assert) => {
      await chip(page, "downloading");
      await settings(page);
      const before = await page.evaluate(() => ({
        calls: __previewIntegrationQA.availabilityCalls,
        creates: __previewIntegrationQA.createCalls,
      }));
      assert(
        "passive inspection does not create a model",
        before.creates === 0,
      );
      await page.evaluate(() => {
        __previewIntegrationQA.modelState = "available";
      });
      await chip(page, "ready");
      const after = await page.evaluate(() => ({
        calls: __previewIntegrationQA.availabilityCalls,
        creates: __previewIntegrationQA.createCalls,
      }));
      assert(
        "watcher updates readiness without reload, focus event, or manual refresh",
        after.calls > before.calls && after.creates === 0,
        { before, after },
      );
      assert(
        "settings show both ready capabilities",
        (await page.locator(".group-readiness").innerText()).includes(
          "Group names: Ready on this device · Explanation wording: Ready on this device",
        ),
      );
    },
  );
  await scenario(
    "setup survives review close and harmless mocked group",
    "downloadable",
    async (page, assert) => {
      await beginSetup(page);
      await page.locator('[data-view="suggestions"]').click();
      await page.locator("[data-review]").click();
      await page.locator("#review-dialog [data-close-dialog]").click();
      assert(
        "closing review leaves setup pending",
        await page.evaluate(
          () =>
            __previewIntegrationQA.abortBeforeCreateResolved === 0 &&
            __previewIntegrationQA.createRecords.some(
              (record) => !record.resolved,
            ),
        ),
      );
      await page.locator("[data-review]").click();
      await page.locator("#apply-group").click();
      await page.waitForFunction(() =>
        __previewIntegrationQA.runtimeCalls.some(
          (call) => call.type === "group",
        ),
      );
      assert(
        "mocked grouping sends reviewed tab identities",
        await page.evaluate(() => {
          const call = __previewIntegrationQA.runtimeCalls.find(
            (call) => call.type === "group",
          );
          return (
            call.tabIds.length === 3 &&
            call.expectedTabs.length === 3 &&
            call.name === "Garden studio"
          );
        }),
      );
      assert(
        "group action leaves setup pending and does not launch another setup",
        await page.evaluate(
          () =>
            __previewIntegrationQA.abortBeforeCreateResolved === 0 &&
            __previewIntegrationQA.createCalls === 1,
        ),
      );
      await settings(page);
      assert(
        "pending progress remains visible after grouping",
        (await page.locator(".progress-note").innerText()).includes("25%"),
      );
      await page.evaluate(() => __previewIntegrationQA.resolveCreate());
      await chip(page, "ready");
      assert(
        "completion clears pending progress and releases setup session",
        await page.evaluate(
          () =>
            !document.querySelector(".progress-note") &&
            __previewIntegrationQA.destroyCalls === 1,
        ),
      );
    },
  );
  await scenario(
    "AI off cancels setup and ignores late completion",
    "downloadable",
    async (page, assert) => {
      await beginSetup(page);
      await page.locator("#toggle-ai").click();
      await chip(page, "off");
      await page.waitForFunction(
        () => __previewIntegrationQA.abortBeforeCreateResolved > 0,
      );
      assert(
        "AI off cancels the active setup request",
        await page.evaluate(
          () =>
            __previewIntegrationQA.abortBeforeCreateResolved === 1 &&
            !__previewIntegrationQA.snapshot.settings.aiEnabled,
        ),
      );
      await page.evaluate(() => __previewIntegrationQA.resolveCreate());
      await page.waitForFunction(() => __previewIntegrationQA.destroyCalls > 0);
      assert(
        "late setup result cannot restore readiness or progress while AI is off",
        await page.evaluate(
          () =>
            document.querySelector("#ai-status").textContent.includes("off") &&
            !document.querySelector(".progress-note"),
        ),
      );
    },
  );
  await scenario(
    "erase cancels setup and clears cached wording and display",
    "available",
    async (page, assert) => {
      await page.waitForFunction(
        () =>
          document.querySelector(".suggestion-card [data-reason]")
            ?.textContent === __previewIntegrationQA.alternateReason,
      );
      assert(
        "fixture first exercises a real app enhancement from mocked inference",
        await page.evaluate(() => __previewIntegrationQA.promptCalls > 0),
      );
      await settings(page);
      await page.evaluate(() => {
        __previewIntegrationQA.modelState = "downloadable";
      });
      await page.locator("#setup-ai").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#setup-ai")
          ?.textContent.includes("Download local model"),
      );
      await page.locator("#setup-ai").click();
      await page.waitForFunction(
        () => __previewIntegrationQA.createRecords.length > 0,
      );
      await page.evaluate(() => __previewIntegrationQA.emitProgress(0.25));
      await page.locator("#clear-data").click();
      await page.locator("#confirm-general").click();
      await page.waitForFunction(
        () => !__previewIntegrationQA.snapshot.consentAt,
      );
      assert(
        "erase cancels setup and clears consent, saved display, and explicit preference",
        await page.evaluate(
          () =>
            __previewIntegrationQA.abortBeforeCreateResolved === 1 &&
            !__previewIntegrationQA.snapshot.consentAt &&
            __previewIntegrationQA.snapshot.settings.aiEnabled &&
            __previewIntegrationQA.snapshot.settings.aiPreferenceSource ===
              "default" &&
            !__previewIntegrationQA.snapshot.settings.enabled &&
            __previewIntegrationQA.snapshot.saved.length === 0 &&
            !document.querySelector(".progress-note"),
        ),
      );
      await page.locator('[data-view="suggestions"]').click();
      await page.waitForSelector("#start");
      const erasedPrompts = await page.evaluate(
        () => __previewIntegrationQA.promptCalls,
      );
      await page.evaluate(() => {
        __previewIntegrationQA.promptOutput = "0";
        __previewIntegrationQA.resolveCreate();
      });
      await page.waitForFunction(
        () => __previewIntegrationQA.destroyCalls >= 2,
      );
      assert(
        "late setup completion cannot resurrect erased UI state",
        await page.evaluate(
          () =>
            !!document.querySelector("#start") &&
            !document.querySelector(".progress-note") &&
            !__previewIntegrationQA.snapshot.settings.enabled,
        ),
      );
      assert(
        "erase blocks metadata inference until consent is renewed",
        await page.evaluate(
          (before) => __previewIntegrationQA.promptCalls === before,
          erasedPrompts,
        ),
      );
      // Exercise the disclosed no-AI choice at onboarding before explicitly
      // enabling again, so cache deletion remains independently observable.
      await page.locator("#start-ai").uncheck();
      await page.locator("#start").click();
      await page.locator('[data-view="suggestions"]').click();
      assert(
        "new consent shows original evidence rather than erased enhanced wording",
        await page.evaluate(
          () =>
            document.querySelector(".suggestion-card [data-reason]")
              .textContent === __previewIntegrationQA.originalReason,
        ),
      );
      const promptsBefore = await page.evaluate(
        () => __previewIntegrationQA.promptCalls,
      );
      await settings(page);
      await page.locator("#toggle-ai").click();
      await chip(page, "ready");
      await page.locator('[data-view="suggestions"]').click();
      await page.waitForFunction(
        (before) => __previewIntegrationQA.promptCalls > before,
        promptsBefore,
      );
      assert(
        "re-enabling performs fresh inference instead of reusing erased module cache",
        await page.evaluate(
          () =>
            document.querySelector(".suggestion-card [data-reason]")
              .textContent === __previewIntegrationQA.originalReason,
        ),
      );
    },
  );
  await scenario(
    "external AI off disables stale review name action",
    "available",
    async (page, assert) => {
      await chip(page, "ready");
      await page.locator("[data-review]").click();
      await page.waitForSelector("#ai-name");
      const createsBefore = await page.evaluate(
        () => __previewIntegrationQA.createCalls,
      );
      await page.evaluate(() => __previewIntegrationQA.externalAIoff());
      await chip(page, "off");
      assert(
        "existing refine button is disabled after external AI off",
        await page.locator("#ai-name").isDisabled(),
      );
      assert(
        "external AI off does not start another model",
        await page.evaluate(
          (before) => __previewIntegrationQA.createCalls === before,
          createsBefore,
        ),
      );
    },
  );
  await scenario(
    "external AI off ignores pending name completion",
    { holdNamePrompts: true },
    async (page, assert) => {
      await chip(page, "ready");
      await page.locator("[data-review]").click();
      await page.locator("#ai-name").click();
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingNames.length === 1,
      );
      await page.evaluate(() => __previewIntegrationQA.externalAIoff());
      await chip(page, "off");
      const before = await page.evaluate(() => ({
        checks: __previewIntegrationQA.availabilityCalls,
        creates: __previewIntegrationQA.createCalls,
      }));
      await page.evaluate(() =>
        __previewIntegrationQA.resolveNames("Studio budget"),
      );
      await page.waitForTimeout(100);
      assert(
        "late name cannot overwrite fallback or restart AI watcher",
        await page.evaluate(
          (before) =>
            document.querySelector("#group-name").value === "Garden studio" &&
            document.querySelector("#ai-status").textContent.includes("off") &&
            __previewIntegrationQA.availabilityCalls === before.checks &&
            __previewIntegrationQA.createCalls === before.creates,
          before,
        ),
      );
    },
  );
  await scenario(
    "failed wording and name requests keep actual ready state",
    { nameBehavior: "fail", wordingBehavior: "fail" },
    async (page, assert) => {
      await chip(page, "ready");
      await settings(page);
      await page.waitForSelector('[data-ai-request="explanations"]');
      assert(
        "wording failure is scoped to its request while model remains ready",
        (
          await page.locator('[data-ai-request="explanations"]').innerText()
        ).includes("wording request could not finish") &&
          (await page.locator("#ai-status").innerText()).includes("ready"),
      );
      await page.locator('[data-view="suggestions"]').click();
      assert(
        "failed wording leaves deterministic evidence intact",
        await page.evaluate(
          () =>
            document.querySelector(".suggestion-card [data-reason]")
              .textContent === __previewIntegrationQA.originalReason,
        ),
      );
      await page.locator("[data-review]").click();
      await page.locator("#ai-name").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#toast")
          ?.textContent.includes("name request could not finish"),
      );
      assert(
        "failed name preserves fallback and gives a request-specific toast",
        (await page.locator("#group-name").inputValue()) === "Garden studio" &&
          (await page.locator("#ai-status").innerText()).includes("ready"),
      );
      await page.locator("#review-dialog [data-close-dialog]").click();
      await settings(page);
      await page.waitForSelector('[data-ai-request="names"]');
      assert(
        "failed requests do not offer model setup again",
        (await page.locator("#setup-ai").innerText()) ===
          "Check availability" &&
          (
            await page.locator('[data-ai-request="names"]').innerText()
          ).includes("original name is still available"),
      );
      await audit(page, "ready with failed name and wording outcomes", assert);
    },
  );
  await scenario(
    "delayed wording and name watchdogs keep actual ready state",
    { nameBehavior: "hang", wordingBehavior: "hang", virtualWatchdogs: true },
    async (page, assert) => {
      await chip(page, "ready");
      await page.waitForFunction(() =>
        [...__previewIntegrationQA.watchdogs.values()].some(
          (timer) => timer.delay === 30_000,
        ),
      );
      assert(
        "pending proactive name leaves the immediate fallback visible",
        (await page.locator("[data-group-name]").innerText()) ===
          "Garden studio",
      );
      await page.evaluate(() => __previewIntegrationQA.fireWatchdog(30_000));
      await page.waitForFunction(() =>
        [...__previewIntegrationQA.watchdogs.values()].some(
          (timer) => timer.delay === 15_000,
        ),
      );
      assert(
        "pending wording keeps immediate deterministic explanation and ready header",
        await page.evaluate(
          () =>
            document.querySelector(".suggestion-card [data-reason]")
              .textContent === __previewIntegrationQA.originalReason &&
            document.querySelector("#ai-status").textContent.includes("ready"),
        ),
      );
      await page.evaluate(() => __previewIntegrationQA.fireWatchdog(15_000));
      await settings(page);
      await page.waitForSelector('[data-ai-request="explanations"]');
      assert(
        "wording timeout remains a scoped historical outcome",
        (
          await page.locator('[data-ai-request="explanations"]').innerText()
        ).includes("wording request took too long") &&
          (await page.locator("#ai-status").innerText()).includes("ready"),
      );
      await page.locator('[data-view="suggestions"]').click();
      await page.locator("[data-review]").click();
      await page.locator("#ai-name").click();
      await page.waitForFunction(() =>
        [...__previewIntegrationQA.watchdogs.values()].some(
          (timer) => timer.delay === 30_000,
        ),
      );
      assert(
        "pending naming keeps current model readiness",
        (await page.locator("#ai-status").innerText()).includes("ready") &&
          (await page.locator("#group-name").inputValue()) === "Garden studio",
      );
      await page.evaluate(() => __previewIntegrationQA.fireWatchdog(30_000));
      await page.waitForFunction(() =>
        document
          .querySelector("#toast")
          ?.textContent.includes("name request took too long"),
      );
      assert(
        "naming timeout preserves fallback and request-specific toast",
        (await page.locator("#group-name").inputValue()) === "Garden studio" &&
          (await page.locator("#ai-status").innerText()).includes("ready"),
      );
      await page.locator("#review-dialog [data-close-dialog]").click();
      await settings(page);
      await page.waitForSelector('[data-ai-request="names"]');
      assert(
        "both timed-out requests remain separate from ready model status",
        (await page.locator(".capability-label").innerText()) ===
          "Ready on this device" &&
          (
            await page.locator('[data-ai-request="names"]').innerText()
          ).includes("name request took too long") &&
          (
            await page.locator('[data-ai-request="explanations"]').innerText()
          ).includes("wording request took too long"),
      );
      await audit(
        page,
        "ready with timed-out name and wording outcomes",
        assert,
      );
      await page
        .locator(".capability-label")
        .evaluate((node) => node.scrollIntoView({ block: "center" }));
      await page.evaluate(() => {
        const badge = document.createElement("div");
        badge.id = "qa-provenance";
        badge.textContent = "SOURCE QA · SIMULATED AI TIMEOUTS · NO REAL MODEL";
        badge.style.cssText =
          "position:fixed;bottom:12px;left:12px;z-index:9999;padding:9px 14px;border:1px solid #d1b669;border-radius:8px;background:#fff4cf;color:#493a12;font:600 12px system-ui;box-shadow:0 2px 8px #0002";
        document.body.append(badge);
      });
      const relative = "qa/screenshots/preview-ready-request-timeout.png";
      await fs.mkdir(path.join(root, "qa/screenshots"), { recursive: true });
      await page.screenshot({
        path: path.join(root, relative),
        animations: "disabled",
      });
      report.screenshots.push({
        path: relative,
        simulatedAI: true,
        description:
          "Source UI shows actual mocked readiness separately from virtual naming/wording timeout outcomes.",
      });
    },
  );
  await scenario(
    "passive availability check failure retries without model creation",
    { availabilityFailure: true },
    async (page, assert) => {
      await chip(page, "needs attention");
      await settings(page);
      assert(
        "passive check failure offers inspection instead of setup",
        (await page.locator("#setup-ai").innerText()) ===
          "Check availability" &&
          (await page.locator(".capability-label").innerText()) ===
            "Could not check model",
      );
      const before = await page.evaluate(() => ({
        checks: __previewIntegrationQA.availabilityCalls,
        creates: __previewIntegrationQA.createCalls,
      }));
      await page.evaluate(() => {
        __previewIntegrationQA.availabilityFailure = false;
      });
      await page.locator("#setup-ai").click();
      await chip(page, "ready");
      assert(
        "availability retry inspects again and never calls create",
        await page.evaluate(
          (before) =>
            __previewIntegrationQA.availabilityCalls > before.checks &&
            __previewIntegrationQA.createCalls === 0 &&
            before.creates === 0,
          before,
        ),
      );
    },
  );
  await scenario(
    "actual availability loss is shown despite previous ready state",
    "available",
    async (page, assert) => {
      await chip(page, "ready");
      await settings(page);
      const createsBefore = await page.evaluate(
        () => __previewIntegrationQA.createCalls,
      );
      await page.evaluate(() => {
        __previewIntegrationQA.modelState = "unavailable";
      });
      await page.locator("#setup-ai").click();
      await chip(page, "unavailable");
      assert(
        "fresh unavailable response replaces historical ready state",
        (await page.locator(".capability-label").innerText()) ===
          "Unavailable here",
      );
      assert(
        "detecting actual availability loss does not create a session",
        await page.evaluate(
          (before) => __previewIntegrationQA.createCalls === before,
          createsBefore,
        ),
      );
    },
  );
  await scenario(
    "one hundred cached tabs remain usable during a real pending check",
    {
      sourceSnapshot: engineFixture("actionable"),
      holdSnapshot: true,
      readySelector: "#workspace-check",
    },
    async (page, assert) => {
      await page.waitForFunction(
        () => typeof __previewIntegrationQA.resolveSnapshot === "function",
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#workspace-check")
          ?.textContent.includes("A fresh check is next."),
      );
      assert(
        "pending check shows retained engine results immediately instead of a blank workspace",
        (await page.locator(".suggestion-card").count()) > 0 &&
          (await page.locator("#tab-count").innerText()) === "100",
      );
      assert(
        "waiting for the backend does not claim an active scan",
        !(await page.locator("#workspace-check").innerText()).includes(
          "Checking your open tabs",
        ),
      );
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.evaluation.phase = "checking";
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#workspace-check")
          ?.textContent.includes("Checking your open tabs"),
      );
      assert(
        "checking status does not fabricate percentages or elapsed stages",
        !/\b\d+%|stage\s*\d|step\s*\d/i.test(
          await page.locator("#workspace-check").innerText(),
        ),
      );
      await page.evaluate(() => {
        const now = Date.now();
        __previewIntegrationQA.snapshot.evaluation = {
          state: "idle",
          phase: null,
          checkedAt: now,
          requestedAt: null,
          error: null,
        };
        __previewIntegrationQA.snapshot.evaluationSummary.checkedAt = now;
        __previewIntegrationQA.resolveSnapshot();
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#workspace-check")
          ?.textContent.includes(
            "100 tabs checked. Your choices, in a useful order.",
          ),
      );
      assert(
        "completed status reports all100 examined tabs from the engine",
        await page.evaluate(
          () =>
            __previewIntegrationQA.snapshot.evaluationSummary.webTabsChecked ===
              100 &&
            __previewIntegrationQA.snapshot.evaluationSummary
              .suggestionsShown ===
              document.querySelectorAll(".suggestion-card").length,
        ),
      );
      assert(
        "summary category counts match the actual displayed review opportunities",
        await page.evaluate(() => {
          const suggestions = __previewIntegrationQA.snapshot.suggestions;
          const expected = [
            suggestions.filter((item) => item.type === "group").length,
            suggestions
              .filter((item) => item.type === "duplicate")
              .reduce((sum, item) => sum + item.tabs.length, 0),
            suggestions
              .filter((item) => item.type === "inactive")
              .reduce((sum, item) => sum + item.tabs.length, 0),
          ];
          return (
            JSON.stringify(
              [...document.querySelectorAll(".check-results b")].map((el) =>
                Number(el.textContent),
              ),
            ) === JSON.stringify(expected)
          );
        }),
      );
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.evaluation = {
          ...__previewIntegrationQA.snapshot.evaluation,
          state: "checking",
          phase: "queued",
          requestedAt: Date.now(),
        };
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#workspace-check")
          ?.textContent.includes("A fresh check is next."),
      );
      assert(
        "queued checks retain previous results and are not labelled actively running",
        (await page.locator(".check-recency").innerText()).includes(
          "Last completed check: 100 tabs",
        ) && (await page.locator(".suggestion-card").count()) > 0,
      );
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.evaluation = {
          ...__previewIntegrationQA.snapshot.evaluation,
          state: "idle",
          phase: null,
          requestedAt: null,
        };
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForFunction(() =>
        document
          .querySelector("#workspace-check")
          ?.textContent.includes(
            "100 tabs checked. Your choices, in a useful order.",
          ),
      );
      await audit(
        page,
        "100 tabs with completed deterministic scan summary",
        assert,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert(
        "100-tab summary and retained cards fit a narrow viewport without horizontal overflow",
        await page.evaluate(() => {
          const panel = document
            .querySelector("#workspace-check")
            .getBoundingClientRect();
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            panel.left >= 0 &&
            panel.right <= innerWidth
          );
        }),
        { viewport: "390x844" },
      );
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.evaluation = {
          ...__previewIntegrationQA.snapshot.evaluation,
          state: "checking",
          phase: "checking",
          requestedAt: Date.now(),
        };
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForSelector("#workspace-check.is-checking");
      assert(
        "reduced-motion preference disables the actual checking animation",
        await page.evaluate(() => {
          const panel = document.querySelector("#workspace-check");
          const symbol = panel.querySelector(".check-symbol svg");
          return (
            matchMedia("(prefers-reduced-motion: reduce)").matches &&
            getComputedStyle(symbol).animationName === "none" &&
            panel
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState !== "running")
          );
        }),
      );
    },
  );
  for (const fixtureKind of ["fresh", "grouped", "guarded", "empty"]) {
    await scenario(
      `completed ${fixtureKind} workspace explains zero suggestions`,
      {
        sourceSnapshot: engineFixture(fixtureKind),
        readySelector: "#workspace-check",
      },
      async (page, assert) => {
        await page.waitForFunction(
          () =>
            !document
              .querySelector("#workspace-check")
              ?.textContent.includes("Checking your open tabs"),
        );
        const text = await page.locator("#workspace-check").innerText();
        assert(
          "zero suggestions are a completed result with a constructive next step",
          (await page.locator(".suggestion-card").count()) === 0 &&
            text.includes("No new suggestions") &&
            !/error|failed|stuck/i.test(text),
          text,
        );
        assert(
          "the no-result explanation follows actual measured eligibility",
          await page.evaluate((kind) => {
            const summary = __previewIntegrationQA.snapshot.evaluationSummary;
            return (
              summary.suggestionsShown === 0 &&
              (kind === "empty"
                ? summary.webTabsChecked === 0
                : summary.webTabsChecked === 100) &&
              (kind !== "fresh" ||
                summary.skipped.insufficientHistory === 100) &&
              (kind !== "grouped" || summary.skipped.alreadyGrouped === 100) &&
              (kind !== "guarded" || summary.skipped.guarded === 100)
            );
          }, fixtureKind),
        );
        const explanation = await page
          .locator(".suggestion-list .empty")
          .innerText();
        const expectedCopy = {
          fresh: /recorded.*observation|observation.*time|recorded URL use/i,
          grouped: /already.*Chrome groups|already.*grouped/i,
          guarded: /pinned.*audio.*protected/i,
          empty: /open a few web pages/i,
        };
        assert(
          "empty-state copy explains the actual reason and offers open tabs",
          expectedCopy[fixtureKind].test(explanation) &&
            explanation.includes("See open tabs"),
          explanation,
        );
      },
    );
  }
  await scenario(
    "paused workspace does not pretend to have completed a zero-tab check",
    {
      sourceSnapshot: engineFixture("paused"),
      readySelector: "#workspace-check",
    },
    async (page, assert) => {
      const text = await page.locator("#workspace-check").innerText();
      assert(
        "paused state is explicit and avoids invented current scan counts",
        /pause/i.test(text) && !/0 tabs checked|No new suggestions/i.test(text),
        text,
      );
      assert(
        "paused source snapshot exposes no current summary or tabs",
        await page.evaluate(
          () =>
            __previewIntegrationQA.snapshot.evaluationSummary === null &&
            __previewIntegrationQA.snapshot.tabs.length === 0,
        ),
      );
    },
  );
  const downloadingSnapshot = engineFixture("actionable");
  downloadingSnapshot.settings.aiEnabled = true;
  await scenario(
    "model download is independent of the completed one-hundred-tab check",
    {
      sourceSnapshot: downloadingSnapshot,
      initialModelState: "downloading",
      readySelector: "#workspace-check",
    },
    async (page, assert) => {
      await chip(page, "downloading");
      assert(
        "deterministic scan stays complete while optional model downloads",
        (await page.locator("#workspace-check").innerText()).includes(
          "100 tabs checked. Your choices, in a useful order.",
        ) && (await page.locator(".suggestion-card").count()) > 0,
      );
      assert(
        "completed tab check does not start a download or infer metadata",
        await page.evaluate(
          () =>
            __previewIntegrationQA.createCalls === 0 &&
            __previewIntegrationQA.promptCalls === 0,
        ),
      );
    },
  );
  const errorSnapshot = engineFixture("actionable");
  errorSnapshot.evaluation = {
    ...errorSnapshot.evaluation,
    state: "error",
    phase: null,
    error: "Synthetic browser check did not finish.",
  };
  await scenario(
    "failed current check retains prior results and supports a real retry",
    { sourceSnapshot: errorSnapshot, readySelector: "#workspace-check" },
    async (page, assert) => {
      const text = await page.locator("#workspace-check").innerText();
      assert(
        "failed check is distinct from no suggestions and retains earlier cards",
        /interrupted|could not|did not|didn.t|couldn’t|error|try again/i.test(
          text,
        ) && (await page.locator(".suggestion-card").count()) > 0,
        text,
      );
      await page.evaluate(() => {
        const now = Date.now();
        __previewIntegrationQA.snapshot.evaluation = {
          state: "idle",
          phase: null,
          checkedAt: now,
          requestedAt: null,
          error: null,
        };
        __previewIntegrationQA.snapshot.evaluationSummary.checkedAt = now;
      });
      await page.locator("#check-again").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#workspace-check")
          ?.textContent.includes(
            "100 tabs checked. Your choices, in a useful order.",
          ),
      );
      assert(
        "retry completes from a fresh runtime snapshot response",
        await page.evaluate(
          () =>
            __previewIntegrationQA.runtimeCalls.filter(
              (call) => call.type === "snapshot",
            ).length >= 2,
        ),
      );
    },
  );
  await scenario(
    "persistent action receipt retains a grouping warning beside completed counts",
    {
      sourceSnapshot: engineFixture("actionable"),
      groupSnapshot: engineFixture("actionable", true),
      groupWarning:
        "The tabs were grouped, but the name could not be set. Rename the group in Chrome.",
      readySelector: "#workspace-check",
    },
    async (page, assert) => {
      const groupId = await page.evaluate(
        () =>
          __previewIntegrationQA.snapshot.suggestions.find(
            (suggestion) => suggestion.type === "group",
          ).id,
      );
      await page.locator(`[data-review="${groupId}"]`).click();
      await page.locator("#group-name").fill("Garden studio");
      await page.locator("#apply-group").click();
      await page.waitForSelector(".decision-receipt");
      assert(
        "partial grouping result keeps the naming warning in its persistent receipt",
        (await page.locator(".decision-receipt").innerText()).includes(
          "The tabs were grouped, but the name could not be set. Rename the group in Chrome.",
        ),
      );
      assert(
        "receipt preserves completed scan counts and only reports the submitted mock action",
        (await page.locator("#workspace-check").innerText()).includes(
          "100 tabs checked.",
        ) &&
          (await page.evaluate(() => {
            const actions = __previewIntegrationQA.runtimeCalls.filter(
              (call) => call.type === "group",
            );
            return (
              actions.length === 1 &&
              actions[0].tabIds.length === 10 &&
              actions[0].name === "Garden studio" &&
              __previewIntegrationQA.snapshot.tabs.length === 100
            );
          })),
      );
      await settings(page);
      await page.locator('[data-view="suggestions"]').click();
      assert(
        "the warning remains after navigating away and back",
        (await page.locator(".decision-receipt").innerText()).includes(
          "name could not be set",
        ),
      );
      await audit(
        page,
        "persistent grouping warning with completed scan summary",
        assert,
      );
      await page
        .getByRole("button", { name: "Dismiss completed action" })
        .click();
      assert(
        "dismissing the receipt leaves the completed check and current suggestions intact",
        (await page.locator(".decision-receipt").count()) === 0 &&
          (await page.locator("#workspace-check").innerText()).includes(
            "100 tabs checked.",
          ) &&
          (await page.locator(".suggestion-card").count()) > 0,
      );
    },
  );
  await scenario(
    "fresh install disclosure is nonblocking and history progress stays current",
    {
      sourceSnapshot: {
        ...engineFixture("actionable"),
        installDisclosure: true,
        history: {
          state: "indexing",
          processedURLs: 256,
          analyzedVisits: 943,
          indexedURLs: 0,
        },
      },
      readySelector: ".install-disclosure",
    },
    async (page, assert) => {
      assert(
        "install disclosure accompanies usable results without a history permission gate",
        (await page.locator(".suggestion-card").count()) > 0 &&
          (await page.locator("#start").count()) === 0 &&
          (await page.locator(".install-disclosure").innerText()).includes(
            "browsing history",
          ),
      );
      assert(
        "history progress reports actual synthetic counts and partial coverage",
        (await page.locator(".history-progress").innerText()).includes(
          "256 URLs and 943 available visits",
        ) &&
          (await page.locator(".history-progress").innerText()).includes(
            "partial",
          ),
      );
      await page.screenshot({
        path: path.join(
          root,
          "qa/screenshots/preview-120-close-and-history.png",
        ),
      });
      report.screenshots.push(
        "qa/screenshots/preview-120-close-and-history.png",
      );
      await audit(
        page,
        "fresh install nonblocking disclosure and Close",
        assert,
      );
      await page.locator("#dismiss-disclosure").click();
      assert(
        "Got it dismisses only the disclosure",
        (await page.locator(".install-disclosure").count()) === 0 &&
          (await page.locator(".suggestion-card").count()) > 0,
      );
      await settings(page);
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.history = {
          state: "ready",
          processedURLs: 10057,
          analyzedVisits: 38419,
          indexedURLs: 10057,
        };
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForFunction(() =>
        document
          .querySelector(".history-progress")
          ?.textContent.includes("10057 available history URLs reviewed"),
      );
      assert(
        "history status updates in Settings without a manual refresh",
        true,
      );
      await page.evaluate(() => {
        __previewIntegrationQA.snapshot.history.state = "error";
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      });
      await page.locator("#retry-history").click();
      assert(
        "history failure offers a retry while core suggestions remain in the snapshot",
        await page.evaluate(
          () =>
            __previewIntegrationQA.runtimeCalls.some(
              (call) => call.type === "retryHistory",
            ) && __previewIntegrationQA.snapshot.suggestions.length > 0,
        ),
      );
      await page.locator("#toggle-history").click();
      assert(
        "history feature opt-out clears displayed progress without requesting permission",
        await page.evaluate(
          () =>
            !__previewIntegrationQA.snapshot.settings.historyEnabled &&
            document.querySelectorAll(".history-progress").length === 0 &&
            __previewIntegrationQA.runtimeCalls.every(
              (call) => !/permission/i.test(call.type),
            ),
        ),
      );
      await audit(
        page,
        "history settings and required-permission disclosure",
        assert,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => scrollTo(0, 0));
      assert(
        "Close remains visible and page fits390px",
        await page.evaluate(() => {
          const box = document
            .querySelector("#close-workspace")
            .getBoundingClientRect();
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            document.documentElement.scrollWidth <= innerWidth
          );
        }),
      );
    },
  );
  await scenario(
    "all suggestions and all eligible older tabs remain reachable",
    {
      sourceSnapshot: engineFixture("many"),
      readySelector: ".suggestion-card",
    },
    async (page, assert) => {
      assert(
        "all50 valid groups appear with no five-suggestion cutoff",
        (await page.locator(".suggestion-card").count()) === 50 &&
          (await page.locator(".section-label").innerText()).includes(
            "50 suggestions · all shown",
          ),
      );
      await page.locator(".rank-note").first().locator("summary").click();
      assert(
        "ranking rationale shows recorded evidence and available history",
        await page.evaluate(() => {
          const first = __previewIntegrationQA.snapshot.suggestions[0];
          return (
            first.tabIds.includes(100) &&
            !!first.rankReason &&
            !!first.historyReason &&
            document
              .querySelector(".rank-note")
              .textContent.includes(first.historyReason)
          );
        }),
      );
      await page.locator("[data-review]").last().click();
      assert(
        "the last group is actionable without AI",
        (await page.locator("#apply-group").count()) === 1,
      );
      await page.locator("[data-close-dialog]").click();
      const next = engineFixture("actionable");
      const older = next.suggestions.filter((item) => item.type === "inactive");
      const expected = older.reduce((n, item) => n + item.tabs.length, 0);
      await page.evaluate((next) => {
        __previewIntegrationQA.snapshot = next;
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" });
      }, next);
      await page.locator(`[data-review="${older[0].id}"]`).click();
      assert(
        "older-tab review exposes every eligible tab beyond the previous eight",
        expected > 8 &&
          (await page.locator("dialog [data-tab-check]").count()) ===
            older[0].tabs.length,
        {
          totalEligibleOlderTabs: expected,
          visibleReviewRows: older[0].tabs.length,
        },
      );
      assert(
        "older-tab review starts without selecting a close action",
        await page.locator("#close-selected").isDisabled(),
      );
    },
  );
  await scenario(
    "workspace Close is explicit and recoverable while Escape stays in the dialog",
    { aiEnabled: false },
    async (page, assert) => {
      await page.locator("[data-review]").click();
      await page.keyboard.press("Escape");
      assert(
        "Escape closes a review without issuing workspace closure",
        !(await page.locator("dialog").isVisible()) &&
          (await page.evaluate(() =>
            __previewIntegrationQA.runtimeCalls.every(
              (call) => call.type !== "closeWorkspace",
            ),
          )),
      );
      await page.evaluate(() => {
        __previewIntegrationQA.closeError = true;
      });
      await page
        .getByRole("button", { name: "Close Tabosmart workspace" })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#close-workspace").disabled,
      );
      assert(
        "a failed close keeps an enabled retry control and a visible error",
        (await page.locator("#toast").innerText()).includes(
          "Synthetic close failed",
        ),
      );
      await page.evaluate(() => {
        __previewIntegrationQA.closeError = false;
      });
      await page.locator("#close-workspace").click();
      assert(
        "Close requests only its sender workspace, without a caller-supplied tab or window",
        await page.evaluate(() => {
          const calls = __previewIntegrationQA.runtimeCalls.filter(
            (call) => call.type === "closeWorkspace",
          );
          return (
            calls.length === 2 &&
            calls.every((call) => Object.keys(call).length === 1) &&
            document.querySelector("#close-workspace").disabled
          );
        }),
      );
    },
  );
  await scenario(
    "actual AI activity crosses the toolbar port and reconnects without stale busy state",
    { holdNamePrompts: true },
    async (page, assert) => {
      await page.waitForFunction(() =>
        __previewIntegrationQA.ports.some((port) =>
          port.messages.some((m) => m.naming),
        ),
      );
      assert(
        "a pending real module naming request reports naming activity",
        await page.evaluate(() =>
          __previewIntegrationQA.ports[0].messages.some(
            (m) => m.naming && m.enabled && m.setup === "idle",
          ),
        ),
      );
      await page.evaluate(() => {
        __previewIntegrationQA.holdNamePrompts = false;
        __previewIntegrationQA.resolveNames("Studio plans");
      });
      await page.waitForFunction(() => {
        const last = __previewIntegrationQA.ports.at(-1)?.messages.at(-1);
        return last && !last.naming && !last.wording && last.setup === "idle";
      });
      assert(
        "completed requests settle to idle rather than treating model readiness as work",
        true,
      );
      await page.evaluate(() =>
        __previewIntegrationQA.ports.at(-1).disconnect(),
      );
      await page.waitForFunction(
        () => __previewIntegrationQA.ports.length === 2,
      );
      assert(
        "reconnection sends current idle activity",
        await page.evaluate(() => {
          const last = __previewIntegrationQA.ports.at(-1).messages.at(-1);
          return last && !last.naming && !last.wording && last.setup === "idle";
        }),
      );
      await settings(page);
      await page.locator("#toggle-observation").click();
      assert(
        "pause reports disabled activity",
        await page.evaluate(
          () =>
            __previewIntegrationQA.ports.at(-1).messages.at(-1).enabled ===
            false,
        ),
      );
    },
  );
  await scenario(
    "ordinary workspace leave clears toolbar ownership without explicitly aborting setup",
    "downloadable",
    async (page, assert) => {
      await beginSetup(page);
      await page.evaluate(() => __previewIntegrationQA.emitProgress(0.35));
      await page.waitForFunction(() =>
        __previewIntegrationQA.ports
          .at(-1)
          ?.messages.some((m) => m.setup === "downloading"),
      );
      assert("genuine setup progress reports a downloading activity", true);
      await page.evaluate(() =>
        dispatchEvent(new PageTransitionEvent("pagehide")),
      );
      assert(
        "page leave disconnects its toolbar owner but preserves the pending setup signal",
        await page.evaluate(
          () =>
            __previewIntegrationQA.ports.every((port) => port.disconnected) &&
            __previewIntegrationQA.abortBeforeCreateResolved === 0 &&
            __previewIntegrationQA.createRecords.every(
              (record) => !record.signal.aborted,
            ),
        ),
      );
      await page.evaluate(() => __previewIntegrationQA.resolveCreate());
      assert(
        "this synthetic check makes no assertion about Chrome model completion after closure",
        true,
      );
    },
  );
  for (const modelState of ["available", "unavailable"]) {
    await scenario(
      `Lithuanian news category is immediately useful with ${modelState} model`,
      {
        sourceSnapshot: newsFixture(),
        readySelector: "#workspace-check",
        initialModelState: modelState,
      },
      async (page, assert) => {
        assert(
          "three grounded news members group while the opaque Alfa brand stays outside",
          (await page.locator(".suggestion-card").count()) === 1 &&
            (await page.locator("[data-group-name]").innerText()) ===
              "Naujienos" &&
            (await page.evaluate(() => {
              const suggestion = __previewIntegrationQA.snapshot.suggestions[0];
              return (
                suggestion.signal === "category" &&
                JSON.stringify(suggestion.tabIds) === JSON.stringify([1, 2, 4])
              );
            })),
        );
        assert(
          "Lithuanian category evidence does not request a model or native grouping",
          await page.evaluate(
            () =>
              __previewIntegrationQA.createCalls === 0 &&
              __previewIntegrationQA.runtimeCalls.every(
                (x) => x.type !== "group",
              ),
          ),
        );
        if (modelState === "unavailable") {
          await page.screenshot({
            path: path.join(
              root,
              "qa/screenshots/preview-140-news-category.png",
            ),
          });
          report.screenshots.push(
            "qa/screenshots/preview-140-news-category.png",
          );
          await audit(page, "grounded Lithuanian news without AI", assert);
        }
        await page.locator("[data-review]").click();
        assert(
          "deterministic group names remain directly editable",
          await page.locator("#group-name").isEditable(),
        );
        await page.locator("#group-name").fill("Ryto naujienos");
        await page.evaluate(() =>
          __previewIntegrationQA.emitMessage({ type: "snapshotChanged" }),
        );
        assert(
          "edited Lithuanian name survives a snapshot refresh without a model prompt",
          (await page.locator("#group-name").inputValue()) ===
            "Ryto naujienos" &&
            (await page.evaluate(
              () => __previewIntegrationQA.promptCalls === 0,
            )),
        );
      },
    );
  }
  await scenario(
    "one new tab can be reviewed for an existing native news group",
    {
      sourceSnapshot: newsFixture(false, "auto", true),
      readySelector: "#workspace-check",
    },
    async (page, assert) => {
      assert(
        "the engine proposes only the ungrouped matching member",
        await page.evaluate(() => {
          const suggestion = __previewIntegrationQA.snapshot.suggestions[0];
          return (
            suggestion.signal === "existing-group" &&
            suggestion.targetGroup.id === 84 &&
            JSON.stringify(suggestion.tabIds) === JSON.stringify([4])
          );
        }),
      );
      await page.locator("[data-review]").click();
      assert(
        "review preserves the exact native name and offers no AI rename",
        (await page.locator("#group-name").inputValue()) === "Mano naujienos" &&
          !(await page.locator("#group-name").isEditable()) &&
          (await page.locator("#ai-name").count()) === 0 &&
          (await page.locator("#apply-group").innerText()) === "Add to group",
      );
      assert(
        "one selected new tab is actionable without selecting existing members",
        (await page.locator("#review-selection-count").innerText()) ===
          "1 selected" &&
          (await page.locator("#apply-group").isEnabled()) &&
          (await page.locator("#review-dialog .tab-row").count()) === 1,
      );
      await page.screenshot({
        path: path.join(
          root,
          "qa/screenshots/preview-140-existing-group-review.png",
        ),
      });
      report.screenshots.push(
        "qa/screenshots/preview-140-existing-group-review.png",
      );
      await audit(
        page,
        "single-tab addition to an existing named group",
        assert,
      );
      await page.locator("#apply-group").click();
      assert(
        "the explicit review sends one guarded addition to the mock runtime",
        await page.evaluate(() => {
          const calls = __previewIntegrationQA.runtimeCalls.filter(
            (call) => call.type === "group",
          );
          return (
            calls.length === 1 &&
            calls[0].name === "Mano naujienos" &&
            JSON.stringify(calls[0].tabIds) === JSON.stringify([4]) &&
            calls[0].expectedTabs.length === 1 &&
            calls[0].expectedTabs[0].id === 4 &&
            typeof calls[0].suggestionId === "string"
          );
        }),
      );
      assert(
        "synthetic acknowledgment retains both previous group members and the opaque tab",
        await page.evaluate(() => {
          const snapshot = __previewIntegrationQA.snapshot;
          return (
            snapshot.tabs
              .filter((tab) => tab.groupId === 84)
              .map((tab) => tab.id)
              .join(",") === "1,2,4" &&
            snapshot.tabs.find((tab) => tab.id === 3).groupId === -1 &&
            snapshot.nativeGroups[0].title === "Mano naujienos"
          );
        }),
      );
      assert(
        "this source-only scenario does not claim an actual native browser action",
        true,
      );
    },
  );
  await scenario(
    "remembered grouping names survive ready proactive AI and remain editable",
    {
      sourceSnapshot: rememberedFixture(),
      nameOutput: "Overwritten AI name",
      readySelector: "#workspace-check",
    },
    async (page, assert) => {
      await chip(page, "ready");
      assert(
        "the real engine reuses the confirmed name without automatic model replacement",
        (await page.locator("[data-group-name]").innerText()) ===
          "Autumn escape" &&
          (await page.evaluate(() => {
            const suggestion = __previewIntegrationQA.snapshot.suggestions[0];
            return (
              suggestion.signal === "remembered-group" &&
              suggestion.nameLocked &&
              __previewIntegrationQA.prompts.every(
                (prompt) => prompt.kind !== "names",
              )
            );
          })),
      );
      await page.locator("[data-review]").click();
      assert(
        "remembered names remain user-editable in review",
        (await page.locator("#group-name").isEditable()) &&
          (await page.locator("#group-name").inputValue()) === "Autumn escape",
      );
      await page.locator("#group-name").fill("Autumn escape 2026");
      await page.evaluate(() =>
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" }),
      );
      assert(
        "an edited remembered name survives refresh",
        (await page.locator("#group-name").inputValue()) ===
          "Autumn escape 2026",
      );
      await page.screenshot({
        path: path.join(
          root,
          "qa/screenshots/preview-140-remembered-group-review.png",
        ),
      });
      report.screenshots.push(
        "qa/screenshots/preview-140-remembered-group-review.png",
      );
      await audit(
        page,
        "remembered grouping choice with editable review",
        assert,
      );
      assert(
        "no grouping happened before an explicit confirmation",
        await page.evaluate(() =>
          __previewIntegrationQA.runtimeCalls.every(
            (call) => call.type !== "group",
          ),
        ),
      );
    },
  );
  const heldOut = newsFixture(true);
  const inferred = {
    name: "Theremin restoration",
    relationship: "task",
    members: heldOut.tabs.map((t) => ({ id: t.id, evidence: t.title })),
  };
  await scenario(
    "optional ready AI discovers an unfamiliar task after immediate deterministic results",
    {
      sourceSnapshot: heldOut,
      readySelector: "#workspace-check",
      holdDiscovery: true,
      discoveryOutput: { groups: [inferred] },
    },
    async (page, assert) => {
      assert(
        "initial core results do not wait for the pending model",
        (await page.locator(".suggestion-card").count()) === 0 &&
          (await page.locator("#check-again").isEnabled()),
      );
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingDiscovery.length === 1,
      );
      assert(
        "actual discovery is reported without marking core checking",
        await page.evaluate(() =>
          __previewIntegrationQA.ports
            .flatMap((p) => p.messages)
            .some((m) => m.discovery === true),
        ),
      );
      await page.evaluate(() =>
        __previewIntegrationQA.pendingDiscovery
          .splice(0)
          .forEach((r) =>
            r(JSON.stringify(__previewIntegrationQA.discoveryOutput)),
          ),
      );
      await page.waitForFunction(
        () =>
          document.querySelector("[data-group-name]")?.textContent ===
          "Theremin restoration",
      );
      assert(
        "a new three-member inferred proposal has AI provenance and quoted evidence",
        (await page.locator(".ai-name-badge").count()) === 1 &&
          (await page.locator("[data-reason]").innerText()).includes(
            "inferred relationship",
          ) &&
          (await page.evaluate(
            () => __previewIntegrationQA.snapshot.suggestions[0].tabIds.length,
          )) === 3,
      );
      assert(
        "no action is applied automatically",
        await page.evaluate(() =>
          __previewIntegrationQA.runtimeCalls.every((x) => x.type !== "group"),
        ),
      );
      await page.screenshot({
        path: path.join(
          root,
          "qa/screenshots/preview-140-general-discovery.png",
        ),
      });
      report.screenshots.push(
        "qa/screenshots/preview-140-general-discovery.png",
      );
      await audit(page, "general AI discovery with inferred evidence", assert);
      await page.locator("[data-review]").click();
      await page.locator("#group-name").fill("My instrument");
      await page.evaluate(() =>
        __previewIntegrationQA.emitMessage({ type: "snapshotChanged" }),
      );
      assert(
        "user name stays fixed",
        (await page.locator("#group-name").inputValue()) === "My instrument",
      );
      await page.locator("#apply-group").click();
      assert(
        "only the explicit reviewed action uses the edited name",
        await page.evaluate(() =>
          __previewIntegrationQA.runtimeCalls.some(
            (x) =>
              x.type === "group" &&
              x.name === "My instrument" &&
              x.tabIds.length === 3,
          ),
        ),
      );
    },
  );
  await scenario(
    "unavailable AI leaves unfamiliar metadata usable without invented semantics",
    {
      sourceSnapshot: heldOut,
      readySelector: "#workspace-check",
      initialModelState: "unavailable",
    },
    async (page, assert) => {
      assert(
        "no model or unsupported fabricated group",
        await page.evaluate(
          () =>
            __previewIntegrationQA.createCalls === 0 &&
            __previewIntegrationQA.snapshot.suggestions.length === 0,
        ),
      );
      await page.locator('.nav-item[data-view="tabs"]').click();
      assert(
        "all original tabs remain available",
        (await page.locator("[data-tab-check]").count()) === 3,
      );
    },
  );
  await scenario(
    "changed titles reject a late optional discovery result",
    {
      sourceSnapshot: heldOut,
      readySelector: "#workspace-check",
      holdDiscovery: true,
      discoveryOutput: { groups: [inferred] },
    },
    async (page, assert) => {
      await page.waitForFunction(
        () => __previewIntegrationQA.pendingDiscovery.length === 1,
      );
      await page.evaluate(() => {
        const s = __previewIntegrationQA;
        s.snapshot.tabs[0].title = "Unrelated calendar";
        s.emitMessage({ type: "snapshotChanged" });
      });
      await page.waitForFunction(
        () => document.querySelector("#workspace-check") !== null,
      );
      await page.evaluate(() =>
        __previewIntegrationQA.pendingDiscovery
          .splice(0)
          .forEach((r) =>
            r(JSON.stringify(__previewIntegrationQA.discoveryOutput)),
          ),
      );
      await page.locator('.nav-item[data-view="tabs"]').click();
      assert(
        "stale discovery cannot register an old grouping",
        await page.evaluate(
          () =>
            __previewIntegrationQA.runtimeCalls.every(
              (x) => x.type !== "discoverGroups",
            ) && __previewIntegrationQA.snapshot.suggestions.length === 0,
        ),
      );
    },
  );
  await scenario(
    "explicit naming-language control preserves grounded category membership",
    {
      sourceSnapshot: newsFixture(),
      readySelector: "#workspace-check",
      initialModelState: "unavailable",
    },
    async (page, assert) => {
      await settings(page);
      await page.locator("#group-name-language").selectOption("en");
      assert(
        "language preference is persisted without extra permission",
        await page.evaluate(() =>
          __previewIntegrationQA.runtimeCalls.some(
            (x) => x.type === "settings" && x.patch.groupNameLanguage === "en",
          ),
        ),
      );
      await page.locator('[data-view="suggestions"]').click();
      assert(
        "choosing a language preserves the three evidence-backed members",
        (await page.locator(".suggestion-card").count()) === 1 &&
          (await page.evaluate(
            () =>
              __previewIntegrationQA.snapshot.suggestions[0].tabIds.join(
                ",",
              ) === "1,2,4",
          )),
      );
      await settings(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => scrollTo(0, 0));
      assert(
        "language settings fit390px",
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.locator("#toast").waitFor({ state: "hidden" });
      await page
        .locator("#group-name-language")
        .evaluate((el) =>
          el.closest("section").scrollIntoView({ block: "start" }),
        );
      await page.screenshot({
        path: path.join(
          root,
          "qa/screenshots/preview-140-language-settings.png",
        ),
      });
      report.screenshots.push(
        "qa/screenshots/preview-140-language-settings.png",
      );
      await audit(page, "narrow multilingual naming preferences", assert);
    },
  );
} catch (error) {
  report.fatalError = error.stack || error.message;
} finally {
  if (browser) await browser.close();
  await preview.close();
  report.passed =
    !report.fatalError &&
    report.scenarios.length === 41 &&
    report.scenarios.every((item) => item.passed) &&
    report.checks.every((item) => item.passed) &&
    report.pageErrors.length === 0 &&
    report.unexpectedRequests.length === 0;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        sourceVersion: report.sourceVersion,
        passed: report.passed,
        scenarios: report.scenarios.map(({ name, passed, error }) => ({
          name,
          passed,
          error,
        })),
        checks: report.checks.length,
        pageErrors: report.pageErrors.length,
        unexpectedRequests: report.unexpectedRequests.length,
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
}
