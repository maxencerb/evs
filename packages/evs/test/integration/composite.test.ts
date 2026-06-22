/**
 * Composite-types end-to-end integration (spec §9, testing.md §3/§7).
 *
 * Runs builder-compiled read scripts against a REAL solc-0.8.30 `Composite` deployment on
 * anvil — the byte-exact differential oracle already proves codec parity, this tier proves
 * the whole pipeline (encode args → eth_call → decode tuple output → typed object) works on
 * production-shaped ABIs through every toViem path:
 *   - struct OUTPUT decode + named/nested field reads (positions / slot0Struct / getOuter),
 *   - composite ARG encode against real solc (quote(QuoteParams)),
 *   - the bubbled `EvsDecodeError` failure path (positions at an EOA → explainRevert).
 *
 * Determinism: every expected value is re-derived from the same primitives the contract uses
 * (keccak of abi.encodePacked / abi.encode), so the assertions track Composite.sol exactly.
 */

import { encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, keccak256 } from 'viem';
import { beforeAll, describe, expect, expectTypeOf, test } from 'vitest';

import { evscript, t } from '../../src/index.js';
import { Composite } from '../generated/index.js';
import { publicClient, testClient } from '../harness/anvil.js';
import { callExpectRevert, deploy, deployer } from './helpers.js';

let composite: `0x${string}`;

beforeAll(async () => {
  composite = await deploy(Composite.abi, Composite.bytecode);
});

// --- deterministic derivations (mirror Composite.sol exactly) ----------------------------

/** Position derived from a tokenId — the on-chain `positions(tokenId)` derivation. */
function derivePosition(tokenId: bigint): {
  nonce: bigint;
  operator: `0x${string}`;
  liquidity: bigint;
  feeGrowthInside0: bigint;
  feeGrowthInside1: bigint;
} {
  const u96 = (1n << 96n) - 1n;
  const u128 = (1n << 128n) - 1n;
  const u160 = (1n << 160n) - 1n;
  const operatorInt = (tokenId * 3n + 1n) & u160;
  return {
    nonce: tokenId & u96,
    operator: getAddress(`0x${operatorInt.toString(16).padStart(40, '0')}`),
    liquidity: (tokenId * 1000n + 7n) & u128,
    feeGrowthInside0: BigInt(keccak256(encodePacked(['string', 'uint256'], ['fee0', tokenId]))),
    feeGrowthInside1: BigInt(keccak256(encodePacked(['string', 'uint256'], ['fee1', tokenId]))),
  };
}

// --- positions(tokenId): struct OUTPUT → named field reads, ALL THREE paths ---------------

const TOKEN_ID = 0xdeadn;

// the target address and tokenId are runtime args (the deployment address is only known in
// beforeAll); the struct field reads are what this case exercises.
const readPosition = evscript(
  { name: 'readPosition', args: [t.address, t.uint256] },
  (s, target, tokenId) => {
    const pos = s.call({
      address: target,
      abi: Composite.abi,
      functionName: 'positions',
      args: [tokenId],
    });
    return s.return({
      nonce: pos.nonce.get(),
      operator: pos.operator.get(),
      liquidity: pos.liquidity.get(),
      feeGrowthInside0: pos.feeGrowthInside0.get(),
      feeGrowthInside1: pos.feeGrowthInside1.get(),
    });
  },
);

describe('positions(tokenId): struct output decode + named fields, all three toViem paths', () => {
  const compiled = readPosition.compile();

  const expected = () => {
    const p = derivePosition(TOKEN_ID);
    return {
      nonce: p.nonce,
      operator: p.operator,
      liquidity: p.liquidity,
      feeGrowthInside0: p.feeGrowthInside0,
      feeGrowthInside1: p.feeGrowthInside1,
    };
  };

  test('deployless (default toViem)', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'readPosition',
      args: [composite, TOKEN_ID],
    });
    expect(out).toStrictEqual(expected());

    // Full inference pinned at the type level: uint96/uint128/uint256 → bigint, address → hex.
    expectTypeOf(out).toEqualTypeOf<{
      nonce: bigint;
      operator: `0x${string}`;
      liquidity: bigint;
      feeGrowthInside0: bigint;
      feeGrowthInside1: bigint;
    }>();
  });

  test('stateOverride', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride' }),
      functionName: 'readPosition',
      args: [composite, TOKEN_ID],
    });
    expect(out).toStrictEqual(expected());
  });

  test('deployless code via anvil_setCode', async () => {
    const at = '0x00000000000000000000000000000000000c0001' as const;
    await testClient.setCode({ address: at, bytecode: compiled.runtimeBytecode });
    const out = await publicClient.readContract({
      address: at,
      abi: compiled.abi,
      functionName: 'readPosition',
      args: [composite, TOKEN_ID],
    });
    expect(out).toStrictEqual(expected());
  });
});

// --- slot0Struct(): static struct → int24 field (signed word) ----------------------------

describe('slot0Struct(): tick field (int24 → number)', () => {
  const readTick = evscript({ name: 'readTick', args: t.address }, (s, target) => {
    const slot0 = s.call({ address: target, abi: Composite.abi, functionName: 'slot0Struct' });
    return s.return({ tick: slot0.tick.get() });
  });

  test('returns the negative MIN_TICK through a struct field handle', async () => {
    const compiled = readTick.compile();
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'readTick',
      args: [composite],
    });
    expect(out).toStrictEqual({ tick: -887_272 });
    expectTypeOf(out).toEqualTypeOf<{ tick: number }>();
  });
});

// --- getOuter(): NESTED struct → nested field read ----------------------------------------

describe('getOuter(): nested struct field (outer.inner.b)', () => {
  const readInnerB = evscript({ name: 'readInnerB', args: t.address }, (s, target) => {
    const outer = s.call({ address: target, abi: Composite.abi, functionName: 'getOuter' });
    return s.return({ b: outer.inner.get().b.get() });
  });

  test('reads a bytes32 out of the inner struct', async () => {
    const compiled = readInnerB.compile();
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'readInnerB',
      args: [composite],
    });
    expect(out).toStrictEqual({
      b: keccak256(encodePacked(['string'], ['evs.composite.outer.inner'])),
    });
    expectTypeOf(out).toEqualTypeOf<{ b: `0x${string}` }>();
  });
});

// --- quote(QuoteParams): composite ARG encode against real solc ---------------------------

// the QuoteParams tuple descriptor, byte-identical to Composite.abi's `quote` input[0] (carries
// `internalType` so the s.tuple handle matches the abi's tuple-arg input type exactly).
const QuoteParams = {
  type: 'tuple',
  components: [
    { type: 'address', name: 'tokenIn', internalType: 'address' },
    { type: 'address', name: 'tokenOut', internalType: 'address' },
    { type: 'uint24', name: 'fee', internalType: 'uint24' },
    { type: 'uint256', name: 'amountIn', internalType: 'uint256' },
  ],
} as const;

describe('quote(QuoteParams): composite input encode + (uint256, Position) output', () => {
  const TOKEN_IN = getAddress('0x00000000000000000000000000000000000000a1');
  const TOKEN_OUT = getAddress('0x00000000000000000000000000000000000000b2');
  const FEE = 3000;
  const AMOUNT_IN = 1_000_000_000_000_000_000n; // 1e18

  // build the QuoteParams via s.tuple(...) (alloc + zero-fill + MSTORE each member, the Expr args
  // flowing into the field slots) and pass the Tuple handle to quote(params) — proves composite-arg
  // ENCODE flows out as calldata that real solc decodes. The destructured outputs (amountOut, pos)
  // cover the mixed (word, tuple) OUTPUT decode in one shot.
  const runQuote = evscript(
    { name: 'runQuote', args: [t.address, t.address, t.address, t.uint24, t.uint256] },
    (s, target, tokenIn, tokenOut, fee, amountIn) => {
      const params = s.tuple(QuoteParams, { tokenIn, tokenOut, fee, amountIn });
      const [amountOut, pos] = s.call({
        address: target,
        abi: Composite.abi,
        functionName: 'quote',
        args: [params],
      });
      return s.return({
        amountOut,
        posOperator: pos.operator.get(),
        posLiquidity: pos.liquidity.get(),
        posNonce: pos.nonce.get(),
      });
    },
  );

  const expected = () => {
    const amountOut = (AMOUNT_IN * BigInt(FEE)) / 1_000_000n;
    const seed = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'uint256' }],
          [TOKEN_IN, TOKEN_OUT, FEE, AMOUNT_IN],
        ),
      ),
    );
    return {
      amountOut,
      posOperator: TOKEN_IN,
      posLiquidity: amountOut & ((1n << 128n) - 1n),
      posNonce: seed & ((1n << 96n) - 1n),
    };
  };

  test('encodes the struct arg solc decodes; derived pos matches', async () => {
    const compiled = runQuote.compile();
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'runQuote',
      args: [composite, TOKEN_IN, TOKEN_OUT, FEE, AMOUNT_IN],
    });
    expect(out).toStrictEqual(expected());
    expectTypeOf(out).toEqualTypeOf<{
      amountOut: bigint;
      posOperator: `0x${string}`;
      posLiquidity: bigint;
      posNonce: bigint;
    }>();
  });
});

// --- failure path: positions at an EOA → bubbled EvsDecodeError ----------------------------

describe('failure path: positions at an EOA → EvsDecodeError', () => {
  test('explainRevert decodes the bubbled error as evs-decode', async () => {
    const compiled = readPosition.compile();
    const overrideParams = compiled.toViem({ mode: 'stateOverride' });
    const raw = await callExpectRevert({
      to: overrideParams.address,
      stateOverride: overrideParams.stateOverride,
      data: encodeFunctionData({
        abi: compiled.abi,
        functionName: 'readPosition',
        // deployer is a funded EOA (no code) → the positions() call has nothing to decode.
        args: [deployer.address, TOKEN_ID],
      }),
    });
    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    const site = explained.site;
    expect(site).toBeDefined();
    if (site !== undefined && site.loc !== null) {
      expect(site.loc.file).toContain('composite.test.ts');
    }
  });
});
