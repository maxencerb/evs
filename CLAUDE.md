# evs — agent guide

This is a **Bun workspaces monorepo** for `@maxencerb/evs`: a TypeScript callback-builder
compiled to EVM runtime bytecode for `eth_call` read scripts, with a literal-typed ABI for
viem inference.

## Documentation

- `packages/evs/README.md` (the root `README.md` is a symlink to it) is the single project
  document: user-facing intro + quickstart, provider support, design notes, testing tiers,
  release flow, docs-site deploy settings. Keep it accurate when you change any of those.
- `apps/docs/src/content/docs/**` — the user documentation site (evs.maxencerb.com).
- The former `docs/design/**` / `docs/research/**` design and research documents were
  **retired on 2026-09-14** (essentials folded into the README, citations swept from code
  comments). Do not add references to them; the code and the README are the truth.

## Toolchain: Vite+ (`vp`) on top of Bun

The repo is driven by **[Vite+](https://viteplus.dev)** (`vp`, global CLI; `vite-plus` pinned in
`catalog:testing`): it bundles vitest 4.1, oxlint, oxfmt and oxlint-tsgolint. Bun stays the
**package manager / script runner** (`packageManager` pin; `vp install` delegates to bun).
Config lives in the root `vite.config.ts` (`fmt`, `lint`, `test`) — there is no
`.oxlintrc.json` / `.oxfmtrc.json` / `vitest.config.ts`. `packages/evs/vite.config.ts` owns the
test projects (`unit`, `types`, `integration`).

## IMPORTANT deviation from the default Bun template: testing

Tests run on **vitest** (via `vp test`), NOT Bun's test runner — we need prool per-worker anvil
via `VITEST_POOL_ID`/globalSetup and vitest `typecheck` type tests. Test files import from
`vite-plus/test` (a re-export of vitest).

- **NEVER run `bun test`** — it invokes Bun's Jest-like runner against vitest files and will
  misbehave. Always go through `vp` / package scripts:
  - `vp run test` (= `bun run test`) — unit + type tests (`vp test run --project unit --project types`)
  - `vp run test:integration` — anvil via prool (foundry must be installed)
  - `vp run test:all` — everything
  - Single file: `vp test run <path> --project unit`

## Layout

- `packages/evs` — the published library. Code in `src/` (`core/ ir/ abi/ builder/ asm/
codegen/ compile.ts viem.ts index.ts`), unit tests `src/**/*.test.ts`, type tests
  `src/**/*.test-d.ts`, integration tests + harnesses in `test/`. Built with `tsc`
  (`tsconfig.build.json`), ESM-only. The committed `version` is the **last released** one —
  only the changesets "Version Packages" PR changes it.
- `packages/contracts` — Foundry package (solc 0.8.30 exact, optimizer off). `forge build`,
  `forge test`; `vp run codegen` emits `as const` TS artifacts to
  `packages/evs/test/generated/` (gitignored). `forge-std` is a git submodule at
  `lib/forge-std` (never an npm dependency).
- `examples/` — runnable example scripts (private workspaces).
- `apps/docs` — Astro Starlight docs site → `evs.maxencerb.com`. Built/deployed by
  **Cloudflare Workers Builds**, NOT ci.yml (dashboard settings are recorded in the README's
  "Docs site" section; its build command uses plain `bun run …` and must not depend on `vp`).
  Every ` ```ts ` fence in `src/content/docs/` must typecheck standalone (gate:
  `bun run check:snippets` in `apps/docs`, needs the library built first); ` ```ts nocheck `
  opts out. Lint ignores `apps/docs/**`; the formatter ignores its `src/content/**` (MDX).
- `scripts/` — release helpers run on bun (`scripts/publish.ts`).
- `.github/assets/` — repository artwork (`evs-banner.svg`, the animated README banner; the
  docs landing hero in `apps/docs/src/components/Hero.astro` redraws the same ridges inline).
- Dependency versions are pinned via **catalogs** in the root `package.json`. `viem` and
  `vite-plus` are exact-pinned (type tests depend on viem patch behavior; `vite-plus` must
  match the `vite` alias override and the `vitest` override pin) — bump deliberately, then
  re-run `vp install`.

## Key commands

- `vp install` — install everything (workspaces + catalogs; = `bun install`)
- `vp run build` — build `@maxencerb/evs` (tsc emit: dist/ js + d.ts + maps)
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
  `.node-version`, bun from `packageManager`, cached `vp install --frozen-lockfile`) → forge
  build + test + codegen → build library → fmt:check → lint:ci → typecheck → unit+type tests
  → integration (anvil; foundry pinned `FOUNDRY_VERSION`) → publint + attw → informational
  `changeset status`. `fork-tests` runs on `workflow_dispatch` only (`ANVIL_FORK_URL`).
  Every action is pinned to a commit SHA with the tag in a trailing comment — bump both.
- `.github/workflows/release.yml` — **changesets** on every push to `main`: pending
  changesets → opens/updates the "Version Packages" PR; otherwise publishes the not-yet-
  published version via npm **OIDC trusted publishing** (filename must stay `release.yml`).
  Publishing is `scripts/publish.ts` = `bun pm pack` → `npm publish <tgz> --provenance` →
  `changeset git-tag` — NOT `bun publish` (no OIDC support, oven-sh/bun#22423) and NOT
  `changeset publish` (would ship `catalog:`/`workspace:` specs). The repo is public and
  provenance is ON (`publishConfig.provenance: true` + `--provenance`); if the repo ever goes
  private again, flip both off or publishes fail.
- Docs site CI/deploy is owned by Cloudflare Workers Builds (see Layout), not GitHub Actions.
