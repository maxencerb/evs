/**
 * `core/types/vocabulary.ts` — the type vocabulary: word / dynamic / array / tuple type strings,
 * `EvsType`, and the type-level array-suffix parsing (`PeelArraySuffix`, `ArrayElemOf`, …).
 */

// ---------------------------------------------------------------------------
// type vocabulary
// ---------------------------------------------------------------------------

export type Hex = `0x${string}`;

// prettier-ignore
export type UintBits = 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64 | 72 | 80 | 88 | 96 | 104 | 112
  | 120 | 128 | 136 | 144 | 152 | 160 | 168 | 176 | 184 | 192 | 200 | 208 | 216 | 224 | 232
  | 240 | 248 | 256;
// prettier-ignore
export type BytesSize = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32;

export type UintType = `uint${UintBits}`;
export type IntType = `int${UintBits}`;
export type BytesNType = `bytes${BytesSize}`;
export type WordType = UintType | IntType | 'address' | 'bool' | BytesNType;
export type DynType = 'string' | 'bytes';
/**
 * A type whose ABI layout is captured entirely by its type **string**: a word, a dynamic
 * byte-blob, or an array (to any depth) of such. Tuples are NOT string-encoded — named members
 * cannot live in a string — they are {@link TupleType} descriptor objects.
 */
export type ScalarType = WordType | DynType;
/** Every string-encoded type (a {@link ScalarType} or an {@link ArrayType}). */
export type StringType = ScalarType | ArrayType;
/**
 * Arrays over a scalar leaf, string-encoded, nestable to ANY depth with a dynamic (`[]`) or
 * fixed-size (`[N]`, N ≥ 1) suffix at every level: `uint256[]`, `address[3]`, `string[][]`,
 * `uint256[2][]`, `bytes[][3][]`, …
 *
 * Shape — and why it is shaped this way (type-check PERFORMANCE, issue #4): the dynamic forms up
 * to three levels deep are spelled out as a FINITE union of ~300 exact literals (autocomplete +
 * O(log n) set membership), and everything else — any chain with a fixed size, deeper nesting —
 * is admitted by ONE catch-all pattern (`` `${string}[${string}` ``: something followed by an
 * array suffix). A single pattern is deliberate: TypeScript cannot reduce the intersection of
 * two different template patterns, so a union of N leaf-exact patterns (`` `${ScalarType}[…` ``,
 * N = 100) produced N² irreducible `` `uint8[…` & `uint16[…` `` junk members every time the
 * vocabulary was intersected with a type parameter (`Expr.at`'s `this: Expr<t & ArrayType>`,
 * `IntoMember`, …) and multiplied the full-package check time by ~6. With one pattern a literal
 * either matches it (the intersection collapses to the literal) or does not (`never`).
 *
 * Consequence: a concrete array type is always an EXACT literal (`t.array(t.uint256, 2)` is
 * `'uint256[2]'`; an `as const` ABI's `'int56[2]'` stays `'int56[2]'`), and {@link ArrayElemOf} /
 * {@link FixedLengthOf} / `.at()` / `s.forEach` recover its element and length exactly at any
 * depth. What the catch-all does NOT check at the type level is the LEAF of a fixed-size or
 * deeper-than-three-level string (`'foo[2]'` is assignable to `ArrayType`; its element is
 * `never`). The runtime (`isStringType`) is the exact authority — every entry point validates
 * eagerly (`TYPE_MISMATCH`), so a malformed leaf or suffix never reaches the IR.
 */
export type ArrayType =
  | `${ScalarType}[]`
  | `${ScalarType}[][]`
  | `${ScalarType}[][][]`
  | `${string}[${string}`;
/**
 * A tuple / struct type — an abitype `AbiParameter`-shaped descriptor (recursive, JSON-safe).
 * `type` carries any array suffix chain (`'tuple'`, `'tuple[]'`, `'tuple[2]'`, `'tuple[][]'`,
 * `'tuple[3][]'`, …) and `components` describe the (element) tuple's members. Built via
 * {@link t.struct} / {@link t.tuple} / {@link t.array}; a raw `readonly AbiParameter[]` is also
 * accepted wherever a tuple type is expected.
 */
export interface TupleType {
  readonly type: 'tuple' | `tuple[${string}`;
  readonly components: readonly NamedType[];
}
/**
 * A member of a {@link TupleType}: structurally an abitype `AbiParameter` (and the IR
 * `PlainAbiParam`). `type` is the canonical Solidity string (`'uint256'`, `'tuple'`,
 * `'tuple[]'`, `'uint256[]'`, …); `components` is present iff `type` starts with `'tuple'`. A
 * named struct field has a non-empty `name`; a positional tuple member has `name: ''`.
 */
export interface NamedType {
  readonly name: string;
  readonly type: string;
  readonly components?: readonly NamedType[];
}
export type EvsType = WordType | DynType | ArrayType | TupleType;

// -- suffix-chain parsing (type level) ----------------------------------------------------------
// A string-array type is parsed FRONT TO BACK, one `[size]` group per step, with plain two-
// placeholder template inference (`${infer a}[${infer b}` splits at the FIRST `[`, which is
// exactly where the leaf ends; `[${infer size}]${infer rest}` splits at the first `]`, which is
// exactly where one group ends). No size alphabet is involved: the earlier
// `${infer e}[${'' | 1 | … | 99}]` end-anchored trick (abitype's) put a 100-member template
// union into every `infer` and every conditional-vs-conditional comparison of `Expr.at`'s result.

/** The sizes of a suffix chain, front to back: `'[2][][3]'` → `['2', '', '3']`; `''` → `[]`;
 *  a malformed chain (`'[2'`) → `null` (a sentinel rather than `never`, which would match any
 *  tuple pattern downstream). */
type ArraySizes<s extends string, acc extends readonly string[] = []> = s extends ''
  ? acc
  : s extends `[${infer size}]${infer rest}`
    ? ArraySizes<rest, [...acc, size]>
    : null;

/** The inverse of {@link ArraySizes}: `['2', '']` → `'[2][]'`. */
type JoinSizes<sizes extends readonly string[]> = sizes extends readonly [
  infer size extends string,
  ...infer rest extends readonly string[],
]
  ? `[${size}]${JoinSizes<rest>}`
  : '';

/** `'uint256[2][]'` → `['uint256', ['2', '']]`; a suffix-less leaf → `[leaf, []]`; a malformed
 *  chain → `[leaf, null]`. */
type SplitArrayType<s extends string> = s extends `${infer leaf}[${infer tail}`
  ? [leaf, ArraySizes<`[${tail}`>]
  : [s, []];

/** The size group of `s`'s OUTERMOST suffix, as written: `'uint256[2][3]'` → `'3'`,
 *  `'tuple[2][]'` → `''` (dynamic); a suffix-less or malformed string → `null`. Forward parsing of
 *  a concrete string (overload resolution's fixed-length check compares it against a literal
 *  array's `` `${length}` ``, so no number parsing is involved). */
export type OuterArraySize<s extends string> =
  SplitArrayType<s> extends [string, [...string[], infer last extends string]] ? last : null;

/**
 * The OUTERMOST suffix (`[]` or `[N]`) peeled off a type string, at any depth: `'uint256[][]'` →
 * `'uint256[]'`, `'address[3]'` → `'address'`, `'uint256[][2]'` → `'uint256[]'`, `'tuple[2][]'` →
 * `'tuple[2]'`. A string with no suffix (or a malformed one) → `never`. Type-level mirror of the
 * runtime `peelArraySuffix` — shared by {@link ArrayElemOf} (string arrays) and the tuple-array
 * element dispatch in the builder.
 */
export type PeelArraySuffix<s extends string> =
  SplitArrayType<s> extends [
    infer leaf extends string,
    [...infer init extends readonly string[], string],
  ]
    ? `${leaf}${JoinSizes<init>}`
    : never;

/**
 * The element type of a string-array type — one suffix peeled (see {@link PeelArraySuffix}) and
 * re-checked against the vocabulary (a peeled leaf that is not a {@link StringType}, e.g. the
 * `'foo'` of `'foo[2]'`, is `never`). Computed by FORWARD parsing of the receiver's own concrete
 * `t`. The outer check is tuple-wrapped so it does NOT distribute: a concrete array type (or a
 * small union of them) yields its element(s), while a wide/non-array `t` (a loosely-typed
 * `Expr<EvsType>`) collapses to `never` instead of materializing a huge union.
 *
 * Perf: {@link Expr.at} computes its element via this instead of reverse-solving a generic
 * `elem extends StringType` against `${elem}[]` — forward parsing of the already-concrete
 * receiver type is ~free; reverse-matching a template against the union dominated check time.
 */
export type ArrayElemOf<t extends EvsType> = [t] extends [ArrayType]
  ? t extends string
    ? PeelArraySuffix<t> extends infer e extends StringType
      ? e
      : never
    : never
  : never;

/** The fixed length of `t`'s OUTERMOST suffix (`'uint256[3]'` → `3`, `'uint256[][2]'` → `2`), or
 *  `null` for a dynamic `[]` (or a non-array). Type-level mirror of the runtime `fixedLengthOf`:
 *  the size must be a positive decimal integer with no sign / leading zero (`'01'`, `'0'`, `'1e3'`
 *  → `null`, exactly the strings the runtime rejects as a malformed suffix). */
export type FixedLengthOf<t extends EvsType> = [t] extends [ArrayType]
  ? t extends string
    ? SplitArrayType<t> extends [string, [...string[], infer last extends string]]
      ? last extends `${infer n extends number}`
        ? `${n}` extends last // canonical decimal only: `'01'` / `'1e3'` infer a plain `number`
          ? last extends `${'-' | '0'}${string}` | `${string}.${string}`
            ? null
            : n
          : null
        : null
      : null
    : null
  : null;

export type ArgType = EvsType;
export type NumericType = UintType | IntType;
export type BitsType = UintType | BytesNType;
/** The ordering domain of `lt`/`gt`/`lte`/`gte` (Solidity's): the numeric types, plus `address`
 *  and `bytesN`, which compare as unsigned words (a `bytesN` byte by byte, lexicographically). */
export type OrderedType = NumericType | 'address' | BytesNType;

// -- same-width bytesN ↔ uintN (`asUint` / `asBytesN`) -------------------------------------------

// prettier-ignore
interface BytesSizeToBits {
  1: 8; 2: 16; 3: 24; 4: 32; 5: 40; 6: 48; 7: 56; 8: 64; 9: 72; 10: 80; 11: 88; 12: 96;
  13: 104; 14: 112; 15: 120; 16: 128; 17: 136; 18: 144; 19: 152; 20: 160; 21: 168; 22: 176;
  23: 184; 24: 192; 25: 200; 26: 208; 27: 216; 28: 224; 29: 232; 30: 240; 31: 248; 32: 256;
}
// prettier-ignore
interface BitsToBytesSize {
  8: 1; 16: 2; 24: 3; 32: 4; 40: 5; 48: 6; 56: 7; 64: 8; 72: 9; 80: 10; 88: 11; 96: 12;
  104: 13; 112: 14; 120: 15; 128: 16; 136: 17; 144: 18; 152: 19; 160: 20; 168: 21; 176: 22;
  184: 23; 192: 24; 200: 25; 208: 26; 216: 27; 224: 28; 232: 29; 240: 30; 248: 31; 256: 32;
}
/** The `uintN` as wide as a `bytesN` (`'bytes4'` → `'uint32'`) — `Expr.asUint()`'s result. */
export type UintOfBytesN<t extends EvsType> =
  t extends `bytes${infer n extends keyof BytesSizeToBits}` ? `uint${BytesSizeToBits[n]}` : never;
/** The `bytesN` as wide as a `uintN` (`'uint32'` → `'bytes4'`) — `Expr.asBytesN()`'s result. */
export type BytesNOfUint<t extends EvsType> =
  t extends `uint${infer n extends keyof BitsToBytesSize}` ? `bytes${BitsToBytesSize[n]}` : never;
