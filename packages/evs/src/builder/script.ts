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
  ArgSpec,
  BitsType,
  EvsType,
  Expr,
  IntoExpr,
  LitOf,
  NamedType,
  NumericType,
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

export interface MutArray<e extends WordType> {
  readonly elemType: e;
  readonly length: Expr<'uint256'>;
  set(i: IntoExpr<'uint256'>, v: IntoExpr<e>): void; // bounds-checked → Panic 0x32
  get(i: IntoExpr<'uint256'>): Expr<e>; // bounds-checked → Panic 0x32
  expr(): Expr<`${e}[]`>; // memref handle to the SAME buffer (reference semantics, documented)
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

/** The value a composite member accepts on write/init: a {@link Tuple} handle or a host literal. */
export type IntoTuple<t extends TupleType> = Tuple<t> | LitOf<t>;

/** What `Field.set(v)` / a `s.tuple(...)` init slot accepts for a member of type `t`. */
export type IntoMember<t extends EvsType> = t extends TupleType ? IntoTuple<t> : IntoExpr<t>;

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

/** @internal phantom brand keying {@link Tuple}; never present at runtime. */
export declare const tupleBrand: unique symbol;

/** A {@link Tuple} of unknown component shape — the erased brand carrier (return-bound widening). */
export type AnyTuple = { readonly [tupleBrand]: TupleType };

/**
 * What `s.return(...)` accepts per component: an {@link Expr} (the scalar/array/raw-memref form),
 * or a {@link Tuple} handle DIRECTLY (no `.expr()` needed — composite types §6/§8). `.expr()`
 * stays valid: it just yields the equivalent `Expr<C>`, which this union also covers.
 */
export type ReturnValue = Expr | AnyTuple;

/**
 * The {@link EvsType} a {@link ReturnValue} contributes: an `Expr`'s `t`, or — for a bare `Tuple`
 * handle — the `C` recovered from its `expr()` signature (a `Tuple` carries no `exprBrand`, so it
 * never matches the `Expr` arm; the erased {@link tupleBrand} only marks it as a tuple). The
 * recovered `C` is exactly what `tuple.expr()` would have yielded, so both forms infer identically.
 */
export type TypeOfReturn<v> =
  v extends Expr<infer t> ? t : v extends { expr(): Expr<infer c extends TupleType> } ? c : never;

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

// the staged handle of one OUTPUT parameter: a tuple param → a `Tuple` handle (decoded into a
// flat block), every scalar/array param → an `Expr` of its type.
type OutputHandle<p extends AbiParameter> = p['type'] extends 'tuple'
  ? Tuple<ParamToTupleType<p>>
  : Expr<p['type'] extends EvsType ? p['type'] : EvsType>;

// what one INPUT parameter accepts: the abitype Register-resolved primitive (a literal object for
// a struct, a positional array for an unnamed tuple) OR an `Expr` of that type OR — for a tuple
// param — a `Tuple` handle / `s.tuple(...)` result.
type InputValue<p extends AbiParameter> = p['type'] extends 'tuple'
  ?
      | AbiParameterToPrimitiveType<p, 'inputs'>
      | Tuple<ParamToTupleType<p>>
      | Expr<ParamToTupleType<p>>
  : AbiParameterToPrimitiveType<p, 'inputs'> | Expr<p['type'] extends EvsType ? p['type'] : never>;

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

export interface SubcallParams<
  abi extends Abi | readonly unknown[],
  name extends ContractFunctionName<abi, ViewMutability>,
> {
  readonly address: IntoExpr<'address'>;
  readonly abi: abi;
  readonly functionName: name | ContractFunctionName<abi, ViewMutability>; // autocomplete union
  readonly args?: SubcallInputs<abi, name>;
  readonly gas?: IntoExpr<'uint256'>; // optional cap; default forward-all
}

// ---------------------------------------------------------------------------
// user functions (api.md §8)
// ---------------------------------------------------------------------------

export type FnReturn = Expr | readonly Expr[] | void;

// RebuildExprs: Expr<t> → fresh Expr<t>; tuples → fresh tuples; void → void
export type RebuildExprs<r extends FnReturn> =
  r extends Expr<infer tt>
    ? Expr<tt>
    : r extends readonly Expr[]
      ? { readonly [i in keyof r]: r[i] extends Expr<infer tt> ? Expr<tt> : never }
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
  newArray<const e extends WordType>(elem: e, length: IntoExpr<'uint256'>): MutArray<e>;
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

  // calls (api.md §6)
  call<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name>,
  ): UnwrapSingle<SubcallOutputs<abi, name>>;
  tryCall<
    const abi extends Abi | readonly unknown[],
    name extends ContractFunctionName<abi, ViewMutability>,
  >(
    p: SubcallParams<abi, name>,
  ): { readonly success: Expr<'bool'>; readonly value: UnwrapSingle<SubcallOutputs<abi, name>> };

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
