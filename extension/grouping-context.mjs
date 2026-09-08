import { resourceScope } from "./metadata-groups.mjs";
import { titleData } from "./topic-evidence.mjs";

const MINUTE = 60_000;
const DAY = 86_400_000;
export const CONTEXT_LIMITS = Object.freeze({
  openings: 256,
  openingAge: DAY,
  pendingOpeningAge: MINUTE,
  openingWindow: 5 * MINUTE,
  episodes: 128,
  episodeURLs: 12,
  episodeGap: 10 * MINUTE,
  episodeDuration: 30 * MINUTE,
  episodeAge: 30 * DAY,
  currentWindows: 8,
  choices: 64,
  choiceURLs: 200,
  choiceAge: 90 * DAY,
  textBudget: 300_000,
});

const timestamp = (value, now) =>
  Number.isFinite(value) && value >= 0 && value <= now;
function webURL(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
function identity(tab) {
  return (
    Number.isSafeInteger(tab?.id) &&
    tab.id >= 0 &&
    Number.isSafeInteger(tab.windowId) &&
    tab.windowId >= 0 &&
    !tab.incognito
  );
}
function eligible(tab) {
  return (
    identity(tab) &&
    webURL(tab.url) &&
    !tab.pinned &&
    !tab.audible &&
    !tab.protected &&
    (tab.groupId ?? -1) === -1
  );
}
const uniqueURLs = (urls, max) =>
  Array.isArray(urls) ? [...new Set(urls.filter(webURL))].slice(0, max) : [];
const cleanName = (value) =>
  typeof value === "string" && !/[<>\u0000-\u001f\u007f]/u.test(value)
    ? value.trim().slice(0, 60)
    : "";
const setKey = (urls) => JSON.stringify([...urls].sort());

export function createGroupingContext() {
  return { version: 1, openings: [], current: {}, episodes: [], choices: [] };
}

// Browser-session boundaries discard unfinished observations. A worker restart
// uses hydrate instead, preserving observed events in the same browser session.
export function resetGroupingSession(context) {
  context.openings = [];
  context.current = {};
  return context;
}

function trim(context) {
  context.openings.sort((a, b) => a.at - b.at);
  context.openings = [
    ...new Map(context.openings.map((event) => [event.id, event])).values(),
  ].slice(-CONTEXT_LIMITS.openings);
  context.episodes.sort((a, b) => a.lastAt - b.lastAt);
  context.episodes = context.episodes.slice(-CONTEXT_LIMITS.episodes);
  context.choices.sort((a, b) => a.at - b.at);
  context.choices = [
    ...new Map(
      context.choices.map((choice) => [setKey(choice.urls), choice]),
    ).values(),
  ].slice(-CONTEXT_LIMITS.choices);
  const windows = Object.entries(context.current).sort(
    (a, b) => a[1].lastAt - b[1].lastAt,
  );
  context.current = Object.fromEntries(
    windows.slice(-CONTEXT_LIMITS.currentWindows),
  );
  // The string budget also bounds storage for unusually long URLs. It is an
  // upper bound on UTF-16 characters, not a claim about storage byte quotas.
  while (JSON.stringify(context).length > CONTEXT_LIMITS.textBudget) {
    if (context.episodes.length) context.episodes.shift();
    else if (context.choices.length) context.choices.shift();
    else if (context.openings.length) context.openings.shift();
    else {
      const first = Object.keys(context.current)[0];
      if (first === undefined) break;
      delete context.current[first];
    }
  }
}

function readEpisode(raw, now) {
  if (
    !raw ||
    !timestamp(raw.startedAt, now) ||
    !timestamp(raw.lastAt, now) ||
    raw.lastAt < raw.startedAt ||
    raw.lastAt - raw.startedAt > CONTEXT_LIMITS.episodeDuration ||
    now - raw.lastAt > CONTEXT_LIMITS.episodeAge ||
    !Array.isArray(raw.urls) ||
    raw.urls.length > CONTEXT_LIMITS.episodeURLs ||
    raw.urls.some((url) => !webURL(url))
  )
    return null;
  return {
    startedAt: raw.startedAt,
    lastAt: raw.lastAt,
    urls: uniqueURLs(raw.urls, CONTEXT_LIMITS.episodeURLs),
  };
}

export function hydrateGroupingContext(raw, now = Date.now()) {
  const context = createGroupingContext();
  if (!raw || raw.version !== 1) return context;
  for (const value of Array.isArray(raw.openings) ? raw.openings : []) {
    if (
      !identity({ id: value?.id, windowId: value?.windowId }) ||
      !Number.isSafeInteger(value.sourceId) ||
      value.sourceId < 0 ||
      value.sourceId === value.id ||
      !webURL(value.sourceURL) ||
      !(value.url === null || webURL(value.url)) ||
      !timestamp(value.at, now) ||
      now - value.at >
        (value.url === null
          ? CONTEXT_LIMITS.pendingOpeningAge
          : CONTEXT_LIMITS.openingAge)
    )
      continue;
    context.openings.push({
      id: value.id,
      windowId: value.windowId,
      sourceId: value.sourceId,
      sourceURL: value.sourceURL,
      url: value.url,
      at: value.at,
    });
  }
  for (const [window, value] of Object.entries(raw.current || {})) {
    if (!/^\d+$/u.test(window) || !Number.isSafeInteger(Number(window)))
      continue;
    const episode = readEpisode(value, now);
    if (!episode || !episode.urls.length) continue;
    context.current[window] = {
      ...episode,
      lastURL: episode.urls.includes(value.lastURL)
        ? value.lastURL
        : episode.urls.at(-1),
      overflow: value.overflow === true,
    };
  }
  const seen = new Set();
  for (const value of Array.isArray(raw.episodes) ? raw.episodes : []) {
    const episode = readEpisode(value, now);
    if (!episode || episode.urls.length < 2) continue;
    const key = JSON.stringify([episode.startedAt, setKey(episode.urls)]);
    if (!seen.has(key)) context.episodes.push(episode);
    seen.add(key);
  }
  for (const value of Array.isArray(raw.choices) ? raw.choices : []) {
    if (!timestamp(value?.at, now) || now - value.at > CONTEXT_LIMITS.choiceAge)
      continue;
    if (
      !Array.isArray(value.urls) ||
      value.urls.length > CONTEXT_LIMITS.choiceURLs ||
      value.urls.some((url) => !webURL(url))
    )
      continue;
    const urls = uniqueURLs(value.urls, CONTEXT_LIMITS.choiceURLs);
    const name = cleanName(value.name);
    if (urls.length < 2 || !name) continue;
    // Recompute narrow scopes from exact stored URLs. Never trust a persisted
    // domain-wide template or retain arbitrary caller fields.
    context.choices.push({
      urls,
      scopes: [
        ...new Set(
          urls.map((url) => resourceScope({ url })?.key).filter(Boolean),
        ),
      ],
      name,
      at: value.at,
    });
  }
  trim(context);
  return context;
}

/** Only call for an actual onCreated event with its captured opener identity. */
export function recordOpening(context, tab, opener, at = Date.now()) {
  if (
    !timestamp(at, at) ||
    !identity(tab) ||
    !identity(opener) ||
    tab.id === opener.id ||
    tab.openerTabId !== opener.id ||
    tab.windowId !== opener.windowId ||
    !webURL(opener.url)
  )
    return false;
  const pending =
    tab.url == null || tab.url === "" || tab.url === "about:blank";
  if (!pending && !webURL(tab.url)) return false;
  context.openings = context.openings.filter((event) => event.id !== tab.id);
  context.openings.push({
    id: tab.id,
    windowId: tab.windowId,
    sourceId: opener.id,
    sourceURL: opener.url,
    url: pending ? null : tab.url,
    at,
  });
  trim(context);
  return true;
}

function finishEpisode(context, episode) {
  if (!episode.overflow && episode.urls.length >= 2) {
    context.episodes.push({
      startedAt: episode.startedAt,
      lastAt: episode.lastAt,
      urls: [...episode.urls],
    });
  }
}

/** Actual activations only: snapshots and timer checks must not call this. */
export function recordContextActivation(context, tab, at = Date.now()) {
  if (!identity(tab) || !webURL(tab.url) || !timestamp(at, at)) {
    if (Number.isSafeInteger(tab?.windowId))
      delete context.current[String(tab.windowId)];
    return false;
  }
  const key = String(tab.windowId);
  let episode = context.current[key];
  if (episode && at < episode.lastAt) return false;
  if (
    episode &&
    (at - episode.lastAt >= CONTEXT_LIMITS.episodeGap ||
      at - episode.startedAt >= CONTEXT_LIMITS.episodeDuration)
  ) {
    finishEpisode(context, episode);
    delete context.current[key];
    episode = null;
  }
  if (!episode) {
    context.current[key] = {
      startedAt: at,
      lastAt: at,
      lastURL: tab.url,
      urls: [tab.url],
      overflow: false,
    };
  } else {
    if (episode.lastURL === tab.url) return false;
    episode.lastAt = at;
    episode.lastURL = tab.url;
    if (!episode.urls.includes(tab.url)) {
      if (episode.urls.length >= CONTEXT_LIMITS.episodeURLs)
        episode.overflow = true;
      else episode.urls.push(tab.url);
    }
  }
  trim(context);
  return true;
}

export function reconcileGroupingContext(context, tabs, now = Date.now()) {
  const live = new Map(
    (tabs || []).filter(identity).map((tab) => [tab.id, tab]),
  );
  context.openings = context.openings.filter((event) => {
    const child = live.get(event.id);
    if (
      !child ||
      child.windowId !== event.windowId ||
      now < event.at ||
      now - event.at > CONTEXT_LIMITS.openingAge
    )
      return false;
    if (event.url === null) {
      if (now - event.at > CONTEXT_LIMITS.pendingOpeningAge) return false;
      if (webURL(child.url)) event.url = child.url;
      else if (child.url && child.url !== "about:blank") return false;
      return true;
    }
    return child.url === event.url;
  });
  // Sealing an observed period does not add any visits or repeat counts.
  for (const [key, episode] of Object.entries(context.current)) {
    if (
      now - episode.lastAt >= CONTEXT_LIMITS.episodeGap ||
      now - episode.startedAt >= CONTEXT_LIMITS.episodeDuration
    ) {
      if (now - episode.lastAt <= CONTEXT_LIMITS.episodeAge)
        finishEpisode(context, episode);
      delete context.current[key];
    }
  }
  context.episodes = context.episodes.filter(
    (episode) =>
      timestamp(episode.lastAt, now) &&
      now - episode.lastAt <= CONTEXT_LIMITS.episodeAge,
  );
  context.choices = context.choices.filter(
    (choice) =>
      timestamp(choice.at, now) && now - choice.at <= CONTEXT_LIMITS.choiceAge,
  );
  trim(context);
  return context;
}

/** Call only after the user has successfully confirmed a native group. */
export function rememberGroupingChoice(context, tabs, name, at = Date.now()) {
  if (
    !Array.isArray(tabs) ||
    tabs.some((tab) => !identity(tab) || !webURL(tab.url)) ||
    new Set(tabs.map((tab) => tab.url)).size > CONTEXT_LIMITS.choiceURLs ||
    new Set(tabs.map((tab) => tab.windowId)).size !== 1
  )
    return false;
  const urls = uniqueURLs(
    tabs.map((tab) => tab.url),
    CONTEXT_LIMITS.choiceURLs,
  );
  const label = cleanName(name);
  if (urls.length < 2 || !label || !timestamp(at, at)) return false;
  const key = setKey(urls);
  context.choices = context.choices.filter(
    (choice) => setKey(choice.urls) !== key,
  );
  context.choices.push({
    urls,
    scopes: [
      ...new Set(
        urls.map((url) => resourceScope({ url })?.key).filter(Boolean),
      ),
    ],
    name: label,
    at,
  });
  trim(context);
  return true;
}

function genericSource(url) {
  const u = new URL(url);
  const pieces = u.pathname.toLowerCase().split("/").filter(Boolean);
  const inbox =
    /^(inbox|mail)$/u.test(pieces[0] || "") ||
    /^#\/?inbox(?:\/|$)/iu.test(u.hash);
  if (inbox) return true;
  // The exact query is already part of the captured opener identity. It can
  // establish a search context without translating titles or displaying it.
  const specificSearch = ["q", "query", "search", "term", "search_query"].some(
    (key) => (u.searchParams.get(key) || "").trim().length >= 3,
  );
  if (specificSearch) return false;
  return (
    !pieces.length ||
    /^(home|inbox|mail|search|feed|dashboard|app|start)$/u.test(pieces[0]) ||
    /^#\/?(inbox|search)(?:\/|$)/iu.test(u.hash)
  );
}
function corroborated(tabs) {
  const scopes = tabs.map((tab) => resourceScope(tab)?.key);
  if (scopes[0] && scopes.every((scope) => scope === scopes[0])) return true;
  const words = tabs.map(titleData);
  return (
    [...words[0].keys()].filter((word) => words.every((row) => row.has(word)))
      .length >= 2
  );
}
function candidate(tabs, name, reason, signal, priority, preference) {
  return {
    tabs,
    proposedName: name,
    title: signal === "remembered-group" ? `Bring ${name} back together` : name,
    reason,
    signal,
    priority,
    ...(signal === "remembered-group" ? { nameLocked: true } : {}),
    namePreference: preference,
  };
}

function independentEpisodes(episodes) {
  const result = [];
  for (const episode of [...episodes].sort(
    (a, b) => a.startedAt - b.startedAt,
  )) {
    if (
      !result.length ||
      episode.startedAt - result.at(-1).startedAt >= CONTEXT_LIMITS.episodeGap
    )
      result.push(episode);
  }
  return result;
}

/** Returns proposals only. The core still owns dismissal, priority and actions. */
export function discoverContextGroups(
  tabs,
  context,
  now = Date.now(),
  preference = "auto",
) {
  const scopeCache = new Map();
  const scopeOf = (url) => {
    if (!scopeCache.has(url))
      scopeCache.set(url, resourceScope({ url })?.key || null);
    return scopeCache.get(url);
  };
  const windows = new Map();
  for (const tab of (tabs || []).filter(eligible).sort((a, b) => a.id - b.id)) {
    const list = windows.get(tab.windowId) || [];
    if (!list.some((other) => other.url === tab.url)) list.push(tab);
    windows.set(tab.windowId, list);
  }
  const results = [];
  for (const members of windows.values()) {
    const lookup = new Map(members.map((tab) => [tab.id, tab]));
    const byURL = new Map(members.map((tab) => [tab.url, tab]));
    const byScope = new Map();
    for (const tab of members) {
      const scope = scopeOf(tab.url);
      if (!scope) continue;
      const values = byScope.get(scope) || [];
      values.push(tab);
      byScope.set(scope, values);
    }
    for (const choice of context.choices || []) {
      if (now < choice.at || now - choice.at > CONTEXT_LIMITS.choiceAge)
        continue;
      const matches = new Map();
      for (const url of choice.urls) {
        const tab = byURL.get(url);
        if (tab) matches.set(tab.id, tab);
      }
      for (const scope of choice.scopes)
        for (const tab of byScope.get(scope) || []) matches.set(tab.id, tab);
      const selected = [...matches.values()].sort((a, b) => a.id - b.id);
      const selectedScopes = new Set(
        selected.map((tab) => scopeOf(tab.url)).filter(Boolean),
      );
      const matchedResources = choice.urls.filter(
        (url) => byURL.has(url) || selectedScopes.has(scopeOf(url)),
      ).length;
      if (
        selected.length >= 2 &&
        matchedResources / choice.urls.length >= 2 / 3
      ) {
        results.push(
          candidate(
            selected,
            choice.name,
            `You previously grouped these exact pages or specific resources as “${choice.name}”. ${matchedResources} of ${choice.urls.length} previously chosen pages are represented in this window.`,
            "remembered-group",
            80,
            preference,
          ),
        );
      }
    }
    const families = new Map();
    for (const event of context.openings || []) {
      const tab = lookup.get(event.id);
      if (
        !tab ||
        event.url !== tab.url ||
        now < event.at ||
        now - event.at > CONTEXT_LIMITS.openingAge
      )
        continue;
      const list = families.get(event.sourceURL) || [];
      list.push(event);
      families.set(event.sourceURL, list);
    }
    for (const [sourceURL, events] of families) {
      const ordered = events.sort((a, b) => a.at - b.at);
      for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (
          end < ordered.length &&
          ordered[end].at - ordered[start].at <= CONTEXT_LIMITS.openingWindow
        )
          end++;
        const selected = ordered
          .slice(start, end)
          .map((event) => lookup.get(event.id));
        if (
          selected.length >= 2 &&
          (!genericSource(sourceURL) || corroborated(selected))
        ) {
          const host = new URL(sourceURL).hostname.replace(/^www\./u, "");
          results.push(
            candidate(
              selected,
              "Opened together",
              `${selected.length} tabs were opened from the same page on ${host} within five minutes.`,
              "opening-context",
              50,
              preference,
            ),
          );
        }
        start = end;
      }
    }
  }

  const episodes = (context.episodes || []).filter(
    (episode) =>
      now >= episode.lastAt &&
      now - episode.lastAt <= CONTEXT_LIMITS.episodeAge,
  );
  const occurrences = new Map(),
    partners = new Map();
  for (const episode of episodes) {
    for (const url of episode.urls) {
      occurrences.set(url, (occurrences.get(url) || 0) + 1);
      const peers = partners.get(url) || new Map();
      for (const other of episode.urls)
        if (other !== url) peers.set(other, (peers.get(other) || 0) + 1);
      partners.set(url, peers);
    }
  }
  const hubs = new Set(
    [...occurrences]
      .filter(([url, count]) => {
        const peers = partners.get(url);
        return (
          count >= 6 &&
          peers.size >= 4 &&
          Math.max(...peers.values()) / count < 0.7
        );
      })
      .map(([url]) => url),
  );
  const repeated = new Map();
  for (const episode of episodes) {
    const urls = episode.urls.filter((url) => !hubs.has(url)).sort();
    if (urls.length < 2) continue;
    const key = setKey(urls),
      record = repeated.get(key) || { urls, episodes: [] };
    record.episodes.push(episode);
    repeated.set(key, record);
  }
  for (const record of repeated.values()) {
    const evidence = independentEpisodes(record.episodes);
    if (
      evidence.length < 3 ||
      record.urls.some(
        (url) => record.episodes.length / occurrences.get(url) < 0.6,
      )
    )
      continue;
    for (const members of windows.values()) {
      const selected = members.filter((tab) => record.urls.includes(tab.url));
      if (selected.length < 2 || selected.length / record.urls.length < 2 / 3)
        continue;
      results.push(
        candidate(
          selected,
          "Used together",
          `${selected.length} tabs were used together in ${evidence.length} separate recorded browsing periods.`,
          "repeated-use",
          40,
          preference,
        ),
      );
    }
  }
  const seen = new Set();
  return results
    .sort((a, b) => b.priority - a.priority || b.tabs.length - a.tabs.length)
    .filter((proposal) => {
      const key = JSON.stringify(
        proposal.tabs.map((tab) => tab.id).sort((a, b) => a - b),
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
