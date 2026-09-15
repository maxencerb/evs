# Contributing to evs

Maintainer notes for the `@maxencerb/evs` monorepo: how the repository is laid out, how to run
the toolchain and the test tiers, the design decisions worth knowing before touching the
compiler, and how releases and the docs site ship. User documentation lives at
<https://evs.maxencerb.com>; the [README](packages/evs/README.md) is the package's
presentation page (npm, GitHub) and stays user-facing.

## Repository map

| Path                                                                                  | What                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`packages/evs`](https://github.com/maxencerb/evs/tree/main/packages/evs)             | the published library: builder, IR + interpreter, codegen, assembler, viem glue |
| [`packages/contracts`](https://github.com/maxencerb/evs/tree/main/packages/contracts) | Foundry fixtures: mocks + the solc reference contract for differential tests    |
| [`examples/`](https://github.com/maxencerb/evs/tree/main/examples)                    | runnable example scripts (`bun examples/<name>/index.ts` after `bun run build`) |

## Development

Bun workspaces monorepo driven by [Vite+](https://viteplus.dev) (`vp`): one toolchain for
formatting (oxfmt), linting + type-aware checks (oxlint / tsgolint), tests (vitest 4) and the
task runner. Bun stays the package manager (pinned via `packageManager`); `vp install`
delegates to it. Tests execute on vitest (recorded decision — per-worker anvil via prool and
typecheck tests need it; **never run `bun test` here**).

```sh
curl -fsSL https://vite.plus | bash   # once: the global `vp` CLI
vp install                # workspaces + pinned catalogs (= bun install)
vp run build              # build @maxencerb/evs (tsc → dist/)
vp run test               # unit + type tests (vitest via vp test)
vp run test:integration   # anvil integration tests (requires foundry)
vp check                  # format + lint + type-check (tsgolint) in one pass
vp run check              # vp check + tsc/astro typecheck across workspaces (= CI)
vp fmt                    # oxfmt (writes)
vp run changeset          # add a changeset when a change should ship in the next release
```

Contracts: `cd packages/contracts && forge build / forge test / vp run codegen`.
Releases: see [Releasing](#releasing) below.

## Design notes (the parts worth knowing)

- **Pipeline.** The builder callback runs once and records a value-semantics IR (a flat value
  table, one site id per statement). `validateIr` checks it, `eliminateDeadCode` (the one
  IR-level pass, always on and also exported as `dce`) drops statements whose results nothing
  observable reads — returns, `s.throw` args, sub-calls, loops, read cells and impure `s.fn`
  calls are the roots; a revert that only guarded an unused value is dead work too, like in
  the Solidity optimizer — then codegen lowers each surviving statement through fixed
  memory-slot templates to an assembly stream, the assembler resolves jumps (`PUSH2` fixups),
  and mandatory verifiers run on the output before it is handed to you: a `JUMPDEST` scan, a
  stack-height simulation (the operand stack must be empty at every statement boundary),
  opcode/fork lints, and the EIP-170 size check. The artifact's `ir` stays the recorded IR;
  the differential suite checks `interpret(ir) == interpret(dce(ir)) == bytecode(dce(ir))`.
  An opt-in optimizer (`compile(script, { optimize: true })`) adds two passes: a liveness-based
  frame allocator in codegen (a value takes over the slot of a dead one — args, cells and fn
  params stay dedicated, fn frames stay separate, a value crossing a loop boundary stays live
  for the whole loop) and a peephole pass between codegen and assembly (exported as
  `evsPeephole`) that folds store-then-reload slot pairs, constants and stack identities, never
  crosses a `JUMPDEST` and keeps every source location. Both outputs go through the same
  verifiers. It is off by default so the default bytes stay the plain lowering.
- **Memory model** is Solidity's: `0x00–0x3f` scratch, `0x40` free-memory pointer, `0x60` the
  zero slot (the canonical empty value `try*` failures point at), a **static frame from `0x80`**
  with one 32-byte slot per arg / cell / value, and bump allocations after it (returndata
  snapshots, dynamic values, mutable arrays, the return tuple). Every word in a slot is
  canonical (`uintN` zero-extended, `intN` sign-extended, `bool` ∈ {0,1}, `bytesN` left-aligned);
  dynamic values and tuples are pointers. No slot reuse or fusion by default, on purpose — the
  disassembly stays legible and the stack invariant machine-checkable; `optimize: true` packs
  dead values' slots without changing the templates.
- **Checked arithmetic** follows solc ≥ 0.8 `Panic(uint256)` codes (0x11 overflow, 0x12
  division by zero, 0x21 enum/narrowing, 0x32 out-of-bounds), verified differentially against a
  solc-compiled reference contract.
- **Errors at build time** (`EvsTypeError`, `EvsStagingError`) point at your source line; at run
  time the artifact's `explainRevert(data)` maps revert payloads back to the recording site.
- **The artifact** exposes `runtimeBytecode` and `initBytecode` separately and never a field
  named `code`: viem's deployless `code` parameter needs **init** code (a raw runtime blob fails
  silently), and `toViem()` always hands viem the right flavor for the chosen mode.

## Testing

Three tiers, all run by CI (`ci.yml`):

- **unit** (`src/**/*.test.ts`) — in-process EVM harness (`@ethereumjs/evm`), including the
  anti-miscompilation core: the IR **interpreter vs the compiled bytecode** must agree
  byte-for-byte on returndata and revert payloads for every fixture — for the default output
  and its `optimize: true` twin alike; ABI codecs vs viem's
  `encodeAbiParameters` / `encodeFunctionData`; checked arithmetic vs the solc reference
  contract (`packages/contracts`, forge tests + codegen'd artifacts).
- **types** (`src/**/*.test-d.ts`) — vitest typecheck mode, `expectTypeOf` over the inferred
  ABI / result objects (this is why `viem` is exact-pinned in the catalog).
- **integration** (`test/integration`) — real `eth_call`s against a per-worker
  [anvil](https://getfoundry.sh) spawned by prool, both execution modes; an env-gated
  mainnet-fork suite (`ANVIL_FORK_URL`) covers the flagship scenario.

Tests run on vitest through `vp test` — **never `bun test`** (prool's per-worker anvil and
typecheck tests need vitest).

## Releasing

Versioning is driven by [changesets](https://github.com/changesets/changesets); publishing by
`release.yml` with npm **OIDC trusted publishing** (no token anywhere).

1. A PR that changes the library in a user-visible way adds a changeset (`vp run changeset`).
2. On merge to `main`, `release.yml` opens / refreshes the **"chore(release): version packages"**
   PR: bumps `packages/evs/package.json`, writes the changelog, re-syncs `bun.lock`.
3. Merging that PR publishes: full gate → `scripts/publish.ts` = `bun pm pack` → `publint` →
   `npm publish <tarball> --provenance` → `changeset git-tag`; the action pushes the tag and
   creates the GitHub release. The committed version is always the last released one.

Why `bun pm pack` + `npm publish` and not `bun publish` / `changeset publish`: `bun publish`
has no npm OIDC support (oven-sh/bun#22423, open) and `npm publish <dir>` would ship the
`catalog:` / `workspace:` specs verbatim — `bun pm pack` rewrites them. Prereleases:
`bunx changeset pre enter beta` / `pre exit`; versions with a prerelease component publish
under the `next` dist-tag. One-time setup already done: the npm trusted publisher is bound to
workflow file `release.yml` (do not rename it), and "Allow GitHub Actions to create and
approve pull requests" is enabled in the repo settings.

## Docs site

`apps/docs` is an Astro Starlight site deployed to <https://evs.maxencerb.com> by **Cloudflare
Workers Builds** (not GitHub Actions): root directory `/`, build command
`bun install --frozen-lockfile && bun run build && cd apps/docs && bun run check:snippets && bun run build`,
deploy command `npx wrangler deploy -c apps/docs/wrangler.jsonc` (non-production branches:
`npx wrangler versions upload …` for a preview URL), watch paths `apps/docs/**`,
`packages/evs/src/**`, `bun.lock`. `wrangler.jsonc` sets `workers_dev: false` (the custom domain
is the only production route) and `preview_urls: true` explicitly: wrangler syncs both flags on
every deploy, and with `preview_urls` absent it follows the workers.dev flag, so each merge to
`main` used to switch branch preview URLs back off. `wrangler` is a **root** devDependency on purpose: the deploy
command runs `npx wrangler` from the repo root, and bun's isolated `node_modules` only exposes a
workspace's own binaries there. Every ` ```ts ` fence under `apps/docs/src/content/docs/`
must typecheck standalone against the built package (`bun run check:snippets`); ` ```ts nocheck `
opts out. `astro build` also validates every internal link.
