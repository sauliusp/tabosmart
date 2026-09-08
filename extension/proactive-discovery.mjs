import { discoverGroups } from "./local-ai.mjs";
import {
  discoveryBatches,
  crossDiscoveryBatches,
  discoveryKey,
} from "./group-discovery.mjs";

/** Automatic bounded passes, one model session at a time. No total coverage cap. */
export function createProactiveDiscovery({
  generate = discoverGroups,
  publish = async () => {},
  onActivity = () => {},
  cooldownMs = 1500,
  settleMs = 350,
} = {}) {
  const cache = new Map(),
    retries = new Map();
  let snapshot = null,
    identity = null,
    epoch = 0,
    active = null,
    activeKey = null,
    timer = null;
  let running = false,
    allowed = false,
    attempted = new Set(),
    pass = 0,
    failures = 0;
  let hints = new Map(),
    covered = new Set(),
    initialBatches = [],
    crossBatches = null;
  const batchKey = (tabs) =>
    JSON.stringify([
      snapshot.settings.groupNameLanguage,
      tabs.map((t) => [t.id, t.url, t.title, t.windowId, t.groupId]),
    ]);
  function remaining() {
    if (!snapshot) return [];
    const initial = initialBatches.filter((t) => !attempted.has(batchKey(t)));
    if (initial.length) return initial;
    if (crossBatches === null && running) return [];
    crossBatches ||= crossDiscoveryBatches(snapshot, [...hints.values()]);
    return crossBatches.filter((t) => !attempted.has(batchKey(t)));
  }
  function report() {
    onActivity({
      running,
      inspected: covered.size,
      more: remaining().length > 0,
      cooling: timer !== null,
    });
  }
  function stop() {
    epoch++;
    allowed = false;
    clearTimeout(timer);
    timer = null;
    active?.abort();
    if (activeKey) attempted.delete(activeKey);
    activeKey = null;
    active = null;
    running = false;
    report();
  }
  function schedule(delay) {
    if (timer !== null || !allowed || running || !remaining().length) return;
    const generation = epoch;
    timer = setTimeout(() => {
      timer = null;
      if (generation === epoch && allowed) void pump();
    }, delay);
    report();
  }
  async function pump() {
    if (running || !allowed) return;
    const tabs = remaining()[0];
    if (!tabs) {
      report();
      return;
    }
    const key = batchKey(tabs),
      generation = epoch,
      source = identity,
      captured = structuredClone(tabs);
    attempted.add(key);
    running = true;
    pass++;
    const controller = new AbortController();
    active = controller;
    activeKey = key;
    report();
    let completed = true,
      batchHints = [];
    try {
      let groups;
      if (cache.has(key)) ({ groups, hints: batchHints } = cache.get(key));
      else
        groups = await generate(captured, {
          namePreference: snapshot.settings.groupNameLanguage || "auto",
          signal: controller.signal,
          at: snapshot.now,
          onHints: (value) => {
            batchHints = value;
          },
          onOutcome: (value) => {
            completed = value;
          },
        });
      if (
        generation !== epoch ||
        source !== identity ||
        !allowed ||
        controller.signal.aborted
      )
        return;
      if (completed) {
        cache.set(key, { groups, hints: batchHints });
        if (cache.size > 128) cache.delete(cache.keys().next().value);
        captured.forEach((tab) => covered.add(tab.id));
        for (const hint of batchHints)
          if (!hints.has(hint.id)) hints.set(hint.id, hint);
      }
      failures = completed ? 0 : failures + 1;
      if (!completed && (retries.get(key) || 0) < 1) {
        retries.set(key, 1);
        attempted.delete(key);
        if (retries.size > 128) retries.delete(retries.keys().next().value);
      }
      if (groups.length)
        await publish({
          key: source,
          groups,
          tabIds: captured.map((t) => t.id),
        });
    } catch {
      failures++;
    } finally {
      if (generation === epoch) {
        running = false;
        active = null;
        activeKey = null;
        const delay = failures
          ? Math.min(30000, 1000 * 2 ** Math.min(failures, 5))
          : pass >= 3
            ? cooldownMs
            : 0;
        if (pass >= 3) pass = 0;
        report();
        schedule(delay);
      }
    }
  }
  function sync(next, context) {
    const key = discoveryKey(next);
    if (key !== identity) {
      stop();
      identity = key;
      attempted = new Set();
      hints = new Map();
      covered.clear();
      pass = 0;
      initialBatches = discoveryBatches(next);
      crossBatches = null;
    }
    snapshot = next;
    const enabled =
      !!context?.enabled &&
      !!context?.available &&
      !!context?.visible &&
      !context?.reviewing;
    if (!enabled) {
      if (allowed || running) stop();
      else report();
      return;
    }
    allowed = true;
    schedule(settleMs);
    report();
  }
  function more() {
    if (!allowed || running) return;
    clearTimeout(timer);
    timer = null;
    void pump();
  }
  function reset() {
    stop();
    cache.clear();
    retries.clear();
    identity = null;
    initialBatches = [];
    crossBatches = null;
    attempted.clear();
    hints.clear();
    covered.clear();
    pass = 0;
    failures = 0;
  }
  return { sync, stop, reset, more };
}
