import { validateDiscoveredGroups } from "./group-discovery.mjs";
import { NAME_LANGUAGES, namingPlan } from "./topic-evidence.mjs";
import {
  discoverStructuredGroups,
  canGroupWholeSite,
  scopeAwareTitleGroups,
} from "./metadata-groups.mjs";
import { discoverExistingGroupMatches } from "./existing-group-matches.mjs";
import {
  createGroupingContext,
  hydrateGroupingContext,
  resetGroupingSession,
  recordContextActivation,
  reconcileGroupingContext,
  discoverContextGroups,
} from "./grouping-context.mjs";
// Pure local rules. No page content or network calls; optional history aggregates are supplied separately.
export const DAY = 86_400_000;
export const STARTUP_REVIEW_GRACE = 5 * 60_000;
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  aiEnabled: true,
  aiPreferenceSource: "default",
  historyEnabled: true,
  groupNameLanguage: "auto",
  inactivityDays: 7,
});
export const LIMITS = Object.freeze({
  observations: 2000,
  urlHistory: 2000,
  pairs: 1000,
  dismissed: 1500,
  batches: 100,
  storedTabs: 1000,
});

export function isOpenTab(tab) {
  return Number.isInteger(tab?.id) && tab.id >= 0 && !tab.incognito;
}
export function isWebTab(tab) {
  return isOpenTab(tab) && isWebURL(tab.url);
}
export function isWebURL(url) {
  if (typeof url !== "string" || url.length > 16384) return false;
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
export function hash(value) {
  let h = 2166136261;
  for (const char of value) {
    h ^= char.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
export function createState(now = Date.now()) {
  return {
    version: 1,
    sessionId: null,
    trackingSince: now,
    consentAt: null,
    observations: {},
    urlHistory: {},
    startupCandidates: {},
    startupPending: false,
    windowClosures: {},
    sessionStartedAt: now,
    reviewEpoch: now,
    pairs: {},
    lastActivation: {},
    groupingContext: createGroupingContext(),
    dismissed: {},
    protectedUrls: {},
    saved: [],
    recovery: [],
    settings: { ...DEFAULT_SETTINGS },
    evaluation: {
      state: "idle",
      checkedAt: null,
      requestedAt: null,
      error: null,
    },
    cached: null,
    pendingActivationId: null,
  };
}
function readStoredSettings(settings = {}) {
  if (!settings || typeof settings !== "object") settings = {};
  const hasAIChoice = typeof settings.aiEnabled === "boolean";
  let aiPreferenceSource = "default";
  if (hasAIChoice) {
    if (
      settings.aiPreferenceSource === "user" ||
      settings.aiPreferenceSource === "legacy-unknown"
    ) {
      aiPreferenceSource = settings.aiPreferenceSource;
    } else if (
      settings.aiPreferenceSource !== "default" ||
      settings.aiEnabled === false
    ) {
      // Earlier releases defaulted to false without recording its provenance.
      // A legacy true required opt-in; a legacy false may be a deliberate opt-out.
      aiPreferenceSource = settings.aiEnabled ? "user" : "legacy-unknown";
    }
  }
  return {
    enabled: typeof settings.enabled === "boolean" ? settings.enabled : false,
    aiEnabled: hasAIChoice ? settings.aiEnabled : DEFAULT_SETTINGS.aiEnabled,
    aiPreferenceSource,
    historyEnabled:
      typeof settings.historyEnabled === "boolean"
        ? settings.historyEnabled
        : true,
    groupNameLanguage: Object.hasOwn(NAME_LANGUAGES, settings.groupNameLanguage)
      ? settings.groupNameLanguage
      : "auto",
    inactivityDays: Number.isFinite(settings.inactivityDays)
      ? Math.min(90, Math.max(7, Math.round(settings.inactivityDays)))
      : DEFAULT_SETTINGS.inactivityDays,
  };
}
// Apply a user settings patch. Stored data is hydrated separately so ambiguous
// legacy defaults are never upgraded into a claimed explicit choice.
export function sanitizeSettings(patch = {}, current = DEFAULT_SETTINGS) {
  if (!patch || typeof patch !== "object") patch = {};
  current = readStoredSettings(current);
  const hasAIChoice = typeof patch.aiEnabled === "boolean";
  return {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    aiEnabled: hasAIChoice ? patch.aiEnabled : current.aiEnabled,
    aiPreferenceSource: hasAIChoice ? "user" : current.aiPreferenceSource,
    historyEnabled:
      typeof patch.historyEnabled === "boolean"
        ? patch.historyEnabled
        : current.historyEnabled,
    groupNameLanguage: Object.hasOwn(NAME_LANGUAGES, patch.groupNameLanguage)
      ? patch.groupNameLanguage
      : current.groupNameLanguage,
    inactivityDays: Number.isFinite(patch.inactivityDays)
      ? Math.min(90, Math.max(7, Math.round(patch.inactivityDays)))
      : current.inactivityDays,
  };
}
export function hydrateState(raw, now = Date.now()) {
  const state = createState(now);
  if (!raw || raw.version !== 1) return state;
  for (const key of [
    "observations",
    "urlHistory",
    "startupCandidates",
    "windowClosures",
    "pairs",
    "lastActivation",
    "dismissed",
    "protectedUrls",
  ]) {
    if (raw[key] && typeof raw[key] === "object" && !Array.isArray(raw[key]))
      state[key] = raw[key];
  }
  for (const key of ["saved", "recovery"])
    if (Array.isArray(raw[key])) state[key] = raw[key];
  state.sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
  state.trackingSince = Number.isFinite(raw.trackingSince)
    ? raw.trackingSince
    : now;
  state.consentAt = Number.isFinite(raw.consentAt) ? raw.consentAt : null;
  state.settings = readStoredSettings(raw.settings);
  state.groupingContext = hydrateGroupingContext(raw.groupingContext, now);
  state.startupPending = raw.startupPending === true;
  state.sessionStartedAt = Number.isFinite(raw.sessionStartedAt)
    ? raw.sessionStartedAt
    : now;
  state.reviewEpoch = Number.isFinite(raw.reviewEpoch)
    ? raw.reviewEpoch
    : state.trackingSince;
  // Upgrade existing installs from their measured records. Never import Chrome
  // history or lastAccessed as if Tabosmart had observed it.
  for (const record of Object.values(state.observations)) {
    if (!isWebURL(record?.url)) continue;
    mergeURLHistory(
      state,
      record.url,
      record.firstSeenAt,
      record.lastUsedAt,
      record.lastSeenAt,
      record.visitCount,
    );
  }
  if (
    raw.evaluation &&
    ["idle", "checking", "error"].includes(raw.evaluation.state)
  )
    state.evaluation = raw.evaluation;
  if (
    raw.cached &&
    Array.isArray(raw.cached.tabs) &&
    Array.isArray(raw.cached.suggestions)
  )
    state.cached = raw.cached;
  state.installDisclosure = raw.installDisclosure === true;
  state.pendingActivationId = Number.isInteger(raw.pendingActivationId)
    ? raw.pendingActivationId
    : null;
  pruneURLHistory(state, now);
  return state;
}
export function startSession(state, sessionId, now) {
  if (state.sessionId !== sessionId) {
    // Chrome tab IDs are session-scoped. Never attach old observations to reused IDs.
    const previousByURL = new Map();
    const previousRecords = { ...state.observations };
    for (const [id, record] of Object.entries(state.windowClosures)) {
      if (!previousRecords[id] && now - record.closedAt <= 90 * DAY)
        previousRecords[id] = record;
    }
    for (const record of Object.values(previousRecords)) {
      if (!isWebURL(record?.url)) continue;
      mergeURLHistory(
        state,
        record.url,
        record.firstSeenAt,
        record.lastUsedAt,
        record.lastSeenAt,
        record.visitCount,
      );
      const previous = previousByURL.get(record.url) || [];
      previous.push(record);
      previousByURL.set(record.url, previous);
    }
    state.startupCandidates = {};
    if (state.settings.enabled) {
      for (const [url, records] of previousByURL) {
        if (records.length !== 1) continue;
        const record = records[0];
        state.startupCandidates[url] = {
          reviewSince: Math.max(
            record.reviewSince ?? record.firstSeenAt,
            state.reviewEpoch,
          ),
          lastSeenAt: record.lastSeenAt,
        };
      }
    }
    state.startupPending = Object.keys(state.startupCandidates).length > 0;
    state.windowClosures = {};
    state.observations = {};
    state.pairs = {};
    state.lastActivation = {};
    resetGroupingSession(state.groupingContext);
    state.sessionStartedAt = now;
    state.sessionId = sessionId;
    state.cached = null;
    state.pendingActivationId = null;
    state.evaluation = {
      state: "idle",
      checkedAt: null,
      requestedAt: null,
      error: null,
    };
    trimObject(
      state.startupCandidates,
      LIMITS.observations,
      (r) => r.lastSeenAt,
    );
    pruneURLHistory(state, now);
  }
  return state;
}
function mergeURLHistory(
  state,
  url,
  firstSeenAt,
  lastUsedAt,
  lastSeenAt,
  visitCount = 0,
) {
  if (!Number.isFinite(firstSeenAt) || !Number.isFinite(lastSeenAt)) return;
  let history = state.urlHistory[url];
  if (!history)
    history = state.urlHistory[url] = {
      firstObservedAt: firstSeenAt,
      lastUsedAt: null,
      lastSeenAt,
      visitCount: 0,
    };
  history.firstObservedAt = Math.min(history.firstObservedAt, firstSeenAt);
  history.lastSeenAt = Math.max(history.lastSeenAt, lastSeenAt);
  if (Number.isFinite(lastUsedAt))
    history.lastUsedAt = Math.max(history.lastUsedAt || 0, lastUsedAt);
  history.visitCount = Math.max(
    history.visitCount || 0,
    Number.isFinite(visitCount) ? visitCount : 0,
  );
}
function pairKey(a, b) {
  return [a, b].sort((x, y) => x - y).join(":");
}
function trimObject(object, max, timestamp) {
  const entries = Object.entries(object);
  if (entries.length <= max) return;
  entries.sort((a, b) => timestamp(b[1]) - timestamp(a[1]));
  for (const [key] of entries.slice(max)) delete object[key];
}
function pruneURLHistory(state, now) {
  for (const [url, history] of Object.entries(state.urlHistory)) {
    if (
      !isWebURL(url) ||
      !Number.isFinite(history?.lastSeenAt) ||
      now - history.lastSeenAt > 90 * DAY
    )
      delete state.urlHistory[url];
  }
  trimObject(state.urlHistory, LIMITS.urlHistory, (r) => r.lastSeenAt);
  for (const [id, record] of Object.entries(state.windowClosures))
    if (now - record.closedAt > 90 * DAY) delete state.windowClosures[id];
  trimObject(state.windowClosures, LIMITS.observations, (r) => r.closedAt);
}
export function recordTabRemoval(
  state,
  tabId,
  isWindowClosing,
  now = Date.now(),
) {
  if (!state.settings.enabled) return;
  const record = state.observations[tabId];
  if (isWindowClosing && record && isWebURL(record.url))
    state.windowClosures[tabId] = { ...record, closedAt: now };
  else delete state.windowClosures[tabId];
  delete state.observations[tabId];
  for (const [key, pair] of Object.entries(state.pairs))
    if (pair.identities.some((item) => item.id === tabId))
      delete state.pairs[key];
  for (const [key, last] of Object.entries(state.lastActivation))
    if (last.id === tabId) delete state.lastActivation[key];
  pruneURLHistory(state, now);
}
// Measurement is separate from debounced suggestion evaluation: a short visit
// still updates URL recency even if another activation follows immediately.
export function recordActivation(state, tab, at = Date.now()) {
  if (!state.settings.enabled) return;
  recordContextActivation(state.groupingContext, tab, at);
  if (!isWebTab(tab)) {
    if (Number.isInteger(tab?.windowId))
      delete state.lastActivation[tab.windowId];
    return;
  }
  pruneURLHistory(state, at);
  let record = state.observations[tab.id];
  if (!record || record.url !== tab.url)
    record = state.observations[tab.id] = {
      url: tab.url,
      firstSeenAt: at,
      lastUsedAt: null,
      visitCount: 0,
      lastSeenAt: at,
      reviewSince: at,
      reviewNotBefore: at,
      historySource: "current-session",
    };
  record.lastSeenAt = Math.max(record.lastSeenAt, at);
  record.lastUsedAt = Math.max(record.lastUsedAt || 0, at);
  mergeURLHistory(
    state,
    tab.url,
    record.firstSeenAt,
    record.lastUsedAt,
    record.lastSeenAt,
    record.visitCount,
  );
  record.visitCount += 1;
  state.urlHistory[tab.url].visitCount += 1;
  recordCoUse(state, tab, at);
  trimObject(state.observations, LIMITS.observations, (r) => r.lastSeenAt);
  trimObject(state.pairs, LIMITS.pairs, (r) => r.at);
  pruneURLHistory(state, at);
}
function recordCoUse(state, activated, now) {
  const last = state.lastActivation[activated.windowId];
  if (
    last &&
    last.id !== activated.id &&
    now >= last.at &&
    now - last.at <= 10 * 60_000 &&
    state.observations[last.id]?.url === last.url
  ) {
    const key = pairKey(last.id, activated.id);
    let pair = state.pairs[key];
    const identities = [last.id, activated.id]
      .sort((a, b) => a - b)
      .map((id) => ({ id, url: state.observations[id].url }));
    if (!pair || JSON.stringify(pair.identities) !== JSON.stringify(identities))
      pair = state.pairs[key] = { identities, count: 0, at: 0 };
    if (!pair.count || now - pair.at >= 60_000) {
      pair.count += 1;
      pair.at = now;
    }
  }
  state.lastActivation[activated.windowId] = {
    id: activated.id,
    url: activated.url,
    at: now,
  };
}
export function observeTabs(
  state,
  rawTabs,
  now = Date.now(),
  activatedId = null,
  focusedTabId = null,
) {
  if (!state.settings.enabled) return [];
  reconcileGroupingContext(state.groupingContext, rawTabs, now);
  pruneURLHistory(state, now);
  const tabs = rawTabs.filter(isWebTab);
  const currentCounts = new Map();
  for (const tab of tabs)
    currentCounts.set(tab.url, (currentCounts.get(tab.url) || 0) + 1);
  const liveIds = new Set(tabs.map((tab) => String(tab.id)));
  for (const id of Object.keys(state.observations))
    if (!liveIds.has(id)) delete state.observations[id];
  for (const tab of tabs) {
    let record = state.observations[tab.id];
    const fresh = !record || record.url !== tab.url;
    if (fresh) {
      const prior =
        state.startupPending && currentCounts.get(tab.url) === 1
          ? state.startupCandidates[tab.url]
          : null;
      const canUsePrior =
        prior &&
        state.urlHistory[tab.url] &&
        now - prior.lastSeenAt <= 90 * DAY;
      record = state.observations[tab.id] = {
        url: tab.url,
        firstSeenAt: now,
        lastUsedAt: null,
        visitCount: 0,
        lastSeenAt: now,
        reviewSince: canUsePrior
          ? Math.max(prior.reviewSince, state.reviewEpoch)
          : now,
        reviewNotBefore: canUsePrior ? now + STARTUP_REVIEW_GRACE : now,
        historySource: canUsePrior ? "prior-session-url" : "current-session",
      };
    }
    record.reviewSince ??= record.firstSeenAt;
    record.reviewNotBefore ??= record.firstSeenAt;
    record.historySource ??= "current-session";
    record.lastSeenAt = now;
    mergeURLHistory(
      state,
      tab.url,
      record.firstSeenAt,
      record.lastUsedAt,
      now,
      record.visitCount,
    );
    // active is only selection within a window. The caller separately supplies
    // the selected tab in Chrome's actually focused window.
    if (tab.id === focusedTabId || tab.id === activatedId) {
      const firstUse = record.lastUsedAt === null;
      record.lastUsedAt = now;
      state.urlHistory[tab.url].lastUsedAt = now;
      if (fresh || firstUse || tab.id === activatedId) {
        record.visitCount += 1;
        state.urlHistory[tab.url].visitCount += 1;
      }
    }
  }
  // Only the initial populated reconciliation can reuse exact-URL evidence.
  // A URL opened later gets a fresh current-tab review baseline.
  if (tabs.length) {
    state.startupPending = false;
    state.startupCandidates = {};
  }
  for (const [windowId, last] of Object.entries(state.lastActivation)) {
    if (state.observations[last.id]?.url !== last.url)
      delete state.lastActivation[windowId];
  }
  const rawActivated = rawTabs.find((tab) => tab.id === activatedId);
  if (rawActivated && !isWebTab(rawActivated)) {
    delete state.lastActivation[rawActivated.windowId];
    delete state.groupingContext.current[String(rawActivated.windowId)];
  }
  const activated = tabs.find((tab) => tab.id === activatedId);
  if (activated) {
    recordCoUse(state, activated, now);
    recordContextActivation(state.groupingContext, activated, now);
  }
  for (const [key, pair] of Object.entries(state.pairs)) {
    if (
      !Array.isArray(pair.identities) ||
      pair.identities.some(
        (item) => state.observations[item.id]?.url !== item.url,
      ) ||
      now - pair.at > 30 * DAY
    )
      delete state.pairs[key];
  }
  trimObject(state.observations, LIMITS.observations, (r) => r.lastSeenAt);
  pruneURLHistory(state, now);
  trimObject(state.pairs, LIMITS.pairs, (r) => r.at);
  trimObject(state.dismissed, LIMITS.dismissed, (r) => r);
  return tabs.map((tab) => describeTab(tab, state, now));
}
export function describeTab(tab, state, now = Date.now()) {
  const reviewable = isWebTab(tab);
  // Inventory includes every regular tab. Only bounded, credential-free URLs
  // are displayed; data/blob payloads and unknown schemes are never cached.
  let url = reviewable ? tab.url : "";
  let pageType = reviewable ? "Web page" : "Other page";
  if (!reviewable) {
    const candidate = tab.url || tab.pendingUrl;
    try {
      const parsed = new URL(candidate);
      const types = {
        "file:": "Local file",
        "chrome-extension:": "Extension page",
        "chrome:": "Chrome page",
        "chrome-search:": "Chrome page",
        "about:": "Browser page",
      };
      if (types[parsed.protocol]) {
        pageType = types[parsed.protocol];
        if (candidate.length <= 16384 && !parsed.username && !parsed.password)
          url = candidate;
      }
    } catch {
      // Chrome may not have a URL yet for a newly created tab.
    }
  }
  const record =
    state.observations[tab.id]?.url === tab.url
      ? state.observations[tab.id]
      : null;
  const firstSeenAt = record?.firstSeenAt ?? now;
  const lastUsedAt = record?.lastUsedAt ?? null;
  const history = state.urlHistory[tab.url];
  const reviewSince = Math.max(
    record?.reviewSince ?? firstSeenAt,
    state.reviewEpoch,
    history?.lastUsedAt || 0,
  );
  return {
    id: tab.id,
    title: String(tab.title || domainOf(url) || pageType).slice(0, 300),
    url,
    domain: domainOf(url),
    reviewable,
    pageType,
    windowId: tab.windowId,
    index: tab.index ?? 0,
    groupId: tab.groupId ?? -1,
    pinned: !!tab.pinned,
    audible: !!tab.audible,
    active: !!tab.active,
    discarded: !!tab.discarded,
    protected: !!state.protectedUrls[tab.url],
    firstSeenAt,
    firstSeenThisSessionAt: firstSeenAt,
    lastUsedAt,
    historySource: record?.historySource || "current-session",
    urlFirstObservedAt: history?.firstObservedAt ?? firstSeenAt,
    urlLastUsedAt: history?.lastUsedAt ?? null,
    urlVisitCount: history?.visitCount ?? 0,
    reviewReady: !!record && now >= (record.reviewNotBefore ?? firstSeenAt),
    inactivityDays: Math.max(0, Math.floor((now - reviewSince) / DAY)),
    visitCount: record?.visitCount ?? 0,
  };
}
export function eligible(tab, action = "close") {
  return (
    isWebTab(tab) &&
    !tab.protected &&
    !tab.pinned &&
    !tab.audible &&
    (action !== "close" || !tab.active)
  );
}
export function fingerprint(type, tabs) {
  // URL values remain exact, including query strings and fragments.
  return `${type}:${hash(JSON.stringify(tabs.map((t) => t.url).sort()))}`;
}
export function suggestionId(type, tabs, retained = []) {
  return `${type}:${hash(JSON.stringify([...tabs, ...retained].map((t) => [t.id, t.url, t.windowId, t.groupId ?? -1]).sort((a, b) => a[0] - b[0])))}`;
}
export function targetGroupIdentity(target) {
  if (!target) return "";
  return JSON.stringify([
    target.id,
    target.windowId,
    target.title,
    target.members.map((tab) => [tab.id, tab.url]).sort((a, b) => a[0] - b[0]),
  ]);
}
function siteName(domain) {
  const first = domain.split(".")[0] || "Related tabs";
  return first.charAt(0).toUpperCase() + first.slice(1);
}
export function buildSuggestions(
  tabs,
  state,
  now = Date.now(),
  evaluationSummary = null,
  historyFacts = {},
  discoveredGroups = [],
  nativeGroups = [],
) {
  const summary = evaluationSummary || {};
  Object.assign(summary, {
    webTabsChecked: tabs.filter(isWebTab).length,
    groupCandidates: 0,
    exactDuplicateSets: 0,
    exactDuplicateExtras: 0,
    duplicateReviewTabs: 0,
    olderURLCandidates: 0,
    dismissedCandidates: 0,
    limitedCandidates: 0,
    suggestionsShown: 0,
    skipped: {
      guarded: tabs.filter((tab) => isWebTab(tab) && !eligible(tab, "group"))
        .length,
      protected: tabs.filter((tab) => tab.protected).length,
      pinned: tabs.filter((tab) => tab.pinned).length,
      audible: tabs.filter((tab) => tab.audible).length,
      alreadyGrouped: tabs.filter((tab) => tab.groupId !== -1).length,
      insufficientHistory: tabs.filter(
        (tab) =>
          tab.reviewReady === false ||
          tab.inactivityDays < state.settings.inactivityDays,
      ).length,
    },
  });
  const result = [],
    occupied = new Set();
  function add(type, members, title, reason, extra = {}) {
    // Each review must remain actionable under the native action-selection
    // bound. Batching exposes every member; it is not a discovery limit.
    if (members.length > 200) {
      for (let i = 0; i < members.length; i += 200) {
        let batch = members.slice(i, i + 200);
        if (type === "group" && members.length - (i + 200) === 1)
          batch = members.slice(i, i + 199);
        const reasonForBatch = `${reason} This review contains ${batch.length} of those tabs.`;
        add(type, batch, title, reasonForBatch, {
          ...extra,
          explanationVariants: [reasonForBatch],
        });
        if (batch.length === 199) i--;
      }
      return;
    }
    const fp = extra.targetGroup
      ? `group:append:${hash(JSON.stringify([extra.targetGroup.title, extra.targetGroup.members.map((t) => t.url).sort(), members.map((t) => t.url).sort()]))}`
      : fingerprint(type, members);
    if (!members.length) return;
    if (type === "group") summary.groupCandidates++;
    if (state.dismissed[fp]) {
      summary.dismissedCandidates++;
      if (type === "group") members.forEach((tab) => occupied.add(tab.id));
      return;
    }
    const retainedTabs = extra.retainedTabs || [];
    result.push({
      id:
        suggestionId(type, members, retainedTabs) +
        (extra.targetGroup
          ? `:${hash(targetGroupIdentity(extra.targetGroup))}`
          : ""),
      fingerprint: fp,
      type,
      title,
      reason,
      explanationVariants: [reason],
      tabIds: members.map((t) => t.id),
      tabs: members,
      createdAt: now,
      ...extra,
      ...(type === "group"
        ? {
            namePreference: state.settings.groupNameLanguage || "auto",
            nameLanguage: namingPlan(members, state.settings.groupNameLanguage)
              .language,
          }
        : {}),
    });
    members.forEach((tab) => occupied.add(tab.id));
  }
  const urls = new Map();
  for (const tab of tabs) {
    if (!isWebTab(tab)) continue;
    const list = urls.get(tab.url) || [];
    list.push(tab);
    urls.set(tab.url, list);
  }
  for (const members of urls.values()) {
    if (members.length < 2) continue;
    summary.exactDuplicateSets++;
    summary.exactDuplicateExtras += members.length - 1;
    const ordered = [...members].sort(
      (a, b) =>
        Number(b.active || b.pinned || b.protected || b.audible) -
          Number(a.active || a.pinned || a.protected || a.audible) ||
        (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
        a.id - b.id,
    );
    const extras = ordered.slice(1).filter((tab) => eligible(tab));
    summary.duplicateReviewTabs += extras.length;
    const reason = `The same full URL is open in ${members.length} tabs. Page contents or unsaved edits may differ.`;
    add(
      "duplicate",
      extras,
      extras.length === 1
        ? "One extra copy to review"
        : `${extras.length} extra copies to review`,
      reason,
      {
        retainedTabs: [ordered[0]],
        proposedName: siteName(ordered[0].domain),
        explanationVariants: [
          reason,
          `${members.length} open tabs share this exact URL. Check their contents before closing a copy because unsaved edits may differ.`,
        ],
      },
    );
  }
  const remaining = () =>
    tabs.filter(
      (tab) =>
        eligible(tab, "group") && tab.groupId === -1 && !occupied.has(tab.id),
    );
  const preference = state.settings.groupNameLanguage;
  const applyProposals = (proposals) => {
    for (const proposal of proposals.sort(
      (a, b) =>
        (b.priority || 0) - (a.priority || 0) ||
        b.tabs.length - a.tabs.length ||
        a.tabs[0].windowId - b.tabs[0].windowId ||
        a.tabs[0].id - b.tabs[0].id,
    )) {
      if (
        proposal.tabs.length < (proposal.targetGroup ? 1 : 2) ||
        proposal.tabs.some((tab) => occupied.has(tab.id))
      )
        continue;
      if (
        proposal.signal === "remembered-group" &&
        state.dismissed[fingerprint("group", proposal.tabs)]
      )
        continue;
      const { tabs: members, title, reason, ...extra } = proposal;
      add("group", members, title, reason, {
        ...extra,
        explanationVariants:
          extra.explanationVariants ||
          (extra.signal === "title"
            ? [
                reason,
                `These ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
              ]
            : [reason]),
      });
    }
  };
  // Reviewable additions and confirmed choices take precedence. Recompute each
  // weaker family from remaining tabs so reasons always describe its membership.
  applyProposals(
    discoverExistingGroupMatches(tabs, nativeGroups, preference, occupied),
  );
  applyProposals(
    discoverContextGroups(
      remaining(),
      state.groupingContext,
      now,
      preference,
    ).filter((p) => p.signal === "remembered-group"),
  );
  applyProposals(
    discoverStructuredGroups(remaining(), preference).filter(
      (p) => p.signal === "workspace",
    ),
  );
  applyProposals(scopeAwareTitleGroups(remaining(), preference));
  applyProposals(
    discoverContextGroups(
      remaining(),
      state.groupingContext,
      now,
      preference,
    ).filter((p) => p.signal === "opening-context"),
  );
  applyProposals(
    discoverStructuredGroups(remaining(), preference).filter(
      (p) => p.signal === "category",
    ),
  );
  applyProposals(
    discoverContextGroups(
      remaining(),
      state.groupingContext,
      now,
      preference,
    ).filter((p) => p.signal === "repeated-use"),
  );
  const sites = new Map();
  for (const tab of remaining()) {
    const key = `${tab.windowId}:${tab.domain}`;
    const list = sites.get(key) || [];
    list.push(tab);
    sites.set(key, list);
  }
  for (const members of sites.values()) {
    if (members.length < 3) continue;
    // A host containing distinct known workspaces is not itself one project.
    if (!canGroupWholeSite(members)) continue;
    const reason = `${members.length} ungrouped tabs are from ${members[0].domain} in the same window.`;
    add(
      "group",
      members,
      `Bring ${siteName(members[0].domain)} together`,
      reason,
      {
        proposedName: siteName(members[0].domain),
        signal: "site",
        explanationVariants: [
          reason,
          `This window contains ${members.length} ungrouped tabs from ${members[0].domain}.`,
        ],
      },
    );
  }
  if (state.settings.aiEnabled)
    for (const candidate of discoveredGroups) {
      const members = (candidate?.members || [])
        .map((m) => tabs.find((t) => t.id === m.id))
        .filter(Boolean);
      const verified = validateDiscoveredGroups([candidate], members)[0];
      if (!verified || members.some((t) => occupied.has(t.id))) continue;
      const reason = `Local AI suggested a shared ${verified.relationship} from these title excerpts: ${verified.members.map((m) => `“${m.evidence}”`).join("; ")}. This is an inferred relationship. Review whether these tabs belong together.`;
      add("group", members, verified.name, reason, {
        proposedName: verified.name,
        signal: "ai-topic",
        aiDiscovered: true,
        explanationVariants: [reason],
      });
    }
  const olderCandidates = tabs
    .filter(
      (tab) =>
        eligible(tab) &&
        tab.reviewReady !== false &&
        !occupied.has(tab.id) &&
        tab.inactivityDays >= state.settings.inactivityDays,
    )
    .sort((a, b) => b.inactivityDays - a.inactivityDays);
  summary.olderURLCandidates = olderCandidates.length;
  const inactive = olderCandidates;
  if (inactive.length) {
    const days = Math.min(...inactive.map((t) => t.inactivityDays));
    const reason = `No activity has been recorded for these URLs in at least ${days} days. Tabs may have reopened or changed. They may still be important.`;
    add("inactive", inactive, "A few tabs to revisit", reason, {
      explanationVariants: [
        reason,
        `Tabosmart has no recorded use of these URLs in at least ${days} days. The tabs may have reopened or changed, and may still be important.`,
      ],
    });
  }
  summary.limitedCandidates = 0;
  const ranked = rankSuggestions(result, state, tabs, now, historyFacts);
  summary.suggestionsShown = ranked.length;
  return ranked;
}
/** Order evidence-backed proposals without assigning a claimed importance score. */
export function rankSuggestions(
  suggestions,
  state,
  tabs,
  now = Date.now(),
  historyFacts = {},
) {
  const latest = Object.values(state.lastActivation || {})
    .filter(
      (entry) =>
        Number.isFinite(entry.at) &&
        entry.at <= now &&
        now - entry.at <= 30 * 60_000 &&
        tabs.some((tab) => tab.id === entry.id && tab.url === entry.url),
    )
    .sort((a, b) => b.at - a.at || a.id - b.id)[0];
  const entries = suggestions.map((suggestion) => {
    const members = [...suggestion.tabs, ...(suggestion.retainedTabs || [])];
    const current =
      suggestion.type !== "inactive" &&
      !!latest &&
      members.some((tab) => tab.id === latest.id && tab.url === latest.url);
    const strength =
      suggestion.type === "duplicate"
        ? 0
        : suggestion.type === "inactive"
          ? 9
          : ({
              "existing-group": 1,
              "remembered-group": 1,
              workspace: 2,
              title: 3,
              "opening-context": 4,
              category: 5,
              "repeated-use": 6,
              "ai-topic": 7,
              site: 8,
            }[suggestion.signal] ?? 8);
    const history = state.settings.historyEnabled
      ? [...new Set(members.map((tab) => tab.url))]
          .map((url) => historyFacts[url])
          .filter(
            (fact) =>
              fact &&
              Number.isFinite(fact.visits) &&
              fact.visits > 0 &&
              Number.isFinite(fact.lastVisitTime) &&
              fact.lastVisitTime <= now,
          )
      : [];
    const historyLast = Math.max(
      0,
      ...history.map((fact) => fact.lastVisitTime),
    );
    const historyVisits = history.reduce((sum, fact) => sum + fact.visits, 0);
    const historyFrequency = history.reduce(
      (sum, fact) =>
        sum +
        (Number.isFinite(fact.recentVisits)
          ? Math.max(0, fact.recentVisits)
          : 0),
      0,
    );
    const historyRecency = !historyLast
      ? 4
      : now - historyLast <= DAY
        ? 0
        : now - historyLast <= 7 * DAY
          ? 1
          : now - historyLast <= 30 * DAY
            ? 2
            : 3;
    const historyReason = history.length
      ? `${historyVisits} available browser ${historyVisits === 1 ? "visit" : "visits"} to these URLs${history.some((fact) => fact.partial) ? " in history analyzed so far" : ""}. Recent repeated use helps order comparable suggestions; it does not prove importance.`
      : null;
    const effort =
      suggestion.type === "duplicate"
        ? -suggestion.tabs.length
        : suggestion.tabs.length;
    const first = [...suggestion.tabs].sort(
      (a, b) => a.windowId - b.windowId || a.id - b.id,
    )[0];
    const rankReason = current
      ? "Includes the tab you most recently used."
      : suggestion.type === "duplicate"
        ? "An exact URL match gives a concrete review."
        : suggestion.type === "inactive"
          ? "Older recorded use is a reason to review, after more concrete matches."
          : suggestion.signal === "existing-group"
            ? "These tabs match the contents of an existing group."
            : suggestion.signal === "remembered-group"
              ? "A group you previously confirmed provides a direct organizing choice."
              : suggestion.signal === "workspace"
                ? "A specific workspace in the URLs provides a concrete link."
                : suggestion.signal === "opening-context"
                  ? "A shared, recorded opening context supports this group."
                  : suggestion.signal === "category"
                    ? "Each member has metadata supporting the same broad category."
                    : suggestion.signal === "repeated-use"
                      ? "Repeated use together across separate browsing periods supports this group, without proving a shared topic."
                      : suggestion.signal === "ai-topic"
                        ? "Local AI inferred a possible relationship from title evidence. Review whether it fits your work."
                        : suggestion.signal === "title"
                          ? "Shared title words give a more specific link than a website alone."
                          : "A shared website is a broader organizing clue than a specific workspace or title match.";
    return {
      suggestion: { ...suggestion, rankReason, historyReason },
      key: [
        current ? 0 : 1,
        strength,
        historyRecency,
        -historyFrequency,
        effort,
        first?.windowId || 0,
        first?.id || 0,
      ],
    };
  });
  entries.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++)
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return a.suggestion.id.localeCompare(b.suggestion.id);
  });
  return entries.map((entry) => entry.suggestion);
}

export function makeSnapshot(
  state,
  rawTabs,
  now = Date.now(),
  historyFacts = {},
  discoveredGroups = [],
  nativeGroups = [],
) {
  const tabs = state.settings.enabled
    ? rawTabs.filter(isOpenTab).map((tab) => describeTab(tab, state, now))
    : [];
  const evaluationSummary = {};
  const suggestions = buildSuggestions(
    tabs.filter((tab) => tab.reviewable),
    state,
    now,
    evaluationSummary,
    historyFacts,
    discoveredGroups,
    nativeGroups.filter((group) =>
      rawTabs
        .filter((tab) => tab.groupId === group.id)
        .every(
          (tab) =>
            isWebTab(tab) && (!tab.pendingUrl || tab.pendingUrl === tab.url),
        ),
    ),
  );
  return {
    tabs,
    suggestions,
    evaluationSummary: state.settings.enabled
      ? {
          ...evaluationSummary,
          openTabs: tabs.length,
          switchOnlyTabs: tabs.filter((tab) => !tab.reviewable).length,
          checkedAt: now,
        }
      : null,
    saved: state.saved,
    recovery: state.recovery,
    settings: state.settings,
    consentAt: state.consentAt,
    evaluation: { ...state.evaluation },
    stats: {
      observedTabs: tabs.length,
      protectedTabs: tabs.filter((tab) => tab.protected).length,
      trackingSince: state.trackingSince,
    },
    now,
  };
}
export function validateSelection(
  rawTabs,
  state,
  tabIds,
  expectedTabs,
  action,
  now = Date.now(),
) {
  if (
    !Array.isArray(tabIds) ||
    !tabIds.length ||
    tabIds.length > 200 ||
    tabIds.some((id) => !Number.isInteger(id)) ||
    new Set(tabIds).size !== tabIds.length
  )
    throw Object.assign(new Error("Select between 1 and 200 different tabs."), {
      code: "INVALID_SELECTION",
    });
  const expected = new Map((expectedTabs || []).map((tab) => [tab.id, tab]));
  return tabIds.map((id) => {
    const raw = rawTabs.find((tab) => tab.id === id);
    if (!raw || !isWebTab(raw))
      throw Object.assign(
        new Error(
          "A selected tab is no longer available. Review the updated list.",
        ),
        { code: "STALE" },
      );
    const tab = describeTab(raw, state, now),
      old = expected.get(id);
    if (
      !old ||
      old.url !== tab.url ||
      (old.groupId !== undefined && old.groupId !== tab.groupId) ||
      (old.windowId !== undefined && old.windowId !== tab.windowId) ||
      (raw.pendingUrl && raw.pendingUrl !== raw.url)
    )
      throw Object.assign(
        new Error(
          "A selected tab changed. Review the updated list before trying again.",
        ),
        { code: "STALE" },
      );
    if (["close", "group"].includes(action) && !eligible(tab, action))
      throw Object.assign(
        new Error(
          "A selected tab is now active, pinned, playing audio, or protected. Review the updated list.",
        ),
        { code: "PROTECTED" },
      );
    if (action === "group" && tab.groupId !== -1)
      throw Object.assign(
        new Error(
          "A selected tab already belongs to a group. Review the updated list.",
        ),
        { code: "STALE" },
      );
    return tab;
  });
}
