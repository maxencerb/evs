/**
 * E1 — Flagship: Uniswap-V3-style pool metadata in ONE eth_call round trip
 * (docs/design/api.md §11). Data flows BETWEEN calls on-chain (pool → token0 → symbol),
 * which a multicall cannot do; the result comes back as one fully-typed object.
 *
 * Run: bun examples/pool-meta/index.ts   (spawns a local anvil, no configuration needed)
 */

import { erc20Abi, parseEther } from 'viem';

import { evscript, arg, t } from '@maxencerb/evs';
import { startAnvil } from '@maxencerb/evs-examples-shared/run-anvil';

import { MockERC20, MockUniV3Pool } from '../../packages/evs/test/generated/index.js';

const poolMeta = evscript(
  { name: 'poolMeta', args: [arg('pool', t.address), arg('user', t.address)] },
  (s) => {
    const token0 = s.call({ address: s.args.pool, abi: MockUniV3Pool.abi, functionName: 'token0' });
    const token1 = s.call({ address: s.args.pool, abi: MockUniV3Pool.abi, functionName: 'token1' });
    const fee = s.call({ address: s.args.pool, abi: MockUniV3Pool.abi, functionName: 'fee' });
    const slot0 = s.call({ address: s.args.pool, abi: MockUniV3Pool.abi, functionName: 'slot0' });
    const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' });
    const symbol1 = s.call({ address: token1, abi: erc20Abi, functionName: 'symbol' });
    const dec = s.tryCall({ address: token0, abi: erc20Abi, functionName: 'decimals' });
    const decimals0 = s.select(dec.success, dec.value, 18); // default on failure
    const bal0 = s.call({
      address: token0,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [s.args.user],
    });
    return s.return({ token0, token1, fee, symbol0, symbol1, tick: slot0[1], decimals0, bal0 });
  },
);

const chain = await startAnvil();
try {
  // Fixture state: two tokens + a pool, a balance for the user.
  const usdc = await chain.deploy(MockERC20.abi, MockERC20.bytecode, ['USD Coin', 'USDC', 6]);
  const weth = await chain.deploy(MockERC20.abi, MockERC20.bytecode, ['Wrapped Ether', 'WETH', 18]);
  const pool = await chain.deploy(MockUniV3Pool.abi, MockUniV3Pool.bytecode, [usdc, weth, 500, 10]);
  await chain.write({
    address: pool,
    abi: MockUniV3Pool.abi,
    functionName: 'setSlot0',
    args: [79_228_162_514_264_337_593_543_950_336n, 200_000, 0, 1, 1, 0, true],
  });
  await chain.write({
    address: usdc,
    abi: MockERC20.abi,
    functionName: 'mint',
    args: [chain.account.address, parseEther('1000')],
  });

  // ONE deployless eth_call; `out` is fully typed from the generated literal ABI.
  const compiled = poolMeta.compile();
  const out = await chain.client.readContract({
    ...compiled.toViem(), // { abi, code } — deployless, works on any standard RPC
    functionName: 'poolMeta',
    args: [pool, chain.account.address],
  });

  console.log('poolMeta →', out);
  console.log(`runtime bytecode: ${(compiled.runtimeBytecode.length - 2) / 2} bytes`);
} finally {
  await chain.stop();
}
