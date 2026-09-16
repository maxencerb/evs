---
'@maxencerb/evs': patch
---

Fix a module-evaluation crash on runtimes without `import.meta.url` (bundled Cloudflare Workers / workerd, some bundler outputs).

`core/loc.ts` derived its own-frame skip list from `import.meta.url` at import time. Where that value is `undefined`, merely importing `@maxencerb/evs` threw `TypeError: Cannot read properties of undefined (reading 'startsWith')` — uncatchable by the caller, and invisible in dev servers and vitest, which both provide a real `import.meta.url`. The skip list is now resolved lazily on the first frame filter and tolerates a missing self URL: locations degrade (they may point at library internals, or resolve to `<unknown>`) instead of the package failing to load.
