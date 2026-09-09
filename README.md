# Tabosmart

**Less tab clutter. More headspace.** Tabosmart brings related work together, helps you review repeat pages, and saves links for later. You review every action before tabs are grouped or closed.

[Website](https://tabosm.art/) · [Video](https://youtu.be/pftCdoldqAw) · [Share an idea or problem](https://tabosmart.featurebase.app/) · [Privacy](docs/PRIVACY.md)

## Try the extension

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this project's `extension/` folder.
3. The installation guide opens once. Choose **Open my workspace**, or use the Tabosmart toolbar icon.
4. Review a suggestion, check its explanation and choose which tabs belong. Nothing groups or closes without your approval.

The current source version is **1.5.0**. Existing installations can reload Tabosmart at `chrome://extensions`. Updates do not automatically open the installation guide; it stays available through **Quick start guide** in the workspace.

## What it does

- Lists, counts, searches and switches to all tabs in regular Chrome windows, including extension pages, local files, browser pages and Tabosmart itself. Incognito tabs are excluded. Non-web pages are labelled "Switch only"; suggestions, protection, saving and closing remain limited to HTTP(S) pages, including localhost sites.
- Filters suggestions with All, Groups, Repeats and Older tabs. The summary counts select the matching filter; filter counts refer to suggestions, while the summary also shows affected duplicate and older tabs.
- Suggests groups using titles, specific URL context, observed browsing patterns and grouping choices you confirm.
- Explains each suggestion and lets you review its name and members.
- Reviews exact repeated URLs and older tabs, with protections for pinned, audible, protected and Incognito tabs.
- Saves URLs to an extension-local shelf, separate from Chrome bookmarks.
- Records recovery URLs before approved closes. Recovery restores URLs, not unsaved forms or edits.
- Uses Chrome's local favicon endpoint for recognizable website icons, without contacting external icon services.
- Invites specific feedback through Featurebase, with links and QR codes in the extension and launch materials.

## Local processing and optional AI

Browsing data is processed locally in the Chrome profile. Tabosmart does not read page bodies or send browsing data to a server. Local records are not encrypted or anonymous. History contributes bounded, hashed URL identifiers and aggregate visit evidence; separately stored context can contain exact URLs. See [retention and controls](docs/PRIVACY.md).

Fresh installations begin local observation after Chrome grants the required permissions. You can pause observation, disable history or local AI, protect tabs, and erase extension data in Settings.

Optional on-device AI adds relationship and group-name suggestions on supported Chrome devices. Chrome may need to download and prepare a model. Metadata-based suggestions continue while AI is unavailable, preparing or switched off. Browser, device and language support vary; [AI behavior and limits](docs/AI.md) explains the boundaries.

Required permissions: `tabs`, `tabGroups`, `storage`, `alarms`, `history`, and the narrow `favicon` permission. There are no host permissions, analytics, remote AI fallback or browsing-data upload paths. Voluntary feedback opens an external service; no browsing details are attached automatically.

## Development

Use Node.js 22.13 or later.

```sh
npm ci
npm test
npm run check
npm run pack
```

The extension has no runtime dependencies. The Chrome package is generated at `dist/tabosmart-1.5.0-chrome.zip`. For isolated Chromium integration and accessibility checks:

```sh
npx playwright install chromium
npm run qa:browser
npm run qa:workspace
```

The website lives in `website/`:

```sh
npm ci --prefix website
npm run build --prefix website
```

The source includes the five Store screenshots, both promotional tiles, final video, captions and asset scripts. Private narration reference audio and generated local QA records are excluded. [Artifact index](ARTIFACTS.md) lists the deliverables. [Grouping design](docs/MULTILINGUAL-GROUPING.md) documents the matcher and its limits.

## Release status

The website and feedback board are public. Chrome Web Store submission is being prepared; a local package is not a published Store release. See [listing copy and reviewer instructions](docs/STORE-LISTING.md).
