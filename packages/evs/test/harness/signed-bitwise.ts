/**
 * The bitwise operators on `intN`: the scripts, the operand corpus and a host-side reference,
 * shared by the unit differential test (interpreter, constant folding, bytecode on the harness
 * EVM) and the anvil one. The reference is JavaScript's own bitwise operators on `bigint`,
 * which are two's complement over a sign extended without end: the legs cannot agree on a
 * wrong answer.
 */
import { evscript } from '../../src/builder/script.js';
import type { IntType } from '../../src/core/types.js';

/** The widths under test: one byte, an odd byte count, a half word, the full word, and two
 *  in between. */
export const SIGNED_WIDTHS = [8, 24, 64, 128, 256] as const;
export type SignedWidth = (typeof SIGNED_WIDTHS)[number];

/** The four results of one operand pair, in the order the scripts return them. */
export interface SignedBitwiseResults {
  readonly and: bigint;
  readonly or: bigint;
  readonly xor: bigint;
  readonly not: bigint;
}

/** `a & b`, `a | b`, `a ^ b` and `~a` of two N-bit signed integers, as N-bit signed integers. */
export function signedBitwiseReference(bits: number, a: bigint, b: bigint): SignedBitwiseResults {
  return {
    and: BigInt.asIntN(bits, a & b),
    or: BigInt.asIntN(bits, a | b),
    xor: BigInt.asIntN(bits, a ^ b),
    not: BigInt.asIntN(bits, ~a),
  };
}

/** The ABI encoding of the four results: each word sign-extended to 256 bits. */
export function encodeSignedBitwise(r: SignedBitwiseResults): `0x${string}` {
  const word = (v: bigint): string => BigInt.asUintN(256, v).toString(16).padStart(64, '0');
  return `0x${word(r.and)}${word(r.or)}${word(r.xor)}${word(r.not)}`;
}

/**
 * Operands of an N-bit signed integer: zero, the small values of both signs, the two ends of
 * the range, and the two alternating bit patterns (`0101…` is positive, `1010…` negative).
 * `dense: false` keeps the eight that tell the operators apart, for the tests that pay a
 * network round trip per pair.
 */
export function signedOperands(bits: number, options: { readonly dense: boolean }): bigint[] {
  const min = -(1n << BigInt(bits - 1));
  const max = -min - 1n;
  const alternating = BigInt.asIntN(bits, BigInt(`0x${'55'.repeat(bits / 8)}`));
  const sparse = [0n, 1n, -1n, min, max, alternating, ~alternating, -7n];
  const more = [2n, -2n, 7n, min + 1n, max - 1n];
  return [...new Set(options.dense ? [...sparse, ...more] : sparse)];
}

/** Every ordered pair of `values`. */
export function operandPairs(values: readonly bigint[]): (readonly [bigint, bigint])[] {
  return values.flatMap((a) => values.map((b) => [a, b] as const));
}

/** The four operators over two script arguments: evaluated when the script runs. Both the
 *  method and the `s.*` forms are used. */
export function runtimeSignedBitwise(bits: SignedWidth) {
  const type: IntType = `int${bits}`;
  return evscript(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the width is dynamic over the matrix: the handles are typed as one representative
    { name: `signedBitwise${bits}`, args: [type, type] as unknown as ['int24', 'int24'] },
    (s, a, b) =>
      s.return({ and: a.bitAnd(b), or: s.bitOr(a, b), xor: s.bitXor(a, b), not: a.bitNot() }),
  );
}

/** The same four operators over literals: the recorder folds each one to a constant. A literal
 *  is used on either side of an `Expr`, and typed on both for `xor`. */
export function foldedSignedBitwise(bits: SignedWidth, a: bigint, b: bigint) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above: one representative width for the types
  const type = `int${bits}` as 'int24';
  return evscript({ name: `signedBitwise${bits}` }, (s) => {
    const x = s.lit(type, a);
    const y = s.lit(type, b);
    return s.return({ and: x.bitAnd(b), or: s.bitOr(a, y), xor: x.bitXor(y), not: x.bitNot() });
  });
}
