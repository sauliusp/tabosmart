/** Passive status polling for an open interface. This module never creates AI. */
const WAITING = new Set(["checking", "downloading", "preparing"]);
const STATES = new Set([
  ...WAITING,
  "unsupported",
  "downloadable",
  "ready",
  "error",
]);

function failedCheck() {
  const status = {
    state: "error",
    label: "Could not check model",
    detail:
      "Chrome model availability could not be checked. Try checking again.",
    progress: null,
    errorCode: "check-failed",
    errorSource: "availability",
    lastInferenceAt: null,
    lastRequest: null,
    lastSetup: null,
  };
  return { names: { ...status }, explanations: { ...status } };
}

/**
 * Explicit refresh always inspects, including while AI is disabled. Only polling
 * consults shouldCheck/isVisible. Call refresh on visibility/focus to resume.
 * stop suppresses pending responses; a later explicit refresh starts again.
 */
export function createAIStatusWatcher({
  inspect,
  onChange,
  shouldCheck = () => true,
  isVisible = () => true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  delayMs = 5000,
}) {
  if (typeof inspect !== "function") throw new TypeError("inspect is required");
  const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 5000;
  let timer = null;
  let job = null;
  let epoch = 0;
  let stopped = false;
  let latest = null;
  let fingerprint = null;

  function clearPendingTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function canPoll() {
    if (stopped) return false;
    try {
      return Boolean(shouldCheck() && isVisible());
    } catch {
      return false;
    }
  }
  function needsAnotherCheck() {
    return [latest?.names, latest?.explanations].some((status) =>
      WAITING.has(status?.state),
    );
  }
  function schedule() {
    clearPendingTimer();
    if (!canPoll() || !needsAnotherCheck()) return;
    const scheduledEpoch = epoch;
    timer = setTimer(() => {
      timer = null;
      if (scheduledEpoch !== epoch || !canPoll()) return;
      return refresh();
    }, delay);
  }
  function deliver(result) {
    const nextFingerprint = JSON.stringify(result);
    latest = result;
    if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint;
    try {
      onChange?.(result);
    } catch {
      /* A rendering failure cannot create a polling loop. */
    }
  }
  function refresh() {
    stopped = false;
    clearPendingTimer();
    if (job) {
      if (job.epoch === epoch) return job.promise;
      // A stopped request must settle before a new epoch can inspect. Its stale
      // response is discarded and cannot overwrite the restarted watcher.
      return job.promise.then(() => (stopped ? latest : refresh()));
    }
    const running = { epoch, promise: null };
    job = running;
    running.promise = Promise.resolve()
      .then(inspect)
      .then((result) => {
        if (
          !result ||
          !STATES.has(result.names?.state) ||
          !STATES.has(result.explanations?.state)
        )
          return failedCheck();
        return result;
      })
      .catch(() => failedCheck())
      .then((result) => {
        if (!stopped && running.epoch === epoch) deliver(result);
        return latest;
      })
      .finally(() => {
        if (job === running) job = null;
        if (!stopped && running.epoch === epoch) schedule();
      });
    return running.promise;
  }
  function stop() {
    stopped = true;
    epoch++;
    fingerprint = null;
    clearPendingTimer();
  }
  return { refresh, stop };
}
