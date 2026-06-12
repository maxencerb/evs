# Repo Stack Research: Bun monorepo + Vitest + Anvil + Foundry + Library Packaging

Research date: 2026-06-11. All claims verified against current docs/source where possible; source URLs inline.
Audience: implementers without web access. Versions referenced below are current as of this date.

## 0. Version snapshot (June 2026)

| Tool                       | Current                                                               | Notes                                                                                    |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Bun                        | 1.3.x (1.3.14+ released; 1.3 shipped 2025-10)                         | isolated installs default for new workspaces, catalogs since 1.2.14                      |
| Vitest                     | 4.0.x stable (released 2025-10-22); last 3.x = 3.2.4                  | `projects` config exists in both 3.2+ and 4.x; v4 removes `poolOptions`                  |
| prool                      | 0.2.4 (2026-03-24)                                                    | new `Instance`/`Server`/`Pool` API (old `createServer`/`prool/instances` API is pre-0.2) |
| Foundry                    | 1.x stable line (>= 1.3.0)                                            | v1.3.0 added block-context overrides for `eth_call`                                      |
| TypeScript                 | 6.0 stable (2026-03); 5.9 still widely used; TS 7 (Go `tsgo`) in beta | `isolatedDeclarations` since 5.5; `verbatimModuleSyntax` since 5.0                       |
| viem                       | 2.x                                                                   | `code` / `stateOverride` params on `call`/`readContract`                                 |
| npm CLI (for OIDC publish) | >= 11.5.1 required, Node >= 22.14.0                                   | trusted publishing GA since 2025-07-31                                                   |

---

## 1. Bun workspaces & catalogs

Docs: https://bun.com/docs/pm/workspaces , https://bun.com/docs/pm/catalogs

### Root `package.json`

```json
{
  "name": "evs-monorepo",
  "private": true,
  "workspaces": ["packages/*"]
}
```

- Glob patterns supported, including negation: `["packages/**", "!packages/**/test/**"]`.
- Bun 1.3 made **isolated installs** (pnpm-style, no phantom deps) the **default for new workspaces**; controlled by `configVersion` in `bun.lock`. Existing pre-1.3.2 projects keep hoisted mode. Force with `bun install --linker isolated|hoisted`. (https://bun.com/blog/bun-v1.3 , https://bun.com/docs/pm/cli/install)
- `bun.lock` is the text lockfile (default since Bun 1.2). Catalog resolutions are recorded there.

### `workspace:` protocol

In a package depending on a sibling:

```json
{
  "name": "@maxencerb/evs-examples",
  "dependencies": { "@maxencerb/evs": "workspace:*" }
}
```

On `bun publish` / `bun pm pack` the specifier is rewritten:

- `workspace:*` -> exact version, e.g. `1.0.1`
- `workspace:^` -> `^1.0.1`
- `workspace:~` -> `~1.0.1`
- `workspace:1.0.2` -> `1.0.2` (literal wins)

(https://bun.com/docs/pm/workspaces)

**Known bug (verify before relying on it):** [oven-sh/bun#20477](https://github.com/oven-sh/bun/issues/20477) — `bun pm pack` substitutes the version recorded in `bun.lock`, not the dependency's current `package.json` version (observed on 1.2.16; still open as of research date, fix PR #26797 pending). **Mitigation: always run `bun install` after bumping versions and before `bun pm pack`/`bun publish`** so `bun.lock` is regenerated. (Also reported in workflows: [oven-sh/bun#24687](https://github.com/oven-sh/bun/issues/24687).)

### Catalogs (since Bun **1.2.14**; expanded in 1.3)

Root `package.json` (either inside `"workspaces"` object form or at top level):

```json
{
  "workspaces": {
    "packages": ["packages/*"],
    "catalog": {
      "viem": "^2.30.0",
      "typescript": "^5.9.0"
    },
    "catalogs": {
      "testing": { "vitest": "^3.2.4", "prool": "^0.2.4" }
    }
  }
}
```

Member packages:

```json
{
  "dependencies": { "viem": "catalog:" },
  "devDependencies": { "vitest": "catalog:testing" }
}
```

On pack/publish, Bun replaces `catalog:`/`catalog:<name>` with the resolved semver string — published tarballs never contain catalog specifiers. `bun outdated` and `bun update -i` understand catalogs since 1.3. (https://bun.com/docs/pm/catalogs , https://bun.com/blog/bun-v1.3 ; early 1.3.0 had catalog+isolated bugs, [oven-sh/bun#23615](https://github.com/oven-sh/bun/issues/23615) — use a recent 1.3.x patch.)

### Per-package scripts

- `bun run --filter '@maxencerb/evs' build` — run a script in one workspace.
- `bun run --filter '*' build` — run `build` in every workspace that defines it (parallel, respects nothing about topo order unless dependencies are expressed; keep builds independent or chain explicitly).
- `bun install --filter "pkg-*" --filter "!pkg-c"` — selective install.
- From a workspace dir, plain `bun run <script>` works as usual.

### `bun pm pack`

`bun pm pack` builds the tarball honoring the `files` whitelist, `--dry-run` lists contents, `--destination <dir>` sets output. It performs `workspace:` and `catalog:` substitution (with the lockfile caveat above). Recommended release flow (see §6): `bun install && bun run build && bun pm pack`, then publish the tarball with npm CLI for OIDC.

---

## 2. Vitest in a Bun monorepo

Docs: https://vitest.dev/guide/projects , https://vitest.dev/config/ (globalSetup), https://vitest.dev/blog/vitest-4

### Vitest 3.2+ `projects` (replaces deprecated `workspace` file)

`projects` was introduced in **Vitest 3.2** (the separate `vitest.workspace.ts` file is deprecated; identical semantics). Root `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // globs to package dirs or to config files
    projects: ['packages/*/vitest.config.ts'],
    // root-only options:
    coverage: { provider: 'v8' },
  },
});
```

Rules (verified at https://vitest.dev/guide/projects):

- Per-package config files must be named `vitest.config.*` / `vite.config.*` or `vitest.<name>.config.*`.
- Use `defineProject` (not `defineConfig`) in per-package configs for correct typing.
- Every project needs a **unique `name`** (defaults to package name / folder).
- **Root-only options that CANNOT be set per project: `coverage`, `reporters`, `resolveSnapshotPath`** (and other non-runner options).
- Inline projects can set `extends: true` to inherit root plugins/options.
- The root config itself is NOT a project unless listed explicitly.

### Unit vs integration split (recommended)

In `packages/evs/vitest.config.ts` define two projects with different file suffixes; only the integration project pays the anvil globalSetup cost:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/**/*.integration.test.ts'],
          environment: 'node',
          globalSetup: ['./test/globalSetup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
```

Run: `vitest --project unit`, `vitest --project integration`, or repeat `--project` to combine. (https://vitest.dev/guide/projects)

### globalSetup + provide/inject

- globalSetup runs **once, in a separate global scope, before workers are created** — tests cannot see its globals; pass serializable values via `project.provide(key, value)` and read them with `inject(key)` from `vitest`.

```ts
// test/globalSetup.ts
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject) {
  // ... start servers ...
  project.provide('anvilPort', 8545);
  return async function teardown() {
    /* stop servers */
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    anvilPort: number;
  }
}
```

```ts
// in a test
import { inject } from 'vitest';
const port = inject('anvilPort');
```

(https://vitest.dev/config/#globalsetup)

### Pools & worker IDs

- Vitest 3 default pool is `'forks'` (node `child_process` workers); `'threads'` is faster but less isolated. v3 config: `test.pool`, `test.poolOptions.forks.singleFork`, `test.fileParallelism: false` to serialize files.
- **Each worker exposes `process.env.VITEST_POOL_ID`** (small integer, reused across files on the same worker) — this is the key to one-anvil-per-worker (§3).
- **Vitest 4 breaking changes** (if/when upgrading from 3.x): `poolOptions` is removed (options like `singleThread` move to top level), `maxThreads`/`maxForks` merged into **`maxWorkers`**; Browser Mode split into `@vitest/browser-playwright` etc. (https://vitest.dev/blog/vitest-4 , https://vitest.dev/guide/migration.html)

### Running Vitest while the repo uses Bun — yes, fine

- Bun here is the **package manager / script runner**; Vitest itself executes on **Node** (its bin has a node shebang, and `bun run` respects shebangs). This is the supported, recommended setup.
- **Pitfall:** `bun test` runs Bun's own Jest-like runner, NOT Vitest. Always wire `"test": "vitest run"` into package.json and invoke `bun run test`. (https://vitest.dev/guide/ — "If you are using Bun as your package manager, make sure to use `bun run test` instead of `bun test`".)
- `bun run --bun vitest` forces the Bun runtime under Vitest; some users report it works ([vitest-dev/vscode#473](https://github.com/vitest-dev/vscode/discussions/473)) but it is **not officially supported** — don't do it for a library whose CI must be trustworthy. Node must satisfy Vitest's engine range (Vitest 3: ^18 || ^20 || >=22; Vitest 4 requires newer 20.x baseline).

---

## 3. Anvil in tests: prool (recommended) vs hand-rolled spawn

### Recommendation: **prool 0.2.x** (wevm's instance manager — same tool viem's own test suite uses)

Repo: https://github.com/wevm/prool — "programmatic HTTP testing instances for Ethereum". v0.2.4 as of 2026-03-24. Install: `bun add -d prool`.

Why prool over hand-rolled spawn:

1. **One anvil per Vitest worker with zero port bookkeeping**: prool starts a single proxy server on one port; requests to `http://localhost:8545/<key>` lazily spawn (or reuse) an anvil instance bound to that `<key>`, each on a random free port. Use `VITEST_POOL_ID` as the key.
2. Readiness detection built in (resolves when anvil prints `Listening on`), retries (default 5), timeouts (default 45_000 ms), teardown of the whole pool in one call.
3. It sets `FOUNDRY_DISABLE_NIGHTLY_WARNING=true` and converts camelCase options to anvil CLI flags via `toArgs()` (verified in source: https://github.com/wevm/prool/blob/main/src/instances/anvil.ts).

prool v0.2 API (NOTE: pre-0.2 examples on the web use `createServer` + `import { anvil } from 'prool/instances'`; the current API is below):

```ts
// packages/evs/test/globalSetup.ts  (vitest globalSetup)
import { Instance, Server } from 'prool';

export default async function setup() {
  const server = Server.create({
    instance: Instance.anvil({
      // deterministic config — see flag table below
      chainId: 31337,
      hardfork: 'Prague',
      // forking example (pin the block for determinism):
      // forkUrl: process.env.ANVIL_FORK_URL,
      // forkBlockNumber: 22_263_623n,
    }),
    port: 8545, // proxy port; instances get random free ports behind it
    // limit: 10, // optional max concurrent instances
  });
  const stop = await server.start();
  return async () => {
    await stop();
  };
}
```

```ts
// packages/evs/test/clients.ts — per-worker URL
export const poolId = Number(process.env.VITEST_POOL_ID ?? 1);
export const rpcUrl = `http://127.0.0.1:8545/${poolId}`;

import { createPublicClient, createTestClient, http } from 'viem';
import { foundry } from 'viem/chains';

export const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
export const testClient = createTestClient({
  chain: foundry,
  mode: 'anvil',
  transport: http(rpcUrl),
});
```

This is exactly viem's production test setup (verified in source):

- `viem/test/setup.global.ts` starts prool servers and documents the proxy pattern: "In vitest, each thread is assigned a unique, numerical id (`process.env.VITEST_POOL_ID`). We append this id to the local rpc url (e.g. `http://127.0.0.1:8545/<ID>`)."
- `viem/test/src/anvil.ts` does `Server.create({ instance: Instance.anvil({ chainId, forkUrl, forkBlockNumber, hardfork: 'Prague', ...options }), port }).start()` and builds `http://127.0.0.1:${port}/${poolId}`.
- viem also salts the pool id (`VITEST_POOL_ID * VITEST_SHARD_ID + random`) to survive shared CI machines — optional.
- Caveat from viem's comments: one worker runs files serially, so per-worker instances are safe **as long as you avoid `test.concurrent()`**; call `anvil_reset` (or `evm_snapshot`/`evm_revert`) between files if tests mutate chain state. For evs (read-only eth_call tests) this barely matters.

Server proxy endpoints (prool README): `/:key` (proxy), `/:key/start`, `/:key/stop`, `/:key/restart`, `/healthcheck`. There is also `Pool.define({ instance: Instance.anvil() })` + `pool.start(key)` if you want instances without the HTTP proxy.

`Instance.anvil(options)` accepts camelCase mirrors of all anvil flags (verified list from source): `accounts, balance, blockTime, chainId, codeSizeLimit, derivationPath, forkUrl, forkBlockNumber, forkChainId, gasLimit, gasPrice, hardfork, host, ipc, loadState, mnemonic, noMining, noStorageCaching, order, port, pruneHistory, silent, stepsTracing, state, timestamp, timeout, retries, binary` ( `binary` defaults to `'anvil'`), plus more. Defaults: host `localhost`, port `8545`, accounts `10`, balance `10000`.

### Hand-rolled alternative (only if you refuse the dependency)

```ts
// globalSetup.ts — spawn one anvil per run (serial tests: fileParallelism false)
import { spawn } from 'node:child_process';

export default async function setup() {
  const proc = spawn('anvil', ['--port', '8545', '--chain-id', '31337', '--hardfork', 'prague'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      if (String(d).includes('Listening on')) resolve();
    });
    proc.on('exit', (code) => reject(new Error(`anvil exited ${code}`)));
    setTimeout(() => reject(new Error('anvil start timeout')), 15_000);
  });
  return () => {
    proc.kill('SIGTERM');
  };
}
```

You then must either disable parallelism (`fileParallelism: false`) or compute `port = 8545 + Number(process.env.VITEST_POOL_ID)` per worker and spawn in a per-file `beforeAll` instead of globalSetup (globalSetup runs once, not per worker). prool makes all of this go away — **use prool**.

### Anvil flags for deterministic tests

Reference: https://getfoundry.sh/anvil/reference/ , https://getfoundry.sh/anvil/overview/

| Flag                                                      | Default                                                                                                                                      | Use                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `--mnemonic <phrase>`                                     | **`test test test test test test test test test test test junk`** (anvil's default IS deterministic; accounts derived at `m/44'/60'/0'/0/n`) | only override to diverge                                                             |
| `--accounts <n>` / `--balance <eth>`                      | 10 / 10000                                                                                                                                   | dev accounts                                                                         |
| `--hardfork <name>`                                       | `latest` (moves over time!)                                                                                                                  | **pin it**, e.g. `--hardfork prague`, for stable gas/opcodes                         |
| `--chain-id <id>`                                         | 31337                                                                                                                                        | match `foundry` chain in viem                                                        |
| `--port <n>` / `--host`                                   | 8545 / 127.0.0.1                                                                                                                             | prool overrides per instance                                                         |
| `--fork-url <url>` + `--fork-block-number <n>`            | —                                                                                                                                            | fork mainnet; ALWAYS pin block number for determinism                                |
| `--timestamp <unix>`                                      | —                                                                                                                                            | pin genesis timestamp                                                                |
| `--no-mining` / `--block-time <s>`                        | auto-mine                                                                                                                                    | irrelevant for pure eth_call tests; viem pins `noMining: true` on its fork instances |
| `--silent`                                                | off                                                                                                                                          | quiet CI logs                                                                        |
| `--code-size-limit <bytes>` / `--disable-code-size-limit` | EIP-170 (24576)                                                                                                                              | raise if a compiled evs script ever exceeds 24,576 bytes of runtime code             |
| `--steps-tracing`                                         | off                                                                                                                                          | enables geth-style `debug_traceCall` traces — handy for debugging compiled bytecode  |
| `--dump-state` / `--load-state`                           | —                                                                                                                                            | snapshot state to disk between runs                                                  |

First anvil account (useful constant; from viem `test/src/constants.ts`): address `0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266`, key `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`.

### Cheat RPCs you will use

(https://getfoundry.sh/anvil/reference/ — "Custom Methods"; `hardhat_*` aliases also accepted)

- **`anvil_setCode(address, bytecode)`** — plant the compiled evs **runtime bytecode** at a fixed address persistently. Then call it with a plain `eth_call`/`readContract` — _no state override needed on the call_. viem test-client action: `testClient.setCode({ address, bytecode })`.
- `anvil_setStorageAt(address, slot, value)`, `anvil_setBalance`, `anvil_setNonce`
- `anvil_impersonateAccount(address)` / `anvil_stopImpersonatingAccount`
- `anvil_reset({ forking: { jsonRpcUrl, blockNumber } })` — reset between test files
- `evm_snapshot()` -> id, `evm_revert(id)` — viem: `testClient.snapshot()` / `testClient.revert({ id })`
- `anvil_mine(blocks)` / `evm_mine`

### `eth_call` with state override on anvil — VERIFIED: supported

Verified in anvil source (`crates/anvil/src/eth/api.rs`, master):

```rust
pub async fn call(
    &self,
    request: WithOtherFields<TransactionRequest>,
    block_number: Option<BlockId>,
    overrides: EvmOverrides,        // state overrides + block overrides
) -> Result<Bytes>
```

- Anvil accepts the geth-style third `eth_call` param `{ [address]: { balance, nonce, code, state, stateDiff } }` and (since Foundry **v1.3.0**, https://github.com/foundry-rs/foundry/releases/tag/v1.3.0) block-context overrides too. Same for `eth_estimateGas` and `eth_simulateV1`.
- **Limitation:** overrides are rejected with `EvmOverrideError("not available on past forked blocks")` when the call targets a historical block _behind_ the fork point in forking mode. Call against `latest` (default) and you're fine.

viem usage (state override on a read):

```ts
const SCRIPT = '0x000000000000000000000000000000000000beef';
const result = await publicClient.readContract({
  address: SCRIPT,
  abi: evsGeneratedAbi, // the literal ABI evs generates
  functionName: 'main',
  stateOverride: [{ address: SCRIPT, code: compiledRuntimeBytecode }],
});
```

`stateOverride` entries: `{ address, balance?, nonce?, code?, state? | stateDiff? }` (`state` replaces all storage, `stateDiff` patches slots; mutually exclusive). Docs: https://viem.sh/docs/actions/public/call#stateoverride

### Deployless calls (viem `code` param) — one critical nuance + anvil history

- viem deployless-via-bytecode: `call({ code, data })` / `readContract({ code, abi, functionName })`. **Verified in viem source** (`src/actions/public/call.ts`): it ABI-encodes `constructor(bytes bytecode, bytes data)` against a wrapper (`deploylessCallViaBytecodeBytecode`) whose constructor **CREATE2-deploys your bytes, calls the result, and returns the call result from the constructor**. Therefore **`code` must be CREATION bytecode (initcode), not runtime bytecode.** Since the evs compiler emits _runtime_ bytecode, wrap it in trivial initcode (`codecopy` + `return`) before using viem's `code` param — or skip the deployless path and use `stateOverride`, which takes runtime bytecode directly.
- Also: deployless-via-bytecode cannot coexist with `to`; deployless-via-factory needs `factory`, `factoryData`, AND `to`. Docs: https://viem.sh/docs/actions/public/call#deployless-calls
- **Anvil compatibility history:** returning data from a constructor over `eth_call` (exactly this pattern) was broken in early anvil — returned `0x` while Geth/Hardhat/Infura/Alchemy/Tenderly worked: [foundry-rs/foundry discussion #4549](https://github.com/foundry-rs/foundry/discussions/4549) and [issue #4568](https://github.com/foundry-rs/foundry/issues/4568). Issue #4568 is **closed as completed** (fixed), but a 2025-04 comment on #4549 claimed lingering trouble. **Action: keep one integration test that exercises viem's `code` path against your pinned anvil version; make `anvil_setCode` + plain call, and `stateOverride` (both definitively supported) the primary tested execution paths.**

---

## 4. Foundry project inside the monorepo

Docs: https://getfoundry.sh (Foundry Book) — config reference https://getfoundry.sh/config/reference/solidity-compiler

### Layout — `packages/contracts`, no Node integration needed

```
packages/contracts/
  foundry.toml
  remappings.txt          # optional; only if you vendor forge-std
  src/                    # reference contracts (e.g. MockERC20, MockUniV3Pool)
  test/                   # forge solidity tests (optional)
  lib/forge-std/          # git submodule via `forge install foundry-rs/forge-std`
  out/                    # build artifacts (gitignored)
  cache/                  # (gitignored)
```

This package needs **no `package.json`** (Foundry is invoked directly), but adding a minimal one lets `bun run --filter` drive it:

```json
{
  "name": "@maxencerb/evs-contracts",
  "private": true,
  "scripts": { "build": "forge build", "test": "forge test" }
}
```

### `foundry.toml` — pin everything

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.30"     # exact pin; strict versions only (no ^). Disables auto-detect.
auto_detect_solc = false    # default true; ignored when solc_version set, but be explicit
evm_version = "prague"      # default is prague currently, but pin it
optimizer = true
optimizer_runs = 200
via_ir = false
```

Key names verified at https://getfoundry.sh/config/reference/solidity-compiler : `solc_version` (alias `solc`), `auto_detect_solc` (default `true`), `evm_version` (default `prague`), `optimizer` (default `false`), `optimizer_runs` (default `200`), `via_ir` (default `false`). Foundry downloads the pinned solc automatically.

### Remappings (forge-std only)

`forge install foundry-rs/forge-std` adds a git submodule under `lib/`. Forge auto-derives remappings from `lib/` (`auto_detect_remappings`, default true); to be explicit create `remappings.txt`:

```
forge-std/=lib/forge-std/src/
```

If you'd rather avoid git submodules in the monorepo, Foundry also supports Soldeer (`forge soldeer install forge-std~1.9.x`) — but for a single dev-dependency the submodule is simplest. If the reference contracts have no solidity tests, you can skip forge-std entirely and have zero remappings.

### `.gitignore`

```
packages/contracts/out/
packages/contracts/cache/
```

(`lib/forge-std` stays as a submodule entry in `.gitmodules`, not ignored.)

### Artifact format: `out/<File>.sol/<Contract>.json`

`forge build` writes one JSON per contract at `out/Counter.sol/Counter.json`. Foundry **flattens solc's `evm` wrapper** — fields live at the top level (verified via https://pkg.go.dev/github.com/ethereum-optimism/optimism/op-chain-ops/foundry and the forge docs):

```jsonc
{
  "abi": [
    /* standard ABI array */
  ],
  "bytecode": {
    "object": "0x6080...", // CREATION bytecode (initcode)
    "sourceMap": "...",
    "linkReferences": {},
  },
  "deployedBytecode": {
    "object": "0x6080...", // RUNTIME bytecode
    "sourceMap": "...",
    "linkReferences": {},
    "immutableReferences": {},
  },
  "methodIdentifiers": { "token0()": "0dfe1681" },
  "rawMetadata": "{...}", // stringified solc metadata
  "metadata": {
    /* solc metadata object */
  },
  "id": 0,
}
```

- Deploy with viem: `bytecode: artifact.bytecode.object` (initcode). Plant with `anvil_setCode`: use `artifact.deployedBytecode.object` (runtime).
- `forge inspect src/Counter.sol:Counter abi --json` / `forge inspect ... bytecode` extract single fields.

### Consuming artifacts from TS tests

Vitest (via Vite) and Bun both import JSON directly:

```ts
// packages/evs/test/integration/helpers.ts
import erc20Artifact from '../../../contracts/out/MockERC20.sol/MockERC20.json';

const hash = await walletClient.deployContract({
  abi: erc20Artifact.abi,
  bytecode: erc20Artifact.bytecode.object as `0x${string}`,
  args: ['Mock', 'MCK', 18],
});
```

Requirements: `"resolveJsonModule": true` in tsconfig (or use `with { type: 'json' }` import attributes under NodeNext). **Type caveat:** JSON imports produce _widened_ types — `artifact.abi` is NOT a literal `as const` ABI, so viem cannot infer function names/args from it. For tests that's fine (cast or use `as const` on a hand-written ABI). If you want full inference for mock contracts, generate a TS file post-build, e.g. a small script:

```ts
// packages/contracts/scripts/codegen.ts (run with: bun scripts/codegen.ts)
const artifact = await Bun.file('out/MockERC20.sol/MockERC20.json').json();
await Bun.write(
  '../evs/test/generated/mockErc20.ts',
  `export const mockErc20Abi = ${JSON.stringify(artifact.abi)} as const\n` +
    `export const mockErc20Bytecode = ${JSON.stringify(artifact.bytecode.object)} as const\n`,
);
```

CI: install Foundry with `foundry-rs/foundry-toolchain@v1` (inputs: `version: v1.3.0` etc.) — provides `forge`, `anvil`, `cast`. (https://github.com/foundry-rs/foundry-toolchain)

---

## 5. Packaging `@maxencerb/evs` (ESM-only, types-first)

### Build tool decision

- **`bun build` does NOT and will not emit `.d.ts`** — confirmed current (2026): "The Bun bundler is not intended to replace `tsc` for typechecking or generating type declarations." (https://bun.com/docs/bundler). It outputs ESM (default), CJS/IIFE experimental.
- Since this library's value is its **types** and it has no bundling needs (plain TS, viem as peer dep), **use `tsc` as the sole emitter**: one pass produces `.js` + `.d.ts` + `.d.ts.map` + `.js.map` that all agree with each other. Skip `bun build` entirely. (If you ever want a bundle, run `bun build --target node --format esm` for JS and keep `tsc --emitDeclarationOnly` for types.)
- **`isolatedDeclarations`** (TS **5.5+**, https://www.typescriptlang.org/tsconfig/#isolatedDeclarations): forces every exported symbol to have an explicitly-writable type so `.d.ts` can be emitted file-by-file without inference. Pros: future-proofs for parallel/native emitters (tsgo/oxc), guarantees declaration stability. Cons: for an inference-heavy builder API (deep conditional generic types flowing through `s.call(...)`), you must name and annotate every exported helper's return type. **Recommendation: enable it if the annotations stay tolerable; it is a quality ratchet, not a requirement. Do not let it force you to widen types — if a return-type annotation loses precision versus inference, turn it off.** Declaration _quality_ is the product; verify with `@arethetypeswrong/cli` and by snapshotting `.d.ts` output in tests.
- **Ship `declarationMap` + the `src/` folder** so consumers' "Go to Definition" lands in real TypeScript source instead of `.d.ts`. This is cheap (source is small) and is exactly what types-first libraries (e.g. trpc) do. `declarationMap` docs: https://www.typescriptlang.org/tsconfig/#declarationMap

### tsconfig

`packages/evs/tsconfig.json` (typecheck config):

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext", // implies moduleResolution: NodeNext
    "moduleDetection": "force",
    "verbatimModuleSyntax": true, // TS 5.0+; forces `import type`, no import elision surprises
    "isolatedModules": true,
    // "isolatedDeclarations": true, // TS 5.5+; see tradeoff above
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
  },
  "include": ["src", "test"],
}
```

`packages/evs/tsconfig.build.json` (emit config):

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test-d.ts"],
}
```

Notes:

- `module: "NodeNext"` is the correct choice for a _library consumed by Node-resolution and bundlers alike_; it forces explicit `.js` extensions on relative imports in source (`import { x } from './ir.js'`) — required for the emitted ESM to actually run on Node. `moduleResolution: "bundler"` never requires extensions but then `tsc`'s emitted JS would be broken on bare Node; don't use it for emitting a library. (https://www.typescriptlang.org/tsconfig/#module , https://www.typescriptlang.org/docs/handbook/modules/reference.html)
- viem (the main dependency) requires TS >= 5.0.4 and recommends `"strict": true`; declare it a **peerDependency** so consumers' viem instance is the one whose types flow through `readContract` inference.

### `packages/evs/package.json` — recommended exact contents

```json
{
  "name": "@maxencerb/evs",
  "version": "0.1.0",
  "description": "Typed EVM read-script builder: compile typed call graphs to runtime bytecode executed via eth_call",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/maxencerb/evs.git",
    "directory": "packages/evs"
  },
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=20.19" },
  "files": ["dist", "src", "!src/**/*.test.ts", "!src/**/*.test-d.ts", "!dist/**/*.test.*"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "prepublishOnly": "bun run build"
  },
  "peerDependencies": {
    "typescript": ">=5.5",
    "viem": "^2.30.0"
  },
  "peerDependenciesMeta": {
    "typescript": { "optional": true }
  },
  "devDependencies": {
    "typescript": "catalog:",
    "viem": "catalog:",
    "vitest": "catalog:testing",
    "prool": "catalog:testing"
  },
  "publishConfig": { "access": "public" }
}
```

Rationale / exact-field notes:

- **ESM-only**: `"type": "module"`, no `require` condition, no CJS build. Node >=20.19 can even `require()` ESM now, so CJS consumers are not fully locked out.
- **Exports map**: the `"types"` condition MUST come before `"default"` within each entry (conditions are order-sensitive). Keep top-level `"main"`/`"types"` as fallback for old tooling. `"./package.json": "./package.json"` keeps tooling (bundlers, attw) happy.
- **`sideEffects: false`** — the package is pure (builder + compiler functions); enables tree-shaking in bundlers.
- **`files` whitelist** includes `src` (for declarationMap navigation) and excludes tests. `bun pm pack --dry-run` to audit.
- If you later split entry points (e.g. `@maxencerb/evs/compiler`), add sibling export entries — never use `"./*"` wildcards for a types-first package; explicit entries give better attw results.
- **Validate before publishing**: `bunx publint` (packaging mistakes) and `bunx @arethetypeswrong/cli --pack .` (resolution matrix: node16/nodenext/bundler). These two catch ~all exports/types misconfigurations.

### Publishing on GitHub release via npm OIDC (trusted publishing)

- GA since 2025-07-31 (https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/). Requirements (https://docs.npmjs.com/trusted-publishers/): **npm CLI >= 11.5.1**, **Node >= 22.14.0**, workflow permission **`id-token: write`**, and a Trusted Publisher configured on npmjs.com (org/user, repository, **exact workflow filename**, optional environment; case-sensitive). Provenance attestations are generated **by default** under OIDC — no `--provenance` flag, no `NODE_AUTH_TOKEN`. Trusted-publisher configs created after 2026-05-20 must explicitly select allowed actions (e.g. publish).
- **Bun caveat:** `bun publish` rewrites `workspace:`/`catalog:` but has no documented OIDC trusted-publishing support (as of 2026-06). **Pipeline: let Bun pack (does the rewrites), let npm publish (does OIDC):**

```yaml
# .github/workflows/release.yml (filename must match the npm Trusted Publisher config)
name: release
on:
  release: { types: [published] }
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - uses: actions/setup-node@v4
        with: { node-version: 24, registry-url: 'https://registry.npmjs.org' }
      - run: npm install -g npm@latest # ensure npm >= 11.5.1 for OIDC
      - run: bun install --frozen-lockfile
      - run: bun run --filter '@maxencerb/evs' build
      - run: cd packages/evs && bun pm pack
      - run: cd packages/evs && npm publish ./*.tgz
```

(Remember the §1 lockfile bug: version bumps must be followed by `bun install` and the updated `bun.lock` committed before tagging the release.)

---

## 6. Suggested repo skeleton (synthesis)

```
evs/
  package.json            # private, workspaces + catalogs
  bun.lock
  vitest.config.ts        # projects: ['packages/*/vitest.config.ts'], coverage (root-only)
  packages/
    evs/                  # @maxencerb/evs — builder + compiler + abi codegen
      package.json        # §5
      tsconfig.json / tsconfig.build.json
      src/  test/
      vitest.config.ts    # unit + integration projects, integration has globalSetup (prool/anvil)
    contracts/            # foundry; no node integration
      foundry.toml  src/  test/  lib/forge-std/
  .github/workflows/release.yml
```

Day-to-day commands: `bun install` • `bun run --filter '*' build` • `forge build` (in packages/contracts) • `bun run test` (unit) • `bun run test:integration` (spawns anvil via prool; requires foundry installed).

## Sources

- Bun workspaces: https://bun.com/docs/pm/workspaces — catalogs: https://bun.com/docs/pm/catalogs — bundler/no-d.ts: https://bun.com/docs/bundler — Bun 1.3 (isolated installs, catalogs in outdated/update): https://bun.com/blog/bun-v1.3 — install/linker: https://bun.com/docs/pm/cli/install
- Bun bugs: pack uses bun.lock versions https://github.com/oven-sh/bun/issues/20477 ; changeset/workspace publish https://github.com/oven-sh/bun/issues/24687 ; 1.3.0 isolated+catalog bugs https://github.com/oven-sh/bun/issues/23615 ; catalogs intro in v1.2.14 https://bun.com/blog/bun-v1.2.14
- Vitest projects: https://vitest.dev/guide/projects — globalSetup/provide-inject: https://vitest.dev/config/#globalsetup — Vitest 4 announcement: https://vitest.dev/blog/vitest-4 + https://voidzero.dev/posts/announcing-vitest-4 — migration: https://vitest.dev/guide/migration.html — bun-run note: https://vitest.dev/guide/ — bun runtime discussion: https://github.com/vitest-dev/vscode/discussions/473
- prool: https://github.com/wevm/prool (README + src/instances/anvil.ts)
- viem test harness (prool + VITEST_POOL_ID): https://github.com/wevm/viem/blob/main/test/setup.global.ts , https://github.com/wevm/viem/blob/main/test/src/anvil.ts , https://github.com/wevm/viem/blob/main/test/src/constants.ts
- viem deployless/stateOverride: https://viem.sh/docs/actions/public/call , source https://github.com/wevm/viem/blob/main/src/actions/public/call.ts , wrapper bytecode https://github.com/wevm/viem/blob/main/src/constants/contracts.ts
- Anvil reference (flags + custom RPC): https://getfoundry.sh/anvil/reference/ , overview/default mnemonic: https://getfoundry.sh/anvil/overview/ — eth_call overrides in source: https://github.com/foundry-rs/foundry/blob/master/crates/anvil/src/eth/api.rs — block overrides in v1.3.0: https://github.com/foundry-rs/foundry/releases/tag/v1.3.0 — constructor-return history: https://github.com/foundry-rs/foundry/discussions/4549 , https://github.com/foundry-rs/foundry/issues/4568 (closed/completed)
- Foundry config: https://getfoundry.sh/config/reference/solidity-compiler — forge build: https://book.getfoundry.sh/reference/forge/forge-build — artifact shape: https://pkg.go.dev/github.com/ethereum-optimism/optimism/op-chain-ops/foundry — toolchain action: https://github.com/foundry-rs/foundry-toolchain
- TypeScript: tsconfig reference https://www.typescriptlang.org/tsconfig/ (isolatedDeclarations — TS 5.5; verbatimModuleSyntax — TS 5.0; declarationMap; module nodenext) — TS 6.0 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ — TS 7 beta: https://visualstudiomagazine.com/articles/2026/04/21/typescript-7-0-beta-arrives-on-go-based-foundation-with-10x-speed-claim.aspx
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers/ , https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ , provenance: https://docs.npmjs.com/generating-provenance-statements/ , gotchas: https://philna.sh/blog/2026/01/28/trusted-publishing-npm/
