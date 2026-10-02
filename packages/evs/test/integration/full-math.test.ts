/**
 * Wrapping arithmetic and `mulDiv` / `mulDivRoundingUp` vs solc 0.8.30.
 *
 * Every EvsFullMathReference function is paired with the equivalent evs script and driven with
 * the same boundary corpus on anvil: success values must match and revert payloads must be
 * BYTE-IDENTICAL. The wrapping pairs cover solc's `unchecked { … }` add / sub / mul on the
 * width classes with distinct lowerings (a masked uintN, uint256's bare opcode, a SIGNEXTENDed
 * intN, int256); the `mulDiv` pairs drive the FullMath reference through the one-word fast path,
 * the 512-bit path, both Panics (0x12 zero denominator, 0x11 quotient overflow) and the rounding
 * increment that overflows.
 */

import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, type NumericType } from '../../src/index.js';
import { EvsFullMathReference } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, extractRevertData, lcg } from './helpers.js';

const MAX256 = (1n << 256n) - 1n;

interface Pair {
  /** EvsFullMathReference function name == the evs script name. */
  fn: string;
  args: readonly NumericType[];
  // the arg types are dynamic over the matrix: the callback is untyped on purpose
  body: (s: any, ...a: any[]) => unknown;
  corpus: readonly (readonly bigint[])[];
  /** `mulDiv` pairs only: how the program lowers its sites (see `SHARED_PAIRS`). */
  lowering?: 'inline' | 'uniform' | 'mixed';
}

function rangeOf(type: NumericType): { min: bigint; max: bigint } {
  const signed = type.startsWith('int');
  const bits = BigInt(signed ? type.slice(3) : type.slice(4));
  return signed
    ? { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n }
    : { min: 0n, max: (1n << bits) - 1n };
}

function wrapCorpus(type: NumericType): bigint[][] {
  const { min, max } = rangeOf(type);
  const values = [0n, 1n, 2n, max, max - 1n, max / 2n + 1n];
  if (min < 0n) values.push(-1n, -2n, min, min + 1n);
  return values.flatMap((a) => values.map((b) => [a, b]));
}

const WRAP_WIDTHS: readonly [string, NumericType][] = [
  ['U8', 'uint8'],
  ['U192', 'uint192'],
  ['U256', 'uint256'],
  ['I8', 'int8'],
  ['I200', 'int200'],
  ['I256', 'int256'],
];

const rand = lcg(0xf011_3a7dn);
const word = (): bigint => (rand() << 192n) | (rand() << 128n) | (rand() << 64n) | rand();

const mulDivTriples: bigint[][] = [
  [0n, 0n, 0n], // Panic 0x12
  [1n << 255n, 4n, 0n], // Panic 0x12 on the 512-bit path
  [5n, 7n, 3n],
  [6n, 7n, 3n],
  [MAX256, 1n, 1n],
  [MAX256, MAX256, MAX256],
  [MAX256, MAX256, MAX256 - 1n], // Panic 0x11
  [1n << 255n, 4n, 2n], // Panic 0x11 (d == prod1)
  [1n << 255n, 4n, 3n],
  [1n << 128n, 1n << 128n, 1n << 200n],
  [MAX256, MAX256, 1n << 255n],
  // the floor is exactly 2^256 − 1 with a remainder: only rounding up overflows
  [535006138814359n, 432862656469423142931042426214547535783388063929571229938474969n, 2n],
  ...Array.from({ length: 24 }, (_, i) => {
    const d = i % 3 === 0 ? rand() : word() | 1n;
    return [word(), i % 4 === 0 ? rand() : word(), i % 5 === 0 ? d << 64n : d];
  }),
].map(([a, b, d]) => [a ?? 0n, b ?? 0n, (d ?? 0n) & MAX256]);

const PAIRS: Pair[] = [
  ...WRAP_WIDTHS.flatMap(([suffix, ty]) =>
    (
      [
        ['wrapAdd', 'wrappingAdd'],
        ['wrapSub', 'wrappingSub'],
        ['wrapMul', 'wrappingMul'],
      ] as const
    ).map(([prefix, method]): Pair => ({
      fn: `${prefix}${suffix}`,
      args: [ty, ty],
      body: (s, a, b) => s.return({ r: a[method](b) }),
      corpus: wrapCorpus(ty),
    })),
  ),
  mulDivPair('mulDiv', 'inline'),
  mulDivPair('mulDivRoundingUp', 'inline'),
];

/**
 * The `mulDiv` pairs again through the shared `@muldiv` subroutine: a second site, `q·3 / 3`
 * (exactly `q`, and never a Panic), makes the program a two-site one, so both sites call it.
 * The second site rounds like the first (`uniform`: the subroutine carries that rounding only)
 * or the other way (`mixed`: the subroutine tests a rounding flag each site pushes).
 */
const SHARED_PAIRS: Pair[] = (['uniform', 'mixed'] as const).flatMap((lowering) => [
  mulDivPair('mulDiv', lowering),
  mulDivPair('mulDivRoundingUp', lowering),
]);

function mulDivPair(
  fn: 'mulDiv' | 'mulDivRoundingUp',
  lowering: 'inline' | 'uniform' | 'mixed',
): Pair {
  return {
    fn,
    lowering,
    args: ['uint256', 'uint256', 'uint256'],
    body: (s, a, b, d) => {
      const q = fn === 'mulDiv' ? s.mulDiv(a, b, d) : a.mulDivRoundingUp(b, d);
      if (lowering === 'inline') return s.return({ r: q });
      const up = (fn === 'mulDivRoundingUp') === (lowering === 'uniform');
      return s.return({ r: up ? q.mulDivRoundingUp(3n, 3n) : q.mulDiv(3n, 3n) });
    },
    corpus: mulDivTriples,
  };
}

let reference: `0x${string}`;

beforeAll(async () => {
  reference = await deploy(EvsFullMathReference.abi, EvsFullMathReference.bytecode);
});

/** eth_call → { ok, bytes } with the raw returndata or revert payload. */
async function rawCall(params: {
  to: `0x${string}`;
  data: Hex;
  stateOverride?: { address: `0x${string}`; code: Hex }[];
}): Promise<{ ok: boolean; bytes: Hex }> {
  try {
    const { data } = await publicClient.call(
      params.stateOverride === undefined
        ? { to: params.to, data: params.data }
        : { to: params.to, data: params.data, stateOverride: params.stateOverride },
    );
    return { ok: true, bytes: data ?? '0x' };
  } catch (err) {
    return { ok: false, bytes: extractRevertData(err) };
  }
}

describe('wrapping arithmetic / mulDiv: evs vs solc 0.8.30 (EvsFullMathReference)', () => {
  test('every EvsFullMathReference function has an evs twin', () => {
    const fns = (EvsFullMathReference.abi as Abi).flatMap((e) =>
      e.type === 'function' ? [e.name] : [],
    );
    expect(PAIRS.map((p) => p.fn).toSorted()).toEqual(fns.toSorted());
  });

  test.each(PAIRS)('$fn', async (p) => {
    const compiled = compilePair(p);
    expect(compiled.sourceMap.labels.some((l) => l.name === 'muldiv')).toBe(false);
    await expectSolcParity(p, compiled);
  });

  test.each(SHARED_PAIRS)('$fn through the shared @muldiv subroutine ($lowering)', async (p) => {
    const compiled = compilePair(p);
    const labels = compiled.sourceMap.labels.map((l) => l.name);
    expect(labels).toContain('muldiv');
    // only a subroutine serving both roundings tests the flag (its exit label)
    expect(labels.includes('muldiv_exit')).toBe(p.lowering === 'mixed');
    await expectSolcParity(p, compiled);
  });
});

function compilePair(p: Pair) {
  return evscript({ name: p.fn, args: p.args as ['uint256'] }, p.body as never).compile();
}

/** Drives `p.corpus` through the reference and the evs twin: same values, same revert bytes. */
async function expectSolcParity(p: Pair, compiled: ReturnType<typeof compilePair>): Promise<void> {
  const overrideParams = compiled.toViem({ mode: 'stateOverride' });

  const call = async (args: readonly bigint[]) => {
    const [solc, evs] = await Promise.all([
      rawCall({
        to: reference,
        data: encodeFunctionData({
          abi: EvsFullMathReference.abi as Abi,
          functionName: p.fn,
          args,
        }),
      }),
      rawCall({
        to: overrideParams.address,
        stateOverride: overrideParams.stateOverride,
        data: encodeFunctionData({ abi: compiled.abi as Abi, functionName: p.fn, args }),
      }),
    ]);
    return { args, solc, evs };
  };
  // bounded concurrency, like math-ops.test.ts
  const rows: Awaited<ReturnType<typeof call>>[] = [];
  for (let i = 0; i < p.corpus.length; i += 16) {
    rows.push(...(await Promise.all(p.corpus.slice(i, i + 16).map(call))));
  }

  let reverts = 0;
  for (const { args, solc, evs } of rows) {
    const ctx = `${p.fn}(${args.join(', ')})`;
    expect(evs.ok, `${ctx}: success/revert disagreement (solc ok=${solc.ok})`).toBe(solc.ok);
    if (solc.ok) {
      const solcValue = decodeFunctionResult({
        abi: EvsFullMathReference.abi as Abi,
        functionName: p.fn,
        data: solc.bytes,
      });
      const evsValue = decodeFunctionResult({
        abi: compiled.abi as Abi,
        functionName: p.fn,
        data: evs.bytes,
      }) as { r: bigint | number };
      expect(BigInt(evsValue.r), `${ctx}: value mismatch`).toBe(BigInt(solcValue as never));
    } else {
      reverts += 1;
      expect(evs.bytes, `${ctx}: Panic payload mismatch`).toBe(solc.bytes);
    }
  }
  // wrapping never reverts; mulDiv's corpus must hit both Panics
  if (p.fn.startsWith('wrap')) expect(reverts).toBe(0);
  else expect(reverts).toBeGreaterThanOrEqual(4);
}
