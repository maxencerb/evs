/**
 * Checked `pow`, `addmod` / `mulmod` and signed shifts vs solc 0.8.30 (issue #10).
 *
 * Every EvsMathReference function is paired with the equivalent evs script and driven with the
 * same boundary corpus on anvil: success values must match and revert payloads must be
 * BYTE-IDENTICAL (`Panic(0x11)` / `Panic(0x12)`). The pairs cover all three evs `pow` lowerings
 * (runtime loop, folded base, folded exponent) against solc's own templates (the generic checked
 * loop, the signed first-iteration split, the literal-base `exp`), plus the zero-modulus guard
 * and its literal-modulus elision.
 */

import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t, type EvsType, type NumericType } from '../../src/index.js';
import { EvsMathReference } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, extractRevertData } from './helpers.js';

const MAX256 = (1n << 256n) - 1n;

function rangeOf(type: NumericType): { min: bigint; max: bigint; bits: bigint } {
  const signed = type.startsWith('int');
  const bits = BigInt(signed ? type.slice(3) : type.slice(4));
  return signed
    ? { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n, bits }
    : { min: 0n, max: (1n << bits) - 1n, bits };
}

/** ⌊n^(1/k)⌋ */
function iroot(n: bigint, k: bigint): bigint {
  let lo = 0n;
  let hi = 1n << (256n / k + 1n);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid ** k <= n) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

function bases(type: NumericType): bigint[] {
  const { min, max } = rangeOf(type);
  const out = new Set<bigint>([0n, 1n, 2n, 3n, 10n, max, iroot(max, 2n), iroot(max, 2n) + 1n]);
  out.add(iroot(max, 3n));
  out.add(iroot(max, 3n) + 1n);
  if (min < 0n) {
    const cube = iroot(-min, 3n);
    for (const b of [-1n, -2n, -3n, min, min + 1n, -cube, -cube - 1n]) out.add(b);
  }
  return [...out].filter((b) => b >= min && b <= max);
}

function exponents(expType: NumericType): bigint[] {
  const { max, bits } = rangeOf(expType);
  const out = new Set([
    0n,
    1n,
    2n,
    3n,
    7n,
    8n,
    63n,
    64n,
    127n,
    128n,
    255n,
    256n,
    1n << 128n,
    MAX256,
  ]);
  out.add(bits - 1n);
  return [...out].filter((e) => e <= max);
}

interface Pair {
  /** EvsMathReference function name == the evs script name. */
  fn: string;
  args: readonly EvsType[];
  // the arg types are dynamic over the matrix: the callback is untyped on purpose
  body: (s: any, ...a: any[]) => unknown;
  corpus: readonly (readonly bigint[])[];
}

const RUNTIME_POW: readonly [string, NumericType, NumericType][] = [
  ['powU8', 'uint8', 'uint8'],
  ['powU64', 'uint64', 'uint64'],
  ['powU192', 'uint192', 'uint192'],
  ['powU256', 'uint256', 'uint256'],
  ['powI8', 'int8', 'uint8'],
  ['powI64', 'int64', 'uint64'],
  ['powI200', 'int200', 'uint200'],
  ['powI256', 'int256', 'uint256'],
];

const cross = (xs: readonly bigint[], ys: readonly bigint[]): bigint[][] =>
  xs.flatMap((x) => ys.map((y) => [x, y]));

const modTriples: bigint[][] = [
  [0n, 0n, 0n],
  [5n, 7n, 0n],
  [5n, 7n, 1n],
  [5n, 7n, 3n],
  [MAX256, MAX256, MAX256],
  [MAX256, MAX256, MAX256 - 1n],
  [MAX256, 2n, 3n],
  [1n << 255n, 1n << 255n, 7n],
  [123_456_789n, 987_654_321n, 1_000_000_007n],
];

const shiftAmounts = [0n, 1n, 7n, 8n, 255n];
const PAIRS: Pair[] = [
  ...RUNTIME_POW.map(([fn, ty, ety]): Pair => ({
    fn,
    args: [ty, ety],
    body: (s, a, e) => s.return({ r: s.pow(a, e) }),
    corpus: cross(bases(ty), exponents(ety)),
  })),
  ...(
    [
      ['powBase2', 'uint256', 2n, 'uint256'],
      ['powBase10', 'uint256', 10n, 'uint256'],
      ['powBaseNeg2', 'int256', -2n, 'uint256'],
      ['powBase3U8', 'uint8', 3n, 'uint8'],
      ['powBaseNeg3I8', 'int8', -3n, 'uint8'],
    ] as const
  ).map(([fn, ty, base, ety]): Pair => ({
    fn,
    args: [ety],
    body: (s, e) => s.return({ r: s.pow(s.lit(ty, base), e) }),
    corpus: exponents(ety).map((e) => [e]),
  })),
  ...(
    [
      ['powExp2I8', 'int8', 2n],
      ['powExp3I256', 'int256', 3n],
      ['powExp3U64', 'uint64', 3n],
    ] as const
  ).map(([fn, ty, e]): Pair => ({
    fn,
    args: [ty],
    body: (s, a) => s.return({ r: s.pow(a, e) }),
    corpus: bases(ty).map((a) => [a]),
  })),
  {
    fn: 'addmodU256',
    args: ['uint256', 'uint256', 'uint256'],
    body: (s, a, b, n) => s.return({ r: s.addmod(a, b, n) }),
    corpus: modTriples,
  },
  {
    fn: 'mulmodU256',
    args: ['uint256', 'uint256', 'uint256'],
    body: (s, a, b, n) => s.return({ r: a.mulmod(b, n) }),
    corpus: modTriples,
  },
  {
    fn: 'mulmodConst',
    args: ['uint256', 'uint256'],
    body: (s, a, b) => s.return({ r: s.mulmod(a, b, 1_000_000_007n) }),
    corpus: modTriples.map(([a, b]) => [a ?? 0n, b ?? 0n]),
  },
  ...(
    [
      ['shlI8', 'int8', 'uint8'],
      ['shrI8', 'int8', 'uint8'],
      ['shlI256', 'int256', 'uint256'],
      ['shrI256', 'int256', 'uint256'],
    ] as const
  ).map(([fn, ty, nty]): Pair => {
    const { min, max } = rangeOf(ty);
    const amounts = nty === 'uint8' ? shiftAmounts : [...shiftAmounts, 256n, 300n];
    return {
      fn,
      args: [ty, nty],
      body: (s, a, n) => {
        const bits = n.toUint(t.uint256);
        return s.return({ r: fn.startsWith('shl') ? a.shl(bits) : a.shr(bits) });
      },
      corpus: cross([min, min + 1n, -3n, -1n, 0n, 1n, max], amounts),
    };
  }),
];

let reference: `0x${string}`;

beforeAll(async () => {
  reference = await deploy(EvsMathReference.abi, EvsMathReference.bytecode);
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

describe('pow / addmod / mulmod / signed shifts: evs vs solc 0.8.30 (EvsMathReference)', () => {
  test('every EvsMathReference function has an evs twin', () => {
    const fns = (EvsMathReference.abi as Abi).flatMap((e) =>
      e.type === 'function' ? [e.name] : [],
    );
    expect(PAIRS.map((p) => p.fn).toSorted()).toEqual(fns.toSorted());
  });

  test.each(PAIRS)('$fn', async (p) => {
    const script = evscript({ name: p.fn, args: p.args as ['uint256'] }, p.body as never);
    const compiled = script.compile();
    const overrideParams = compiled.toViem({ mode: 'stateOverride' });

    // bounded concurrency: the runtime-pow corpora are a few hundred rows, and flooding the
    // shared prool proxy with them all at once starves the other workers' anvils
    const call = async (args: readonly bigint[]) => {
      const [solc, evs] = await Promise.all([
        rawCall({
          to: reference,
          data: encodeFunctionData({
            abi: EvsMathReference.abi as Abi,
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
          abi: EvsMathReference.abi as Abi,
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
    // the corpora straddle the boundaries: pow and the zero modulus must actually panic somewhere
    if (!p.fn.startsWith('sh') && p.fn !== 'mulmodConst') expect(reverts).toBeGreaterThan(0);
  });
});
