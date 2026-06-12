# @maxencerb/evs

**Typed EVM read scripts in plain TypeScript.** Write a callback against a small builder API;
evs compiles it to EVM bytecode and runs it through a single `eth_call` — no contract to
deploy, no multicall glue, and the result is fully typed end-to-end through viem's inference.
Unlike a multicall, values flow **between** calls on-chain: `pool.token0()` →
`token0.symbol()` is one round trip, not two.

Full documentation: **<https://evs.maxencerb.com>** — design docs and runnable examples:
**<https://github.com/maxencerb/evs>**

## Install

```sh
bun add @maxencerb/evs viem
# or: npm install @maxencerb/evs viem
```

ESM-only. TypeScript ≥ 5.5 (`strict`); peer dependency `viem >= 2.14.1`; Node ≥ 20.19 or Bun.

## Example

```ts
import { arg, evscript, t } from '@maxencerb/evs';
import { createPublicClient, erc20Abi, http } from 'viem';
import { mainnet } from 'viem/chains';

import { uniswapV3PoolAbi } from './abis'; // any `as const` ABI fragment

const poolMeta = evscript(
  { name: 'poolMeta', args: [arg('pool', t.address), arg('user', t.address)] },
  (s) => {
    const token0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token0' });
    //    ^? Expr<'address'>  — feeds the next call ON-CHAIN
    const slot0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' });
    const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' });
    const dec = s.tryCall({ address: token0, abi: erc20Abi, functionName: 'decimals' });
    const decimals0 = s.select(dec.success, dec.value, 18); // default when the call fails
    const bal0 = s.call({
      address: token0,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [s.args.user],
    });
    return s.return({ token0, symbol0, tick: slot0[1], decimals0, bal0 });
  },
);

const client = createPublicClient({ chain: mainnet, transport: http() });
const out = await client.readContract({
  ...poolMeta.compile().toViem(), // { abi, code } — deployless eth_call
  functionName: 'poolMeta',
  args: [pool, user], // typed readonly [pool: `0x${string}`, user: `0x${string}`]
});
// out: { token0: `0x${string}`; symbol0: string; tick: number; decimals0: number; bal0: bigint }
```

No `as const` on the script, no codegen step: the script is its own literal-typed ABI.

## Execution modes

```ts
const compiled = poolMeta.compile();

// Deployless (default): plain 2-parameter eth_call — works on every standard RPC provider.
await client.readContract({ ...compiled.toViem(), functionName, args });

// State override: stable address(this), controllable msg.sender via `account`,
// composable with further overrides. Uses eth_call's third parameter — supported by
// geth/anvil/QuickNode/publicnode; NOT documented on Alchemy/Infura eth_call.
await client.readContract({
  ...compiled.toViem({ mode: 'stateOverride' }),
  functionName,
  args,
  account: caller,
});
```

Both modes are just `eth_call`: historical reads via `blockNumber` work, nothing is ever
deployed, and gas is bounded only by the node's `eth_call` cap.

> [!WARNING]
> **`s.env('caller')` / `s.env('address')` are execution-frame-dependent.** In the default
> deployless mode the script runs inside viem's wrapper: `s.env('caller')` is the wrapper
> contract (never your `account`) and `s.env('address')` is a per-script counterfactual
> CREATE2 address — neither is controllable, and a read like `balanceOf(s.env('caller'))`
> silently returns the wrapper's (zero) balance. Caller-relative reads require
> `toViem({ mode: 'stateOverride' })` with the `account` call parameter; there is no
> deployless workaround. `compile()` warns (`ENV_FRAME_DEPENDENT` via `onDiagnostic`) when a
> script uses these env ops. `timestamp`/`blocknumber`/`chainid` are identical in both modes.

## The one rule to remember

> [!WARNING]
> **Native JS `if`/`for`/`&&` does NOT branch on EVM values.** The builder callback runs once,
> at build time; chain values are typed `Expr` handles. `if (someExpr)` is always truthy and
> records the branch unconditionally — JS cannot trap it. Use `s.if` / `s.while` / `s.for` /
> `s.select` for runtime values; plain JS control flow only over build-time values. Other
> misuses (`x + 1`, `` `${x}` ``, `JSON.stringify(x)`) throw `EvsStagingError` at the
> offending line, and the `typescript/strict-boolean-expressions` lint closes the truthiness
> gap.

## More

- Checked arithmetic (solc ≥ 0.8 `Panic` semantics), checked narrowing conversions.
- `s.tryCall` → `{ success, value }` with safe zero defaults; callee reverts bubble verbatim.
- Loops over runtime arrays + `s.newArray` collection — the multicall replacement.
- `compile({ evmVersion: 'paris' | 'shanghai' | 'cancun' })` for pre-Shanghai chains.
- Inspectable artifact: `disassemble().format()`, `sourceMap`, `explainRevert(data)` mapping
  reverts back to your source lines.

Docs, examples and the full API: **<https://github.com/maxencerb/evs>**

## License

MIT © Maxence Raballand
