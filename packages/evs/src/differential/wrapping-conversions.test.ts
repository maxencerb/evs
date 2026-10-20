/**
 * Differential suite — the wrapping (bit-level) numeric conversions: `wrappingToUint` /
 * `wrappingToInt` (Solidity's explicit `uint24(x)` / `int24(x)` truncation) and the same-width
 * reinterpretations `asInt()` on a uintN / `asUint()` on an intN (`int24(uint24(x))` /
 * `uint24(int24(x))`), as used to read the signed fields of a packed word.
 *
 * `interpret(script.ir)` must agree byte-for-byte with the compiled bytecode (default output and
 * its `optimize: true` twin), and the interpreter is pinned to a host-side reference
 * (`BigInt.asUintN` / `BigInt.asIntN` of the logical value), so the legs cannot agree on a wrong
 * answer; `test/integration/casts.test.ts` pins them against solc 0.8.30.
 */

import { describe, expect, test } from 'vite-plus/test';

import { chainOf, expectAgreement, panicData } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type IntType, type NumericType, type UintType } from '../core/types.js';
import { interpret } from '../ir/interp.js';

function rangeOf(type: NumericType): { min: bigint; max: bigint; bits: number } {
  const signed = type.startsWith('int');
  const bits = Number(signed ? type.slice(3) : type.slice(4));
  return signed
    ? { min: -(1n << BigInt(bits - 1)), max: (1n << BigInt(bits - 1)) - 1n, bits }
    : { min: 0n, max: (1n << BigInt(bits)) - 1n, bits };
}

/** The canonical value of `v` in `type`: its low N bits, two's complement for intN. */
function wrapTo(type: NumericType, v: bigint): bigint {
  const { bits, min } = rangeOf(type);
  return min < 0n ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v);
}

/** The ABI word of a logical value. */
const word = (v: bigint): string => BigInt.asUintN(256, v).toString(16).padStart(64, '0');

const TARGETS = ['uint8', 'uint24', 'uint256', 'int8', 'int24', 'int256'] as const;

/** The boundary values of `type`, plus every target's boundaries that fit in it. */
function corpus(type: NumericType): bigint[] {
  const { min, max } = rangeOf(type);
  const out = new Set([0n, 1n, max, max - 1n, max / 2n, max / 2n + 1n]);
  if (min < 0n) for (const v of [-1n, -2n, min, min + 1n]) out.add(v);
  for (const target of TARGETS) {
    const r = rangeOf(target);
    for (const v of [r.min, r.min - 1n, r.max, r.max + 1n, -r.max]) {
      if (v >= min && v <= max) out.add(v);
    }
  }
  return [...out];
}

describe('wrappingToUint / wrappingToInt: the low N bits, never a Panic', () => {
  const SOURCES = ['uint8', 'uint24', 'uint160', 'uint256', 'int8', 'int24', 'int256'] as const;

  for (const from of SOURCES) {
    test(`from ${from} to every width`, async () => {
      const script = evscript(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the width is dynamic over the matrix: the handle is typed as one representative
        { name: `wrapFrom_${from}`, args: [from] as unknown as ['uint256'] },
        (s, x) =>
          s.return({
            u8: x.wrappingToUint(t.uint8),
            u24: x.wrappingToUint(t.uint24),
            u256: x.wrappingToUint(t.uint256),
            i8: x.wrappingToInt(t.int8),
            i24: x.wrappingToInt(t.int24),
            i256: x.wrappingToInt(t.int256),
          }),
      );
      const values = corpus(from);
      const outcomes = await expectAgreement(
        script,
        values.map((v) => [v]),
      );
      expect(outcomes).toEqual(
        values.map((v) => ({
          kind: 'return',
          data: `0x${TARGETS.map((to) => word(wrapTo(to, v))).join('')}`,
        })),
      );
    });
  }
});

describe('same-width asInt (uintN → intN) / asUint (intN → uintN)', () => {
  const WIDTHS = [8, 16, 24, 64, 160, 248, 256] as const;

  for (const bits of WIDTHS) {
    test(`width ${bits}: 0, 2^(N−1) − 1, 2^(N−1), 2^N − 1 and back`, async () => {
      const uint = `uint${bits}` as UintType;
      const int = `int${bits}` as IntType;
      const script = evscript(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the width is dynamic over the matrix: the handles are typed as one representative
        { name: `reinterpret${bits}`, args: [uint, int] as unknown as ['uint24', 'int24'] },
        (s, u, i) =>
          s.return({
            signed: u.asInt(),
            unsigned: i.asUint(),
            roundTrip: u.asInt().asUint().eq(u).and(i.asUint().asInt().eq(i)),
          }),
      );
      const half = 1n << BigInt(bits - 1);
      const uints = [0n, 1n, half - 1n, half, (1n << BigInt(bits)) - 1n];
      const ints = [0n, -1n, half - 1n, -half, 1n];
      const rows = uints.map((u, k) => [u, ints[k] ?? 0n] as const);
      const outcomes = await expectAgreement(script, rows);
      expect(outcomes).toEqual(
        rows.map(([u, i]) => ({
          kind: 'return',
          data: `0x${word(wrapTo(int, u))}${word(wrapTo(uint, i))}${word(1n)}`,
        })),
      );
    });
  }

  test('the checked toInt / toUint of the same pairs still Panic (control)', async () => {
    const script = evscript({ name: 'checked24', args: [t.uint24, t.int24] }, (s, u, i) =>
      s.return({ signed: u.toInt(t.int24), unsigned: i.toUint(t.uint24) }),
    );
    const outcomes = await expectAgreement(script, [
      [5n, 5n],
      [0x800000n, 0n],
      [0n, -1n],
    ]);
    expect(outcomes.map((o) => o.data)).toEqual([
      `0x${word(5n)}${word(5n)}`,
      panicData(0x11n),
      panicData(0x11n),
    ]);
  });
});

describe('packed signed fields', () => {
  test('Uniswap v4 Slot0: sqrtPriceX96:160 | tick:int24 | protocolFee:24 | lpFee:24', async () => {
    const script = evscript({ name: 'slot0', args: [t.bytes32] }, (s, raw) => {
      const data = raw.asUint256();
      return s.return({
        sqrtPriceX96: data.wrappingToUint(t.uint160),
        // StateLibrary.getSlot0: signextend(2, shr(160, data))
        tick: data.shr(160n).wrappingToInt(t.int24),
        protocolFee: data.shr(184n).wrappingToUint(t.uint24),
        lpFee: data.shr(208n).wrappingToUint(t.uint24),
      });
    });
    const pack = (sqrt: bigint, tick: bigint, protocolFee: bigint, lpFee: bigint): string =>
      `0x${word(
        sqrt | (BigInt.asUintN(24, tick) << 160n) | (protocolFee << 184n) | (lpFee << 208n),
      )}`;
    const rows = [
      [79228162514264337593543950336n, 0n, 0n, 3000n],
      [4295128739n, -887272n, 0xfffn, 500n],
      [(1n << 160n) - 1n, 887272n, 0n, 0x800000n],
      [1n, -1n, 0xffffffn, 0xffffffn],
    ] as const;
    const outcomes = await expectAgreement(
      script,
      rows.map(([sqrt, tick, protocolFee, lpFee]) => [pack(sqrt, tick, protocolFee, lpFee)]),
    );
    expect(outcomes).toEqual(
      rows.map(([sqrt, tick, protocolFee, lpFee]) => ({
        kind: 'return',
        data: `0x${word(sqrt)}${word(tick)}${word(protocolFee)}${word(lpFee)}`,
      })),
    );
  });

  test("a config word's int24 multiplier: every spelling agrees with the workaround", async () => {
    const script = evscript({ name: 'multiplier', args: [t.uint256] }, (s, w) => {
      const raw = w.shr(224n).bitAnd(0xffffffn);
      // the 0.3.1 workaround (issue #158)
      const workaround = raw
        .toInt('int256')
        .sub(s.select(raw.gte(1n << 23n), s.lit(t.int256, 1n << 24n), s.lit(t.int256, 0n)))
        .toInt('int24');
      return s.return({
        workaround,
        masked: raw.toUint('uint24').asInt(),
        truncated: w.shr(224n).wrappingToUint(t.uint24).asInt(),
        direct: w.shr(224n).wrappingToInt(t.int24),
      });
    });
    // type byte | int24 Q12.12 multiplier | uint64 id | address
    const config = (multiplier: bigint): bigint =>
      (0x02n << 248n) | (BigInt.asUintN(24, multiplier) << 224n) | (42n << 160n) | 0xdeadbeefn;
    const multipliers = [6144n, -4096n, 0n, -1n, (1n << 23n) - 1n, -(1n << 23n)];
    const outcomes = await expectAgreement(
      script,
      multipliers.map((m) => [config(m)]),
    );
    expect(outcomes).toEqual(
      multipliers.map((m) => ({ kind: 'return', data: `0x${word(m).repeat(4)}` })),
    );
  });
});

describe('folding and code size', () => {
  test('wrapping conversions of literals fold to the wrapped value (no CERTAIN_PANIC)', () => {
    const script = evscript({ name: 'folds', args: [] }, (s) =>
      s.return({
        a: s.lit(t.uint24, 0xffffffn).asInt(),
        b: s.lit(t.int8, -1n).asUint(),
        c: s.lit(t.uint256, (1n << 256n) - 1n).wrappingToInt(t.int24),
        d: s.lit(t.int256, -5n).wrappingToUint(t.uint256),
        e: s.lit(t.uint256, 0x1234567n).wrappingToUint(t.uint24),
      }),
    );
    expect(script.ir.body.every((st) => st.k === 'const')).toBe(true);
    const { outcome } = interpret(script.ir, [], chainOf({}));
    expect(outcome).toMatchObject({
      kind: 'return',
      data: `0x${word(-1n)}${word(255n)}${word(-1n)}${word(-5n)}${word(0x234567n)}`,
    });
  });

  test('asInt is one SIGNEXTEND, asUint one mask, a lossless wrap is free', () => {
    const u24 = evscript({ name: 'f', args: [t.uint24] }, (s, x) => s.return({ r: x.asInt() }));
    const u24Checked = evscript({ name: 'f', args: [t.uint24] }, (s, x) =>
      s.return({ r: x.toInt(t.int24) }),
    );
    const i24 = evscript({ name: 'f', args: [t.int24] }, (s, x) => s.return({ r: x.asUint() }));
    const i24Checked = evscript({ name: 'f', args: [t.int24] }, (s, x) =>
      s.return({ r: x.toUint(t.uint24) }),
    );
    const u8 = evscript({ name: 'f', args: [t.uint8] }, (s, x) =>
      s.return({ r: x.wrappingToInt(t.int16) }),
    );
    const u8Checked = evscript({ name: 'f', args: [t.uint8] }, (s, x) =>
      s.return({ r: x.toInt(t.int16) }),
    );
    // a same-width reinterpretation is smaller than the checked conversion of the same pair
    expect(compile(u24).runtimeBytecode.length).toBeLessThan(
      compile(u24Checked).runtimeBytecode.length,
    );
    expect(compile(i24).runtimeBytecode.length).toBeLessThan(
      compile(i24Checked).runtimeBytecode.length,
    );
    // uint8 → int16 cannot wrap: the same code as the (free) checked widening
    expect(compile(u8).runtimeBytecode).toBe(compile(u8Checked).runtimeBytecode);
  });
});
