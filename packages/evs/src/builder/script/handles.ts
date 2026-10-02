/**
 * `builder/script/handles.ts` — the staged handle types: `Cell`, `MutArray`, `LoopCtl`, `Tuple` /
 * `Field` (and the tuple-array `Expr` augmentation), the values a script may encode or return,
 * `ScriptReturn`, and the env kinds.
 */

import type {
  EvsType,
  IntoExpr,
  TupleType,
  StringType,
  NamedType,
  ArrayType,
  OuterArraySize,
  PeelArraySuffix,
} from '../../core/types.js';
import type { AllMembersNamed } from '../../core/types/derive.js';
import type { Expr } from '../../core/types/expr.js';
import type { ArgHandle } from './evscript.js';

// ---------------------------------------------------------------------------
// cells, mutable arrays, loop control
// ---------------------------------------------------------------------------

export interface Cell<t extends EvsType> {
  readonly type: t;
  get(): Expr<t>; // fresh snapshot at this program point
  set(value: IntoExpr<t>): void;
}

/** The array value type of a `MutArray<e, n>`: a string element → `${e}[]` (or `${e}[n]` for a
 *  fixed-size array); a tuple descriptor element (plain `tuple` or a tuple array) → the tuple-array
 *  {@link TupleType} with the SAME components and the suffix appended to its tag. Any element type
 *  nests (`MutArray<'uint256[]'>` → `uint256[][]`, `MutArray<tuple[]>` → `tuple[][]`). */
export type MutArrayValueOf<e extends EvsType, n extends number | null = null> = e extends TupleType
  ? {
      readonly type: `${e['type']}[${n extends number ? n : ''}]` & TupleType['type'];
      readonly components: e['components'];
    }
  : e extends StringType
    ? `${e}[${n extends number ? n : ''}]` extends infer a extends EvsType
      ? a // deferred `infer` — instantiated per concrete `e`, never solved against the wide union
      : never
    : never;

/** The element handle of a `MutArray<e>`: a plain `tuple` element → a {@link Tuple} handle; a
 *  tuple-array / scalar / string-array element → an {@link Expr} (the {@link ArgHandle} dispatch,
 *  matching the runtime `valueHandle`). */
export type MutArrayElem<e extends EvsType> = ArgHandle<e>;

/**
 * A mutable array (`s.newArray`) over element type `e` — a dynamic `e[]` (`n = null`) or, with
 * `{ fixed: true }`, a fixed-size `e[n]`. `e` is any value type: a word, `string`/`bytes`, an array
 * (dynamic or fixed, any depth), or a struct/tuple. `set` accepts the element's `IntoMember` (a
 * `Tuple` handle / literal for a tuple element, an array handle / literal for an array element, an
 * `IntoExpr` otherwise); `get` yields the element handle; `expr()` is the raw memref of the SAME
 * buffer.
 */
export interface MutArray<e extends EvsType, n extends number | null = null> {
  readonly elemType: e;
  readonly length: Expr<'uint256'>;
  set(i: IntoExpr<'uint256'>, v: IntoMember<e>): void; // bounds-checked → Panic 0x32
  get(i: IntoExpr<'uint256'>): MutArrayElem<e>; // bounds-checked → Panic 0x32
  expr(): Expr<MutArrayValueOf<e, n>>; // memref handle to the SAME buffer (reference semantics)
  // phantom brand (issue #5 ask #5): lets `s.return({ arr })` / an array slot accept the bare
  // handle (no `.expr()`). Type-only — the runtime `MutArrayImpl` carries no such property.
  readonly [mutArrayBrand]: MutArrayValueOf<e, n>;
}

export interface LoopCtl {
  break(): void;
  continue(): void;
}

// ---------------------------------------------------------------------------
// tuple / struct handles
// ---------------------------------------------------------------------------

/**
 * A {@link NamedType} component (an abitype `AbiParameter`) → its {@link EvsType}: a string for a
 * scalar/array member, a {@link TupleType} descriptor for a composite member (the type-level
 * mirror of core's `abiParamToType`). Keyed off the `tuple…` type tag — a non-tuple member's
 * `components` is structurally absent, so testing the tag avoids a distributive `components` check.
 */
export type ComponentToType<c extends NamedType> = c['type'] extends `tuple${string}`
  ? c['components'] extends readonly NamedType[]
    ? { readonly type: c['type'] & TupleType['type']; readonly components: c['components'] }
    : never
  : Extract<c['type'], EvsType>;

/**
 * The value a composite (plain `tuple`) member accepts on write/init: a precise {@link Tuple}
 * handle of that member type, ANY {@link Tuple} handle (issue #5 ask #3 — the erased
 * {@link tupleBrand} makes a call-decoded `Tuple<C_abi>` assignable into a `t.struct`-typed slot
 * whose `C` is `UnionToTuple`-ordered; the runtime `typesEqual` is the order-sensitive guard), or
 * a {@link StructLiteral} (whose members may themselves be staged).
 */
export type IntoTuple<t extends TupleType> = Tuple<t> | AnyTuple | StructLiteral<t>;

/**
 * A complete literal of the plain `tuple` type `t` whose members may be staged — the value the
 * recorder coerces wherever a struct is expected (a call arg, a struct member, an array element,
 * an `s.fn` param, …: `buildTupleNew` takes every member through the same coercion as a top-level
 * value). By abitype's rule ({@link AllMembersNamed}): a record keyed by member name when every
 * member is named, else a positional array. Every member is present (unlike {@link TupleInit},
 * whose omitted members zero-fill), as overload resolution requires (`FitsStruct` /
 * `Recorder.argFits`), and each accepts its type's {@link IntoMember}: a host literal, an
 * {@link Expr}, a {@link Tuple} / {@link MutArray} handle, or a nested staged literal. The host
 * literal (`LitOf`, abitype's primitive type) is one case of it.
 */
export type StructLiteral<t extends TupleType> =
  AllMembersNamed<t['components']> extends true
    ? { readonly [c in t['components'][number] as c['name']]: IntoMember<ComponentToType<c>> }
    : PositionalLiteral<t['components']>;

/** The complete positional literal of a tuple with an unnamed member (homomorphic over the
 *  components tuple: exactly one element per member). */
type PositionalLiteral<comps extends readonly NamedType[]> = {
  readonly [i in keyof comps]: IntoMember<ComponentToType<comps[i]>>;
};

/** A literal of the tuple-ARRAY type `t` whose elements may be staged: a JS array of the
 *  one-suffix-peeled element's {@link IntoMember} (a {@link StructLiteral} or {@link Tuple} handle
 *  for a `tuple[]`, a row literal or handle for a `tuple[][]`). A fixed outer `[N]` suffix takes
 *  exactly N elements (a readonly N-tuple, as abitype's host arm types it), so a wrong-length
 *  `tuple[N]` literal is a compile error, not only a recording-time `TYPE_MISMATCH`. */
export type TupleArrayLiteral<t extends TupleType> =
  OuterArraySize<t['type']> extends `${infer n extends number}`
    ? FixedLengthLiteral<IntoMember<PeelTupleArray<t>>, n>
    : readonly IntoMember<PeelTupleArray<t>>[];

/** A readonly tuple of exactly `n` `e`s (tail-recursive; abitype's `Tuple` builds its fixed-array
 *  host type the same way). */
type FixedLengthLiteral<
  e,
  n extends number,
  acc extends readonly e[] = readonly [],
> = acc['length'] extends n ? acc : FixedLengthLiteral<e, n, readonly [e, ...acc]>;

/** What an ARRAY-typed slot accepts: an {@link Expr}/literal of the array type, or a bare
 *  {@link MutArray} handle (issue #5 ask #5 — runtime `typesEqual` enforces the element match,
 *  mirroring the bare-{@link Tuple} loosening). */
export type IntoArray<t extends EvsType> = IntoExpr<t> | AnyMutArray;

/**
 * What `Field.set(v)` / a `s.tuple(...)` init slot / `MutArray.set` accepts for a member of type
 * `t`: a plain `tuple` member → {@link IntoTuple}; a `tuple[]`/`tuple[][]` member →
 * {@link IntoArray} or a {@link TupleArrayLiteral} with staged elements; a string-array member →
 * {@link IntoArray} (array Expr/literal/`MutArray`); a scalar member → {@link IntoExpr}.
 */
export type IntoMember<t extends EvsType> = t extends TupleType
  ? t['type'] extends 'tuple'
    ? IntoTuple<t>
    : IntoArray<t> | TupleArrayLiteral<t>
  : t extends ArrayType
    ? IntoArray<t>
    : IntoExpr<t>;

/**
 * A field handle over one tuple member (Cell-like). A composite (plain `tuple`) member's `.get()`
 * follows the pointer and yields a {@link Tuple} handle; a `tuple[]`/scalar member's `.get()`
 * yields an {@link Expr} — the {@link ArgHandle} dispatch, matching the runtime `fieldGet` →
 * `valueHandle` (fixed by the #12 post-review pass: a `tuple[]` member wrongly typed as a
 * named-field `Tuple`, so a field access on it compiled but died in a raw `TypeError` at record
 * time, while `s.forEach` over the member was wrongly a compile error).
 */
export interface Field<t extends EvsType> {
  readonly type: t;
  get(): ArgHandle<t>;
  set(value: IntoMember<t>): void;
}

/**
 * The struct field names that collide with a {@link Tuple} handle member: its methods (`at`,
 * `expr`), the staging traps (`valueOf`, `toString`, `toJSON`), the `Object.prototype` members
 * and `then`. The handle member wins: such a field has no named accessor (at runtime or in the
 * type) and is read through `.at(i)`. Mirrors the runtime `TUPLE_HANDLE_MEMBERS`.
 */
export type TupleHandleMember =
  | 'at'
  | 'expr'
  | 'then'
  | 'valueOf'
  | 'toString'
  | 'toLocaleString'
  | 'toJSON'
  | 'constructor'
  | 'hasOwnProperty'
  | 'isPrototypeOf'
  | 'propertyIsEnumerable'
  | '__proto__'
  | '__defineGetter__'
  | '__defineSetter__'
  | '__lookupGetter__'
  | '__lookupSetter__';

/**
 * A tuple / struct memref handle. For each NAMED component, a property keyed by the
 * component name yields a {@link Field} over that member — except a name in
 * {@link TupleHandleMember}, which stays the handle's own member and is read through `at(i)`;
 * `at(i)` is the positional accessor; and `expr()` is the raw memref {@link Expr} (for returning
 * the tuple or passing it as a call arg). Typed via abitype over `C['components']`. Reference
 * semantics: the handle is the pointer, so a later `field.set()` is visible through every alias.
 */
export type Tuple<C extends TupleType> = {
  readonly [
    c in C['components'][number] as c['name'] extends '' | TupleHandleMember ? never : c['name']
  ]: Field<ComponentToType<c>>;
} & {
  at(i: number): Field<ComponentToType<C['components'][number]>>;
  expr(): Expr<C>;
} & {
  // phantom brand: lets `s.return` / a return bound accept a `Tuple` DIRECTLY (no `.expr()`)
  // while staying distinguishable from an `Expr` even when a struct field is literally named
  // "type"/"expr". The brand is ERASED to `TupleType` (not `C`) so it is order-insensitive —
  // a `Tuple<A>` stays assignable to a `Tuple<B>` whenever their named members match (the
  // `s.read(...)` tuple-input boundary relies on this), and `TypeOfReturn` recovers the precise
  // `C` from `expr()` instead. Type-only — the runtime `TupleHandle` carries no such property.
  readonly [tupleBrand]: TupleType;
};

/** The element `tuple` descriptor of a `tuple[]` {@link TupleType} (same components, `type: 'tuple'`). */
export type TupleArrayElem<C extends TupleType> = {
  readonly type: 'tuple';
  readonly components: C['components'];
};

/** One suffix (`[]`/`[N]`) peeled off a tuple-ARRAY descriptor: `tuple[]` → its plain `tuple`
 *  element (= {@link TupleArrayElem}), `tuple[][]` → its `tuple[]` row, `tuple[2][]` → `tuple[2]`;
 *  a non-array `tuple` → `never`. The tag is parsed front to back by core's
 *  {@link PeelArraySuffix} (the same parser `ArrayElemOf` uses for string arrays). */
type PeelTupleArray<C extends TupleType> =
  PeelArraySuffix<C['type']> extends infer inner extends TupleType['type']
    ? { readonly type: inner; readonly components: C['components'] }
    : never;

/** A tuple-ARRAY descriptor tag: any `tuple` tag with at least one `[]`/`[N]` suffix. */
export type TupleArrayTag = `tuple[${string}`;

/**
 * The element handle `.at(i)` / `s.forEach` yield for a tuple-array {@link Expr} (issue #12
 * follow-up): the one-`[]`-peeled element descriptor run through the SAME {@link ArgHandle}
 * dispatch as the runtime `valueHandle` — a `tuple[]` element is a named-field {@link Tuple},
 * a `tuple[][]` element an {@link Expr} of the peeled `tuple[]` descriptor. The pre-fix typing
 * hand-rolled this dispatch and drifted (it handed a `tuple[][]` element out as a `Tuple`, so a
 * field access compiled but hit a raw `TypeError` at recording); deriving from {@link ArgHandle}
 * keeps the runtime parity in one place.
 */
export type TupleArrayElemHandle<C extends TupleType> = ArgHandle<PeelTupleArray<C>>;

// `.at(i)` on a tuple-ARRAY Expr yields the element handle (the runtime `atOp` returns a Tuple
// handle bound to the `index` out ValueId for a plain-tuple element, an Expr otherwise).
// The base `Expr.at` overload in `core/types/expr.ts` only matches string-element arrays; this
// augmentation adds the tuple-array case where `Tuple`/`Field`/`ComponentToType` are in scope.
// It targets the module that DECLARES `Expr` (not the `core/types.ts` barrel): an augmentation
// through a re-export does not merge into the emitted declarations.
// Overload resolution picks the `this`-matching signature, so a `string[]`/`uint256[][]` Expr
// keeps returning an `Expr` element. Sharpened by the issue-#12 follow-up: the receiver is
// pinned to ARRAY tags (a plain-`tuple` Expr is now a compile error, matching the record-time
// rejection) and the element comes from {@link TupleArrayElemHandle} (a `tuple[][]` element is
// an `Expr<tuple[]>`, matching the runtime — it was wrongly a named-field `Tuple` before).
// `.length()` gets the matching tuple-ARRAY overload (the base bound is `DynType | ArrayType`,
// which a `tuple[]` Expr is not; the runtime `lenOp` accepts `isLengthType`: string/bytes and
// every array, never a plain tuple).
declare module '../../core/types/expr.js' {
  interface Expr<t extends EvsType = EvsType> {
    at<C extends TupleType & { readonly type: TupleArrayTag }>(
      this: Expr<C>,
      i: IntoExpr<'uint256'>,
    ): TupleArrayElemHandle<C>;
    length(this: Expr<TupleType & { readonly type: TupleArrayTag }>): Expr<'uint256'>;
  }
}

/** @internal phantom brand keying {@link Tuple}; never present at runtime. */
export declare const tupleBrand: unique symbol;

/** A {@link Tuple} of unknown component shape — the erased brand carrier (return-bound widening). */
export type AnyTuple = { readonly [tupleBrand]: TupleType };

/** @internal phantom brand keying {@link MutArray}; never present at runtime. Symmetric with
 *  {@link tupleBrand} — lets a bare `MutArray` handle be accepted in a return / array slot (issue
 *  #5 ask #5) while staying distinguishable from an `Expr`/`Tuple`. Erased to {@link EvsType}; the
 *  precise array value type is recovered from `expr()` via {@link TypeOfReturn}. */
export declare const mutArrayBrand: unique symbol;

/** A {@link MutArray} of unknown element shape — the erased brand carrier (return/array-slot
 *  widening, issue #5 ask #5). */
export type AnyMutArray = { readonly [mutArrayBrand]: EvsType };

/**
 * What `s.encode(...)` / `s.keccak256(...)` accept per value (issue #17; keccak widened by #24):
 * any staged handle — an {@link Expr} of any evs type, a {@link Tuple}, or a {@link MutArray} (bare
 * handles contribute their memref, like `s.return`). Literals must be lifted with
 * `s.lit(type, value)` (an untyped literal is ambiguous).
 */
export type EncodeValue = Expr | AnyTuple | AnyMutArray;

/**
 * What `s.encodePacked(...)` accepts per value (issue #17): an {@link Expr} or a bare
 * {@link MutArray}. Packed mode carries Solidity's `abi.encodePacked` restrictions —
 * words, `string`/`bytes`, and word-element arrays only; structs, nested arrays, and
 * `string[]`/`bytes[]` are rejected at record time (matching solc's compile error).
 */
export type PackedValue = Expr | AnyMutArray;

/**
 * What `s.return(...)` accepts per component: an {@link Expr} (the scalar/array/raw-memref form),
 * a {@link Tuple} handle DIRECTLY (no `.expr()` needed), or a
 * {@link MutArray} handle DIRECTLY (no `.expr()` — issue #5 ask #5). `.expr()` stays valid on
 * both handles: it just yields the equivalent `Expr<C>`, which this union also covers.
 */
export type ReturnValue = Expr | AnyTuple | AnyMutArray;

/**
 * The {@link EvsType} a {@link ReturnValue} contributes: an `Expr`'s `t`, or — for a bare `Tuple` /
 * `MutArray` handle — the `C` recovered from its `expr()` signature (neither handle carries an
 * `exprBrand`, so they never match the `Expr` arm; the erased {@link tupleBrand}/{@link
 * mutArrayBrand} only mark the handle kind). The recovered `C` is exactly what `handle.expr()`
 * would have yielded (a `TupleType` for a `Tuple`, the array value type for a `MutArray`), so the
 * bare-handle and `.expr()` forms infer identically.
 */
export type TypeOfReturn<v> =
  v extends Expr<infer t> ? t : v extends { expr(): Expr<infer c extends EvsType> } ? c : never;

/**
 * The partial member init accepted by `s.tuple(type, init?)`, by abitype's rule
 * ({@link AllMembersNamed}): a struct whose members are ALL named takes a name-keyed object; a
 * tuple with any unnamed member (a `t.tuple`, or an ABI tuple only partly named) takes a
 * positional array. Every member is optional (omitted → zero) and accepts a literal, an
 * {@link Expr}, or a {@link Tuple} (per member type).
 */
export type TupleInit<C extends TupleType> =
  AllMembersNamed<C['components']> extends true
    ? { readonly [c in C['components'][number] as c['name']]?: IntoMember<ComponentToType<c>> }
    : PositionalInit<C['components']>;

/** The partial positional init for a tuple with an unnamed member (homomorphic over the
 *  components tuple, so a tuple literal — e.g. `[42n, addr]` — stays assignable). */
type PositionalInit<comps extends readonly NamedType[]> = {
  readonly [i in keyof comps]?: IntoMember<ComponentToType<comps[i]>>;
};

/**
 * Type-level guard for `s.return`: `unknown` (a no-op in the `ret & …` parameter) for any record
 * with at least one key; for `{}` a required, self-describing property, so `s.return({})` fails to
 * typecheck with a message naming the fix. An empty record ABI-encodes to 0x, which viem rejects as
 * "returned no data" (issue #66); the recorder rejects it at runtime too.
 */
export type NonEmptyReturn<ret> = [keyof ret] extends [never]
  ? {
      readonly 's.return() needs at least one value: an empty record ABI-encodes to 0x (return a flag, e.g. { ok: s.lit(t.bool, true) })': never;
    }
  : unknown;

export declare const returnBrand: unique symbol;
export interface ScriptReturn<ret extends Record<string, ReturnValue>> {
  readonly [returnBrand]: ret;
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

/**
 * The `s.env(kind)` argument. `address`/`caller` are frame-dependent (they differ between the
 * two `toViem()` modes); the rest are block context. `blocknumber` is the `NUMBER` opcode, so it
 * reports what the chain defines: on Arbitrum an approximate L1 block number, not the L2 block
 * (read `ArbSys(0x64).arbBlockNumber()` for that).
 */
export type EnvKind = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid';
export type EnvTypeOf<k extends EnvKind> = k extends 'address' | 'caller' ? 'address' : 'uint256';
