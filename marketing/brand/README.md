# Tabosmart identity

The brand is **Tabosmart**, one word. The mark brings two browser-tab shapes into a compact T. It is intentionally simple enough for the browser toolbar.

| Role | Value |
| --- | --- |
| Deep green, primary ink and actions | `#263F36` |
| Warm paper, page canvas | `#F5F5EF` |
| Near white, cards | `#FEFEFB` |
| Mint, secondary mark and quiet accent | `#AFC9B5` |
| Sage, inverse secondary mark | `#82A48D` |
| Typography | Native system sans serif; compact medium-weight headings and relaxed body text |

Use generous spacing, thin quiet borders, and one clear action at a time. Keep status labels readable in words; color is additional information. Use the deep green mark on light backgrounds and the inverse mark on dark promotional surfaces. Do not stretch, rotate, or add effects to the mark. Keep a clear area of at least one quarter of its visible width around standalone use. Avoid em dashes in copy.

- `mark.svg`: editable SVG master, with 96 × 96 artwork in a 128 × 128 canvas.
- `mark-inverse.svg`: inverse variation for dark surfaces.
- `wordmark.svg`, `wordmark.png`: horizontal brand lockup; SVG text uses system fonts.
- `mark-512.png`: large transparent raster export.
- `store-icon-128.png`: Chrome Web Store upload icon.
- `../../extension/icons/icon-{16,32,48,128}.png`: packaged extension icons.
- `icon-verification.json`: recorded raster dimensions, alpha channels, and artwork bounds.
- `icon-proof.png`: visual proof at actual icon sizes on warm paper and a dark surface.

Run `node marketing/brand/render-icons.mjs` from the project root to rebuild raster assets with the project development dependency `sharp`. The 128px export has the [official transparent margin](https://developer.chrome.com/docs/webstore/images#extension-icon); the smaller toolbar exports use a slightly tighter crop for legibility.
