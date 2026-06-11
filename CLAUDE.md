# evs — agent guide

This is a **Bun workspaces monorepo** for `@maxencerb/evs`: a TypeScript callback-builder
compiled to EVM runtime bytecode for `eth_call` read scripts, with a literal-typed ABI for
viem inference.

## Binding documentation — read before changing anything

- `docs/design/**` is **BINDING**: `module-interfaces.md` (frozen exported signatures — THE LAW),
  `architecture.md` (pipeline, memory model, normative codegen tables, error model),
  `api.md` (user-facing semantics), `testing.md` (test tiers and obligations),
  `repo-layout.md` (this repo's layout, configs, CI/release — implemented here).
- `docs/research/**`: verified research facts (opcode table, viem/abitype behavior, panic
  encodings, tooling). Informative, not normative.

## IMPORTANT deviation from the default Bun template: testing

Tests run on **vitest**, NOT Bun's test runner (recorded decision, testing.md §0 — we need
prool per-worker anvil via `VITEST_POOL_ID`/globalSetup and vitest `typecheck` type tests).

- **NEVER run `bun test`** — it invokes Bun's Jest-like runner against vitest files and will
  misbehave. Always go through package scripts:
  - `bun run test` — unit + type tests (`vitest run --project unit --project types`)
  - `bun run test:integration` — anvil via prool (foundry must be installed)
  - `bun run test:all` — everything
  - Single file: `bunx vitest run <path> --project unit`
- Bun is the package manager / script runner only; vitest executes on Node.

## Layout

- `packages/evs` — the published library. Code in `src/` (`core/ ir/ abi/ builder/ asm/
codegen/ compile.ts viem.ts index.ts`), unit tests `src/**/*.test.ts`, type tests
  `src/**/*.test-d.ts`, integration tests + harnesses in `test/`. Built with `tsc`
  (`tsconfig.build.json`), ESM-only.
- `packages/contracts` — Foundry package (solc 0.8.30 exact, optimizer off). `forge build`,
  `forge test`; `bun run codegen` emits `as const` TS artifacts to
  `packages/evs/test/generated/` (gitignored). `forge-std` is a git submodule at
  `lib/forge-std` (never an npm dependency).
- `examples/` — runnable example scripts (private workspaces).
- Dependency versions are pinned via **catalogs** in the root `package.json`. `viem` is
  exact-pinned (type tests depend on viem patch behavior) and `oxfmt` is exact-pinned —
  bump deliberately, then re-run `bun install` before any pack/publish.

## Key commands

- `bun install` — install everything (workspaces + catalogs)
- `bun run build` — build `@maxencerb/evs` (tsc emit: dist/ js + d.ts + maps)
- `bun run typecheck` — `tsc --noEmit` across workspaces
- `bun run lint` / `bun run lint:fix` — **oxlint** (type-aware via oxlint-tsgolint; single
  root `.oxlintrc.json`, nested configs do not merge); CI uses `bun run lint:ci`
- `bun run fmt` (writes!) / `bun run fmt:check` — **oxfmt**, root `.oxfmtrc.json`
- `bun run check` — fmt:check + lint:ci + typecheck
- Contracts: `cd packages/contracts && forge build` / `forge test` / `bun run codegen`

## CI / release

- `.github/workflows/ci.yml` — PR gate: install → forge build + codegen → build library →
  fmt:check → lint:ci → typecheck → unit+type tests → integration (anvil; foundry pinned
  v1.7.1) → publint + attw.
- `.github/workflows/release.yml` — GitHub release tag (`vX.Y.Z`) → npm **OIDC trusted
  publishing** (filename must stay `release.yml`). The committed version stays `0.0.0`; the
  tag is the source of truth. `publishConfig.provenance` MUST stay `false` while the repo is
  private; flip to true when it goes public.
