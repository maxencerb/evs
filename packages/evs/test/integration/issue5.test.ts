/**
 * Issue #5 ergonomics — the flagship Uniswap V3 multi-pool metadata reader, end-to-end on anvil.
 *
 * This is the issue's motivating example, rewritten to use every ergonomic improvement at once,
 * against REAL solc-0.8.30 deployments (`MockUniV3Pool` + `MockERC20`) decoded through viem:
 *   - #1 `s.fn` returns a `t.struct` directly (`getTokenMetadata` → `TokenMetadata`);
 *   - #2 `s.call({ …, struct: true })` decodes the 7-output `slot0()` into one named Tuple;
 *   - #3 the struct-decoded `slot0` flows straight into the `PoolMetadata` struct slot;
 *   - #4 `t.fromOutputs(MockUniV3Pool.abi, 'slot0')` derives `Slot0` from the ABI (no re-typing);
 *   - #5 `s.return({ metadata })` returns the `MutArray` bare (no `.expr()`).
 */

import { getAddress } from 'viem';
import { beforeAll, describe, expect, expectTypeOf, test } from 'vitest';

import { arg, evscript, t } from '../../src/index.js';
import { MockERC20, MockUniV3Pool } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, write } from './helpers.js';

// --- on-chain fixtures (deployed once) -----------------------------------------------------

interface PoolFixture {
  readonly address: `0x${string}`;
  readonly token0: { address: `0x${string}`; symbol: string; decimals: number };
  readonly token1: { address: `0x${string}`; symbol: string; decimals: number };
  readonly fee: number;
  readonly slot0: {
    sqrtPriceX96: bigint;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
    observationCardinalityNext: number;
    feeProtocol: number;
    unlocked: boolean;
  };
}

let pools: PoolFixture[] = [];

async function deployToken(name: string, symbol: string, decimals: number): Promise<`0x${string}`> {
  return deploy(MockERC20.abi, MockERC20.bytecode, [name, symbol, decimals]);
}

async function deployPool(
  t0: { address: `0x${string}`; symbol: string; decimals: number },
  t1: { address: `0x${string}`; symbol: string; decimals: number },
  fee: number,
  slot0: PoolFixture['slot0'],
): Promise<PoolFixture> {
  const address = await deploy(MockUniV3Pool.abi, MockUniV3Pool.bytecode, [
    t0.address,
    t1.address,
    fee,
    60, // tickSpacing (not part of slot0)
  ]);
  await write({
    address,
    abi: MockUniV3Pool.abi,
    functionName: 'setSlot0',
    args: [
      slot0.sqrtPriceX96,
      slot0.tick,
      slot0.observationIndex,
      slot0.observationCardinality,
      slot0.observationCardinalityNext,
      slot0.feeProtocol,
      slot0.unlocked,
    ],
  });
  return { address, token0: t0, token1: t1, fee, slot0 };
}

beforeAll(async () => {
  const weth = {
    address: await deployToken('Wrapped Ether', 'WETH', 18),
    symbol: 'WETH',
    decimals: 18,
  };
  const usdc = { address: await deployToken('USD Coin', 'USDC', 6), symbol: 'USDC', decimals: 6 };
  const dai = { address: await deployToken('Dai', 'DAI', 18), symbol: 'DAI', decimals: 18 };
  pools = [
    await deployPool(weth, usdc, 3000, {
      sqrtPriceX96: 1n << 96n,
      tick: -887_272,
      observationIndex: 3,
      observationCardinality: 10,
      observationCardinalityNext: 20,
      feeProtocol: 0,
      unlocked: true,
    }),
    await deployPool(usdc, dai, 500, {
      sqrtPriceX96: (1n << 96n) + 12_345n,
      tick: 60,
      observationIndex: 1,
      observationCardinality: 2,
      observationCardinalityNext: 4,
      feeProtocol: 6,
      unlocked: false,
    }),
  ];
});

// --- the flagship script: every ergonomic improvement at once ------------------------------

// #4 — derive Slot0 from the ABI's slot0() outputs instead of re-typing the 7 fields.
const Slot0 = t.fromOutputs(MockUniV3Pool.abi, 'slot0');
const TokenMetadata = t.struct({ address: t.address, symbol: t.string, decimals: t.uint8 });
const PoolMetadata = t.struct({
  token0: TokenMetadata,
  token1: TokenMetadata,
  fee: t.uint24,
  slot0: Slot0,
});

const poolsData = evscript({ name: 'poolsData', args: t.array(t.address) }, (s, addrs) => {
  // #1 — the fn builds and returns the struct; the call site gets a usable TokenMetadata Tuple.
  const getTokenMetadata = s.fn('getTokenMetadata', [arg('token', t.address)] as const, (token) =>
    s.tuple(TokenMetadata, {
      address: token,
      symbol: s.call({ address: token, abi: MockERC20.abi, functionName: 'symbol' }),
      decimals: s.call({ address: token, abi: MockERC20.abi, functionName: 'decimals' }),
    }),
  );
  const len = addrs.length();
  const metadata = s.newArray(PoolMetadata, len);
  s.for({ type: t.uint256, from: 0n, until: len }, (i) => {
    const pool = addrs.at(i);
    const token0Address = s.call({ address: pool, abi: MockUniV3Pool.abi, functionName: 'token0' });
    const token1Address = s.call({ address: pool, abi: MockUniV3Pool.abi, functionName: 'token1' });
    const fee = s.call({ address: pool, abi: MockUniV3Pool.abi, functionName: 'fee' });
    // #2 — `struct: true` decodes the 7 named outputs into one Slot0-shaped Tuple.
    const slot0 = s.call({
      address: pool,
      abi: MockUniV3Pool.abi,
      functionName: 'slot0',
      struct: true,
    });
    const token0 = getTokenMetadata(token0Address);
    const token1 = getTokenMetadata(token1Address);
    // #3 — `slot0` flows straight into the struct slot (no positional destructure + rebuild).
    metadata.set(i, s.tuple(PoolMetadata, { token0, token1, fee, slot0 }));
  });
  // #5 — return the MutArray bare (no `.expr()`).
  return s.return({ metadata });
});

/** The decoded shape evs should return for a set of pool fixtures (addresses checksummed by viem). */
function expected(fs: readonly PoolFixture[]) {
  return fs.map((p) => ({
    token0: {
      address: getAddress(p.token0.address),
      symbol: p.token0.symbol,
      decimals: p.token0.decimals,
    },
    token1: {
      address: getAddress(p.token1.address),
      symbol: p.token1.symbol,
      decimals: p.token1.decimals,
    },
    fee: p.fee,
    slot0: { ...p.slot0 },
  }));
}

describe('flagship: Uniswap V3 multi-pool metadata reader (issue #5)', () => {
  const compiled = poolsData.compile();

  test('reads all five ergonomic improvements end-to-end and decodes to a typed object array', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'poolsData',
      args: [pools.map((p) => p.address)],
    });
    expect(out).toStrictEqual({ metadata: expected(pools) });

    // the consumer-visible inference: a fully-typed array of nested structs.
    expectTypeOf(out).toEqualTypeOf<{
      metadata: readonly {
        token0: { address: `0x${string}`; symbol: string; decimals: number };
        token1: { address: `0x${string}`; symbol: string; decimals: number };
        fee: number;
        slot0: {
          sqrtPriceX96: bigint;
          tick: number;
          observationIndex: number;
          observationCardinality: number;
          observationCardinalityNext: number;
          feeProtocol: number;
          unlocked: boolean;
        };
      }[];
    }>();
  });

  test('an empty pool list returns an empty array', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'poolsData',
      args: [[]],
    });
    expect(out).toStrictEqual({ metadata: [] });
  });

  test('a single-pool read matches the deployed slot0 + token metadata exactly', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'poolsData',
      args: [[pools[0]!.address]],
    });
    expect(out).toStrictEqual({ metadata: expected([pools[0]!]) });
  });
});
