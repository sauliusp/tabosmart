import { faviconURL } from "./favicons.mjs";
import { createProactiveDiscovery } from "./proactive-discovery.mjs";
import { NAME_LANGUAGES, namingPlan } from "./topic-evidence.mjs";
import {
  getCapabilities,
  setup,
  enhanceExplanation,
  cancelLocalAI,
  resetLocalAIData,
  getLocalAIActivity,
  getDiscoveryOutcome,
  subscribeLocalAIActivity,
} from "./local-ai.mjs";
import { createProactiveNames, evidenceKeyFor } from "./proactive-names.mjs";
import { createAIStatusWatcher } from "./ai-status-watch.mjs";

const paths = {
  spark: "M12 3l2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7z",
  tabs: "M8 8h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM3 16V5a2 2 0 0 1 2-2h11M6 12h15",
  bookmark: "M6 4h12v17l-6-4-6 4z",
  history: "M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v6l4 2",
  shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8.5 11.5l2.5 2.5 4.5-5",
  sliders: "M4 7h5m4 0h7M4 17h9m4 0h3M9 4v6M13 14v6",
  check: "M5 12l4 4L19 6",
  refresh:
    "M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  close: "M6 6l12 12M6 18L18 6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  group: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3zM3 11h18",
  duplicate: "M9 9h11v11H9zM15 5V3H3v12h2",
  inactive: "M12 3a9 9 0 1 0 9 9M12 7v5l3 2M18 3v6m-3-3h6",
  leaf: "M20 4S9 2 5 7s-1 12 4 12 12-8 11-15ZM4 21 15 10",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5",
  info: "M12 8v.01M12 11v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  volume: "M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8",
  pin: "M9 3h6l-1 6 4 4v2H6v-2l4-4zM12 15v6",
  external: "M14 3h7v7M21 3 10 14M10 3H3v18h18v-7",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.tabs}"/></svg>`;
const esc = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const $ = (sel, base = document) => base.querySelector(sel);
const main = $("#main"),
  dialog = $("#review-dialog");
const enhancedReasons = new Map();
let enhancementRun = false,
  enhancementController = null,
  setupProgress = null,
  aiWorkEpoch = 0;
let data = null,
  view = location.hash === "#settings" ? "settings" : "suggestions",
  capabilities = { names: { state: "checking", label: "Checking" } },
  busy = false,
  search = "",
  selection = new Set(),
  review = null,
  toastTimer,
  toolbarPort = null,
  toolbarTimer = null,
  toolbarAttempts = 0,
  leaving = false,
  lastToolbarPayload = null,
  refreshRun = null,
  pendingSnapshotRefresh = false,
  snapshotRefreshRun = null,
  snapshotRefreshTimer = null,
  snapshotRefreshFailures = 0,
  checkRequest = null,
  lastDecision = null,
  namingActivity = { running: false, queued: 0 },
  discoveryActivity = {
    running: false,
    inspected: 0,
    more: false,
    exhausted: false,
  };
const navNames = {
  suggestions: "Suggestions",
  tabs: "Open tabs",
  saved: "Saved for later",
  recovery: "Recovery",
  settings: "Settings & privacy",
  feedback: "Help shape Tabosmart",
};
function notify(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 10000 : 6000);
}
async function api(type, args = {}) {
  if (!globalThis.chrome?.runtime?.sendMessage)
    throw new Error(
      "Load Tabosmart as an unpacked extension in Chrome to use this workspace.",
    );
  const result = await chrome.runtime.sendMessage({ type, ...args });
  if (!result?.ok)
    throw new Error(
      result?.error ||
        "The action could not be completed. Refresh and review the tabs again.",
    );
  return result;
}
function stopUIAI(erase = false) {
  aiWorkEpoch++;
  stopEnhancement();
  aiStatusWatcher.stop();
  if (erase) proactiveDiscovery.reset();
  else proactiveDiscovery.stop();
  if (erase) {
    proactiveNames.reset();
    resetLocalAIData();
  } else {
    proactiveNames.stop();
    cancelLocalAI();
  }
  setupProgress = null;
  capabilities = {
    names: { state: "checking", label: "Checking model status" },
    explanations: { state: "checking", label: "Checking model status" },
  };
  if (review) review.namingPending = false;
  enhancedReasons.clear();
  const nameButton = $("#ai-name");
  if (nameButton) {
    nameButton.disabled = true;
    nameButton.innerHTML = `${icon("spark")}Rename`;
    nameButton.removeAttribute("aria-busy");
  }
}
function acceptData(next, erased = false) {
  // Runtime responses can arrive after a newer background notification.
  const nextEpoch = next.snapshotEpoch || 0;
  const currentEpoch = data?.snapshotEpoch || 0;
  if (nextEpoch < currentEpoch) return;
  if (
    !erased &&
    nextEpoch === currentEpoch &&
    Number.isSafeInteger(next.snapshotRevision) &&
    Number.isSafeInteger(data?.snapshotRevision) &&
    next.snapshotRevision < data.snapshotRevision
  )
    return;
  const erase = erased || !!(data?.consentAt && !next.consentAt);
  const stopped =
    erase ||
    (data?.settings.aiEnabled && !next.settings.aiEnabled) ||
    (data?.settings.historyEnabled && !next.settings.historyEnabled) ||
    (data?.settings.enabled && !next.settings.enabled);
  if (stopped) stopUIAI(erase);
  if (erase) {
    dialog.close();
    review = null;
    selection.clear();
    lastDecision = null;
  }
  data = next;
  selection = new Set(
    [...selection].filter((id) => data.tabs.some((t) => t.id === id)),
  );
  updateNavigationCounts();
  publishToolbarActivity();
  updateAIChip();
  void syncProactiveNames();
  // The default preference can remain on after erasure or pause. Re-read only
  // model availability so old download/request state does not survive reset.
  if (stopped && data.settings.aiEnabled) void refreshAI();
}
function refresh() {
  if (!refreshRun)
    refreshRun = performRefresh().finally(() => {
      refreshRun = null;
    });
  return refreshRun;
}
async function performRefresh() {
  checkRequest = { state: "checking", phase: "queued" };
  updateCheckStatus();
  try {
    const next = await api("snapshot");
    checkRequest = null;
    acceptData(next);
    selection = new Set(
      [...selection].filter((id) => data.tabs.some((t) => t.id === id)),
    );
    render();
  } catch (error) {
    checkRequest = {
      state: "error",
      error:
        "The latest check did not finish. Your last results are still here.",
    };
    updateCheckStatus();
    if (data) notify(error.message, true);
    else
      main.innerHTML = `<div class="empty"><div class="empty-icon">${icon("tabs")}</div><h1>Let’s open your workspace</h1><p>${esc(error.message)}</p><button class="button secondary" id="retry">Try again</button></div>`;
  }
}
async function action(type, args = {}, message = "Done.") {
  if (busy) return;
  busy = true;
  document
    .querySelectorAll("[data-mutate]")
    .forEach((b) => (b.disabled = true));
  try {
    const result = await api(type, args);
    if (result.tabs) acceptData(result, type === "clearData");
    else acceptData(await api("snapshot"), type === "clearData");
    dialog.close();
    review = null;
    selection.clear();
    const detail = result.action;
    let warning = false;
    if (detail?.type === "group" && !detail.warning && detail.tabIds?.length) {
      lastDecision = `${detail.tabIds.length} tabs now share a home${args.name ? ` in “${args.name}”` : ""}. They’re still open. Use Chrome’s group menu to rename or ungroup them.`;
    } else if (detail?.type === "group" && detail.warning) {
      lastDecision = detail.warning;
    } else if (detail?.type === "save" && detail.count) {
      lastDecision = `${detail.count} URLs saved for later. Your original tabs are still open.`;
    } else if (detail?.type === "close" && detail.closed.length) {
      lastDecision = `${detail.closed.length} tabs closed. Their URLs are in Recovery if you need a way back.${detail.failed.length ? ` ${detail.failed.length} could not be closed. See Recovery for details.` : ""}`;
    }
    render();
    if (detail?.type === "close") {
      message = `${detail.closed.length} ${detail.closed.length === 1 ? "tab" : "tabs"} closed. ${detail.failed.length ? detail.failed.length + " could not be closed. Review Recovery for details." : "Reopen their URLs in Recovery."}`;
      warning = detail.failed.length > 0;
    } else if (detail?.type === "restore") {
      message = `${detail.restored.length} URLs reopened.${detail.failed.length ? " " + detail.failed.length + " need attention. See the saved list for details." : ""}${detail.skipped.length ? " " + detail.skipped.length + " already handled or left open." : ""}`;
      warning = detail.failed.length > 0;
    }
    notify(
      [detail?.warning || detail?.message || message, result.refreshWarning]
        .filter(Boolean)
        .join(" "),
      warning || !!detail?.warning || !!result.refreshWarning,
    );
    return result;
  } catch (error) {
    notify(error.message, true);
    if (dialog.open) {
      let el = $(".error-inline", dialog);
      if (!el) {
        el = document.createElement("p");
        el.className = "error-inline";
        $(".dialog-body", dialog)?.append(el);
      }
      el.textContent = error.message;
    }
    return null;
  } finally {
    busy = false;
    document
      .querySelectorAll("[data-mutate]")
      .forEach((b) => (b.disabled = false));
    updateReviewSelection();
    void drainSnapshotChanges();
  }
}
function expected(tabs) {
  return tabs.map(({ id, url, groupId, windowId }) => ({
    id,
    url,
    groupId,
    windowId,
  }));
}
function timeLabel(tab) {
  if (tab.active) return "Active";
  if (tab.audible) return "Playing audio";
  if (tab.pinned) return "Pinned";
  if (tab.protected) return "Protected";
  const lastUsed = tab.urlLastUsedAt || tab.lastUsedAt;
  if (!lastUsed || !(tab.urlVisitCount || tab.visitCount))
    return "No recorded use";
  const days = Math.max(0, Math.floor((data.now - lastUsed) / 86400000));
  return days ? `URL last active ${days}d ago` : "URL active today";
}
function protectedReason(t) {
  return t.protected
    ? "Protected URL"
    : t.pinned
      ? "Pinned tab"
      : t.audible
        ? "Playing audio"
        : t.active
          ? "Active tab"
          : "";
}
function safeForClose(t) {
  return !protectedReason(t);
}
function siteTile(t) {
  const src = faviconURL(t.url, globalThis.chrome?.runtime?.getURL?.("/"));
  return `<span class="site-tile" aria-hidden="true"><svg class="site-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></svg>${src ? `<img class="site-favicon" src="${esc(src)}" width="16" height="16" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}</span>`;
}
// Chrome may have no cached icon. Keep a neutral fallback, never a remote lookup.
document.addEventListener(
  "error",
  (event) => {
    if (
      event.target instanceof HTMLImageElement &&
      event.target.classList.contains("site-favicon")
    )
      event.target.remove();
  },
  true,
);

function heading(title, subtitle, aside = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${aside}</div>`;
}
function updateNavigationCounts() {
  if (!data) return;
  $("#tab-count").textContent = data.settings.enabled ? data.tabs.length : "–";
  $("#tab-count").title = data.settings.enabled
    ? "Web tabs across all regular Chrome windows. Excludes browser pages, extension pages and Incognito."
    : "Observation paused";
  $("#suggestion-count").textContent = data.suggestions.length;
  $("#saved-count").textContent = data.saved.length;
}
function render() {
  if (!data) return;
  updateCheckStatus();
  updateAIChip();
  document.title = `${navNames[view]} · Tabosmart`;
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  updateNavigationCounts();
  if (!data.settings.enabled && !data.consentAt && view === "suggestions") {
    renderWelcome();
    return;
  }
  ({
    suggestions: renderSuggestions,
    tabs: renderTabs,
    saved: () => renderCollections("saved"),
    recovery: () => renderCollections("recovery"),
    settings: renderSettings,
    feedback: renderFeedback,
  })[view]();
  void runVisibleAI();
}
function renderWelcome() {
  main.innerHTML = `<div class="welcome"><div class="welcome-illustration" aria-hidden="true"><span class="mini-window"></span><span class="mini-window"></span><span class="mini-window"></span></div><p class="eyebrow">A LITTLE LESS OPEN. A LITTLE MORE HEADSPACE.</p><h1>Your tabs don’t need<br>to be a to-do list.</h1><p class="lede">Make room for what you’re doing now. Tabosmart finds related tabs, spots repeat pages, and gives older work a thoughtful second look.</p><div class="consent"><h2>A little context. Always your call.</h2><p>When you start, Tabosmart observes your open tabs’ titles, URLs and tab activity locally to suggest groups, duplicates and tabs to revisit. It remembers when you use each URL across browser restarts, including URLs you later close. The installation permission also lets Tabosmart review available browser history for frequency and recency. It never reads page content.</p><p>You review every action. Your tab data stays in this Chrome profile. There are no accounts, analytics or cloud AI.</p><label class="consent-ai"><input id="start-ai" type="checkbox" ${data.settings.aiEnabled ? "checked" : ""}><span><strong>Use AI for useful group names</strong><span>Starting may download Chrome’s on-device model. Suggestions work while it prepares. Turn AI off anytime in Settings.</span></span></label><button class="button primary" id="start" data-mutate>Start with my tabs ${icon("arrow")}</button><p class="consent-foot">By starting, you allow this local observation. Pause or erase it in Settings & privacy.</p></div></div>`;
}
function renderSuggestions() {
  const count = data.suggestions.length;
  main.innerHTML =
    heading(
      "A little more headspace.",
      "Bring related work together. Give the rest a place for later.",
      `<span class="date-mark">MAKE ROOM FOR WHAT MATTERS</span>`,
    ) +
    (!data.settings.enabled
      ? `<div class="pause-banner">Local observation is paused. <button class="text-button" id="resume">Resume suggestions</button></div>`
      : "") +
    `${data.installDisclosure ? disclosureMarkup() : ""}${lastDecision ? `<div class="decision-receipt">${icon("check")}<p><strong>Last action</strong><br>${esc(lastDecision)}</p><button class="icon-button" id="dismiss-receipt" aria-label="Dismiss completed action">${icon("close")}</button></div>` : ""}${workspaceCheckMarkup()}<p class="ranking-intro">Recent work, stronger links and manageable reviews come first. Every valid suggestion is shown.</p><div class="section-label"><h2>Worth a quick look</h2><span>${count ? `${count} ${count === 1 ? "suggestion" : "suggestions"} · all shown` : "No rush. No busywork."}</span></div><div class="suggestion-list">${count ? data.suggestions.map((s) => `<article class="suggestion-card"><span class="card-symbol ${esc(s.type)}">${icon(s.type)}</span><div class="card-content"><div class="card-kicker">${{ group: "BRING TOGETHER", duplicate: "LESS REPETITION", inactive: "A FRESH LOOK" }[s.type]}<span class="dot"></span>${s.tabIds.length} ${s.tabIds.length === 1 ? "TAB" : "TABS"}</div><h3 data-group-title="${esc(s.id)}">${esc(aiNameFor(s)?.name || s.title)}</h3><p data-reason="${esc(s.id)}">${esc(reasonFor(s))}</p>${s.rankReason ? `<details class="rank-note"><summary>Why this order?</summary><p>${esc(s.rankReason)}${s.historyReason ? ` ${esc(s.historyReason)}` : ""}</p></details>` : ""}<div class="tab-preview">${s.tabs.slice(0, 4).map(siteTile).join("")}<span class="tab-preview-label"><span data-group-name="${esc(s.id)}">${esc(s.type === "group" ? aiNameFor(s)?.name || s.proposedName || "Suggested group" : [...new Set(s.tabs.map((t) => t.domain))].slice(0, 2).join(", "))}</span><span data-group-provenance="${esc(s.id)}">${aiNameFor(s) ? aiNameBadge() : ""}</span>${s.tabs.length > 4 ? ` + ${s.tabs.length - 4} more` : ""}</span></div></div><div class="card-actions"><button class="button secondary" data-review="${esc(s.id)}">${s.type === "group" ? "Review group" : "Review tabs"} ${icon("arrow")}</button></div><button class="dismiss" data-dismiss="${esc(s.id)}" aria-label="Dismiss ${esc(s.title)}" title="Dismiss this suggestion">${icon("close")}</button></article>`).join("") : `${emptySuggestionsMarkup()}`}</div><p class="gentle-note">${icon("shield")}Pinned, audio-playing and protected tabs stay out of suggestions.</p>`;
}
function tabRow(
  t,
  { check = false, checked = false, guard = false, protection = false } = {},
) {
  const reason = guard ? protectedReason(t) : "";
  return `<div class="tab-row">${check ? `<input type="checkbox" data-tab-check="${t.id}" aria-label="Select ${esc(t.title)}" ${checked ? "checked" : ""} ${reason ? "disabled" : ""}>` : ""}${siteTile(t)}<div class="tab-text"><button class="tab-title" data-focus="${t.id}" title="${esc(t.title)}">${esc(t.title || t.url)}</button><div class="tab-url" title="${esc(t.url)}">${esc(t.url)}</div></div><span class="row-meta">${t.protected ? icon("shield") : t.pinned ? icon("pin") : t.audible ? icon("volume") : ""}${esc(reason || timeLabel(t))}</span>${protection ? `<button class="icon-button ${t.protected ? "protected" : ""}" data-protect="${t.id}" aria-label="${t.protected ? "Unprotect" : "Protect"} this URL: ${esc(t.title)}" title="${t.protected ? "Unprotect" : "Protect"} this URL">${icon("shield")}</button>` : ""}</div>`;
}
function renderTabs() {
  const filtered = data.tabs.filter((t) =>
    (t.title + " " + t.url).toLowerCase().includes(search.toLowerCase()),
  );
  main.innerHTML =
    heading(
      "Everything you have open.",
      "Web tabs across all your regular Chrome windows. Find, protect or save what matters.",
    ) +
    `<p class="tab-scope">${data.settings.enabled ? `${filtered.length} of ${data.tabs.length} web tabs${new Set(data.tabs.map((t) => t.windowId)).size > 1 ? ` across ${new Set(data.tabs.map((t) => t.windowId)).size} windows` : ""}. Chrome pages, extension pages and Incognito are excluded.` : "Observation is paused. Resume in Settings to see current tabs."}</p><div class="toolbar"><input id="tab-search" class="search" placeholder="Find a title or website…" aria-label="Search open tabs" value="${esc(search)}"><div class="button-group"><span class="selection-note" id="selection-count">${selection.size} selected</span><button class="button secondary" id="review-selected" ${selection.size ? "" : "disabled"}>Review selected ${icon("arrow")}</button></div></div>${filtered.length ? `<div class="tab-list">${filtered.map((t) => tabRow(t, { check: true, checked: selection.has(t.id), protection: true })).join("")}</div>` : `<div class="empty"><div class="empty-icon">${icon("search")}</div><h2>${search ? "No matching tabs." : "A clear workspace."}</h2><p>${search ? "Try a shorter title or a website name." : data.settings.enabled ? "Open a web page and it will appear here. Chrome pages, extension pages and Incognito tabs are not included." : "Local observation is paused. Resume it in settings to see your tabs."}</p></div>`}<p class="gentle-note">${icon("shield")}Protecting a URL keeps all of its open copies out of suggestions. You can unprotect it anytime.</p>`;
}
function renderCollections(kind) {
  const saved = kind === "saved",
    collections = data[kind];
  main.innerHTML =
    heading(
      saved ? "Keep the possibility." : "A way back.",
      saved
        ? "Your extension-local shelf, separate from Chrome bookmarks. Saving leaves the original tabs open."
        : "Reopen URLs from tabs you chose to close with Tabosmart.",
    ) +
    (saved
      ? ""
      : `<p class="review-caution">Recovery reopens URLs. It cannot restore unsaved forms, page state, your exact tab arrangement or private sessions.</p><br>`) +
    (collections.length
      ? collections
          .map(
            (c) =>
              `<article class="collection"><div class="collection-head"><div><h2>${esc(c.title)}</h2><span class="small muted">${c.tabs.length} URLs · ${new Date(c.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div><div class="button-group"><button class="button secondary" data-restore="${esc(c.id)}" data-kind="${kind}" ${!saved && c.tabs.every((t) => t.restoredAt || t.restoredTabId || t.status === "not-closed") ? "disabled" : ""} data-again="${saved && c.tabs.every((t) => t.restoredAt || t.restoredTabId) ? "true" : "false"}">${c.tabs.every((t) => t.restoredAt || t.restoredTabId) ? (saved ? "Reopen again" : "Reopened") : "Reopen URLs"} ${icon("external")}</button><button class="icon-button" data-forget="${esc(c.id)}" data-kind="${kind}" aria-label="Remove ${esc(c.title)} from ${saved ? "saved URLs" : "recovery"}">${icon("trash")}</button></div></div><div class="tab-list">${c.tabs.map((t) => `<div class="tab-row">${siteTile(t)}<div class="tab-text"><a class="tab-title" href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.title || t.url)}</a><div class="tab-url">${esc(t.url)}</div></div>${t.restoredAt || t.restoredTabId ? '<span class="status-pill">Reopened</span>' : ""}${t.error ? `<span class="row-meta">${esc(t.error)}</span>` : ""}</div>`).join("")}</div><p class="restore-note">${saved ? "Saved locally in this Chrome profile." : "The URL list was saved before closing was attempted."} ${c.tabs.some((t) => t.error) ? "Some URLs need another attempt. Reopen URLs retries only outstanding items." : ""}</p></article>`,
          )
          .join("")
      : `<div class="empty"><div class="empty-icon">${icon(saved ? "bookmark" : "history")}</div><h2>${saved ? "An open mind. A lighter browser." : "Nothing to recover."}</h2><p>${saved ? "Save a few selected tab URLs here when you want to come back to them. Your shelf stays on this device." : "When you choose to close tabs here, their URLs are saved first so you have a way back."}</p><button class="button secondary" data-view="tabs">Browse open tabs ${icon("arrow")}</button></div>`);
}
function combinedCapability() {
  const list = [capabilities.names, capabilities.explanations].filter(Boolean);
  return (
    list.find((c) => c.state === "error") ||
    list.find((c) =>
      ["preparing", "downloading", "checking"].includes(c.state),
    ) ||
    list.find((c) => c.state !== "ready") ||
    capabilities.names
  );
}
function aiRequestNotes() {
  if (!data.settings.aiEnabled) return "";
  const rows = [
    ["names", "Group naming"],
    ["explanations", "Explanation wording"],
  ].flatMap(([kind, label]) => {
    const outcome = capabilities[kind]?.lastRequest;
    if (
      !outcome ||
      !["failed", "cancelled", "running", "succeeded"].includes(outcome.state)
    )
      return [];
    return [
      `<p data-ai-request="${kind}"><strong>${label}:</strong> ${esc(outcome.detail)}</p>`,
    ];
  });
  const setupOutcome = capabilities.names?.lastSetup;
  if (setupOutcome && ["failed", "cancelled"].includes(setupOutcome.state))
    rows.push(
      `<p data-ai-setup-outcome><strong>Last setup attempt:</strong> ${esc(setupOutcome.detail)}</p>`,
    );
  return rows.length
    ? `<div class="ai-request-notes small" aria-live="polite">${rows.join("")}</div>`
    : "";
}
function capabilityRow() {
  const enabled = !!data.settings.aiEnabled;
  const c = enabled
    ? combinedCapability()
    : {
        state: "off",
        label: "Not in use",
        detail:
          "Enable local AI to check the current model status. Turning it off does not remove Chrome’s model.",
      };
  const progressText = setupProgress
    ? setupProgress.state === "preparing"
      ? "Preparing local AI…"
      : setupProgress.state === "error"
        ? "Setup did not finish. You can try again."
        : setupProgress.state === "ready"
          ? "Local AI is ready."
          : setupProgress.progress == null
            ? "Downloading local model…"
            : `Downloading local model · ${Math.floor(setupProgress.progress * 100)}%`
    : "";
  return `<div class="setting-row"><div><strong>Local assistance</strong><p>${enabled ? "Enabled. AI can find shared tasks across sites and suggest names when the model is ready. You can turn it off anytime." : "Off. Your suggestions and complete explanations already work. Enable optional assistance whenever you want."}</p></div><button class="button secondary" id="toggle-ai" data-mutate>${enabled ? "Turn off local AI" : "Enable local AI"}</button></div><div class="setting-row"><div><strong>Model status</strong><span class="capability-label ${esc(c.state)}">${esc(c.label)}</span><p>${esc(c.detail || "Optional help with names and explanations, processed on this device.")}</p>${progressText ? `<p class="progress-note" role="status">${esc(progressText)}</p>` : ""}</div>${enabled && ["downloadable", "error", "ready"].includes(c.state) && !setupProgress ? `<button class="button secondary" id="setup-ai">${c.state === "downloadable" ? "Download local model" : c.state === "error" && c.errorSource !== "availability" ? "Try setup again" : "Check availability"}</button>` : ""}</div><p class="group-readiness">Group names: ${enabled ? esc(capabilities.names.label) : "Off"} · Explanation wording: ${enabled ? esc(capabilities.explanations?.label || capabilities.names.label) : "Off"}</p>${setupProgress ? '<p class="small">Chrome is preparing the model on your device. This can take time. You can keep organizing tabs while it finishes.</p>' : ""}`;
}
function renderFeedback() {
  main.innerHTML =
    heading(
      "A better browser starts with your day.",
      "Tabosmart is early. Help shape what it becomes.",
    ) +
    `<section class="settings-section"><h2>What were you trying to do?</h2><p>A suggestion that missed the point. A confusing button. The one thing that would make you use Tabosmart tomorrow. Small, specific experiences are the most useful place to start.</p><div class="feedback-panel"><div><h2>Tell us what would make this useful.</h2><p>Share an idea, describe a problem or vote on a request. Include what you expected, what happened and your Chrome version. Please leave private URLs and browsing details out of public posts.</p></div><a class="button primary" href="https://tabosmart.featurebase.app/" target="_blank" rel="noopener noreferrer">Share feedback ${icon("external")}</a></div><div class="feedback-qr"><a href="https://tabosmart.featurebase.app/" target="_blank" rel="noopener noreferrer" aria-label="Open Tabosmart feedback"><img src="icons/feedback-qr.svg" width="132" height="132" alt="QR code linking to Tabosmart feedback"></a><p><strong>Have a thought on your phone?</strong><br>Scan to share it.<br><span class="small">tabosmart.featurebase.app</span></p></div><p class="small">Feedback opens an external service. Nothing from your tabs or history is attached automatically. You choose what to share.</p></section><section class="settings-section"><h2>Useful today. Open to your ideas.</h2><p>Review related tabs, remove selected repeat copies, save URLs for later and reopen them from Recovery. Every action stays your choice. Recovery restores URLs, not unsaved forms or edits.</p><h2>Local AI is an extra pair of eyes.</h2><p>Core suggestions work without it. On supported Chrome devices, optional AI can propose additional relationships, useful group names and clearer wording. Model input is processed on your device, with no cloud fallback. Chrome may need a model download; availability varies by device and language. You can switch AI off in Settings & privacy.</p></section>`;
}

function renderSettings() {
  main.innerHTML =
    heading(
      "Make yourself comfortable.",
      "Quiet by design. You stay in control of what Tabosmart observes and suggests.",
    ) +
    `<section class="settings-section"><h2>Your browsing, your pace.</h2><div class="setting-row"><div><strong>Local tab observation</strong><p>Observe open-tab titles, URLs, opening relationships and activity in this Chrome profile. Use specific workspaces, category clues, repeated use and groups you confirm to suggest organization. Pausing stops observation. Resuming begins a fresh review window. Recorded URL use survives browser restarts; it does not prove a tab stayed open.</p></div><button class="button secondary" id="toggle-observation" data-mutate>${data.settings.enabled ? "Pause observation" : "Start observation"}</button></div><div class="setting-row"><div><strong>Give older tabs a second look</strong><p>Only after this many days without recorded URL use. Reopened or changed tabs may still be important. Inactivity is a reason to review, never a reason to close automatically.</p></div><label><span class="sr-only">Inactivity review threshold</span><select id="inactivity-days" data-mutate ${busy ? "disabled" : ""}>${[7, 14, 30].map((n) => `<option value="${n}" ${data.settings.inactivityDays === n ? "selected" : ""}>After ${n} days</option>`).join("")}</select></label></div></section><section class="settings-section"><h2>Browsing patterns</h2><p>Tabosmart automatically reviews all history available through Chrome’s history API while observation and history insights are on. Chrome controls its installation and update permission notices. Deleted, Incognito and otherwise unavailable records cannot be analyzed. Frequency and recency help order comparable suggestions; they do not prove importance.</p><div class="setting-row"><div><strong>History insights</strong><p>Only hashed URL identifiers and aggregate visit evidence are kept locally. History titles and full visit lists are not retained. Turning this off erases that index, without deleting Chrome’s history.</p></div><button class="button secondary" id="toggle-history" data-mutate>${data.settings.historyEnabled ? "Turn off history insights" : "Use history insights"}</button></div>${historyStatusMarkup()}</section><section class="settings-section"><h2>Group names</h2><div class="setting-row"><div><strong>Naming language</strong><p>Automatic follows a clear majority of recognized tab-title languages. Mixed or unclear titles request English model output; literal shared title words stay as written. Website endings and browser language do not choose it. Your edited names stay yours.</p></div><label><span class="sr-only">Group naming language</span><select id="group-name-language" data-mutate ${busy ? "disabled" : ""}>${Object.entries(
      NAME_LANGUAGES,
    )
      .map(
        ([value, label]) =>
          `<option value="${value}" ${(data.settings.groupNameLanguage || "auto") === value ? "selected" : ""}>${esc(label)}</option>`,
      )
      .join(
        "",
      )}</select></label></div><p class="small">Initial suggestions work without AI. Chrome’s naming model currently supports English, German, French, Spanish and Japanese. Other languages keep useful metadata names without another download.</p></section><section class="settings-section"><h2>Local AI <span class="status-pill">OPTIONAL</span></h2><p>Enabled by default for new workspaces. When the model is ready, AI can find more shared tasks across websites and suggest group names from short tab metadata. Initial suggestions appear first. Further AI review continues automatically while this view is active. You review every inferred relationship before grouping. Supported Chrome devices may need an initial model download. This metadata is processed on this device, with no page reading or cloud fallback.</p>${capabilityRow()}${aiRequestNotes()}<p class="small">Group names follow your naming-language choice where Chrome supports the input and output. The interface and explanations currently use English. Explanations appear immediately from measured rules. AI can choose among verified phrasings of the same facts. It never changes the evidence or approves an action.</p><details class="local-ai-help"><summary>Why might local AI be unavailable?</summary><p>Chrome checks browser, device, language and model requirements. “Unavailable” does not tell Tabosmart the exact cause. Setup may need a model download; an error means an attempt did not finish. Your suggestions, names and complete explanations still work.</p><a href="https://developer.chrome.com/docs/ai/get-started" target="_blank" rel="noreferrer">Chrome requirements & setup ${icon("external")}</a><a href="https://developer.chrome.com/docs/ai/prompt-api" target="_blank" rel="noreferrer">Chrome local AI documentation ${icon("external")}</a></details></section><section class="settings-section"><h2>A space of your own.</h2><div class="privacy-copy"><p>Tabosmart stores open-tab titles and URLs, recorded URL use, protected URLs, dismissed suggestions, and saved or recoverable URLs in this Chrome profile. It also keeps bounded opening relationships, including exact source URLs, for up to one day, recorded browsing periods for up to 30 days, and confirmed grouping choices for up to 90 days. These help suggest groups locally; opening the browser does not count as opening related tabs together. URL-use history can include closed pages, is limited to 2,000 URLs, and expires after 90 days unseen when Tabosmart next processes local records. It also analyzes browser history available through Chrome’s history API when history insights are on. It stores hashed URL identifiers and aggregate visit counts and recency in this profile, without retaining history titles or full visit lists. Hashes are not anonymous or encrypted. It does not read page content or bookmarks, and sends no browsing data to a server. There are no analytics, accounts or remote fonts.</p><p>Data is local to this profile, not an encrypted vault or a backup. Anyone with access to the profile may access it. Uninstalling the extension removes its local storage.</p><p>Recovery reopens URLs. It cannot restore unsaved page or form state. Review important work before closing it.</p></div><div class="setting-row"><div><strong>Erase Tabosmart data</strong><p>Clear saved URLs, recovery, URL-use history, the browser-history index, opening context, learned grouping choices, activity, protection and dismissal choices. Observation stops. Open browser tabs stay open.</p></div><button class="button secondary" id="clear-data">Erase local data</button></div></section>`;
}
function navigate(next) {
  stopEnhancement();
  view = next;
  render();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function openReview(tabs, suggestion = null) {
  stopEnhancement();
  review = {
    tabs,
    suggestion,
    selected: new Set(
      suggestion?.type === "group" ? tabs.map((t) => t.id) : [],
    ),
    confirming: false,
    name:
      aiNameFor(suggestion)?.name ||
      suggestion?.proposedName ||
      suggestion?.title ||
      "",
    nameSource: aiNameFor(suggestion) ? "local-ai" : "fallback",
    nameRevision: 0,
    selectionRevision: 0,
    namingPending: false,
  };
  renderReview();
  dialog.showModal();
  void syncProactiveNames();
  updateReviewSelection();
}
function renderReview() {
  const { tabs, suggestion: s } = review,
    isGroup = s?.type === "group";
  $("#dialog-content").innerHTML =
    `<div class="dialog-head"><div><span class="eyebrow">${isGroup ? "BRING RELATED WORK TOGETHER" : "ONE SMALL DECISION"}</span><h2 id="dialog-title">${s?.targetGroup ? "Add to your existing group." : isGroup ? "A home for these tabs." : s?.type === "duplicate" ? "Same URL. Still your choice." : "What would you like to keep?"}</h2><p>${s?.targetGroup ? `Add the selected tabs to “${esc(s.targetGroup.title)}”. Its current name and tabs stay in place.` : isGroup ? "Adjust the name or leave out a tab. We’ll group only what you select." : "Select only the tabs you want to act on. Nothing is selected for you."}</p></div><button class="dismiss" data-close-dialog aria-label="Close review">${icon("close")}</button></div><div class="dialog-body">${s ? `<div class="review-reason">${icon("info")}<span data-reason="${esc(s.id)}">${esc(reasonFor(s))}</span></div>` : ""}<div class="review-controls"><span class="small muted">${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"} in this review</span><label><input type="checkbox" id="review-select-all" ${review.selected.size === tabs.length ? "checked" : ""}>Select eligible tabs</label></div><div class="tab-list">${tabs.map((t) => tabRow(t, { check: true, checked: review.selected.has(t.id), guard: !isGroup })).join("")}</div>${s?.retainedTabs?.length ? `<p class="retained-label">${icon("check")}This copy stays open</p><div class="tab-list">${s.retainedTabs.map((t) => tabRow(t)).join("")}</div>` : ""}${isGroup ? `<div class="name-field"><label for="group-name">${s?.targetGroup ? "Existing group" : "Group name"}</label><input ${s?.targetGroup ? "readonly" : ""} id="group-name" aria-describedby="name-help review-name-provenance" value="${esc(review.name)}" maxlength="60"><span id="review-name-provenance">${review.nameSource === "local-ai" ? aiNameBadge() : ""}</span>${s?.targetGroup ? "" : `<button class="text-button rename-button" id="ai-name" aria-label="Rename with AI assistance" title="Suggest a name with AI using the selected tab titles and website domains">${icon("spark")}Rename</button>`}<p class="name-help" id="name-help">${s?.targetGroup ? "You can rename this group using its menu in Chrome." : "Edit the name directly, or ask local AI for another idea."}</p></div><p class="summary-note">Tabs stay in their current window. You can rename, move or ungroup them using Chrome’s group menu.</p>` : `<p class="review-caution">${s?.type === "duplicate" ? "Even identical URLs can hold different unsaved work. " : "Check important work before closing. "}Saving keeps the tabs open. Closing saves recovery URLs first, but cannot preserve unsaved page or form state.</p>`}</div><div class="dialog-footer"><span class="small muted" id="review-selection-count">${review.selected.size} selected</span><div class="dialog-buttons">${isGroup ? `<button class="button primary" id="apply-group" data-mutate>${s?.targetGroup ? "Add to group" : "Create group"}</button>` : '<button class="button secondary" id="save-selected" data-mutate>Save for later</button><button class="button primary" id="close-selected" data-mutate>Review closing</button>'}</div></div>`;
  updateReviewSelection();
}
function updateReviewSelection() {
  if (!review || !dialog.open) return;
  const n = review.selected.size;
  const count = $("#review-selection-count");
  if (count) count.textContent = `${n} selected`;
  for (const id of ["apply-group", "save-selected", "close-selected"]) {
    const b = $("#" + id);
    if (b)
      b.disabled =
        busy ||
        n < (id === "apply-group" && !review.suggestion?.targetGroup ? 2 : 1);
  }
  const rename = $("#ai-name");
  if (rename) {
    const selected = review.tabs.filter((tab) => review.selected.has(tab.id));
    const namePlan = namingPlan(
      selected,
      review.suggestion?.namePreference ||
        data.settings.groupNameLanguage ||
        "auto",
    );
    const languageFallback = !namePlan.modelEligible;
    rename.disabled =
      languageFallback ||
      busy ||
      n < 2 ||
      review.namingPending ||
      !data.settings.enabled ||
      !data.settings.aiEnabled ||
      capabilities.names.state !== "ready";
    rename.title = languageFallback
      ? "This input or naming language uses a metadata name. Edit it directly anytime."
      : !data.settings.aiEnabled
        ? "Enable AI in Settings to suggest a name"
        : capabilities.names.state !== "ready"
          ? "AI model setup is needed. Open Settings to check its status"
          : "Suggest a name with AI using the selected tab titles and website domains";
    rename.setAttribute("aria-busy", String(review.namingPending));
    rename.innerHTML = `${icon("spark")}${review.namingPending ? "Naming…" : "Rename"}`;
    const help = $("#name-help");
    if (help)
      help.textContent = languageFallback
        ? "Using a metadata name. Chrome’s model does not support this input or chosen language; you can edit the name directly."
        : !data.settings.aiEnabled
          ? "Edit the name directly. Enable local AI in Settings for name ideas."
          : capabilities.names.state !== "ready"
            ? "Edit the name directly. Local AI is not ready; check its status in Settings."
            : "Edit the name directly, or ask local AI for another idea.";
  }
  const all = $("#review-select-all");
  if (all) {
    const eligible = review.tabs.filter(
      (t) => review.suggestion?.type === "group" || safeForClose(t),
    );
    all.checked = n === eligible.length && n > 0;
    all.indeterminate = n > 0 && n < eligible.length;
  }
}
function confirmClose() {
  const tabs = review.tabs.filter((t) => review.selected.has(t.id));
  review.confirming = true;
  $("#dialog-content").innerHTML =
    `<div class="dialog-head"><div><span class="eyebrow">A FINAL LOOK</span><h2 id="dialog-title">Close ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}?</h2><p>Their URLs will be saved in Recovery before closing is attempted.</p></div><button class="dismiss" data-close-dialog aria-label="Cancel closing">${icon("close")}</button></div><div class="dialog-body"><div class="tab-list">${tabs.map((t) => tabRow(t)).join("")}</div><p class="review-caution">Unsaved work can be lost. Recovery only reopens URLs; it does not restore forms or page state. Pinned, active, audio-playing and protected tabs cannot be closed here.</p></div><div class="dialog-footer"><button class="button secondary" id="back-to-review">Go back</button><button class="button danger" id="confirm-close" data-mutate>Close ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}</button></div>`;
  $("#back-to-review").focus();
}
function confirmDialog(title, body, button, handler) {
  review = null;
  $("#dialog-content").innerHTML =
    `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="dismiss" data-close-dialog aria-label="Cancel">${icon("close")}</button></div><div class="dialog-body"><p class="small muted">${esc(body)}</p></div><div class="dialog-footer"><button class="button secondary" data-close-dialog>Cancel</button><button class="button danger" id="confirm-general" data-mutate>${esc(button)}</button></div>`;
  $("#confirm-general").addEventListener("click", handler);
  dialog.showModal();
  void syncProactiveNames();
}
function updateAIChip() {
  const c = combinedCapability(),
    chip = $("#ai-status");
  if (data && !data.settings.aiEnabled) {
    chip.className = "ai-chip";
    chip.innerHTML =
      '<span class="status-dot"></span><span>Local AI · off</span>';
    chip.setAttribute(
      "aria-label",
      "Local AI is off. Suggestions and explanations work. Open settings",
    );
    return;
  }
  chip.className = `ai-chip ${c.state}`;
  chip.innerHTML = `<span class="status-dot"></span><span>Local AI · ${esc({ ready: "ready", unsupported: "unavailable", downloadable: "setup available", downloading: "downloading", error: "needs attention", checking: "checking", preparing: "preparing" }[c.state] || c.label)}</span>`;
  chip.setAttribute(
    "aria-label",
    `Local AI names and explanation wording: ${c.label}. Open settings`,
  );
}
const aiStatusWatcher = createAIStatusWatcher({
  inspect: getCapabilities,
  shouldCheck: () => !!data?.settings.aiEnabled,
  isVisible: () => !document.hidden,
  onChange(result) {
    capabilities = result;
    updateAIChip();
    updateReviewSelection();
    if (data && view === "settings") renderPreservingFocus();
    void runVisibleAI();
  },
});
const refreshAI = () => aiStatusWatcher.refresh();

const proactiveNames = createProactiveNames({
  onName: () => patchGroupNames(),
  onActivity(activity) {
    namingActivity = activity;
    updateWorkspaceCheck();
  },
});
function aiNameFor(suggestion) {
  if (suggestion?.nameLocked) return null;
  if (
    suggestion?.aiDiscovered &&
    data?.settings.enabled &&
    data.settings.aiEnabled
  )
    return { name: suggestion.proposedName, source: "local-ai" };
  return data?.settings.enabled && data.settings.aiEnabled
    ? proactiveNames.getName(suggestion)
    : null;
}
function aiNameBadge() {
  return `<span class="ai-name-badge" title="This name was suggested by local AI">AI suggested</span>`;
}
function patchGroupNames() {
  if (!data || dialog.open || view !== "suggestions") return;
  for (const suggestion of data.suggestions.filter((s) => s.type === "group")) {
    const result = aiNameFor(suggestion);
    for (const el of main.querySelectorAll("[data-group-title]"))
      if (el.dataset.groupTitle === suggestion.id)
        el.textContent = result?.name || suggestion.title;
    for (const el of main.querySelectorAll("[data-group-name]"))
      if (el.dataset.groupName === suggestion.id)
        el.textContent =
          result?.name || suggestion.proposedName || "Suggested group";
    for (const el of main.querySelectorAll("[data-group-provenance]"))
      if (el.dataset.groupProvenance === suggestion.id)
        el.innerHTML = result ? aiNameBadge() : "";
  }
}
const proactiveDiscovery = createProactiveDiscovery({
  publish: async (payload) => {
    if (dialog.open || document.hidden || view !== "suggestions") return;
    const result = await api("discoverGroups", payload);
    acceptData(result);
    if (!dialog.open && view === "suggestions") renderPreservingFocus();
  },
  onActivity(activity) {
    discoveryActivity = activity;
    updateWorkspaceCheck();
  },
});
function syncProactiveNames() {
  if (data)
    proactiveDiscovery.sync(data, {
      enabled: data.settings.enabled && data.settings.aiEnabled,
      available: capabilities.names.state === "ready",
      visible: !document.hidden && view === "suggestions",
      reviewing: dialog.open || busy,
    });
  return proactiveNames.sync(
    !dialog.open && view === "suggestions"
      ? (data?.suggestions || []).filter(
          (s) =>
            !s.aiDiscovered &&
            !s.nameLocked &&
            namingPlan(
              s.tabs,
              s.namePreference || data.settings.groupNameLanguage || "auto",
            ).modelEligible,
        )
      : [],
    {
      enabled: !!data?.settings.enabled && !!data?.settings.aiEnabled,
      available: capabilities.names.state === "ready",
      visible: !document.hidden && (view === "suggestions" || dialog.open),
      reviewProposal:
        dialog.open && review?.suggestion?.type === "group"
          ? selectedNameProposal()
          : null,
    },
  );
}
async function runVisibleAI() {
  const epoch = aiWorkEpoch;
  await syncProactiveNames();
  if (epoch === aiWorkEpoch) await enhanceVisibleReasons();
}
function selectedNameProposal() {
  const tabs = review.tabs.filter((t) => review.selected.has(t.id));
  return { ...review.suggestion, tabs, tabIds: tabs.map((t) => t.id) };
}
function changedReviewSelection() {
  review.selectionRevision++;
  review.nameSource = "fallback";
  const badge = $("#review-name-provenance");
  if (badge) badge.textContent = "";
}

function viewSignature(value) {
  if (!value) return "";
  if (view === "settings")
    return JSON.stringify({ settings: value.settings, history: value.history });
  if (["saved", "recovery"].includes(view)) return JSON.stringify(value[view]);
  return JSON.stringify({
    settings: value.settings,
    installDisclosure: value.installDisclosure,
    tabs: value.tabs.map((t) => [
      t.id,
      t.title,
      t.url,
      t.windowId,
      t.groupId,
      t.pinned,
      t.active,
      t.audible,
      t.protected,
      t.visitCount,
      t.inactivityDays,
      t.urlLastUsedAt,
      t.urlVisitCount,
    ]),
    suggestions: value.suggestions.map((s) => [
      s.id,
      s.reason,
      s.title,
      s.rankReason,
      s.historyReason,
    ]),
    stats: value.stats,
  });
}
function renderPreservingFocus() {
  const focused = document.activeElement;
  const selector = focused?.id
    ? "#" + CSS.escape(focused.id)
    : focused?.dataset?.tabCheck
      ? '[data-tab-check="' + focused.dataset.tabCheck + '"]'
      : focused?.dataset?.review
        ? '[data-review="' + CSS.escape(focused.dataset.review) + '"]'
        : null;
  const caret = focused?.selectionStart;
  render();
  const replacement = selector ? document.querySelector(selector) : null;
  if (replacement) {
    replacement.focus({ preventScroll: true });
    if (caret != null && replacement.setSelectionRange)
      replacement.setSelectionRange(caret, caret);
  }
}
function setCheckStatus(state, text) {
  const node = $("#check-status");
  node.className = `check-state ${state}`;
  node.innerHTML = `<span class="status-dot"></span><span>${esc(text)}</span>`;
}
function updateCheckStatus() {
  updateWorkspaceCheck();
  const e = currentEvaluation();
  if (!data?.settings.enabled) {
    setCheckStatus(
      "idle",
      data?.consentAt ? "Observation paused" : "Ready when you are",
    );
    return;
  }
  if (e?.state === "checking") {
    setCheckStatus("checking", "Checking your tabs");
    return;
  }
  if (e?.state === "error") {
    setCheckStatus("error", "Check interrupted");
    $("#check-status").title =
      e.error || "Use Refresh suggestions to try again.";
    return;
  }
  setCheckStatus(
    "idle",
    e?.checkedAt && Date.now() - e.checkedAt > 60000
      ? "Checked recently"
      : "Up to date",
  );
  $("#check-status").title = e?.checkedAt
    ? `Last checked ${new Date(e.checkedAt).toLocaleTimeString()}`
    : "Suggestions reflect the current observed tabs.";
  if (e?.warning) $("#check-status").title += ` ${e.warning}`;
}
function currentEvaluation() {
  if (
    checkRequest?.state === "checking" &&
    data?.evaluation?.state === "checking"
  )
    return data.evaluation;
  return checkRequest || data?.evaluation || {};
}
function checkRecency(at) {
  if (!at) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
  if (minutes < 1) return "Just checked";
  if (minutes < 60)
    return `Checked ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  return `Checked at ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
function workspaceCheckMarkup() {
  if (!data) return "";
  const summary = data.evaluationSummary,
    current = currentEvaluation();
  const enabled = data.settings.enabled;
  const checking = enabled && current.state === "checking";
  const failed = enabled && current.state === "error";
  const done = enabled && summary && summary.checkedAt;
  const count = data.suggestions.length;
  const title = !enabled
    ? "A pause, whenever you need it."
    : failed
      ? "The latest check didn’t finish."
      : checking
        ? current.phase === "queued"
          ? "A fresh check is next."
          : "Checking your open tabs…"
        : done
          ? `${summary.webTabsChecked} ${summary.webTabsChecked === 1 ? "tab" : "tabs"} checked. ${count ? "Your choices, in a useful order." : "No new suggestions."}`
          : "Ready for a fresh look.";
  const detail = !enabled
    ? "Resume when you want a fresh look. Your saved URLs are still here."
    : failed
      ? "Your last results stay available. Try another check when you’re ready."
      : checking
        ? "Looking for related tabs, repeat URLs and older work to revisit. You can keep reviewing below."
        : done
          ? count
            ? `${count} ${count === 1 ? "suggestion" : "suggestions"} to consider. Start with one; the rest can wait.`
            : "Related tabs, repeat URLs and recorded activity have been checked."
          : "Check your open web tabs for related work, repeat URLs and activity worth revisiting.";
  const groups = data.suggestions.filter((s) => s.type === "group").length;
  const duplicates = data.suggestions
    .filter((s) => s.type === "duplicate")
    .reduce((n, s) => n + s.tabs.length, 0);
  const older = data.suggestions
    .filter((s) => s.type === "inactive")
    .reduce((n, s) => n + s.tabs.length, 0);
  const aiActive =
    enabled &&
    data.settings.aiEnabled &&
    (namingActivity.running || namingActivity.queued);
  const aiLine = discoveryActivity.running
    ? "AI is checking title evidence for more relationships. Your initial suggestions are ready."
    : aiActive
      ? "AI is finding useful names. Your suggestions are ready to review."
      : enabled &&
          data.settings.aiEnabled &&
          ["downloading", "preparing"].includes(capabilities.names.state)
        ? "AI is preparing on this device. Tab checks and suggestions keep working."
        : "";
  return `<section class="workspace-check ${checking ? "is-checking" : failed ? "is-error" : ""}" id="workspace-check" aria-label="Tab check summary"><div class="check-main"><span class="check-symbol" aria-hidden="true">${icon(checking ? "refresh" : failed ? "info" : !enabled ? "leaf" : "check")}</span><div class="check-copy"><p class="check-eyebrow">${!enabled ? "YOUR WORKSPACE, YOUR PACE" : checking ? "A FRESH LOOK AT YOUR TABS" : failed ? "LET’S TRY THAT AGAIN" : "A LITTLE LESS TO HOLD IN YOUR HEAD"}</p><h2 class="check-title" aria-live="polite">${esc(title)}</h2><p>${esc(detail)}</p></div>${enabled ? `<button class="text-button" id="check-again" ${checking ? "disabled" : ""}>${failed ? "Try again" : "Check again"}${icon("refresh")}</button>` : ""}</div>${done ? `<div class="check-results"><span>${icon("group")}<b>${groups}</b> ${groups === 1 ? "group idea" : "group ideas"}</span><span>${icon("duplicate")}<b>${duplicates}</b> ${duplicates === 1 ? "repeat copy" : "repeat copies"} to review</span><span>${icon("inactive")}<b>${older}</b> ${older === 1 ? "older tab" : "older tabs"} to revisit</span><span class="check-recency" title="${esc(new Date(summary.checkedAt).toLocaleString())}">${checking || failed ? `Last completed check: ${summary.webTabsChecked} tabs` : checkRecency(summary.checkedAt)}</span></div>` : ""}${historyStatusMarkup()}${enabled && data.settings.aiEnabled && !discoveryActivity.running && (discoveryActivity.inspected || getDiscoveryOutcome()?.state === "failed") ? `<p class="check-ai-note">${getDiscoveryOutcome()?.state === "failed" ? esc(getDiscoveryOutcome().detail) : `Local AI reviewed ${discoveryActivity.inspected} tab titles. Suggestions can miss connections.${discoveryActivity.more ? " More tabs will be reviewed automatically." : " Review whether each suggestion fits your work."}`}${discoveryActivity.more && discoveryActivity.cooling ? ' <button class="text-button" id="more-topics">Continue now</button>' : ""}</p>` : ""}${aiLine ? `<p class="check-ai-note">${icon("spark")}${esc(aiLine)}</p>` : ""}</section>`;
}
function updateWorkspaceCheck() {
  const panel = $("#workspace-check");
  if (!panel || dialog.open) return;
  const next = workspaceCheckMarkup();
  if (panel.outerHTML === next) return;
  const focused = panel.contains(document.activeElement)
    ? document.activeElement.id
    : null;
  panel.outerHTML = next;
  if (focused) $("#" + focused)?.focus({ preventScroll: true });
}
function emptySuggestionsMarkup() {
  const summary = data.evaluationSummary,
    skipped = summary?.skipped || {};
  let title = "Nothing to review here yet.",
    detail;
  if (!data.settings.enabled) {
    title = "Pick up where you left off.";
    detail =
      "Resume local observation whenever you’re ready. Your saved URLs and recovery entries are still here.";
  } else if (!summary) {
    title = "Let’s take a first look.";
    detail =
      "Your first completed check will show what was considered. No tabs will move or close without your say.";
  } else if (!summary.webTabsChecked) {
    title = "A clear starting point.";
    detail =
      "Open a few web pages and they’ll appear here. Chrome pages, extension pages and Incognito tabs stay out of this workspace.";
  } else if (summary.dismissedCandidates > 0) {
    title = "No new decisions to make.";
    detail =
      "The choices you dismissed stay set aside. Your open tabs will be checked again as they change.";
  } else if (skipped.guarded === summary.webTabsChecked) {
    title = "These tabs are left as they are.";
    detail =
      "In the last check, these tabs were pinned, playing audio or protected. They stay out of suggestions while those safeguards apply.";
  } else if (skipped.alreadyGrouped === summary.webTabsChecked) {
    title = "Your tabs already have a home.";
    detail = `The last check found all ${summary.webTabsChecked} web tabs already in Chrome groups. Tabosmart leaves those groups as you arranged them.`;
    if (skipped.insufficientHistory)
      detail +=
        " Older-tab review needs the configured interval without recorded URL use.";
  } else {
    const pieces = [];
    if (skipped.alreadyGrouped)
      pieces.push(
        `${skipped.alreadyGrouped} tabs already have a Chrome group.`,
      );
    if (skipped.guarded)
      pieces.push(
        `${skipped.guarded} pinned, audio-playing or protected tabs are left out.`,
      );
    if (skipped.insufficientHistory)
      pieces.push(
        `Older-tab reminders need at least ${data.settings.inactivityDays} days without recorded URL use and enough observation time.`,
      );
    if (!pieces.length)
      pieces.push(
        "No new grouping or repeat-page suggestion met the review rules in this check.",
      );
    detail =
      pieces.slice(0, 2).join(" ") +
      " Suggestions update as your tabs and activity change.";
  }
  return `<div class="empty"><div class="empty-icon">${icon("leaf")}</div><h2>${esc(title)}</h2><p>${esc(detail)}</p><button class="button secondary" data-view="tabs">See open tabs ${icon("arrow")}</button></div>`;
}

function disclosureMarkup() {
  return `<section class="install-disclosure" aria-label="How Tabosmart works"><div><strong>A little context. More useful choices.</strong><p>Tabosmart reviews open-tab titles, URLs, activity and browsing history available from Chrome to find related work and order suggestions. Analysis stays on this device. No page content or cloud AI. Pause observation, turn off history insights or erase local records in Settings.</p></div><button class="text-button" id="dismiss-disclosure">Got it</button></section>`;
}
function historyStatusMarkup() {
  const h = data?.history;
  if (!data?.settings.historyEnabled && h?.state === "error")
    return `<p class="history-progress" role="status">${icon("history")}<span>History insights are off, but the local history index could not be erased. No history processing is running.</span><button class="text-button" id="retry-history">Retry erasing index</button></p>`;
  if (!data?.settings.historyEnabled || !data.settings.enabled) return "";
  let text;
  if (["indexing", "updating"].includes(h?.state))
    text = `Tabosmart is reviewing browsing patterns: ${h.processedURLs || 0} URLs and ${h.analyzedVisits || 0} available visits analyzed in this pass. Coverage is still partial; suggestions remain available.`;
  else if (h?.state === "ready")
    text = `${h.indexedURLs || 0} available history URLs reviewed. Retained visit frequency and recency help order comparable suggestions.`;
  else if (["error", "denied"].includes(h?.state))
    text =
      "History insights are unavailable right now. Tab suggestions still work.";
  else
    text =
      "Tabosmart will review available browsing patterns when Chrome’s history API is available. Tab suggestions already work.";
  return `<p class="history-progress" ${["indexing", "updating"].includes(h?.state) ? 'role="status"' : ""}>${icon("history")}<span>${esc(text)}</span>${h?.state === "error" ? '<button class="text-button" id="retry-history">Retry history review</button>' : ""}</p>`;
}
function publishToolbarActivity(force = false) {
  if (leaving || !toolbarPort) return;
  const payload = {
    type: "aiActivity",
    ...getLocalAIActivity(),
    enabled: !!data?.settings.enabled && !!data?.settings.aiEnabled,
  };
  const serialized = JSON.stringify(payload);
  if (!force && lastToolbarPayload === serialized) return;
  try {
    toolbarPort.postMessage(payload);
    lastToolbarPayload = serialized;
  } catch {
    toolbarPort = null;
  }
}
function connectToolbar(reset = false) {
  if (reset) toolbarAttempts = 0;
  if (
    leaving ||
    toolbarPort ||
    toolbarAttempts >= 3 ||
    !globalThis.chrome?.runtime?.connect
  )
    return;
  toolbarAttempts++;
  try {
    const port = chrome.runtime.connect({ name: "tabosmart-ai-activity" });
    toolbarPort = port;
    lastToolbarPayload = null;
    port.onMessage.addListener((message) => {
      if (message?.type === "requestAIActivity") publishToolbarActivity(true);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (toolbarPort !== port) return;
      toolbarPort = null;
      if (!leaving && toolbarAttempts < 3)
        toolbarTimer = setTimeout(() => {
          toolbarTimer = null;
          connectToolbar();
        }, 500 * toolbarAttempts);
    });
    publishToolbarActivity(true);
  } catch {
    toolbarPort = null;
  }
}
subscribeLocalAIActivity(() => {
  if (!toolbarPort) connectToolbar(true);
  publishToolbarActivity();
});

function reasonFor(s) {
  const value = enhancedReasons.get(s.id);
  return value?.reason === s.reason ? value.text : s.reason;
}
function stopEnhancement() {
  enhancementController?.abort();
}
async function enhanceVisibleReasons() {
  if (
    enhancementRun ||
    document.hidden ||
    !data?.settings.enabled ||
    !data.settings.aiEnabled ||
    view !== "suggestions" ||
    dialog.open ||
    capabilities.explanations?.state !== "ready"
  )
    return;
  enhancementRun = true;
  const controller = new AbortController();
  enhancementController = controller;
  const epoch = aiWorkEpoch;
  try {
    for (const suggestion of data.suggestions.slice(0, 5)) {
      if (
        document.hidden ||
        dialog.open ||
        !data.settings.enabled ||
        !data.settings.aiEnabled ||
        view !== "suggestions"
      )
        break;
      if (enhancedReasons.get(suggestion.id)?.reason === suggestion.reason)
        continue;
      const text = await enhanceExplanation(suggestion, {
        signal: controller.signal,
      });
      if (epoch !== aiWorkEpoch || controller.signal.aborted) break;
      enhancedReasons.set(suggestion.id, {
        reason: suggestion.reason,
        text: text || suggestion.reason,
      });
      const current = data.suggestions.find(
        (s) => s.id === suggestion.id && s.reason === suggestion.reason,
      );
      if (text && current && !dialog.open && view === "suggestions") {
        document.querySelectorAll("[data-reason]").forEach((el) => {
          if (el.dataset.reason === current.id) {
            el.textContent = text;
            el.title =
              "Wording selected locally from verified explanations of the same facts.";
          }
        });
      }
    }
  } finally {
    enhancementRun = false;
    if (enhancementController === controller) enhancementController = null;
    if (epoch === aiWorkEpoch) await refreshAI();
  }
}

async function beginModelSetup() {
  setupProgress = { state: "preparing", progress: null };
  const epoch = aiWorkEpoch;
  const pending = setup("names", (progress) => {
    if (epoch !== aiWorkEpoch) return;
    setupProgress = progress;
    const state = progress.state === "ready" ? "ready" : progress.state;
    const currentStatus = {
      state,
      label:
        state === "preparing"
          ? "Preparing"
          : state === "downloading"
            ? "Downloading"
            : state === "error"
              ? "Could not finish"
              : "Ready on this device",
      detail:
        state === "preparing"
          ? "Chrome is initializing the local model. Your tab suggestions still work."
          : state === "downloading"
            ? "Chrome is downloading its local model. Your tab suggestions still work."
            : state === "error"
              ? "Local setup did not finish. Try again when you are ready."
              : "Available on this device.",
    };
    capabilities.names = { ...capabilities.names, ...currentStatus };
    capabilities.explanations = {
      ...capabilities.explanations,
      ...currentStatus,
    };
    updateAIChip();
    if (view === "settings") renderSettings();
  });
  try {
    const result = await pending;
    if (epoch === aiWorkEpoch) {
      capabilities.names = result;
      if (result.state === "ready") enhancedReasons.clear();
    }
  } catch (e) {
    if (epoch === aiWorkEpoch) notify(e.message, true);
  } finally {
    if (epoch === aiWorkEpoch) {
      setupProgress = null;
      await refreshAI();
    }
  }
}

for (const el of document.querySelectorAll("[data-icon]"))
  el.innerHTML = icon(el.dataset.icon);
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const d = button.dataset,
    id = button.id;
  if (d.closeDialog !== undefined) {
    dialog.close();
    review = null;
    return;
  }
  if (d.view) {
    navigate(d.view);
    return;
  }
  if (d.focus) {
    try {
      await api("focus", { tabId: Number(d.focus) });
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (d.review) {
    const s = data.suggestions.find((s) => s.id === d.review);
    if (s) openReview(s.tabs, s);
    return;
  }
  if (d.dismiss) {
    await action(
      "dismiss",
      { id: d.dismiss },
      "Suggestion dismissed. We’ll remember this choice.",
    );
    return;
  }
  if (d.protect) {
    const t = data.tabs.find((t) => t.id === Number(d.protect));
    if (t)
      await action(
        "protect",
        {
          tabIds: [t.id],
          protected: !t.protected,
          expectedTabs: expected([t]),
        },
        t.protected
          ? "URL unprotected."
          : "URL protected. All open copies stay out of suggestions.",
      );
    return;
  }
  if (d.restore) {
    if (d.again === "true") {
      confirmDialog(
        "Reopen this saved list again?",
        "This opens a fresh copy of every saved URL in this list. Any copies you already have open stay open.",
        "Reopen again",
        () =>
          action(
            "restore",
            { id: d.restore, kind: d.kind, again: true },
            "Saved URLs reopened.",
          ),
      );
      return;
    }
    await action(
      "restore",
      { id: d.restore, kind: d.kind },
      "Saved URLs reopened.",
    );
    return;
  }
  if (d.forget) {
    confirmDialog(
      "Remove this saved list?",
      "This erases the saved URLs in this list. It does not close any open tabs.",
      "Remove list",
      () =>
        action("forget", { id: d.forget, kind: d.kind }, "Saved list removed."),
    );
    return;
  }
  if (id === "refresh" || id === "check-again" || id === "retry") {
    await refresh();
    return;
  }
  if (id === "close-workspace") {
    button.disabled = true;
    try {
      await api("closeWorkspace");
    } catch (error) {
      button.disabled = false;
      notify(error.message, true);
    }
    return;
  }
  if (id === "dismiss-disclosure") {
    await action(
      "dismissDisclosure",
      {},
      "You can review privacy choices anytime in Settings.",
    );
    return;
  }
  if (id === "toggle-history") {
    await action(
      "settings",
      { patch: { historyEnabled: !data.settings.historyEnabled } },
      data.settings.historyEnabled
        ? "History insights turned off and their local index erased."
        : "History review started. Existing suggestions remain available.",
    );
    return;
  }
  if (id === "retry-history") {
    await action(
      "retryHistory",
      {},
      data.settings.historyEnabled
        ? "History review requested. Tab suggestions remain available."
        : "The local history index was erased. History insights remain off.",
    );
    return;
  }
  if (id === "dismiss-receipt") {
    lastDecision = null;
    $(".decision-receipt")?.remove();
    return;
  }
  if (id === "ai-status") {
    navigate("settings");
    return;
  }
  if (id === "start" || id === "resume") {
    const patch = { enabled: true };
    const useAI =
      id === "start" ? $("#start-ai").checked : data.settings.aiEnabled;
    if (useAI !== data.settings.aiEnabled) patch.aiEnabled = useAI;
    // Model creation begins inside this disclosed click gesture; metadata work
    // remains gated by the successful observation preference below.
    if (
      id === "start" &&
      useAI &&
      !["ready", "unsupported"].includes(capabilities.names.state)
    )
      void beginModelSetup();
    const result = await action(
      "settings",
      { patch },
      "Your local workspace is ready.",
    );
    if (!result) stopUIAI();
    window.scrollTo(0, 0);
    return;
  }
  if (id === "toggle-observation") {
    await action(
      "settings",
      { patch: { enabled: !data.settings.enabled } },
      data.settings.enabled
        ? "Local observation paused."
        : "Local observation started.",
    );
    return;
  }
  if (id === "review-selected") {
    openReview(data.tabs.filter((t) => selection.has(t.id)));
    return;
  }
  if (id === "clear-data") {
    confirmDialog(
      "Erase your local Tabosmart data?",
      "This permanently removes all saved URLs, recovery lists, activity and preferences from Tabosmart, and stops observation. Open tabs stay open.",
      "Erase local data",
      () =>
        action("clearData", {}, "Tabosmart data erased. Observation is off."),
    );
    return;
  }
  if (id === "back-to-review") {
    review.confirming = false;
    renderReview();
    return;
  }
  if (id === "close-selected") {
    confirmClose();
    return;
  }
  if (["apply-group", "save-selected", "confirm-close"].includes(id)) {
    const tabs = review.tabs.filter((t) => review.selected.has(t.id)),
      args = {
        tabIds: tabs.map((t) => t.id),
        expectedTabs: expected(tabs),
        ...(review.suggestion ? { suggestionId: review.suggestion.id } : {}),
      };
    if (id === "apply-group") {
      args.name =
        $("#group-name").value.trim() || review.suggestion.proposedName;
      await action(
        "group",
        args,
        review.suggestion?.targetGroup
          ? `Tabs added to ${review.suggestion.targetGroup.title}.`
          : "Tabs grouped. A little more room to think.",
      );
    } else if (id === "save-selected") {
      await action(
        "save",
        args,
        "URLs saved for later. Your tabs are still open.",
      );
    } else {
      args.confirmed = true;
      await action(
        "close",
        args,
        "Tabs closed. Reopen their URLs in Recovery.",
      );
    }
    return;
  }
  if (id === "toggle-ai") {
    if (data.settings.aiEnabled) {
      stopUIAI();
    }
    await action(
      "settings",
      { patch: { aiEnabled: !data.settings.aiEnabled } },
      data.settings.aiEnabled
        ? "Local AI turned off. Your suggestions still work."
        : "Local AI enabled. Model setup may still be needed.",
    );
    if (data.settings.aiEnabled) await refreshAI();
    return;
  }
  if (id === "setup-ai") {
    if (
      combinedCapability().state === "ready" ||
      combinedCapability().errorSource === "availability"
    ) {
      await refreshAI();
      return;
    }
    await beginModelSetup();
    return;
  }
  if (id === "ai-name") {
    if (
      !review ||
      review.suggestion?.targetGroup ||
      !data.settings.enabled ||
      !data.settings.aiEnabled
    )
      return;
    const epoch = aiWorkEpoch,
      currentReview = review;
    const revision = review.nameRevision,
      selectionRevision = review.selectionRevision;
    const baseKey = evidenceKeyFor(review.suggestion);
    const proposal = selectedNameProposal();
    review.namingPending = true;
    updateReviewSelection();
    void syncProactiveNames();
    const result = await proactiveNames.request(proposal, { retry: true });
    if (epoch !== aiWorkEpoch || review !== currentReview || !dialog.open)
      return;
    review.namingPending = false;
    const stillCurrent =
      baseKey ===
        evidenceKeyFor(
          data.suggestions.find((s) => s.id === review.suggestion.id),
        ) &&
      selectionRevision === review.selectionRevision &&
      evidenceKeyFor(proposal) === evidenceKeyFor(selectedNameProposal());
    const keptManualEdit = revision !== review.nameRevision;
    if (result && stillCurrent && !keptManualEdit) {
      review.name = result.name;
      review.nameSource = "local-ai";
      $("#group-name").value = result.name;
      $("#review-name-provenance").innerHTML = aiNameBadge();
    }
    updateReviewSelection();
    await refreshAI();
    if (epoch !== aiWorkEpoch || review !== currentReview || !dialog.open)
      return;
    notify(
      keptManualEdit
        ? "Kept your edited name."
        : !stillCurrent
          ? "The selected tabs changed. Kept your current name."
          : result
            ? "Suggested name updated. You can still edit it."
            : (capabilities.names?.lastRequest?.state === "failed"
                ? capabilities.names.lastRequest.detail
                : null) ||
              "Kept the current name. AI did not find a better supported name.",
    );
  }
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#more-topics")) proactiveDiscovery.more();
});
document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.matches("[data-tab-check]")) {
    const id = Number(el.dataset.tabCheck);
    if (dialog.contains(el) && review) {
      el.checked ? review.selected.add(id) : review.selected.delete(id);
      changedReviewSelection();
      updateReviewSelection();
      void syncProactiveNames();
    } else {
      el.checked ? selection.add(id) : selection.delete(id);
      $("#selection-count").textContent = `${selection.size} selected`;
      $("#review-selected").disabled = !selection.size;
    }
  }
  if (el.id === "review-select-all" && review) {
    changedReviewSelection();
    review.selected = new Set(
      el.checked
        ? review.tabs
            .filter(
              (t) => review.suggestion?.type === "group" || safeForClose(t),
            )
            .map((t) => t.id)
        : [],
    );
    dialog
      .querySelectorAll("[data-tab-check]")
      .forEach(
        (c) => (c.checked = review.selected.has(Number(c.dataset.tabCheck))),
      );
    updateReviewSelection();
    void syncProactiveNames();
  }
  if (el.id === "group-name-language")
    action(
      "settings",
      { patch: { groupNameLanguage: el.value } },
      "Naming preference updated. Existing browser group names stay as you chose them.",
    );
  if (el.id === "inactivity-days")
    action(
      "settings",
      { patch: { inactivityDays: Number(el.value) } },
      "Review timing updated.",
    );
});
document.addEventListener("input", (event) => {
  if (event.target.id === "group-name" && review) {
    review.name = event.target.value;
    review.nameRevision++;
    review.nameSource = "user";
    $("#review-name-provenance").textContent = "";
  }
  if (event.target.id === "tab-search") {
    const cursor = event.target.selectionStart;
    search = event.target.value;
    renderTabs();
    const input = $("#tab-search");
    input.focus();
    input.setSelectionRange(cursor, cursor);
  }
});
dialog.addEventListener("close", () => {
  review = null;
  if (data && !busy) renderPreservingFocus();
  void runVisibleAI();
});
window.addEventListener("focus", () => {
  connectToolbar(true);
  if (data && !dialog.open && !busy) refresh();
  void refreshAI();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopEnhancement();
  void syncProactiveNames();
  if (!document.hidden) void refreshAI();
});
window.addEventListener("pagehide", () => {
  leaving = true;
  stopEnhancement();
  aiWorkEpoch++;
  aiStatusWatcher.stop();
  proactiveNames.stop();
  proactiveDiscovery.stop();
  clearTimeout(toolbarTimer);
  clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = null;
  pendingSnapshotRefresh = false;
  toolbarPort?.disconnect();
  toolbarPort = null;
  cancelLocalAI({ preserveSetup: true });
});
function drainSnapshotChanges() {
  if (
    leaving ||
    busy ||
    !pendingSnapshotRefresh ||
    snapshotRefreshRun ||
    snapshotRefreshTimer
  )
    return snapshotRefreshRun;
  snapshotRefreshRun = (async () => {
    while (pendingSnapshotRefresh && !busy) {
      pendingSnapshotRefresh = false;
      try {
        const next = await api("cachedSnapshot");
        snapshotRefreshFailures = 0;
        const previous = data;
        acceptData(next);
        updateCheckStatus();
        if (
          !busy &&
          !dialog.open &&
          viewSignature(previous) !== viewSignature(data)
        )
          renderPreservingFocus();
      } catch {
        setCheckStatus("error", "Check interrupted");
        if (leaving) break;
        pendingSnapshotRefresh = true;
        const delay = Math.min(
          1000 * 2 ** Math.min(snapshotRefreshFailures++, 4),
          10000,
        );
        snapshotRefreshTimer = setTimeout(() => {
          snapshotRefreshTimer = null;
          void drainSnapshotChanges();
        }, delay);
        break;
      }
    }
  })().finally(() => {
    snapshotRefreshRun = null;
    if (pendingSnapshotRefresh && !busy && !snapshotRefreshTimer)
      void drainSnapshotChanges();
  });
  return snapshotRefreshRun;
}
globalThis.chrome?.runtime?.onMessage?.addListener((message) => {
  if (message.type === "snapshotChanged") {
    clearTimeout(snapshotRefreshTimer);
    snapshotRefreshTimer = null;
    pendingSnapshotRefresh = true;
    void drainSnapshotChanges();
  }
});
async function bootstrap() {
  connectToolbar();
  try {
    acceptData(await api("cachedSnapshot"));
    render();
  } catch {}
  await refresh();
  await refreshAI();
}
void bootstrap();
