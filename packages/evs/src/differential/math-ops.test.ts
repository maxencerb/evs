/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — checked `pow`, `addmod` / `mulmod` and signed shifts (issue #10).
 *
 * `interpret(script.ir)` must agree byte-for-byte with the compiled bytecode (default output and
 * its `optimize: true` twin) on returndata and Panic payloads. `pow` has three lowerings — a
 * runtime square-and-multiply loop, a folded-base `e ≤ maxE` + `EXP` template and a
 * folded-exponent root-bound + `EXP` template — so every width class is driven through all
 * three over the overflow boundaries; the interpreter's exact-math oracle is itself pinned to
 * solc 0.8.30 by `test/integration/math-ops.test.ts`.
 */

import { describe, expect, test } from 'vite-plus/test';

import { EVM_VERSIONS, expectAgreement, panicData } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type NumericType, type UintType } from '../core/types.js';

const MAX256 = (1n << 256n) - 1n;

const WIDTHS: readonly NumericType[] = [
  'uint8',
  'uint64',
  'uint192',
  'uint256',
  'int8',
  'int64',
  'int200',
  'int256',
];

function rangeOf(type: NumericType): { min: bigint; max: bigint; bits: bigint } {
  const signed = type.startsWith('int');
  const bits = BigInt(signed ? type.slice(3) : type.slice(4));
  return signed
    ? { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n, bits }
    : { min: 0n, max: (1n << bits) - 1n, bits };
}

/** ⌊n^(1/k)⌋ — the largest base whose k-th power still fits. */
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

/** Bases around every overflow boundary of `type` (sign, magnitude 0/1/2, roots, extremes). */
function baseCorpus(type: NumericType): bigint[] {
  const { min, max } = rangeOf(type);
  const out = new Set<bigint>([0n, 1n, 2n, 3n, 10n, max, max - 1n, iroot(max, 2n) + 1n]);
  out.add(iroot(max, 2n));
  out.add(iroot(max, 3n));
  if (min < 0n) {
    for (const b of [-1n, -2n, -3n, min, min + 1n, -iroot(-min, 3n), -iroot(-min, 3n) - 1n]) {
      out.add(b);
    }
  }
  return [...out].filter((b) => b >= min && b <= max);
}

/** Exponents around the loop's bit boundaries, the `e > 255` early Panic and huge values. */
function exponentCorpus(bits: bigint): bigint[] {
  return [0n, 1n, 2n, 3n, 7n, bits - 1n, bits, 255n, 256n, 1n << 128n, MAX256];
}

function powScript(type: NumericType, expType: UintType = 'uint256') {
  return evscript({ name: `pow_${type}`, args: [type, expType] }, (s, a, e) =>
    s.return({ r: s.pow(a, e) }),
  );
}

describe('pow: runtime base and exponent (the checked loop)', () => {
  for (const type of WIDTHS) {
    test(`width ${type}`, async () => {
      const { bits } = rangeOf(type);
      const pairs = baseCorpus(type).flatMap((a) => exponentCorpus(bits).map((e) => [a, e]));
      await expectAgreement(powScript(type), pairs);
    });
  }

  test('the loop across paris / shanghai / cancun', async () => {
    const pairs: [bigint, bigint][] = [
      [3n, 161n],
      [3n, 162n], // 3^162 > 2^256 − 1
      [-2n, 255n], // exactly int256 min
      [2n, 255n], // int256 max < 2^255: Panic
      [-(1n << 255n), 1n],
      [-(1n << 255n), 2n],
    ];
    for (const evmVersion of EVM_VERSIONS) {
      // oxlint-disable-next-line no-await-in-loop -- per-fork labels stay deterministic
      await expectAgreement(powScript('int256'), pairs, {}, evmVersion);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await expectAgreement(
        powScript('uint256'),
        pairs.filter(([a]) => a >= 0n),
        {},
        evmVersion,
      );
    }
  });

  test('a narrow exponent type (uint8) and the exact int8 edges', async () => {
    const outcomes = await expectAgreement(powScript('int8', 'uint8'), [
      [-2n, 7n], // −128: fits
      [2n, 7n], // 128: Panic 0x11
      [-128n, 1n],
      [-128n, 2n],
      [-1n, 255n],
      [-1n, 254n],
      [11n, 2n], // 121
      [12n, 2n], // 144: Panic
      [-5n, 3n], // −125
      [-6n, 3n], // −216: Panic
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual([
      'return',
      'revert',
      'return',
      'revert',
      'return',
      'return',
      'return',
      'revert',
      'return',
      'revert',
    ]);
    expect(outcomes[1]?.data).toBe(panicData(0x11n));
  });
});

describe('pow: folded base (e ≤ maxE + EXP)', () => {
  function constBase(type: NumericType, base: bigint) {
    return evscript({ name: `pow_base`, args: [t.uint256] }, (s, e) =>
      s.return({ r: s.pow(s.lit(type, base), e) }),
    );
  }
  for (const type of WIDTHS) {
    test(`width ${type}`, async () => {
      const { bits, min } = rangeOf(type);
      const bases = [0n, 1n, 2n, 3n, 10n, ...(min < 0n ? [-1n, -2n, -3n, -10n, min] : [])];
      const exps = exponentCorpus(bits).map((e) => [e]);
      await Promise.all(bases.map((b) => expectAgreement(constBase(type, b), exps)));
    });
  }

  test('2 ** e on uint256 is a single bound check and EXP (no loop)', () => {
    const constant = compile(constBase('uint256', 2n)).runtimeBytecode.length;
    const loop = compile(powScript('uint256')).runtimeBytecode.length;
    expect(constant).toBeLessThan(loop);
  });
});

describe('pow: folded exponent (root bound + EXP)', () => {
  function constExp(type: NumericType, e: bigint) {
    return evscript({ name: `pow_exp`, args: [type] }, (s, a) => s.return({ r: s.pow(a, e) }));
  }
  for (const type of WIDTHS) {
    test(`width ${type}`, async () => {
      const { bits } = rangeOf(type);
      const bases = baseCorpus(type).map((a) => [a]);
      const exps = [0n, 1n, 2n, 3n, 4n, 5n, 7n, bits - 1n, 255n, 256n];
      await Promise.all(exps.map((e) => expectAgreement(constExp(type, e), bases)));
    });
  }
});

// ---------------------------------------------------------------------------
// addmod / mulmod
// ---------------------------------------------------------------------------

describe('addmod / mulmod', () => {
  const triples: [bigint, bigint, bigint][] = [
    [0n, 0n, 0n], // Panic 0x12
    [5n, 7n, 0n], // Panic 0x12
    [5n, 7n, 1n],
    [5n, 7n, 3n],
    [MAX256, MAX256, MAX256],
    [MAX256, MAX256, MAX256 - 1n], // the intermediate needs 257 / 512 bits
    [MAX256, 2n, 3n],
    [1n << 255n, 1n << 255n, 7n],
    [MAX256 - 1n, 1n, MAX256],
    [123_456_789n, 987_654_321n, 1_000_000_007n],
  ];

  for (const op of ['addmod', 'mulmod'] as const) {
    test(`${op}: runtime operands across forks`, async () => {
      const script = evscript({ name: op, args: [t.uint256, t.uint256, t.uint256] }, (s, a, b, n) =>
        s.return({ r: op === 'addmod' ? a.addmod(b, n) : s.mulmod(a, b, n) }),
      );
      for (const evmVersion of EVM_VERSIONS) {
        // oxlint-disable-next-line no-await-in-loop -- per-fork labels stay deterministic
        const outcomes = await expectAgreement(script, triples, {}, evmVersion);
        expect(outcomes[0]?.data).toBe(panicData(0x12n));
      }
    });

    test(`${op}: literal modulus (the zero guard is elided for a nonzero one)`, async () => {
      const make = (n: bigint) =>
        evscript({ name: `${op}_const`, args: [t.uint256, t.uint256] }, (s, a, b) =>
          s.return({ r: op === 'addmod' ? s.addmod(a, b, n) : a.mulmod(b, n) }),
        );
      const pairs = triples.map(([a, b]) => [a, b]);
      await Promise.all(
        [0n, 1n, 2n, 7n, 1_000_000_007n, MAX256].map((n) => expectAgreement(make(n), pairs)),
      );
      // the elision: a nonzero literal modulus drops `DUP1 ISZERO PUSH @panic JUMPI`
      const guarded = compile(make(0n)).runtimeBytecode.length;
      const elided = compile(make(7n)).runtimeBytecode.length;
      expect(elided).toBeLessThan(guarded);
    });
  }

  test('literal operands on either side (mixed with Exprs)', async () => {
    const script = evscript({ name: 'mixed', args: [t.uint256] }, (s, x) =>
      s.return({
        a: s.addmod(MAX256, x, 10n),
        m: s.mulmod(MAX256, MAX256, x),
        f: s.mulmod(MAX256, MAX256, 12n), // folds at recording
      }),
    );
    await expectAgreement(script, [[0n], [1n], [9n], [MAX256]]);
  });
});

// ---------------------------------------------------------------------------
// signed shifts (issue #10 exposed intN on the typed shl / shr surface)
// ---------------------------------------------------------------------------

describe('signed shifts (SAR / re-sign-extending SHL)', () => {
  test('int8 / int256 shl and shr', async () => {
    const script = evscript({ name: 'sshift', args: [t.int8, t.int256, t.uint256] }, (s, x, y, n) =>
      s.return({ xl: x.shl(n), xr: x.shr(n), yl: s.shl(y, n), yr: s.shr(y, n) }),
    );
    await expectAgreement(script, [
      [-1n, -1n, 0n],
      [-128n, -(1n << 255n), 1n],
      [-3n, -3n, 1n], // SAR rounds toward −∞: −3 >> 1 == −2
      [127n, (1n << 255n) - 1n, 1n], // shl wraps into the sign bit
      [-5n, -5n, 255n],
      [-5n, -5n, 256n],
      [5n, 5n, 300n],
    ]);
  });
});
