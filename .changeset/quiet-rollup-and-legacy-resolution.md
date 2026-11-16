---
'@maxencerb/evs': patch
---

Bundling the library with Rollup (so with Vite 5, 6 and 7) no longer prints a warning on every build. A comment in `dist/core/bytes.js` named the pure-call marker in prose, and Rollup reported it as "an annotation that Rollup cannot interpret due to the position of the comment". `@maxencerb/evs/runtime` now has its types under TypeScript's legacy `moduleResolution: "node"` too: that resolution does not read `exports`, so the import was an error there ("Cannot find module '@maxencerb/evs/runtime' or its corresponding type declarations") although a bundler resolved it. The npm page now links to the documentation site and the issue tracker.
