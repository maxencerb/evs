# Contributing to evs

Maintainer notes for the `@maxencerb/evs` monorepo: how the repository is laid out, how to run
the toolchain and the test tiers, the design decisions worth knowing before touching the
compiler, and how releases and the docs site ship. User documentation lives at
<https://evs.maxencerb.com>; the [README](packages/evs/README.md) is the package's
presentation page (npm, GitHub) and stays user-facing.

## Repository map

| Path                                                                                  | What                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`packages/evs`](https://github.com/maxencerb/evs/tree/main/packages/evs)             | the published library: builder, IR + interpreter, codegen, assembler, viem glue                     |
| [`packages/contracts`](https://github.com/maxencerb/evs/tree/main/packages/contracts) | Foundry fixtures: mocks + the solc reference contract for differential tests                        |
| [`examples/`](https://github.com/maxencerb/evs/tree/main/examples)                    | runnable example scripts (`node examples/<name>/index.ts` after `vp run build` + contracts codegen) |

## Development

pnpm workspaces monorepo driven by [Vite+](https://viteplus.dev) (`vp`): one toolchain for
formatting (oxfmt), linting + type-aware checks (oxlint / tsgolint), tests (Vitest 5), the
library build (tsdown via `vp pack`) and the task runner. Vite+ 1.0 needs Node
`^22.18 || ^24.11 || >=26` (`.node-version` pins the 24 line); upgrade with `vp upgrade` then
`vp migrate --no-interactive` from the repo root. **pnpm** is the package manager
(`packageManager: pnpm@12.x`; `vp install` delegates to it and `vp env` provisions it) and
**Node** runs every TypeScript script directly through type stripping (`node scripts/x.ts`:
erasable syntax only, explicit `.ts` import specifiers).

```sh
curl -fsSL https://vite.plus | bash   # once: the global `vp` CLI (provisions Node + pnpm)
vp install                # workspaces + pinned catalogs (= pnpm install)
vp run build              # build @maxencerb/evs (vp pack → dist/, see below)
vp run test               # unit + type tests (vitest via vp test)
vp run test:integration   # anvil integration tests (requires foundry)
vp check                  # format + lint + type-check (tsgolint) in one pass
vp run check              # vp check + tsc/astro typecheck across workspaces (= CI)
vp fmt                    # oxfmt (writes)
vp run changeset          # add a changeset when a change should ship in the next release
```

Without the global CLI, `pnpm install` then `pnpm run <script>` works the same (the scripts call
the project-local `vp` from `vite-plus`).

Contracts: `cd packages/contracts && forge build / forge test / vp run codegen`.

### Workspace configuration (`pnpm-workspace.yaml`)

- **Catalogs**: the default catalog holds the shared runtime + toolchain pins (`viem` and
  `vite-plus` exact, the `vite` → `@voidzero-dev/vite-plus-core` alias), `testing` and `docs`
  the rest. setup-vp reads the `vite-plus` entry to install CI's `vp`.
- **overrides** `vite@*` / `vitest@*`: required by Vite+ under pnpm so every package shares the
  Vite+ core and the Vitest `vp test` bundles; bump them together with `vite-plus`.
  `peerDependencyRules.allowedVersions.vite` accepts the core alias's own version (1.0.0) for
  `vite` peers such as vitest's and astro's `vitefu`.
- **allowBuilds**: pnpm ≥ 11 fails an install on any dependency build script nobody has ruled
  on (`strictDepBuilds`). esbuild and workerd are denied — their postinstall only re-checks the
  prebuilt binary their JS shim finds on its own. Rule on any new one there.
- **minimumReleaseAge** (pnpm default: one day) refuses too-fresh versions at resolution time;
  pnpm itself writes exact-version `minimumReleaseAgeExclude` entries when a pin is newer, and
  prunes them once the lockfile no longer needs them.
- No hoisting workarounds are needed: the Cloudflare tooling (`cf`, `wrangler`) is a devDependency
  of `apps/docs`, whose package scripts are the deploy commands (pnpm links a workspace's
  binaries into its own `node_modules` only). The docs app's former direct `satteri` dependency
  (a bun resolution workaround) is gone.

### Library build (`vp pack`)

`packages/evs` builds with `vp pack` (tsdown, the `pack` block in its `vite.config.ts`): entry
`src/index.ts`, unbundled ESM (one `dist/` module per reachable source file, `.js` / `.d.ts`
names so `exports` / `main` / `types` are unchanged), JS source maps and declaration maps
(`files` ships `src/` so they resolve). No tsdown compatibility settings are set:
`deps.resolveDepSubpath` does not matter (every external is imported by its bare name) and
attw runs in CI with the `esm-only` profile, not inside the build. Differences from the former
`tsc -p tsconfig.build.json` emit: declarations are generated only for modules reachable from
the public entry (internal-only modules have no `.d.ts`, and per-module declarations drop
exports that are not part of the public graph — `exports` never allowed deep imports anyway),
`dist/index.js` (a pure re-export) has no source map, and rolldown-plugin-dts keeps the
`declare module '../core/types.js'` augmentation in `builder/script.d.ts` as written (valid
because the layout is unbundled; tsdown logs a note about it). The public surface —
137 exports of `dist/index.d.ts` — is identical by name, kind and type. Consumers are checked by
publint, attw, the docs snippet gate, the playground payload and the examples; the type tests
(`*.test-d.ts`) run against `src/`.

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
- **Checked arithmetic** follows solc ≥ 0.8 `Panic(uint256)` codes (0x11 overflow and checked
  narrowing, 0x12 division by zero, 0x32 out-of-bounds, 0x41 over-allocation), verified
  differentially against a solc-compiled reference contract.
- **Errors at build time** (`EvsTypeError`, `EvsStagingError`) point at your source line; at run
  time the artifact's `explainRevert(data)` maps revert payloads back to the recording site.
- **The artifact** exposes `runtimeBytecode` and `initBytecode` separately and never a field
  named `code`: viem's deployless `code` parameter needs **init** code (a raw runtime blob fails
  silently), and `toViem()` always hands viem the right flavor for the chosen mode.

## Testing

Three tiers, all run by CI (`ci.yml`):

- **unit** (`src/**/*.test.ts`, `test/harness/**/*.test.ts`) — in-process EVM harness
  (`@ethereumjs/evm`), including the anti-miscompilation core: the IR **interpreter vs the
  compiled bytecode** must agree byte-for-byte on returndata and revert payloads for every
  fixture — for the default output and its `optimize: true` twin alike; ABI codecs vs viem's
  `encodeAbiParameters` / `encodeFunctionData`.
- **types** (`src/**/*.test-d.ts`) — vitest typecheck mode, `expectTypeOf` over the inferred
  ABI / result objects (this is why `viem` is exact-pinned in the catalog).
- **integration** (`test/integration`) — real `eth_call`s against a per-worker
  [anvil](https://getfoundry.sh) spawned by prool, both execution modes, including checked
  arithmetic vs the solc 0.8.30 `EvsReference` contract (codegen'd from `packages/contracts`,
  whose own forge tests run in CI's contracts step); an env-gated
  mainnet-fork suite (`ANVIL_FORK_URL`) covers the flagship scenario.

Tests run on vitest through `vp test` (prool's per-worker anvil and typecheck tests need
vitest); test files import from `vite-plus/test`.

## Releasing

Versioning is driven by [changesets](https://github.com/changesets/changesets); publishing by
`release.yml` with npm **OIDC trusted publishing** (no token anywhere).

1. A PR that changes the library in a user-visible way adds a changeset (`vp run changeset`).
2. On merge to `main`, `release.yml` opens / refreshes the **"chore(release): version packages"**
   PR: bumps `packages/evs/package.json` and writes the changelog (`CHANGELOG.md` is excluded
   from the formatter, since changesets writes it in its own style). No lockfile resync: pnpm
   links workspace packages without recording their version.
3. Merging that PR publishes: full gate (+ publint / attw) → `changeset publish` → a check that
   npm shows a provenance attestation for the new version. `changeset publish` (changesets
   CLI 3) detects pnpm and runs `pnpm publish --access public --tag <tag> --no-git-checks` for
   each package whose version is not on npm yet (`prepublishOnly` rebuilds `dist/`), then
   creates the `@maxencerb/evs@X.Y.Z` tag and reports it through `CHANGESETS_OUTPUT`; the action
   pushes the tag and creates the GitHub release. The committed version is always the last
   released one.

Why this works without a token or the npm CLI: since pnpm 11, `pnpm publish` is native (it no
longer shells out to `npm publish`) and implements npm trusted publishing itself — it reads
`ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` (the job's `id-token: write`), exchanges the GitHub
OIDC token for a short-lived npm token, and signs sigstore provenance automatically when the
repository and the package are both public. It rewrites `catalog:` / `workspace:` specs in the
packed manifest (the reason the bun era needed `bun pm pack` + `npm publish`). pnpm does not
read `publishConfig.provenance` (npm does; it stays `true` for any manual `npm publish`), and a
provenance it cannot attach is only a warning — hence the attestation check after publishing.
Only the first real release can prove the OIDC exchange + provenance end to end.

Prereleases: `vp exec changeset pre enter beta` / `pre exit` (pre-mode releases publish under
the pre tag). One-time setup already done: the npm trusted publisher is bound to workflow file
`release.yml` (do not rename it), and "Allow GitHub Actions to create and approve pull
requests" is enabled in the repo settings.

## Docs site

`apps/docs` is an Astro Starlight site deployed to <https://evs.maxencerb.com> by **Cloudflare
Workers Builds** (not GitHub Actions) with Cloudflare's **`cf` CLI**. Worker `evs`, two build
triggers ("Deploy default branch" for `main`, "Deploy non-production branches" for everything
else; inspect or change them with `cf builds triggers list|update` or in the dashboard under
Workers → `evs` → Settings → Build):

- root directory `/`, path filter `*` (every push builds)
- no build variables: the image detects Node from `.node-version` (24) and pnpm from
  `packageManager`, and runs `pnpm install --frozen-lockfile` itself before the build command
- build command (both triggers)
  `pnpm --filter @maxencerb/evs run build && pnpm --filter @maxencerb/evs-docs run check:snippets && pnpm --filter @maxencerb/evs-docs run build`
- deploy command `pnpm --filter @maxencerb/evs-docs run deploy` (non-production branches:
  `pnpm --filter @maxencerb/evs-docs run deploy:preview`)

The build does not need the global `vp` or `cf` CLIs: everything resolves from `node_modules` —
`vp pack` is the project-local binary of `vite-plus`, the playground bundles use Rolldown through
`vite/rolldown` (the Vite+ core), the docs scripts run on plain Node, and `cf` (exact-pinned in
the `docs` catalog while it is in beta) plus `wrangler` are `apps/docs` devDependencies that its
package scripts call. Every ` ```ts ` fence under `apps/docs/src/content/docs/` must typecheck
standalone against the built package (`pnpm run check:snippets` in `apps/docs`);
` ```ts nocheck ` opts out. `astro build` also validates every internal link.

Worker configuration:

- `apps/docs/cloudflare.config.ts` is the Worker's single source of truth: an **assets-only**
  Worker (no script) with `notFoundHandling: "404-page"` (unknown paths get `404.html` with a
  404 status; trailing-slash redirects are the platform default `auto-trailing-slash`), the
  custom domain `evs.maxencerb.com` as the only production route (`workersDev: false`), and
  `previewUrls: true` set explicitly — every deploy syncs both flags, and with `previewUrls`
  unset it follows `workersDev`, so each merge to `main` used to switch preview URLs back off.
  It is a function of the build context: the custom domain is production-only, because Worker
  Previews reject `domains`.
- `apps/docs/wrangler.config.ts` only names the static-assets directory (`./dist`):
  `cloudflare.config.ts` has no field for it, and `cf` delegates the Build Output step of a
  project without a Vite plugin to wrangler.

How a deploy runs: `pnpm run build` writes the static site to `apps/docs/dist` exactly as before.
`pnpm run deploy` then runs `cf-wrangler build` (wrangler's `cf` delegate, the same step
`cf build` runs for a wrangler-bundled project) to package `dist/` plus the config as Build
Output under `apps/docs/.cloudflare/output/v0/` (gitignored), and `cf deploy --prebuilt`
uploads it and promotes it to production. `pnpm run deploy:preview` builds the Build Output
with `CLOUDFLARE_PREVIEW_BUILD=true` (a Preview build, which `cf deploy` refuses) and runs
`cf previews deploy --prebuilt`: a **Worker Preview** named after the branch
(`WORKERS_CI_BRANCH` in Workers Builds), served at
`<branch-slug>-evs.<account-subdomain>.workers.dev` plus a per-deployment URL, and never
production traffic. The account puts Cloudflare Access in front of these `workers.dev` preview
hostnames, so opening one needs a login.

Why not plain `cf build` / `cf deploy`: in `cf@1.0.0-beta.6` both run the framework's own
command for a detected Astro project (a bare `astro build`, skipping `gen:playground`) and
there is no build-command setting; the `@astrojs/cloudflare` adapter (14.3) cannot produce Build
Output under the new config (it passes `config` to the Cloudflare Vite plugin, which rejects it
alongside `cloudflare.config.ts`) and would turn the site into a Worker with KV sessions and an
Images binding. Revisit when `cf build` can run a project's own build script, then fold
`cf-wrangler build` + `cf deploy --prebuilt` into plain `cf deploy`.
