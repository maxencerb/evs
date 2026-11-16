/**
 * `core/types/derive.ts` — type-level derivations: evs types ↔ ABI components
 * (`TypeToComponent`, `StructTypeOf`, `TupleTypeOf`, `TupleArrayOf`, `AbiParamToEvsType`, …) and
 * `FromAbiOutputs`.
 */

import type { AbiParameter, Abi } from 'viem';

import type { SignatureName, AbiFunctionSignature } from '../signature.js';
import type { EvsType, TupleType } from './vocabulary.js';

// -- the members of a record, at the type level --------------------------------------------------
// A record type has no key order. Recovering one goes through a union, and the order of a union
// belongs to the type checker: TypeScript 5 and 6 keep the order in which the program first
// mentioned each member, TypeScript 7 and its ports (`bun check`, tsrs) sort. So a FULLY NAMED
// tuple type carries no member order: its `components` is a list of the member union, of a known
// length ({@link NamedComponents}). `t.struct`, an ABI tuple and `t.fromOutputs` then give one and
// the same type for the same members, under every checker. The encoding order lives in the
// runtime descriptor (`Object.keys()` insertion order for `t.struct`, the ABI's order otherwise),
// and recording compares it (`typesEqual`). A tuple with an unnamed member (`t.tuple(...)`, a
// positional ABI tuple) keeps its components in order: its declarators are an ordered list.
type UnionToIntersection<u> = (u extends unknown ? (k: u) => void : never) extends (
  k: infer i,
) => void
  ? i
  : never;
type LastOf<u> =
  UnionToIntersection<u extends unknown ? () => u : never> extends () => infer r ? r : never;
/** A union → a tuple of its members, in an order that depends on the type checker (see above):
 *  read its `length`, never its positions. The accumulator keeps the recursion in tail position,
 *  so TypeScript evaluates it as a loop: a 300-member union fits, where the
 *  `[...UnionToTuple<rest>, last]` spelling exceeds the instantiation depth past ~45. */
export type UnionToTuple<u, acc extends readonly unknown[] = []> = [u] extends [never]
  ? acc
  : UnionToTuple<Exclude<u, LastOf<u>>, [LastOf<u>, ...acc]>;

/** How many members a union has. */
type CountOf<u> =
  UnionToTuple<u> extends infer members extends readonly unknown[] ? members['length'] : never;

/**
 * The `components` of a fully named tuple type: `count` members, each one of `member`, in no
 * order. The length makes the type exact. `Expr` is covariant in its type, so without it a struct
 * lacking a member would be assignable to the struct that has it; with it, two such lists are
 * assignable to each other only when their members are the same.
 */
export type NamedComponents<member, count extends number> = readonly member[] & {
  readonly length: count;
};

/** A single `t.*` type → an abitype component descriptor (a {@link NamedType}). */
export type TypeToComponent<name extends string, ty extends EvsType> = ty extends TupleType
  ? { readonly name: name; readonly type: ty['type']; readonly components: ty['components'] }
  : { readonly name: name; readonly type: ty };
/** One component per key of a struct record, as a union. */
type StructMember<spec extends Record<string, EvsType>> = {
  readonly [k in keyof spec & string]: TypeToComponent<k, spec[k]>;
}[keyof spec & string];
/** `t.struct({...})` → a fully named tuple type: its members, in no order (see above). A record
 *  with no literal keys (the constraint itself) has an unknown number of members. */
export type StructTypeOf<spec extends Record<string, EvsType>> = {
  readonly type: 'tuple';
  readonly components: string extends keyof spec
    ? readonly StructMember<spec>[]
    : NamedComponents<StructMember<spec>, CountOf<keyof spec>>;
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
// ABI parameters are an ordered `AbiParameter[]`. A fully named list still becomes the unordered
// {@link NamedComponents}, so that the type derived from an ABI and the `t.struct` written by hand
// are the same type; a list with an unnamed member keeps its order.

/**
 * abitype's (and viem's) tuple-literal rule over a component list: `true` when EVERY member is
 * named (the literal is a record keyed by member name), `false` as soon as one member is unnamed
 * (`''` or absent — the literal is a positional array). Written as abitype's
 * `AbiComponentsToPrimitiveType` writes it, so the literal shapes `TupleInit` and `FitsStruct`
 * accept agree with `TupleLitOf`. The runtime twin is `allMembersNamed`
 * (builder/expr/helpers.ts).
 */
export type AllMembersNamed<comps extends readonly { readonly name?: string | undefined }[]> =
  comps[number]['name'] extends Exclude<comps[number]['name'] & string, undefined | ''>
    ? true
    : false;

/** An abitype `AbiParameter`'s `name` (`''` when absent) — abitype params name is optional. */
type AbiParamName<p extends AbiParameter> = p extends { readonly name: infer n extends string }
  ? n
  : '';

/** One ABI `AbiParameter` → a canonical {@link NamedType} component (recursing into tuple
 *  components, preserving names). The mirror of the builder's `ComponentToType`
 *  (`builder/script/handles.ts`) in the ABI→type direction, normalizing the optional `name` to a
 *  string so the result is a valid `NamedType`. */
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

/** A list of ABI `AbiParameter`s → {@link NamedType} components: the unordered
 *  {@link NamedComponents} when every member is named (what `t.struct` gives for the same
 *  members), else the same list in the same order. */
export type AbiParamsToComponents<ps extends readonly AbiParameter[]> = ps extends readonly []
  ? readonly []
  : AllMembersNamed<ps> extends true
    ? NamedComponents<AbiParamToComponent<ps[number]>, ps['length']>
    : { readonly [i in keyof ps]: AbiParamToComponent<ps[i]> };

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

/** The `function` entry of `abi` that `name` selects: a bare name (a union if overloaded) or a
 *  canonical signature `'get(uint256)'` naming one overload (issue #4). */
type AbiFnNamed<abi, name extends string> = abi extends Abi
  ? name extends `${string}(${string}`
    ? MatchAbiSignature<
        Extract<abi[number], { readonly type: 'function'; readonly name: SignatureName<name> }>,
        name
      >
    : Extract<abi[number], { readonly type: 'function'; readonly name: name }>
  : never;

type MatchAbiSignature<f, ref extends string> = f extends unknown
  ? AbiFunctionSignature<f> extends ref
    ? f
    : never
  : never;

/**
 * `t.fromOutputs(abi, name)` → the {@link EvsType} of the function's outputs (`name` is a bare
 * function name or, for an overloaded function, its canonical signature): a SINGLE output →
 * that output's type (a {@link TupleType} for a tuple output, else the scalar/array string); MANY
 * outputs → a {@link TupleType} struct over the (named) outputs. A non-`const` ABI /
 * unknown name degrades to {@link EvsType} (never a hard error — mirrors `s.call` widening).
 */
export type FromAbiOutputs<abi, name extends string> = [AbiFnNamed<abi, name>] extends [never]
  ? EvsType
  : AbiFnNamed<abi, name> extends { readonly outputs: infer outs extends readonly AbiParameter[] }
    ? outs extends readonly [infer one extends AbiParameter]
      ? AbiParamToEvsType<one>
      : { readonly type: 'tuple'; readonly components: AbiParamsToComponents<outs> }
    : EvsType;
