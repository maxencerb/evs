# evs — agent guide

This is a **pnpm workspaces monorepo** (driven by Vite+, scripts on Node) for `@maxencerb/evs`: a TypeScript callback-builder
compiled to EVM runtime bytecode for `eth_call` read scripts, with a literal-typed ABI for
viem inference.

## Documentation

- `packages/evs/README.md` (the root `README.md` is a symlink to it) is the package's
  **presentation page** — what npm and GitHub show: banner, intro, install, quickstart, the two
  execution modes, key concepts, runnable examples. Keep it user-facing; maintainer material
  does not go there.
- `CONTRIBUTING.md` (repo root, not published to npm) is the **maintainer document**: repository
  map, toolchain, test tiers, design notes, release flow, docs-site deploy settings. Keep it
  accurate when you change any of those.
- `apps/docs/src/content/docs/**` — the user documentation site (evs.maxencerb.com). The
  provider support matrix lives in `guides/execution.mdx`.
- The former `docs/design/**` / `docs/research/**` design and research documents were
  **retired on 2026-09-14** (essentials folded into what is now CONTRIBUTING.md, citations swept
  from code comments). Do not add references to them; the code and CONTRIBUTING.md are the
  truth.

## Toolchain: Vite+ (`vp`) + pnpm + Node

The repo is driven by **[Vite+](https://viteplus.dev) 1.0** (`vp`, global CLI; `vite-plus`
exact-pinned in the default catalog of `pnpm-workspace.yaml`): it bundles Vitest 5, oxlint,
oxfmt, oxlint-tsgolint and
tsdown (`vp toolchain` prints the exact versions). It needs Node `^22.18 || ^24.11 || >=26`
(`.node-version` is `24`); the library's own `engines.node` is a separate, public contract.
Upgrade it with `vp upgrade` (global CLI) then `vp migrate --no-interactive` from the repo root
(never `--full`). **pnpm** is the package manager (`packageManager: pnpm@12.x`; `vp install`
delegates to it, `vp env` provisions it) and **Node** runs every TS script directly (type
stripping, Node ≥ 22.18: `node scripts/x.ts`, so erasable syntax only and explicit `.ts`
import specifiers). Bun is not part of the toolchain any more (the library still supports it
as a consumer runtime).
Config lives in the root `vite.config.ts` (`fmt`, `lint`, `test`) — there is no
`.oxlintrc.json` / `.oxfmtrc.json` / `vitest.config.ts`. `packages/evs/vite.config.ts` owns the
test projects (`unit`, `types`, `integration`); the root config re-roots them, so Vitest 5
defaults apply (inline projects inherit the root `test` options, `coverage.include` globs are
relative to `packages/evs`, `VITEST_POOL_ID` starts at 1). The library is built by `vp pack`
(tsdown; the `pack` block in `packages/evs/vite.config.ts`).

## Testing

Tests run on **vitest** through `vp test` (prool per-worker anvil via
`VITEST_POOL_ID`/globalSetup, vitest `typecheck` type tests). Test files import from
`vite-plus/test` (a re-export of vitest), never from `vitest` directly.

- Run them through `vp` / the package scripts, never a bare `vitest`/`node --test`, and from the
  repo root (the root `vite.config.ts` re-roots the `packages/evs` projects):
  - `vp run test` (= `pnpm run test`) — unit + type tests (`vp test run --project unit --project types`)
  - `vp run test:integration` — anvil via prool (foundry must be installed)
  - `vp run test:all` — everything
  - Single file: `vp test run <path> --project unit`

## Layout

- `packages/evs` — the published library. Code in `src/` (`core/ ir/ abi/ builder/ asm/
codegen/ compile.ts viem.ts index.ts`), unit tests `src/**/*.test.ts`, type tests
  `src/**/*.test-d.ts`, integration tests + harnesses in `test/`. Built with `vp pack`
  (tsdown, unbundled ESM + `.d.ts` + JS maps with embedded sources into `dist/`; no
  declaration maps, and `src/` is not published), ESM-only. The committed `version` is the **last released** one —
  only the changesets "Version Packages" PR (titled "chore(release): version packages")
  changes it.
- `packages/contracts` — Foundry package (solc 0.8.30 exact, optimizer off). `forge build`,
  `forge test`; `vp run codegen` emits `as const` TS artifacts to
  `packages/evs/test/generated/` (gitignored; the barrel uses `.ts` specifiers so the examples
  can import it under plain Node). `forge-std` is a git submodule at
  `lib/forge-std` (never an npm dependency).
- `examples/` — runnable example scripts (private workspaces), run with plain
  `node examples/<name>/index.ts`.
- `apps/docs` — Astro Starlight docs site → `evs.maxencerb.com`. Built/deployed by
  **Cloudflare Workers Builds**, NOT ci.yml (dashboard settings are recorded in
  CONTRIBUTING.md's "Docs site" section; its build command uses plain `pnpm …` and must not
  depend on the global `vp` CLI — everything it runs resolves from `node_modules`: the local
  `vite-plus` for `vp pack`, node for the scripts). Deploys stay on wrangler (`apps/docs/wrangler.jsonc`), not the `cf` CLI
  beta: `cf build`/`cf deploy` cannot ship a static Astro build without the Cloudflare adapter
  (details in CONTRIBUTING.md) — do not run `cf migrate` on it.
  Every ` ```ts ` fence in `src/content/docs/` must typecheck standalone (gate:
  `pnpm run check:snippets` in `apps/docs`, needs the library built first); ` ```ts nocheck `
  opts out. Lint ignores `apps/docs/**`; the formatter ignores its `src/content/**` (MDX).
- `.github/assets/` — repository artwork (`evs-banner.svg`, the animated README banner; the
  docs landing hero in `apps/docs/src/components/Hero.astro` redraws the same ridges inline).
- Dependency versions are pinned via **catalogs** in `pnpm-workspace.yaml` (default +
  `testing` + `docs`), which also holds `overrides` (`vite@*` → `@voidzero-dev/vite-plus-core`,
  `vitest@*` → the Vitest `vp` bundles, both required by Vite+ under pnpm), the
  `peerDependencyRules` for the core alias's version, `allowBuilds` (pnpm ≥ 11 fails installs on
  unreviewed dependency build scripts — rule on any new one there) and pnpm's
  `minimumReleaseAge` excludes. `viem` and `vite-plus` are exact-pinned (type tests depend on
  viem patch behavior; `vite-plus`, the `vite` alias and the `vitest` override move together) —
  bump through `vp migrate`, then re-run `vp install`.
  TypeScript is on 6.x: `@astrojs/check` does not accept 7 yet, and TS 6 no longer
  auto-includes `@types/*` (every tsconfig lists its `types`).

## Key commands

- `vp install` — install everything (workspaces + catalogs; = `pnpm install`)
- `vp run build` — build `@maxencerb/evs` (`vp pack`: dist/ js + d.ts + maps)
- `vp check` — format + lint (type-aware) + tsgolint type-check, one pass (use in loops)
- `vp run check` — `vp check` + per-workspace `tsc --noEmit` / `astro check`
- `vp run typecheck` — `tsc --noEmit` / `astro check` across workspaces
- `vp lint` / `vp lint --fix` — oxlint; CI uses `vp run lint:ci` (`--deny-warnings`)
- `vp fmt` (writes!) / `vp fmt --check` — oxfmt
- `vp run changeset` — add a changeset for a user-visible library change
- Contracts: `cd packages/contracts && forge build` / `forge test` / `vp run codegen`
- Built-ins (`vp test`, `vp check`, `vp lint`, `vp fmt`, `vp build`, `vp pack`) always run the
  built-in tool; `vp run <name>` runs the `package.json` script of that name.

## CI / release

- `.github/workflows/ci.yml` — one serial job (`ci`): `voidzero-dev/setup-vp` (node from
  `.node-version`, pnpm from `packageManager`, cached pnpm store, `vp install --frozen-lockfile`) → forge
  build + test + codegen → build library → fmt:check → lint:ci → typecheck → unit+type tests
  → integration (anvil; foundry pinned `FOUNDRY_VERSION`) → publint + attw → informational
  `changeset status`. `fork-tests` runs on `workflow_dispatch` only (`ANVIL_FORK_URL`).
  Every action is pinned to a commit SHA with the tag in a trailing comment — bump both.
- `.github/workflows/release.yml` — **changesets** on every push to `main`: pending
  changesets → opens/updates the "Version Packages" PR (titled "chore(release): version
  packages"); otherwise publishes the not-yet-
  published version via npm **OIDC trusted publishing** (filename must stay `release.yml`).
  Publishing is `changeset publish` → `pnpm publish` (pnpm ≥ 11 publishes natively, does the
  OIDC exchange itself and rewrites `catalog:`/`workspace:` specs) → git tag via
  `CHANGESETS_OUTPUT`, then a step fails the job if npm shows no provenance attestation. pnpm
  attaches provenance automatically under OIDC for a public repo + public package and ignores
  `publishConfig.provenance` (kept `true` for npm); if the repo ever goes private, set it to
  false and drop the provenance check step.
- Docs site CI/deploy is owned by Cloudflare Workers Builds (see Layout), not GitHub Actions.
