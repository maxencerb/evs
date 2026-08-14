/**
 * M5 `builder/script.ts` — the public builder surface: `evscript`, `EvsScript`,
 * `ScriptBuilder`, `Cell`, `MutArray`, `LoopCtl`, `ScriptReturn`.
 *
 * Contract: docs/design/module-interfaces.md §M5 (frozen signatures) + api.md §1/§4–§9.
 * The recording engine (scope stack, handle internals, folding, validation checklist) lives
 * in `builder/expr.ts`; this file owns the frozen types and wires the typed facade onto it.
 */
import type {
  Abi,
  AbiParameter,
  AbiParameterToPrimitiveType,
  AbiParametersToPrimitiveTypes,
  AbiStateMutability,
} from 'abitype';
import type { ContractFunctionName } from 'viem';

import {
  buildScriptAbi,
  errorSelectorOf,
  selectorOf,
  type ResolveArgName,
  type ScriptAbi,
} from '../abi/artifact.js';
import * as compileModule from '../compile.js';
import type { CompiledEvsScript, CompileOptions } from '../compile.js';
import { EvsInternalError, EvsTypeError } from '../core/errors.js';
import { captureLoc, setLocCapture } from '../core/loc.js';
import { isEvsValueType, typeToAbiParam } from '../core/types.js';
import type {
  AbiParamsToComponents,
  ArgsInput,
  ArgSpec,
  ArrayElemOf,
  ArrayType,
  BitsType,
  EvsErrorType,
  EvsType,
  Expr,
  IntoExpr,
  LitOf,
  NamedType,
  NormalizeArgs,
  NumericType,
  StringType,
  TupleType,
  WordType,
} from '../core/types.js';
import type { PlainAbiError, ScriptIr } from '../ir/nodes.js';
import { assertV0Type, Recorder, type RecErrorDecl } from './expr.js';

// ---------------------------------------------------------------------------
// entry point (api.md §1)
// ---------------------------------------------------------------------------

export interface EvsScript<
  name extends string = string,
  args extends readonly ArgSpec[] = readonly ArgSpec[],
  ret extends Record<string, ReturnValue> = Record<string, ReturnValue>,
  // declared custom errors (issue #15) — trailing param with a wide default, so pre-#15
  // `EvsScript<n, a, r>` instantiations keep compiling and stay supertypes of concrete scripts
  errs extends readonly EvsErrorType[] = readonly EvsErrorType[],
> {
  readonly name: name;
  readonly ir: ScriptIr; // frozen, JSON-serializable
  readonly abi: ScriptAbi<name, args, ret, errs>; // literal-typed value, exists pre-compile
  readonly errors: errs; // the declared `t.error` values (frozen; [] when none)
  compile(options?: CompileOptions): CompiledEvsScript<name, args, ret, errs>; // sugar for compile()
}

// `ArgInput` / `ArgsInput` / `ToArgSpec` / `NormalizeArgs` moved to M1 core/types.ts (issue #15
// — `t.error` params take the same shorthand and core takes no builder import); re-exported
// verbatim so the frozen M5 surface is unchanged.
export type { ArgInput, ArgsInput, NormalizeArgs, ToArgSpec } from '../core/types.js';

/**
 * `errors` input on the script def (issue #15): a single `t.error` value or a `readonly` list
 * of them (a lone declaration is sugar for a one-element list, like `args`).
 */
export type ErrorsInput = EvsErrorType | readonly EvsErrorType[];

/** Normalizes {@link ErrorsInput} to the canonical `readonly EvsErrorType[]`. */
export type NormalizeErrors<e extends ErrorsInput> = e extends readonly EvsErrorType[]
  ? e
  : readonly [e];

/** The named-record args form of `s.throw` (every param named): one REQUIRED member per param
 *  (no zero-defaulting — Solidity parity), each taking the param type's {@link IntoMember}. */
export type ThrowArgRecord<params extends readonly ArgSpec[]> = {
  readonly [p in params[number] as p['name'] & string]: IntoMember<Extract<p['type'], EvsType>>;
};

/** The positional args form of `s.throw` (any bare param): a full tuple, one entry per param. */
export type ThrowArgTuple<params extends readonly ArgSpec[]> = {
  readonly [i in keyof params]: IntoMember<Extract<params[i]['type'], EvsType>>;
};

/**
 * The rest-args shape of `s.throw(error, ...)` for one declared error: nothing for a
 * zero-param error; ONE name-keyed record when every param is named; ONE positional tuple
 * otherwise (mirrors the `s.tuple` init split, but with required members).
 */
export type ThrowArgs<e extends EvsErrorType> = e['params'] extends readonly []
  ? readonly []
  : [Extract<e['params'][number]['name'], ''>] extends [never]
    ? readonly [args: ThrowArgRecord<e['params']>]
    : readonly [args: ThrowArgTuple<e['params']>];

/**
 * The handle the runtime `valueHandle` yields for a value of type `t`: a plain tuple/struct
 * arrives as a {@link Tuple} handle, a composite ARRAY (`tuple[]`/`tuple[][]`) and every scalar
 * as an {@link Expr} (fixed by #12; the pre-#12 type wrongly mapped `tuple[]` args to `Tuple`,
 * disagreeing with the runtime handle). THE single type-level mirror of that dispatch — arg
 * handles, `s.fn` results ({@link RebuildFnResult}), tuple-array elements
 * ({@link TupleArrayElemHandle}) and `Field.get` all derive from it, so the static types cannot
 * drift from `valueHandle` one surface at a time. A NON-literal (constraint-widened) tuple tag
 * has no single runtime answer, so it yields the honest union `Tuple<t> | Expr<t>`.
 */
export type ArgHandle<t extends EvsType> = t extends TupleType
  ? t['type'] extends 'tuple'
    ? Tuple<t>
    : 'tuple' extends t['type']
      ? Tuple<t> | Expr<t>
      : Expr<t>
  : Expr<t>;

/**
 * A LABEL-carrying tuple built from an {@link ArgSpec} list (issue #9): abitype's named-tuple
 * inference (`AbiParametersToPrimitiveTypes<…, 'inputs', true>` — the exact path viem uses for its
 * `args` labels) applied to synthetic `AbiParameter`s. Used PURELY as a source of tuple-member
 * LABELS — the element primitive types are remapped away by {@link ArgHandles}/{@link FnArgHandles}/
 * {@link EvsFn}, so the carrier's element `type` is a constant placeholder (the label comes from the
 * NAME, never the type). A named arg labels its element; a bare arg (resolved to `arg{i}`) labels
 * positionally. The placeholder keeps the synthetic params PROVABLY `readonly AbiParameter[]` with no
 * intersection — an intersection breaks abitype's `>6`-element rest-pattern match (it falls back to
 * `readonly unknown[]`, dropping args), so it must stay a clean tuple.
 */
type LabelCarrier<specs extends readonly ArgSpec[]> = AbiParametersToPrimitiveTypes<
  {
    readonly [i in keyof specs]: {
      readonly name: ResolveArgName<specs[i]['name'], i>;
      readonly type: 'uint256';
    };
  },
  'inputs',
  true
>;

/**
 * The positional handle tuple spread into the body after `s`: homomorphic over the {@link
 * LabelCarrier} type parameter `L` so the surfaced arg names appear as the callback parameter
 * LABELS (issue #9; mapping over a label-carrying type parameter is the only way to synthesize tuple
 * labels — see `LabelCarrier`), while the element handles come from the parallel `specs` (a tuple
 * arg → a {@link Tuple} handle, else an {@link Expr}). No `UnionToTuple`.
 */
export type ArgHandles<
  specs extends readonly ArgSpec[],
  L extends readonly unknown[] = LabelCarrier<specs>,
> = {
  readonly [i in keyof L]: i extends keyof specs
    ? ArgHandle<Extract<specs[i]['type'], EvsType>>
    : never;
};

const IDENT_RE = /^[A-Za-z_]\w*$/;

/**
 * A {@link namedArg}-produced {@link ArgSpec} value: a plain object carrying a string `name` (a bare
 * type is a string; a bare composite type is a {@link TupleType} object, which has no `name`). Used
 * to distinguish a named declarator from a bare one when normalizing `evscript` args / `s.fn` params.
 */
function isArgSpecValue(v: unknown): v is { readonly name: string; readonly type: unknown } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { name?: unknown }).name === 'string' &&
    'type' in v
  );
}

/** A `t.error`-produced value (issue #15): the `kind: 'error'` discriminant plus the frozen
 *  shape `t.error` builds. Param/type validity is re-checked below — a hand-built value
 *  cannot smuggle junk into the IR or the ABI. */
function isEvsErrorValue(v: unknown): v is EvsErrorType {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as { kind?: unknown; name?: unknown; params?: unknown };
  return o.kind === 'error' && typeof o.name === 'string' && Array.isArray(o.params);
}

// the four built-in selectors a declared error may not collide with (issue #15): Solidity's
// Panic/Error plus the evs runtime errors. Name shadowing is rejected separately (t.error +
// buildScriptAbi); this catches the astronomically-unlikely selector collision under a
// DIFFERENT name, which would corrupt every decode path.
const BUILTIN_ERROR_SELECTORS: ReadonlyMap<string, string> = new Map([
  [selectorOf('Panic', ['uint256']), 'Panic(uint256)'],
  [selectorOf('Error', ['string']), 'Error(string)'],
  [selectorOf('EvsDecodeError', ['uint256']), 'EvsDecodeError(uint256)'],
  [selectorOf('EvsInvalidCalldata', []), 'EvsInvalidCalldata()'],
]);

/** Normalizes + validates the def's `errors` list into recorder decls (issue #15): each entry
 *  must be a `t.error` value with v0 param types; names and selectors must be unique (and
 *  selector-disjoint from the built-ins). */
function normalizeErrorDecls(
  scriptName: string,
  errorsIn: unknown,
  entryLoc: ReturnType<typeof captureLoc>,
): readonly RecErrorDecl[] {
  let list: readonly unknown[];
  if (errorsIn === undefined) {
    list = [];
  } else if (Array.isArray(errorsIn)) {
    list = errorsIn;
  } else {
    list = [errorsIn];
  }
  const seenNames = new Set<string>();
  const seenSelectors = new Map<string, string>();
  return list.map((e, i): RecErrorDecl => {
    const ctx = `evscript "${scriptName}" errors[${i}]`;
    if (!isEvsErrorValue(e)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: expected an error declared with t.error(...), got ${typeof e === 'object' && e !== null ? 'a non-error object' : String(e)}`,
        { loc: entryLoc },
      );
    }
    if (!IDENT_RE.test(e.name)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: invalid error name ${JSON.stringify(e.name)} (must be a non-empty identifier)`,
        { loc: entryLoc },
      );
    }
    if (seenNames.has(e.name)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: duplicate error name "${e.name}" — each declared error needs a distinct name (the client-side switch is keyed by name)`,
        { loc: entryLoc },
      );
    }
    seenNames.add(e.name);
    // re-validate the params (a t.error value is trusted-shaped, a hand-built one is not),
    // then rebuild the canonical inputs — never trust a carried `abi` blob.
    const params = (e.params as readonly unknown[]).map((p, j) => {
      if (
        !isArgSpecValue(p) ||
        (p.name !== '' && !IDENT_RE.test(p.name)) ||
        !isEvsValueType(p.type)
      ) {
        throw new EvsTypeError(
          'ERROR_DECL',
          `${ctx} ("${e.name}"): param #${j} is not a valid t.error param`,
          { loc: entryLoc },
        );
      }
      return { name: p.name, type: p.type };
    });
    const inputs = Object.freeze(
      params.map((p, j) => typeToAbiParam(p.name === '' ? `arg${j}` : p.name, p.type)),
    );
    const selector = errorSelectorOf(e.name, inputs);
    const builtin = BUILTIN_ERROR_SELECTORS.get(selector);
    if (builtin !== undefined) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: error "${e.name}" has the same 4-byte selector (${selector}) as the built-in ${builtin} — rename it or change its params`,
        { loc: entryLoc },
      );
    }
    const clash = seenSelectors.get(selector);
    if (clash !== undefined) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: error "${e.name}" has the same 4-byte selector (${selector}) as declared error "${clash}"`,
        { loc: entryLoc },
      );
    }
    seenSelectors.set(selector, e.name);
    return {
      value: e,
      params: Object.freeze(params),
      ir: Object.freeze({ name: e.name, selector, inputs }) satisfies PlainAbiError,
    };
  });
}

export function evscript<
  const name extends string,
  const args extends ArgsInput = readonly [],
  ret extends Record<string, ReturnValue> = Record<string, ReturnValue>,
  const errs extends ErrorsInput = readonly [],
>(
  def: { name: name; args?: args; errors?: errs },
  body: (
    s: ScriptBuilder<NormalizeErrors<errs>>,
    ...args: ArgHandles<NormalizeArgs<args>>
  ) => ScriptReturn<ret>,
  opts?: { locations?: boolean }, // default true: capture source locations
): EvsScript<name, NormalizeArgs<args>, ret, NormalizeErrors<errs>> {
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
  // `args` is optional (a zero-arg script omits it); a lone declarator (a bare type or a single
  // `namedArg`) normalizes to a one-element list (issue #9).
  let declsIn: readonly unknown[];
  if (def.args === undefined) {
    declsIn = [];
  } else if (Array.isArray(def.args)) {
    declsIn = def.args;
  } else {
    declsIn = [def.args];
  }
  if (typeof body !== 'function') {
    throw new EvsTypeError('TYPE_MISMATCH', `evscript "${def.name}": body must be a callback`, {
      loc: entryLoc,
    });
  }
  // a `namedArg` declarator carries its user name; a bare type is auto-named `arg{i}` (the
  // positional fallback — viem still infers args positionally, but the name surfaces as the label).
  const argSpecs = declsIn.map((d, i): { name: string; type: EvsType } => {
    if (isArgSpecValue(d)) {
      const ty: unknown = d.type;
      if (!isEvsValueType(ty)) {
        assertV0Type(ty, `evscript "${def.name}" arg "${d.name}"`, entryLoc);
      }
      return { name: d.name, type: ty };
    }
    if (!isEvsValueType(d)) {
      assertV0Type(d, `evscript "${def.name}" arg #${i}`, entryLoc); // throws with a precise code
    }
    return { name: `arg${i}`, type: d };
  });

  // declared custom errors (issue #15): normalized + validated before recording starts, so a
  // bad declaration fails fast (and s.throw checks against the same decls).
  const errorDecls = normalizeErrorDecls(def.name, def.errors, entryLoc);

  const locations = opts?.locations ?? true;
  if (!locations) setLocCapture(false); // scoped per recorder; restored below
  let recorder: Recorder;
  let callbackResult: unknown;
  try {
    recorder = new Recorder(def.name, argSpecs, locations ? entryLoc : null, errorDecls);
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
  // the runtime ABI array is the encode/decode source of truth; the literal type mirrors it.
  // `ir.args` carries each arg's resolved name (user `namedArg` name or the `arg{i}` fallback), so
  // the ABI inputs are labeled accordingly (issue #9).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime↔type agreement is pinned by M3 tests
  const abi = buildScriptAbi(
    def.name,
    ir.args,
    returns,
    errorDecls.map((d) => d.ir),
  ) as unknown as ScriptAbi<name, NormalizeArgs<args>, ret, NormalizeErrors<errs>>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decls carry the original t.error values verbatim
  const errors = Object.freeze(errorDecls.map((d) => d.value)) as unknown as NormalizeErrors<errs>;
  const script: EvsScript<name, NormalizeArgs<args>, ret, NormalizeErrors<errs>> = {
    name: def.name,
    ir,
    abi,
    errors,
    compile(
      options?: CompileOptions,
    ): CompiledEvsScript<name, NormalizeArgs<args>, ret, NormalizeErrors<errs>> {
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
        ) => CompiledEvsScript<name, NormalizeArgs<args>, ret, NormalizeErrors<errs>>;
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
  // `s.read(...)` tuple-input boundary relies on this), and `TypeOfReturn` recovers the precise
  // `C` from `expr()` instead. Type-only — the runtime `TupleHandle` carries no such property.
  readonly [tupleBrand]: TupleType;
};

/** The element `tuple` descriptor of a `tuple[]` {@link TupleType} (same components, `type: 'tuple'`). */
export type TupleArrayElem<C extends TupleType> = {
  readonly type: 'tuple';
  readonly components: C['components'];
};

/** One `[]` peeled off a tuple-ARRAY descriptor: `tuple[]` → its plain `tuple` element
 *  (= {@link TupleArrayElem}), `tuple[][]` → its `tuple[]` row; a non-array `tuple` → `never`. */
type PeelTupleArray<C extends TupleType> = C['type'] extends `${infer inner}[]`
  ? { readonly type: inner & TupleType['type']; readonly components: C['components'] }
  : never;

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
// handle bound to the `index` out ValueId for a plain-tuple element, an Expr otherwise — §12.8).
// The base `Expr.at` overload in `core/types.ts` only matches string-element arrays; this
// augmentation adds the tuple-array case where `Tuple`/`Field`/`ComponentToType` are in scope.
// Overload resolution picks the `this`-matching signature, so a `string[]`/`uint256[][]` Expr
// keeps returning an `Expr` element. Sharpened by the issue-#12 follow-up: the receiver is
// pinned to ARRAY tags (a plain-`tuple` Expr is now a compile error, matching the record-time
// rejection) and the element comes from {@link TupleArrayElemHandle} (a `tuple[][]` element is
// an `Expr<tuple[]>`, matching the runtime — it was wrongly a named-field `Tuple` before).
// `.length()` gets the matching tuple-ARRAY overload (the base bound is `DynType | ArrayType`,
// which a `tuple[]` Expr is not; the runtime `lenOp` accepts every dynamic memref).
declare module '../core/types.js' {
  interface Expr<t extends EvsType = EvsType> {
    at<C extends TupleType & { readonly type: 'tuple[]' | 'tuple[][]' }>(
      this: Expr<C>,
      i: IntoExpr<'uint256'>,
    ): TupleArrayElemHandle<C>;
    length(this: Expr<TupleType & { readonly type: 'tuple[]' | 'tuple[][]' }>): Expr<'uint256'>;
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
 * any staged handle — an {@link Expr} of any v0 type, a {@link Tuple}, or a {@link MutArray} (bare
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

type FnOf<abi, name, mut extends AbiStateMutability> = abi extends Abi
  ? Extract<
      abi[number],
      { readonly type: 'function'; readonly name: name; readonly stateMutability: mut }
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

export type SubcallInputs<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
> = [FnOf<abi, name, mut>] extends [never]
  ? readonly unknown[]
  : FnOf<abi, name, mut> extends { readonly inputs: infer inputs extends readonly AbiParameter[] }
    ? { readonly [i in keyof inputs]: InputValue<inputs[i]> }
    : readonly unknown[];

export type SubcallOutputs<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
> = [FnOf<abi, name, mut>] extends [never]
  ? readonly (Expr | Tuple<TupleType>)[]
  : FnOf<abi, name, mut> extends { readonly outputs: infer outs extends readonly AbiParameter[] }
    ? { readonly [i in keyof outs]: OutputHandle<outs[i]> }
    : readonly (Expr | Tuple<TupleType>)[];

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
export type SubcallStruct<
  abi extends Abi | readonly unknown[],
  name extends string,
  mut extends AbiStateMutability = ViewMutability,
> = [FnOf<abi, name, mut>] extends [never]
  ? Tuple<TupleType>
  : FnOf<abi, name, mut> extends { readonly outputs: infer outs extends readonly AbiParameter[] }
    ? Tuple<{ readonly type: 'tuple'; readonly components: AbiParamsToComponents<outs> }>
    : Tuple<TupleType>;

export interface SubcallParams<
  abi extends Abi | readonly unknown[],
  name extends ContractFunctionName<abi, mut>,
  mut extends AbiStateMutability = ViewMutability,
> {
  readonly address: IntoExpr<'address'>;
  readonly abi: abi;
  readonly functionName: name | ContractFunctionName<abi, mut>; // autocomplete union
  readonly args?: SubcallInputs<abi, name, mut>;
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

/** The strict result shape, parameterized over the mutability bucket. */
export interface SubcallVerb<mut extends AbiStateMutability> {
  <const abi extends Abi | readonly unknown[], name extends ContractFunctionName<abi, mut>>(
    p: SubcallParams<abi, name, mut> & { readonly struct: true },
  ): SubcallStruct<abi, name, mut>;
  <const abi extends Abi | readonly unknown[], name extends ContractFunctionName<abi, mut>>(
    p: SubcallParams<abi, name, mut> & { readonly struct?: false },
  ): UnwrapSingle<SubcallOutputs<abi, name, mut>>;
  <const abi extends Abi | readonly unknown[], name extends ContractFunctionName<abi, mut>>(
    p: SubcallParams<abi, name, mut>,
  ): SubcallStruct<abi, name, mut> | UnwrapSingle<SubcallOutputs<abi, name, mut>>;
}

/** The try result shape (`{ success, value }`), parameterized over the mutability bucket. */
export interface TrySubcallVerb<mut extends AbiStateMutability> {
  <const abi extends Abi | readonly unknown[], name extends ContractFunctionName<abi, mut>>(
    p: SubcallParams<abi, name, mut> & { readonly struct: true },
  ): { readonly success: Expr<'bool'>; readonly value: SubcallStruct<abi, name, mut> };
  <const abi extends Abi | readonly unknown[], name extends ContractFunctionName<abi, mut>>(
    p: SubcallParams<abi, name, mut> & { readonly struct?: false },
  ): {
    readonly success: Expr<'bool'>;
    readonly value: UnwrapSingle<SubcallOutputs<abi, name, mut>>;
  };
  <const abi extends Abi | readonly unknown[], name extends ContractFunctionName<abi, mut>>(
    p: SubcallParams<abi, name, mut>,
  ): {
    readonly success: Expr<'bool'>;
    readonly value: SubcallStruct<abi, name, mut> | UnwrapSingle<SubcallOutputs<abi, name, mut>>;
  };
}

/** `s.read` — STATICCALL of a `view`/`pure` function (the frozen read surface). */
export type ReadVerb = SubcallVerb<ViewMutability>;
/** `s.tryRead` — STATICCALL, never reverts the script (`{ success, value }`). */
export type TryReadVerb = TrySubcallVerb<ViewMutability>;
/** `s.call` / `s.simulate` — a `CALL` frame for a `nonpayable`/`payable` function. */
export type WriteVerb = SubcallVerb<WriteMutability>;
/** `s.tryCall` / `s.trySimulate` — a `CALL` frame, never reverts the script. */
export type TryWriteVerb = TrySubcallVerb<WriteMutability>;

// ---------------------------------------------------------------------------
// user functions (api.md §8)
// ---------------------------------------------------------------------------

/**
 * What an `s.fn` body may return (widened by issue #5 ask #1): a single {@link Expr}, a single
 * {@link Tuple}/{@link MutArray} handle (a composite/array result — byte-identical IR to `.expr()`),
 * a readonly list of those (the `[many]` shape), or void. `s.fn` PARAMS stay word/string-typed —
 * composite params are a separate v0 deferral, rejected at record time with `UNSUPPORTED_V0`
 * whether declared bare or via `namedArg` (whose bound admits every `EvsType` since #25).
 */
export type FnReturn = Expr | AnyTuple | AnyMutArray | readonly FnResult[] | void;
/** One element of an `s.fn` body's `[many]`-shape return. */
export type FnResult = Expr | AnyTuple | AnyMutArray;

/**
 * One fn result → the handle the CALL SITE receives, recovering the precise `EvsType` from the
 * result's static form and applying {@link ArgHandle} (the single `valueHandle`-parity dispatch —
 * the former file-private `HandleOfType` was character-for-character the same conditional).
 * CRUCIAL: this must agree with the runtime `fnCall` `wrap` (which dispatches on the RESULT TYPE,
 * not the body's static form), so a body that returns `s.tuple(...).expr()` (an `Expr<tuple>`) and
 * one that returns the bare `Tuple` both yield a `Tuple<C>` at the call site — and an array result
 * (`Expr<tuple[]>`, `MutArray`) yields an `Expr`.
 */
export type RebuildFnResult<r> =
  r extends Expr<infer t>
    ? ArgHandle<t>
    : r extends { expr(): Expr<infer c extends EvsType> }
      ? ArgHandle<c>
      : never;

// RebuildExprs: the `[many]` list → element-wise rebuild; a single Expr/Tuple/MutArray → its
// rebuilt call-site handle (via the result TYPE, matching the runtime); void → void.
export type RebuildExprs<r extends FnReturn> = r extends readonly FnResult[]
  ? { readonly [i in keyof r]: RebuildFnResult<r[i]> }
  : r extends Expr | AnyTuple | AnyMutArray
    ? RebuildFnResult<r>
    : void;

/**
 * The body-callback param tuple for an `s.fn`: each param as an {@link Expr}, LABELED by its
 * surfaced name (issue #9) — homomorphic over the {@link LabelCarrier} type parameter `L` (the only
 * way to synthesize tuple/param labels), with the element types from the parallel `specs`.
 */
type FnArgHandles<
  specs extends readonly ArgSpec[],
  L extends readonly unknown[] = LabelCarrier<specs>,
> = {
  [i in keyof L]: i extends keyof specs ? Expr<Extract<specs[i]['type'], EvsType>> : never;
};

/**
 * The call-site signature of an {@link EvsFn}: each param as an {@link IntoExpr}, LABELED by its
 * surfaced name (a {@link namedArg} name, or the `arg{i}` fallback for a bare param — issue #9).
 * The labels come from the {@link LabelCarrier} type parameter `L`; the element types from `params`.
 */
export type EvsFn<
  params extends readonly ArgSpec[],
  r extends FnReturn,
  L extends readonly unknown[] = LabelCarrier<params>,
> = (
  ...args: {
    [i in keyof L]: i extends keyof params ? IntoExpr<Extract<params[i]['type'], EvsType>> : never;
  }
) => RebuildExprs<r>;

// ---------------------------------------------------------------------------
// the builder (api.md §4 — full surface)
// ---------------------------------------------------------------------------

export interface ScriptBuilder<
  // the script's DECLARED custom errors (issue #15): `s.throw` only accepts members of this
  // tuple, so throwing an undeclared error is a type error at the site. Wide default keeps
  // pre-#15 `ScriptBuilder` references compiling (and accepts any error, backstopped at
  // record time).
  errs extends readonly EvsErrorType[] = readonly EvsErrorType[],
> {
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

  // ABI encoding + hashing (issue #17, amended by #24; api.md §4.1). `keccak256` hashes the
  // STANDARD encoding — `keccak256(abi.encode(...))` — of any encodable values (a single
  // bytes/string value is hashed directly, Solidity's `keccak256(bytes)`); the non-standard
  // packed hash is the explicit composition s.keccak256(s.encodePacked(…)).
  encode(...values: [EncodeValue, ...EncodeValue[]]): Expr<'bytes'>;
  encodePacked(...values: [PackedValue, ...PackedValue[]]): Expr<'bytes'>;
  keccak256(...values: [EncodeValue, ...EncodeValue[]]): Expr<'bytes32'>;

  // control flow (combinators — api.md §7)
  if(cond: IntoExpr<'bool'>, then: () => void, otherwise?: () => void): void;
  while(cond: () => IntoExpr<'bool'>, body: (loop: LoopCtl) => void): void;
  // `range.type` is optional (issue #12): the first overload matches a type-less range and
  // types the counter as uint256; the explicit-type overload keeps the pre-#12 behaviour.
  for(
    range: {
      type?: undefined;
      from: IntoExpr<'uint256'>;
      until: IntoExpr<'uint256'>;
      step?: IntoExpr<'uint256'>;
    },
    body: (i: Expr<'uint256'>, loop: LoopCtl) => void,
  ): void;
  for<const t extends NumericType>(
    range: { type: t; from: IntoExpr<t>; until: IntoExpr<t>; step?: IntoExpr<t> },
    body: (i: Expr<t>, loop: LoopCtl) => void,
  ): void;
  // forEach over an array value (issue #12): the counter loop with `until` = the array's
  // length (snapshot ONCE) and `elem` = the bounds-checked `array.at(i)` — a `tuple[]` array
  // hands the body a `Tuple` element handle, a `tuple[][]` an `Expr<tuple[]>` element, a
  // string-element array an `Expr` of the element (the same {@link TupleArrayElemHandle}
  // dispatch as the `.at` augmentation; a plain `tuple` is a compile error, mirrored at record
  // time). Staged handles only: a MutArray iterates through its `.expr()` memref. The element
  // load is recorded only when the body declares `elem` (v0 has no DCE — an unconditional load
  // would execute its bounds check + reads every iteration for nothing).
  forEach<C extends TupleType & { readonly type: 'tuple[]' | 'tuple[][]' }>(
    array: Expr<C>,
    body: (elem: TupleArrayElemHandle<C>, i: Expr<'uint256'>, loop: LoopCtl) => void,
  ): void;
  forEach<a extends ArrayType>(
    array: Expr<a>,
    body: (elem: Expr<ArrayElemOf<a>>, i: Expr<'uint256'>, loop: LoopCtl) => void,
  ): void;
  select<t extends EvsType>(cond: IntoExpr<'bool'>, a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>;

  // calls (api.md §6) — SPLIT BY MUTABILITY (issue #1). Each verb carries the same three
  // struct-aware overloads (the `struct` opt-in from issue #5 ask #2), differing only in the
  // mutability bucket its `functionName`/arg/output handles are filtered by:
  //   read     / tryRead     → STATICCALL of view/pure          (the renamed frozen read surface)
  //   call     / tryCall     → CALL of nonpayable/payable        (non-static frame, NO rollback)
  //   simulate / trySimulate → CALL of nonpayable/payable        (write dry-run, state rolled back)
  read: ReadVerb;
  tryRead: TryReadVerb;
  call: WriteVerb;
  tryCall: TryWriteVerb;
  simulate: WriteVerb;
  trySimulate: TryWriteVerb;

  // functions (api.md §8) — `params` accepts the same shorthand as `evscript` args (issue #9): a
  // bare `t.*` type, a single `namedArg(...)`, or a `readonly` list mixing named/bare. Body params
  // are labeled by name; composite params stay a v0 deferral (rejected at record time).
  fn<const params extends ArgsInput, const r extends FnReturn>(
    name: string,
    params: params,
    body: (...args: FnArgHandles<NormalizeArgs<params>>) => r,
  ): EvsFn<NormalizeArgs<params>, r>;

  // custom errors (issue #15) — revert with `selector ‖ abi.encode(args)`. Only DECLARED
  // errors (the def's `errors: [...]`) are accepted; args are a required name-keyed record
  // (all params named), a positional tuple (any bare param), or absent (zero params).
  // Recording continues after a throw (it is usually conditional, inside s.if); statements
  // recorded after an UNCONDITIONAL throw in the same block are dead in the emitted program.
  throw<const e extends errs[number]>(error: e, ...args: ThrowArgs<e>): void;

  // return (api.md §9) — accepts an `Expr` OR a `Tuple` handle directly per component (the
  // `.expr()` on a tuple is optional; the bare handle returns the same memref).
  return<const ret extends Record<string, ReturnValue>>(values: ret): ScriptReturn<ret>;
}

// ---------------------------------------------------------------------------
// the facade (typed surface over the untyped Recorder engine)
// ---------------------------------------------------------------------------

function makeBuilder(r: Recorder): ScriptBuilder {
  // the six calling verbs (issue #1) — all route through the one recorder `subcall`, differing
  // in the call kind (frame/state semantics) and, for the try variants, the success/value wrap.
  type CallKind = 'static' | 'call' | 'simulate';
  const strictVerb = (kind: CallKind) => (p: unknown) => r.subcall(p, 'strict', kind).value;
  const tryVerb = (kind: CallKind) => (p: unknown) => {
    const res = r.subcall(p, 'try', kind);
    return Object.freeze({ success: res.success, value: res.value });
  };

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

    encode: (...values: unknown[]) => r.encodeOp('abi', values, 's.encode()'),
    encodePacked: (...values: unknown[]) => r.encodeOp('packed', values, 's.encodePacked()'),
    keccak256: (...values: unknown[]) => r.keccakOp(values, 's.keccak256()'),

    if: (cond: unknown, then: unknown, otherwise?: unknown) => {
      r.ifStmt(cond, then, otherwise);
    },
    while: (cond: unknown, body: unknown) => {
      r.whileStmt(cond, body);
    },
    for: (range: unknown, body: unknown) => {
      r.forStmt(range, body);
    },
    forEach: (array: unknown, body: unknown) => {
      r.forEachStmt(array, body);
    },
    select: (cond: unknown, a: unknown, b: unknown) => r.select(cond, a, b),

    read: strictVerb('static'),
    tryRead: tryVerb('static'),
    call: strictVerb('call'),
    tryCall: tryVerb('call'),
    simulate: strictVerb('simulate'),
    trySimulate: tryVerb('simulate'),

    fn: (name: unknown, params: unknown, body: unknown) => r.defineFn(name, params, body),

    throw: (error: unknown, ...args: unknown[]) => {
      r.throwStmt(error, args, 's.throw()');
    },

    return: (values: unknown) => r.ret(values),
  };
  // the facade implements the frozen api.md §4 surface; types are enforced at the surface,
  // the engine is dynamic
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return builder as unknown as ScriptBuilder;
}
