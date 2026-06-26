/**
 * M1 `core/types.ts` — the type vocabulary, `Expr` brand, `namedArg()`/`t`, and runtime type
 * predicates/metadata (single source of truth for all modules).
 *
 * Contract: docs/design/module-interfaces.md §M1 (frozen) + api.md §2/§3.
 */

import { EvsStagingError, EvsTypeError, type SourceLoc } from './errors.js';
import { captureLoc } from './loc.js';

// re-exported per the module-interfaces conventions block ("`Address` is re-exported from
// `abitype`"); type-only — abitype is the only import core may take.
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
 * Arrays of scalar leaves, string-encoded and nestable to a bounded depth (real ABIs rarely
 * exceed two): `uint256[]`, `address[][]`, `string[]`, …
 */
export type ArrayType = `${ScalarType}[]` | `${ScalarType}[][]` | `${ScalarType}[][][]`;
/**
 * A tuple / struct type — an abitype `AbiParameter`-shaped descriptor (recursive, JSON-safe).
 * `type` carries any array suffix (`'tuple'`, `'tuple[]'`, `'tuple[][]'`) and `components`
 * describe the (element) tuple's members. Built via {@link t.struct} / {@link t.tuple}; a raw
 * `readonly AbiParameter[]` is also accepted wherever a tuple type is expected.
 */
export interface TupleType {
  readonly type: 'tuple' | 'tuple[]' | 'tuple[][]';
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

/**
 * One `[]` peeled off a string-array type via FORWARD inference: `uint256[][]` → `uint256[]`. The
 * check type is tuple-wrapped so it does NOT distribute — a concrete (or small-union) array type
 * infers its element, but a wide/non-array `t` (e.g. a loosely-typed `Expr<EvsType>`) collapses to
 * `never` instead of materializing the whole ~400-member union ("too complex to represent").
 *
 * Perf (amendments.md §18.1): {@link Expr.at} computes its element via this instead of reverse-
 * solving a generic `elem extends StringType` against `${elem}[]` — forward `infer` on the already-
 * concrete receiver type is ~free; reverse-matching a template against the union dominated check time.
 */
export type ArrayElemOf<t extends EvsType> = [t] extends [`${infer e extends StringType}[]`]
  ? e
  : never;
export type ArgType = EvsType;
export type NumericType = UintType | IntType;
export type BitsType = UintType | BytesNType;

// ---------------------------------------------------------------------------
// Expr — the branded staged-value handle (api.md §3, verbatim)
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
  eq(this: Expr<t & WordType>, rhs: IntoExpr<t>): Expr<'bool'>; // word types only (typed)
  neq(this: Expr<t & WordType>, rhs: IntoExpr<t>): Expr<'bool'>;

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
  // element via FORWARD inference on the receiver's own (concrete) `t` (see {@link ArrayElemOf}),
  // NOT a reverse-solved `elem extends StringType` against `${elem}[]` — same result type, but
  // amendments.md §18.1 cut `tsc` check time ~10× by not pattern-matching the ~400-member union.
  // `t & ArrayType` still pins the receiver to the depth-bounded array vocabulary.
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
              : t extends `${infer e extends StringType}[]`
                ? readonly LitOf<e>[]
                : never;

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
// namedArg() declarator + the `t` type namespace (api.md §2)
// ---------------------------------------------------------------------------

export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name;
  readonly type: type;
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

/**
 * Names a **top-level** arg/param so the name surfaces in the resulting type (issue #9): in a
 * script's `args`, the viem `args` tuple element is labeled (`[token: …]`); in an `s.fn`'s params,
 * the callback parameter is labeled (`(token) => …`). The `type` bound is {@link StringType} (word/
 * dynamic/string-array) — composite (`t.struct`/`t.tuple`) types are passed bare; nested composite
 * fields are named via `t.struct` and keep their behaviour. A bare (unnamed) top-level arg keeps the
 * positional `arg{i}` fallback name.
 */
export function namedArg<const name extends string, const type extends StringType>(
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
  assertEvsType(type, `argument "${name}"`);
  return Object.freeze({ name, type });
}

// -- type-level record→ordered-components machinery (abitype §4.2) -----------------------------
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
/** `t.array(tupleType)` → an array-of-tuple type (one `[]` deeper). */
export type TupleArrayOf<e extends TupleType> = {
  readonly type: `${e['type']}[]` & TupleType['type'];
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
  array<const e extends StringType>(elem: e): `${e}[]`;
  array<const e extends TupleType>(elem: e): TupleArrayOf<e>;
  struct<const spec extends Record<string, EvsType>>(spec: spec): StructTypeOf<spec>;
  tuple<const items extends readonly EvsType[]>(...items: items): TupleTypeOf<items>;
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
  array(elem: unknown): unknown {
    return arrayTypeRT(elem);
  },
  struct(spec: unknown): unknown {
    return structTypeRT(spec);
  },
  tuple(...items: unknown[]): unknown {
    return tupleTypeRT(items);
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

/** Recognizes a string-encoded type (word, dynamic, or a nested array of such). */
export function isStringType(s: string): s is StringType {
  if (isWordType(s) || s === 'string' || s === 'bytes') return true;
  return s.endsWith('[]') && isStringType(s.slice(0, -2));
}

/** A composite (tuple/struct) type descriptor — the only non-string {@link EvsType}. */
export function isTupleType(v: unknown): v is TupleType {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as { type?: unknown; components?: unknown };
  return (
    (o.type === 'tuple' || o.type === 'tuple[]' || o.type === 'tuple[][]') &&
    Array.isArray(o.components)
  );
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
    if (o.type.startsWith('tuple'))
      return Array.isArray(o.components) && componentsValid(o.components);
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

/** `intN` → true; every other v0 type (incl. `intN[]`, tuples) → false. */
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

/** Memref-valued (not a single stack word): string | bytes | T[] | tuple. */
export function isDynamicType(s: EvsType): boolean {
  if (typeof s !== 'string') return true; // tuples are always memref pointers
  return s === 'string' || s === 'bytes' || s.endsWith('[]');
}

/** A `T[]` array type (string array or tuple array). */
export function isArrayValueType(s: EvsType): s is ArrayType | TupleType {
  return typeof s === 'string' ? s.endsWith('[]') : s.type !== 'tuple';
}

/** The element type of an array type: one `[]` peeled off (string arrays) or the element
 *  tuple (tuple arrays). */
export function elemTypeOf(s: ArrayType | TupleType): EvsType {
  if (typeof s === 'string') {
    const elem: string = s.endsWith('[]') ? s.slice(0, -2) : '';
    if (isStringType(elem)) return elem;
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `elemTypeOf: ${JSON.stringify(s)} is not an array type`,
      { loc: captureLoc() },
    );
  }
  if (s.type === 'tuple') {
    throw new EvsTypeError('TYPE_MISMATCH', `elemTypeOf: a tuple is not an array type`, {
      loc: captureLoc(),
    });
  }
  const innerTag = s.type.slice(0, -2); // 'tuple[]' → 'tuple', 'tuple[][]' → 'tuple[]'
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- peeling one [] off a tuple-array tag yields a valid TupleType tag
  return Object.freeze({ type: innerTag as TupleType['type'], components: s.components });
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

function arrayTypeRT(elem: unknown): EvsType {
  if (typeof elem === 'string') {
    assertEvsType(elem, 't.array() element');
    arrayDepthGuard(`${elem}[]`);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- elem is a validated StringType, so `${elem}[]` is a valid ArrayType (depth-guarded)
    return `${elem}[]` as ArrayType;
  }
  if (isTupleType(elem)) {
    const tag = `${elem.type}[]`;
    if (tag !== 'tuple[]' && tag !== 'tuple[][]') {
      throw new EvsTypeError(
        'UNSUPPORTED_V0',
        `t.array(): tuple array nesting deeper than [][] is not supported`,
        {
          loc: captureLoc(),
        },
      );
    }
    return Object.freeze({
      type: tag,
      components: normalizeComponents(elem.components, 't.array()'),
    });
  }
  if (Array.isArray(elem)) {
    return Object.freeze({ type: 'tuple[]', components: componentsFromAbi(elem, 't.array()') });
  }
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `t.array(): element type ${describeTypeInput(elem)} is not a type (use the \`t\` namespace)`,
    { loc: captureLoc() },
  );
}

function arrayDepthGuard(s: string): void {
  // depth-3 ceiling matches the ArrayType template type; deeper string arrays are rejected so
  // the runtime and type-level vocabularies agree.
  if (/\[\]\[\]\[\]\[\]/.test(s)) {
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      `t.array(): array nesting deeper than [][][] is not supported`,
      {
        loc: captureLoc(),
      },
    );
  }
}

/** A non-null, non-array object — narrows `unknown` to a property-indexable record. */
function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `t.fromOutputs(abi, name)` runtime: locate the single function named `name` (overloads are a v0
 * deferral, mirroring `s.call`), validate + canonicalize its outputs through {@link componentsFromAbi},
 * and return a SINGLE output's {@link EvsType} directly or wrap MANY outputs in a `tuple`
 * {@link TupleType} (named, in ABI order). The result flows wherever a `t.struct`/`t.tuple` type
 * does and round-trips with a `s.read({…, struct: true})` decode of the same function.
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
  if (fns.length > 1) {
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      `t.fromOutputs("${name}"): function "${name}" is overloaded (${fns.length} entries) — overload disambiguation is deferred in v0; prune the ABI to the single intended entry`,
      { loc: captureLoc() },
    );
  }
  const outputs = fns[0]?.outputs;
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
// internal helpers (module-private to evs; not part of the frozen M1 surface)
// ---------------------------------------------------------------------------

/** Recognizably-Solidity types that are deliberately out of evs get the UNSUPPORTED_V0 code. */
function looksDeferred(s: string): boolean {
  if (/\[\d+\]$/.test(s)) return true; // fixed-size arrays T[N]
  if (s.endsWith('[]') && /\[\d+\]/.test(s.slice(0, -2))) return true; // arrays containing a fixed array
  return false;
}

/**
 * Eager type-string validation: throws `EvsTypeError` with the caller's loc, using
 * `UNSUPPORTED_V0` for valid-Solidity-but-deferred shapes and `TYPE_MISMATCH` otherwise.
 */
function assertEvsType(s: string, context: string): asserts s is StringType {
  if (isStringType(s)) return;
  if (looksDeferred(s)) {
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      `${context}: type ${JSON.stringify(s)} is not supported (fixed-size arrays \`T[N]\` are deferred — use a dynamic \`T[]\`)`,
      { loc: captureLoc() },
    );
  }
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `${context}: unknown type ${JSON.stringify(s)} (expected uintN/intN/address/bool/bytesN, string, bytes, a \`T[]\` array, or a \`t.struct\`/\`t.tuple\`)`,
    { loc: captureLoc() },
  );
}

/**
 * @internal Staging-misuse traps shared by every handle implementation (architecture.md §3).
 *
 * Installs throwing `valueOf` / `toString` / `toJSON` / `Symbol.toPrimitive` on `target`
 * (each throws `EvsStagingError` citing both the misuse site and where the handle was
 * recorded), plus a NON-throwing `nodejs.util.inspect.custom` returning `describe()` —
 * printing is debugging, not misuse. The builder (M5) layers `Expr` methods on top.
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
