# Bundled reading fonts

Noto Sans SC (weights 400–600) is used for Chinese and Latin UI, body text and numbers.
Noto Serif SC (weight 600) is reserved for the large new-work heading.
Both are official Google Fonts WOFF2 subsets under the included SIL OFL 1.1 licenses.

Sources:
- https://fonts.google.com/noto/specimen/Noto+Sans+SC
- https://fonts.google.com/noto/specimen/Noto+Serif+SC
- https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400..600&display=swap
- https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600&display=swap

`manifest.json` records the exact upstream URL, SHA-256 and byte length of each unmodified subset.
`../fonts.css` retains the upstream unicode ranges; do not trim these to sample text or preload
all subsets. Dynamic customer text must use the same font coverage. esbuild fingerprints and
copies referenced WOFF2 files into `dist/fonts`, shared by the workbench and its sandboxed App.
Fonts never load from Google at runtime and are not installed into the operating system.
The font files total 7,719,672 bytes on disk; per-document loading depends on displayed characters.
