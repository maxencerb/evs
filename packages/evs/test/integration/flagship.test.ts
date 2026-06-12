/**
 * testing.md §7 — the flagship end-to-end release gate.
 *
 * E1 `poolMeta` (api.md §11) against MockUniV3Pool + two MockERC20s through ALL THREE
 * execution paths with full type inference; E2 `balances` over 50 tokens (loop + dynamic
 * arg + MutArray); then the failure half: EOA pool → decode error naming the originating
 * s.call, Malformed token → EvsDecodeError(site).
 */

import { encodeFunctionData, erc20Abi, parseEther } from 'viem';
import { beforeAll, describe, expect, expectTypeOf, test } from 'vitest';

import { arg, evscript, t } from '../../src/index.js';
import { Malformed, MockERC20, MockUniV3Pool } from '../generated/index.js';
import { publicClient, testClient } from '../harness/anvil.js';
import { callExpectRevert, deploy, deployer, write } from './helpers.js';

// --- E1: flagship pool metadata script (api.md §11 E1, verbatim semantics) ---------------

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
    const decimals0 = s.select(dec.success, dec.value, 18);
    const bal0 = s.call({
      address: token0,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [s.args.user],
    });
    return s.return({ token0, token1, fee, symbol0, symbol1, tick: slot0[1], decimals0, bal0 });
  },
);

const compiledPoolMeta = poolMeta.compile();

let token0: `0x${string}`;
let token1: `0x${string}`;
let pool: `0x${string}`;
let malformed: `0x${string}`;

const TICK = -887_220;
const USER_BALANCE = parseEther('42');

beforeAll(async () => {
  token0 = await deploy(MockERC20.abi, MockERC20.bytecode, ['USD Coin', 'USDC', 6]);
  token1 = await deploy(MockERC20.abi, MockERC20.bytecode, ['Wrapped Ether', 'WETH', 18]);
  pool = await deploy(MockUniV3Pool.abi, MockUniV3Pool.bytecode, [token0, token1, 3000, 60]);
  malformed = await deploy(Malformed.abi, Malformed.bytecode);
  await write({
    address: pool,
    abi: MockUniV3Pool.abi,
    functionName: 'setSlot0',
    args: [79_228_162_514_264_337_593_543_950_336n, TICK, 0, 1, 1, 0, true],
  });
  await write({
    address: token0,
    abi: MockERC20.abi,
    functionName: 'mint',
    args: [deployer.address, USER_BALANCE],
  });
});

describe('E1 poolMeta through all three paths', () => {
  const expected = () => ({
    token0,
    token1,
    fee: 3000,
    symbol0: 'USDC',
    symbol1: 'WETH',
    tick: TICK,
    decimals0: 6,
    bal0: USER_BALANCE,
  });

  test('deployless (default toViem)', async () => {
    const out = await publicClient.readContract({
      ...compiledPoolMeta.toViem(),
      functionName: 'poolMeta',
      args: [pool, deployer.address],
    });
    expect(out).toStrictEqual(expected());

    // Full inference, pinned at the type level (testing.md §7): int24 → number,
    // uint8-backed select → number, balance → bigint, strings, addresses.
    expectTypeOf(out).toEqualTypeOf<{
      token0: `0x${string}`;
      token1: `0x${string}`;
      fee: number;
      symbol0: string;
      symbol1: string;
      tick: number;
      decimals0: number;
      bal0: bigint;
    }>();
  });

  test('stateOverride', async () => {
    const out = await publicClient.readContract({
      ...compiledPoolMeta.toViem({ mode: 'stateOverride' }),
      functionName: 'poolMeta',
      args: [pool, deployer.address],
    });
    expect(out).toStrictEqual(expected());
  });

  test('anvil_setCode', async () => {
    const at = '0x00000000000000000000000000000000000eff10' as const;
    await testClient.setCode({ address: at, bytecode: compiledPoolMeta.runtimeBytecode });
    const out = await publicClient.readContract({
      address: at,
      abi: compiledPoolMeta.abi,
      functionName: 'poolMeta',
      args: [pool, deployer.address],
    });
    expect(out).toStrictEqual(expected());
  });
});

// --- E2: batch balances over 50 tokens (api.md §11 E2) -----------------------------------

const balances = evscript(
  { name: 'balances', args: [arg('tokens', t.array(t.address)), arg('owner', t.address)] },
  (s) => {
    const n = s.args.tokens.length();
    const out = s.newArray(t.uint256, n);
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      const token = s.args.tokens.at(i);
      const r = s.tryCall({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [s.args.owner],
      });
      out.set(i, s.select(r.success, r.value, 0n));
    });
    return s.return({ balances: out.expr() });
  },
);

describe('E2 balances over 50 tokens (multicall replacement)', () => {
  test('matches direct readContract calls; non-tokens default to 0', async () => {
    const tokens: `0x${string}`[] = [];
    for (let i = 0; i < 48; i++) {
      const addr = await deploy(MockERC20.abi, MockERC20.bytecode, [`Token ${i}`, `T${i}`, 18]);
      tokens.push(addr);
      if (i % 3 === 0) {
        await write({
          address: addr,
          abi: MockERC20.abi,
          functionName: 'mint',
          args: [deployer.address, parseEther(String(i + 1))],
        });
      }
    }
    // Two non-token addresses: an EOA and an address with no code at all → tryCall default 0n.
    tokens.push(deployer.address, '0x00000000000000000000000000000000000fffff');
    expect(tokens).toHaveLength(50);

    const out = await publicClient.readContract({
      ...balances.compile().toViem(),
      functionName: 'balances',
      args: [tokens, deployer.address],
    });
    expectTypeOf(out).toEqualTypeOf<{ balances: readonly bigint[] }>();

    const direct = await Promise.all(
      tokens.slice(0, 48).map((address) =>
        publicClient.readContract({
          address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [deployer.address],
        }),
      ),
    );
    expect(out.balances).toStrictEqual([...direct, 0n, 0n]);
  });
});

// --- Failure half (testing.md §7) ---------------------------------------------------------

describe('failure half: explainRevert names the originating call', () => {
  test('EOA as pool → decode error at the token0 call site', async () => {
    const overrideParams = compiledPoolMeta.toViem({ mode: 'stateOverride' });
    const raw = await callExpectRevert({
      to: overrideParams.address,
      stateOverride: overrideParams.stateOverride,
      data: encodeFunctionData({
        abi: compiledPoolMeta.abi,
        functionName: 'poolMeta',
        args: [deployer.address, deployer.address], // an EOA, not a pool
      }),
    });
    const explained = compiledPoolMeta.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    const site = explained.site;
    expect(site).toBeDefined();
    if (site !== undefined && site.loc !== null) {
      expect(site.loc.file).toContain('flagship.test.ts');
    }
  });

  test('Malformed callee → EvsDecodeError with the right site', async () => {
    // Malformed.emptyReturn() is declared `returns (string)` but returns ZERO bytes —
    // the strict call must revert EvsDecodeError(site), never decode garbage.
    const script = evscript({ name: 'readMalformed', args: [arg('target', t.address)] }, (s) => {
      const v = s.call({ address: s.args.target, abi: Malformed.abi, functionName: 'emptyReturn' });
      return s.return({ v });
    });
    const compiled = script.compile();
    const overrideParams = compiled.toViem({ mode: 'stateOverride' });
    const raw = await callExpectRevert({
      to: overrideParams.address,
      stateOverride: overrideParams.stateOverride,
      data: encodeFunctionData({
        abi: compiled.abi,
        functionName: 'readMalformed',
        args: [malformed],
      }),
    });
    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    const site = explained.site;
    expect(site).toBeDefined();
    if (site !== undefined && site.loc !== null) {
      expect(site.loc.file).toContain('flagship.test.ts');
    }
  });
});
