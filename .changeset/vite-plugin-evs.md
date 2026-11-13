---
'@maxencerb/vite-plugin-evs': minor
---

First release of the Vite plugin. It runs every `*.evs.ts` module in Node during the build and replaces it with the precompiled scripts it exports, so the client bundle holds the bytecode and the `@maxencerb/evs/runtime` entry instead of the compiler. It warns when the compiler still ends up in the client bundle.
