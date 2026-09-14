# @maxencerb/evs

**Typed EVM read scripts in plain TypeScript.** You write a callback against a small builder
API; evs compiles it to EVM runtime bytecode and executes it through a single `eth_call` —
deployless by default, no contract to deploy, with the result fully typed end-to-end through
viem's inference.

**Why:** a multicall can batch reads, but it cannot _feed one call's result into the next_ —
`pool.token0()` → `token0.symbol()` is two round trips, plus client-side decode/re-encode glue,
plus hand-written result types. An evs script moves that data flow on-chain: cross-call values,
loops over runtime arrays, per-call error recovery, and checked arithmetic all run inside one
RPC round trip, and `readContract` infers the whole result object from the script's generated
literal ABI.

```
TS callback ──record──▶ IR ──compile──▶ runtime bytecode ──eth_call──▶ typed object
```

**Documentation: <https://evs.maxencerb.com>** · source: <https://github.com/maxencerb/evs>

## Install

```sh
bun add @maxencerb/evs viem
```

ESM-only. TypeScript ≥ 5.5 in `strict` mode; peer dependency `viem >= 2.14.1`; Node ≥ 20.19
(or Bun).

## Quickstart — pool metadata in one round trip

`token0`/`token1`/`slot0` from a Uniswap V3 pool, each token's `symbol`, a defaulted
`decimals`, and the user's balance: seven dependent reads, one `eth_call`. (This mirrors the
runnable [`examples/pool-meta`](https://github.com/maxencerb/evs/tree/main/examples/pool-meta) script, pointed at the real mainnet pool
ABI.)

```ts
// abis.ts — plain `as const` ABI fragments (viem-style)
export const uniswapV3PoolAbi = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;
```

```ts
import { evscript, t } from '@maxencerb/evs';
import { createPublicClient, erc20Abi, http } from 'viem';
import { mainnet } from 'viem/chains';

import { uniswapV3PoolAbi } from './abis';

const poolMeta = evscript(
  { name: 'poolMeta', args: [t.address, t.address] },
  // args arrive as positional params after `s`, in declaration order
  (s, pool, user) => {
    // values flow BETWEEN calls on-chain — a multicall cannot do this
    const token0 = s.read({ address: pool, abi: uniswapV3PoolAbi, functionName: 'token0' });
    //    ^? Expr<'address'>
    const token1 = s.read({ address: pool, abi: uniswapV3PoolAbi, functionName: 'token1' });
    const slot0 = s.read({ address: pool, abi: uniswapV3PoolAbi, functionName: 'slot0' });
    //    ^? readonly [Expr<'uint160'>, Expr<'int24'>, …]
    const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
    const symbol1 = s.read({ address: token1, abi: erc20Abi, functionName: 'symbol' });
    const dec = s.tryRead({ address: token0, abi: erc20Abi, functionName: 'decimals' });
    const decimals0 = s.select(dec.success, dec.value, 18); // default when the call fails
    const bal0 = s.read({
      address: token0,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [user],
    });
    return s.return({ token0, token1, symbol0, symbol1, tick: slot0[1], decimals0, bal0 });
  },
);

const compiled = poolMeta.compile();

const client = createPublicClient({ chain: mainnet, transport: http() });
const out = await client.readContract({
  ...compiled.toViem(), // { abi, code } — deployless eth_call, works on any standard RPC
  functionName: 'poolMeta',
  args: [
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    '0x0000000000000000000000000000000000000001',
  ],
  //     ^ args is typed readonly [pool: `0x${string}`, user: `0x${string}`]
});
// out: {
//   token0: `0x${string}`; token1: `0x${string}`; symbol0: string; symbol1: string;
//   tick: number; decimals0: number; bal0: bigint
// }
```

No `as const` needed on the script itself, no codegen step, no ABI files to maintain — the
script _is_ its own literal-typed ABI (`poolMeta.abi` exists before compiling).

## Two execution modes

```ts
// 1. Deployless (the default): `{ abi, code }` — a plain 2-parameter eth_call with `to`
//    omitted. Maximal portability: works on every provider that implements standard eth_call.
await client.readContract({ ...compiled.toViem(), functionName: 'poolMeta', args });

// 2. State override: `{ abi, address, stateOverride }` — eth_call's third parameter.
await client.readContract({
  ...compiled.toViem({ mode: 'stateOverride' }),
  functionName: 'poolMeta',
  args,
  account: caller, // msg.sender as seen by the script — controllable in this mode
  blockNumber: 22_000_000n, // historical reads work in both modes — it is just eth_call
});

// 2b. Sender mode: the script is installed AT `sender` (+ `account: sender`), so every sub-call
//     target — including a simulated write — sees msg.sender = sender.
await client.readContract({
  ...compiled.toViem({ mode: 'stateOverride', sender: caller }),
  functionName: 'poolMeta',
  args,
});
```

Prefer `stateOverride` when you want a stable, human-meaningful `address(this)` (default
`0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`, overridable), a controllable `msg.sender`, or to
compose with further overrides (balance spoofing etc.). It is supported by geth, anvil,
QuickNode and publicnode, but **not documented** for `eth_call` on Alchemy or Infura — which is
why deployless is the default (support matrix below). The artifact deliberately exposes `runtimeBytecode` / `initBytecode` and never a field
named `code`: passing runtime bytecode as viem's `code` fails _silently_, and `toViem()` always
hands viem the right flavor.

> [!WARNING]
> **`s.env('caller')` / `s.env('address')` are execution-frame-dependent — and the default
> deployless mode gives you values you cannot control.** Deployless `eth_call` runs the script
> inside viem's wrapper: `s.env('caller')` is the wrapper contract
> (`0xBd770416a3345F91E4B34576cb804a576fa48EB1` when no `account` is passed — never your
> account), and `s.env('address')` is a per-script counterfactual CREATE2 address. A
> caller-relative read like `balanceOf(s.env('caller'))` therefore silently returns the
> wrapper's (zero) balance. Caller-relative reads **require**
> `toViem({ mode: 'stateOverride' })` plus the `account` call parameter — there is no
> deployless workaround. `compile()` emits an `ENV_FRAME_DEPENDENT` warning (via
> `onDiagnostic`) whenever a script uses these two env ops; `timestamp`/`blocknumber`/
> `chainid` are block context and identical in both modes. To model a non-default frame in
> tests, pass `interpret(ir, args, chain, { env: { caller, address } })`.

## Key concepts

### Build time vs run time

The builder callback runs **once**, at build time, recording statements. Everything that
touches chain data is an `Expr<type>` handle — a typed placeholder for a value that will only
exist inside `eth_call`.

> [!WARNING]
> **Native JS `if`/`for`/`&&` does NOT branch on EVM values.** `if (someExpr)` compiles — and
> the condition is just an object, so it is _always truthy_; the branch is recorded
> unconditionally and JS cannot trap it. For runtime values use the combinators: `s.if`,
> `s.while`, `s.for`, `s.select`. Use plain JS control flow only over host values (unrolling a
> known-at-build-time list, for example). Most other misuses (`x + 1`, `` `${x}` ``,
> `JSON.stringify(x)`, `x == 5`) throw `EvsStagingError` at the offending line; the truthiness
> gap is the one JS cannot intercept — turn on the `typescript/strict-boolean-expressions`
> lint to close it.

| Runs at build time (TS)                                | Runs on-chain (compiled)                     |
| ------------------------------------------------------ | -------------------------------------------- |
| the builder callback, exactly once                     | the recorded statements, in recorded order   |
| JS `if`/`for` over host values (unrolls / specializes) | `s.if`/`s.while`/`s.for` over runtime values |
| literal validation & folding, ABI resolution           | checked arithmetic, calls, decoding          |

### Values and cells

Every operation returns an immutable `Expr` snapshot — reusing a handle re-reads a value, never
re-executes the computation. The only mutable state is a cell from `s.let`, and reads are an
explicit `.get()` so "snapshot vs current value" is visible at every use:

```ts
const total = s.let(t.uint256, 0n); // Cell<'uint256'>
total.set(total.get().add(amount)); // `amount` is a positional arg; checked add — Panic 0x11 on overflow
const snapshot = total.get(); // fixed at this program point
```

### Control flow combinators

```ts
s.if(
  cond,
  () => {
    /* then */
  },
  () => {
    /* else */
  },
); // cond evaluated once, before branching
s.while(
  () => i.get().lt(n),
  (loop) => {
    /* loop.break() / loop.continue() */
  },
);
s.for({ type: t.uint256, from: 0n, until: n }, (i, loop) => {
  /* i: Expr<'uint256'> */
});
const v = s.select(cond, a, b); // ternary — but EAGER on both sides (they are values already)
```

`while` conditions are thunks (recorded into a loop header that re-executes per iteration);
`s.select` does not short-circuit — use `s.if` + a cell for conditional execution. Loop over a
runtime array with `s.for` + `s.newArray` to collect outputs — that is the multicall
replacement pattern ([`examples/token-balances`](https://github.com/maxencerb/evs/tree/main/examples/token-balances)).

### Calls: `read`, `call`, `simulate`

The calling surface is split into three verbs by mutability and call frame. All three share the
same `{ address, abi, functionName, args }` shape (typed like viem's `readContract`: per-arg
literal-or-`Expr` unions, outputs unwrapped one→`Expr`/many→tuple) and a `try*` variant returning
`{ success: Expr<'bool'>, value }` (`success` false on failure **or** malformed returndata,
`value` then zeros/empty — pair with `s.select` for defaults).

| Verb                           | Opcode                                | Functions                | State                                                           |
| ------------------------------ | ------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `s.read` / `s.tryRead`         | `STATICCALL`                          | `view` / `pure`          | static — no writes possible                                     |
| `s.call` / `s.tryCall`         | `CALL`                                | `nonpayable` / `payable` | a real frame; the write is **not** rolled back                  |
| `s.simulate` / `s.trySimulate` | `CALL` via a self-call + revert macro | `nonpayable` / `payable` | the write is **rolled back**, yet its return value is read back |

`s.read` is the normal view-read path. `s.call` opens a non-static frame for functions that
aren't `view` yet don't usefully persist state — the canonical case is a Uniswap **quoter** (it
simulates a swap and so can't run under `STATICCALL`); the write it makes is visible to later
subcalls in the same script but the `eth_call` itself never commits. `s.simulate` dry-runs a true
**write** in a self-call sub-frame that reverts, so you read back what it _would_ return while its
state changes are discarded and isolated from later reads. Mutability is filtered per verb — a
`nonpayable` function under `s.read`, or a `view` function under `s.call`, is a compile error that
steers you to the right verb. `s.call` / `s.tryCall` also take `revertReturns: [t.uint256]` to
decode a QuoterV1-style target's **revert data** as the result (the list replaces the ABI outputs as
the decode schema; a normal return is then the failure).

A callee revert **bubbles verbatim** (`Error(string)`, `Panic`, custom errors alike) under the
strict verbs, so viem decodes the original error through your script; malformed returndata reverts
a named `EvsDecodeError(site)`. ⚠ `s.call`/`s.simulate` make a real call where the target sees
`msg.sender` as your script's address — use `toViem({ mode: 'stateOverride', sender })` (the
script runs _at_ `sender`) for `msg.sender`-sensitive targets. Every verb takes an optional `gas`
cap (for `s.simulate` it bounds the inner target call), and simulate sites nest freely — inside
`s.fn` bodies, one dry-run feeding the next.

### Checked arithmetic

All arithmetic is checked with solc ≥ 0.8 semantics: standard `Panic(code)` reverts — `0x11`
overflow, `0x12` division by zero, `0x32` array out-of-bounds, `0x41` over-allocation.
Narrowing conversions (`x.toUint('uint8')`) are range-checked; widening is free. Operations
whose literal operands make a panic certain are caught while recording, at the exact line.

### Compiling and the artifact

```ts
const compiled = poolMeta.compile({ evmVersion: 'paris' }); // 'cancun' (default) | 'shanghai' | 'paris'

compiled.runtimeBytecode; // what runs (state-override mode); EIP-170 size enforced
compiled.initBytecode; // wrapped for deployless mode — what toViem() passes as `code`
compiled.abi; // literal-typed: the script fn + EvsInvalidCalldata + EvsDecodeError
console.log(compiled.disassemble().format()); // annotated listing — your source line per pc
compiled.explainRevert(revertData).message; // Panic codes & decode sites → builder call sites
```

`evmVersion` lowers PUSH0/MCOPY usage for pre-Shanghai/pre-Cancun chains. The compiler verifies
its own output (JUMPDEST scan, stack-height simulation, opcode/fork lints) before handing it to
you.

## Runnable examples

Both examples spawn a throwaway local [anvil](https://getfoundry.sh) and need zero
configuration:

```sh
bun install && bun run build
bun examples/pool-meta/index.ts        # the quickstart script, end to end
bun examples/token-balances/index.ts   # loop + tryCall over address[] — the multicall replacement
```

## Repository map

| Path                                                                                  | What                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`packages/evs`](https://github.com/maxencerb/evs/tree/main/packages/evs)             | the published library: builder, IR + interpreter, codegen, assembler, viem glue |
| [`packages/contracts`](https://github.com/maxencerb/evs/tree/main/packages/contracts) | Foundry fixtures: mocks + the solc reference contract for differential tests    |
| [`examples/`](https://github.com/maxencerb/evs/tree/main/examples)                    | runnable example scripts (see above)                                            |

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

## Provider support for the two modes

| Provider / node       | deployless (`to: null`) | `stateOverride` (3rd `eth_call` param)                    |
| --------------------- | ----------------------- | --------------------------------------------------------- |
| geth, reth, anvil     | yes                     | yes (documented; anvil verified in the integration suite) |
| QuickNode, publicnode | yes                     | yes (documented / empirically verified)                   |
| Alchemy, Infura       | yes                     | **not documented** for `eth_call` — probe before relying  |

Deployless works everywhere `eth_call` works, which is why it is the default. Both modes share
the node's `eth_call` gas cap (geth default 50M) — the ceiling for scripts making many calls.

## Design notes (the parts worth knowing)

- **Pipeline.** The builder callback runs once and records a value-semantics IR (a flat value
  table, one site id per statement). `validateIr` checks it, codegen lowers each statement
  through fixed memory-slot templates to an assembly stream, the assembler resolves jumps
  (`PUSH2` fixups), and mandatory verifiers run on the output before it is handed to you:
  a `JUMPDEST` scan, a stack-height simulation (the operand stack must be empty at every
  statement boundary), opcode/fork lints, and the EIP-170 size check.
- **Memory model** is Solidity's: `0x00–0x3f` scratch, `0x40` free-memory pointer, `0x60` the
  zero slot (the canonical empty value `try*` failures point at), a **static frame from `0x80`**
  with one 32-byte slot per arg / cell / value, and bump allocations after it (returndata
  snapshots, dynamic values, mutable arrays, the return tuple). Every word in a slot is
  canonical (`uintN` zero-extended, `intN` sign-extended, `bool` ∈ {0,1}, `bytesN` left-aligned);
  dynamic values and tuples are pointers. No slot reuse or fusion on purpose — the disassembly
  stays legible and the stack invariant machine-checkable.
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
  byte-for-byte on returndata and revert payloads for every fixture; ABI codecs vs viem's
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
`packages/evs/src/**`, `bun.lock`. `wrangler` is a **root** devDependency on purpose: the deploy
command runs `npx wrangler` from the repo root, and bun's isolated `node_modules` only exposes a
workspace's own binaries there. Every ` ```ts ` fence under `apps/docs/src/content/docs/`
must typecheck standalone against the built package (`bun run check:snippets`); ` ```ts nocheck `
opts out. `astro build` also validates every internal link.

## License

MIT © Maxence Raballand
