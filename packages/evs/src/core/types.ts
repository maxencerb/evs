/**
 * `core/types.ts` — the type vocabulary, `Expr` brand, `namedArg()`/`t`, and runtime type
 * predicates/metadata (single source of truth for all modules).
 */

import { EvsInternalError, EvsStagingError, EvsTypeError, type SourceLoc } from './errors.js';
import { captureLoc } from './loc.js';

// `Address` is re-exported from `abitype`; type-only — abitype is the only import core may take.
export type { Address } from 'abitype';
import type { Abi, AbiParameter, AbiParameterToPrimitiveType } from 'abitype';

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

  // comparisons — LT/GT vs SLT/SGT chosen from the static type
  lt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  lte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
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
  shl(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>;
  shr(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>; // SAR for intN via s.shr

  // conversions — widening free; NARROWING IS CHECKED (Panic 0x11 on out-of-range)
  toUint<const u extends UintType>(target: u): Expr<u>;
  toInt<const i extends IntType>(target: i): Expr<i>;
  asAddress(this: Expr<'uint256' | 'bytes32'>): Expr<'address'>; // checked: high 96 bits zero
  asUint256(this: Expr<'bytes32'>): Expr<'uint256'>; // free reinterpret
  asBytes32(this: Expr<'uint256'>): Expr<'bytes32'>; // free reinterpret

  // dynamic / array values (memrefs)
  length(this: Expr<DynType | ArrayType>): Expr<'uint256'>;
  // element via FORWARD parsing of the receiver's own (concrete) `t` (see {@link ArrayElemOf}),
  // NOT a reverse-solved `elem extends StringType` against `${elem}[]` — same result type, but
  // this cut `tsc` check time ~10× by not pattern-matching the ~300-member union.
  // `t & ArrayType` still pins the receiver to the array vocabulary (dynamic `T[]` or fixed `T[N]`).
  at(this: Expr<t & ArrayType>, i: IntoExpr<'uint256'>): Expr<ArrayElemOf<t>>;
  // bounds-checked → Panic 0x32; tuple-element arrays use the composite `Tuple`/array handles
}

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
                    ? readonly unknown[] // `T[][N]`-style suffix chains: widened (see the note below)
                    : never;
// Array literals — an element may be a host literal OR a staged `Expr` of the element type
// (`[x, 1n]`): the recorder builds such a literal element-wise. The shape of this arm is
// performance-critical. TypeScript infers a call's
// `t` BACKWARDS through `LitOf<t>` for every literal operand (`s.let(t.uint256, 0n)`,
// `s.add(x, 1n)`, …); an `infer e extends StringType` placeholder or a `[${'' | 1 | … | 99}]` size
// alphabet here made that inference ~15× slower (minutes per file). So the placeholders are
// unconstrained (`e extends StringType` is re-checked as a plain conditional), a fixed-size `T[N]`
// literal is typed as `readonly LitOf<T>[]` (NOT an N-tuple — the exact length is enforced at
// recording with `TYPE_MISMATCH`), and only a dynamic-inside-fixed chain (`uint256[][2]`) widens to
// `readonly unknown[]` (`${infer e}` stops at the FIRST `[`, so the element cannot be recovered
// in one match; {@link ArrayElemOf} is not used here on purpose — a conditional in an inference
// target position defeats the backward inference). The runtime validates every shape exactly.

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

// ---------------------------------------------------------------------------
// namedArg() declarator + the `t` type namespace
// ---------------------------------------------------------------------------

export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name;
  readonly type: type;
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

/**
 * Names a **top-level** arg/param so the name surfaces in the resulting type (issue #9): in a
 * script's `args`, the viem `args` tuple element is labeled (`[token: …]`); in an `s.fn`'s params,
 * the callback parameter is labeled (`(token) => …`). The `type` bound is {@link EvsType} — the
 * full parameter-type vocabulary (widened by #25 from `StringType`): words, `string`/`bytes`,
 * arrays, and composite `t.struct`/`t.tuple` descriptors (a named struct arg arrives as a `Tuple`
 * handle, exactly like a bare one — in a script's `args` and in an `s.fn`'s params alike). Nested
 * composite fields are named via `t.struct` and keep their behaviour. A bare (unnamed) top-level
 * arg keeps the positional `arg{i}` fallback name. Every array shape is admitted — dynamic `T[]`,
 * fixed-size `T[N]`, and any nesting of those (`tuple[][]`, `uint256[2][]`, `string[][]`, …).
 */
export function namedArg<const name extends string, const type extends EvsType>(
  name: name,
  type: type,
): ArgSpec<name, type> {
  if (!IDENT_RE.test(name)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `invalid argument name ${JSON.stringify(name)}: must be a non-empty identifier matching /^[A-Za-z_]\\w*$/`,
      { loc: captureLoc() },
    );
  }
  if (typeof type === 'string') {
    assertEvsType(type, `argument "${name}"`);
  } else if (!isEvsValueType(type)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `argument "${name}": expected a type (use the \`t\` namespace), got ${describeTypeInput(type)}`,
      { loc: captureLoc() },
    );
  }
  return Object.freeze({ name, type });
}

// ---------------------------------------------------------------------------
// args-input normalization (shared by `evscript` args, `s.fn` params, `t.error` params)
// ---------------------------------------------------------------------------
// These lived in builder/script.ts until issue #15; they are pure core/ material (EvsType +
// ArgSpec only) and `t.error` needs them, so they moved here. script.ts re-exports them
// verbatim — the builder's public surface is unchanged.

/**
 * One top-level arg/param declarator (issue #9): a bare `t.*` type, or a
 * {@link namedArg}-produced {@link ArgSpec} that labels the arg.
 */
export type ArgInput = EvsType | ArgSpec;

/**
 * Args/params input: a single {@link ArgInput} (a bare type or a {@link namedArg}), or a `readonly`
 * list of them (mixing named and bare). A lone declarator is sugar for a one-element list
 * (`args: t.uint256` ≡ `args: [t.uint256]`; `args: namedArg('x', t.uint256)` ≡ `args:
 * [namedArg('x', t.uint256)]`) — shared by `evscript` args, `s.fn` params, and `t.error` params.
 */
export type ArgsInput = ArgInput | readonly ArgInput[];

/** One declarator → its normalized {@link ArgSpec}: a {@link namedArg} keeps its spec; a bare type
 *  becomes an unnamed spec (`name: ''`) — the positional `arg{i}` fallback name is applied
 *  downstream (`ResolveArgName` / the recorder). */
export type ToArgSpec<d> = d extends ArgSpec ? d : d extends EvsType ? ArgSpec<'', d> : never;

/** Normalizes {@link ArgsInput} to the canonical `readonly ArgSpec[]` (lone declarator → one-tuple;
 *  homomorphic over a list so order/positions are preserved). */
export type NormalizeArgs<a extends ArgsInput> = a extends readonly ArgInput[]
  ? { readonly [i in keyof a]: ToArgSpec<a[i]> }
  : readonly [ToArgSpec<a>];

// The positional fallback name for arg position `i`: `arg{i}` for a concrete tuple index (a
// numeric-string key), but a plain `string` for the open `number` index of the default
// `readonly ArgSpec[]` instantiation — so `arg0`/`arg1` literals stay assignable to it (vs.
// collapsing to `never`, which would reject every concrete script).
export type ArgName<i> = i extends `${number}` ? `arg${i}` : string;

// The surfaced name of an arg at position `i`: its user-provided {@link namedArg} name, or the
// positional `arg{i}` fallback when the arg was passed bare (an empty sentinel name). issue #9.
export type ResolveArgName<name extends string, i> = name extends '' ? ArgName<i> : name;

// A normalized ArgSpec tuple → labeled abitype input components: each entry is labeled with its
// user name (`namedArg`) or the positional `arg0`/`arg1`/… fallback, and a tuple arg expands to
// `{ name, type: 'tuple', components }` via {@link TypeToComponent}. A purely HOMOMORPHIC mapped
// type — order/labels preserved structurally (no `UnionToTuple`), and no conditional over `args`
// itself, so `args` stays a COVARIANT type parameter. (Moved from abi/artifact.ts — issue #15 —
// which re-exports it; `t.error` uses it for the literal error-ABI inputs.)
export type ArgsToInputs<args extends readonly ArgSpec[]> = {
  readonly [i in keyof args]: TypeToComponent<ResolveArgName<args[i]['name'], i>, args[i]['type']>;
};

// ---------------------------------------------------------------------------
// custom error declarations — `t.error` (issue #15)
// ---------------------------------------------------------------------------

/** The literal `{ type: 'error', name, inputs }` ABI entry carried by an {@link EvsErrorType}
 *  (spreadable into any viem ABI; appended to the script ABI by `buildScriptAbi`). */
export interface EvsErrorAbiEntry<
  name extends string = string,
  params extends readonly ArgSpec[] = readonly ArgSpec[],
> {
  readonly type: 'error';
  readonly name: name;
  readonly inputs: ArgsToInputs<params>;
}

/**
 * A declared custom error (issue #15): a module-level value created by {@link t.error},
 * declared on a script def (`errors: [...]`) and thrown with `s.throw`. Carries the normalized
 * param specs and the literal ABI entry; the 4-byte selector is derived downstream
 * (`selectorOf` in abi/artifact.ts — core stays viem-free), byte-identical to Solidity's over
 * the canonical signature.
 */
export interface EvsErrorType<
  name extends string = string,
  params extends readonly ArgSpec[] = readonly ArgSpec[],
> {
  readonly kind: 'error'; // runtime discriminant (an EvsType is a string or TupleType)
  readonly name: name;
  readonly params: params; // normalized ArgSpecs (namedArg names or '' sentinels)
  readonly abi: EvsErrorAbiEntry<name, params>;
}

// -- type-level record→ordered-components machinery (UnionToTuple) -----------------------------
// A struct record is unordered at the type level; recovering an order needs `UnionToTuple`,
// whose order is TS-internal-id order, NOT declaration order. That is SAFE here because a struct
// compiles to a single NAMED ABI `tuple` which abitype infers as an ORDER-INSENSITIVE object;
// runtime encode order is `Object.keys()` insertion order (the only source of truth). Positional
// `t.tuple(...)` and script args use ordered declarators and never touch `UnionToTuple`.
type UnionToIntersection<u> = (u extends unknown ? (k: u) => void : never) extends (
  k: infer i,
) => void
  ? i
  : never;
type LastOf<u> =
  UnionToIntersection<u extends unknown ? () => u : never> extends () => infer r ? r : never;
type UnionToTuple<u, acc extends readonly unknown[] = []> = [u] extends [never]
  ? acc
  : UnionToTuple<Exclude<u, LastOf<u>>, [LastOf<u>, ...acc]>;

/** A single `t.*` type → an abitype component descriptor (a {@link NamedType}). */
export type TypeToComponent<name extends string, ty extends EvsType> = ty extends TupleType
  ? { readonly name: name; readonly type: ty['type']; readonly components: ty['components'] }
  : { readonly name: name; readonly type: ty };
/** `t.struct({...})` → a named-components tuple type (key order irrelevant; see above). */
export type StructTypeOf<spec extends Record<string, EvsType>> = {
  readonly type: 'tuple';
  readonly components: {
    readonly [i in keyof UnionToTuple<keyof spec>]: UnionToTuple<keyof spec>[i] extends infer k
      ? k extends keyof spec & string
        ? TypeToComponent<k, spec[k]>
        : never
      : never;
  };
};
/** `t.tuple(a, b, …)` → a positional (unnamed-components) tuple type — order is structural. */
export type TupleTypeOf<items extends readonly EvsType[]> = {
  readonly type: 'tuple';
  readonly components: { readonly [i in keyof items]: TypeToComponent<'', items[i]> };
};
/** `t.array(tupleType)` / `t.array(tupleType, n)` → an array-of-tuple type one suffix deeper:
 *  `'tuple'` → `'tuple[]'` (or `'tuple[n]'` for a fixed length), `'tuple[]'` → `'tuple[][]'`, …
 *  A concrete element tag yields the exact literal (the element-handle dispatch relies on
 *  `tuple[]` vs `tuple[][]` staying distinguishable — issue #12 follow-up); a constraint-widened
 *  `e['type']` keeps the honest pattern union. */
export type TupleArrayOf<e extends TupleType, n extends number | null = null> = {
  readonly type: `${e['type']}[${n extends number ? n : ''}]` & TupleType['type'];
  readonly components: e['components'];
};

// -- ABI → `t.*` type derivation (`t.fromOutputs` / `t.fromAbiParameter`, issue #5 ask #4) -------
// ABI parameters are an already-ORDERED `AbiParameter[]`, so deriving a type from them is SAFER
// than `t.struct` — it sidesteps the `UnionToTuple` record-key-order instability entirely (the
// derived components are in ABI declaration order, matching the runtime decode + `s.read({...,
// struct: true})`).

/** An abitype `AbiParameter`'s `name` (`''` when absent) — abitype params name is optional. */
type AbiParamName<p extends AbiParameter> = p extends { readonly name: infer n extends string }
  ? n
  : '';

/** One ABI `AbiParameter` → a canonical {@link NamedType} component (recursing into tuple
 *  components, preserving names/order). The mirror of {@link ComponentToType} in the ABI→type
 *  direction, normalizing the optional `name` to a string so the result is a valid `NamedType`. */
export type AbiParamToComponent<p extends AbiParameter> = p extends {
  readonly type: `tuple${string}`;
  readonly components: infer comps extends readonly AbiParameter[];
}
  ? {
      readonly name: AbiParamName<p>;
      readonly type: p['type'];
      readonly components: AbiParamsToComponents<comps>;
    }
  : { readonly name: AbiParamName<p>; readonly type: p['type'] };

/** A list of ABI `AbiParameter`s → {@link NamedType} components (homomorphic — order preserved). */
export type AbiParamsToComponents<ps extends readonly AbiParameter[]> = {
  readonly [i in keyof ps]: AbiParamToComponent<ps[i]>;
};

/** One ABI `AbiParameter` → its {@link EvsType}: a `tuple…` param → the matching {@link TupleType}
 *  descriptor; every scalar/array param → its type string. The type-level mirror of core's
 *  `abiParamToType`. */
export type AbiParamToEvsType<p extends AbiParameter> = p extends {
  readonly type: `tuple${string}`;
  readonly components: infer comps extends readonly AbiParameter[];
}
  ? {
      readonly type: p['type'] & TupleType['type'];
      readonly components: AbiParamsToComponents<comps>;
    }
  : Extract<p['type'], EvsType>;

/** The view/pure-or-any `function` entry of `abi` named `name` (a union if overloaded). */
type AbiFnNamed<abi, name extends string> = abi extends Abi
  ? Extract<abi[number], { readonly type: 'function'; readonly name: name }>
  : never;

/**
 * `t.fromOutputs(abi, name)` → the {@link EvsType} of the function's outputs: a SINGLE output →
 * that output's type (a {@link TupleType} for a tuple output, else the scalar/array string); MANY
 * outputs → a {@link TupleType} struct over the (named, ABI-ordered) outputs. A non-`const` ABI /
 * unknown name degrades to {@link EvsType} (never a hard error — mirrors `s.call` widening).
 */
export type FromAbiOutputs<abi, name extends string> = [AbiFnNamed<abi, name>] extends [never]
  ? EvsType
  : AbiFnNamed<abi, name> extends { readonly outputs: infer outs extends readonly AbiParameter[] }
    ? outs extends readonly [infer one extends AbiParameter]
      ? AbiParamToEvsType<one>
      : { readonly type: 'tuple'; readonly components: AbiParamsToComponents<outs> }
    : EvsType;

type TypeNamespace = { readonly [k in WordType | DynType]: k } & {
  // `t.array(elem)` → a dynamic `elem[]`; `t.array(elem, n)` → a fixed-size `elem[n]` (n ≥ 1,
  // a literal number). Both nest to any depth (`t.array(t.array(t.uint256, 2))` → `uint256[2][]`).
  array<const e extends StringType>(elem: e): `${e}[]`;
  array<const e extends StringType, const n extends number>(elem: e, length: n): `${e}[${n}]`;
  array<const e extends TupleType>(elem: e): TupleArrayOf<e>;
  array<const e extends TupleType, const n extends number>(elem: e, length: n): TupleArrayOf<e, n>;
  struct<const spec extends Record<string, EvsType>>(spec: spec): StructTypeOf<spec>;
  tuple<const items extends readonly EvsType[]>(...items: items): TupleTypeOf<items>;
  // declare a custom error (issue #15): params take the same shorthand as `evscript` args /
  // `s.fn` params — a bare `t.*` type, a single `namedArg(...)`, or a `readonly` list mixing
  // named and bare (bare params get the positional `arg{i}` fallback name).
  error<const name extends string, const params extends ArgsInput = readonly []>(
    name: name,
    params?: params,
  ): EvsErrorType<name, NormalizeArgs<params>>;
  // derive a `t.*` type from an ABI function's outputs / a single ABI parameter (issue #5 ask #4):
  fromOutputs<const abi extends Abi | readonly unknown[], const name extends string>(
    abi: abi,
    name: name,
  ): FromAbiOutputs<abi, name>;
  fromAbiParameter<const p extends AbiParameter>(param: p): AbiParamToEvsType<p>;
};

const UINT_BITS_LIST: readonly number[] = Array.from({ length: 32 }, (_, i) => 8 * (i + 1));
const BYTES_SIZE_LIST: readonly number[] = Array.from({ length: 32 }, (_, i) => i + 1);

function buildWordTypeSets(): {
  word: ReadonlySet<string>;
  numeric: ReadonlySet<string>;
  signed: ReadonlySet<string>;
  bits: ReadonlyMap<string, number>;
} {
  const word = new Set<string>(['address', 'bool']);
  const numeric = new Set<string>();
  const signed = new Set<string>();
  const bits = new Map<string, number>([
    ['address', 160],
    ['bool', 8], // canonical 0/1
  ]);
  for (const n of UINT_BITS_LIST) {
    word.add(`uint${n}`).add(`int${n}`);
    numeric.add(`uint${n}`).add(`int${n}`);
    signed.add(`int${n}`);
    bits.set(`uint${n}`, n);
    bits.set(`int${n}`, n);
  }
  for (const n of BYTES_SIZE_LIST) {
    word.add(`bytes${n}`);
    bits.set(`bytes${n}`, 8 * n);
  }
  return { word, numeric, signed, bits };
}

const SETS = buildWordTypeSets();

// frozen namespace: the overloaded method types are the authority; the impls are intentionally
// `unknown`-typed and validate at runtime (double-cast through `unknown`).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const t: TypeNamespace = Object.freeze({
  address: 'address',
  bool: 'bool',
  uint8: 'uint8',
  uint16: 'uint16',
  uint24: 'uint24',
  uint32: 'uint32',
  uint40: 'uint40',
  uint48: 'uint48',
  uint56: 'uint56',
  uint64: 'uint64',
  uint72: 'uint72',
  uint80: 'uint80',
  uint88: 'uint88',
  uint96: 'uint96',
  uint104: 'uint104',
  uint112: 'uint112',
  uint120: 'uint120',
  uint128: 'uint128',
  uint136: 'uint136',
  uint144: 'uint144',
  uint152: 'uint152',
  uint160: 'uint160',
  uint168: 'uint168',
  uint176: 'uint176',
  uint184: 'uint184',
  uint192: 'uint192',
  uint200: 'uint200',
  uint208: 'uint208',
  uint216: 'uint216',
  uint224: 'uint224',
  uint232: 'uint232',
  uint240: 'uint240',
  uint248: 'uint248',
  uint256: 'uint256',
  int8: 'int8',
  int16: 'int16',
  int24: 'int24',
  int32: 'int32',
  int40: 'int40',
  int48: 'int48',
  int56: 'int56',
  int64: 'int64',
  int72: 'int72',
  int80: 'int80',
  int88: 'int88',
  int96: 'int96',
  int104: 'int104',
  int112: 'int112',
  int120: 'int120',
  int128: 'int128',
  int136: 'int136',
  int144: 'int144',
  int152: 'int152',
  int160: 'int160',
  int168: 'int168',
  int176: 'int176',
  int184: 'int184',
  int192: 'int192',
  int200: 'int200',
  int208: 'int208',
  int216: 'int216',
  int224: 'int224',
  int232: 'int232',
  int240: 'int240',
  int248: 'int248',
  int256: 'int256',
  bytes1: 'bytes1',
  bytes2: 'bytes2',
  bytes3: 'bytes3',
  bytes4: 'bytes4',
  bytes5: 'bytes5',
  bytes6: 'bytes6',
  bytes7: 'bytes7',
  bytes8: 'bytes8',
  bytes9: 'bytes9',
  bytes10: 'bytes10',
  bytes11: 'bytes11',
  bytes12: 'bytes12',
  bytes13: 'bytes13',
  bytes14: 'bytes14',
  bytes15: 'bytes15',
  bytes16: 'bytes16',
  bytes17: 'bytes17',
  bytes18: 'bytes18',
  bytes19: 'bytes19',
  bytes20: 'bytes20',
  bytes21: 'bytes21',
  bytes22: 'bytes22',
  bytes23: 'bytes23',
  bytes24: 'bytes24',
  bytes25: 'bytes25',
  bytes26: 'bytes26',
  bytes27: 'bytes27',
  bytes28: 'bytes28',
  bytes29: 'bytes29',
  bytes30: 'bytes30',
  bytes31: 'bytes31',
  bytes32: 'bytes32',
  string: 'string',
  bytes: 'bytes',
  array(elem: unknown, length?: unknown): unknown {
    return arrayTypeRT(elem, length);
  },
  struct(spec: unknown): unknown {
    return structTypeRT(spec);
  },
  tuple(...items: unknown[]): unknown {
    return tupleTypeRT(items);
  },
  error(name: unknown, params?: unknown): unknown {
    return errorTypeRT(name, params);
  },
  fromOutputs(abi: unknown, name: unknown): unknown {
    return fromOutputsRT(abi, name);
  },
  fromAbiParameter(param: unknown): unknown {
    return fromAbiParameterRT(param);
  },
} as const) as unknown as TypeNamespace;

// ---------------------------------------------------------------------------
// runtime type predicates / metadata
// ---------------------------------------------------------------------------

// The trailing array suffix of a type string: `[]` (dynamic) or `[N]` (fixed, N ≥ 1 with no
// leading zero). Greedy `(.*)` anchors the match at the LAST suffix, so the inner type keeps its
// own suffix chain (`uint256[2][]` → inner `uint256[2]`, size `[]`).
const ARRAY_SUFFIX_RE = /^(.*)\[([1-9]\d*)?\]$/;
/** A tuple tag: `tuple` followed by zero or more `[]`/`[N]` suffixes. */
const TUPLE_TAG_RE = /^tuple(?:\[(?:[1-9]\d*)?\])*$/;
/** Fixed-size arrays at or above this length cannot be allocated (`arrnew` Panics 0x41 there),
 *  so the vocabulary rejects them outright rather than admitting an unconstructible type. */
const MAX_FIXED_LENGTH = 0xffffffff;

/**
 * Splits one trailing array suffix off a type string: `'uint256[]'` → `{ inner: 'uint256',
 * length: null }`, `'uint256[3][]'` → `{ inner: 'uint256[3]', length: null }`, `'address[2]'` →
 * `{ inner: 'address', length: 2 }`. `null` when `s` has no well-formed trailing suffix (a bare
 * type, or a malformed suffix such as `[0]`/`[01]`/`[x]`). Works on tuple tags too.
 */
export function peelArraySuffix(s: string): { inner: string; length: number | null } | null {
  const m = ARRAY_SUFFIX_RE.exec(s);
  if (m === null) return null;
  const inner = m[1] ?? '';
  const digits = m[2];
  if (digits === undefined) return { inner, length: null };
  const length = Number(digits);
  if (!Number.isSafeInteger(length) || length > MAX_FIXED_LENGTH) return null;
  return { inner, length };
}

/** Recognizes a string-encoded type (word, dynamic, or an array of such to any depth, with
 *  dynamic or fixed-size suffixes). */
export function isStringType(s: string): s is StringType {
  if (isWordType(s) || s === 'string' || s === 'bytes') return true;
  const peeled = peelArraySuffix(s);
  return peeled !== null && isStringType(peeled.inner);
}

/** A well-formed tuple tag (`'tuple'`, `'tuple[]'`, `'tuple[2]'`, `'tuple[][3]'`, …). */
export function isTupleTag(s: string): s is TupleType['type'] {
  if (!TUPLE_TAG_RE.test(s)) return false;
  // re-walk the suffix chain through `peelArraySuffix` so oversized fixed lengths are rejected
  let cur = s;
  while (cur !== 'tuple') {
    const peeled = peelArraySuffix(cur);
    if (peeled === null) return false;
    cur = peeled.inner;
  }
  return true;
}

/** A composite (tuple/struct) type descriptor — the only non-string {@link EvsType}. */
export function isTupleType(v: unknown): v is TupleType {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as { type?: unknown; components?: unknown };
  return typeof o.type === 'string' && isTupleTag(o.type) && Array.isArray(o.components);
}

/** Any valid {@link EvsType} value (string-encoded or a tuple descriptor). */
export function isEvsValueType(v: unknown): v is EvsType {
  return (
    (typeof v === 'string' && isStringType(v)) || (isTupleType(v) && componentsValid(v.components))
  );
}

function componentsValid(components: readonly unknown[]): boolean {
  return components.every((c) => {
    if (typeof c !== 'object' || c === null) return false;
    const o = c as { name?: unknown; type?: unknown; components?: unknown };
    if (typeof o.name !== 'string' || typeof o.type !== 'string') return false;
    if (o.type.startsWith('tuple')) {
      return isTupleTag(o.type) && Array.isArray(o.components) && componentsValid(o.components);
    }
    return isStringType(o.type) && o.components === undefined;
  });
}

/** String type validity (word, dynamic, nested arrays). Tuples are objects — see {@link isEvsValueType}. */
export function isEvsType(s: string): s is StringType {
  return isStringType(s);
}

export function isWordType(s: string | TupleType): s is WordType {
  return typeof s === 'string' && SETS.word.has(s);
}

export function isNumeric(s: EvsType): s is NumericType {
  return typeof s === 'string' && SETS.numeric.has(s);
}

/** `intN` → true; every other evs type (incl. `intN[]`, tuples) → false. */
export function isSigned(s: EvsType): boolean {
  return typeof s === 'string' && SETS.signed.has(s);
}

/** address→160, bool→8 (canonical 0/1), bytesN→8N, uintN/intN→N. */
export function bitsOf(s: WordType): number {
  const bits = SETS.bits.get(s);
  if (bits === undefined) {
    throw new EvsTypeError('TYPE_MISMATCH', `bitsOf: ${JSON.stringify(s)} is not a word type`, {
      loc: captureLoc(),
    });
  }
  return bits;
}

/** Memref-valued (not a single stack word): string | bytes | any array (`T[]`/`T[N]`) | tuple. */
export function isDynamicType(s: EvsType): boolean {
  if (typeof s !== 'string') return true; // tuples are always memref pointers
  return s === 'string' || s === 'bytes' || s.endsWith(']');
}

/**
 * True when `abi.encodePacked` accepts a value of this type (issue #17): a word, `string`/`bytes`,
 * or a word-element array — dynamic `T[]` or fixed `T[N]` — whose elements pack padded to 32
 * bytes, per the Solidity spec. Everything Solidity rejects in packed mode — structs, nested
 * arrays, arrays of dynamic elements — is false here; `s.encode` (standard ABI) handles those.
 */
export function isPackedEncodable(s: EvsType): boolean {
  if (typeof s !== 'string') return false; // tuple / tuple[] descriptors
  if (isWordType(s) || s === 'string' || s === 'bytes') return true;
  const peeled = peelArraySuffix(s);
  return peeled !== null && isWordType(peeled.inner);
}

/** An array type — dynamic `T[]` or fixed-size `T[N]`, string array or tuple array. */
export function isArrayValueType(s: EvsType): s is ArrayType | TupleType {
  return typeof s === 'string' ? s.endsWith(']') : s.type !== 'tuple';
}

/** The fixed length `N` of an array type `T[N]`, or `null` for a dynamic `T[]`. Throws for a
 *  non-array type. Only the OUTERMOST suffix is consulted (`uint256[2][]` → `null`). */
export function fixedLengthOf(s: ArrayType | TupleType): number | null {
  const peeled = peelArraySuffix(typeof s === 'string' ? s : s.type);
  if (peeled === null) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `fixedLengthOf: ${typeof s === 'string' ? JSON.stringify(s) : 'a tuple'} is not an array type`,
      { loc: captureLoc() },
    );
  }
  return peeled.length;
}

/** The element type of an array type: the outermost suffix peeled off (string arrays), or the
 *  element tuple / tuple-array descriptor with the same components (tuple arrays). */
export function elemTypeOf(s: ArrayType | TupleType): EvsType {
  if (typeof s === 'string') {
    const peeled = peelArraySuffix(s);
    if (peeled !== null && isStringType(peeled.inner)) return peeled.inner;
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `elemTypeOf: ${JSON.stringify(s)} is not an array type`,
      { loc: captureLoc() },
    );
  }
  const peeled = peelArraySuffix(s.type);
  if (s.type === 'tuple' || peeled === null || !isTupleTag(peeled.inner)) {
    throw new EvsTypeError('TYPE_MISMATCH', `elemTypeOf: a tuple is not an array type`, {
      loc: captureLoc(),
    });
  }
  // 'tuple[]' → 'tuple', 'tuple[][]' → 'tuple[]', 'tuple[3][]' → 'tuple[3]'
  return Object.freeze({ type: peeled.inner, components: s.components });
}

/** Structural equality of two value types — deep for tuples, `===` for string types. Tuple
 *  descriptors are fresh objects (never reference-equal), so callers must use this, not `===`. */
export function typesEqual(a: EvsType, b: EvsType): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.type !== b.type || a.components.length !== b.components.length) return false;
  return a.components.every((ca, i) => {
    const cb = b.components[i];
    return (
      cb !== undefined && ca.name === cb.name && typesEqual(abiParamToType(ca), abiParamToType(cb))
    );
  });
}

/** A {@link NamedType} / IR `PlainAbiParam` → its {@link EvsType} (a string, or a TupleType when
 *  the param carries `components`). */
export function abiParamToType(p: { type: string; components?: readonly NamedType[] }): EvsType {
  if (p.type.startsWith('tuple') && p.components !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded by startsWith('tuple') + components present
    return { type: p.type as TupleType['type'], components: p.components };
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- non-tuple PlainAbiParam types are string-encoded EvsTypes
  return p.type as EvsType;
}

/** An {@link EvsType} → an abitype param/component with `name`. Inverse of {@link abiParamToType}. */
export function typeToAbiParam(name: string, ty: EvsType): NamedType {
  if (typeof ty === 'string') return Object.freeze({ name, type: ty });
  return Object.freeze({ name, type: ty.type, components: ty.components });
}

// ---------------------------------------------------------------------------
// `t.struct` / `t.tuple` / `t.array` runtime constructors
// ---------------------------------------------------------------------------

/** A user-supplied member/element type → a canonical {@link NamedType} component. Accepts a
 *  type string, a {@link TupleType}, or a raw `readonly AbiParameter[]` (interpreted as a tuple's
 *  components). */
function toComponentRT(name: string, ty: unknown, ctx: string): NamedType {
  if (typeof ty === 'string') {
    assertEvsType(ty, ctx);
    return Object.freeze({ name, type: ty });
  }
  if (isTupleType(ty)) {
    return Object.freeze({
      name,
      type: ty.type,
      components: normalizeComponents(ty.components, ctx),
    });
  }
  if (Array.isArray(ty)) {
    return Object.freeze({ name, type: 'tuple', components: componentsFromAbi(ty, ctx) });
  }
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `${ctx}: expected a type (use the \`t\` namespace), got ${describeTypeInput(ty)}`,
    { loc: captureLoc() },
  );
}

function describeTypeInput(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'bigint') return `${v}n`;
  return JSON.stringify(v);
}

function normalizeComponents(components: readonly NamedType[], ctx: string): readonly NamedType[] {
  return Object.freeze(
    components.map((c) =>
      c.components === undefined
        ? toComponentRT(c.name, c.type, ctx)
        : Object.freeze({
            name: c.name,
            type: c.type,
            components: normalizeComponents(c.components, ctx),
          }),
    ),
  );
}

/** Validate + canonicalize a raw `readonly AbiParameter[]` into tuple components. */
function componentsFromAbi(params: readonly unknown[], ctx: string): readonly NamedType[] {
  if (params.length === 0) {
    throw new EvsTypeError('TYPE_MISMATCH', `${ctx}: a tuple must have at least one component`, {
      loc: captureLoc(),
    });
  }
  return Object.freeze(
    params.map((p, i) => {
      if (typeof p !== 'object' || p === null) {
        throw new EvsTypeError('TYPE_MISMATCH', `${ctx}: component #${i} is not an ABI parameter`, {
          loc: captureLoc(),
        });
      }
      const o = p as { name?: unknown; type?: unknown; components?: unknown };
      const name = typeof o.name === 'string' ? o.name : '';
      if (typeof o.type !== 'string') {
        throw new EvsTypeError('TYPE_MISMATCH', `${ctx}: component #${i} has no \`type\``, {
          loc: captureLoc(),
        });
      }
      if (o.type.startsWith('tuple')) {
        if (!Array.isArray(o.components)) {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${ctx}: tuple component #${i} ("${name}") has no \`components\``,
            { loc: captureLoc() },
          );
        }
        return Object.freeze({
          name,
          type: o.type,
          components: componentsFromAbi(o.components, ctx),
        });
      }
      assertEvsType(o.type, `${ctx} component #${i}`);
      return Object.freeze({ name, type: o.type });
    }),
  );
}

function structTypeRT(spec: unknown): TupleType {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `t.struct(): expected a record of { field: type }, got ${describeTypeInput(spec)}`,
      { loc: captureLoc() },
    );
  }
  const entries = Object.entries(spec);
  if (entries.length === 0) {
    throw new EvsTypeError('TYPE_MISMATCH', `t.struct(): a struct must have at least one field`, {
      loc: captureLoc(),
    });
  }
  const components = entries.map(([name, ty]) => {
    if (!IDENT_RE.test(name)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `t.struct(): field name ${JSON.stringify(name)} must be a non-empty identifier (an empty/odd name would collapse the struct to a positional array on the viem side)`,
        { loc: captureLoc() },
      );
    }
    return toComponentRT(name, ty, `t.struct() field "${name}"`);
  });
  return Object.freeze({ type: 'tuple', components: Object.freeze(components) });
}

function tupleTypeRT(items: readonly unknown[]): TupleType {
  if (items.length === 0) {
    throw new EvsTypeError('TYPE_MISMATCH', `t.tuple(): a tuple must have at least one member`, {
      loc: captureLoc(),
    });
  }
  const components = items.map((ty, i) => toComponentRT('', ty, `t.tuple() member #${i}`));
  return Object.freeze({ type: 'tuple', components: Object.freeze(components) });
}

/** The tuple-array tag one suffix deeper than `tag`: `('tuple', null)` → `'tuple[]'`,
 *  `('tuple[]', 2)` → `'tuple[][2]'`. The one place the tag string is rebuilt (shared by the
 *  builder and the validator so the IR/type tags never drift). */
export function tupleArrayTag(tag: TupleType['type'], fixed: number | null): TupleType['type'] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- appending a well-formed `[]`/`[N]` suffix to a tuple tag yields a tuple tag
  return `${tag}${fixed === null ? '[]' : `[${fixed}]`}` as TupleType['type'];
}

/** `t.array(elem)` → `elem[]`; `t.array(elem, n)` → `elem[n]`. The suffix string is validated
 *  through the same parser every other entry point uses (`isStringType`/`isTupleTag`), so the
 *  runtime and type-level vocabularies agree by construction. Nesting is unbounded. */
function arrayTypeRT(elem: unknown, length: unknown): EvsType {
  const suffix = arraySuffixRT(length, 't.array()');
  if (typeof elem === 'string') {
    assertEvsType(elem, 't.array() element');
    return `${elem}${suffix}`;
  }
  const fixed = suffix === '[]' ? null : Number(suffix.slice(1, -1));
  if (isTupleType(elem)) {
    return Object.freeze({
      type: tupleArrayTag(elem.type, fixed),
      components: normalizeComponents(elem.components, 't.array()'),
    });
  }
  if (Array.isArray(elem)) {
    return Object.freeze({
      type: tupleArrayTag('tuple', fixed),
      components: componentsFromAbi(elem, 't.array()'),
    });
  }
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `t.array(): element type ${describeTypeInput(elem)} is not a type (use the \`t\` namespace)`,
    { loc: captureLoc() },
  );
}

/** The `[]` / `[n]` suffix for an optional fixed length: `undefined` → dynamic; otherwise a
 *  positive safe integer below 2^32 (the allocation cap) → fixed. */
function arraySuffixRT(length: unknown, ctx: string): '[]' | `[${number}]` {
  if (length === undefined) return '[]';
  const n = typeof length === 'bigint' ? Number(length) : length;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_FIXED_LENGTH) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${ctx}: a fixed array length must be a positive integer below 2^32, got ${describeTypeInput(length)}`,
      { loc: captureLoc() },
    );
  }
  return `[${n}]`;
}

/** A non-null, non-array object — narrows `unknown` to a property-indexable record. */
function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `t.fromOutputs(abi, name)` runtime: locate the function named `name`, validate + canonicalize
 * its outputs through {@link componentsFromAbi}, and return a SINGLE output's {@link EvsType}
 * directly or wrap MANY outputs in a `tuple` {@link TupleType} (named, in ABI order). The result
 * flows wherever a `t.struct`/`t.tuple` type does and round-trips with a
 * `s.read({…, struct: true})` decode of the same function.
 *
 * Overloads: there are no call args here to pick an overload by (unlike `s.read`/`s.call`), so
 * an overloaded name is accepted only when every overload declares the SAME outputs (the derived
 * type is then unambiguous); otherwise `UNSUPPORTED_V0` tells the caller how to prune the ABI.
 */
function fromOutputsRT(abi: unknown, name: unknown): EvsType {
  if (typeof name !== 'string') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `t.fromOutputs(): functionName must be a string, got ${describeTypeInput(name)}`,
      { loc: captureLoc() },
    );
  }
  if (!Array.isArray(abi)) {
    throw new EvsTypeError('ABI_SHAPE', `t.fromOutputs("${name}"): abi must be an ABI array`, {
      loc: captureLoc(),
    });
  }
  // `Array.isArray` narrows `abi` to `any[]`; re-widen to `unknown[]` so member access is guarded.
  const entries: readonly unknown[] = abi;
  const fns = entries.filter(
    (it): it is Record<string, unknown> =>
      isRecordObject(it) && it['type'] === 'function' && it['name'] === name,
  );
  if (fns.length === 0) {
    throw new EvsTypeError(
      'ABI_SHAPE',
      `t.fromOutputs("${name}"): the provided ABI has no function named "${name}"`,
      { loc: captureLoc() },
    );
  }
  const derived = fns.map((fn): EvsType => {
    const outputs = fn.outputs;
    if (!Array.isArray(outputs) || outputs.length === 0) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `t.fromOutputs("${name}"): function "${name}" has no outputs to derive a type from`,
        { loc: captureLoc() },
      );
    }
    const components = componentsFromAbi(outputs, `t.fromOutputs("${name}")`);
    const single = components[0];
    if (components.length === 1 && single !== undefined) return abiParamToType(single);
    return Object.freeze({ type: 'tuple', components });
  });
  const first = derived[0];
  if (first === undefined) throw new EvsInternalError('INTERNAL', 't.fromOutputs: no derivation');
  if (!derived.every((d) => typesEqual(d, first))) {
    const sigs = fns
      .map((fn) => {
        const inputs = Array.isArray(fn.inputs) ? (fn.inputs as readonly unknown[]) : [];
        const types = inputs
          .map((p) => (isRecordObject(p) && typeof p['type'] === 'string' ? p['type'] : '?'))
          .join(',');
        return `${name}(${types})`;
      })
      .join(', ');
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      `t.fromOutputs("${name}"): function "${name}" is overloaded with differing outputs (${sigs}) and there are no call args to pick an overload by — prune the ABI to the intended entry first, e.g. abi.filter((f) => f.type === 'function' && f.name === "${name}" && f.inputs.length === N)`,
      { loc: captureLoc() },
    );
  }
  return first;
}

// ---------------------------------------------------------------------------
// `t.error` runtime (issue #15)
// ---------------------------------------------------------------------------

/** Names whose selectors/semantics belong to Solidity or the evs runtime — a user error may
 *  not shadow them (they get dedicated decode arms and would break the client-side switch).
 *  '_' is the matchScriptError default-arm key. */
const RESERVED_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Panic',
  'Error',
  'EvsDecodeError',
  'EvsInvalidCalldata',
  '_',
]);

/** A {@link namedArg}-produced {@link ArgSpec} value (a bare type is a string; a bare composite
 *  type is a {@link TupleType}, which has no `name`). Mirror of the builder's declarator check. */
function isArgSpecValue(v: unknown): v is { readonly name: string; readonly type: unknown } {
  return isRecordObject(v) && typeof (v as { name?: unknown }).name === 'string' && 'type' in v;
}

function errorTypeRT(name: unknown, paramsIn: unknown): EvsErrorType {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new EvsTypeError(
      'ERROR_DECL',
      `t.error(): error name must be a non-empty identifier, got ${describeTypeInput(name)}`,
      { loc: captureLoc() },
    );
  }
  if (RESERVED_ERROR_NAMES.has(name)) {
    throw new EvsTypeError(
      'ERROR_DECL',
      `t.error("${name}"): the name is reserved (Panic/Error are Solidity built-ins; EvsDecodeError/EvsInvalidCalldata belong to the evs runtime) — pick another name`,
      { loc: captureLoc() },
    );
  }
  let decls: readonly unknown[];
  if (paramsIn === undefined) {
    decls = [];
  } else if (Array.isArray(paramsIn)) {
    decls = paramsIn;
  } else {
    decls = [paramsIn];
  }
  const params = decls.map((d, i): { name: string; type: EvsType } => {
    const ctx = `t.error("${name}") param #${i}`;
    if (isArgSpecValue(d)) {
      if (d.name !== '' && !IDENT_RE.test(d.name)) {
        throw new EvsTypeError(
          'ERROR_DECL',
          `${ctx}: invalid param name ${JSON.stringify(d.name)} (must be a non-empty identifier)`,
          { loc: captureLoc() },
        );
      }
      const ty: unknown = d.type;
      if (typeof ty === 'string') {
        assertEvsType(ty, `${ctx} ("${d.name}")`);
        return { name: d.name, type: ty };
      }
      if (!isEvsValueType(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${ctx} ("${d.name}"): expected a type (use the \`t\` namespace), got ${describeTypeInput(ty)}`,
          { loc: captureLoc() },
        );
      }
      return { name: d.name, type: ty };
    }
    if (typeof d === 'string') {
      assertEvsType(d, ctx);
      return { name: '', type: d };
    }
    if (isTupleType(d) && isEvsValueType(d)) return { name: '', type: d };
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${ctx}: expected a type or namedArg(...), got ${describeTypeInput(d)}`,
      { loc: captureLoc() },
    );
  });
  // resolved (arg{i}-fallback) input names must be unique — the decode utilities key args by name
  const seen = new Set<string>();
  const inputs = params.map((p, i) => {
    const resolved = p.name === '' ? `arg${i}` : p.name;
    if (seen.has(resolved)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `t.error("${name}"): duplicate param name "${resolved}"`,
        { loc: captureLoc() },
      );
    }
    seen.add(resolved);
    return typeToAbiParam(resolved, p.type);
  });
  const abi = Object.freeze({
    type: 'error',
    name,
    inputs: Object.freeze(inputs),
  });
  const specs = Object.freeze(params.map((p) => Object.freeze(p)));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the literal type is the overload's authority; the runtime shape is built to match
  return Object.freeze({ kind: 'error', name, params: specs, abi }) as unknown as EvsErrorType;
}

/**
 * `t.fromAbiParameter(param)` runtime: validate + canonicalize one ABI parameter and return its
 * {@link EvsType} (a {@link TupleType} for a `tuple…` param, else the scalar/array string).
 */
function fromAbiParameterRT(param: unknown): EvsType {
  const components = componentsFromAbi([param], 't.fromAbiParameter()');
  const single = components[0];
  if (single === undefined) {
    throw new EvsTypeError('ABI_SHAPE', `t.fromAbiParameter(): missing parameter`, {
      loc: captureLoc(),
    });
  }
  return abiParamToType(single);
}

// ---------------------------------------------------------------------------
// internal helpers (module-private to evs; not part of the public surface)
// ---------------------------------------------------------------------------

/**
 * Why a type string is NOT a {@link StringType}, for the `TYPE_MISMATCH` message: a tuple written
 * as a string (tuples are descriptor objects), a malformed fixed-size suffix (`[0]`, `[01]`,
 * `[x]`, or ≥ 2^32), or an unknown leaf. Exported for the layout/builder mirrors so every entry
 * point explains a rejection the same way.
 */
export function explainBadTypeString(s: string): string {
  if (s === 'tuple' || s.startsWith('tuple')) {
    return `a tuple type must be a \`t.struct\`/\`t.tuple\` descriptor (or a raw AbiParameter[]), not the string ${JSON.stringify(s)}`;
  }
  // walk the suffix chain inward: the first suffix that does not parse is the malformed one
  let cur = s;
  while (/\[[^\]]*\]$/.test(cur)) {
    const peeled = peelArraySuffix(cur);
    if (peeled === null) {
      return `malformed array suffix in ${JSON.stringify(s)} — a fixed-size array length must be a positive integer below 2^32 with no leading zero (\`T[3]\`), or empty for a dynamic array (\`T[]\`)`;
    }
    cur = peeled.inner;
  }
  return `unknown type ${JSON.stringify(s)} (expected uintN/intN/address/bool/bytesN, string, bytes, an array \`T[]\`/\`T[N]\` of those, or a \`t.struct\`/\`t.tuple\`)`;
}

/** Eager type-string validation: throws `EvsTypeError(TYPE_MISMATCH)` with the caller's loc. */
function assertEvsType(s: string, context: string): asserts s is StringType {
  if (isStringType(s)) return;
  throw new EvsTypeError('TYPE_MISMATCH', `${context}: ${explainBadTypeString(s)}`, {
    loc: captureLoc(),
  });
}

/**
 * @internal Staging-misuse traps shared by every handle implementation.
 *
 * Installs throwing `valueOf` / `toString` / `toJSON` / `Symbol.toPrimitive` on `target`
 * (each throws `EvsStagingError` citing both the misuse site and where the handle was
 * recorded), plus a NON-throwing `nodejs.util.inspect.custom` returning `describe()` —
 * printing is debugging, not misuse. The builder layers `Expr` methods on top.
 */
export function installStagingTraps(
  target: object,
  info: { describe(): string; recordedAt(): SourceLoc | null },
): void {
  const explode = (operation: string): never => {
    throw new EvsStagingError(
      'STAGING_MISUSE',
      `${operation} on a staged handle (${info.describe()}): evs handles are recorded program values, not host values — use the builder ops (s.add, .eq, s.if, …) instead`,
      {
        loc: captureLoc(),
        relatedLocs: [{ label: 'handle recorded at', loc: info.recordedAt() }],
      },
    );
  };
  const traps: PropertyDescriptorMap = {
    valueOf: { value: () => explode('valueOf()'), enumerable: false },
    toString: { value: () => explode('toString()'), enumerable: false },
    toJSON: { value: () => explode('toJSON() / JSON.stringify'), enumerable: false },
    [Symbol.toPrimitive]: {
      value: () => explode('primitive coercion (Symbol.toPrimitive)'),
      enumerable: false,
    },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      value: () => info.describe(),
      enumerable: false,
    },
  };
  Object.defineProperties(target, traps);
}
