/**
 * `core/types/expr.ts` — `Expr`, the branded staged-value handle, and the host-literal types that
 * convert into it (`LitOf`, `TupleLitOf`, `IntoExpr`).
 */

import type { AbiParameterToPrimitiveType, AbiParameter } from 'viem';

import type {
  EvsType,
  NumericType,
  UintType,
  BitsType,
  IntType,
  DynType,
  ArrayType,
  ArrayElemOf,
  BytesNType,
  TupleType,
  StringType,
  OrderedType,
  UintOfBytesN,
  BytesNOfUint,
} from './vocabulary.js';

// ---------------------------------------------------------------------------
// Expr — the branded staged-value handle
// ---------------------------------------------------------------------------

export declare const exprBrand: unique symbol;

export interface Expr<t extends EvsType = EvsType> {
  readonly [exprBrand]: t; // nominal, covariant phantom
  readonly type: t; // runtime-readable type tag

  // arithmetic — checked (Panic 0x11 / 0x12); this-parameter restricts to numeric types
  add(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  sub(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  mul(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  div(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  mod(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  // checked exponentiation (solc `**`): Panic 0x11 when the power leaves t's range; the exponent
  // is unsigned — a literal or any Expr<'uintN'> (0 ** 0 == 1)
  pow(this: Expr<t & NumericType>, exponent: IntoExpr<'uint256'> | Expr<UintType>): Expr<t>;
  // full-precision modular arithmetic (ADDMOD / MULMOD — the intermediate never wraps), uint256
  // only like Solidity's builtins; Panic 0x12 on a zero modulus
  addmod(
    this: Expr<'uint256'>,
    rhs: IntoExpr<'uint256'>,
    modulus: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  mulmod(
    this: Expr<'uint256'>,
    rhs: IntoExpr<'uint256'>,
    modulus: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  // FullMath: ⌊this · rhs / denominator⌋ (⌈…⌉ for mulDivRoundingUp) over a 512-bit intermediate,
  // uint256 only; Panic 0x12 on a zero denominator, Panic 0x11 when the quotient overflows
  mulDiv(
    this: Expr<'uint256'>,
    rhs: IntoExpr<'uint256'>,
    denominator: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  mulDivRoundingUp(
    this: Expr<'uint256'>,
    rhs: IntoExpr<'uint256'>,
    denominator: IntoExpr<'uint256'>,
  ): Expr<'uint256'>;
  // wrapping arithmetic — solc `unchecked { … }`: the result modulo 2^N, two's complement for
  // intN; never a Panic (an explicit opt-out of the checked add / sub / mul above)
  wrappingAdd(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  wrappingSub(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  wrappingMul(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;

  // comparisons — LT/GT vs SLT/SGT chosen from the static type; `address` and `bytesN` order as
  // unsigned words (Solidity's `<` on them)
  lt(this: Expr<t & OrderedType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gt(this: Expr<t & OrderedType>, rhs: IntoExpr<t>): Expr<'bool'>;
  lte(this: Expr<t & OrderedType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gte(this: Expr<t & OrderedType>, rhs: IntoExpr<t>): Expr<'bool'>;
  // eq/neq: word equality, or HASH equality on memrefs — string/bytes byte-for-byte, arrays and
  // tuples element-wise via their standard ABI encoding (lowered to keccak256(a) == keccak256(b))
  eq(rhs: IntoExpr<t>): Expr<'bool'>;
  neq(rhs: IntoExpr<t>): Expr<'bool'>;

  // bool logic — eager, NOT short-circuiting (use s.if for conditional execution)
  and(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>;
  or(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>;
  not(this: Expr<'bool'>): Expr<'bool'>;

  // bitwise (result re-canonicalized to t's width)
  bitAnd(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitOr(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitXor(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitNot(this: Expr<t & BitsType>): Expr<t>;
  // shifts are unchecked (Solidity): the result is re-canonicalized to t's width; on intN, `shl`
  // re-sign-extends and `shr` is the arithmetic SAR (rounds toward −∞, like solc's `>>`)
  shl(this: Expr<t & (BitsType | IntType)>, bits: IntoExpr<'uint256'>): Expr<t>;
  shr(this: Expr<t & (BitsType | IntType)>, bits: IntoExpr<'uint256'>): Expr<t>;

  // conversions — widening free; NARROWING IS CHECKED (Panic 0x11 on out-of-range). toUint/toInt
  // convert between numeric types only: reach a uint from bytes32 through asUint256(), from an
  // address through asUint160(), from a bytesN through asUint() — on any other receiver the
  // compile error names that conversion (see {@link NumericReceiver})
  toUint<const u extends UintType>(this: NumericReceiver<t, 'toUint'>, target: u): Expr<u>;
  toInt<const i extends IntType>(this: NumericReceiver<t, 'toInt'>, target: i): Expr<i>;
  // checked from uint256/bytes32 (high 96 bits zero); free from uint160 (Solidity's address(u160))
  asAddress(this: Expr<'uint256' | 'bytes32' | 'uint160'>): Expr<'address'>;
  asUint160(this: Expr<'address'>): Expr<'uint160'>; // free (Solidity's uint160(addr))
  asUint256(this: Expr<'bytes32'>): Expr<'uint256'>; // free reinterpret
  asBytes32(this: Expr<'uint256'>): Expr<'bytes32'>; // free reinterpret
  // same-width bytesN ↔ uintN (Solidity's uint32(bytes4) / bytes4(uint32)): free, a shift
  // between the left-aligned bytesN lane and the right-aligned uintN one
  asUint(this: Expr<t & BytesNType>): Expr<UintOfBytesN<t>>;
  asBytesN(this: Expr<t & UintType>): Expr<BytesNOfUint<t>>;
  // string ↔ bytes: free reinterpret (the same memory). On a bytesN, `asString` copies its bytes
  // into a fresh string with the trailing zero bytes trimmed (the legacy bytes32 `symbol()`)
  asBytes(this: Expr<'string'>): Expr<'bytes'>;
  asString(this: Expr<'bytes' | BytesNType>): Expr<'string'>;

  // dynamic / array values (memrefs)
  length(this: Expr<DynType | ArrayType>): Expr<'uint256'>;
  // the byte at `i` of a string/bytes (Solidity's `b[i]`) — bounds-checked → Panic 0x32
  byteAt(this: Expr<DynType>, i: IntoExpr<'uint256'>): Expr<'bytes1'>;
  // a fresh copy of bytes [start, end) (`end` defaults to the length; Solidity's `b[start:end]`)
  // — Panic 0x32 unless start ≤ end ≤ length
  slice(this: Expr<t & DynType>, start: IntoExpr<'uint256'>, end?: IntoExpr<'uint256'>): Expr<t>;
  // element via FORWARD parsing of the receiver's own (concrete) `t` (see {@link ArrayElemOf}),
  // NOT a reverse-solved `elem extends StringType` against `${elem}[]` — same result type, but
  // this cut `tsc` check time ~10× by not pattern-matching the ~300-member union.
  // `t & ArrayType` still pins the receiver to the array vocabulary (dynamic `T[]` or fixed `T[N]`).
  at(this: Expr<t & ArrayType>, i: IntoExpr<'uint256'>): Expr<ArrayElemOf<t>>;
  // bounds-checked → Panic 0x32; tuple-element arrays use the composite `Tuple`/array handles
}

// ---------------------------------------------------------------------------
// NumericReceiver — the `this` type of toUint / toInt
// ---------------------------------------------------------------------------

export declare const conversionHint: unique symbol;

/**
 * The receiver `toUint` / `toInt` accept: an `Expr` of a numeric type. A non-numeric receiver
 * is rejected as by `Expr<t & NumericType>`, but against an object type no value has (keyed by
 * the type-only {@link conversionHint} symbol) whose one property is the
 * {@link ConversionHint} message, so tsc's error spells out the fix the recording-time
 * TYPE_MISMATCH gives:
 *
 * ```text
 * The 'this' context of type 'Expr<"address">' is not assignable to method's 'this' of type
 * '{ readonly [conversionHint]: ".toUint(): cannot convert from 'address' — the source must be
 * numeric (uintN/intN) — use .asUint160() first (then .toUint(…))"; }'.
 * ```
 *
 * The other member of the non-numeric branch is for a generic `t` (a type parameter bounded by
 * the numeric types): the checker relates its receiver to both branches of the deferred
 * conditional, and `Expr<t> & { type: NumericType }` accepts it. For a concrete `t` it accepts
 * no receiver (its `type` would be both `t` and numeric); for one non-tuple type it even reduces
 * to `never` (`t & NumericType` is: a disjoint discriminant), leaving the message alone in the
 * error.
 */
export type NumericReceiver<t extends EvsType, method extends 'toUint' | 'toInt'> = [t] extends [
  NumericType,
]
  ? Expr<t>
  :
      | (Expr<t> & { readonly type: NumericType })
      | { readonly [conversionHint]: ConversionHint<t, method> };

/**
 * The message of a non-numeric `toUint` / `toInt` receiver: the recording-time TYPE_MISMATCH's
 * text (`ops.ts`, pinned against it by `conversions.test.ts`), the same-width `as*` conversion
 * to use first included for an address or a bytesN. A tuple receiver's runtime text names its
 * JSON descriptor, which a type cannot spell, so its message leaves the source type out.
 */
export type ConversionHint<t extends EvsType, method extends 'toUint' | 'toInt'> = [t] extends [
  'address',
]
  ? `.${method}(): cannot convert from 'address' — the source must be numeric (uintN/intN) — use .asUint160() first (then .${method}(…))`
  : [t] extends [BytesNType]
    ? `.${method}(): cannot convert from '${t}' — the source must be numeric (uintN/intN) — use .asUint() first (same width, then .${method}(…))`
    : [t] extends [string]
      ? `.${method}(): cannot convert from '${t}' — the source must be numeric (uintN/intN)`
      : `.${method}(): the source must be numeric (uintN/intN)`;

export type LitOf<t extends EvsType> = t extends NumericType
  ? bigint | number
  : t extends 'address'
    ? `0x${string}`
    : t extends 'bool'
      ? boolean
      : t extends BytesNType
        ? `0x${string}`
        : t extends 'string'
          ? string
          : t extends 'bytes'
            ? `0x${string}`
            : t extends TupleType
              ? TupleLitOf<t>
              : t extends `${infer e}[]`
                ? e extends StringType
                  ? readonly (LitOf<e> | Expr<e>)[] // `T[]` (any depth); elements may be staged
                  : never
                : t extends `${infer e}[${number}]`
                  ? e extends StringType
                    ? readonly (LitOf<e> | Expr<e>)[] // `T[N]` — N enforced at recording (below)
                    : never
                  : t extends `${string}[${string}]`
                    ? // a multi-level chain with a fixed OUTER suffix (`T[2][3]`, `T[][2]`): the
                      // element comes from forward parsing, behind `NoInfer` (see the note below)
                      readonly (LitOf<NoInfer<ArrayElemOf<t>>> | Expr<NoInfer<ArrayElemOf<t>>>)[]
                    : never;
// Array literals — an element may be a host literal OR a staged `Expr` of the element type
// (`[x, 1n]`): the recorder builds such a literal element-wise. The shape of this arm is
// performance-critical. TypeScript infers a call's
// `t` BACKWARDS through `LitOf<t>` for every literal operand (`s.let(t.uint256, 0n)`,
// `s.add(x, 1n)`, …); an `infer e extends StringType` placeholder or a `[${'' | 1 | … | 99}]` size
// alphabet here made that inference ~15× slower (minutes per file). So the placeholders are
// unconstrained (`e extends StringType` is re-checked as a plain conditional), and a fixed-size
// `T[N]` literal is typed as `readonly LitOf<T>[]` (NOT an N-tuple — the exact length is enforced
// at recording with `TYPE_MISMATCH`). `${infer e}` stops at the FIRST `[`, so the two template
// arms only cover chains whose outer suffix is `[]` (any depth) and single-level `T[N]`; a
// multi-level chain whose OUTER suffix is fixed (`uint256[2][3]`, `uint256[][2]`, `bool[2][2]`)
// gets its element from {@link ArrayElemOf} (forward parsing of the concrete `t`) wrapped in
// `NoInfer`: a conditional in an inference target position would defeat the backward inference,
// and `NoInfer` keeps the inference from entering it. Every array shape is thus element-checked
// at the type level; lengths are validated exactly at recording.

/**
 * Host literal of a tuple: delegated to abitype, which applies the exact named-vs-positional
 * rule (every member named → an object keyed by names; any member unnamed → a positional
 * tuple) and recurses through nested components / array suffixes. A {@link TupleType} is
 * abitype-`AbiParameter`-shaped, so it plugs straight in.
 */
export type TupleLitOf<t extends TupleType> = AbiParameterToPrimitiveType<
  TupleAsParam<t>,
  'inputs'
>;

/** A {@link TupleType} viewed as an unnamed abitype `AbiParameter` (for inference). */
export type TupleAsParam<t extends TupleType> = {
  readonly name: '';
  readonly type: t['type'];
  readonly components: t['components'];
} & AbiParameter;

export type IntoExpr<t extends EvsType> = Expr<t> | LitOf<t>;
