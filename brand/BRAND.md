# palm brand

**Name.** Always lowercase `palm`, never "PaLM" or "Palm". Pair it with the descriptor
**"package manager for agent resources"**; tagline: "One setup for every coding agent."

## Mark

A fan-palm frond: identical leaflets spreading from one stem (one origin, every harness).
Built on a 64-unit grid by `tools/build.py`, whose opening numbers generate every asset.

- **Construction**: every ray grows from the pivot (32, 35). The **5 leaflets** sit at 0°, ±32°, ±64°: tapered bars,
  r1.25 at the pivot to r3.5 at the tip, tip centre 25 units out. The **stem** is at 180°: a straight bar r3.5,
  21 long. One terminal radius (3.5) on all six ends.
- **Outline**: the exact union of the bars (sharp notches, one closed path, fill only, 2-decimal coordinates).
- **Balance**: bbox 6.03–57.97 × 6.5–59.5, centred horizontally. It sits 1 unit low because the frond carries the weight (centroid y 27.8).
- **Why 5**: 7-leaflet cuts (`candidates/refined-2`, `-3`) blur into a blob at 16 px; see `candidates/refined-preview.png`.
- **Favicon crop**: `favicon.svg` uses viewBox `4 5 56 56`, so the stem lands on whole pixels at 16, 32 and 48 px.

## Colour

| Token | Hex | Use | Contrast |
|---|---|---|---|
| frond | `#12876A` | mark on light, buttons, large text | 4.47:1 on paper (graphics, large text; small green text uses `#0F7A5F`, 5.29:1) |
| mint | `#3DD6A3` | mark and accents on dark | 8.86:1 on ink |
| ink | `#10231E` | text, dark backgrounds | 16.39:1 on paper |
| paper | `#FFFFFF` | light backgrounds, text on ink | |
| grey | 50 `#F3F6F5` · 100 `#E2E8E6` · 300 `#B3C1BD` · 500 `#63746F` · 700 `#3A4B46` · 900 `#1B2E29` | borders, secondary text, code panels | 500 on paper 4.93:1; 300 on ink 8.80:1 |

## Type

- **Text**: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. **Code**: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
- **Wordmark**: JetBrains Mono SemiBold, outlined to paths, so no font is needed. Its stems match the mark's bars; Bold is heavier.

## Lockups, sizes, clear space

- **Horizontal**: the stem end sits on the baseline and the outer leaflet tips touch the x-height. The round centre tip
  overshoots the "l" by 2.5%. The gap to the "p" is one leaflet width.
- **Stacked**: the mark is twice the cap height, centred over the text; the gap is one leaflet width at that scale.
- **Minimum sizes**: mark 16 px (use `favicon.svg` below 24 px); horizontal lockup 18 px tall.
- **Clear space**: 25% of the mark's height around the mark; the x-height of "palm" around a lockup.

## Do / don't

- **Do** use the files as supplied: frond on light, mint on dark, or one flat colour (`mark.svg` is `currentColor`). **Don't** add gradients, shadows or glows, or make an outline (stroked) version. Don't rotate, tilt, flip, stretch or crop.
- **Don't** change the leaflet count, colour leaflets separately, or point the tips (a pointed seven-leaf frond reads as cannabis).
- **Don't** put frond on ink (3.67:1, dull); use mint. Don't reset "palm" in another font or case.

## Where each asset goes

| File | Use |
|---|---|
| `wordmark.svg`, `wordmark-dark.svg` | README header via `<picture>` with `media="(prefers-color-scheme: dark)"`; docs logo (Starlight `logo.light` / `logo.dark`, `replacesTitle`). npm shows the README, so use absolute https image URLs |
| `mark.svg`, `mark-green.svg`, `mark-dark.svg` | inline UI (`currentColor`), docs pages, slides |
| `wordmark-stacked*.svg` | square spaces: docs hero, slides, stickers |
| `favicon.svg`, `favicon.ico`, `favicon-{16,32,48}.png` | docs favicon: the SVG first (it follows dark mode), ico and PNGs as fallbacks |
| `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png` | iOS home screen, web manifest (maskable-safe), GitHub org avatar |
| `social-card.png` (source `social-card.html`) | GitHub social preview, docs `og:image`, link unfurls |

**Rebuild**: `python3 brand/tools/build.py`. It needs Pillow, Google Chrome, and JetBrains Mono installed for re-outlining.
