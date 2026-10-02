/**
 * `builder/script/calls.ts` — the call-verb types: function-name and overload resolution
 * (`ResolveOverload`, in lockstep with the recorder's runtime rules), sub-call inputs / outputs,
 * and the six calling verbs as callable interfaces.
 */

import type { AbiStateMutability, Abi, AbiParameter, AbiParameterToPrimitiveType } from 'viem';

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
import type { AbiParamToEvsType, AllMembersNamed, UnionToTuple } from '../../core/types/derive.js';
import type { Expr, exprBrand } from '../../core/types/expr.js';
import type { ArgHandle } from './evscript.js';
import type {
  AnyTuple,
  AnyMutArray,
  TupleArrayTag,
  Tuple,
  StructLiteral,
  TupleArrayLiteral,
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
 * Whether `abi` is widened — typed `Abi`, imported from JSON or declared without `as const` — so
 * its function names and mutabilities are not known at the type level: it is not an `Abi` at all,
 * or one of its function entries has a non-literal `name` or `stateMutability`.
 */
type IsWideAbi<abi> = abi extends Abi
  ? true extends IsWideFunction<abi[number]>
    ? true
    : false
  : true;

type IsWideFunction<entry> = entry extends {
  readonly type: 'function';
  readonly name: infer name;
  readonly stateMutability: infer mut;
}
  ? string extends name
    ? true
    : AbiStateMutability extends mut
      ? true
      : false
  : false;

/**
 * What `functionName` accepts (issue #4): every function name in the bucket (the autocomplete) OR
 * a canonical signature (`'balanceOf(address)'`, {@link AbiFunctionSignature}) naming one overload
 * exactly. A widened ABI ({@link IsWideAbi}) accepts any string. A literal ABI with no function in
 * the bucket accepts nothing (`never`), so `s.read` on an all-`nonpayable` ABI is a compile error —
 * unlike viem's `ContractFunctionName`, which falls back to `string` on an empty name set.
 */
export type SubcallFunctionName<
  abi extends Abi | readonly unknown[],
  mut extends AbiStateMutability = ViewMutability,
> =
  IsWideAbi<abi> extends true
    ? string
    : FnsOf<abi, mut>['name'] | AbiFunctionSignature<FnsOf<abi, mut>>;

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
 *  makes the whole tuple positional); every member present and fitting, and nothing more — a key
 *  that names no member ({@link NoExtraKeys}) or a length other than the tuple's
 *  ({@link MayHaveLength}) is a misfit, as the coercion rejects it. */
type FitsStruct<v, comps> = comps extends readonly AbiParameter[]
  ? v extends object
    ? AllMembersNamed<comps> extends true
      ? v extends readonly unknown[]
        ? false
        : [
              | { [i in keyof comps]: NoFit<MemberFits<v, NameOf<comps[i]>, comps[i]>> }[number]
              | NoFit<NoExtraKeys<v, NameOf<comps[number]>>>,
            ] extends [never]
          ? true
          : false
      : v extends readonly unknown[]
        ? MayHaveLength<v['length'], comps['length']> extends true
          ? [{ [i in keyof comps]: NoFit<MemberFits<v, i, comps[i]>> }[number]] extends [never]
            ? true
            : false
          : false
        : false
    : false
  : false;

/** `true` when every key of the record `v` that the recorder's `Object.keys` lists (a string or
 *  a numeric one, the latter as its string form) is one of `names`; `false` when another key is
 *  required. A maybe-fit (`boolean`) when the other keys are all optional, or under an index
 *  signature (keys unknown statically): the value may carry none of them. */
type NoExtraKeys<v, names> =
  ExtraKeys<v, names> extends infer extra extends keyof v
    ? [extra] extends [never]
      ? true
      : string extends extra
        ? boolean
        : number extends extra
          ? boolean
          : Partial<Pick<v, extra>> extends Pick<v, extra>
            ? boolean
            : false
    : false;

/** The keys of `v` (symbols aside) whose string form is none of `names`. */
type ExtraKeys<v, names> = {
  [k in keyof v]-?: k extends symbol ? never : `${k & (string | number)}` extends names ? never : k;
}[keyof v];

/** Whether an array of length `len` may have the tuple's length `n`: a literal length must be
 *  `n`, a union of lengths (optional elements) or a plain `number` (`T[]`) need only include it —
 *  a maybe-fit, as the recorder decides by the runtime length. */
type MayHaveLength<len, n> = [Extract<len, n> | Extract<n, len>] extends [never] ? false : true;

type NameOf<c> = c extends { readonly name: infer n extends string } ? n : '';

/** The member `key` of the literal `v` is present and fits the component `c` (a plain array's
 *  element, its index unknown statically, stands for every position). */
type MemberFits<v, key, c> = c extends AbiParameter
  ? key extends keyof v
    ? FitsArg<v[key], c['type'], ComponentsOf<c>>
    : v extends readonly unknown[]
      ? number extends v['length']
        ? FitsArg<v[number], c['type'], ComponentsOf<c>>
        : false
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
 *  overloads turns into a missing-property error naming the fix and the candidate signatures (the
 *  recorder's `ABI_SHAPE` ambiguity); `args` fitting none of several same-arity overloads, likewise
 *  (its `TYPE_MISMATCH`). */
export type OverloadGuard<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability,
  args,
> =
  ResolveOverload<abi, name, mut, args> extends infer picked
    ? true extends IsUnion<picked>
      ? {
          readonly 'evs: ambiguous overload': `these args fit ${SignatureList<picked>} — pass typed values (s.lit(t.uint8, 1)) or name one by signature in functionName`;
        }
      : [picked] extends [never]
        ? FnOf<abi, name, mut> extends infer fns
          ? true extends IsUnion<fns>
            ? {
                readonly 'evs: no overload matches': `these args fit none of the overloads taking this many arguments (among ${SignatureList<fns>}) — a handle must carry the parameter type exactly (s.lit(t.uint8, 1)), a T[N] literal needs exactly N elements, a struct literal only its members; or name one by signature in functionName`;
              }
            : unknown
          : unknown
        : unknown
    : unknown;

/** A union of function entries → their canonical signatures, quoted and comma-separated. */
type SignatureList<fns> = JoinQuoted<UnionToTuple<AbiFunctionSignature<fns>>>;

type JoinQuoted<sigs> = sigs extends readonly [infer head extends string, ...infer rest]
  ? rest extends readonly []
    ? `"${head}"`
    : `"${head}", ${JoinQuoted<rest>}`
  : '';

/** An abitype `AbiParameter` for a `'tuple'` member → the matching {@link TupleType} descriptor. */
type ParamToTupleType<p extends AbiParameter> = p extends {
  readonly type: 'tuple';
  readonly components: infer comps extends readonly NamedType[];
}
  ? { readonly type: 'tuple'; readonly components: comps }
  : never;

/** An abitype `AbiParameter` for a `tuple…` param → its {@link TupleType} descriptor with the
 *  member names normalized (a `parseAbi` member with no `name` is unnamed, `''`), the literal
 *  shapes' input. */
type ParamToEvsTuple<p extends AbiParameter> = Extract<AbiParamToEvsType<p>, TupleType>;

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
// `Expr`/handle of that type. For a `tuple` param: a `Tuple` handle / `s.tuple(...)` result, or a
// struct literal whose members may be staged (`StructLiteral`: `{ tokenId: id, … }`, coerced like
// an `s.tuple` init with every member given). For a tuple-array param: an `Expr` of the
// tuple-array descriptor (a decoded/constructed array handle) or an array literal whose elements
// may be staged (`TupleArrayLiteral`). `uint256[][]`/`string[]`/`uint256[2]` are `EvsType` strings
// → `Expr<that>` (or the literal; a fixed-size literal is a tuple of exactly N).
type InputValue<p extends AbiParameter> = p['type'] extends 'tuple'
  ?
      | AbiParameterToPrimitiveType<p, 'inputs'>
      | StructLiteral<ParamToEvsTuple<p>>
      | Tuple<ParamToTupleType<p>>
      | AnyTuple // issue #5 ask #3: a cross-order call-decoded Tuple is accepted (runtime-checked)
      | Expr<ParamToTupleType<p>>
  : p['type'] extends TupleArrayTag
    ?
        | AbiParameterToPrimitiveType<p, 'inputs'>
        | TupleArrayLiteral<ParamToEvsTuple<p>>
        | Expr<ParamToTupleArrayType<p>>
        | AnyMutArray // issue #5 ask #5: a bare MutArray<tuple> is accepted (runtime-checked)
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

/**
 * What a sub-call on a widened ABI ({@link IsWideAbi}) can return: the recorder unwraps by the
 * real output count of the entry it resolves — none → `undefined`, one → that output's handle
 * (`Expr` or `Tuple`), several → a frozen array of handles — and the types cannot know that count.
 * Declare the ABI `as const` for exact types, or cast to the shape the function is known to have.
 */
export type WideSubcallResult =
  | Expr
  | Tuple<TupleType>
  | readonly (Expr | Tuple<TupleType>)[]
  | undefined;

/** The positional output handles of the function `name` selects; for an overloaded name, of the
 *  overload `args` resolves to ({@link ResolveOverload}). Without a resolved entry (a widened
 *  ABI), the already-unwrapped {@link WideSubcallResult} ({@link UnwrapSingle} passes it through). */
export type SubcallOutputs<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
  args = readonly unknown[],
> = [ResolveOverload<abi, name, mut, args>] extends [never]
  ? WideSubcallResult
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

/** What `value` accepts where the function cannot receive ETH: nothing. The name is the compile
 *  error (`Type 'bigint' is not assignable to type 'ValueRequiresPayableFunction'`). */
interface ValueRequiresPayableFunction {
  readonly 'evs: value is only accepted for a payable function (s.call / s.simulate)': never;
}

/**
 * The type of the `value` param: the wei to send, accepted iff the function the call resolves to
 * ({@link ResolveOverload}) is `payable` — so never under `s.read` / `s.tryRead`, and never for a
 * `nonpayable` target (which would revert on any ETH). A widened ABI (no literal entries to look
 * at) accepts it; the recorder then checks the resolved entry at run time, like everything else.
 */
export type CallValue<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
  args = readonly unknown[],
> = [ResolveOverload<abi, name, mut, args>] extends [{ readonly stateMutability: 'payable' }]
  ? IntoExpr<'uint256'>
  : ValueRequiresPayableFunction;

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
  // the wei the CALL sends (payable functions only, see {@link CallValue}); paid from the
  // script's own balance — fund it with a stateOverride `balance`. Default 0.
  readonly value?: CallValue<abi, name, mut, args>;
  // opt-in (issue #5 ask #2): decode multiple named outputs into ONE named Tuple handle instead of
  // the default positional `[many]` array. See {@link SubcallStruct}.
  readonly struct?: boolean;
}

// ---------------------------------------------------------------------------
// the six calling verbs (issue #1) as callable interfaces — one set of three struct-aware
// overloads per mutability bucket, shared by the strict and try flavours (`Tried`).
// `read`/`tryRead` filter to ViewMutability (STATICCALL); `call`/`tryCall`/`simulate`/
// `trySimulate` filter to WriteMutability (CALL).
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

/**
 * A verb's result for the strict (`tried = false`) or the try (`tried = true`) flavour: the try
 * verbs wrap the strict result `v` as `{ success, value }` (`value` is zeroed when `success` is
 * false). The one place the two flavours differ, so each verb set is declared once.
 */
export type Tried<tried extends boolean, v> = tried extends true
  ? { readonly success: Expr<'bool'>; readonly value: v }
  : v;

/** The calling-verb shape for one mutability bucket and flavour (see {@link Tried}). */
export interface SubcallVerbOf<mut extends AbiStateMutability, tried extends boolean> {
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args> & { readonly struct: true },
  ): Tried<tried, SubcallStruct<abi, name, mut, args>>;
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args> & { readonly struct?: false },
  ): Tried<tried, UnwrapSingle<SubcallOutputs<abi, name, mut, args>>>;
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, mut>,
    const args extends SubcallInputs<abi, name, mut> = SubcallInputs<abi, name, mut>,
  >(
    p: ResolvedSubcallParams<abi, name, mut, args>,
  ): Tried<
    tried,
    SubcallStruct<abi, name, mut, args> | UnwrapSingle<SubcallOutputs<abi, name, mut, args>>
  >;
}

/** The strict result shape, parameterized over the mutability bucket. */
export type SubcallVerb<mut extends AbiStateMutability> = SubcallVerbOf<mut, false>;

/** The try result shape (`{ success, value }`), parameterized over the mutability bucket. */
export type TrySubcallVerb<mut extends AbiStateMutability> = SubcallVerbOf<mut, true>;

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
 * `args` is the inferred argument tuple, as in {@link ResolvedSubcallParams}: the overload it
 * resolves to still decides the inputs and whether `value` is accepted ({@link CallValue}).
 */
export interface RevertReturnsParams<
  abi extends Abi | readonly unknown[],
  name extends SubcallFunctionName<abi, WriteMutability>,
  rr extends readonly EvsType[],
  args = SubcallInputs<abi, name, WriteMutability>,
> extends SubcallParams<abi, name, WriteMutability, args> {
  readonly revertReturns: rr;
  readonly struct?: false;
}

/** The handles of a `revertReturns` list, positionally: each declared type → its
 *  {@link ArgHandle} (a `t.struct` → a `Tuple`; anything else → an `Expr`). */
export type RevertReturnHandles<rr extends readonly EvsType[]> = {
  readonly [i in keyof rr]: rr[i] extends EvsType ? ArgHandle<rr[i]> : never;
};

/** The `s.call` / `s.tryCall` shape: {@link SubcallVerbOf} over the write bucket plus the
 *  `revertReturns` overload (issue #35), whose strict result is typed from the declared list
 *  (`[] → void`, `[one] → handle`, `[many] → readonly tuple`). */
export interface CallVerbOf<tried extends boolean> extends SubcallVerbOf<WriteMutability, tried> {
  <
    const abi extends Abi | readonly unknown[],
    name extends SubcallFunctionName<abi, WriteMutability>,
    const rr extends readonly EvsType[],
    const args extends SubcallInputs<abi, name, WriteMutability> = SubcallInputs<
      abi,
      name,
      WriteMutability
    >,
  >(
    p: RevertReturnsParams<abi, name, rr, args & OverloadGuard<abi, name, WriteMutability, args>>,
  ): Tried<tried, UnwrapSingle<RevertReturnHandles<rr>>>;
}

/** `s.call` — {@link WriteVerb} plus the `revertReturns` overload (issue #35). */
export type CallVerb = CallVerbOf<false>;

/** `s.tryCall` — {@link TryWriteVerb} plus the `revertReturns` overload (issue #35). */
export type TryCallVerb = CallVerbOf<true>;
