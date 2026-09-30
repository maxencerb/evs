---
'@maxencerb/evs': patch
---

Smaller install: the published package no longer ships `src/` (about 31% of the unpacked size). The JavaScript source maps embed the TypeScript sources (`sourcesContent`), so stack traces and debuggers still resolve to the original code. Declaration maps are no longer emitted; go-to-definition lands on the `.d.ts` files, which keep their JSDoc.
