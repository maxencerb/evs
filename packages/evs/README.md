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
  <a href="https://evs.maxencerb.com/examples/pool-metadata/">Examples</a>
  ·
  <a href="https://github.com/maxencerb/evs/blob/main/packages/evs/CHANGELOG.md">Changelog</a>
</p>

# @maxencerb/evs

evs compiles a TypeScript callback to EVM bytecode that runs in a single `eth_call`. You write
reads against a small builder API, and viem infers the arguments and the result.

A multicall batches reads, but it cannot feed one call's result into the next: a pool's `token0`,
then that token's `symbol`, takes two round trips. An evs script runs that chain on-chain, in one.

## Install

```sh
npm install @maxencerb/evs viem
```

ESM only. Requires `viem` ≥ 2.14.1, TypeScript ≥ 5.5 in `strict` mode, and Node ≥ 20.19 (or Bun).

## Quick start

Read a Uniswap V3 pool's two tokens, then each token's symbol: four reads, two of which target
addresses returned by the first two.

```ts
import { compile, evscript, t } from '@maxencerb/evs';
import { createPublicClient, erc20Abi, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const poolTokens = evscript({ name: 'poolTokens', args: [t.address] }, (s, pool) => {
  const token0 = s.read({ address: pool, abi: poolAbi, functionName: 'token0' });
  const token1 = s.read({ address: pool, abi: poolAbi, functionName: 'token1' });
  // token0 and token1 exist only on-chain: they are the targets of the next two reads
  const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
  const symbol1 = s.read({ address: token1, abi: erc20Abi, functionName: 'symbol' });
  return s.return({ token0, token1, symbol0, symbol1 });
});

const client = createPublicClient({ chain: mainnet, transport: http() });
const compiled = compile(poolTokens);

const result = await client.readContract({
  ...compiled.toViem(),
  functionName: 'poolTokens',
  args: ['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'], // USDC/WETH 0.05% pool
});
// { token0: `0x${string}`; token1: `0x${string}`; symbol0: string; symbol1: string }
```

The callback runs once, to record the script. `token0` is an `Expr<'address'>`: a handle to a value
that only exists during the call. viem infers `result` from what you pass to `s.return`.

## What you get

- **One round trip.** Dependent reads, loops and branches run inside a single `eth_call`.
- **Typed end to end.** viem infers the arguments and the result from the script itself.
- **Nothing to deploy.** The bytecode travels with the call and runs on any standard RPC node.
- **Three calling verbs.** Read a view, call a non-view function, or dry-run a write.
- **Solidity 0.8 semantics.** Checked arithmetic, standard panic codes, reverts bubbled unchanged.
- **Verified, debuggable bytecode.** Checked on every compile. `explainRevert()` locates a revert.

## Calling contracts

| Verb         | Opcode       | Functions               | State changes                         |
| ------------ | ------------ | ----------------------- | ------------------------------------- |
| `s.read`     | `STATICCALL` | `view`, `pure`          | None possible                         |
| `s.call`     | `CALL`       | `nonpayable`, `payable` | Kept for the rest of the script       |
| `s.simulate` | `CALL`       | `nonpayable`, `payable` | Rolled back, the return value is kept |

Each verb has a `try*` variant, such as `s.tryRead`, that returns `{ success, value }` instead of
reverting. Nothing is ever committed: the whole script runs inside one `eth_call`.

## Execution modes

| Mode                 | `toViem` argument           | Provider support                      | `msg.sender`           |
| -------------------- | --------------------------- | ------------------------------------- | ---------------------- |
| Deployless (default) | None                        | Every standard `eth_call`             | A wrapper contract     |
| State override       | `{ mode: 'stateOverride' }` | Nodes with `eth_call` state overrides | The `account` you pass |

Switch to state override when the script reads `msg.sender`, and pass the sender as `account`.

```ts
await client.readContract({
  ...compiled.toViem({ mode: 'stateOverride' }),
  functionName: 'poolTokens',
  args: ['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'],
  account: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // the script's msg.sender
});
```

State override also lifts the 24,576-byte cap that deployless mode puts on the result: see
[deployless limits](https://evs.maxencerb.com/guides/execution/#deployless-limits). Not every
provider supports it: see the
[provider matrix](https://evs.maxencerb.com/guides/execution/#provider-support).

> [!WARNING]
> Two mistakes return a wrong result instead of an error:
>
> - A JS `if` does not branch on an `Expr`: the handle is an object, so the condition is always
>   truthy. Use `s.if` or `s.select`.
> - In deployless mode, a caller-relative read such as `balanceOf(s.env('caller'))` reads the
>   wrapper contract's balance, not yours. Use state override with `account`.

## Documentation

- [Quick start](https://evs.maxencerb.com/getting-started/quick-start/): a first script, end to end.
- [Guides](https://evs.maxencerb.com/guides/writing-scripts/): calls, control flow, debugging.
- [Builder reference](https://evs.maxencerb.com/reference/builder/): every `s.*` method.
- [Expr reference](https://evs.maxencerb.com/reference/expr/): arithmetic, comparisons, conversions.
- [Types reference](https://evs.maxencerb.com/reference/types/): the `t.*` type constructors.
- [Examples](https://evs.maxencerb.com/examples/pool-metadata/): complete, annotated programs.

## Runnable examples

The scripts in [`examples/`](https://github.com/maxencerb/evs/tree/main/examples) run on a local
anvil. They need [Foundry](https://getfoundry.sh), Node ≥ 22.18, pnpm and the git submodules.

```sh
git submodule update --init                  # once: forge-std
pnpm install && pnpm run build               # once, from the repo root
(cd packages/contracts && pnpm run codegen)  # once: builds the mock contracts
node examples/pool-meta/index.ts             # dependent reads on a Uniswap V3 pool mock
node examples/token-balances/index.ts        # balanceOf over a runtime address[]
```

## Contributing

See [CONTRIBUTING.md](https://github.com/maxencerb/evs/blob/main/CONTRIBUTING.md).

## License

MIT © Maxence Raballand
