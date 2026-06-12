# evs — Test Architecture (binding)

Status: FINAL. Companion to `module-interfaces.md` (per-module test obligations are pinned
there; this document defines the shared infrastructure, tiers, and cross-cutting suites).

## 0. Runner decision (recorded deviation from CLAUDE.md)

**All tiers run on vitest, invoked through `bun run test*` scripts.** This deviates from the
repo CLAUDE.md default (`bun test`) deliberately, because the synthesis brief mandates the two
capabilities Bun's runner lacks:

1. **prool per-worker anvil** (stack-testing §3): the entire pattern is built on vitest's
   `VITEST_POOL_ID` + `globalSetup`/`provide`/`inject` — it is viem's own production test
   setup, verified in their source.
2. **Type-level tests** with `expectTypeOf` via vitest's `typecheck` project — chosen over
   `tsd` (single runner, richer assertions, lives next to the runtime tests it guards).

Never run `bun test` in this repo (it would invoke Bun's Jest-like runner against vitest
files); `package.json` wires `"test": "vitest run --project unit"` etc., and CI only calls
`bun run <script>` (stack-testing §2's documented pitfall).

## 1. Tiers

| Tier        | Project name  | What runs                                 | EVM                                            | Speed |
| ----------- | ------------- | ----------------------------------------- | ---------------------------------------------- | ----- |
| unit        | `unit`        | per-module tests in `src/**/*.test.ts`    | `@ethereumjs/evm` in-process (harness) or none | ms    |
| types       | `types`       | `src/**/*.test-d.ts` via vitest typecheck | none                                           | s     |
| integration | `integration` | `test/integration/**/*.test.ts`           | anvil via prool                                | s–min |

`packages/evs/vitest.config.ts` (exact):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        test: {
          name: 'types',
          include: ['src/**/*.test-d.ts'],
          typecheck: { enabled: true, only: true, include: ['src/**/*.test-d.ts'] },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
```

Root `vitest.config.ts` lists `projects: ['packages/*/vitest.config.ts']` and holds the
root-only options (`coverage`, `reporters`).

## 2. In-process EVM harness (unit tier)

`packages/evs/test/harness/evm.ts` — pinned contract in module-interfaces §M10:

```ts
execRuntime(runtime: Hex, calldata: Hex, fixture?: { contracts?: Record<Address, Hex>; gasLimit?: bigint })
  → { success: boolean; data: Hex; gasUsed: bigint }
```

- `@ethereumjs/evm` v10 (catalog-pinned). The script runtime is planted at a fixed address;
  `fixture.contracts` plants mock STATICCALL targets (runtime bytecode per address).
- Default gasLimit 30,000,000 (anvil parity worst case [evm §4]).
- Mock callee fixtures live in `test/harness/fixtures.ts` as hand-assembled hex with comments
  (the research fixtures `RUNTIME_42`, `RUNTIME_WHOAMI`, `RUNTIME_STATICCALL` from
  viem-integration App. A are the seed corpus), plus **attacker-shaped returners**: bytecode
  returning huge head offsets, huge lengths, off-by-one truncations, dirty high bits, empty
  returndata — used by the M7 decode-bounds suite, which asserts `EvsDecodeError(site)`
  reverts and **never** an exceptional halt (gasUsed sanity-checked ≪ gasLimit to prove no
  all-gas consumption).

## 3. Anvil integration via prool (integration tier)

Per stack-testing §3 — viem's production pattern, verbatim:

```ts
// packages/evs/test/global-setup.ts
import { Instance, Server } from 'prool';
export default async function setup() {
  const server = Server.create({
    instance: Instance.anvil({
      chainId: 31337,
      hardfork: 'Prague', // PINNED — anvil's default `latest` moves over time
      gasLimit: 100_000_000, // headroom over the 30M default for stress tests
    }),
    port: 8545,
  });
  const stop = await server.start();
  return async () => {
    await stop();
  };
}

// packages/evs/test/harness/anvil.ts
export const poolId = Number(process.env.VITEST_POOL_ID ?? 1);
export const rpcUrl = `http://127.0.0.1:8545/${poolId}`; // one anvil per vitest worker
```

Rules: no `test.concurrent()` in integration files (per-worker instances are safe because one
worker runs files serially); read-only eth_call tests need no state reset; tests that deploy
mocks use `testClient.setCode` / `deployContract` and are deterministic per worker.

**Execution paths covered, every release:**

1. `anvil_setCode(runtimeBytecode)` + plain `readContract` (primary, most debuggable).
2. `stateOverride` mode: `readContract({ ...toViem({mode:'stateOverride'}), ... })`.
3. **Deployless `code` path regression** (permanent, pinned anvil version): viem's `code` param
   with `initBytecode` — guards the historical anvil constructor-return bug
   (foundry #4549/#4568 [stack §3]) and the silent-failure footgun (a deliberate
   raw-runtime-as-`code` canary test asserts the empty-data failure mode still exists, so the
   guard rails stay honest).
4. Revert bubbling end-to-end: a Solidity contract reverting with `Error(string)`, `Panic`,
   a custom error, and empty revert — assert viem surfaces the _callee's_ error through the
   script unchanged.
5. Fork-mode (env-gated, `ANVIL_FORK_URL` + pinned block): mainnet WETH `symbol()` through a
   compiled script, both modes — reproduces viem-integration §3 tests 4/5. Skipped when the
   env var is absent (CI runs it on a scheduled job, not per-PR).

## 4. Differential testing (three axes — the anti-miscompilation core)

### 4.1 Interpreter vs bytecode (the oracle)

For **every** example script in `examples/` and every IR fixture in the corpus:
`interpret(ir, args, mockChain)` must agree **byte-for-byte** with
`execRuntime(compiled.runtimeBytecode, encodedCalldata, fixture)` on returndata AND revert
payloads (Panic codes, EvsDecodeError sites, bubbled data, tryCall zeroing). The mock chain
and the harness fixtures are generated from the same table so both sides see identical callee
behavior. Divergence = release blocker; `architecture.md` §6/§7/§8 adjudicate which side is
wrong.

### 4.2 ABI codecs vs viem

- Return encoding: for a fuzzed matrix of return shapes (words of every width class ×
  string/bytes × `T[]` × mixed orders), the script's RETURN bytes must equal
  `encodeAbiParameters([resultTupleParam], [valuesObject])`.
- Calldata decoding: scripts echoing their args back must round-trip
  `encodeFunctionData(...)` exactly (incl. dynamic args).
- Sub-call arg encoding: mock callee records calldata (returns it); compare against
  `encodeFunctionData` for literal, Expr, and mixed args.

### 4.3 Checked arithmetic vs solc (the reference contract)

`packages/contracts/src/EvsReference.sol` (solc 0.8.30 pinned, via_ir false):

```solidity
contract EvsReference {
    // one external pure function per (op × width class) used by the differential suite:
    function addU256(uint256 a, uint256 b) external pure returns (uint256) { return a + b; }
    function mulU192(uint192 a, uint192 b) external pure returns (uint192) { return a * b; }
    function mulI200(int200 a, int200 b) external pure returns (int200) { return a * b; }
    function divI256(int256 a, int256 b) external pure returns (int256) { return a / b; }
    function subU64(uint64 a, uint64 b) external pure returns (uint64) { return a - b; }
    // … full matrix: {add,sub,mul,div,mod} × {uint8, uint64, uint128, uint192, uint256,
    //                 int8, int128, int200, int256} …
    function toU8(uint256 x) external pure returns (uint8) { return uint8(x); } // NOT used for
    // narrowing parity (evs narrows checked, solc truncates) — kept to DOCUMENT the divergence
}
```

The suite runs boundary operands (`0, 1, max−1, max, min, −1` and the wrap-back cases
`uint192: 2^191 × (2^65+1)`, `int256: −2^255 / −1`, `int8: −128 / −1`) against BOTH the solc
function (deployed on the harness from `deployedBytecode`) and the equivalent evs script, and
asserts identical success/revert outcomes and identical `Panic(code)` payloads. This pins the
architecture §6 table to solc ground truth.

Also in `packages/contracts/src`:

- `MockERC20.sol`, `MockUniV3Pool.sol` (slot0/token0/token1/fee) — integration fixtures.
- `Reverter.sol` — reverts with Error(string)/Panic(via assert/overflow)/custom error/empty,
  selected by selector — the bubbling suite's callee.
- `Malformed.sol` — returns attacker-shaped ABI payloads via inline assembly (huge offsets,
  truncated tails) — the on-anvil mirror of the harness decode-bounds suite.

Artifacts are consumed from `contracts/out/**.json` (deployedBytecode for setCode/harness;
bytecode for deploys). `forge build` is a pretest step in CI (see repo-layout.md).

## 5. Type-level tests (`types` project, vitest `expectTypeOf`)

Pinned suites (exact viem patch version in the catalog — viem types change in patches):

- `core`: `IntoExpr`/`LitOf` acceptance/rejection matrices; brand nominality
  (structurally-similar object NOT assignable to `Expr`).
- `builder`: `s.args` record from a tuple; `s.call` output unwrap (0/1/n); `@ts-expect-error`
  on nonpayable names, wrong arg literal types, `eq` on `Expr<'string'>`; graceful widening
  (non-const ABI → `functionName: string`, output `Expr<EvsType>` — compiles, no error).
- `abi`: `ScriptAbi` literal shape; `ReadContractParameters<abi, name>['args']` is the labeled
  positional tuple in **declaration order** for a 3-arg script whose names are deliberately
  pre-interned earlier in the file (the abitype §4.2 regression);
  `ReadContractReturnType<abi, name>` is the expected object incl. `int24 → number`.
- `compile/viem`: both `toViem()` shapes spread into `readContract` params and typecheck;
  omitting both `address` and `code` is an error.
- Budget guard: the flagship script's full inference compiles without `TS2589` under
  `tsc --noEmit` (a dedicated CI step compiles `examples/` with the strictest config).

## 6. Golden snapshots and the honesty rule

- `disassemble().format()` snapshots for: each worked example in architecture.md §15, the
  dispatcher, each checked-op width class, the call patterns, return encoders. The
  architecture doc's listings are **generated from these goldens** (a doc-sync test fails if
  the doc drifts from real output) — A's honesty rule, enforced.
- `serializeIr` snapshots for every builder API.
- sourceMap snapshots: segments cover 100% of code bytes (no gaps), sites resolve.

## 7. Flagship end-to-end scenario (release gate)

On a worker-local anvil: deploy `MockUniV3Pool` + two `MockERC20`s; run the api.md E1
`poolMeta` script through **all three** execution paths; assert the fully-typed result object
matches the mock state; then `balances` (E2) over a 50-token array (loop + dynamic arg +
MutArray output); then the failure half: point E1 at an EOA address → assert the bubbled
revert decodes through viem and `explainRevert` names the originating `s.call` line; feed
`Malformed` as a token → assert `EvsDecodeError(site)` with the right site. Fork-mode variant
(env-gated) repeats E1 against real mainnet USDC/WETH pool at a pinned block.

## 8. CI wiring (full YAML in repo-layout.md)

PR pipeline: `bun install --frozen-lockfile` → `forge build` → `bun run build` (tsc; needed by
type-aware lint) → `oxfmt --check` → `oxlint --deny-warnings` → `vitest run --project unit
--project types` → `vitest run --project integration` (foundry toolchain installed; no fork) →
`publint` + `attw --pack`. Scheduled job adds the fork-mode suite. Release runs the full PR
pipeline before publishing.
