import test from "node:test";
import assert from "node:assert/strict";
import {
  createHistoryIndex,
  historyKey,
  summarizeVisits,
} from "../extension/history-index.mjs";

const DAY = 86_400_000;
const T = 200 * DAY;
const copy = (value) =>
  value === undefined ? undefined : structuredClone(value);
function memoryStore() {
  const records = new Map();
  let meta,
    abortCommit = false;
  return {
    records,
    async get(key) {
      return copy(records.get(key));
    },
    async put(record) {
      records.set(record.key, copy(record));
    },
    abortNextCommit() {
      abortCommit = true;
    },
    async commit(record, nextMeta) {
      // Model an IDB transaction: stage both values and expose neither if it
      // aborts, including a fault after the record request was accepted.
      const stagedRecord = copy(record),
        stagedMeta = copy(nextMeta);
      if (abortCommit) {
        abortCommit = false;
        throw new Error("History transaction aborted");
      }
      records.set(stagedRecord.key, stagedRecord);
      meta = stagedMeta;
    },
    async count() {
      return records.size;
    },
    async getMeta() {
      return copy(meta);
    },
    async setMeta(value) {
      meta = copy(value);
    },
    async clear() {
      records.clear();
      meta = undefined;
    },
    async sweep(generation) {
      for (const [key, value] of records)
        if (value.generation !== generation) records.delete(key);
    },
  };
}
function timers() {
  const jobs = new Map();
  let next = 0;
  return {
    setTimer(fn, delay) {
      const id = ++next;
      jobs.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      jobs.delete(id);
    },
    async run(delay) {
      for (const [id, job] of [...jobs]) {
        if (delay !== undefined && job.delay !== delay) continue;
        jobs.delete(id);
        job.fn();
        await Promise.resolve();
      }
    },
    jobs,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function item(index, lastVisitTime = T - 1000 - index) {
  const url = `https://history-${index}.example.test/article?entry=${index}#position`;
  return {
    item: {
      id: String(index),
      url,
      title: `Private history title ${index}`,
      lastVisitTime,
      visitCount: 100 + (index % 9),
    },
    visits: [
      {
        visitId: `${index}-old`,
        visitTime: lastVisitTime - 40 * DAY,
        transition: "link",
      },
      {
        visitId: `${index}-recent`,
        visitTime: lastVisitTime - 3 * DAY,
        transition: "typed",
      },
      {
        visitId: `${index}-last`,
        visitTime: lastVisitTime,
        transition: "link",
      },
    ],
  };
}
function fixture(rows = [], options = {}) {
  const dataset = new Map(rows.map((row) => [row.item.url, row]));
  const store = options.store || memoryStore(),
    clock = timers();
  let at = options.at ?? T,
    permission = true;
  const calls = { search: [], visits: [], permissions: 0 },
    statuses = [];
  const api = {
    permissions: {
      async contains() {
        calls.permissions++;
        return permission;
      },
    },
    history: {
      async search(query) {
        calls.search.push(copy(query));
        // Both endpoints are inclusive. This intentionally exercises overlap
        // deduplication rather than assuming a convenient exclusive boundary.
        return [...dataset.values()]
          .map((row) => row.item)
          .filter(
            (row) =>
              row.lastVisitTime >= query.startTime &&
              row.lastVisitTime <= query.endTime,
          )
          .sort(
            (a, b) =>
              b.lastVisitTime - a.lastVisitTime || a.url.localeCompare(b.url),
          )
          .slice(0, query.maxResults)
          .map(copy);
      },
      async getVisits({ url }) {
        calls.visits.push(url);
        return copy(dataset.get(url)?.visits || []);
      },
    },
  };
  const create = (extra = {}) =>
    createHistoryIndex(api, {
      store,
      now: () => at,
      onChange: (state) => statuses.push(copy(state)),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...options,
      ...extra,
    });
  const index = create();
  return {
    api,
    store,
    clock,
    calls,
    statuses,
    dataset,
    index,
    create,
    setTime(value) {
      at = value;
    },
    setPermission(value) {
      permission = value;
    },
  };
}
const enable = (index) =>
  index.configure({ enabled: true, historyEnabled: true });

test("visit aggregates deduplicate browser IDs and separate returned visits from Chrome's total counter", () => {
  const visits = [
    { visitId: "old", visitTime: T - 40 * DAY },
    { visitId: "boundary", visitTime: T - 30 * DAY },
    { visitId: "last", visitTime: T - 1 },
    { visitId: "last", visitTime: T - 1 },
    { visitId: "future", visitTime: T + 1 },
    { visitId: "bad", visitTime: NaN },
    { visitId: "negative", visitTime: -1 },
  ];
  assert.deepEqual(summarizeVisits({ visitCount: 900 }, visits, T), {
    visits: 3,
    recentVisits: 2,
    lastVisitTime: T - 1,
    browserVisitCount: 900,
    observedAt: T,
  });
});

test("all 10,057 available URLs are indexed and facts cover120 open URLs without a result cap", async () => {
  const rows = Array.from({ length: 10_057 }, (_, i) =>
    item(i, T - 1000 - i * 1000),
  );
  const f = fixture(rows);
  await enable(f.index);
  await f.index.whenIdle();
  const status = f.index.snapshot();
  assert.equal(status.state, "ready");
  assert.equal(status.coverage, "available browser history");
  assert.equal(status.indexedURLs, rows.length);
  assert.equal(status.processedURLs, rows.length);
  assert.equal(status.analyzedVisits, rows.length * 3);
  assert.equal(f.store.records.size, rows.length);
  assert.equal(f.calls.visits.length, rows.length);
  assert.equal(new Set(f.calls.visits).size, rows.length);
  assert.ok(f.calls.search.some((query) => query.startTime === 0));
  assert.ok(
    f.statuses.filter((state) => state.state === "indexing").length > 10,
  );
  const open = Array.from(
    { length: 120 },
    (_, i) => rows[Math.floor((i * (rows.length - 1)) / 119)],
  );
  const facts = await f.index.facts(open.map((row) => row.item.url));
  assert.equal(Object.keys(facts).length, 120);
  for (const row of open) {
    const fact = facts[row.item.url];
    assert.equal(fact.visits, 3);
    assert.equal(fact.recentVisits, 2);
    assert.equal(fact.browserVisitCount, row.item.visitCount);
    assert.equal(fact.lastVisitTime, row.item.lastVisitTime);
    assert.equal(fact.partial, false);
  }
});

test("dense equal timestamps increase the browser batch limit without losing URLs or double-counting boundaries", async () => {
  const rows = Array.from({ length: 1037 }, (_, i) => item(i, T - 2));
  const f = fixture(rows, { batchSize: 16, workPerTurn: 100 });
  await enable(f.index);
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().indexedURLs, 1037);
  assert.equal(f.index.snapshot().processedURLs, 1037);
  assert.equal(new Set(f.calls.visits).size, 1037);
  assert.equal(f.calls.visits.length, 1037);
  assert.ok(f.calls.search.some((query) => query.maxResults >= 2048));
  assert.ok(
    f.calls.search.some((query) => query.endTime - query.startTime <= 1),
  );
});

test("storage contains only hashed per-URL aggregates and numeric range checkpoints", async () => {
  const rows = [
    item(1),
    item(2),
    { ...item(3), item: { ...item(3).item, url: "chrome://settings" } },
    {
      ...item(4),
      item: { ...item(4).item, url: "file:///private/local-notes.txt" },
    },
    {
      ...item(5),
      item: { ...item(5).item, url: "ftp://archive.example.test/file" },
    },
  ];
  const f = fixture(rows);
  await enable(f.index);
  await f.index.whenIdle();
  assert.equal(f.store.records.size, 5);
  assert.equal(f.index.snapshot().processedURLs, 5);
  assert.equal(f.calls.visits.length, 5);
  const allowed = [
    "key",
    "generation",
    "visits",
    "recentVisits",
    "lastVisitTime",
    "browserVisitCount",
    "observedAt",
  ].sort();
  for (const record of f.store.records.values()) {
    assert.match(record.key, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(record).sort(), allowed);
    assert.doesNotMatch(
      JSON.stringify(record),
      /https:|chrome:|file:|ftp:|Private history title|transition|visitId/,
    );
  }
  const meta = await f.store.getMeta();
  assert.doesNotMatch(
    JSON.stringify(meta),
    /example\.test|Private history title|visitId/,
  );
  assert.ok(
    meta.ranges.every(
      (range) => range.length === 3 && range.every(Number.isFinite),
    ),
  );
  const facts = await f.index.facts([
    rows[0].item.url,
    rows[0].item.url,
    "chrome://settings",
    "file:///private/local-notes.txt",
    "ftp://archive.example.test/file",
    "https://unknown.example",
  ]);
  assert.deepEqual(Object.keys(facts), [rows[0].item.url]);
  assert.notEqual(
    await historyKey(rows[0].item.url),
    await historyKey(`${rows[0].item.url}x`),
  );
});

test("a new worker resumes saved ranges without re-fetching already indexed URL visits", async () => {
  const rows = Array.from({ length: 43 }, (_, i) => item(i));
  const f = fixture(rows, { batchSize: 8, workPerTurn: 12 });
  await enable(f.index);
  for (let turn = 0; turn < 20 && !f.store.records.size; turn++)
    await f.index.pump();
  assert.ok(f.store.records.size > 0 && f.store.records.size < rows.length);
  const checkpoint = await f.store.getMeta();
  assert.ok(checkpoint.ranges.length > 0);
  await f.index.stop();
  const restarted = f.create();
  await enable(restarted);
  await restarted.whenIdle();
  assert.equal(restarted.snapshot().state, "ready");
  assert.equal(restarted.snapshot().indexedURLs, rows.length);
  assert.equal(restarted.snapshot().processedURLs, rows.length);
  assert.equal(f.calls.visits.length, rows.length);
});

test("new visits trigger an overlapping incremental update while retaining unchanged URL facts", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => item(i));
  const f = fixture(rows);
  await enable(f.index);
  await f.index.whenIdle();
  const initialLookups = f.calls.visits.length;
  f.setTime(T + 1000);
  const changed = item(1, T + 200),
    added = item(99, T + 999);
  changed.visits.push({ visitId: "added", visitTime: T + 100 });
  f.dataset.set(changed.item.url, changed);
  f.dataset.set(added.item.url, added);
  await f.index.changed();
  assert.equal(f.index.snapshot().state, "updating");
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().indexedURLs, 21);
  assert.equal(f.index.snapshot().processedURLs, 2);
  assert.equal(f.calls.visits.length - initialLookups, 2);
  assert.ok(f.calls.search.some((query) => query.startTime === T - 1));
  const facts = await f.index.facts([
    changed.item.url,
    added.item.url,
    rows[2].item.url,
  ]);
  assert.equal(facts[changed.item.url].visits, 4);
  assert.equal(facts[added.item.url].visits, 3);
  assert.equal(facts[rows[2].item.url].visits, 3);
});

test("a visit arriving during indexing is processed in a follow-up pass", async () => {
  const f = fixture([item(1)]),
    entered = deferred(),
    gate = deferred();
  const getVisits = f.api.history.getVisits;
  let first = true;
  f.api.history.getVisits = async (request) => {
    if (first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
    return getVisits(request);
  };
  await enable(f.index);
  const running = f.index.pump();
  await entered.promise;
  f.setTime(T + 1000);
  const added = item(2, T + 100);
  f.dataset.set(added.item.url, added);
  await f.index.changed();
  gate.resolve();
  await running;
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "ready");
  assert.equal(f.index.snapshot().indexedURLs, 2);
  assert.equal(
    (await f.index.facts([added.item.url]))[added.item.url].visits,
    3,
  );
});

test("history deletions purge retained aggregates and reindex only remaining browser records", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => item(i)),
    f = fixture(rows);
  await enable(f.index);
  await f.index.whenIdle();
  f.dataset.delete(rows[4].item.url);
  await f.index.removed();
  assert.equal(f.store.records.size, 0);
  assert.deepEqual(await f.index.facts([rows[4].item.url]), {});
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().indexedURLs, 11);
  assert.deepEqual(await f.index.facts([rows[4].item.url]), {});
  f.dataset.clear();
  await f.index.removed();
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "ready");
  assert.equal(f.index.snapshot().indexedURLs, 0);
  assert.equal(f.store.records.size, 0);
});

test("observation pause, opt-out and denied permission never query browsing history", async () => {
  const f = fixture([item(1)]);
  await f.index.configure({ enabled: false, historyEnabled: true });
  assert.equal(f.index.snapshot().state, "paused");
  await f.index.configure({ enabled: true, historyEnabled: false });
  assert.equal(f.index.snapshot().state, "off");
  f.setPermission(false);
  await enable(f.index);
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "denied");
  assert.equal(f.calls.search.length, 0);
  assert.equal(f.calls.visits.length, 0);
  assert.deepEqual(await f.index.facts([item(1).item.url]), {});
});

test("revocation clears stored facts and a late getVisits response cannot restore them", async () => {
  const f = fixture([item(1), item(2)]),
    entered = deferred(),
    gate = deferred();
  const getVisits = f.api.history.getVisits;
  let calls = 0;
  f.api.history.getVisits = async (request) => {
    if (++calls === 2) {
      entered.resolve();
      await gate.promise;
    }
    return getVisits(request);
  };
  await enable(f.index);
  const pending = f.index.pump();
  await entered.promise;
  assert.equal(f.store.records.size, 1);
  f.setPermission(false);
  await f.index.revoked();
  assert.equal(f.index.snapshot().state, "denied");
  assert.equal(f.store.records.size, 0);
  gate.resolve();
  await pending;
  assert.equal(f.store.records.size, 0);
  assert.equal(f.index.snapshot().state, "denied");
  assert.deepEqual(await f.index.facts([item(1).item.url]), {});
});

test("erase wins against a pending permission check and no late enable starts discovery", async () => {
  const f = fixture([item(1)]),
    entered = deferred(),
    gate = deferred();
  f.api.permissions.contains = async () => {
    entered.resolve();
    return gate.promise;
  };
  const enabling = enable(f.index);
  await entered.promise;
  await f.index.stop({ erase: true });
  gate.resolve(true);
  await enabling;
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "off");
  assert.equal(f.calls.search.length, 0);
  assert.equal(f.store.records.size, 0);
  assert.equal(await f.store.getMeta(), undefined);
});

test("API failures expose genuine partial progress and retry the saved unfinished range", async () => {
  const f = fixture([item(1), item(2), item(3), item(4)]);
  const getVisits = f.api.history.getVisits;
  let lookups = 0;
  f.api.history.getVisits = async (request) => {
    if (++lookups === 3) throw new Error("Chrome visit lookup failed");
    return getVisits(request);
  };
  await enable(f.index);
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "error");
  assert.equal(f.index.snapshot().coverage, "partial");
  assert.equal(f.index.snapshot().processedURLs, 2);
  assert.equal(f.index.snapshot().analyzedVisits, 6);
  assert.equal(f.store.records.size, 2);
  assert.ok((await f.store.getMeta()).ranges.length > 0);
  await f.index.retry();
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "ready");
  assert.equal(f.index.snapshot().indexedURLs, 4);
  assert.equal(f.index.snapshot().processedURLs, 4);
  assert.equal(f.calls.visits.length, 4);
});

test("a hung browser lookup times out as partial and late completion cannot claim readiness", async () => {
  const f = fixture([item(1)], { timeoutMs: 15 }),
    entered = deferred(),
    gate = deferred();
  f.api.history.search = async () => {
    entered.resolve();
    return gate.promise;
  };
  await enable(f.index);
  const pending = f.index.pump();
  await entered.promise;
  await f.clock.run(15);
  await pending;
  assert.equal(f.index.snapshot().state, "error");
  assert.equal(f.index.snapshot().coverage, "partial");
  assert.equal(f.index.snapshot().processedURLs, 0);
  gate.resolve([item(1).item]);
  await Promise.resolve();
  assert.equal(f.index.snapshot().state, "error");
  assert.equal(f.store.records.size, 0);
});

test("erase wins against a pending retry permission check", async () => {
  const f = fixture([item(1)]),
    entered = deferred(),
    gate = deferred();
  const search = f.api.history.search;
  f.api.history.search = async () => {
    throw new Error("retryable search failure");
  };
  await enable(f.index);
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "error");
  f.api.history.search = search;
  f.api.permissions.contains = async () => {
    entered.resolve();
    return gate.promise;
  };
  const retrying = f.index.retry();
  await entered.promise;
  await f.index.stop({ erase: true });
  gate.resolve(true);
  await retrying;
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "off");
  assert.equal(f.store.records.size, 0);
  assert.equal(await f.store.getMeta(), undefined);
});

test("erase wins against a deletion-triggered reindex waiting for permission", async () => {
  const f = fixture([item(1)]),
    entered = deferred(),
    gate = deferred();
  await enable(f.index);
  await f.index.whenIdle();
  f.api.permissions.contains = async () => {
    entered.resolve();
    return gate.promise;
  };
  const removing = f.index.removed();
  await entered.promise;
  await f.index.stop({ erase: true });
  gate.resolve(true);
  await removing;
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "off");
  assert.equal(f.store.records.size, 0);
});

test("a late permission recheck after API failure cannot replace an erased state with error", async () => {
  const f = fixture([item(1)]),
    entered = deferred(),
    gate = deferred();
  await enable(f.index);
  let checks = 0;
  f.api.permissions.contains = async () => {
    if (++checks === 1) return true;
    entered.resolve();
    return gate.promise;
  };
  f.api.history.search = async () => {
    throw new Error("search failed");
  };
  const running = f.index.pump();
  await entered.promise;
  await f.index.stop({ erase: true });
  gate.resolve(true);
  await running;
  assert.equal(f.index.snapshot().state, "off");
  assert.equal(f.store.records.size, 0);
  assert.equal(await f.store.getMeta(), undefined);
});

test("an aborted atomic commit rolls back record and checkpoint before a worker resumes", async () => {
  const rows = [item(1), item(2), item(3)],
    f = fixture(rows);
  const commit = f.store.commit;
  let failed = false;
  f.store.commit = async (record, value) => {
    if (!failed && value.processedURLs === 2) {
      failed = true;
      f.store.abortNextCommit();
    }
    await commit(record, value);
  };
  await enable(f.index);
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "error");
  assert.equal(f.store.records.size, 1);
  assert.equal((await f.store.getMeta()).processedURLs, 1);
  assert.equal((await f.store.getMeta()).analyzedVisits, 3);
  assert.equal(f.index.snapshot().processedURLs, 1);
  await f.index.stop();
  const restarted = f.create();
  await enable(restarted);
  await restarted.whenIdle();
  assert.equal(restarted.snapshot().state, "ready");
  assert.equal(restarted.snapshot().indexedURLs, 3);
  assert.equal(restarted.snapshot().processedURLs, 3);
  assert.equal(restarted.snapshot().analyzedVisits, 9);
  assert.equal(
    Object.keys(await restarted.facts(rows.map((row) => row.item.url))).length,
    3,
  );
});

test("a permission-check API failure is partial error, not a claim of revocation or a silent purge", async () => {
  const f = fixture([item(1)]);
  await enable(f.index);
  await f.index.whenIdle();
  f.setTime(T + 1000);
  await f.index.changed();
  f.api.permissions.contains = async () => {
    throw new Error("Chrome permissions service did not respond");
  };
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "error");
  assert.equal(f.index.snapshot().coverage, "partial");
  assert.equal(f.store.records.size, 1);
  assert.ok(await f.store.getMeta());
});

test("a later full scan removes expired browser records and recalculates the rolling30-day count", async () => {
  const first = item(1),
    expired = item(2),
    f = fixture([first, expired]);
  await enable(f.index);
  await f.index.whenIdle();
  f.dataset.delete(expired.item.url);
  f.setTime(T + 31 * DAY);
  await f.index.changed();
  assert.equal(f.index.snapshot().state, "indexing");
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().indexedURLs, 1);
  assert.deepEqual(await f.index.facts([expired.item.url]), {});
  const facts = await f.index.facts([first.item.url]);
  assert.equal(facts[first.item.url].visits, 3);
  assert.equal(facts[first.item.url].recentVisits, 0);
  assert.equal(facts[first.item.url].observedAt, T + 31 * DAY);
});

test("a stored-fact read failure returns no evidence and partial error instead of rejecting core evaluation", async () => {
  const rows = [item(1), item(2)],
    f = fixture(rows);
  await enable(f.index);
  await f.index.whenIdle();
  const get = f.store.get;
  let reads = 0;
  f.store.get = async (key) => {
    if (++reads === 2) throw new Error("History record could not be read");
    return get(key);
  };
  assert.deepEqual(await f.index.facts(rows.map((row) => row.item.url)), {});
  assert.equal(f.index.snapshot().state, "error");
  assert.equal(f.index.snapshot().coverage, "partial");
  assert.equal(f.store.records.size, 2);
  assert.equal((await f.store.getMeta()).indexedURLs, 2);
});

test("concurrent configure and an arriving visit share initialization while getMeta is pending", async () => {
  const f = fixture([item(1)]),
    entered = deferred(),
    gate = deferred();
  const getMeta = f.store.getMeta,
    setMeta = f.store.setMeta;
  let loads = 0,
    fullInitializations = 0;
  f.store.getMeta = async () => {
    loads++;
    entered.resolve();
    await gate.promise;
    return getMeta();
  };
  f.store.setMeta = async (value) => {
    if (value.full && value.processedURLs === 0) fullInitializations++;
    return setMeta(value);
  };
  const first = enable(f.index);
  await entered.promise;
  const second = enable(f.index);
  f.setTime(T + 1000);
  const added = item(2, T + 500);
  f.dataset.set(added.item.url, added);
  await f.index.changed();
  gate.resolve();
  await Promise.all([first, second]);
  await f.index.whenIdle();
  assert.equal(loads, 1);
  assert.equal(fullInitializations, 1);
  assert.equal(f.index.snapshot().state, "ready");
  assert.equal(f.index.snapshot().indexedURLs, 2);
  const facts = await f.index.facts([item(1).item.url, added.item.url]);
  assert.equal(Object.keys(facts).length, 2);
  assert.equal(facts[added.item.url].lastVisitTime, T + 500);
  assert.equal(facts[added.item.url].visits, 3);
});

test("stale retry cannot restart a paused, erased, or disabled history index", async () => {
  for (const mode of ["paused", "erased", "history-off"]) {
    const f = fixture([item(1), item(2)]);
    await enable(f.index);
    await f.index.whenIdle();
    if (mode === "paused")
      await f.index.configure({ enabled: false, historyEnabled: true });
    else if (mode === "erased") await f.index.stop({ erase: true });
    else await f.index.configure({ enabled: true, historyEnabled: false });
    const before = copy(f.calls),
      status = f.index.snapshot(),
      records = [...f.store.records],
      meta = await f.store.getMeta();
    await f.index.retry();
    await f.index.whenIdle();
    assert.deepEqual(
      f.calls,
      before,
      `${mode} retry must not even check permission`,
    );
    assert.deepEqual(f.index.snapshot(), status);
    assert.deepEqual([...f.store.records], records);
    assert.deepEqual(await f.store.getMeta(), meta);
    assert.equal(f.clock.jobs.size, 0);
    // A later explicit enable restores normal work; cancellation is not permanent.
    await enable(f.index);
    await f.index.whenIdle();
    assert.equal(f.index.snapshot().state, "ready");
    assert.ok(f.calls.search.length > before.search.length);
  }
});

test("pause wins against a retry already waiting for permission", async () => {
  const f = fixture([item(1)]),
    entered = deferred(),
    gate = deferred();
  const search = f.api.history.search;
  f.api.history.search = async () => {
    throw new Error("Retryable synthetic failure");
  };
  await enable(f.index);
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "error");
  f.api.history.search = search;
  f.api.permissions.contains = async () => {
    entered.resolve();
    return gate.promise;
  };
  const pending = f.index.retry();
  await entered.promise;
  await f.index.configure({ enabled: false, historyEnabled: true });
  const before = copy(f.calls),
    statuses = f.statuses.length;
  gate.resolve(true);
  await pending;
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "paused");
  assert.deepEqual(f.calls, before);
  assert.equal(f.statuses.length, statuses);
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.store.records.size, 0);
});

test("automatic reindex after a browser deletion still allows an enabled error retry", async () => {
  const rows = [item(1), item(2), item(3)],
    f = fixture(rows);
  await enable(f.index);
  await f.index.whenIdle();
  f.dataset.delete(rows[0].item.url);
  const search = f.api.history.search;
  f.api.history.search = async () => {
    throw new Error("Retryable deletion reindex failure");
  };
  await f.index.removed();
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "error");
  assert.equal(f.store.records.size, 0);
  f.api.history.search = search;
  await f.index.retry();
  await f.index.whenIdle();
  assert.equal(f.index.snapshot().state, "ready");
  assert.equal(f.index.snapshot().indexedURLs, 2);
  assert.equal(f.store.records.size, 2);
  assert.equal(
    await f.store.get(await historyKey(rows[0].item.url)),
    undefined,
  );
});
