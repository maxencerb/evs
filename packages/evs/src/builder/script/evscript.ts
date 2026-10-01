/**
 * `builder/script/evscript.ts` — the entry point: `evscript` (records the callback, builds the
 * literal-typed ABI, wires `compile`), `EvsScript`, and the error-declaration and arg-handle
 * input types.
 */

import type { AbiParametersToPrimitiveTypes } from 'abitype';

import {
  type ScriptAbi,
  type ResolveArgName,
  PANIC_SELECTOR,
  ERROR_STRING_SELECTOR,
  EVS_DECODE_ERROR_SELECTOR,
  EVS_INVALID_CALLDATA_SELECTOR,
  errorSelectorOf,
  buildScriptAbi,
} from '../../abi/artifact.js';
import * as compileModule from '../../compile.js';
import type { CompileOptions, CompiledEvsScript } from '../../compile.js';
import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import {
  type ArgSpec,
  type EvsErrorType,
  type EvsType,
  type TupleType,
  IDENT_RE,
  isArgSpecValue,
  isEvsValueType,
  normalizeArgsInput,
  typeToAbiParam,
  type ArgsInput,
  type NormalizeArgs,
} from '../../core/types.js';
import type { Expr } from '../../core/types/expr.js';
import type { ScriptIr, PlainAbiError } from '../../ir/nodes.js';
import { type RecErrorDecl, Recorder } from '../expr.js';
import { type ScriptBuilder, makeBuilder } from './builder.js';
import type { ReturnValue, IntoMember, Tuple, ScriptReturn } from './handles.js';

// ---------------------------------------------------------------------------
// entry point
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
export type LabelCarrier<specs extends readonly ArgSpec[]> = AbiParametersToPrimitiveTypes<
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
  [PANIC_SELECTOR, 'Panic(uint256)'],
  [ERROR_STRING_SELECTOR, 'Error(string)'],
  [EVS_DECODE_ERROR_SELECTOR, 'EvsDecodeError(uint256)'],
  [EVS_INVALID_CALLDATA_SELECTOR, 'EvsInvalidCalldata()'],
]);

/** Normalizes + validates the def's `errors` list into recorder decls (issue #15): each entry
 *  must be a `t.error` value with evs param types; names and selectors must be unique (and
 *  selector-disjoint from the built-ins). */
function normalizeErrorDecls(scriptName: string, errorsIn: unknown): readonly RecErrorDecl[] {
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
      );
    }
    if (!IDENT_RE.test(e.name)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: invalid error name ${JSON.stringify(e.name)} (must be a non-empty identifier)`,
      );
    }
    if (seenNames.has(e.name)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: duplicate error name "${e.name}" — each declared error needs a distinct name (the client-side switch is keyed by name)`,
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
      );
    }
    const clash = seenSelectors.get(selector);
    if (clash !== undefined) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `${ctx}: error "${e.name}" has the same 4-byte selector (${selector}) as declared error "${clash}"`,
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
): EvsScript<name, NormalizeArgs<args>, ret, NormalizeErrors<errs>> {
  if (typeof def !== 'object' || def === null) {
    throw new EvsTypeError('TYPE_MISMATCH', `evscript: def must be { name, args? }`);
  }
  if (typeof def.name !== 'string' || !IDENT_RE.test(def.name)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `evscript: script name must be a non-empty identifier, got ${JSON.stringify(def.name)}`,
    );
  }
  if (typeof body !== 'function') {
    throw new EvsTypeError('TYPE_MISMATCH', `evscript "${def.name}": body must be a callback`);
  }
  // `args` is optional (a zero-arg script omits it) and a lone declarator stands for a one-element
  // list (issue #9); the normalizer is the one `s.fn` params and `t.error` params share. A
  // `namedArg` (or a named ABI parameter) carries its user name; a bare type is labeled `arg{i}`
  // (viem still infers args positionally, but the name surfaces as the label). Bad or duplicate
  // names stay `ABI_SHAPE` (`buildScriptAbi` re-checks them) but fail here, before the callback.
  const argSpecs = normalizeArgsInput(def.args, {
    owner: `evscript "${def.name}"`,
    noun: 'arg',
    nameCode: 'ABI_SHAPE',
  }).map((a) => ({ name: a.label, type: a.type }));

  // declared custom errors (issue #15): normalized + validated before recording starts, so a
  // bad declaration fails fast (and s.throw checks against the same decls).
  const errorDecls = normalizeErrorDecls(def.name, def.errors);
  // the script name must not also name an error of the artifact ABI (issue #63) — the
  // function entry would be shadowed for viem (buildScriptAbi re-checks; failing here keeps
  // the error at the def).
  if (
    def.name === 'EvsDecodeError' ||
    def.name === 'EvsInvalidCalldata' ||
    errorDecls.some((d) => d.ir.name === def.name)
  ) {
    throw new EvsTypeError(
      'ERROR_DECL',
      `evscript "${def.name}": script name "${def.name}" collides with the error "${def.name}" in its ABI (${def.name.startsWith('Evs') ? 'an evs runtime error every artifact carries' : 'a declared error'}) — viem would resolve the error entry instead of the function; rename the script or the error`,
    );
  }

  const recorder = new Recorder(def.name, argSpecs, errorDecls);
  const s = makeBuilder(recorder);
  // the engine yields Expr|Tuple handles positionally; the typed surface (ArgHandles) is
  // enforced at the call site (`as unknown as` — the recorder is intentionally untyped).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- recorder is dynamically typed; ArgHandles is enforced at the public surface
  const handles = recorder.argHandles() as unknown as ArgHandles<NormalizeArgs<args>>;
  const callbackResult: unknown = body(s, ...handles);
  const { ir, returns } = recorder.finish(callbackResult);
  // the runtime ABI array is the encode/decode source of truth; the literal type mirrors it.
  // `ir.args` carries each arg's resolved name (user `namedArg` name or the `arg{i}` fallback), so
  // the ABI inputs are labeled accordingly (issue #9).
  /* oxlint-disable typescript/no-unsafe-type-assertion -- runtime↔type agreement pinned by abi tests */
  const abi = buildScriptAbi(
    def.name,
    ir.args,
    returns,
    errorDecls.map((d) => d.ir),
  ) as unknown as ScriptAbi<name, NormalizeArgs<args>, ret, NormalizeErrors<errs>>;
  /* oxlint-enable typescript/no-unsafe-type-assertion */
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
      // namespace access keeps this tolerant of the compile module landing separately
      const compileFn: unknown = (compileModule as Record<string, unknown>)['compile'];
      if (typeof compileFn !== 'function') {
        throw new EvsInternalError(
          'INTERNAL',
          'compile() is not available — the evs compile module failed to load',
        );
      }
      // the `compile()` signature; the namespace-loaded compile is intentionally typed `unknown`.
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
