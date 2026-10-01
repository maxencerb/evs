/**
 * `builder/script/calls.ts` — the call-verb types: function-name and overload resolution
 * (`ResolveOverload`, in lockstep with the recorder's runtime rules), sub-call inputs / outputs,
 * and the six calling verbs as callable interfaces.
 */

import type { AbiStateMutability, Abi, AbiParameter, AbiParameterToPrimitiveType } from 'abitype';
import type { ContractFunctionName } from 'viem';

import type { AbiFunctionSignature, SignatureName } from '../../core/signature.js';
import type {
  EvsType,
  NamedType,
  LitOf,
  TupleType,
  AbiParamsToComponents,
  IntoExpr,
  OuterArraySize,
  PeelArraySuffix,
} from '../../core/types.js';
import type { AllMembersNamed } from '../../core/types/derive.js';
import type { Expr, exprBrand } from '../../core/types/expr.js';
import type { ArgHandle } from './evscript.js';
import type {
  AnyTuple,
  AnyMutArray,
  TupleArrayTag,
  Tuple,
  mutArrayBrand,
  tupleBrand,
} from './handles.js';

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

/**
 * The two mutability buckets the calling surface is split across (issue #1):
 * - {@link ViewMutability} (`'pure' | 'view'`) — `s.read` / `s.tryRead`, lowered to `STATICCALL`.
 *   The EVM forbids *any* state-touching subcall under `STATICCALL`, so the `read` name makes the
 *   restriction explicit and frees `call`.
 * - {@link WriteMutability} (`'nonpayable' | 'payable'`) — `s.call` / `s.tryCall` (a plain `CALL`
 *   frame: non-view targets that need a real frame but don't usefully persist state, e.g. Uniswap
 *   quoters) and `s.simulate` / `s.trySimulate` (a `CALL` dry-run whose state is rolled back).
 * The `functionName` autocomplete + the arg/output handle shapes are filtered by the bucket of the
 * verb you call, so a `nonpayable` function is a compile error under `s.read` and vice-versa.
 */
export type ViewMutability = 'pure' | 'view';
export type WriteMutability = 'nonpayable' | 'payable';

/** The `function` entries of `abi` in the mutability bucket `mut`. */
type FnsOf<abi, mut extends AbiStateMutability> = abi extends Abi
  ? Extract<abi[number], { readonly type: 'function'; readonly stateMutability: mut }>
  : never;

/**
 * What `functionName` accepts (issue #4): every function name in the bucket (viem's
 * `ContractFunctionName`, the autocomplete) OR a canonical signature (`'balanceOf(address)'`,
 * {@link AbiFunctionSignature}) naming one overload exactly. A widened (non-`const`) ABI accepts any
 * string.
 */
export type SubcallFunctionName<
  abi extends Abi | readonly unknown[],
  mut extends AbiStateMutability = ViewMutability,
> = ContractFunctionName<abi, mut> | AbiFunctionSignature<FnsOf<abi, mut>>;

/** Keeps the overloads of `f` whose canonical signature is `ref` (a signature reference). */
type MatchSignature<f, ref extends string> = f extends unknown
  ? AbiFunctionSignature<f> extends ref
    ? f
    : never
  : never;

/** The `function` entry (a union when overloaded) that `name` — a bare name or a canonical
 *  signature — selects in the `mut` bucket. */
type FnOf<abi, name extends string, mut extends AbiStateMutability> = abi extends Abi
  ? name extends `${string}(${string}`
    ? MatchSignature<
        Extract<
          abi[number],
          {
            readonly type: 'function';
            readonly name: SignatureName<name>;
            readonly stateMutability: mut;
          }
        >,
        name
      >
    : Extract<
        abi[number],
        { readonly type: 'function'; readonly name: name; readonly stateMutability: mut }
      >
  : never;

type IsUnion<u, all = u> = u extends unknown ? ([all] extends [u] ? false : true) : never;

/**
 * Overload resolution by argument types (issue #4 — the `ExtractAbiFunctionForArgs` approach viem
 * ships, as a distributive filter instead of viem's `UnionToTuple`). The type-level twin of
 * `Recorder.resolveOverload` (builder/expr/calls.ts), step for step: among the overloads `name`
 * selects, keep those of the args' arity; a single arity match is taken as is (the regular input
 * checks then report a mismatch, like the recorder's coercion); otherwise keep the overloads every
 * argument {@link FitsArg fits}. A single (non-overloaded) entry is returned as is. `args =
 * readonly unknown[]` (the default: no args known) keeps every overload.
 */
export type ResolveOverload<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
  args = readonly unknown[],
> =
  FnOf<abi, name, mut> extends infer fns
    ? true extends IsUnion<fns>
      ? readonly unknown[] extends args
        ? fns
        : // no `args` given (still the constraint union) → the zero-argument overload, like viem
          ResolveByArgs<fns, readonly [] extends args ? readonly [] : args>
      : fns
    : never;

/** Arity first; a lone arity match wins without looking at the args (the recorder's rule). */
type ResolveByArgs<fns, args> = args extends { readonly length: infer n }
  ? ByArity<fns, n> extends infer arity
    ? true extends IsUnion<arity>
      ? PickOverload<arity, args>
      : arity
    : never
  : never;

type ByArity<f, n> = f extends { readonly inputs: { readonly length: n } } ? f : never;

type PickOverload<f, args> = f extends {
  readonly inputs: infer inputs extends readonly AbiParameter[];
}
  ? [
      {
        [i in keyof inputs]: NoFit<
          FitsArg<args[i & keyof args], inputs[i]['type'], ComponentsOf<inputs[i]>>
        >;
      }[number],
    ] extends [never]
    ? f
    : never
  : never;

/** `'no'` for a definite misfit, `never` for a fit (`true`) or a maybe-fit (`boolean`, a union
 *  argument some member of which fits) — so `[results] extends [never]` reads "all fit". */
type NoFit<r> = true extends r ? never : 'no';

type ComponentsOf<p> = p extends { readonly components: infer c extends readonly AbiParameter[] }
  ? c
  : readonly [];

/**
 * Whether the argument `v` can stand for a value of the ABI type `ty` (+ `comps` for a tuple tag)
 * — the type-level twin of `Recorder.argFits` (builder/expr/calls.ts); the two must stay in
 * lockstep (see CONTRIBUTING.md). A handle (`Expr`, `MutArray`, `Tuple`) fits iff it carries
 * exactly that type ({@link SameType}); a literal fits by JS kind: an array type ← an array whose
 * elements all fit (a fixed `T[N]` ← exactly N of them), a `tuple` ← a record keyed by member
 * name (a positional array when any member is unnamed) whose members all fit, bool ← boolean,
 * (u)intN ← number | bigint, address/bytesN/bytes ← a `0x` string, string ← any string. Value
 * ranges and byte lengths are NOT considered (`5n` fits every `uintN`).
 */
type FitsArg<v, ty extends string, comps> = 0 extends 1 & v
  ? true // `any`
  : v extends { readonly [exprBrand]: infer x }
    ? SameType<x, ty, comps>
    : v extends { readonly [mutArrayBrand]: infer x }
      ? SameType<x, ty, comps>
      : v extends { readonly [tupleBrand]: unknown; expr(): Expr<infer x> }
        ? SameType<x, ty, comps>
        : ty extends 'tuple'
          ? FitsStruct<v, comps>
          : ty extends `${string}]`
            ? FitsArray<v, ty, comps>
            : FitsScalar<v, ty>;

type FitsScalar<v, ty extends string> = ty extends 'bool'
  ? v extends boolean
    ? true
    : false
  : ty extends 'string'
    ? v extends string
      ? true
      : false
    : ty extends 'address' | `bytes${string}`
      ? v extends `0x${string}`
        ? true
        : false
      : ty extends `int${string}` | `uint${string}`
        ? v extends number | bigint
          ? true
          : false
        : false;

/** An array literal: every element fits the one-suffix-peeled element type, and a fixed `[N]`
 *  outer suffix needs exactly N elements (an array of statically unknown length may fit). */
type FitsArray<v, ty extends string, comps> = v extends readonly unknown[]
  ? OuterArraySize<ty> extends infer size
    ? size extends ''
      ? AllElemsFit<v, PeelArraySuffix<ty>, comps>
      : number extends v['length']
        ? AllElemsFit<v, PeelArraySuffix<ty>, comps>
        : `${v['length']}` extends size
          ? AllElemsFit<v, PeelArraySuffix<ty>, comps>
          : false
    : false
  : false;

type AllElemsFit<v extends readonly unknown[], elem extends string, comps> = [
  { [k in keyof v]: NoFit<FitsArg<v[k], elem, comps>> }[number],
] extends [never]
  ? true
  : false;

/** A tuple literal, by abitype's rule ({@link AllMembersNamed}): a (non-array) record keyed by
 *  member name when every member is named, else a positional array (a single unnamed member
 *  makes the whole tuple positional); every member present and fitting. Extra keys / elements are
 *  not considered here — the coercion of the resolved overload rejects them. */
type FitsStruct<v, comps> = comps extends readonly AbiParameter[]
  ? v extends object
    ? AllMembersNamed<comps> extends true
      ? v extends readonly unknown[]
        ? false
        : [
              { [i in keyof comps]: NoFit<MemberFits<v, NameOf<comps[i]>, comps[i]>> }[number],
            ] extends [never]
          ? true
          : false
      : v extends readonly unknown[]
        ? [{ [i in keyof comps]: NoFit<MemberFits<v, i, comps[i]>> }[number]] extends [never]
          ? true
          : false
        : false
    : false
  : false;

type NameOf<c> = c extends { readonly name: infer n extends string } ? n : '';

/** The member `key` of the literal `v` is present and fits the component `c`. */
type MemberFits<v, key, c> = key extends keyof v
  ? c extends AbiParameter
    ? FitsArg<v[key], c['type'], ComponentsOf<c>>
    : false
  : false;

/**
 * Whether a handle's type `x` (a type string or a tuple descriptor) is exactly the ABI type
 * (`ty`, `comps`) — the runtime `typesEqual`. Non-distributive: a loosely typed `Expr<EvsType>`
 * fits nothing. One deliberate difference: NAMED tuple components are compared by name, not by
 * position — a `t.struct`'s component order is not recoverable at the type level (see
 * `StructTypeOf`), so a same-members struct in another order fits here and the recorder, which
 * compares positions, then rejects it loudly (never a silently different overload).
 */
type SameType<x, ty extends string, comps> = [x] extends [string]
  ? Exact<x, ty>
  : [x] extends [{ readonly type: infer xt; readonly components: infer xc }]
    ? Exact<xt, ty> extends true
      ? SameComps<xc, comps>
      : false
    : false;

type Exact<a, b> = [a] extends [b] ? ([b] extends [a] ? true : false) : false;

// Fully-named components are compared as a SET through `xc[number]`: a `t.struct` descriptor's
// `components` is a mapped object over its `UnionToTuple` keys, not a real tuple (no usable
// `length`). Components with any unnamed member (`t.tuple`, an ABI-derived type — both real
// tuples) are compared index by index.
type SameComps<xc, pc> = pc extends readonly AbiParameter[]
  ? AllMembersNamed<pc> extends false
    ? xc extends readonly unknown[]
      ? Exact<xc['length'], pc['length']> extends true
        ? [
            {
              [i in keyof pc]: NoFit<i extends keyof xc ? SameComp<xc[i], pc[i]> : false>;
            }[number],
          ] extends [never]
          ? true
          : false
        : false
      : false
    : xc extends { readonly [i: number]: infer xm }
      ? [Exclude<NameOf<xm>, NameOf<pc[number]>>] extends [never] // no extra member
        ? [
            {
              [i in keyof pc]: NoFit<
                SameComp<Extract<xm, { readonly name: NameOf<pc[i]> }>, pc[i]>
              >;
            }[number],
          ] extends [never]
          ? true
          : false
        : false
      : false
  : false;

type SameComp<xm, pm> = [xm] extends [never]
  ? false // no member of that name
  : [xm] extends [{ readonly type: infer xt extends string }]
    ? pm extends { readonly type: infer pt extends string }
      ? Exact<xt, pt> extends true
        ? Exact<NameOf<xm>, NameOf<pm>> extends true
          ? pt extends `tuple${string}`
            ? SameComps<
                xm extends { readonly components: infer c } ? c : readonly [],
                ComponentsOf<pm>
              >
            : true
          : false
        : false
      : false
    : false;

/** @internal compile-time mirror of the recorder's overload errors: `args` fitting several
 *  overloads turns into a missing-property error naming the fix (the recorder's `ABI_SHAPE`
 *  ambiguity); `args` fitting none of several same-arity overloads, likewise (its
 *  `TYPE_MISMATCH`). */
type OverloadGuard<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability,
  args,
> =
  ResolveOverload<abi, name, mut, args> extends infer picked
    ? true extends IsUnion<picked>
      ? {
          readonly 'evs: ambiguous overload': 'these args fit several overloads — pass typed values (s.lit(t.uint8, 1)) or name one by signature (functionName: "get(uint8)")';
        }
      : [picked] extends [never]
        ? true extends IsUnion<FnOf<abi, name, mut>>
          ? {
              readonly 'evs: no overload matches': 'these args fit none of the overloads of this arity — a handle must carry the parameter type exactly (s.lit(t.uint8, 1)), a T[N] literal needs exactly N elements; or name one by signature (functionName: "get(uint8)")';
            }
          : unknown
        : unknown
    : unknown;

/** An abitype `AbiParameter` for a `'tuple'` member → the matching {@link TupleType} descriptor. */
type ParamToTupleType<p extends AbiParameter> = p extends {
  readonly type: 'tuple';
  readonly components: infer comps extends readonly NamedType[];
}
  ? { readonly type: 'tuple'; readonly components: comps }
  : never;

/** An abitype `AbiParameter` for a tuple-ARRAY member (`'tuple[]'`, `'tuple[2]'`, `'tuple[][]'`,
 *  …) → the matching tuple-array {@link TupleType} descriptor (an array value type whose `.type`
 *  is the param's tag). */
type ParamToTupleArrayType<p extends AbiParameter> = p extends {
  readonly type: infer tag extends TupleArrayTag;
  readonly components: infer comps extends readonly NamedType[];
}
  ? { readonly type: tag; readonly components: comps }
  : never;

// the staged handle of one OUTPUT parameter: a `tuple` param → a `Tuple` handle
// (decoded into a flat block); a tuple-array param (`tuple[]`, `tuple[2]`, `tuple[][]`, …) → an
// `Expr` of the tuple-array descriptor (so a returned array is abitype-typed as `readonly Struct[]`
// and `.at(i)` is a typed Tuple element / row); a nested word array (`uint256[][]`) / `string[]`
// / fixed `uint256[2]` → an `Expr` of its string type (abitype infers `readonly (readonly
// bigint[])[]` / `readonly string[]` / `readonly [bigint, bigint]`); every other scalar → an `Expr`.
type OutputHandle<p extends AbiParameter> = p['type'] extends 'tuple'
  ? Tuple<ParamToTupleType<p>>
  : p['type'] extends TupleArrayTag
    ? Expr<ParamToTupleArrayType<p>>
    : Expr<p['type'] extends EvsType ? p['type'] : EvsType>;

// what one INPUT parameter accepts: the abitype Register-resolved primitive (a literal object for
// a struct, a positional array for an unnamed tuple, a `readonly Struct[]` for a `tuple[]`) OR an
// `Expr`/handle of that type. For a `tuple` param: a `Tuple` handle / `s.tuple(...)` result. For a
// tuple-array param: an `Expr` of the tuple-array descriptor (a decoded/constructed array handle)
// or the `readonly Struct[]` literal. `uint256[][]`/`string[]`/`uint256[2]` are `EvsType` strings →
// `Expr<that>` (or the literal; a fixed-size literal is a tuple of exactly N).
type InputValue<p extends AbiParameter> = p['type'] extends 'tuple'
  ?
      | AbiParameterToPrimitiveType<p, 'inputs'>
      | Tuple<ParamToTupleType<p>>
      | AnyTuple // issue #5 ask #3: a cross-order call-decoded Tuple is accepted (runtime-checked)
      | Expr<ParamToTupleType<p>>
  : p['type'] extends TupleArrayTag
    ? AbiParameterToPrimitiveType<p, 'inputs'> | Expr<ParamToTupleArrayType<p>> | AnyMutArray // issue #5 ask #5: a bare MutArray<tuple> is accepted (runtime-checked)
    : p['type'] extends `${string}[${string}`
      ?
          | AbiParameterToPrimitiveType<p, 'inputs'>
          | LitOf<Extract<p['type'], EvsType>> // an array literal whose elements may be staged Exprs
          | Expr<p['type'] extends EvsType ? p['type'] : never>
          | AnyMutArray // a bare MutArray of the array type is accepted (runtime-checked)
      :
          | AbiParameterToPrimitiveType<p, 'inputs'>
          | Expr<p['type'] extends EvsType ? p['type'] : never>;

/** The overload(s)' input tuple(s) → what `args` accepts: one tuple per overload (a union when the
 *  name is overloaded — the concrete args then select the overload, {@link ResolveOverload}). */
type InputsOf<f> = f extends { readonly inputs: infer inputs extends readonly AbiParameter[] }
  ? { readonly [i in keyof inputs]: InputValue<inputs[i]> }
  : never;

/** The overload(s)' outputs → the positional handle tuple(s). */
type OutputsOf<f> = f extends { readonly outputs: infer outs extends readonly AbiParameter[] }
  ? { readonly [i in keyof outs]: OutputHandle<outs[i]> }
  : never;

export type SubcallInputs<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
> = [FnOf<abi, name, mut>] extends [never] ? readonly unknown[] : InputsOf<FnOf<abi, name, mut>>;

/** The positional output handles of the function `name` selects; for an overloaded name, of the
 *  overload `args` resolves to ({@link ResolveOverload}). */
export type SubcallOutputs<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
  args = readonly unknown[],
> = [ResolveOverload<abi, name, mut, args>] extends [never]
  ? readonly (Expr | Tuple<TupleType>)[]
  : OutputsOf<ResolveOverload<abi, name, mut, args>>;

// outputs []  → void;  [one] → Expr<one> | Tuple<one>;  [many] → readonly tuple of handles (viem)
export type UnwrapSingle<outs> = outs extends readonly []
  ? void
  : outs extends readonly [infer one]
    ? one
    : outs;

/**
 * `s.read({ …, struct: true })` (issue #5 ask #2) → ONE named {@link Tuple} handle built over ALL
 * of the function's (named, ABI-ordered) outputs — the opt-in alternative to the default positional
 * `[many]` shape (which stays the default, mirroring viem's `readContract`). Requires every output
 * to carry a name at record time. The struct type is in ABI declaration order, so it unifies with
 * `t.fromOutputs(abi, name)` and a `t.struct` declared in the same order (issue #5 asks #3/#4).
 */
type StructOf<f> = f extends { readonly outputs: infer outs extends readonly AbiParameter[] }
  ? Tuple<{ readonly type: 'tuple'; readonly components: AbiParamsToComponents<outs> }>
  : never;

export type SubcallStruct<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
  args = readonly unknown[],
> = [ResolveOverload<abi, name, mut, args>] extends [never]
  ? Tuple<TupleType>
  : StructOf<ResolveOverload<abi, name, mut, args>>;

export interface SubcallParams<
  abi extends Abi | readonly unknown[],
  name extends SubcallFunctionName<abi, mut>,
  mut extends AbiStateMutability = ViewMutability,
  args = SubcallInputs<abi, name, mut>,
> {
  readonly address: IntoExpr<'address'>;
  readonly abi: abi;
  // a bare name (overloads resolved by `args`) or a canonical signature `'get(uint256)'` (issue #4)
  readonly functionName: name | SubcallFunctionName<abi, mut>; // autocomplete union
  readonly args?: args;
  readonly gas?: IntoExpr<'uint256'>; // optional cap; default forward-all
  // opt-in (issue #5 ask #2): decode multiple named outputs into ONE named Tuple handle instead of
  // the default positional `[many]` array. See {@link SubcallStruct}.
  readonly struct?: boolean;
}

// ---------------------------------------------------------------------------
// the six calling verbs (issue #1) as callable interfaces — one set of three struct-aware
// overloads per (mutability bucket × strict/try). `read`/`tryRead` filter to ViewMutability
// (STATICCALL); `call`/`tryCall`/`simulate`/`trySimulate` filter to WriteMutability (CALL).
// ---------------------------------------------------------------------------

/**
 * The per-call params with `args` inferred (`const`) so an overloaded name resolves to one overload
 * ({@link ResolveOverload}); args fitting several overloads fail to compile ({@link OverloadGuard}),
 * mirroring the recorder's ambiguous-overload error.
 */
export type ResolvedSubcallParams<
  abi extends Abi | readonly unknown[],
  name extends SubcallFunctionName<abi, mut>,
  mut extends AbiStateMutability,
  args,
> = SubcallParams<abi, name, mut, args & OverloadGuard<abi, name, mut, args>>;

/** The strict result shape, parameterized over the mutability bucket. */
export interface SubcallVerb<mut extends AbiStateMutability> {
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args> & { readonly struct: true },
  ): SubcallStruct<abi, name, mut, args>;
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args> & { readonly struct?: false },
  ): UnwrapSingle<SubcallOutputs<abi, name, mut, args>>;
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args>,
  ): SubcallStruct<abi, name, mut, args> | UnwrapSingle<SubcallOutputs<abi, name, mut, args>>;
}

/** The try result shape (`{ success, value }`), parameterized over the mutability bucket. */
export interface TrySubcallVerb<mut extends AbiStateMutability> {
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args> & { readonly struct: true },
  ): { readonly success: Expr<'bool'>; readonly value: SubcallStruct<abi, name, mut, args> };
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args> & { readonly struct?: false },
  ): {
    readonly success: Expr<'bool'>;
    readonly value: UnwrapSingle<SubcallOutputs<abi, name, mut, args>>;
  };
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args>,
  ): {
    readonly success: Expr<'bool'>;
    readonly value:
      | SubcallStruct<abi, name, mut, args>
      | UnwrapSingle<SubcallOutputs<abi, name, mut, args>>;
  };
}

/** `s.read` — STATICCALL of a `view`/`pure` function. */
export type ReadVerb = SubcallVerb<ViewMutability>;
/** `s.tryRead` — STATICCALL, never reverts the script (`{ success, value }`). */
export type TryReadVerb = TrySubcallVerb<ViewMutability>;
/** `s.simulate` (and the base of `s.call`) — a `CALL` frame for a `nonpayable`/`payable` function. */
export type WriteVerb = SubcallVerb<WriteMutability>;
/** `s.trySimulate` (and the base of `s.tryCall`) — a `CALL` frame, never reverts the script. */
export type TryWriteVerb = TrySubcallVerb<WriteMutability>;

// ---------------------------------------------------------------------------
// revert-data-as-result (issue #35): `s.call` / `s.tryCall` `revertReturns` opt-in
// ---------------------------------------------------------------------------

/**
 * `s.call({ …, revertReturns: [t.uint256] })` (issue #35) — the QuoterV1 pattern: the target
 * REVERTS with its ABI-encoded result. `revertReturns` declares the output types carried by the
 * revert payload and REPLACES the ABI outputs as the decode schema (the ABI's own `outputs`, if
 * any, are ignored). The branches swap: a revert is the value path; a normal return is the
 * failure (`s.call` reverts `EvsDecodeError(site)`, `s.tryCall` reports `success = false` with
 * zeroed values). Not combinable with `struct: true` — declare one `t.struct` type instead.
 */
export interface RevertReturnsParams<
  abi extends Abi | readonly unknown[],
  name extends SubcallFunctionName<abi, WriteMutability>,
  rr extends readonly EvsType[],
> extends SubcallParams<abi, name, WriteMutability> {
  readonly revertReturns: rr;
  readonly struct?: false;
}

/** The handles of a `revertReturns` list, positionally: each declared type → its
 *  {@link ArgHandle} (a `t.struct` → a `Tuple`; anything else → an `Expr`). */
export type RevertReturnHandles<rr extends readonly EvsType[]> = {
  readonly [i in keyof rr]: rr[i] extends EvsType ? ArgHandle<rr[i]> : never;
};

/** `s.call` — {@link WriteVerb} plus the `revertReturns` overload (issue #35), whose result is
 *  typed from the declared list (`[] → void`, `[one] → handle`, `[many] → readonly tuple`). */
export interface CallVerb extends WriteVerb {
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, WriteMutability>,
    const rr extends readonly EvsType[],
  >(
    p: RevertReturnsParams<abi, name, rr>,
  ): UnwrapSingle<RevertReturnHandles<rr>>;
}

/** `s.tryCall` — {@link TryWriteVerb} plus the `revertReturns` overload (issue #35). */
export interface TryCallVerb extends TryWriteVerb {
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, WriteMutability>,
    const rr extends readonly EvsType[],
  >(
    p: RevertReturnsParams<abi, name, rr>,
  ): { readonly success: Expr<'bool'>; readonly value: UnwrapSingle<RevertReturnHandles<rr>> };
}
