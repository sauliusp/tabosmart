# Tabosmart 1.4.0 QA

The [final source report](../qa/final-source-checks.json) records final counts, source hashes and commands. The update is prepared locally for user testing. No personal Chrome profile or installed extension was accessed, and no real model download or inference was attempted.

## Checks performed

- `npm test`: pure-engine, mocked-backend, AI lifecycle, history, context and native-action validation tests.
- `npm run check`: required permission scope, packaged modules, syntax and absence of network or page-reading APIs.
- `node scripts/preview-integration-qa.mjs`: actual UI modules served over disposable localhost HTTP, with synthetic browser/model APIs. [Report](../qa/preview-integration-report.json)
- `node scripts/multilingual-repro.mjs`: archived 1.3.0 versus current source on stored public-reference titles, plus 100/500/1,000-tab synthetic scan timings. [Report](../qa/multilingual-reproduction.json)
- `npm run pack`: archive contents and SHA-256 verification for the extension and source packages.

## New behavior and regression coverage

Stored Lrytas, Delfi and LRT homepage titles form one deterministic news group with AI unavailable or ready. The opaque Alfa title is excluded. Unfamiliar Unicode title clusters and optional AI discovery still work.

Specific repositories, project paths, products and document identities remain distinct. Generic route/owner words cannot merge different repositories. Same-site fallback is suppressed on known multipurpose services or explicit resource paths.

Creation tests distinguish actual opener events from restored inventory and capture source URL identity before queued work. Generic inbox/homepage sources require corroboration; a specific search context can link titles with no common language. Child navigation, pending URLs, missing parents, privacy flags and reused IDs are exercised.

Usage tests reject a rapid switching burst, count independent periods, avoid transitive chains, discount hubs and cover restart, pause, hydration, bounded data and expiry. Confirmed grouping choices preserve names, require substantial resource coverage and reject oversized partial memories.

Existing-group tests allow a single reviewed newcomer, retain the exact native name/color/collapse state, reject ambiguous or incoherent destinations, and revalidate changed names, windows and complete memberships before mutation. Non-web or guarded target members cannot be hidden to fabricate a coherent group. Dismissed/resolved choices remain suppressed; changed memberships can be offered again.

The source UI run covers editable news grouping, existing-group read-only name and one-member action, and recalled names protected from automatic AI naming. It also rechecks the existing availability/download/error/review/Close/history interfaces and accessibility. All model responses and native action results in this HTTP preview are mocked; backend action logic is independently tested with mutable browser fixtures.

## Review and performance

Independent agent reviews found and prompted fixes for incomplete destination references, delayed opener lookup, remembered-name overwrites, oversized remembered-group truncation and generic cross-repository title matches. Meaningful regressions cover those changes.

Performance checks include 1,000 unrelated tabs, dense shared-title tabs, structured workspaces, existing groups and populated local context. These are Node scans on this development machine, not end-to-end Chrome latency, battery/memory benchmarks or evidence of user acceptance. Remaining uncertainties include real metadata coverage, browsing habits, useful group sizes and real local-model quality.

## User test

Reload **Tabosmart only** at chrome://extensions, then reopen its workspace and verify **1.4.0**. Review the news-homepage suggestion if the open titles expose the relevant clues. Try tabs within a specific project, several tabs opened from the same search, and an addition to an existing coherent group. Confirming a group can teach its name for later matching resources. Opening context and recurrence need actual post-update observation; no earlier events are invented.

Keep useful groups, remove incorrect members and dismiss unwanted proposals normally. Note missed obvious groups, wrong members and whether the explanation helps. No automatic grouping occurs. Existing stored dismissals and protections can legitimately prevent an otherwise matching suggestion.

## Historical evidence

Version 1.3.0 reports and source baselines are archived in [qa/releases/1.3.0](../qa/releases/1.3.0/). Earlier source UI/IndexedDB/Store-asset reports keep their original version and synthetic-data boundaries. The unchanged history implementation's earlier IndexedDB test remains historical evidence, not a fresh 1.4.0 run. Store assets were not regenerated for this test update.

Earlier regular-Chrome observations concerned older builds and included model download progress and user-reported readiness/timeouts. The historical installed-browser access rejection remains documented; this update uses source-only checks and does not claim current installed behavior. No Store submission or publication occurred.
