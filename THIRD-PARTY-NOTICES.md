# Third-party notices

SmartChef is MIT-licensed (see `LICENSE`). It bundles the following components under their own licenses. Full license texts ship inside each package in `node_modules` and in the installers' license files.

## Summary of production dependencies (frontend)
MIT (210), ISC (23), Apache-2.0 (13), BlueOak-1.0.0 (10), OFL-1.1 (2), Hippocratic-2.1 (2), Unlicense (2), BSD-2/3-Clause (3), Zlib (1), 0BSD (1). Regenerate with `npx license-checker --production --summary` in `frontend/`.

## Components that need attribution or care

| Component | License | Notes |
|---|---|---|
| Material Symbols (`material-symbols`) | Apache-2.0 | Icon font, subset committed in `frontend/src/fonts/` |
| Inter, Manrope (`@fontsource/*`) | SIL OFL 1.1 | Fonts |
| Tesseract.js and core | Apache-2.0 | On-device OCR; language data downloaded at runtime |
| pdf.js (`pdfjs-dist`) | Apache-2.0 | PDF import |
| JSZip | MIT or GPL-3.0-or-later | Used under MIT |
| Leaflet (`react-leaflet`, `@react-leaflet/core`) | Hippocratic License 2.1 | Not OSI-approved; see below |
| `world-atlas` | ISC (data: Natural Earth, public domain) | Origin map |
| Map tiles and geocoding | © OpenStreetMap contributors (ODbL) | Tiles and Nominatim are used under the OSM tile and Nominatim usage policies |
| Electron | MIT | Windows builds also ship Chromium's licenses |

## Open point
`react-leaflet` is under the Hippocratic License 2.1, an ethical-source license that is not OSI-approved. F-Droid's inclusion policy requires free-software licenses, so this may need replacing (for example with plain Leaflet, which is BSD-2-Clause) before an official F-Droid submission.
