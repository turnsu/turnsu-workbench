# Bundled UI fonts

Inter 400/500/600 is the shared UI and heading family;
IBM Plex Mono 400 is the code family. These unmodified binaries and their SIL
OFL notices are bundled locally. Source URLs, sizes and hashes are recorded in
`manifest.json`. No runtime Google request or system font installation occurs.

Chinese uses PingFang SC where available, with Noto Sans SC subsets as the
packaged fallback. Titles and brand text use the same sans-serif stack.

Sources:
- https://fonts.google.com/noto/specimen/Noto+Sans+SC
- https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400..600&display=swap

`manifest.json` records the exact upstream URL, SHA-256 and byte length of each unmodified subset.
`../fonts.css` retains the upstream unicode ranges; do not trim these to sample text or preload
all subsets. Dynamic customer text must use the same font coverage. esbuild fingerprints and
copies referenced WOFF2 files into `dist/fonts`, shared by the workbench and its sandboxed App.
Fonts never load from Google at runtime and are not installed into the operating system.
Per-document loading depends on displayed characters. Disk size is not a memory measurement.
