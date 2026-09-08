# Architecture

Tabosmart 1.4.0 is a dependency-free Manifest V3 extension. The source manifest requires tabs, tabGroups, storage, alarms and history. There are no host permissions, content scripts, scripting permission, bookmark access or remote executable assets.

## Components

| Module                                       | Responsibility                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| topic-evidence.mjs                           | Unicode lexical clustering, boilerplate filtering and bounded AI naming-language policy.  |
| group-discovery.mjs, proactive-discovery.mjs | Bounded model metadata, output/hint validation, automatic passes, cross-batch nominations, cache and cancellation.               |
| core.mjs                                     | Deterministic grouping, duplicate and older-URL proposals; complete discovery, ranking, settings and identity validation.        |
| background.mjs                               | Serialized native actions, observation scheduling, cached snapshots, persisted records, history integration and toolbar updates. |
| history-index.mjs                            | Resumable analysis of API-available history and local IndexedDB aggregates.                                                      |
| workspace-view.mjs                           | Serialized workspace opening, reuse and validated self-close; return-tab session context.                                        |
| toolbar-state.mjs                            | Pure global action mapping and ephemeral reports from workspace Ports. It does not run a model.                                  |
| app.mjs, index.html, styles.css              | Full-tab review workspace, disclosures, controls, dialogs, actual progress and action receipts.                                  |
| local-ai.mjs                                 | Optional document-context Prompt API use with separate availability, setup and request outcomes.                                 |
| proactive-names.mjs                          | Visible proposal naming, metadata cache, attempt limit and stale-result guards.                                                  |
| ai-status-watch.mjs                          | Passive capability refresh without model creation.                                                                               |

The additional `metadata-groups.mjs`, `grouping-context.mjs` and `existing-group-matches.mjs` modules provide immediate resource/category matching, bounded opening/use/choice records and conservative existing-group additions. The metadata vocabulary is explicit and finite; there is no publisher-domain directory.

## Startup and observation

On an installation with no stored Tabosmart state, backend initialization enables observation and history insights, records the initialization time and marks a nonblocking first-use disclosure for display. This is the normal lifecycle after Chrome's required permission grant, with no optional history request or additional onboarding permission gate. Existing stored pauses and erased states are not silently re-enabled. The stored consentAt field also records this fresh-install initialization; it is not evidence of a separate in-product consent click.

Tab creation, metadata/state changes, activation, removal, moving/replacing/attaching, grouping and relevant window events schedule checks. Bursts settle for 250 ms with a two-second maximum delay. A roughly 30-second alarm provides recovery after worker suspension; maintenance runs approximately every 15 minutes while enabled. Chrome may delay alarms or suspend the worker. These are not continuous observation or device-wake guarantees. [Worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [Alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)

Activation events update Tabosmart's own use record independently of the debounced check. Active tabs receive conservative recency. This is not a measure of attention, importance or dwell time. History-derived evidence remains separate from locally observed tab activity.

## Comprehensive browser-history analysis

The history permission is required in the manifest. The implementation checks actual API access and fails to a truthful unavailable/partial state if access or storage is unavailable. It never invokes an optional permission prompt.

Initial discovery uses history.search with an empty text query, startTime zero and a captured end time. Saturated time ranges split recursively; a dense one-millisecond range increases its request limit. API call and work-per-turn limits bound each step, not total coverage. Each nonempty URL returned by the API is processed through history.getVisits, including non-web schemes if Chrome exposes them. Only matching current HTTP(S) tabs consume the resulting facts in suggestions. Per-generation hash keys deduplicate overlapping ranges. The API describes search as returning pages by their last visit; getVisits supplies retained visit evidence. [History API](https://developer.chrome.com/docs/extensions/reference/api/history)

The local IndexedDB database tabosmart.history has records and meta stores. A record contains a SHA-256 digest of the exact URL, generation identifier, retained-visit count, count from the preceding 30 days, latest retained visit time, Chrome's aggregate visit count and the time of analysis. It contains no raw history URL, title or visit list. Raw API results exist temporarily during processing. Hashing supports exact matching, not anonymity or encryption.

Metadata stores unprocessed time ranges, generation, real processed-URL/visit counts and synchronization timestamps. A transaction commits each aggregate and its counter checkpoint together. After worker suspension, ranges resume and already committed generation records are skipped. A failed or incomplete pass reports partial coverage rather than claiming success.

New visit events and maintenance request incremental analysis from the preceding synchronization boundary, with an overlap to avoid dropping boundary timestamps. A full refresh is due after roughly one day and runs when enabled processing next occurs. Completed full generations sweep records absent from the current API results. History deletion events clear the derived index and rebuild when active; turning history insights off or erasing data clears it. Pause stops processing and retains its checkpoint. No processing occurs while Chrome or the extension is off.

Coverage means all history the API makes available at the time of analysis. It is not a lifetime history guarantee. Deleted, Incognito, unavailable or browser-retention-expired visits cannot be recovered. Chrome may return visits synced from another device; the index does not filter on isLocal. Browser access and storage errors can leave coverage partial.

## Discovery and ordering

Initial membership combines existing-group matches, remembered choices, specific URL resources, scoped Unicode title anchors, recorded opener families, explicit multilingual category clues, independent repeated-use sets and conservative same-site fallback. The core recomputes each weaker family from unoccupied tabs; a raw switch counter no longer generates a proposal. History aggregates remain ranking-only. [Detailed algorithm, priorities and limits](MULTILINGUAL-GROUPING.md)

Existing-group suggestions contain only ungrouped additions and capture the complete target member URL/ID identity, name and window. One addition is allowed. Protected/non-web/incoherent references and ambiguous destinations are skipped. The backend revalidates the captured target immediately before adding without changing its title/color/collapsed state. Group confirmations store their name and exact pages/narrow resources locally. The UI excludes native and recalled names from automatic AI naming.

Exact duplicate identity includes the full URL, query and fragment. A retained copy is identified before extra copies are offered for review. Older-URL eligibility still comes from Tabosmart's own activity and restart rules, not merely a browser-history visit date.

Every valid non-dismissed proposal is returned. The former five-suggestion cap and eight-older-tab cutoff are removed. A review cannot exceed 200 selected tabs, so large member sets are split into multiple actionable proposals without dropping members. Group batching avoids a final singleton.

Ordering favors the currently used tab, explicit existing/confirmed organization and specific metadata evidence, then opening/category/repeated-use/AI/site evidence, available history recency band, recent visit frequency and review effort, followed by stable tie-breakers. History facts are matched only by the exact current URL. A visit count is evidence of repeated loading, not proof that work matters. A why-this-order detail exposes the measured rationale and qualifies partial history.

## Visible work and toolbar state

evaluation persists queued/checking/completed/error state. A successful check stores evaluationSummary, checkedAt and cached suggestions. Cached reads do not trigger another evaluation. The summary counts considered web tabs and displayed review opportunities, and keeps the last completed result labeled during a new check or error.

Raw duplicate counts differ from safely reviewable extras. Protected, pinned and audible categories overlap; guarded is their unique union. Insufficient history also includes recently used tabs or an unmet grace period. Do not add overlapping exclusions. There is no intentional display-cap count in the complete-discovery flow. History has separate indexing/updating/ready/partial/error state and actual processed counts. No stage, completion percentage or model success is fabricated.

The toolbar uses global chrome.action state. A static warm-dot work icon and ellipsis reflect actual tab checking or history processing; an AI badge reflects active setup, discovery, naming or wording reported by an open workspace. Core checks have priority over history, then AI. Idle results display the actual suggestion count, capped visually at 99+ while the title retains the full number. Pause/start are blank; check/history errors use an exclamation badge. Cached counts are qualified as from the last completed check during work or failure.

Workspace Ports carry allowlisted ephemeral activity only. Disconnect removes their report; a reconnect sends fresh state. The worker reapplies desired action state on initialization rather than trusting an old badge. A connected Port alone is not a worker-lifetime guarantee. [Action API](https://developer.chrome.com/docs/extensions/reference/api/action), [Port API](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-Port)

## Workspace Close

Toolbar clicks serialize opening/reuse of the normal index.html workspace. Browser-session storage keeps bounded return tab/window IDs; it does not persist return URLs or titles.

Close accepts only the extension's own workspace sender and revalidates the live URL, pending navigation, tab ID, regular profile and window. It closes that workspace only. It returns to a still-valid remembered browsing tab, with Chrome's normal tab selection as fallback. If the workspace is the window's last tab, a new tab is created first. It does not close selected work tabs, pause observation or erase data.

On pagehide, cleanup cancels inference and disconnects UI reports but deliberately does not abort an active setup controller. Closing the document still ends its callbacks and session context; preserving a controller is not a promise that the page or listener survives. Chrome explicitly documents that a triggered model download continues after the initiating tab closes and can resume after a browser restart within 30 days. The extension cannot report unseen progress or completion after losing its owner page. Reopening checks current availability. This is a browser download guarantee, not a live inference result. [Chrome model management](https://developer.chrome.com/docs/ai/understand-built-in-model-management#initial_model_download)

## Actions, recovery and retained tab context

Native actions are serialized. Each selected identity is rechecked before action, including exact URL and relevant state. Pinned, audible and protected tabs are guarded; closing also guards active tabs. URL protections apply to all matching copies. Accepted or dismissed proposals are remembered. There is still a native race between final validation and mutation because Chrome offers no atomic tab lock.

Saving stores links without closing them. Closing persists recovery first and refuses operations when retention capacity cannot preserve them. Restore records per-item completion, does not blindly replay ambiguous interrupted attempts and only reopens URLs. Forms, unsaved edits, login state and exact page state are not restored.

Tabosmart's separate observed-URL ledger holds up to 2,000 exact URLs, including closed tabs, with 90-day unseen pruning when local records are next processed. Current-session tab observations are capped at 2,000; co-use pairs at 1,000 and 30 days, removed when a member closes or navigates. Temporary window-close records are capped at 2,000 and 90 days.

A new browser session starts fresh tab identities and current-tab ages. Only an unambiguous one-prior/one-current exact-URL match during initial populated reconciliation can reuse review evidence, after a five-minute grace period. New, navigated, ambiguous and later-restored tabs get fresh eligibility. Pause/resume also resets eligibility while retaining context. No URL match proves continuous tab identity.

Shelf and recovery each allow 100 batches and 1,000 URLs. Dismissals cap at 1,500; protections persist until removed or erased. See [Privacy](PRIVACY.md).

The separate grouping context retains up to 256 opening records for one day, 128 completed periods for 30 days, eight unfinished window periods, and 64 confirmed choices (at most 200 unique URLs each) for 90 days, under a 300,000 serialized-character budget. Opener URLs include exact query context. Oversized choices and overfull activity periods are skipped rather than learned as truncated groups. Worker hydration preserves sanitized in-session context; browser-session reset/pause clears unfinished periods and openings. Full erasure clears all context. See the [retention details](MULTILINGUAL-GROUPING.md#local-retention-and-control).

## Optional AI and security boundary

Fresh/missing AI preferences default true; user choices and legacy false values are preserved with provenance. A preference does not create a model or prove readiness. Setup requires an explicit supported user gesture. Proactive names use only eligible visible metadata while enabled and ready, with immediate deterministic fallback, at most ten automatic attempts per interface, exact-evidence cache/deduplication and names before optional wording. Reviews and edits stay frozen against late results.

Explanation assistance selects a vetted equivalent phrasing. Model availability, last setup and last request remain separate. Setup's ten-minute progress-aware inactivity watchdog does not impose a ten-minute total download limit. The passive watcher never creates a model. [AI contract](AI.md)

The CSP blocks extension network connections. No page bodies, native bookmarks, cloud model, telemetry or remote assets are used. Native website loads and Chrome-managed downloads are separate. Source/synthetic verification does not establish installed-browser behavior; see [QA](QA.md).

## Verification record

The current commands, counts and hashes are in [QA](QA.md) and [the final source report](../qa/final-source-checks.json). Core/backend tests and disposable HTTP UI integration use synthetic browser/model data. No personal profile, installed extension, real history or actual AI inference is exercised by the 1.4.0 checks. Historical 1.3.0 reports/source/screenshots remain under `qa/releases/1.3.0/`.
