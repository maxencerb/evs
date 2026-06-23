/**
 * M5 `builder/script.ts` — the public builder surface: `evscript`, `EvsScript`,
 * `ScriptBuilder`, `Cell`, `MutArray`, `LoopCtl`, `ScriptReturn`.
 *
 * Contract: docs/design/module-interfaces.md §M5 (frozen signatures) + api.md §1/§4–§9.
 * The recording engine (scope stack, handle internals, folding, validation checklist) lives
 * in `builder/expr.ts`; this file owns the frozen types and wires the typed facade onto it.
 */
import type { Abi, AbiParameter, AbiParameterToPrimitiveType } from 'abitype';
import type { ContractFunctionName } from 'viem';

import { buildScriptAbi, type ScriptAbi } from '../abi/artifact.js';
import * as compileModule from '../compile.js';
import type { CompiledEvsScript, CompileOptions } from '../compile.js';
import { EvsInternalError, EvsTypeError } from '../core/errors.js';
import { captureLoc, setLocCapture } from '../core/loc.js';
import { isEvsValueType } from '../core/types.js';
import type {
  AbiParamsToComponents,
  ArgSpec,
  ArrayType,
  BitsType,
  EvsType,
  Expr,
  IntoExpr,
  LitOf,
  NamedType,
  NumericType,
  StringType,
  TupleType,
  WordType,
} from '../core/types.js';
import type { ScriptIr } from '../ir/nodes.js';
import { assertV0Type, Recorder } from './expr.js';

// ---------------------------------------------------------------------------
// entry point (api.md §1)
// ---------------------------------------------------------------------------

export interface EvsScript<
  name extends string = string,
  args extends readonly EvsType[] = readonly EvsType[],
  ret extends Record<string, ReturnValue> = Record<string, ReturnValue>,
> {
  readonly name: name;
  readonly ir: ScriptIr; // frozen, JSON-serializable
  readonly abi: ScriptAbi<name, args, ret>; // literal-typed value, exists pre-compile
  compile(options?: CompileOptions): CompiledEvsScript<name, args, ret>; // sugar for compile()
}

/**
 * Script-args input (api.md §2): a single `t.*` type, or a `readonly` list of them. A lone type
 * is sugar for a one-element list (`args: t.uint256` ≡ `args: [t.uint256]`).
 */
export type ArgsInput = EvsType | readonly EvsType[];

/** Normalizes {@link ArgsInput} to the canonical `readonly EvsType[]` (lone type → one-tuple). */
export type NormalizeArgs<a extends ArgsInput> = a extends readonly EvsType[] ? a : readonly [a];

/**
 * The body-callback handle for one normalized arg type: a tuple/struct arg arrives as a
 * {@link Tuple} handle, every scalar arg as an {@link Expr}.
 */
export type ArgHandle<t extends EvsType> = t extends TupleType ? Tuple<t> : Expr<t>;

/**
 * The positional handle tuple spread into the body after `s`: homomorphic over the normalized arg
 * type list (order/labels preserved structurally — no `UnionToTuple`).
 */
export type ArgHandles<types extends readonly EvsType[]> = {
  readonly [i in keyof types]: ArgHandle<types[i]>;
};

const IDENT_RE = /^[A-Za-z_]\w*$/;

export function evscript<
  const name extends string,
  const args extends ArgsInput = readonly [],
  ret extends Record<string, ReturnValue> = Record<string, ReturnValue>,
>(
  def: { name: name; args?: args },
  body: (s: ScriptBuilder, ...args: ArgHandles<NormalizeArgs<args>>) => ScriptReturn<ret>,
  opts?: { locations?: boolean }, // default true: capture source locations
): EvsScript<name, NormalizeArgs<args>, ret> {
  const entryLoc = captureLoc();
  if (typeof def !== 'object' || def === null) {
    throw new EvsTypeError('TYPE_MISMATCH', `evscript: def must be { name, args? }`, {
      loc: entryLoc,
    });
  }
  if (typeof def.name !== 'string' || !IDENT_RE.test(def.name)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `evscript: script name must be a non-empty identifier, got ${JSON.stringify(def.name)}`,
      { loc: entryLoc },
    );
  }
  // `args` is optional (a zero-arg script omits it); a lone type normalizes to a one-element list.
  let argTypesIn: readonly unknown[];
  if (def.args === undefined) {
    argTypesIn = [];
  } else if (Array.isArray(def.args)) {
    argTypesIn = def.args;
  } else {
    argTypesIn = [def.args];
  }
  if (typeof body !== 'function') {
    throw new EvsTypeError('TYPE_MISMATCH', `evscript "${def.name}": body must be a callback`, {
      loc: entryLoc,
    });
  }
  const argSpecs = argTypesIn.map((ty, i): { name: string; type: EvsType } => {
    if (!isEvsValueType(ty)) {
      assertV0Type(ty, `evscript "${def.name}" arg #${i}`, entryLoc); // throws with a precise code
    }
    // each normalized arg is auto-named `arg{i}` (positional labels; viem infers args positionally)
    return { name: `arg${i}`, type: ty };
  });

  const locations = opts?.locations ?? true;
  if (!locations) setLocCapture(false); // scoped per recorder; restored below
  let recorder: Recorder;
  let callbackResult: unknown;
  try {
    recorder = new Recorder(def.name, argSpecs, locations ? entryLoc : null);
    const s = makeBuilder(recorder);
    // the engine yields Expr|Tuple handles positionally; the typed surface (ArgHandles) is
    // enforced at the call site (`as unknown as` — the recorder is intentionally untyped).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- recorder is dynamically typed; ArgHandles is enforced at the public surface
    const handles = recorder.argHandles() as unknown as ArgHandles<NormalizeArgs<args>>;
    callbackResult = body(s, ...handles);
  } finally {
    if (!locations) setLocCapture(true);
  }
  const { ir, returns } = recorder.finish(callbackResult);
  // the runtime ABI array is the encode/decode source of truth; the literal type mirrors it
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime↔type agreement is pinned by M3 tests
  const abi = buildScriptAbi(
    def.name,
    ir.args.map((a) => a.type),
    returns,
  ) as unknown as ScriptAbi<name, NormalizeArgs<args>, ret>;
  const script: EvsScript<name, NormalizeArgs<args>, ret> = {
    name: def.name,
    ir,
    abi,
    compile(options?: CompileOptions): CompiledEvsScript<name, NormalizeArgs<args>, ret> {
      // namespace access keeps this tolerant of the M9 module landing separately
      const compileFn: unknown = (compileModule as Record<string, unknown>)['compile'];
      if (typeof compileFn !== 'function') {
        throw new EvsInternalError(
          'INTERNAL',
          'compile() is not available — the evs compile module failed to load',
        );
      }
      // M9 frozen signature; the namespace-loaded compile is intentionally typed `unknown`.
      const typedCompile =
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
        compileFn as (
          sc: unknown,
          o?: CompileOptions,
        ) => CompiledEvsScript<name, NormalizeArgs<args>, ret>;
      return typedCompile(script, options);
    },
  };
  return Object.freeze(script);
}

// ---------------------------------------------------------------------------
// cells, mutable arrays, loop control (api.md §5)
// ---------------------------------------------------------------------------

export interface Cell<t extends EvsType> {
  readonly type: t;
  get(): Expr<t>; // fresh snapshot at this program point
  set(value: IntoExpr<t>): void;
}

/** The `T[]` value type of a `MutArray<e>` element `e`: a string element → `${e}[]` (pinned to the
 *  depth-bounded {@link EvsType} array vocabulary); a `tuple` element → a `tuple[]` {@link TupleType}
 *  with the SAME components (§12.8 — a `MutArray` element is always a plain `tuple`, so the array tag
 *  is exactly `'tuple[]'`). One-level-deeper only — deeper string arrays are rejected at record time. */
export type MutArrayValueOf<e extends EvsType> = e extends TupleType
  ? { readonly type: 'tuple[]'; readonly components: e['components'] }
  : e extends StringType
    ? Extract<`${e}[]`, EvsType>
    : never;

/** The element handle of a `MutArray<e>`: a `tuple` element → a {@link Tuple} handle; otherwise an
 *  {@link Expr} of the element type. */
export type MutArrayElem<e extends EvsType> = e extends TupleType
  ? Tuple<e>
  : Expr<Extract<e, EvsType>>;

/**
 * A mutable array (`s.newArray`) over element type `e` (§5; widened to composite elements in §12.8).
 * `e` is a word type, `string`/`bytes`, a one-level string array (`uint256[]`), or a `tuple`. `set`
 * accepts the element's `IntoMember` (a `Tuple` handle / literal for a tuple element, an `IntoExpr`
 * otherwise); `get` yields the element handle; `expr()` is the raw memref of the SAME buffer.
 */
export interface MutArray<e extends EvsType> {
  readonly elemType: e;
  readonly length: Expr<'uint256'>;
  set(i: IntoExpr<'uint256'>, v: IntoMember<e>): void; // bounds-checked → Panic 0x32
  get(i: IntoExpr<'uint256'>): MutArrayElem<e>; // bounds-checked → Panic 0x32
  expr(): Expr<MutArrayValueOf<e>>; // memref handle to the SAME buffer (reference semantics)
  // phantom brand (issue #5 ask #5): lets `s.return({ arr })` / an array slot accept the bare
  // handle (no `.expr()`). Type-only — the runtime `MutArrayImpl` carries no such property.
  readonly [mutArrayBrand]: MutArrayValueOf<e>;
}

export interface LoopCtl {
  break(): void;
  continue(): void;
}

// ---------------------------------------------------------------------------
// tuple / struct handles (api.md §5; spec §5)
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
 * a host literal.
 */
export type IntoTuple<t extends TupleType> = Tuple<t> | AnyTuple | LitOf<t>;

/** What an ARRAY-typed slot accepts: an {@link Expr}/literal of the array type, or a bare
 *  {@link MutArray} handle (issue #5 ask #5 — runtime `typesEqual` enforces the element match,
 *  mirroring the bare-{@link Tuple} loosening). */
export type IntoArray<t extends EvsType> = IntoExpr<t> | AnyMutArray;

/**
 * What `Field.set(v)` / a `s.tuple(...)` init slot / `MutArray.set` accepts for a member of type
 * `t`: a plain `tuple` member → {@link IntoTuple}; a `tuple[]`/`tuple[][]` or string-array member →
 * {@link IntoArray} (array Expr/literal/`MutArray`); a scalar member → {@link IntoExpr}.
 */
export type IntoMember<t extends EvsType> = t extends TupleType
  ? t['type'] extends 'tuple'
    ? IntoTuple<t>
    : IntoArray<t>
  : t extends ArrayType
    ? IntoArray<t>
    : IntoExpr<t>;

/**
 * A field handle over one tuple member (Cell-like). A composite member's `.get()` follows the
 * pointer and yields a {@link Tuple} handle; a scalar member's `.get()` yields an {@link Expr}.
 */
export interface Field<t extends EvsType> {
  readonly type: t;
  get(): t extends TupleType ? Tuple<t> : Expr<t>;
  set(value: IntoMember<t>): void;
}

/**
 * A tuple / struct memref handle (spec §5). For each NAMED component, a property keyed by the
 * component name yields a {@link Field} over that member; `at(i)` is the positional accessor; and
 * `expr()` is the raw memref {@link Expr} (for returning the tuple or passing it as a call arg).
 * Typed via abitype over `C['components']`. Reference semantics: the handle is the pointer, so a
 * later `field.set()` is visible through every alias (api.md §5).
 */
export type Tuple<C extends TupleType> = {
  readonly [c in C['components'][number] as c['name'] extends '' ? never : c['name']]: Field<
    ComponentToType<c>
  >;
} & {
  at(i: number): Field<ComponentToType<C['components'][number]>>;
  expr(): Expr<C>;
} & {
  // phantom brand: lets `s.return` / a return bound accept a `Tuple` DIRECTLY (no `.expr()`)
  // while staying distinguishable from an `Expr` even when a struct field is literally named
  // "type"/"expr". The brand is ERASED to `TupleType` (not `C`) so it is order-insensitive —
  // a `Tuple<A>` stays assignable to a `Tuple<B>` whenever their named members match (the
  // `s.call(...)` tuple-input boundary relies on this), and `TypeOfReturn` recovers the precise
  // `C` from `expr()` instead. Type-only — the runtime `TupleHandle` carries no such property.
  readonly [tupleBrand]: TupleType;
};

/** The element `tuple` descriptor of a `tuple[]` {@link TupleType} (same components, `type: 'tuple'`). */
export type TupleArrayElem<C extends TupleType> = {
  readonly type: 'tuple';
  readonly components: C['components'];
};

// `.at(i)` on a `tuple[]` Expr yields a typed {@link Tuple} element (the runtime `atOp` returns a
// Tuple handle bound to the `index` out ValueId — §12.8). The base `Expr.at` overload in
// `core/types.ts` only matches string-element arrays; this augmentation adds the tuple-array case
// where `Tuple`/`Field`/`ComponentToType` are in scope. Overload resolution picks the `this`-matching
// signature, so a `string[]`/`uint256[][]` Expr keeps returning an `Expr` element.
declare module '../core/types.js' {
  interface Expr<t extends EvsType = EvsType> {
    at<C extends TupleType>(this: Expr<C>, i: IntoExpr<'uint256'>): Tuple<TupleArrayElem<C>>;
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
 * What `s.return(...)` accepts per component: an {@link Expr} (the scalar/array/raw-memref form),
 * a {@link Tuple} handle DIRECTLY (no `.expr()` needed — composite types §6/§8), or a
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
 * The partial member record accepted by `s.tuple(type, init?)`. A fully-named struct takes a
 * name-keyed object; a positional `t.tuple` takes a positional record. Every member is optional
 * (omitted → zero) and accepts a literal, an {@link Expr}, or a {@link Tuple} (per member type).
 */
export type TupleInit<C extends TupleType> = C['components'][number]['name'] extends ''
  ? PositionalInit<C['components']>
  : {
      readonly [c in C['components'][number] as c['name'] extends ''
        ? never
        : c['name']]?: IntoMember<ComponentToType<c>>;
    };

/** The partial positional init record for a `t.tuple` (homomorphic over the components tuple, so
 *  a tuple literal — e.g. `[42n, addr]` — stays assignable). */
type PositionalInit<comps extends readonly NamedType[]> = {
  readonly [i in keyof comps]?: IntoMember<ComponentToType<comps[i]>>;
};

export declare const returnBrand: unique symbol;
export interface ScriptReturn<ret extends Record<string, ReturnValue>> {
  readonly [returnBrand]: ret;
}

// ---------------------------------------------------------------------------
// env (api.md §4)
// ---------------------------------------------------------------------------

export type EnvKind = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid';
export type EnvTypeOf<k extends EnvKind> = k extends 'address' | 'caller' ? 'address' : 'uint256';

// ---------------------------------------------------------------------------
// calls (api.md §6)
// ---------------------------------------------------------------------------

export type ViewMutability = 'pure' | 'view';

type ViewFnOf<abi, name> = abi extends Abi
  ? Extract<
      abi[number],
      { readonly type: 'function'; readonly name: name; readonly stateMutability: ViewMutability }
    >
  : never;

/** An abitype `AbiParameter` for a `'tuple'` member → the matching {@link TupleType} descriptor. */
type ParamToTupleType<p extends AbiParameter> = p extends {
  readonly type: 'tuple';
  readonly components: infer comps extends readonly NamedType[];
}
  ? { readonly type: 'tuple'; readonly components: comps }
  : never;

/** An abitype `AbiParameter` for a `'tuple[]'` member → the matching `tuple[]` {@link TupleType}
 *  descriptor (an array value type whose `.type` is `'tuple[]'`). */
type ParamToTupleArrayType<p extends AbiParameter> = p extends {
  readonly type: 'tuple[]';
  readonly components: infer comps extends readonly NamedType[];
}
  ? { readonly type: 'tuple[]'; readonly components: comps }
  : never;

// the staged handle of one OUTPUT parameter (§12.8 return side): a `tuple` param → a `Tuple` handle
// (decoded into a flat block); a `tuple[]` param → an `Expr` of the `tuple[]` descriptor (so a
// returned array is abitype-typed as `readonly Struct[]` and `.at(i)` is a typed Tuple element); a
// nested word array (`uint256[][]`) / `string[]` → an `Expr` of its string type (abitype infers
// `readonly (readonly bigint[])[]` / `readonly string[]`); every other scalar/array → an `Expr`.
type OutputHandle<p extends AbiParameter> = p['type'] extends 'tuple'
  ? Tuple<ParamToTupleType<p>>
  : p['type'] extends 'tuple[]'
    ? Expr<ParamToTupleArrayType<p>>
    : Expr<p['type'] extends EvsType ? p['type'] : EvsType>;

// what one INPUT parameter accepts: the abitype Register-resolved primitive (a literal object for
// a struct, a positional array for an unnamed tuple, a `readonly Struct[]` for a `tuple[]`) OR an
// `Expr`/handle of that type. For a `tuple` param: a `Tuple` handle / `s.tuple(...)` result. For a
// `tuple[]` param (§12.8): an `Expr` of the `tuple[]` descriptor (a decoded/constructed array handle)
// or the `readonly Struct[]` literal. `uint256[][]`/`string[]` are `EvsType` strings → `Expr<that>`.
type InputValue<p extends AbiParameter> = p['type'] extends 'tuple'
  ?
      | AbiParameterToPrimitiveType<p, 'inputs'>
      | Tuple<ParamToTupleType<p>>
      | AnyTuple // issue #5 ask #3: a cross-order call-decoded Tuple is accepted (runtime-checked)
      | Expr<ParamToTupleType<p>>
  : p['type'] extends 'tuple[]'
    ? AbiParameterToPrimitiveType<p, 'inputs'> | Expr<ParamToTupleArrayType<p>> | AnyMutArray // issue #5 ask #5: a bare MutArray<tuple> is accepted (runtime-checked)
    :
        | AbiParameterToPrimitiveType<p, 'inputs'>
        | Expr<p['type'] extends EvsType ? p['type'] : never>;

export type SubcallInputs<abi extends Abi | readonly unknown[], name extends string> = [
  ViewFnOf<abi, name>,
] extends [never]
  ? readonly unknown[]
  : ViewFnOf<abi, name> extends { readonly inputs: infer inputs extends readonly AbiParameter[] }
    ? { readonly [i in keyof inputs]: InputValue<inputs[i]> }
    : readonly unknown[];

export type SubcallOutputs<abi extends Abi | readonly unknown[], name extends string> = [
  ViewFnOf<abi, name>,
] extends [never]
  ? readonly (Expr | Tuple<TupleType>)[]
  : ViewFnOf<abi, name> extends { readonly outputs: infer outs extends readonly AbiParameter[] }
    ? { readonly [i in keyof outs]: OutputHandle<outs[i]> }
    : readonly (Expr | Tuple<TupleType>)[];

// outputs []  → void;  [one] → Expr<one> | Tuple<one>;  [many] → readonly tuple of handles (viem)
export type UnwrapSingle<outs> = outs extends readonly []
  ? void
  : outs extends readonly [infer one]
    ? one
    : outs;

/**
 * `s.call({ …, struct: true })` (issue #5 ask #2) → ONE named {@link Tuple} handle built over ALL
 * of the function's (named, ABI-ordered) outputs — the opt-in alternative to the default positional
 * `[many]` shape (which stays the default, mirroring viem's `readContract`). Requires every output
 * to carry a name at record time. The struct type is in ABI declaration order, so it unifies with
 * `t.fromOutputs(abi, name)` and a `t.struct` declared in the same order (issue #5 asks #3/#4).
 */
export type SubcallStruct<abi extends Abi | readonly unknown[], name extends string> = [
  ViewFnOf<abi, name>,
] extends [never]
  ? Tuple<TupleType>
  : ViewFnOf<abi, name> extends { readonly outputs: infer outs extends readonly AbiParameter[] }
    ? Tuple<{ readonly type: 'tuple'; readonly components: AbiParamsToComponents<outs> }>
    : Tuple<TupleType>;

export interface SubcallParams<
  abi extends Abi | readonly unknown[],
  name extends ContractFunctionName<abi, ViewMutability>,
> {
  readonly address: IntoExpr<'address'>;
  readonly abi: abi;
  readonly functionName: name | ContractFunctionName<abi, ViewMutability>; // autocomplete union
  readonly args?: SubcallInputs<abi, name>;
  readonly gas?: IntoExpr<'uint256'>; // optional cap; default forward-all
  // opt-in (issue #5 ask #2): decode multiple named outputs into ONE named Tuple handle instead of
  // the default positional `[many]` array. See {@link SubcallStruct}.
  readonly struct?: boolean;
}

// ---------------------------------------------------------------------------
// user functions (api.md §8)
// ---------------------------------------------------------------------------

/**
 * What an `s.fn` body may return (widened by issue #5 ask #1): a single {@link Expr}, a single
 * {@link Tuple}/{@link MutArray} handle (a composite/array result — byte-identical IR to `.expr()`),
 * a readonly list of those (the `[many]` shape), or void. `s.fn` PARAMS stay word/string-typed
 * (composite params are a separate v0 deferral — `arg()`'s bound is `StringType`).
 */
export type FnReturn = Expr | AnyTuple | AnyMutArray | readonly FnResult[] | void;
/** One element of an `s.fn` body's `[many]`-shape return. */
export type FnResult = Expr | AnyTuple | AnyMutArray;

/** An {@link EvsType} → the call-site handle the runtime `wrap`/`handleFor` yields for it: a plain
 *  `tuple` → a {@link Tuple} handle (named field access); any array/scalar → an {@link Expr}. */
type HandleOfType<c extends EvsType> = c extends TupleType
  ? c['type'] extends 'tuple'
    ? Tuple<c>
    : Expr<c>
  : Expr<c>;

/**
 * One fn result → the handle the CALL SITE receives, recovering the precise `EvsType` from the
 * result's static form and applying {@link HandleOfType}. CRUCIAL: this must agree with the runtime
 * `fnCall` `wrap` (which dispatches on the RESULT TYPE, not the body's static form), so a body that
 * returns `s.tuple(...).expr()` (an `Expr<tuple>`) and one that returns the bare `Tuple` both yield
 * a `Tuple<C>` at the call site — and an array result (`Expr<tuple[]>`, `MutArray`) yields an `Expr`.
 */
export type RebuildFnResult<r> =
  r extends Expr<infer t>
    ? HandleOfType<t>
    : r extends { expr(): Expr<infer c extends EvsType> }
      ? HandleOfType<c>
      : never;

// RebuildExprs: the `[many]` list → element-wise rebuild; a single Expr/Tuple/MutArray → its
// rebuilt call-site handle (via the result TYPE, matching the runtime); void → void.
export type RebuildExprs<r extends FnReturn> = r extends readonly FnResult[]
  ? { readonly [i in keyof r]: RebuildFnResult<r[i]> }
  : r extends Expr | AnyTuple | AnyMutArray
    ? RebuildFnResult<r>
    : void;

export type EvsFn<params extends readonly ArgSpec[], r extends FnReturn> = (
  ...args: { [i in keyof params]: IntoExpr<params[i]['type']> }
) => RebuildExprs<r>;

// ---------------------------------------------------------------------------
// the builder (api.md §4 — full surface)
// ---------------------------------------------------------------------------

export interface ScriptBuilder {
  // values & state
  lit<const t extends EvsType>(type: t, value: LitOf<t>): Expr<t>;
  let<const t extends EvsType>(type: t, init: IntoExpr<t>): Cell<t>;
  let<t extends EvsType>(init: Expr<t>): Cell<t>;
  // §12.8: `e` is a word type, `string`/`bytes`, a one-level string array (`uint256[]`), or a
  // `tuple` (deferred shapes — `tuple[]` element, deeper nesting, `T[N]` — throw at record time).
  newArray<const e extends EvsType>(elem: e, length: IntoExpr<'uint256'>): MutArray<e>;
  // tuple/struct allocator (spec §5): `init` is a partial, name-keyed (struct) or positional
  // (t.tuple) record of members; omitted members default to zero. Returns a `Tuple` handle.
  tuple<const c extends TupleType>(type: c, init?: TupleInit<c>): Tuple<c>;
  env<const k extends EnvKind>(kind: k): Expr<EnvTypeOf<k>>;
  // address/caller → Expr<'address'>; others → Expr<'uint256'>

  // ops (free-function mirrors of the Expr methods; same checked semantics)
  add<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>; // ≥1 operand an Expr
  sub<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  mul<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  div<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  mod<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  lt<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  gt<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  lte<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  gte<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  eq<t extends WordType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  neq<t extends WordType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>;
  and(a: IntoExpr<'bool'>, b: IntoExpr<'bool'>): Expr<'bool'>;
  or(a: IntoExpr<'bool'>, b: IntoExpr<'bool'>): Expr<'bool'>;
  not(a: IntoExpr<'bool'>): Expr<'bool'>;
  bitAnd<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  bitOr<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  bitXor<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;
  bitNot<t extends BitsType>(a: Expr<t>): Expr<t>;
  shl<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>;
  shr<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>;

  // control flow (combinators — api.md §7)
  if(cond: IntoExpr<'bool'>, then: () => void, otherwise?: () => void): void;
  while(cond: () => IntoExpr<'bool'>, body: (loop: LoopCtl) => void): void;
  for<const t extends NumericType>(
    range: { type: t; from: IntoExpr<t>; until: IntoExpr<t>; step?: IntoExpr<t> },
    body: (i: Expr<t>, loop: LoopCtl) => void,
  ): void;
  select<t extends EvsType>(cond: IntoExpr<'bool'>, a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;

  // calls (api.md §6) — the result shape depends on `struct` (issue #5 ask #2). Three overloads in
  // precedence order so the static type ALWAYS matches the runtime (`wantStruct = struct === true`):
  //   `struct: true`  → ONE named Tuple;
  //   `struct?: false` / omitted → the frozen positional `[many]` shape (unchanged default);
  //   a NON-LITERAL `boolean` → the union of both (the runtime decides on the value, so the caller
  //     must narrow — this closes the literal-vs-boolean soundness gap).
  call<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name> & { readonly struct: true },
  ): SubcallStruct<abi, name>;
  call<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name> & { readonly struct?: false },
  ): UnwrapSingle<SubcallOutputs<abi, name>>;
  call<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name>,
  ): SubcallStruct<abi, name> | UnwrapSingle<SubcallOutputs<abi, name>>;
  tryCall<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name> & { readonly struct: true },
  ): { readonly success: Expr<'bool'>; readonly value: SubcallStruct<abi, name> };
  tryCall<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name> & { readonly struct?: false },
  ): { readonly success: Expr<'bool'>; readonly value: UnwrapSingle<SubcallOutputs<abi, name>> };
  tryCall<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name>,
  ): {
    readonly success: Expr<'bool'>;
    readonly value: SubcallStruct<abi, name> | UnwrapSingle<SubcallOutputs<abi, name>>;
  };

  // functions (api.md §8)
  fn<const params extends readonly ArgSpec[], const r extends FnReturn>(
    name: string,
    params: params,
    body: (...args: { [i in keyof params]: Expr<params[i]['type']> }) => r,
  ): EvsFn<params, r>;

  // return (api.md §9) — accepts an `Expr` OR a `Tuple` handle directly per component (the
  // `.expr()` on a tuple is optional; the bare handle returns the same memref).
  return<const ret extends Record<string, ReturnValue>>(values: ret): ScriptReturn<ret>;
}

// ---------------------------------------------------------------------------
// the facade (typed surface over the untyped Recorder engine)
// ---------------------------------------------------------------------------

function makeBuilder(r: Recorder): ScriptBuilder {
  const builder = {
    lit: (type: unknown, value: unknown) => r.lit(type, value),
    let: (a: unknown, b?: unknown) => r.letCell(a, b),
    newArray: (elem: unknown, length: unknown) => r.newArray(elem, length),
    tuple: (type: unknown, init?: unknown) => r.tuple(type, init),
    env: (kind: unknown) => r.env(kind),

    add: (a: unknown, b: unknown) => r.bin('add', a, b, 's.add()'),
    sub: (a: unknown, b: unknown) => r.bin('sub', a, b, 's.sub()'),
    mul: (a: unknown, b: unknown) => r.bin('mul', a, b, 's.mul()'),
    div: (a: unknown, b: unknown) => r.bin('div', a, b, 's.div()'),
    mod: (a: unknown, b: unknown) => r.bin('mod', a, b, 's.mod()'),
    lt: (a: unknown, b: unknown) => r.bin('lt', a, b, 's.lt()'),
    gt: (a: unknown, b: unknown) => r.bin('gt', a, b, 's.gt()'),
    lte: (a: unknown, b: unknown) => r.bin('lte', a, b, 's.lte()'),
    gte: (a: unknown, b: unknown) => r.bin('gte', a, b, 's.gte()'),
    eq: (a: unknown, b: unknown) => r.bin('eq', a, b, 's.eq()'),
    neq: (a: unknown, b: unknown) => r.bin('neq', a, b, 's.neq()'),
    and: (a: unknown, b: unknown) => r.bin('and', a, b, 's.and()'),
    or: (a: unknown, b: unknown) => r.bin('or', a, b, 's.or()'),
    not: (a: unknown) => r.notOp(a, 's.not()'),
    bitAnd: (a: unknown, b: unknown) => r.bin('bitand', a, b, 's.bitAnd()'),
    bitOr: (a: unknown, b: unknown) => r.bin('bitor', a, b, 's.bitOr()'),
    bitXor: (a: unknown, b: unknown) => r.bin('bitxor', a, b, 's.bitXor()'),
    bitNot: (a: unknown) => r.bitNotOp(a, 's.bitNot()'),
    shl: (a: unknown, bits: unknown) => r.bin('shl', a, bits, 's.shl()'),
    shr: (a: unknown, bits: unknown) => r.bin('shr', a, bits, 's.shr()'),

    if: (cond: unknown, then: unknown, otherwise?: unknown) => {
      r.ifStmt(cond, then, otherwise);
    },
    while: (cond: unknown, body: unknown) => {
      r.whileStmt(cond, body);
    },
    for: (range: unknown, body: unknown) => {
      r.forStmt(range, body);
    },
    select: (cond: unknown, a: unknown, b: unknown) => r.select(cond, a, b),

    call: (p: unknown) => r.subcall(p, 'strict').value,
    tryCall: (p: unknown) => {
      const res = r.subcall(p, 'try');
      return Object.freeze({ success: res.success, value: res.value });
    },

    fn: (name: unknown, params: unknown, body: unknown) => r.defineFn(name, params, body),

    return: (values: unknown) => r.ret(values),
  };
  // the facade implements the frozen api.md §4 surface; types are enforced at the surface,
  // the engine is dynamic
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return builder as unknown as ScriptBuilder;
}
