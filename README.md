# evs

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

## Install

```sh
bun add @maxencerb/evs viem
```

ESM-only. TypeScript ≥ 5.5 in `strict` mode; peer dependency `viem >= 2.14.1`; Node ≥ 20.19
(or Bun).

## Quickstart — pool metadata in one round trip

`token0`/`token1`/`slot0` from a Uniswap V3 pool, each token's `symbol`, a defaulted
`decimals`, and the user's balance: seven dependent reads, one `eth_call`. (This mirrors the
runnable [`examples/pool-meta`](examples/pool-meta) script, pointed at the real mainnet pool
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
import { arg, evscript, t } from '@maxencerb/evs';
import { createPublicClient, erc20Abi, http } from 'viem';
import { mainnet } from 'viem/chains';

import { uniswapV3PoolAbi } from './abis';

const poolMeta = evscript(
  { name: 'poolMeta', args: [arg('pool', t.address), arg('user', t.address)] },
  (s) => {
    // values flow BETWEEN calls on-chain — a multicall cannot do this
    const token0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token0' });
    //    ^? Expr<'address'>
    const token1 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token1' });
    const slot0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' });
    //    ^? readonly [Expr<'uint160'>, Expr<'int24'>, …]
    const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' });
    const symbol1 = s.call({ address: token1, abi: erc20Abi, functionName: 'symbol' });
    const dec = s.tryCall({ address: token0, abi: erc20Abi, functionName: 'decimals' });
    const decimals0 = s.select(dec.success, dec.value, 18); // default when the call fails
    const bal0 = s.call({
      address: token0,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [s.args.user],
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
```

Prefer `stateOverride` when you want a stable, human-meaningful `address(this)` (default
`0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`, overridable), a controllable `msg.sender`, or to
compose with further overrides (balance spoofing etc.). It is supported by geth, anvil,
QuickNode and publicnode, but **not documented** for `eth_call` on Alchemy or Infura — which is
why deployless is the default (see
[docs/research/viem-integration.md](docs/research/viem-integration.md) for the full support
matrix). The artifact deliberately exposes `runtimeBytecode` / `initBytecode` and never a field
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
total.set(total.get().add(s.args.amount)); // checked add — Panic 0x11 on overflow
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
replacement pattern ([`examples/token-balances`](examples/token-balances)).

### Calls, `tryCall`, and revert bubbling

`s.call({ address, abi, functionName, args })` is typed like viem's `readContract`: only
`view`/`pure` functions, per-arg literal-or-`Expr` unions, outputs unwrapped (one output → one
`Expr`, many → a tuple). A callee revert **bubbles verbatim** (`Error(string)`, `Panic`,
custom errors alike), so viem decodes the original error through your script. Structurally
malformed returndata reverts a named `EvsDecodeError(site)` — never a silent wrong value.

`s.tryCall(...)` returns `{ success: Expr<'bool'>, value }` instead: `success` is false on
failure **or** malformed returndata, and `value` is then zeros/empty — always safe to consume
(pair it with `s.select` for defaults).

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

| Path                                       | What                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`packages/evs`](packages/evs)             | the published library: builder, IR + interpreter, codegen, assembler, viem glue    |
| [`packages/contracts`](packages/contracts) | Foundry fixtures: mocks + the solc reference contract for differential tests       |
| [`examples/`](examples)                    | runnable example scripts (see above)                                               |
| [`docs/design`](docs/design)               | binding design docs: architecture, api, module-interfaces, testing, repo-layout    |
| [`docs/research`](docs/research)           | verified research notes: EVM target, viem integration, abitype, tooling, prior art |

## Development

Bun workspaces monorepo; Bun is the package manager / script runner, tests execute on
[vitest](https://vitest.dev) (recorded decision — per-worker anvil via prool and typecheck
tests need it; **never run `bun test` here**).

```sh
bun install               # workspaces + pinned catalogs
bun run build             # build @maxencerb/evs (tsc → dist/)
bun run test              # unit + type tests (vitest)
bun run test:integration  # anvil integration tests (requires foundry)
bun run check             # fmt:check + lint:ci + typecheck
bun run fmt               # oxfmt (writes)
```

Contracts: `cd packages/contracts && forge build / forge test / bun run codegen`.

## License

[MIT](packages/evs/package.json) © Maxence Raballand
