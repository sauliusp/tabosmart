import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPreviewServer } from "./preview-server.mjs";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "qa/history-storage-report.json");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "extension/manifest.json"), "utf8"),
);
const sourceFiles = ["history-index.mjs", "core.mjs"];
async function sourceHashes() {
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await fs.readFile(path.join(root, "extension", file)))
          .digest("hex"),
      ]),
    ),
  );
}
const report = {
  date: new Date().toISOString(),
  sourceVersion: manifest.version,
  evidence:
    "Actual source createHistoryStore and createHistoryIndex run against real browser IndexedDB in a disposable HTTP-origin Playwright context. History and permission APIs return synthetic fixture data only.",
  boundary:
    "No extension installation, installed extension URL, personal browser profile, actual Chrome history, or model access. This source storage test does not substitute for real-extension verification.",
  sourceHashes: await sourceHashes(),
  browser: null,
  dataset: { syntheticURLs: 257, syntheticVisits: 771 },
  checks: [],
  metrics: {},
  pageErrors: [],
  unexpectedRequests: [],
};
function check(name, passed, detail) {
  report.checks.push({
    name,
    passed: Boolean(passed),
    ...(detail === undefined ? {} : { detail }),
  });
  if (!passed) throw new Error(name);
}

// This function is serialized into the empty disposable page after each reload.
// The imported modules are served unchanged by createPreviewServer.
async function installHarness(page) {
  await page.evaluate(async () => {
    const module = await import("/history-index.mjs");
    const store = module.createHistoryStore();
    // Let the actual store create its schema before the read-only inspector
    // opens a second native connection to the same database.
    await store.count();
    const at = 200 * 86_400_000;
    const rows = Array.from({ length: 257 }, (_, index) => {
      const lastVisitTime = at - 1000 - index * 28_800_000;
      const url = `https://fixture-${index}.history.invalid/document?synthetic=${index}#section`;
      return {
        item: {
          id: String(index),
          url,
          title: `Synthetic private fixture title ${index}`,
          visitCount: 3,
          lastVisitTime,
        },
        visits: [0, 60_000, 40 * 86_400_000].map((offset, visit) => ({
          visitId: `${index}:${visit}`,
          visitTime: lastVisitTime - offset,
          transition: "link",
        })),
      };
    });
    const visited = [],
      searches = [],
      timers = new Map();
    let nextTimer = 1;
    const api = {
      permissions: {
        async contains(query) {
          if (
            JSON.stringify(query) !==
            JSON.stringify({ permissions: ["history"] })
          )
            throw new Error("Unexpected permission query");
          return true;
        },
      },
      history: {
        async search(query) {
          searches.push({ ...query });
          return rows
            .map((row) => row.item)
            .filter(
              (row) =>
                row.lastVisitTime >= query.startTime &&
                row.lastVisitTime <= query.endTime,
            )
            .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
            .slice(0, query.maxResults)
            .map((row) => ({ ...row }));
        },
        async getVisits({ url }) {
          visited.push(url);
          return (
            rows
              .find((row) => row.item.url === url)
              ?.visits.map((visit) => ({ ...visit })) || []
          );
        },
      },
    };
    async function inspect() {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("tabosmart.history", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = database.transaction(
            ["records", "meta"],
            "readonly",
          );
          const records = transaction.objectStore("records").getAll();
          const meta = transaction.objectStore("meta").getAll();
          transaction.oncomplete = () =>
            resolve({ records: records.result, meta: meta.result });
          transaction.onerror = transaction.onabort = () =>
            reject(transaction.error);
        });
      } finally {
        database.close();
      }
    }
    function createIndex() {
      return module.createHistoryIndex(api, {
        store,
        now: () => at,
        batchSize: 64,
        workPerTurn: 25,
        setTimer(fn) {
          const id = nextTimer++;
          timers.set(id, fn);
          return id;
        },
        clearTimer(id) {
          timers.delete(id);
        },
      });
    }
    // Abort after the records request succeeds inside the uncommitted native
    // transaction. Chrome must roll back it and the queued checkpoint together.
    async function abortAfterRecords(method, work) {
      const original = IDBObjectStore.prototype[method];
      let injected = false,
        scope = [];
      IDBObjectStore.prototype[method] = function (...args) {
        const request = original.apply(this, args);
        if (
          !injected &&
          this.name === "records" &&
          this.transaction.mode === "readwrite" &&
          this.transaction.objectStoreNames.contains("meta")
        ) {
          injected = true;
          scope = [...this.transaction.objectStoreNames];
          const transaction = this.transaction;
          request.addEventListener("success", () => transaction.abort(), {
            once: true,
          });
        }
        return request;
      };
      let rejected = false;
      try {
        await work();
      } catch {
        rejected = true;
      } finally {
        IDBObjectStore.prototype[method] = original;
      }
      return { injected, rejected, scope };
    }
    globalThis.storageQA = {
      module,
      store,
      inspect,
      abortAfterRecords,
      createIndex,
      rows,
      visited,
      searches,
      timers,
    };
  });
}

let server, browser, context;
try {
  server = await createPreviewServer(root);
  const origin = new URL(server.url).origin;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  report.browser = {
    engine: "Playwright Chromium",
    version: browser.version(),
    persistentProfile: false,
  };
  context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      report.unexpectedRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/index.html")
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><head><meta charset='utf-8'><title>Tabosmart synthetic IndexedDB QA</title></head><body><p>Disposable source storage test. No real browsing history is accessed.</p></body></html>",
      });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.goto(server.url);
  await installHarness(page);
  const first = await page.evaluate(async () => {
    const qa = storageQA,
      { store } = qa;
    const empty = await qa.inspect();
    const key = await qa.module.historyKey(qa.rows[0].item.url);
    const otherKey = await qa.module.historyKey(qa.rows[1].item.url);
    const baseline = {
      key,
      generation: "atomic-fixture",
      visits: 3,
      recentVisits: 2,
      lastVisitTime: 123,
      observedAt: 456,
      browserVisitCount: 3,
    };
    const checkpoint = {
      version: 1,
      processedURLs: 1,
      analyzedVisits: 3,
      ranges: [[0, 100, 64]],
    };
    await store.commit(baseline, checkpoint);
    const initial = await qa.inspect();
    const updateFault = await qa.abortAfterRecords("put", () =>
      store.commit(
        { ...baseline, visits: 99 },
        { ...checkpoint, analyzedVisits: 99 },
      ),
    );
    const afterUpdateFault = await qa.inspect();
    const insertFault = await qa.abortAfterRecords("put", () =>
      store.commit(
        { ...baseline, key: otherKey },
        { ...checkpoint, processedURLs: 2, analyzedVisits: 6 },
      ),
    );
    const afterInsertFault = await qa.inspect();
    await store.commit(
      { ...baseline, key: otherKey },
      { ...checkpoint, processedURLs: 2, analyzedVisits: 6 },
    );
    return {
      empty,
      initial,
      updateFault,
      afterUpdateFault,
      insertFault,
      afterInsertFault,
      committed: await qa.inspect(),
    };
  });
  check(
    "Disposable origin begins with empty records and checkpoint stores",
    first.empty.records.length === 0 && first.empty.meta.length === 0,
  );
  check(
    "Successful commit writes both a record and its checkpoint",
    first.initial.records.length === 1 &&
      first.initial.meta[0].processedURLs === 1 &&
      first.initial.meta[0].analyzedVisits === 3,
  );
  for (const [label, fault, result] of [
    ["updated record", first.updateFault, first.afterUpdateFault],
    ["new record", first.insertFault, first.afterInsertFault],
  ]) {
    check(
      `Injected ${label} failure aborts the real two-store transaction`,
      fault.injected &&
        fault.rejected &&
        fault.scope.includes("records") &&
        fault.scope.includes("meta"),
    );
    check(
      `Aborted ${label} commit leaves both stores exactly unchanged`,
      JSON.stringify(result) === JSON.stringify(first.initial),
    );
  }
  await page.reload();
  await installHarness(page);
  const reload = await page.evaluate(async () => {
    const before = await storageQA.inspect();
    await storageQA.store.clear();
    return { before, cleared: await storageQA.inspect() };
  });
  check(
    "Committed records and checkpoint survive a real page reload",
    JSON.stringify(reload.before) === JSON.stringify(first.committed),
  );
  check(
    "Clear removes both records and checkpoint before the index fixture",
    reload.cleared.records.length === 0 && reload.cleared.meta.length === 0,
  );

  const partial = await page.evaluate(async () => {
    const qa = storageQA,
      index = qa.createIndex();
    await index.configure({ enabled: true, historyEnabled: true });
    for (let turn = 0; turn < 10 && (await qa.store.count()) < 20; turn++)
      await index.pump();
    return {
      snapshot: index.snapshot(),
      data: await qa.inspect(),
      visited: qa.visited,
      searches: qa.searches.length,
    };
  });
  const partialCount = partial.data.records.length;
  check(
    "A bounded indexing turn persists genuine unfinished progress",
    partialCount > 0 &&
      partialCount < 257 &&
      partial.data.meta[0].ranges.length > 0 &&
      partial.snapshot.state === "indexing",
  );
  check(
    "Partial checkpoint counts exactly match durable record aggregates",
    partial.data.meta[0].processedURLs === partialCount &&
      partial.data.meta[0].analyzedVisits ===
        partial.data.records.reduce((sum, row) => sum + row.visits, 0),
  );
  // No graceful stop or save call: navigation discards the index instance while
  // retaining only data already committed to browser IndexedDB.
  await page.reload();
  await installHarness(page);
  const resumed = await page.evaluate(async () => {
    const qa = storageQA,
      before = await qa.inspect(),
      index = qa.createIndex();
    await index.configure({ enabled: true, historyEnabled: true });
    const start = index.snapshot();
    await index.whenIdle();
    const completed = index.snapshot(),
      data = await qa.inspect();
    const facts = await index.facts(qa.rows.map((row) => row.item.url));
    const clearFault = await qa.abortAfterRecords("clear", () =>
      qa.store.clear(),
    );
    const afterClearFault = await qa.inspect();
    await index.stop({ erase: true });
    return {
      before,
      start,
      completed,
      data,
      factCount: Object.keys(facts).length,
      visited: qa.visited,
      searches: qa.searches.length,
      clearFault,
      afterClearFault,
      erased: await qa.inspect(),
      stopped: index.snapshot(),
    };
  });
  check(
    "Reload preserves the exact unfinished record and checkpoint state",
    JSON.stringify(resumed.before) === JSON.stringify(partial.data),
  );
  check(
    "A new index resumes the saved generation and counters",
    resumed.start.processedURLs === partialCount &&
      resumed.data.meta[0].generation === partial.data.meta[0].generation,
  );
  check(
    "Resumed index finishes all 257 synthetic URLs and 771 retained visits",
    resumed.completed.state === "ready" &&
      resumed.completed.processedURLs === 257 &&
      resumed.completed.analyzedVisits === 771 &&
      resumed.completed.indexedURLs === 257 &&
      resumed.data.records.length === 257,
  );
  check(
    "Finished checkpoint has no unfinished ranges and matching aggregate counts",
    resumed.data.meta[0].ranges.length === 0 &&
      resumed.data.meta[0].processedURLs === 257 &&
      resumed.data.meta[0].analyzedVisits === 771,
  );
  const allVisits = [...partial.visited, ...resumed.visited];
  check(
    "Resume does not refetch already committed URL visits",
    allVisits.length === 257 && new Set(allVisits).size === 257,
  );
  check(
    "Exact-URL facts remain available for every synthetic open URL",
    resumed.factCount === 257,
  );
  const allowedFields = [
    "key",
    "generation",
    "visits",
    "recentVisits",
    "lastVisitTime",
    "observedAt",
    "browserVisitCount",
  ];
  check(
    "Raw IndexedDB stores contain only hashed numeric per-URL aggregates",
    resumed.data.records.every(
      (record) =>
        /^[a-f0-9]{64}$/.test(record.key) &&
        Object.keys(record).every((key) => allowedFields.includes(key)) &&
        Object.entries(record).every(
          ([key, value]) =>
            ["key", "generation"].includes(key) || Number.isFinite(value),
        ),
    ),
  );
  check(
    "Neither record nor checkpoint stores contain raw fixture URLs, titles, or visit lists",
    !/https?:\/\/|history\.invalid|Synthetic private fixture title|visitId|transition/.test(
      JSON.stringify(resumed.data),
    ),
  );
  check(
    "Injected erase failure aborts the real two-store transaction",
    resumed.clearFault.injected &&
      resumed.clearFault.rejected &&
      resumed.clearFault.scope.length === 2,
  );
  check(
    "An aborted erase preserves both record and checkpoint stores",
    JSON.stringify(resumed.afterClearFault) === JSON.stringify(resumed.data),
  );
  check(
    "Successful erase removes all records and checkpoints and stops the index",
    resumed.erased.records.length === 0 &&
      resumed.erased.meta.length === 0 &&
      resumed.stopped.state === "off",
  );
  await page.reload();
  await installHarness(page);
  const erasedAfterReload = await page.evaluate(() => storageQA.inspect());
  check(
    "Erasure remains complete after a fresh page and store instance",
    erasedAfterReload.records.length === 0 &&
      erasedAfterReload.meta.length === 0,
  );
  report.metrics = {
    partialRecordsBeforeReload: partialCount,
    finalIndexedURLs: resumed.completed.indexedURLs,
    analyzedVisits: resumed.completed.analyzedVisits,
    getVisitsCallsAcrossReload: allVisits.length,
    searchCallsAcrossReload: partial.searches + resumed.searches,
    injectedNativeTransactionAborts: 3,
    pageReloads: 3,
  };
  check(
    "Browser page reported no unhandled errors",
    report.pageErrors.length === 0,
  );
  check(
    "Every browser request stayed on the disposable localhost origin",
    report.unexpectedRequests.length === 0,
  );
  check(
    "Verified source files remained unchanged throughout this run",
    JSON.stringify(await sourceHashes()) ===
      JSON.stringify(report.sourceHashes),
  );
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  await server?.close();
  report.summary = {
    passed: report.checks.filter((item) => item.passed).length,
    failed: report.checks.filter((item) => !item.passed).length,
    status: report.error ? "failed" : "passed",
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: path.relative(root, output),
      ...report.summary,
      ...(report.error ? { error: report.error.message } : {}),
    }),
  );
}
