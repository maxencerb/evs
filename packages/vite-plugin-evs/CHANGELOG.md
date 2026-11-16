# @maxencerb/vite-plugin-evs

## 0.1.1

### Patch Changes

- [#173](https://github.com/maxencerb/evs/pull/173) [`4fe20dd`](https://github.com/maxencerb/evs/commit/4fe20dd50d29d468f1fa8c0e9d18063a4a074ef0) Thanks [@maxencerb](https://github.com/maxencerb)! - Narrow which modules the plugin runs at build time, and keep its output fresh under Vitest.
  
  - A module id with a query or a hash is never a build-time module. The dev server used to run a file in Node when the query of a request ended in `.evs.ts`, `.evs.mts`, `.evs.js` or `.evs.mjs`, whatever the file was. Such a request is now left to Vite, like `?raw` already was. The virtual module of another plugin is left alone too.
  - A file inside `node_modules` is never a build-time module. `vite build` used to run a dependency's `*.evs.js` file in Node, with the environment of the build, while the dev server served the same file as source. Both now treat it like any other module of a dependency: it is bundled as written and compiles its scripts in the browser, and the compiler check reports it. A package of your workspace, linked into `node_modules`, is still precompiled. If you publish a library, publish precompiled output instead of `*.evs.js` files: the plugin reference shows how.
  - Under Vitest, which reads the app's Vite config and so runs the plugin, a build-time module is compiled on every run. With Vitest's module cache on disk (`fsModuleCache`, on by default since Vitest 5.1), a test kept the bytecode of an earlier run after an edit to a file the module imports, and `explainRevert()` and `debug()` rejected on every run after the first with "the debug data a page asked for belongs to a version of a \*.evs.ts module that is gone". The plugin now keeps its output out of that cache.
  
  The docs say which files are build-time modules, and that the dev server runs one whenever its URL is requested, imported or not.

- [#172](https://github.com/maxencerb/evs/pull/172) [`363b05e`](https://github.com/maxencerb/evs/commit/363b05ea3e3385ef5fd9518191e0471963636104) Thanks [@maxencerb](https://github.com/maxencerb)! - `engines.node` is now `^20.19.0 || >=22.12.0`, the Node versions Vite 8 itself runs on: the range used to admit Node 21 and 22.0 to 22.11, where Vite refuses to start. The npm page now links to the plugin's documentation and the issue tracker, and the package has keywords.
- Updated dependencies [[`e4e2ba6`](https://github.com/maxencerb/evs/commit/e4e2ba69e25db866c9b151f831da34ab631952d8), [`363b05e`](https://github.com/maxencerb/evs/commit/363b05ea3e3385ef5fd9518191e0471963636104), [`0add65b`](https://github.com/maxencerb/evs/commit/0add65bfc82f776b0fe8403e1a32a1439070aead)]:
  - @maxencerb/evs@0.5.1

## 0.1.0

### Minor Changes

- [#166](https://github.com/maxencerb/evs/pull/166) [`81a3ebe`](https://github.com/maxencerb/evs/commit/81a3ebefef84b842b02cd791f522998b05aa9c98) Thanks [@maxencerb](https://github.com/maxencerb)! - First release of the Vite plugin. It runs every `*.evs.ts` module in Node during the build and replaces it with the precompiled scripts it exports, so the client bundle holds the bytecode and the `@maxencerb/evs/runtime` entry instead of the compiler. It warns when the compiler still ends up in the client bundle.

### Patch Changes

- Updated dependencies [[`81a3ebe`](https://github.com/maxencerb/evs/commit/81a3ebefef84b842b02cd791f522998b05aa9c98), [`81a3ebe`](https://github.com/maxencerb/evs/commit/81a3ebefef84b842b02cd791f522998b05aa9c98)]:
  - @maxencerb/evs@0.5.0
