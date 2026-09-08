import { suggestName } from "./local-ai.mjs";

/** Exact metadata identity, independent of the displayed tab ordering. */
export function evidenceKeyFor(suggestion) {
  if (
    suggestion?.type !== "group" ||
    typeof suggestion.id !== "string" ||
    !suggestion.id ||
    !Array.isArray(suggestion.tabs) ||
    suggestion.tabs.length < 2
  )
    return null;
  if (
    suggestion.tabs.some((tab) => {
      if (
        tab?.incognito ||
        !Number.isInteger(tab?.id) ||
        typeof tab.url !== "string" ||
        tab.url.length > 16384
      )
        return true;
      try {
        const url = new URL(tab.url);
        return (
          !["http:", "https:"].includes(url.protocol) ||
          !!url.username ||
          !!url.password
        );
      } catch {
        return true;
      }
    }) ||
    new Set(suggestion.tabs.map((tab) => tab.id)).size !==
      suggestion.tabs.length
  )
    return null;
  return JSON.stringify({
    id: String(suggestion.id || ""),
    reason: String(suggestion.reason || ""),
    signal: String(suggestion.signal || ""),
    fallback: String(suggestion.proposedName || ""),
    namePreference: suggestion.namePreference || "auto",
    tabs: suggestion.tabs
      .map((tab) => [
        tab.id,
        tab.url,
        String(tab.title || ""),
        tab.windowId ?? null,
        tab.groupId ?? -1,
      ])
      .sort((a, b) => a[0] - b[0]),
  });
}

function sameName(a, b) {
  return (
    String(a || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase() ===
    String(b || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase()
  );
}
function validName(name) {
  return (
    typeof name === "string" &&
    name.trim() &&
    name.trim().length <= 36 &&
    name.trim().split(/\s+/u).length <= 4 &&
    !/[<>\n\r\u0000-\u001f\u007f]/u.test(name) &&
    !/https?:|www\./i.test(name)
  );
}

/**
 * Schedules optional names only. It never changes group membership or Chrome.
 * enabled must include observation consent and the local-AI preference.
 * sync/whenIdle resolve after the current queue settles. Manual request uses the
 * same evidence/cache and may explicitly retry outside the automatic budget.
 */
export function createProactiveNames({
  generate = suggestName,
  onName = () => {},
  onActivity = () => {},
  maxAutomaticAttempts = 10,
} = {}) {
  const budget = Number.isFinite(maxAutomaticAttempts)
    ? Math.min(20, Math.max(0, Math.floor(maxAutomaticAttempts)))
    : 10;
  const cache = new Map(),
    attempted = new Set(),
    pending = new Map();
  const latestManual = new Map();
  let proposals = new Map(),
    queue = [],
    active = null,
    epoch = 0;
  let automaticAttempts = 0,
    scheduled = false;
  let context = { enabled: false, available: false, visible: false };
  let idleWaiters = [];

  function canRun() {
    return context.enabled && context.available && context.visible;
  }
  function isCurrent(job) {
    return (
      job.epoch === epoch &&
      !job.controller.signal.aborted &&
      canRun() &&
      (!context.reviewing || context.reviewKey === job.key) &&
      (job.manual
        ? latestManual.get(job.id) === job.key
        : proposals.get(job.id) === job.key || context.reviewKey === job.key)
    );
  }
  function reportActivity() {
    try {
      onActivity({
        running: !!active && isCurrent(active),
        queued: queue.filter(isCurrent).length,
      });
    } catch {}
  }
  function notifyIdle() {
    reportActivity();
    if ((active && active.epoch === epoch) || queue.length || scheduled) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }
  function whenIdle() {
    if ((!active || active.epoch !== epoch) && !queue.length && !scheduled)
      return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }
  function getName(suggestion) {
    const key = evidenceKeyFor(suggestion),
      value = key && cache.get(key);
    return value ? { ...value } : null;
  }
  function settle(job, value) {
    if (pending.get(job.key) === job) pending.delete(job.key);
    job.resolve(value);
  }
  function cancelActive() {
    if (!active) return;
    if (!active.manual) attempted.delete(active.key);
    active.controller.abort();
    settle(active, null);
  }
  function schedule() {
    if (scheduled || active) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void pump();
    });
  }
  async function pump() {
    if (active) return;
    while (queue.length) {
      const job = queue.shift();
      if (!isCurrent(job) || (!job.manual && automaticAttempts >= budget)) {
        settle(job, null);
        continue;
      }
      active = job;
      reportActivity();
      if (!job.manual) automaticAttempts++;
      attempted.add(job.key);
      if (attempted.size > 128)
        attempted.delete(attempted.values().next().value);
      try {
        const name = await Promise.race([
          generate(
            job.suggestion.tabs,
            {
              signal: job.suggestion.signal,
              proposedName: job.suggestion.proposedName,
              namePreference: job.suggestion.namePreference,
            },
            { signal: job.controller.signal },
          ),
          job.cancelled,
        ]);
        if (
          !isCurrent(job) ||
          !validName(name) ||
          sameName(name, job.suggestion.proposedName)
        ) {
          settle(job, null);
          continue;
        }
        const result = {
          name: name.trim(),
          evidenceKey: job.key,
          source: "local-ai",
        };
        cache.set(job.key, result);
        if (cache.size > 128) cache.delete(cache.keys().next().value);
        settle(job, { ...result });
        try {
          onName({ suggestionId: job.id, ...result });
        } catch {
          /* UI callbacks do not own the queue. */
        }
      } catch {
        settle(job, null);
      } finally {
        active = null;
        reportActivity();
      }
    }
    notifyIdle();
  }
  function enqueue(suggestion, manual, retry = false) {
    const key = evidenceKeyFor(suggestion);
    if (!key || !canRun()) return Promise.resolve(null);
    const id = String(suggestion.id || "");
    if (manual) {
      latestManual.set(id, key);
      if (latestManual.size > 128)
        latestManual.delete(latestManual.keys().next().value);
    }
    if (pending.has(key)) {
      const existing = pending.get(key);
      // Opening a review removes automatic proposals. The explicit manual
      // request can adopt its still-running exact-evidence generation.
      if (manual) existing.manual = true;
      return existing.promise;
    }
    if (manual && active && active.key !== key) cancelActive();
    if (!retry && cache.has(key)) return Promise.resolve({ ...cache.get(key) });
    if (!retry && attempted.has(key)) return Promise.resolve(null);
    if (!manual && automaticAttempts >= budget) return Promise.resolve(null);
    if (
      !manual &&
      queue.filter((job) => !job.manual).length >= budget - automaticAttempts
    )
      return Promise.resolve(null);
    // Capture supplied evidence; caller edits cannot silently change the prompt.
    const captured = {
      id,
      type: "group",
      reason: String(suggestion.reason || ""),
      signal: suggestion.signal,
      proposedName: suggestion.proposedName,
      namePreference: suggestion.namePreference,
      tabs: suggestion.tabs.map((tab) => ({ ...tab })),
    };
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const job = {
      id,
      key,
      suggestion: captured,
      manual,
      epoch,
      resolve,
      promise,
      controller: new AbortController(),
    };
    job.cancelled = new Promise((done) =>
      job.controller.signal.addEventListener("abort", () => done(null), {
        once: true,
      }),
    );
    pending.set(key, job);
    if (manual) queue.unshift(job);
    else queue.push(job);
    schedule();
    reportActivity();
    return promise;
  }
  function stop() {
    epoch++;
    context = { ...context, enabled: false };
    proposals.clear();
    latestManual.clear();
    cancelActive();
    for (const job of queue.splice(0)) settle(job, null);
    pending.clear();
    notifyIdle();
  }
  function sync(suggestions, nextContext) {
    const next = {
      enabled: nextContext?.enabled === true,
      available: nextContext?.available === true,
      visible: nextContext?.visible === true,
      reviewing: !!nextContext?.reviewProposal,
      reviewKey: evidenceKeyFor(nextContext?.reviewProposal),
    };
    if (!next.enabled || !next.available || !next.visible) {
      stop();
      context = next;
      return whenIdle();
    }
    context = next;
    proposals = new Map();
    const eligible = [];
    for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
      const key = evidenceKeyFor(suggestion);
      if (!key) continue;
      proposals.set(String(suggestion.id || ""), key);
      eligible.push(suggestion);
    }
    // Keep an exact review job available for adoption, but release stale work
    // immediately when the selected tabs or their evidence changes.
    if (active && !isCurrent(active)) cancelActive();
    queue = queue.filter((job) => {
      if (isCurrent(job)) return true;
      settle(job, null);
      return false;
    });
    for (const suggestion of eligible) void enqueue(suggestion, false);
    notifyIdle();
    return whenIdle();
  }
  function reset() {
    stop();
    cache.clear();
    attempted.clear();
    automaticAttempts = 0;
  }
  return {
    sync,
    getName,
    request: (suggestion, options = {}) =>
      enqueue(suggestion, true, options.retry === true),
    whenIdle,
    stop,
    reset,
  };
}
