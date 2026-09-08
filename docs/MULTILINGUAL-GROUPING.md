# Grouping without AI in 1.4.0

Prepared 8 September 2026. Suggestions for the current workspace appear without waiting for AI or a learning period. Local AI remains optional and retains its existing language, readiness and model-download limits.

## Evidence and candidate order

The engine evaluates the complete eligible inventory in this order, recomputing weaker families from the remaining tabs:

1. Additions to coherent existing native groups, preserving their exact names.
2. Previously confirmed grouping choices matched to exact pages or specific URL resources.
3. Specific URL workspaces, repositories, documents, folders and products.
4. Distinctive Unicode title anchors, with service route/owner words insufficient to bridge different resources on one service.
5. Actual opening families captured from the same source page within five minutes.
6. Broad categories supported by each member's title or URL section.
7. Selective whole sets used across at least three separate recorded browsing periods.
8. Broad same-site groups where a host does not represent unrelated workspaces.

Exact duplicate reviews reserve their proposed extra copies first. Optional validated AI discoveries enter after deterministic membership selection. Inactivity reviews retain the original safety and URL-use rules. All valid non-dismissed proposals remain available; reviews split at 200 selected tabs. A single new tab may be added to an existing group after review.

## Immediate metadata matching

`metadata-groups.mjs` recognizes explicit resource structures such as `/projects/aurora/...`, `/products/camera-model/...`, repository paths, and exact Google document or folder identities. Query parameters and arbitrary numeric paths do not establish workspace identity. Different resources on a large service do not become one same-site fallback. Known URL schemas describe service structure; they are not a news-publisher directory.

The category vocabulary covers news, recipes, accommodation and documentation in several languages. Labels are localized for the available naming preferences where defined. Category evidence preserves the actual matched title word or URL section. Tutorial, reference and ambiguous mixed-category metadata is excluded. A category is an organizing clue rather than a verified classification of every page on a domain. Language coverage is finite; opaque titles and synonyms outside the vocabulary can still be missed.

The stored public-reference fixture contains Lrytas, Delfi and LRT titles with Lithuanian news clues, plus the opaque Alfa brand because its earlier fetch failed. Version 1.4.0 produces one three-member Naujienos proposal without AI. The opaque fourth title is excluded. The archived 1.3.0 source produces no proposal for the same fixture. This is a source reproduction, not inspection of the user's current tab titles or proof about an additional publisher. See [reproduction](../qa/multilingual-reproduction.json).

## Opening and usage context

`grouping-context.mjs` records opening context only from actual creation events. The backend captures an opener lookup immediately and rejects disagreement with its already-observed identity. The opener's exact URL is kept with the child identity, rather than being relabeled after the source navigates. Initial startup inventory and the first minute after a browser-session start do not create opening evidence. An unresolved child URL gets at most one minute to become available; a later navigation or closed child invalidates its link.

A source with a specific search query can support a family across unrelated titles or languages. A generic homepage or inbox needs corroborating title/resource evidence. Shared time or neighboring tab positions alone never generate a group. Suggestion reasons identify the source host and observed opening interval without exposing its query.

Only explicit observed activations build usage periods. Ten minutes without another recorded activation, or a thirty-minute period duration, closes a period. More than twelve distinct URLs makes that period unsuitable for learning rather than truncating it into a false small set. Repeated proposals require three sufficiently separated periods with the same set, selective recurrence, and at least two-thirds of that set present in the same current window. Widely used hub pages are discounted. Rapid switching alone and transitive chains do not establish a group. These are observed browsing periods, not proven attention or semantic tasks.

## Your choices and existing groups

A successful reviewed group action stores its chosen name and exact URL membership, with narrow resource keys derived from those URLs. Later proposals require at least two matches and at least two-thirds of the original resources represented. Matching a project path can include new pages within that project; matching a domain alone cannot. Automatic AI naming leaves recalled names alone, while the new-group review still permits an explicit rename.

Native group additions require coherent metadata shared with every current reference member. Group names alone do not prove membership. Ambiguous destinations, guarded or non-web reference members, and references with more than 256 members are skipped. The review shows only new additions with a read-only destination name. The backend revalidates the destination's full member identity, window and title immediately before grouping. Adding does not change its name, color or collapsed state.

Accepted exact memberships remain resolved. Native ungrouping does not immediately regenerate the same suggestion; changed memberships can produce a new proposal. Existing explicit dismissals and protections continue to apply. No group action runs automatically.

## Local retention and control

Context is separate from Chrome's history aggregate index. It retains up to 256 opening records for one day, 128 completed usage periods for thirty days, eight unfinished window periods, and 64 confirmed choices of at most 200 unique URLs for ninety days. The complete context is also limited to 300,000 serialized UTF-16 characters. Oversized choices are not learned as partial prefixes. Expiration occurs during enabled processing or hydration, and processing may be delayed while Chrome is stopped.

Worker restarts preserve validated unfinished observations in the same browser session. Browser-session changes and pause clear opening records and unfinished periods; completed periods and choices retain their bounded lifetime. Erasing Tabosmart data clears this context alongside the other local records. Opener URLs can include search queries; records remain in this Chrome profile and are not anonymous or encrypted. No page reading, network call, additional permission or remote classification is introduced.

## Optional AI and language limits

The existing model path still declares only English, Japanese, Spanish, German and French. Recognized unsupported input or output languages keep the local deterministic result. A Ready indicator does not mean every language is eligible. Automatic naming follows its bounded title-language heuristic; website suffixes do not select a language. Specific user and native group names are preserved.

AI can still propose additional inferred tasks from bounded current titles/domains and observed-use context. Its sequential queue, exact title-evidence checks, automatic continuation, cross-batch hint comparisons and cancellation remain in place. The model cannot perform actions. Real local-model quality was not tested in this update.

## Verification

[QA](QA.md) and the [final source report](../qa/final-source-checks.json) record the final test totals and source hashes. Unit and mocked-backend tests cover cold-start news, URL scopes, mixed resources, opener timing and navigation, restored inventories, repeated sets and inbox hubs, choices, expiry, privacy controls, dismissals, one-tab additions and stale destination rejection.

The disposable HTTP integration exercises the real source UI against synthetic browser/model APIs. It checks immediate Lithuanian suggestions with the model ready and unavailable, editable names, exact existing-group names, one-tab addition review, and preserved remembered names. Screenshots are source previews. No personal Chrome profile, installed extension or actual AI model was accessed.

Node timing reports measure synthetic source scans, not browser startup, real inference, attention, battery use or product acceptance. Real browsing quality is the next user test; passing fixtures does not guarantee every desired group will be found.

## Future translation gate

Translation remains unimplemented. Any future experiment must keep initial suggestions immediate, use bounded short metadata and a bounded queue, cache and cancel stale work, retain original metadata when unavailable, require a separate deliberate language-pack download action, and measure actual quality and resource cost before enablement.
