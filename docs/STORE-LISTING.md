# Tabosmart 1.6.0 · Community launch

## Name
Tabosmart

## Short description
Group tabs, review duplicates and save links for later. Local processing, optional on-device AI. Help shape what comes next.

## Detailed description
You didn’t open all those tabs for no reason. You just don’t need them all right now.

Tabosmart helps you make room for today’s work while keeping a place for later. Bring related tabs together, give repeat pages a second look, and save links you want to revisit. Nothing moves or closes without your approval.

A few good decisions. A little more headspace.

WHAT YOU CAN DO TODAY
• Review suggested groups, see the reason, edit the name and choose the tabs.
• Find repeated full URLs and select which copies to close. Identical addresses can still contain different unsaved work.
• Save URLs for later on a local shelf. Saving leaves the original tabs open until you choose to close them.
• Reopen recoverable URLs after supported closing actions. Recovery cannot restore unsaved edits, forms or exact page state.
• Give older work another look, with local activity and available history helping order comparable suggestions.
• Keep pinned, audio-playing and protected tabs out of suggestions.

YOUR BROWSING STAYS LOCAL
Tabosmart processes open-tab titles, URLs, activity and available browsing history in your Chrome profile. It does not read page contents or upload browsing records to the developer. No extension account, analytics or cloud-AI fallback. You can pause observation, turn history insights off, or erase local records in Settings & privacy.

History insights begin after Chrome grants the installation permissions. The history index retains hashed URL identifiers and aggregate visit evidence, not history titles or full visit lists. Open-tab views, saved links and Recovery keep the exact URLs they need locally. URL hashes are not anonymous or encrypted.

LOCAL AI IS A COMPLEMENT
Core suggestions work without AI. On supported Chrome devices, optional AI can propose additional relationships, suggest group names and choose clearer wording for measured explanations. Model input is processed on your device. Chrome may need an initial model download; availability varies by browser, device and language. Setup is an explicit action when a download is required. Assistance is enabled by default for fresh workspaces, and you can turn it off. AI never approves a tab action.

HELP SHAPE WHAT COMES NEXT
Tabosmart is early. The intention is to build it with the people using it. A confusing suggestion, a missing connection, the one change that would make your day easier: tell us.

Share an idea, report a problem or vote on what matters:
https://tabosmart.featurebase.app/

The most useful feedback says what you tried, what you expected and what happened. No browsing data is attached automatically. Keep private URLs and sensitive details out of public posts. Honest feedback of every kind is welcome.

Website: https://tabosm.art/
Privacy: https://tabosm.art/privacy/
Private concerns: saulius.developer@gmail.com

## Category and language
Productivity · Workflow & Planning (choose the equivalent dashboard category if labels differ). English.

## Single purpose
Help users organize their current Chrome tabs through locally generated suggestions, reviewed grouping and tab-closing actions, and local saved/recoverable URLs.

## Permission justifications
- tabs: Read current tab titles, URLs, metadata and activity; display reviews; focus, group and close selected tabs; reopen selected saved/recoverable URLs.
- tabGroups: Read current group names/membership and apply user-approved creation or additions to native Chrome groups.
- storage: Persist local settings, observed tab context, saved/recoverable URLs, protections and dismissal choices. No sync storage.
- alarms: Schedule local maintenance and suggestion refreshes, including resumable history processing.
- favicon: Display recognizable website icons through Chrome’s local favicon store in suggestions, reviews, saved links and recovery. No external icon service or host access.
- history: Analyze Chrome-available URL visit frequency and recency locally to help order comparable tab suggestions. Never add or delete browser history. Retained history index consists of hashed exact-URL identifiers and aggregate evidence, without history titles or full visit lists.

## Data disclosures for dashboard completion
The extension accesses web history and user activity for the disclosed tab-management purpose; do not describe it as accessing no data. Processing is local, without browsing-data transmission. Review the current form wording carefully: distinguish data handled on-device from information collected by the developer. Featurebase receives only feedback/account content users deliberately provide on its separate website. No financial, health, authentication, location, communications, or website-content collection by the extension. No remote code; optional inference uses Chrome’s browser-owned model through its built-in API.

## Reviewer instructions
Install in desktop Chrome. Local observations and history analysis begin after the browser’s required permission grant; the installation guide and workspace disclosure explain this. Open several related web pages and duplicate a full URL, then refresh suggestions. Review a group, edit its name and confirm. Review repeated pages, select copies and confirm closure after checking unsaved work. Save selected URLs, reopen them from Saved for later, and inspect Recovery. Verify that pinned/audio/protected tabs stay out of suggestions. Settings provides pause, history off, AI off and erase controls. AI is supplementary; unsupported environments retain core functionality. Use explicit setup if Chrome reports a model download is needed. Feedback opens the public Featurebase portal with no tab or history data attached. No account or payment is needed for the extension.

## Promotional video
https://www.youtube.com/watch?v=pftCdoldqAw

## Assets
Use exactly the five numbered PNGs in marketing/community-launch/store, in numeric order. Each is 1280×800 RGB. Small promotion: 440×280. Marquee: 1400×560. The source interface is genuine; browsing data is fictional. No AI-ready state has been fabricated.

## Publication boundary
Prepared listing, package and website are separate from a submitted or published Chrome Web Store item. Record the actual item ID, submission status and video URL in the launch status file after dashboard verification.


### Website icons

Website favicons are read from Chrome’s local favicon store using the narrow `favicon` permission. This helps identify tabs in suggestions, reviews, saved URLs and recovery. Tabosmart does not contact an external icon service or request access to website content. If Chrome has no icon, a neutral website icon is shown.

### Installation onboarding

A fresh installation opens the bundled `welcome.html` once. It explains the core value, a first useful action, local tab/history observation, optional local AI, URL recovery limits and voluntary feedback. “Open my workspace” opens the extension, and “Settings & privacy” goes directly to settings. The sidebar's “Quick start guide” reopens the page. Updates and browser restarts do not open it automatically.
