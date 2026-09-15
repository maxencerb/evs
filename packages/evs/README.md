<p align="center">
  <a href="https://evs.maxencerb.com">
    <img src="https://raw.githubusercontent.com/maxencerb/evs/main/.github/assets/evs-banner.svg" alt="Ethereum Virtual Script (evs)" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@maxencerb/evs"><img alt="npm version" src="https://img.shields.io/npm/v/@maxencerb/evs?labelColor=111111&color=3d3d3d"></a>
  <a href="https://github.com/maxencerb/evs/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/maxencerb/evs/ci.yml?branch=main&label=ci&labelColor=111111"></a>
  <a href="https://github.com/maxencerb/evs/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/@maxencerb/evs?labelColor=111111&color=3d3d3d"></a>
  <a href="https://www.npmjs.com/package/viem"><img alt="viem peer dependency" src="https://img.shields.io/badge/viem-%E2%89%A5%202.14-3d3d3d?labelColor=111111"></a>
</p>

<p align="center">
  <a href="https://evs.maxencerb.com"><b>Documentation</b></a>
  ·
  <a href="https://evs.maxencerb.com/getting-started/quick-start/">Quick start</a>
  ·
  <a href="https://evs.maxencerb.com/playground/">Playground</a>
  ·
  <a href="https://github.com/maxencerb/evs/tree/main/examples">Examples</a>
  ·
  <a href="https://github.com/maxencerb/evs/blob/main/packages/evs/CHANGELOG.md">Changelog</a>
</p>

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

## Highlights

- **One round trip.** Dependent reads — pool → tokens → metadata — collapse into a single
  `eth_call`. No multicall contract, no waterfall of requests, no client-side glue.
- **Typed end to end.** Calls are typed like viem's `readContract`; the script _is_ its own
  literal ABI, so viem infers your arguments and the exact shape of the result.
- **Nothing to deploy.** Runs deploylessly through the `eth_call` `code` parameter, or through
  a state override — any standard RPC node, any block, including historical ones.
- **Three calling verbs.** `s.read` for views, `s.call` for `CALL`-frame functions such as a
  Uniswap quoter, `s.simulate` to dry-run a write and read back its return value.
- **Solidity-grade semantics.** Checked arithmetic with solc 0.8 panic codes, verbatim revert
  bubbling, loops over runtime arrays, per-call error recovery with `try*` variants.
- **Verified bytecode.** Every compile passes a `JUMPDEST` scan, a stack-height simulation and
  fork lints; the test suite pins the bytecode against a reference interpreter, viem's codecs
  and real solc output.
- **Debuggable.** `disassemble()` annotates each opcode with your source line, and
  `explainRevert()` maps a revert payload back to the builder call that produced it.

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
why deployless is the default ([provider matrix](https://evs.maxencerb.com/guides/execution/#provider-support)). The artifact deliberately exposes `runtimeBytecode` / `initBytecode` and never a field
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

## Documentation and contributing

The full guides, reference and concept pages are at <https://evs.maxencerb.com>, with a
browser [playground](https://evs.maxencerb.com/playground/) that compiles and runs scripts
against any RPC. Repository layout, toolchain, test tiers, design notes and the release flow
are in [CONTRIBUTING.md](https://github.com/maxencerb/evs/blob/main/CONTRIBUTING.md).

## License

MIT © Maxence Raballand
