export const TOOLBAR_PORT = "tabosmart-ai-activity";
const SETUP_STATES = new Set(["idle", "downloading", "preparing"]);
const CORE_STATES = new Set(["idle", "checking", "error"]);
const HISTORY_STATES = new Set([
  "indexing",
  "updating",
  "ready",
  "error",
  "off",
  "paused",
  "denied",
]);
const COLORS = Object.freeze({
  work: "#355D4C",
  idle: "#566747",
  error: "#8B4D32",
});
const BASE_ICON = Object.freeze({
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
});
const WORK_ICON = Object.freeze({
  16: "icons/work-16.png",
  32: "icons/work-32.png",
});

function normalizeCore(value = {}) {
  const evaluation = value?.evaluation || {};
  const history = value?.history || {};
  const count = (number) =>
    Number.isSafeInteger(number) && number >= 0 ? number : 0;
  return {
    enabled: value?.enabled === true,
    consentAt: Number.isFinite(value?.consentAt) ? value.consentAt : null,
    evaluation: {
      state: CORE_STATES.has(evaluation.state) ? evaluation.state : "idle",
      phase: evaluation.phase === "queued" ? "queued" : "checking",
    },
    suggestionCount: count(value?.suggestionCount),
    history: {
      state: HISTORY_STATES.has(history.state) ? history.state : "off",
      processedURLs: count(history.processedURLs),
      analyzedVisits: count(history.analyzedVisits),
    },
  };
}

/** Exact allowlist: availability/readiness alone is not activity. */
export function validateAIActivity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "type",
          "setup",
          "naming",
          "discovery",
          "wording",
          "enabled",
        ].includes(key),
    )
  )
    return null;
  if (
    (value.discovery !== undefined && typeof value.discovery !== "boolean") ||
    value.type !== "aiActivity" ||
    !SETUP_STATES.has(value.setup) ||
    typeof value.naming !== "boolean" ||
    typeof value.wording !== "boolean" ||
    typeof value.enabled !== "boolean"
  )
    return null;
  return value.enabled
    ? {
        setup: value.setup,
        naming: value.naming,
        ...(value.discovery !== undefined
          ? { discovery: value.discovery }
          : {}),
        wording: value.wording,
        enabled: true,
      }
    : { setup: "idle", naming: false, wording: false, enabled: false };
}

/** Pure mapping shared by the worker and labeled previews. No elapsed-time guesses. */
export function deriveToolbarState(coreValue, activityValues = []) {
  const core = normalizeCore(coreValue);
  const activities = core.enabled
    ? [...activityValues].filter((value) => value?.enabled === true)
    : [];
  const setup = activities.some((value) => value.setup === "preparing")
    ? "preparing"
    : activities.some((value) => value.setup === "downloading")
      ? "downloading"
      : "idle";
  const naming = activities.some((value) => value.naming === true);
  const discovery = activities.some((value) => value.discovery === true);
  const wording = activities.some((value) => value.wording === true);
  const coreWorking = core.enabled && core.evaluation.state === "checking";
  const historyWorking =
    core.enabled && ["indexing", "updating"].includes(core.history.state);
  const historyError = core.enabled && core.history.state === "error";
  const aiWorking = setup !== "idle" || naming || discovery || wording;
  const busy = coreWorking || historyWorking || aiWorking;
  const count = core.enabled ? core.suggestionCount : 0;
  const countLabel = `${count} ${count === 1 ? "suggestion" : "suggestions"}`;
  let state = "idle",
    text = count ? (count > 99 ? "99+" : String(count)) : "";
  const parts = ["Tabosmart"];
  if (!core.enabled) {
    state = core.consentAt === null ? "start" : "paused";
    parts.push(
      state === "paused"
        ? "Tab observation paused"
        : "Start local tab assistance",
    );
  } else {
    if (coreWorking) {
      state =
        core.evaluation.phase === "queued" ? "core-queued" : "core-checking";
      text = "…";
      parts.push(
        state === "core-queued"
          ? "A tab check is queued"
          : "Checking your tabs",
      );
    } else if (historyWorking) {
      state = `history-${core.history.state}`;
      text = "…";
    } else if (aiWorking) {
      state =
        setup !== "idle"
          ? "ai-setup"
          : discovery
            ? "ai-discovery"
            : naming
              ? "ai-naming"
              : "ai-wording";
      text = "AI";
    } else if (core.evaluation.state === "error" || historyError) {
      state = "error";
      text = "!";
    }
    if (historyWorking) {
      parts.push("Reviewing browsing patterns");
      parts.push(
        `${core.history.processedURLs} ${core.history.processedURLs === 1 ? "URL" : "URLs"} analyzed`,
      );
    }
    if (setup !== "idle")
      parts.push(
        setup === "downloading"
          ? "Downloading the local AI model"
          : "Preparing local AI",
      );
    if (discovery) parts.push("Finding possible relationships locally");
    if (naming) parts.push("Generating group names locally");
    if (wording) parts.push("Choosing explanation wording locally");
    if (core.evaluation.state === "error")
      parts.push("The latest tab check did not finish");
    if (historyError) parts.push("Browsing-pattern review did not finish");
    parts.push(
      coreWorking ||
        historyWorking ||
        historyError ||
        core.evaluation.state === "error"
        ? `${countLabel} from the last completed check`
        : countLabel,
    );
    parts.push("Open workspace");
  }
  return {
    state,
    busy,
    suggestionCount: count,
    badgeText: text,
    badgeColor: busy
      ? COLORS.work
      : state === "error"
        ? COLORS.error
        : COLORS.idle,
    badgeTextColor: "#FFFFFF",
    title: parts.join(" · "),
    iconPath: { ...(busy ? WORK_ICON : BASE_ICON) },
  };
}

/** Owns only action appearance and ephemeral workspace reports; never model work. */
export function createToolbarState(api, { now = () => Date.now() } = {}) {
  let core = normalizeCore();
  const views = new Map();
  let desired = deriveToolbarState(core),
    appliedSignature = null;
  let writeJob = null,
    disposed = false,
    writeError = null;

  function getState() {
    return { ...desired, iconPath: { ...desired.iconPath }, writeError };
  }
  async function apply(state) {
    const action = api?.action;
    if (
      !action ||
      typeof action.setBadgeText !== "function" ||
      typeof action.setTitle !== "function" ||
      typeof action.setIcon !== "function"
    )
      throw new Error("Action appearance is unavailable");
    await action.setIcon({ path: state.iconPath });
    if (typeof action.setBadgeBackgroundColor === "function")
      await action.setBadgeBackgroundColor({ color: state.badgeColor });
    if (typeof action.setBadgeTextColor === "function")
      await action.setBadgeTextColor({ color: state.badgeTextColor });
    await action.setTitle({ title: state.title });
    await action.setBadgeText({ text: state.badgeText });
  }
  function refresh() {
    if (disposed) return Promise.resolve(false);
    desired = deriveToolbarState(
      core,
      [...views.values()].map((view) => view.activity),
    );
    // Each refresh joins the tail, including calls arriving as the previous job
    // settles. Read the latest desired state only when this job can write.
    const job = (writeJob || Promise.resolve()).then(async () => {
      if (disposed) return false;
      const target = desired,
        signature = JSON.stringify(target);
      if (signature === appliedSignature) return true;
      try {
        await apply(target);
        appliedSignature = signature;
        writeError = null;
        return true;
      } catch {
        // Earlier setters may have succeeded, so even the previously applied
        // state must be written in full on the next requested retry.
        appliedSignature = null;
        writeError =
          "The toolbar update could not finish. It will retry on the next update.";
        return false;
      }
    });
    writeJob = job;
    void job.then(() => {
      if (writeJob === job) writeJob = null;
    });
    return job;
  }
  function requestActivity(port) {
    try {
      port.postMessage({ type: "requestAIActivity" });
    } catch {
      remove(port);
    }
  }
  function updateCore(value) {
    const before = core;
    core = normalizeCore(value);
    if (before.enabled && !core.enabled)
      for (const view of views.values())
        view.activity = {
          setup: "idle",
          naming: false,
          wording: false,
          enabled: false,
        };
    if (!before.enabled && core.enabled)
      for (const port of views.keys()) requestActivity(port);
    return refresh();
  }
  function remove(port) {
    const view = views.get(port);
    if (!view) return;
    views.delete(port);
    port.onMessage.removeListener?.(view.message);
    port.onDisconnect.removeListener?.(view.disconnect);
    void refresh();
  }
  function connect(port) {
    if (disposed || views.has(port)) return () => {};
    const sender = port?.sender;
    const extensionURL = api?.runtime?.getURL?.("");
    if (
      port?.name !== TOOLBAR_PORT ||
      !api?.runtime?.id ||
      sender?.id !== api.runtime.id ||
      !extensionURL ||
      typeof sender?.url !== "string" ||
      !sender.url.startsWith(extensionURL) ||
      sender?.tab?.incognito ||
      typeof port?.onMessage?.addListener !== "function" ||
      typeof port?.onDisconnect?.addListener !== "function"
    )
      return () => {};
    const view = {
      activity: {
        setup: "idle",
        naming: false,
        wording: false,
        enabled: false,
      },
      connectedAt: now(),
      message(value) {
        if (disposed || !views.has(port) || !core.enabled) return;
        const activity = validateAIActivity(value);
        if (!activity) return;
        view.activity = activity;
        void refresh();
      },
      disconnect() {
        remove(port);
      },
    };
    views.set(port, view);
    port.onMessage.addListener(view.message);
    port.onDisconnect.addListener(view.disconnect);
    requestActivity(port);
    void refresh();
    return () => remove(port);
  }
  function dispose() {
    disposed = true;
    for (const [port, view] of views) {
      port.onMessage.removeListener?.(view.message);
      port.onDisconnect.removeListener?.(view.disconnect);
    }
    views.clear();
  }
  // A new worker writes a fresh initial state; it never trusts an old badge.
  void refresh();
  return { updateCore, connect, refresh, dispose, getState };
}
