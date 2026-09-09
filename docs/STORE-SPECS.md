# Historical Chrome Web Store preparation notes

For the current 0.9.0 campaign, use [the artifact index](../ARTIFACTS.md) and [current listing copy](STORE-LISTING.md). All five current screenshots and both promotional tiles are in `marketing/community-launch/store/`. The historical paths below refer to earlier local assets, which are not included in the public repository.

Official references checked on 8 September 2026. These notes describe Tabosmart 1.3.0 source. Source tests and current capture provenance are verified. Package reports separately establish archive contents and SHA-256 after packaging. This is not a Store submission, approval or publication record.

## Images and text

| Asset              | Specification                                                | Local path                                                       |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| Store/package icon | PNG 128×128; square mark 96×96 with 16px transparent padding | marketing/brand/store-icon-128.png; extension/icons/icon-128.png |
| Toolbar icons      | Static PNG 16/32, plus 48 for relevant management surfaces   | extension/icons/icon-*.png; work-16.png and work-32.png          |
| Screenshots        | One to five; 1280×800 preferred, 640×400 accepted            | marketing/output/01-_.png through 05-_.png                       |
| Small promo        | Required 440×280 PNG/JPEG                                    | marketing/output/small-promo-440x280.png                         |
| Marquee            | Optional 1400×560 PNG/JPEG                                   | marketing/output/marquee-1400x560.png                            |
| Toolbar mock       | Internal design illustration; not an actual browser capture  | marketing/output/toolbar-states-preview.png                      |

Screenshot/promo exports use opaque RGB PNGs; icons retain transparency. Captures must show current functionality, with no invented stages, fake results or unsupported performance claims. Keep the brand exactly Tabosmart and the plain-text short description at most 132 characters. [Image guide](https://developer.chrome.com/docs/webstore/images), [listing dashboard](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [description limit](https://developer.chrome.com/docs/extensions/reference/manifest/description)

The 1.3.0 asset manifest verifies seven source captures: five Store screenshots at 1280×800, a fresh nonblocking first-use view and a 390px Close view. All have zero axe violations, page errors and external requests. The separate toolbar preview is a ten-state static mock at 1200×1315, explicitly labeled as an illustration. Runtime/history/model data are synthetic; no actual profile, history or model inference is implied. Historical 1.1.0 asset manifests remain in qa/releases/1.1.0; no claim is made that the old image bytes are archived there.

The official image guide lists an icon, small promo and at least one screenshot as mandatory. Verify the live dashboard's video validation during authorized submission; no placeholder YouTube URL is supplied. [Design principles](DESIGN-PRINCIPLES.md) are source-informed product hypotheses. [Video brief](VIDEO-BRIEF.md) is a future storyboard only, not a produced or published video.

## Permissions and data declarations

The manifest requires tabs, tabGroups, storage, alarms and history. History access is part of the current history-informed tab-ordering feature; there is no optional permission request or extra onboarding history gate. A fresh installation begins observation and history analysis after Chrome's normal grant and shows a nonblocking disclosure. Existing stored pauses and erasure remain respected.

History search starts at zero, partitions saturated ranges and retrieves retained visits. The derived index retains hashed exact-URL identifiers, aggregate visit counts/recency and resumable checkpoints in local IndexedDB. It does not retain raw history URLs, titles or visit lists. The separate open-tab/observed-URL/shelf/recovery records do contain exact metadata. Hashes are neither anonymous nor encrypted. See [Privacy](PRIVACY.md) and the [permission justifications](STORE-LISTING.md).

Coverage means history exposed by Chrome, not all lifetime browsing. Deleted, Incognito and unavailable records are outside that claim. Processing errors remain partial; Chrome may return synced visits. The extension does not modify Chrome history. [History API](https://developer.chrome.com/docs/extensions/reference/api/history)

There are no host permissions, content scripts, scripting, bookmark access, telemetry, remote code or cloud-AI fallback. Alarm-based maintenance is approximately 15 minutes while enabled, with short pending-work recovery alarms. Worker suspension and sleep may delay work. [Permissions guidance](https://developer.chrome.com/docs/webstore/program-policies/policies#use-of-permissions), [Alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)

Local processing still handles user data. The privacy policy and dashboard answers must disclose the broader history scope and the narrower retained index, as well as existing tab data. Do not choose “no user data” because nothing is uploaded. [Privacy dashboard](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

## Store readiness boundary

The requested auto-start/nonblocking-disclosure behavior is documented as implemented, not certified compliant. The current official FAQ requires a specific in-product agreement before collection and describes encryption-at-rest requirements. The existing flow and local storage need reconciliation with those requirements before submission. No additional gate has been added by this documentation work and no Store outcome is asserted. [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

Publish the final privacy policy with verified publisher/contact details at a real public HTTPS URL before submission. Package manifest placement, permissions, claims, dashboard answers and current captures must agree. Final ZIP contents and SHA-256 belong in the package reports; this document does not establish that an archive has already been built. [Publishing guidance](https://developer.chrome.com/docs/webstore/publish)

## Product and AI claims

Every valid non-dismissed proposal remains available; large reviews split at 200 members without dropping eligible tabs. Initial grouping uses local site/title/co-use evidence. Optional model discovery can add inferred tasks/topics from bounded title evidence across arbitrary sites, with backend revalidation and normal ranking. Automatic subsequent passes cover further eligible batches, and dynamically generated hints nominate bounded cross-batch comparisons. No publisher/category catalog or all-pairs model scan is used. [Discovery limits](MULTILINGUAL-GROUPING.md)

A visible Close control closes the validated workspace only and returns to browsing. The toolbar uses static icons and actual core/history/AI activity; availability alone is not work. Global badge text is limited visually, with full counts and context in its accessible title. [Action API](https://developer.chrome.com/docs/extensions/reference/api/action)

AI defaults on for fresh/missing preferences and preserves existing off choices. Setup stays explicit when downloading is needed. Deterministic names/reasons appear first; ready AI may discover new candidate relationships, refine names and select vetted wording. It cannot read pages or apply actions. Existing naming has ten automatic attempts per workspace; discovery uses automatically continuing bounded passes, metadata-based caching, cancellation, cooldowns and error backoff. Model availability and individual failures remain separate.

Chrome's model download may continue after its initiating tab closes; the workspace's session and progress reporting end. Reopening checks actual availability. An AI badge must not continue solely because a disconnected page previously reported work. [Model management](https://developer.chrome.com/docs/ai/understand-built-in-model-management#initial_model_download), [Prompt API](https://developer.chrome.com/docs/ai/prompt-api)

## Verification boundary

Version 1.3.0 passes 247 unit tests, source/scope checks and an audit with zero vulnerabilities. Source HTTP integration passes 134 checks across 39 scenarios, with ten tested axe surfaces and no violations, page errors or external requests. Native IndexedDB verification passes 25 checks using 257 synthetic URLs and 771 visits across three reloads, including rollback/resume/erase. This is source verification, not installed-browser or real-history coverage. [QA](QA.md)

Historical 1.0.0 regular Chrome evidence shows actual installation, model progress through 11% and deterministic grouping during download. The user reported the old timeout, then later a Ready-to-timeout sequence after reload. The later version and inference were not independently verified. The 1.0.1 progress-aware watchdog and 1.0.2 availability/request separation fixed source defects but do not prove the live sequence's cause.

Automatic approval review continues to block extension-URL access and alternate methods. No current regular-Chrome verification, real reset or successful inference is claimed. The 64-fixture fresh-model plan stopped before reset and used Node HTTP validation only. [QA](QA.md), [real first-run plan](REAL-FIRST-RUN-QA.md)

For a future permitted manual check, reload **Tabosmart only** on chrome://extensions, handle Chrome's own history permission notice if shown, reopen the workspace and verify 1.3.0. Preserve stored pauses and choices. Use **Check availability** passively and the extension's own setup/download control when appropriate. These are instructions, not a claim that the build was loaded.
