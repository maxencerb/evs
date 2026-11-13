# @maxencerb/vite-plugin-evs

## 0.1.0

### Minor Changes

- [#166](https://github.com/maxencerb/evs/pull/166) [`81a3ebe`](https://github.com/maxencerb/evs/commit/81a3ebefef84b842b02cd791f522998b05aa9c98) Thanks [@maxencerb](https://github.com/maxencerb)! - First release of the Vite plugin. It runs every `*.evs.ts` module in Node during the build and replaces it with the precompiled scripts it exports, so the client bundle holds the bytecode and the `@maxencerb/evs/runtime` entry instead of the compiler. It warns when the compiler still ends up in the client bundle.

### Patch Changes

- Updated dependencies [[`81a3ebe`](https://github.com/maxencerb/evs/commit/81a3ebefef84b842b02cd791f522998b05aa9c98), [`81a3ebe`](https://github.com/maxencerb/evs/commit/81a3ebefef84b842b02cd791f522998b05aa9c98)]:
  - @maxencerb/evs@0.5.0
