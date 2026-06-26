/**
 * E1 — Flagship: Uniswap-V3-style pool metadata in ONE eth_call round trip
 * (docs/design/api.md §11). Data flows BETWEEN calls on-chain (pool → token0 → symbol),
 * which a multicall cannot do; the result comes back as one fully-typed object.
 *
 * Also showcases a STRUCT-returning getter: `Composite.slot0Struct()` decodes into a
 * `Tuple` handle whose fields are read by name (`slot0.tick.get()`, fully typed `int24`).
 *
 * Args arrive as positional callback params after `s` — no `s.args`.
 *
 * Run: bun examples/pool-meta/index.ts   (spawns a local anvil, no configuration needed)
 */

import { erc20Abi, parseEther } from 'viem';

import { evscript, t } from '@maxencerb/evs';
import { startAnvil } from '@maxencerb/evs-examples-shared/run-anvil';

import { Composite, MockERC20, MockUniV3Pool } from '../../packages/evs/test/generated/index.js';

// `args: [t.address, t.address]` → the body callback receives `(s, pool, user)` positionally.
const poolMeta = evscript({ name: 'poolMeta', args: [t.address, t.address] }, (s, pool, user) => {
  const token0 = s.read({ address: pool, abi: MockUniV3Pool.abi, functionName: 'token0' });
  const token1 = s.read({ address: pool, abi: MockUniV3Pool.abi, functionName: 'token1' });
  const fee = s.read({ address: pool, abi: MockUniV3Pool.abi, functionName: 'fee' });
  // MockUniV3Pool.slot0() returns 7 FLAT outputs, so `slot0` is a readonly tuple of Exprs
  // accessed positionally — `slot0[1]` is the int24 tick. (Compare the struct getter below.)
  const slot0 = s.read({ address: pool, abi: MockUniV3Pool.abi, functionName: 'slot0' });
  const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
  const symbol1 = s.read({ address: token1, abi: erc20Abi, functionName: 'symbol' });
  const dec = s.tryRead({ address: token0, abi: erc20Abi, functionName: 'decimals' });
  const decimals0 = s.select(dec.success, dec.value, 18); // default on failure
  const bal0 = s.read({
    address: token0,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [user],
  });
  return s.return({ token0, token1, fee, symbol0, symbol1, tick: slot0[1], decimals0, bal0 });
});

// A second script showing a STRUCT-returning getter decoded into a `Tuple` handle: the
// `'tuple'` output of `slot0Struct()` becomes a handle whose fields are read by name.
const poolSlot0 = evscript({ name: 'poolSlot0', args: [t.address] }, (s, composite) => {
  const slot0 = s.read({ address: composite, abi: Composite.abi, functionName: 'slot0Struct' });
  return s.return({
    sqrtPriceX96: slot0.sqrtPriceX96.get(), // Expr<'uint160'>
    tick: slot0.tick.get(), // Expr<'int24'>
    unlocked: slot0.unlocked.get(), // Expr<'bool'>
    slot0, // a Tuple handle is returnable directly — the whole struct flows out, abitype-typed
  });
});

const chain = await startAnvil();
try {
  // Fixture state: two tokens + a pool, a balance for the user, and a Composite for the struct.
  const usdc = await chain.deploy(MockERC20.abi, MockERC20.bytecode, ['USD Coin', 'USDC', 6]);
  const weth = await chain.deploy(MockERC20.abi, MockERC20.bytecode, ['Wrapped Ether', 'WETH', 18]);
  const pool = await chain.deploy(MockUniV3Pool.abi, MockUniV3Pool.bytecode, [usdc, weth, 500, 10]);
  const composite = await chain.deploy(Composite.abi, Composite.bytecode);
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

  // The struct getter: `slot0` comes back as a typed object (named struct members).
  const slot0Out = await chain.client.readContract({
    ...poolSlot0.compile().toViem(),
    functionName: 'poolSlot0',
    args: [composite],
  });
  console.log('poolSlot0 →', slot0Out);
} finally {
  await chain.stop();
}
