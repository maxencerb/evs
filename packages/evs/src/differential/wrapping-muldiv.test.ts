/* oxlint-disable vitest/expect-expect --
 * the fork sweeps assert through the shared `expectAgreement` runner. */
/**
 * Differential suite — wrapping arithmetic (`wrappingAdd` / `wrappingSub` / `wrappingMul`) and
 * `mulDiv` / `mulDivRoundingUp`.
 *
 * `interpret(script.ir)` must agree byte-for-byte with the compiled bytecode (default output and
 * its `optimize: true` twin) on returndata and Panic payloads. The interpreter is itself pinned
 * here to a host-side bigint reference (the low N bits of the true result; the exact floor /
 * ceiling quotient), and to solc 0.8.30 (`unchecked` blocks, OpenZeppelin-style FullMath) by
 * `test/integration/full-math.test.ts`.
 */

import { describe, expect, test } from 'vite-plus/test';

import { EVM_VERSIONS, expectAgreement, panicData } from '../../test/harness/differential.js';
import type { SourceMap } from '../asm/sourcemap.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type Hex, type NumericType } from '../core/types.js';

const MAX256 = (1n << 256n) - 1n;

const WIDTHS: readonly NumericType[] = [
  'uint8',
  'uint64',
  'uint128',
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

/** The ABI word of a logical value. */
const word = (v: bigint): string => `0x${BigInt.asUintN(256, v).toString(16).padStart(64, '0')}`;

// ---------------------------------------------------------------------------
// wrapping add / sub / mul
// ---------------------------------------------------------------------------

describe('wrapping add / sub / mul', () => {
  /** Values around every wrap boundary of `type`. */
  function corpus(type: NumericType): bigint[] {
    const { min, max } = rangeOf(type);
    const out = new Set([0n, 1n, 2n, 3n, max, max - 1n, max / 2n, max / 2n + 1n]);
    if (min < 0n) for (const v of [-1n, -2n, min, min + 1n, min / 2n]) out.add(v);
    return [...out];
  }

  const OPS = [
    ['wrappingAdd', (a: bigint, b: bigint) => a + b],
    ['wrappingSub', (a: bigint, b: bigint) => a - b],
    ['wrappingMul', (a: bigint, b: bigint) => a * b],
  ] as const;

  for (const type of WIDTHS) {
    test(`width ${type}: the true result modulo 2^N, never a Panic`, async () => {
      const { bits, min } = rangeOf(type);
      const wrap = (v: bigint) =>
        min < 0n ? BigInt.asIntN(Number(bits), v) : BigInt.asUintN(Number(bits), v);
      const values = corpus(type);
      const pairs = values.flatMap((a) => values.map((b) => [a, b] as const));
      const script = evscript(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the width is dynamic over the matrix: the handles are typed as one representative
        { name: `wrap_${type}`, args: [type, type] as unknown as ['uint256', 'uint256'] },
        (s, a, b) =>
          s.return({ add: a.wrappingAdd(b), sub: s.wrappingSub(a, b), mul: a.wrappingMul(b) }),
      );
      const outcomes = await expectAgreement(script, pairs);
      const expected = pairs.map(([a, b]) => ({
        kind: 'return',
        data: `0x${OPS.map(([, f]) => word(wrap(f(a, b))).slice(2)).join('')}`,
      }));
      expect(outcomes).toEqual(expected);
    });
  }

  test('across paris / shanghai / cancun', async () => {
    const script = evscript({ name: 'wrap_forks', args: [t.int256, t.uint8] }, (s, a, b) =>
      s.return({ i: a.wrappingMul(-1n), u: b.wrappingSub(1n) }),
    );
    for (const evmVersion of EVM_VERSIONS) {
      // oxlint-disable-next-line no-await-in-loop -- per-fork labels stay deterministic
      const outcomes = await expectAgreement(script, [[-(1n << 255n), 0n]], {}, evmVersion);
      // −(−2^255) wraps back to −2^255; 0 − 1 wraps to 255
      expect(outcomes[0]?.data).toBe(`0x${word(-(1n << 255n)).slice(2)}${word(255n).slice(2)}`);
    }
  });

  test('all-literal operands fold, wrapped (the checked op would be a CERTAIN_PANIC)', () => {
    const script = evscript({ name: 'wrap_fold', args: [] }, (s) =>
      s.return({
        u: s.wrappingAdd(s.lit(t.uint8, 250n), 10n),
        i: s.wrappingSub(s.lit(t.int8, -128n), 1n),
        m: s.lit(t.uint256, MAX256).wrappingMul(MAX256),
      }),
    );
    expect(script.ir.body.every((st) => st.k === 'const')).toBe(true);
    expect(() =>
      evscript({ name: 'checked_fold', args: [] }, (s) =>
        s.return({ u: s.add(s.lit(t.uint8, 250n), 10n) }),
      ),
    ).toThrow(/Panic\(0x11\)/);
  });

  test('a wrapping uint256 op is the bare opcode: smaller than its checked twin', () => {
    const make = (wrapping: boolean) =>
      evscript({ name: 'size', args: [t.uint256, t.uint256] }, (s, a, b) =>
        s.return({ r: wrapping ? a.wrappingMul(b) : a.mul(b) }),
      );
    expect(compile(make(true)).runtimeBytecode.length).toBeLessThan(
      compile(make(false)).runtimeBytecode.length,
    );
  });
});

// ---------------------------------------------------------------------------
// mulDiv / mulDivRoundingUp
// ---------------------------------------------------------------------------

describe('mulDiv / mulDivRoundingUp', () => {
  /** Host reference with OpenZeppelin `Math.mulDiv`'s Panic codes, as an expected outcome. */
  function reference(a: bigint, b: bigint, d: bigint, up: boolean): { kind: string; data: string } {
    if (d === 0n) return { kind: 'revert', data: panicData(0x12n) };
    const p = a * b;
    const q = p / d + (up && p % d !== 0n ? 1n : 0n);
    return q > MAX256
      ? { kind: 'revert', data: panicData(0x11n) }
      : { kind: 'return', data: word(q) };
  }

  // a deterministic xorshift corpus over the full word, plus every path boundary
  let state = 0x9e3779b97f4a7c15f39cc0605cedc834n;
  const next = (): bigint => {
    state ^= (state << 13n) & MAX256;
    state ^= state >> 7n;
    state ^= (state << 17n) & MAX256;
    return state;
  };

  const triples: [bigint, bigint, bigint][] = [
    [0n, 0n, 0n], // Panic 0x12
    [5n, 7n, 0n], // Panic 0x12
    [0n, MAX256, 1n],
    [5n, 7n, 3n], // fast path, inexact
    [6n, 7n, 3n], // fast path, exact
    [MAX256, 1n, 1n], // floor == 2^256 − 1 on the fast path, exact
    [MAX256, MAX256, MAX256], // full path, exactly 2^256 − 1
    [MAX256, MAX256, MAX256 - 1n], // Panic 0x11 (quotient 2^256 …)
    [MAX256, MAX256 - 1n, MAX256], // full path, exact
    [1n << 255n, 4n, 2n], // p1 == 2 == d: Panic 0x11
    [1n << 255n, 4n, 3n], // d == p1 + 1: fits
    [1n << 128n, 1n << 128n, 1n], // 2^256 / 1: Panic 0x11
    [1n << 128n, 1n << 128n, 2n], // 2^255, d a power of two (twos == d)
    [1n << 128n, 1n << 128n, 1n << 200n], // twos == 2^200
    [MAX256, MAX256, 1n << 255n], // even denominator, odd product
    [MAX256, 3n, 3n], // exact 2^256 − 1 on the full path
    // ⌊a·b / 2⌋ == 2^256 − 1 with a remainder: the floor fits, rounding up overflows
    [535006138814359n, 432862656469423142931042426214547535783388063929571229938474969n, 2n],
    // Q96 / Q128 fixed point (Uniswap v3): sqrtPriceX96² / 2^192 · 1e18 and fee growth
    [79228162514264337593543950336n * 3n, 79228162514264337593543950336n * 5n, 1n << 192n],
    [MAX256 - 12345n, 10n ** 18n, 1n << 128n],
  ];
  for (let i = 0; i < 48; i++) {
    const a = next();
    const b = i % 3 === 0 ? next() >> 128n : next();
    // a third of the denominators small (full path overflows), the rest large (most fit)
    const d = i % 3 === 1 ? next() >> 192n : next() | 1n;
    triples.push([a, b, i % 8 === 0 ? (d << 7n) & MAX256 : d]);
  }

  for (const [name, up] of [
    ['mulDiv', false],
    ['mulDivRoundingUp', true],
  ] as const) {
    test(`${name}: runtime operands, exact vs the bigint reference`, async () => {
      const script = evscript({ name, args: [t.uint256, t.uint256, t.uint256] }, (s, a, b, d) =>
        s.return({ r: up ? a.mulDivRoundingUp(b, d) : s.mulDiv(a, b, d) }),
      );
      const outcomes = await expectAgreement(script, triples);
      const expected = triples.map(([a, b, d]) => reference(a, b, d, up));
      expect(outcomes).toEqual(expected);
      // both panics and both paths are exercised
      const data = outcomes.map((o) => o.data);
      expect(data).toContain(panicData(0x12n));
      expect(data).toContain(panicData(0x11n));
      const fits = triples.filter(([a, b, d]) => d !== 0n && (a * b) / d <= MAX256);
      expect(fits.filter(([a, b]) => a * b <= MAX256).length).toBeGreaterThan(5); // p1 == 0
      expect(fits.filter(([a, b]) => a * b > MAX256).length).toBeGreaterThan(20); // 512-bit
    });

    test(`${name}: across paris / shanghai / cancun`, async () => {
      const script = evscript({ name, args: [t.uint256, t.uint256, t.uint256] }, (s, a, b, d) =>
        s.return({ r: up ? s.mulDivRoundingUp(a, b, d) : a.mulDiv(b, d) }),
      );
      for (const evmVersion of EVM_VERSIONS) {
        // oxlint-disable-next-line no-await-in-loop -- per-fork labels stay deterministic
        await expectAgreement(script, triples.slice(0, 20), {}, evmVersion);
      }
    });

    test(`${name}: literal denominators (the zero guard is elided for a nonzero one)`, async () => {
      const make = (d: bigint) =>
        evscript({ name: `${name}_const`, args: [t.uint256, t.uint256] }, (s, a, b) =>
          s.return({ r: up ? a.mulDivRoundingUp(b, d) : s.mulDiv(a, b, d) }),
        );
      const pairs = triples.map(([a, b]) => [a, b]);
      await Promise.all(
        [0n, 1n, 2n, 3n, 1n << 96n, 1n << 192n, 10n ** 18n, MAX256].map((d) =>
          expectAgreement(make(d), pairs),
        ),
      );
      const guarded = compile(make(0n)).runtimeBytecode.length;
      const elided = compile(make(7n)).runtimeBytecode.length;
      expect(elided).toBeLessThan(guarded);
    });
  }

  /** `k` sites on distinct operands (nothing CSEs), summed; `full` picks mulDiv over mul.div. */
  const sites = (k: number, full: boolean) =>
    evscript({ name: 'sites', args: [t.uint256, t.uint256, t.uint256] }, (s, a, b, d) => {
      const acc = s.let(t.uint256, 0n);
      for (let i = 0; i < k; i++) {
        const bi = b.add(BigInt(i));
        acc.set(acc.get().add(full ? a.mulDiv(bi, d) : a.mul(bi).div(d)));
      }
      return s.return({ r: acc.get() });
    });

  /** How many `@muldiv` subroutines the program carries (its entry label, `muldiv`). */
  const subroutines = (script: { compile: () => { readonly sourceMap: SourceMap } }): number =>
    script.compile().sourceMap.labels.filter((l) => l.name === 'muldiv').length;

  test('two or more sites call one shared FullMath subroutine: an extra site costs a few bytes', () => {
    for (const optimize of [false, true]) {
      const size = (k: number, full: boolean) =>
        (compile(sites(k, full), { optimize }).runtimeBytecode.length - 2) / 2;
      // the mulDiv premium over a.mul(b).div(d), per extra site: the call sequence only (it was
      // the whole ~111-byte FullMath body when every site inlined it)
      const perSite = (size(5, true) - size(5, false) - (size(2, true) - size(2, false))) / 3;
      expect(perSite).toBeLessThanOrEqual(0);
    }
    expect(subroutines(sites(2, true))).toBe(1);
    expect(subroutines(sites(5, true))).toBe(1);
  });

  test('a single site inlines the body: no call overhead when nothing shares it', () => {
    expect(subroutines(sites(1, true))).toBe(0);
    // a fn body is one site however many times it is called …
    const twice = evscript({ name: 'twice', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const scale = s.fn('scale', [t.uint256, t.uint256], (x, y) => x.mulDiv(y, 1n << 96n));
      return s.return({ x: scale(a, b), y: scale(b, a) });
    });
    expect(subroutines(twice)).toBe(0);
    // … and a fn the program never calls is never emitted, so its site does not count
    const uncalled = evscript({ name: 'uncalled', args: [t.uint256, t.uint256] }, (s, a, b) => {
      s.fn('unused', [t.uint256, t.uint256], (x, y) => x.mulDiv(y, 3n));
      return s.return({ q: a.mulDiv(b, 7n) });
    });
    expect(subroutines(uncalled)).toBe(0);
  });

  test('several sites (floor and rounding up, in a fn and a loop) agree with the reference', async () => {
    const script = evscript(
      { name: 'many', args: [t.uint256, t.uint256, t.uint256] },
      (s, a, b, d) => {
        const half = s.fn('half', [t.uint256, t.uint256], (x, y) => s.mulDivRoundingUp(x, y, 2n));
        const acc = s.let(t.uint256, 0n);
        s.for({ type: t.uint256, from: 0n, until: 3n }, (i) => {
          acc.set(acc.get().wrappingAdd(a.mulDiv(b, d.add(i))));
        });
        return s.return({
          floor: a.mulDiv(b, d),
          up: s.mulDivRoundingUp(a, b, d),
          lit: b.mulDiv(a, 1n << 96n),
          fn: half(a, b),
          loop: acc.get(),
        });
      },
    );
    const inputs = triples.filter(([, , d]) => d < MAX256 - 4n);
    for (const evmVersion of EVM_VERSIONS) {
      // oxlint-disable-next-line no-await-in-loop -- per-fork labels stay deterministic
      const outcomes = await expectAgreement(script, inputs, {}, evmVersion);
      const expected = inputs.map(([a, b, d]) => {
        // in evaluation order: the loop runs first (it is recorded first), then the return tuple
        const steps = [
          ...[0n, 1n, 2n].map((i) => reference(a, b, d + i, false)),
          reference(a, b, d, false),
          reference(a, b, d, true),
          reference(b, a, 1n << 96n, false),
          reference(a, b, 2n, true),
        ];
        const failed = steps.find((r) => r.kind === 'revert');
        if (failed !== undefined) return failed;
        const [l0, l1, l2, ...outs] = steps.map((r) => BigInt(r.data));
        const loop = ((l0 ?? 0n) + (l1 ?? 0n) + (l2 ?? 0n)) & MAX256;
        return {
          kind: 'return',
          data: `0x${[...outs, loop].map((v) => word(v).slice(2)).join('')}`,
        };
      });
      expect(outcomes).toEqual(expected);
    }
  });

  test('explainRevert: a Panic raised in the shared subroutine names the sites that call it', async () => {
    const script = evscript(
      { name: 'two', args: [t.uint256, t.uint256, t.uint256] },
      (s, a, b, d) => s.return({ q: s.mulDiv(a, b, 3n), r: s.mulDivRoundingUp(a, b, d) }),
    );
    const compiled = compile(script);
    const ids = compiled.sourceMap.sites
      .filter((site) => site.detail.startsWith('muldiv'))
      .map((site) => site.id);
    expect(ids).toHaveLength(2);
    const [overflow, divZero] = await expectAgreement(script, [
      [MAX256, MAX256, 1n], // the first site's quotient overflows inside @muldiv
      [1n, 2n, 0n], // the second site's zero guard
    ]);
    const candidates = (data: Hex) =>
      compiled.explainRevert(data).candidateSites?.map((site) => site.id);
    expect(overflow?.data).toBe(panicData(0x11n));
    expect(candidates(panicData(0x11n))).toEqual(ids);
    expect(divZero?.data).toBe(panicData(0x12n));
    expect(candidates(panicData(0x12n))).toEqual(ids.slice(1));
  });

  test('all-literal operands fold; a certain Panic is a CERTAIN_PANIC at recording', () => {
    const script = evscript({ name: 'fold', args: [] }, (s) =>
      s.return({
        q: s.mulDiv(MAX256, MAX256, MAX256),
        u: s.mulDivRoundingUp(5n, 7n, 3n),
      }),
    );
    expect(script.ir.body.every((st) => st.k === 'const')).toBe(true);
    expect(() =>
      evscript({ name: 'zero', args: [] }, (s) => s.return({ q: s.mulDiv(1n, 2n, 0n) })),
    ).toThrow(/mulDiv\(1, 2, 0\) divides by zero.*Panic\(0x12\)/s);
    expect(() =>
      evscript({ name: 'over', args: [] }, (s) => s.return({ q: s.mulDiv(MAX256, 2n, 1n) })),
    ).toThrow(/overflows uint256.*Panic\(0x11\)/s);
  });
});
