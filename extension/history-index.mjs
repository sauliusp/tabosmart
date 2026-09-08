import { isWebURL } from "./core.mjs";

export const HISTORY_ALARM = "tabosmart.history";
const DAY = 86_400_000;
export async function historyKey(url) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** IndexedDB stores hashed URL aggregates, never history titles or visit lists. */
export function createHistoryStore(indexedDB = globalThis.indexedDB) {
  let opening;
  function db() {
    if (!opening)
      opening = new Promise((resolve, reject) => {
        if (!indexedDB)
          return reject(new Error("Local history storage is unavailable."));
        const request = indexedDB.open("tabosmart.history", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("records", { keyPath: "key" });
          request.result.createObjectStore("meta");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        opening = null;
        throw error;
      });
    return opening;
  }
  async function operation(store, mode, run) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, mode),
        object = tx.objectStore(store);
      let result;
      const request = run(object);
      if (request)
        request.onsuccess = () => {
          result = request.result;
        };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("History storage could not finish."));
    });
  }
  return {
    get: (key) => operation("records", "readonly", (s) => s.get(key)),
    put: (record) => operation("records", "readwrite", (s) => s.put(record)),
    async commit(record, meta) {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(["records", "meta"], "readwrite");
        tx.objectStore("records").put(record);
        tx.objectStore("meta").put(meta, "index");
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () =>
          reject(tx.error || new Error("History checkpoint could not finish."));
      });
    },
    count: () => operation("records", "readonly", (s) => s.count()),
    getMeta: () => operation("meta", "readonly", (s) => s.get("index")),
    setMeta: (value) =>
      operation("meta", "readwrite", (s) => s.put(value, "index")),
    async clear() {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(["records", "meta"], "readwrite");
        tx.objectStore("records").clear();
        tx.objectStore("meta").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () =>
          reject(tx.error || new Error("History storage could not be erased."));
      });
    },
    async sweep(generation) {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction("records", "readwrite");
        const cursor = tx.objectStore("records").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (row.value.generation !== generation) row.delete();
          row.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
  };
}

export function summarizeVisits(item, visits, at) {
  const unique = new Set();
  let count = 0,
    recentVisits = 0,
    lastVisitTime = 0;
  for (const visit of visits) {
    if (
      !Number.isFinite(visit.visitTime) ||
      visit.visitTime < 0 ||
      visit.visitTime > at
    )
      continue;
    const key = visit.visitId ?? `${visit.visitTime}:${visit.transition || ""}`;
    if (unique.has(key)) continue;
    unique.add(key);
    count++;
    lastVisitTime = Math.max(lastVisitTime, visit.visitTime);
    if (at - visit.visitTime <= 30 * DAY) recentVisits++;
  }
  return {
    visits: count,
    recentVisits,
    lastVisitTime,
    browserVisitCount: Number.isFinite(item.visitCount)
      ? Math.max(0, item.visitCount)
      : null,
    observedAt: at,
  };
}

/** Resumable time-partitioned discovery. Limits bound calls, never coverage. */
export function createHistoryIndex(
  api,
  {
    store = createHistoryStore(),
    now = () => Date.now(),
    onChange = () => {},
    batchSize = 256,
    workPerTurn = 200,
    timeoutMs = 15000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let epoch = 0,
    active = false,
    observationEnabled = false,
    wanted = false,
    configured = false;
  let timer = null,
    runPromise = null,
    loaded = false,
    meta = null;
  let writes = Promise.resolve(),
    followup = false,
    starting = null;
  let status = {
    state: "off",
    processedURLs: 0,
    analyzedVisits: 0,
    indexedURLs: 0,
  };
  const snapshot = () => ({ ...status });
  function emit() {
    try {
      onChange(snapshot());
    } catch {}
  }
  function save(task, token = epoch) {
    const result = writes
      .catch(() => {})
      .then(() => (token === epoch ? task() : undefined));
    writes = result;
    return result;
  }
  async function lookup(promise) {
    let timeout;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "The history lookup did not finish. Coverage remains partial; retry when Chrome is ready.",
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  async function allowed() {
    return (
      !!api.history?.search &&
      !!api.history?.getVisits &&
      (await lookup(
        api.permissions?.contains({ permissions: ["history"] }),
      )) === true
    );
  }
  async function load(token = epoch) {
    if (loaded) return;
    const stored = await store.getMeta();
    if (token !== epoch) return;
    meta = stored;
    loaded = true;
    if (meta?.version !== 1 || !Array.isArray(meta.ranges)) meta = null;
  }
  function showMeta(state) {
    status = {
      state,
      processedURLs: meta?.processedURLs || 0,
      analyzedVisits: meta?.analyzedVisits || 0,
      indexedURLs: meta?.indexedURLs || 0,
      startedAt: meta?.startedAt || null,
      completedAt: meta?.completedAt || null,
      coverage: state === "ready" ? "available browser history" : "partial",
    };
    emit();
  }
  function schedule() {
    if (!active || timer !== null || runPromise) return;
    timer = setTimer(() => {
      timer = null;
      void pump();
    }, 0);
  }
  function start(full = false) {
    if (starting?.token === epoch) return starting.promise;
    const token = epoch;
    const promise = startWork(full).finally(() => {
      if (starting?.promise === promise) starting = null;
    });
    starting = { token, promise };
    return promise;
  }
  async function startWork(full = false) {
    const token = epoch;
    await load(token);
    if (token !== epoch || !active) return;
    const end = now();
    if (meta?.ranges.length) {
      showMeta(meta.full ? "indexing" : "updating");
      schedule();
      return;
    }
    const fullScan =
      full || !meta?.lastSyncAt || end - (meta.lastFullAt || 0) >= DAY;
    meta = {
      version: 1,
      generation: `${end}-${crypto.randomUUID()}`,
      full: fullScan,
      ranges: [
        [fullScan ? 0 : Math.max(0, meta.lastSyncAt - 1), end + 1, batchSize],
      ],
      processedURLs: 0,
      analyzedVisits: 0,
      indexedURLs: meta?.indexedURLs || 0,
      startedAt: end,
      completedAt: null,
      lastSyncAt: meta?.lastSyncAt || 0,
      lastFullAt: meta?.lastFullAt || 0,
    };
    await save(() => store.setMeta(meta), token);
    if (token !== epoch || !active) return;
    showMeta(fullScan ? "indexing" : "updating");
    schedule();
  }
  async function denied() {
    await stop({ erase: true });
    status = {
      state: "denied",
      processedURLs: 0,
      analyzedVisits: 0,
      indexedURLs: 0,
      coverage: "none",
    };
    emit();
  }
  async function pump() {
    if (runPromise || !active) return runPromise;
    const token = epoch;
    runPromise = (async () => {
      if (!(await allowed())) {
        if (token === epoch) await denied();
        return;
      }
      let work = 0;
      while (
        active &&
        token === epoch &&
        meta?.ranges.length &&
        work < workPerTurn
      ) {
        const range = meta.ranges[meta.ranges.length - 1];
        const [startTime, endTime, maxResults] = range;
        const items = await lookup(
          api.history.search({
            text: "",
            startTime,
            endTime,
            maxResults,
          }),
        );
        if (token !== epoch || !active) return;
        work++;
        if (!Array.isArray(items))
          throw new Error("Chrome returned an unreadable history batch.");
        if (items.length >= maxResults) {
          meta.ranges.pop();
          if (endTime - startTime > 1) {
            const middle = Math.floor((startTime + endTime) / 2);
            // Overlapping boundaries prevent dropping equal timestamps. The
            // generation key deduplicates any URL returned in both partitions.
            meta.ranges.push(
              [startTime, middle, batchSize],
              [middle, endTime, batchSize],
            );
          } else {
            if (maxResults > 1_000_000_000)
              throw new Error(
                "Chrome’s result limit prevents complete coverage of a dense timestamp. Coverage remains partial.",
              );
            meta.ranges.push([startTime, endTime, maxResults * 2]);
          }
          await save(() => store.setMeta(meta), token);
          continue;
        }
        let finished = true;
        for (const item of items) {
          // Analyze every URL Chrome returns, including non-web schemes. Only
          // open HTTP(S) tabs can use these aggregates in actionable reviews.
          if (typeof item?.url !== "string" || !item.url) continue;
          const key = await historyKey(item.url);
          const prior = await store.get(key);
          if (token !== epoch || !active) return;
          if (prior?.generation === meta.generation) continue;
          if (work >= workPerTurn) {
            finished = false;
            break;
          }
          const visits = await lookup(api.history.getVisits({ url: item.url }));
          work++;
          if (token !== epoch || !active) return;
          if (!Array.isArray(visits))
            throw new Error("Chrome returned an unreadable visit list.");
          const record = {
            key,
            generation: meta.generation,
            ...summarizeVisits(item, visits, now()),
          };
          const nextMeta = {
            ...meta,
            processedURLs: meta.processedURLs + 1,
            analyzedVisits: meta.analyzedVisits + record.visits,
          };
          // One IndexedDB transaction commits the record and its counters. A
          // suspended worker cannot skip a row that its checkpoint did not count.
          await save(() => store.commit(record, nextMeta), token);
          if (token !== epoch) return;
          meta = nextMeta;
        }
        if (finished) meta.ranges.pop();
        await save(() => store.setMeta(meta), token);
      }
      if (token !== epoch || !active) return;
      if (meta.ranges.length) {
        showMeta(meta.full ? "indexing" : "updating");
      } else {
        if (meta.full) await save(() => store.sweep(meta.generation), token);
        if (token !== epoch) return;
        const indexedURLs = await store.count();
        if (token !== epoch || !active) return;
        meta.indexedURLs = indexedURLs;
        meta.completedAt = now();
        meta.lastSyncAt = meta.startedAt;
        if (meta.full) meta.lastFullAt = meta.completedAt;
        await save(() => store.setMeta(meta), token);
        showMeta("ready");
        if (followup) {
          followup = false;
          await start();
        }
      }
    })()
      .catch(async (error) => {
        if (token !== epoch) return;
        let hasPermission = null;
        try {
          hasPermission = await allowed();
        } catch {}
        if (token !== epoch) return;
        if (hasPermission === false) {
          await denied();
          return;
        }
        active = false;
        status = {
          ...status,
          state: "error",
          processedURLs: meta?.processedURLs || 0,
          analyzedVisits: meta?.analyzedVisits || 0,
          coverage: "partial",
          detail:
            error.message ||
            "History review could not finish. Tab suggestions still work.",
        };
        emit();
      })
      .finally(() => {
        runPromise = null;
        if (active && meta?.ranges.length) schedule();
      });
    return runPromise;
  }
  async function configure({ enabled, historyEnabled }) {
    const token = epoch;
    observationEnabled = enabled === true;
    wanted = historyEnabled === true;
    configured = true;
    if (!wanted) {
      await stop({ erase: true });
      return snapshot();
    }
    if (!enabled) {
      await stop();
      status = { ...status, state: "paused" };
      emit();
      return snapshot();
    }
    const permission = await allowed();
    if (token !== epoch || !wanted) return snapshot();
    if (!permission) {
      await denied();
      return snapshot();
    }
    if (!active) {
      active = true;
      await start();
    }
    return snapshot();
  }
  async function stop({ erase = false } = {}) {
    epoch++;
    active = false;
    observationEnabled = false;
    followup = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (erase) {
      await writes.catch(() => {});
      try {
        await store.clear();
      } catch (error) {
        status = {
          ...status,
          state: "error",
          coverage: "partial",
          detail:
            "The local history index could not be erased. Try erasing local data again.",
        };
        emit();
        throw error;
      }
      meta = null;
      loaded = true;
      status = {
        state: "off",
        processedURLs: 0,
        analyzedVisits: 0,
        indexedURLs: 0,
        coverage: "none",
      };
    } else status = { ...status, state: "paused", coverage: "partial" };
    emit();
  }
  async function changed() {
    if (!active) return;
    if (starting?.token === epoch || runPromise || meta?.ranges.length) {
      followup = true;
      return;
    }
    await start();
  }
  async function removed() {
    const resume = active && wanted;
    await stop({ erase: true });
    const token = epoch;
    if (resume && (await allowed()) && token === epoch && wanted) {
      observationEnabled = true;
      active = true;
      await start(true);
    }
  }
  async function facts(urls) {
    if (
      !configured ||
      !wanted ||
      !active ||
      status.state === "denied" ||
      status.state === "off"
    )
      return {};
    const token = epoch,
      result = {};
    try {
      for (const url of new Set(urls.filter(isWebURL))) {
        const record = await store.get(await historyKey(url));
        if (token !== epoch) return {};
        if (record)
          result[url] = {
            visits: record.visits,
            recentVisits: record.recentVisits,
            lastVisitTime: record.lastVisitTime,
            observedAt: record.observedAt,
            browserVisitCount: record.browserVisitCount,
            partial: status.state !== "ready",
          };
      }
    } catch (error) {
      if (token !== epoch) return {};
      active = false;
      status = {
        ...status,
        state: "error",
        coverage: "partial",
        detail:
          error.message ||
          "History evidence could not be read. Tab suggestions still work.",
      };
      emit();
      return {};
    }
    return result;
  }
  return {
    configure: async (options) => {
      // Disabling history performs deletion. Its caller must distinguish a
      // committed opt-out from incomplete cleanup, including after stop's epoch
      // change. stop() already records the error and prevents further work.
      if (options.historyEnabled === false) return configure(options);
      const token = epoch;
      try {
        return await configure(options);
      } catch (error) {
        if (token !== epoch) return snapshot();
        active = false;
        status = {
          ...status,
          state: "error",
          coverage: "partial",
          detail: error.message,
        };
        emit();
        return snapshot();
      }
    },
    snapshot,
    pump,
    facts,
    changed,
    removed,
    revoked: denied,
    stop,
    retry: async () => {
      const token = epoch;
      if (
        observationEnabled &&
        wanted &&
        (await allowed()) &&
        token === epoch &&
        observationEnabled &&
        wanted
      ) {
        active = true;
        await start();
      }
    },
    whenIdle: async () => {
      while (runPromise || (active && meta?.ranges.length)) {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        await pump();
      }
    },
  };
}
