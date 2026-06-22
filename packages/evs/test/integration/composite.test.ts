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

// --- composite arrays READ PATH: real-solc getters → derived words ------------------------
//
// Each compiled evs script eth_calls a composite-array getter on the REAL deployment and returns
// a DERIVED WORD (len / an element field / an element length) — composite-array encode is the next
// milestone, so we never return a whole composite array. Expected values mirror Composite.sol.

// loose handle shapes for the composite-array read corpus: composite-array call outputs are decoded
// into array/tuple read handles; the read calls (`.length()`/`.at()`/`.field.get()`) flow derived
// words back out. (The precise abitype inference of these handles is pinned by the type tests.)
interface FieldLike {
  get(): { length(): unknown } & Record<string, FieldLike>;
}
interface ArrLike {
  length(): unknown;
  at(i: bigint): ArrLike & Record<string, FieldLike> & { length(): unknown };
}
const asArr = (v: unknown): ArrLike => v as ArrLike;
/** A named tuple field of an element handle (Tuple handles expose fields as own properties). */
const fld = (el: unknown, name: string): FieldLike => (el as Record<string, FieldLike>)[name]!;
/** Tags a resolved read value as a returnable Expr for the loose corpus scripts. */
const ret = (v: unknown): never => v as never;

describe('composite arrays (read path) against real solc getters', () => {
  test('positionsBatch(3)[1].liquidity + nonce + len (static-element tuple[])', async () => {
    const script = evscript({ name: 'rdPositions', args: t.address }, (s, target) => {
      const ps = asArr(
        s.call({ address: target, abi: Composite.abi, functionName: 'positionsBatch', args: [3n] }),
      );
      const p1 = ps.at(1n);
      return s.return({
        len: ret(ps.length()),
        liquidity1: ret(fld(p1, 'liquidity').get()),
        nonce1: ret(fld(p1, 'nonce').get()),
      });
    });
    const compiled = script.compile();
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'rdPositions',
      args: [composite],
    });
    expect(out).toStrictEqual({
      len: 3n,
      liquidity1: 1n * 1000n + 7n, // uint128(i*1000+7), i=1
      nonce1: 1n, // uint96(i), i=1
    });
  });

  test('withBytesBatch(3)[2].id + blob length (dynamic-member tuple[])', async () => {
    const script = evscript({ name: 'rdWithBytes', args: t.address }, (s, target) => {
      const xs = asArr(
        s.call({ address: target, abi: Composite.abi, functionName: 'withBytesBatch', args: [3n] }),
      );
      const e2 = xs.at(2n);
      return s.return({
        len: ret(xs.length()),
        id2: ret(fld(e2, 'id').get()),
        blob2len: ret(fld(e2, 'data').get().length()),
      });
    });
    const compiled = script.compile();
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'rdWithBytes',
      args: [composite],
    });
    expect(out).toStrictEqual({
      len: 3n,
      id2: 2n + 0xc0ffeen, // id = i + 0xC0FFEE, i=2
      blob2len: 2n, // data = new bytes(i), i=2
    });
  });

  test('matrix(5): outer row count + a nested cell (uint256[][])', async () => {
    const script = evscript({ name: 'rdMatrix', args: t.address }, (s, target) => {
      const m = asArr(
        s.call({ address: target, abi: Composite.abi, functionName: 'matrix', args: [5n] }),
      );
      const row3 = m.at(3n); // row 3 length = (3 % 4) + 1 = 4
      return s.return({
        rows: ret(m.length()),
        row3len: ret(row3.length()),
        row3at2: ret(row3.at(2n)),
      });
    });
    const compiled = script.compile();
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'rdMatrix',
      args: [composite],
    });
    expect(out).toStrictEqual({
      rows: 5n,
      row3len: 4n,
      row3at2: BigInt(
        keccak256(encodePacked(['string', 'uint256', 'uint256'], ['matrix', 3n, 2n])),
      ),
    });
  });

  test('names(4)[2] length + outer count (string[])', async () => {
    const script = evscript({ name: 'rdNames', args: t.address }, (s, target) => {
      const ns = asArr(
        s.call({ address: target, abi: Composite.abi, functionName: 'names', args: [4n] }),
      );
      return s.return({
        count: ret(ns.length()),
        name2len: ret(ns.at(2n).length()), // "2-2-2" = 5 bytes
        name0len: ret(ns.at(0n).length()), // "0" = 1 byte
      });
    });
    const compiled = script.compile();
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'rdNames',
      args: [composite],
    });
    expect(out).toStrictEqual({
      count: 4n,
      name2len: 5n,
      name0len: 1n,
    });
  });
});

// --- composite arrays RETURN PATH: real-solc getters → return the WHOLE array -------------
//
// Each compiled evs script eth_calls a composite-array getter on the REAL deployment and returns
// the WHOLE decoded array (§12.7 encode). The solc-derived ground truth is the SAME getter read
// directly through viem; the evs-script result must deep-equal it across all three toViem paths.

/** Loose returnable handle: a composite-array call output is an Expr at runtime (precise inference
 *  is pinned by the type tests). */
const whole = (v: unknown): never => v as never;

describe('composite arrays (return path) against real solc getters', () => {
  test('return whole positionsBatch(4) (static-element tuple[]) — all three toViem paths', async () => {
    const script = evscript({ name: 'retPositions', args: t.address }, (s, target) => {
      const ps = s.call({
        address: target,
        abi: Composite.abi,
        functionName: 'positionsBatch',
        args: [4n],
      });
      return s.return({ ps: whole(ps) });
    });
    const compiled = script.compile();
    // solc-derived ground truth: the same getter read directly.
    const expected = await publicClient.readContract({
      address: composite,
      abi: Composite.abi,
      functionName: 'positionsBatch',
      args: [4n],
    });

    const deployless = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'retPositions',
      args: [composite],
    });
    expect(deployless).toStrictEqual({ ps: expected });

    const override = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride' }),
      functionName: 'retPositions',
      args: [composite],
    });
    expect(override).toStrictEqual({ ps: expected });

    const at = '0x00000000000000000000000000000000000c0002' as const;
    await testClient.setCode({ address: at, bytecode: compiled.runtimeBytecode });
    const setCode = await publicClient.readContract({
      address: at,
      abi: compiled.abi,
      functionName: 'retPositions',
      args: [composite],
    });
    expect(setCode).toStrictEqual({ ps: expected });
  });

  test('return whole withBytesBatch(4) (dynamic-member tuple[])', async () => {
    const script = evscript({ name: 'retWithBytes', args: t.address }, (s, target) => {
      const xs = s.call({
        address: target,
        abi: Composite.abi,
        functionName: 'withBytesBatch',
        args: [4n],
      });
      return s.return({ xs: whole(xs) });
    });
    const compiled = script.compile();
    const expected = await publicClient.readContract({
      address: composite,
      abi: Composite.abi,
      functionName: 'withBytesBatch',
      args: [4n],
    });
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'retWithBytes',
      args: [composite],
    });
    expect(out).toStrictEqual({ xs: expected });
  });

  test('return whole matrix(6) (ragged uint256[][])', async () => {
    const script = evscript({ name: 'retMatrix', args: t.address }, (s, target) => {
      const m = s.call({ address: target, abi: Composite.abi, functionName: 'matrix', args: [6n] });
      return s.return({ m: whole(m) });
    });
    const compiled = script.compile();
    const expected = await publicClient.readContract({
      address: composite,
      abi: Composite.abi,
      functionName: 'matrix',
      args: [6n],
    });
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'retMatrix',
      args: [composite],
    });
    expect(out).toStrictEqual({ m: expected });
  });

  test('return whole names(5) (string[])', async () => {
    const script = evscript({ name: 'retNames', args: t.address }, (s, target) => {
      const ns = s.call({ address: target, abi: Composite.abi, functionName: 'names', args: [5n] });
      return s.return({ ns: whole(ns) });
    });
    const compiled = script.compile();
    const expected = await publicClient.readContract({
      address: composite,
      abi: Composite.abi,
      functionName: 'names',
      args: [5n],
    });
    const out = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'retNames',
      args: [composite],
    });
    expect(out).toStrictEqual({ ns: expected });
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
