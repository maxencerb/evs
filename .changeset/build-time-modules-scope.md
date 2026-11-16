---
'@maxencerb/vite-plugin-evs': patch
---

Narrow which modules the plugin runs at build time, and keep its output fresh under Vitest.

- A module id with a query or a hash is never a build-time module. The dev server used to run a file in Node when the query of a request ended in `.evs.ts`, `.evs.mts`, `.evs.js` or `.evs.mjs`, whatever the file was. Such a request is now left to Vite, like `?raw` already was. The virtual module of another plugin is left alone too.
- A file inside `node_modules` is never a build-time module. `vite build` used to run a dependency's `*.evs.js` file in Node, with the environment of the build, while the dev server served the same file as source. Both now treat it like any other module of a dependency: it is bundled as written and compiles its scripts in the browser, and the compiler check reports it. A package of your workspace, linked into `node_modules`, is still precompiled. If you publish a library, publish precompiled output instead of `*.evs.js` files: the plugin reference shows how.
- Under Vitest, which reads the app's Vite config and so runs the plugin, a build-time module is compiled on every run. With Vitest's module cache on disk (`fsModuleCache`, on by default since Vitest 5.1), a test kept the bytecode of an earlier run after an edit to a file the module imports, and `explainRevert()` and `debug()` rejected on every run after the first with "the debug data a page asked for belongs to a version of a \*.evs.ts module that is gone". The plugin now keeps its output out of that cache.

The docs say which files are build-time modules, and that the dev server runs one whenever its URL is requested, imported or not.
