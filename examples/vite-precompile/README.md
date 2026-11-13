# vite-precompile — scripts compiled at build time

A minimal Vite app that reads a Uniswap V3 pool's two tokens and their symbols in **one**
`eth_call`, with the script compiled **during the build** by
[`@maxencerb/vite-plugin-evs`](../../packages/vite-plugin-evs).

- `src/pool.evs.ts` is a build-time module: the plugin runs it in Node and replaces it with the
  script's bytecode and ABI. It ends in `.compile().toPrecompiled()`.
- `src/main.ts` imports the script like any module and spreads `poolTokens.toViem()` into viem's
  `readContract`. Its helpers come from `@maxencerb/evs/runtime`, the entry without the compiler.
- `vite.config.ts` adds the plugin. That is the whole setup.

The bundle holds the script and a few kilobytes of runtime, not the compiler. What
`explainRevert()` needs is in two chunks the page loads only when it calls it.

```sh
vp install && vp run build              # once, from the repo root: builds the library and the plugin
cd examples/vite-precompile
vp run dev                              # the dev server
vp run build                            # the production build, into dist/
```

The build prints `precompiled 1 script from 1 file`. Import `evscript` in `src/main.ts` and build
again to see the warning about the compiler in the bundle.

The page calls a public mainnet RPC through viem's default transport: pass a URL of your own to
`http()` if it is rate-limited.

In an app of your own the scripts are plain Vite: `vite` and `vite build`. This repository runs
them through [Vite+](https://viteplus.dev) (`vp dev`, `vp build`).
