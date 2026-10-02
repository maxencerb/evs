/**
 * `builder/expr/calls.ts` — the recorder layer for the call verbs: `subcall` (every read / call /
 * simulate verb, strict and try) and overload resolution (`resolveOverload` / `argFits`, in
 * lockstep with the type-level `ResolveOverload` in `builder/script/calls.ts`).
 */

import type { AbiFunction } from 'viem';

import { toPlainAbiFunction } from '../../abi/artifact.js';
import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import { functionsByRef, signatureRefName, functionSignature } from '../../core/signature.js';
import {
  type Expr,
  abiParamToType,
  isEvsValueType,
  type EvsType,
  typesEqual,
  isTupleType,
  isArrayValueType,
  elemTypeOf,
  fixedLengthOf,
  isNumeric,
  repeatedMemberName,
  UNIQUE_MEMBER_NAMES,
  type TupleType,
} from '../../core/types.js';
import type { ValueId, PlainAbiParam, PlainAbiFunction } from '../../ir/nodes.js';
import { RecorderControl } from './control.js';
import {
  makeExpr,
  EXPR_INTERNALS,
  TUPLE_INTERNALS,
  ARR_INTERNALS,
  CELL_INTERNALS,
  FIELD_INTERNALS,
  makeTuple,
} from './handles.js';
import {
  unsafeCast,
  describeHost,
  describeRejectedHost,
  abiInputsOf,
  signatureList,
  isRecordObj,
  allMembersNamed,
  normalizeAbiParam,
  assertLayout,
  assertTupleGates,
} from './helpers.js';

type CallKind = 'static' | 'call' | 'simulate';

interface SubcallShape {
  readonly success: Expr | null;
  readonly value: unknown; // void | Expr | readonly Expr[]
}

/** Every key a call verb's params object may carry (`value` and `revertReturns` are further
 *  restricted per verb below). Anything else — a typo, or an option evs does not have — is a
 *  recording-time error rather than a silently ignored key. */
const SUBCALL_PARAM_KEYS: ReadonlySet<string> = new Set([
  'address',
  'abi',
  'functionName',
  'args',
  'gas',
  'value',
  'struct',
  'revertReturns',
]);

/** A call verb's params object, unvalidated: one object `subcall` hands to each helper that
 *  needs a key of it, so a new option is read next to the ones it sits with. Its keys are
 *  exactly {@link SUBCALL_PARAM_KEYS}. */
interface CallParams {
  readonly address?: unknown;
  readonly abi?: unknown;
  readonly functionName?: unknown;
  readonly args?: unknown;
  readonly gas?: unknown;
  readonly value?: unknown;
  readonly struct?: unknown;
  readonly revertReturns?: unknown;
}

/** Sub-calls and overload resolution (a `Recorder` layer). */
export abstract class RecorderCalls extends RecorderControl {
  // -- calls -------------------------------------------------------------------------------

  subcall(p: unknown, mode: 'strict' | 'try', kind: CallKind): SubcallShape {
    // verb name for error messages / debug names: static→read, call→call, simulate→simulate,
    // with a `try` prefix in try mode (s.read / s.tryRead / s.call / s.tryCall / s.simulate /
    // s.trySimulate).
    const verbBase = kind === 'static' ? 'read' : kind;
    const callerName =
      mode === 'try'
        ? `s.try${verbBase[0]?.toUpperCase() ?? ''}${verbBase.slice(1)}`
        : `s.${verbBase}`;
    const label = `${callerName}()`;
    this.assertOpen(label);
    const expected = `{ address, abi, functionName, args?, gas?${kind === 'static' ? '' : ', value?'}, struct?${kind === 'call' ? ', revertReturns?' : ''} }`;
    if (typeof p !== 'object' || p === null) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: expected ${expected}`);
    }
    for (const key of Object.keys(p)) {
      if (!SUBCALL_PARAM_KEYS.has(key)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${label}: unknown parameter \`${key}\` — expected ${expected}`,
        );
      }
    }
    const params = unsafeCast<CallParams>(p);
    if (params.value !== undefined && kind === 'static') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: \`value\` is not supported — STATICCALL cannot send ETH; call a payable function with s.call (a real CALL) or s.simulate (rolled back) instead`,
      );
    }
    if (params.struct !== undefined && typeof params.struct !== 'boolean') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: \`struct\` must be a boolean (omit it, or pass \`struct: true\` to decode named outputs into one Tuple)`,
      );
    }
    const wantStruct = params.struct === true;
    // revert-data-as-result (issue #35): an s.call / s.tryCall opt-in declaring the output types
    // carried by the target's REVERT payload (the QuoterV1 pattern). Validated before the ABI so a
    // misplaced option steers immediately.
    const revertReturns =
      params.revertReturns === undefined
        ? undefined
        : this.revertReturnTypes(params.revertReturns, kind, wantStruct, label);
    const abi = params.abi;
    if (!Array.isArray(abi)) {
      throw new EvsTypeError('ABI_SHAPE', `${label}: \`abi\` must be an ABI array`);
    }
    const fname = params.functionName;
    if (typeof fname !== 'string' || fname === '') {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${label}: \`functionName\` is required (got ${describeHost(fname)})`,
      );
    }
    const plain = this.selectAbiEntry(abi, fname, params, kind, label);
    // debug names use the entry's bare name, so a signature `functionName` records the same IR
    const fnTag = plain.name;
    if (params.address === undefined) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: \`address\` is required`);
    }
    const target = this.coerceToId(params.address, 'address', `${label} address`);
    const argIds = this.coerceCallArgs(plain, params.args, fname, label);
    // the call options are coerced here, beside the statement that records them
    const gasId =
      params.gas === undefined ? undefined : this.coerceToId(params.gas, 'uint256', `${label} gas`);
    const valueId =
      params.value === undefined
        ? undefined
        : this.coerceToId(params.value, 'uint256', `${label} value`);
    const outTypes = revertReturns ?? this.callOutputTypes(plain, label);
    const outs = outTypes.map((type, i) => {
      const tag =
        outTypes.length === 1 ? `${callerName}(${fnTag})` : `${callerName}(${fnTag})[${i}]`;
      return { type, id: this.newValue(type, tag) };
    });
    const outIds = outs.map((o) => o.id);
    const successId =
      mode === 'try' ? this.newValue('bool', `${callerName}(${fnTag}).success`) : undefined;
    this.appendStmt({
      k: 'call',
      target,
      fnAbi: plain,
      args: argIds,
      outs: outIds,
      mode,
      // omit `kind` when 'static' so STATICCALL IR stays byte-identical to the pre-issue-#1 shape
      ...(kind !== 'static' ? { kind } : {}),
      ...(successId !== undefined ? { successOut: successId } : {}),
      ...(gasId !== undefined ? { gas: gasId } : {}),
      ...(valueId !== undefined ? { value: valueId } : {}),
      ...(revertReturns !== undefined ? { revertReturns } : {}),
    });
    // opt-in (issue #5 ask #2): decode the (named) outputs into ONE Tuple by composing a
    // `tuplenew` over the already-decoded output ValueIds; the default is the positional shape.
    const value = wantStruct
      ? this.buildSubcallStruct(plain.outputs, outIds, callerName, fnTag)
      : this.wrapCallResult(outs);
    return { success: successId !== undefined ? makeExpr(this.self, successId) : null, value };
  }

  /**
   * The ONE ABI entry a call verb records: `functionName` (a bare name selects every overload of
   * that name; a canonical signature such as `'get(uint256)'`, issue #4, selects exactly one entry
   * and skips argument-based resolution), filtered by the verb's mutability bucket, then resolved
   * against `params.args` ({@link resolveOverload}) and validated into its IR form. It takes the
   * whole params object: a check that depends on the resolved entry belongs here.
   */
  private selectAbiEntry(
    abi: readonly unknown[],
    fname: string,
    params: CallParams,
    kind: CallKind,
    label: string,
  ): PlainAbiFunction {
    const { entries: named, bySignature } = functionsByRef(abi, fname);
    if (named.length === 0) {
      throw new EvsTypeError('ABI_SHAPE', this.noSuchFunction(label, abi, fname, bySignature));
    }
    // mutability filter, split by call kind (issue #1): STATICCALL admits view/pure; CALL
    // (s.call/s.simulate) admits nonpayable/payable. The wrong bucket gets a steering error.
    // Overloads outside the verb's bucket never compete in the resolution below.
    const allowedMuts: readonly string[] =
      kind === 'static' ? ['view', 'pure'] : ['nonpayable', 'payable'];
    const matching = named.filter((it) => allowedMuts.includes(String(it['stateMutability'])));
    if (matching.length === 0) {
      const muts = named
        .map((it) => {
          const m = it['stateMutability'];
          return typeof m === 'string' ? m : 'unspecified';
        })
        .join('/');
      const steer =
        kind === 'static'
          ? `${label} runs under STATICCALL and can only call view/pure functions — for a non-view target use s.call (plain CALL) or s.simulate (rolled-back write dry-run)`
          : `${label} runs under CALL and can only call nonpayable/payable functions — for a view/pure read use s.read`;
      throw new EvsTypeError('ABI_SHAPE', `${label}: function "${fname}" is ${muts}. ${steer}`);
    }
    const item =
      matching.length === 1
        ? matching[0]
        : this.resolveOverload(matching, params.args, label, fname);
    if (item === undefined || !Array.isArray(item['inputs']) || !Array.isArray(item['outputs'])) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${label}: ABI entry for "${fname}" is malformed (missing inputs/outputs arrays)`,
      );
    }
    // `value` (the wei the CALL sends) is for payable functions only: a nonpayable target reverts
    // on any value, so it is refused here, after overload resolution picked the entry.
    if (params.value !== undefined && item['stateMutability'] !== 'payable') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: \`value\` is only accepted for a payable function — "${fname}" is ${String(item['stateMutability'])} and would revert on any ETH sent`,
      );
    }
    // shape-checked above; toPlainAbiFunction validates the evs types, naming the parameter
    return toPlainAbiFunction(unsafeCast<AbiFunction>(item));
  }

  /** Coerces a call's `args` to the selected entry's input types (exact arity), in order. */
  private coerceCallArgs(
    fn: PlainAbiFunction,
    args: unknown,
    fname: string,
    label: string,
  ): ValueId[] {
    const rawArgs = args === undefined ? [] : args;
    if (!Array.isArray(rawArgs)) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: \`args\` must be an array`);
    }
    if (rawArgs.length !== fn.inputs.length) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: function "${fname}" expects ${fn.inputs.length} argument(s), got ${rawArgs.length}`,
      );
    }
    return fn.inputs.map((inp, i) => {
      // abiParamToType turns a `'tuple'` input (carrying components) into a TupleType — coerceToId
      // then routes through its tuple branch (a Tuple handle or a literal struct object).
      const ity = abiParamToType(inp);
      if (!isEvsValueType(ity)) {
        throw new EvsInternalError('INTERNAL', `${label}: unsupported input survived validation`);
      }
      const argLabel = inp.name === '' ? `args[${i}]` : `args[${i}] ("${inp.name}")`;
      return this.coerceToId(rawArgs[i], ity, `${label} ${argLabel}`);
    });
  }

  /** The types of a call's outputs, `abiParamToType(o)` each: a `'tuple'` output (head/tail in
   *  the returndata) is decoded into a freshly-allocated flat block (codegen/call.ts) and yields a
   *  Tuple handle on unwrap; scalars/arrays yield an Expr. (Under `revertReturns` the declared
   *  types replace these: the payload comes from the revert.) */
  private callOutputTypes(fn: PlainAbiFunction, label: string): readonly EvsType[] {
    return fn.outputs.map((o): EvsType => {
      const oty = abiParamToType(o);
      if (!isEvsValueType(oty)) {
        throw new EvsInternalError('INTERNAL', `${label}: unsupported output survived validation`);
      }
      return oty;
    });
  }

  /** The default (positional) result of a call verb: nothing for no output, the output's handle
   *  for one, a frozen array of handles for several. A tuple (NOT a tuple ARRAY) output is a Tuple
   *  handle; a composite array (`tuple[]`/`T[][]`/`string[]`) or any scalar/word array is an Expr
   *  (whose `.at(i)`/`.length()` yield the element/length handles — a `tuple[]` element `.at(i)`
   *  is a `Tuple` handle). */
  private wrapCallResult(outs: readonly { id: ValueId; type: EvsType }[]): unknown {
    const [only] = outs;
    if (only === undefined) return undefined;
    if (outs.length === 1) return this.valueHandle(only.id, only.type);
    return Object.freeze(outs.map((o) => this.valueHandle(o.id, o.type)));
  }

  /** The `ABI_SHAPE` message for a `functionName` that selects no ABI entry — for a signature
   *  reference, listing the signatures the name does have (a typo'd / non-canonical type). */
  private noSuchFunction(
    label: string,
    abi: readonly unknown[],
    fname: string,
    bySignature: boolean,
  ): string {
    if (!bySignature) return `${label}: the provided ABI has no function named "${fname}"`;
    const name = signatureRefName(fname);
    const known = functionsByRef(abi, name).entries.map(functionSignature);
    const have =
      known.length === 0
        ? `the ABI has no function named "${name}"`
        : `the ABI has ${known.join(', ')}`;
    return `${label}: the provided ABI has no function with signature "${fname}" (${have}) — a signature uses canonical types without names or spaces, tuples as (type,…), e.g. "transfer(address,uint256)"`;
  }

  /**
   * Overload resolution (issue #4): picks the ONE overload among `candidates` (same name, same
   * mutability bucket, 2+ entries) whose inputs accept `rawArgs`. Arity first; then per argument
   * {@link argFits} — a handle must carry exactly the input's type, a literal only needs the right
   * JS kind (value ranges and byte lengths are not considered, so `1n` fits every `uintN`). The
   * same rules drive the type-level `ResolveOverload`, so the statically inferred overload is the
   * one recorded. A single arity match is returned without checking the args (the regular
   * coercion then reports the precise mismatch); several fitting overloads are an `ABI_SHAPE`
   * ambiguity, none a `TYPE_MISMATCH`.
   */
  private resolveOverload(
    candidates: readonly Record<string, unknown>[],
    rawArgs: unknown,
    label: string,
    fname: string,
  ): Record<string, unknown> {
    // identical entries (an ABI listing the same function twice) are one function
    const unique = [...new Map(candidates.map((c) => [functionSignature(c), c] as const)).values()];
    const first = unique[0];
    if (unique.length === 1 && first !== undefined) return first;
    const args = rawArgs === undefined ? [] : rawArgs;
    if (!Array.isArray(args)) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: \`args\` must be an array`);
    }
    const byArity = unique.filter((fn) => abiInputsOf(fn).length === args.length);
    const only = byArity[0];
    if (byArity.length === 1 && only !== undefined) return only;
    if (byArity.length === 0) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: no overload of "${fname}" takes ${args.length} argument(s) (overloads: ${signatureList(unique)})`,
      );
    }
    const fitting = byArity.filter((fn) =>
      abiInputsOf(fn).every((inp, i) => {
        if (!isRecordObj(inp) || typeof inp['type'] !== 'string') return false;
        // raw input: normalize absent member names (parseAbi) to `''` before reading the rule
        return this.argFits(args[i], abiParamToType(normalizeAbiParam(inp)));
      }),
    );
    const picked = fitting[0];
    if (fitting.length === 1 && picked !== undefined) return picked;
    // two or more arity matches remain here (zero and one returned above)
    const example = picked ?? only;
    if (example === undefined) {
      throw new EvsInternalError('INTERNAL', `${label}: overload resolution lost its candidates`);
    }
    const hint = `pass typed values (an Expr, or s.lit(t.uint8, 1) for a literal) or name the overload by signature (functionName: "${functionSignature(example)}")`;
    if (fitting.length === 0) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: the args match none of the overloads of "${fname}" taking ${args.length} argument(s): ${signatureList(byArity)} — ${hint}`,
      );
    }
    throw new EvsTypeError(
      'ABI_SHAPE',
      `${label}: call to overloaded function "${fname}" is ambiguous — the args fit ${signatureList(fitting)}; ${hint}`,
    );
  }

  /**
   * Whether `v` can stand for a value of `type` in overload resolution (never records anything).
   * A handle (Expr / Tuple / MutArray) fits iff its type equals `type`; a Cell/Field never fits.
   * A literal fits by JS kind: bool ← boolean; (u)intN ← number | bigint; address/bytesN/bytes ←
   * a `0x` string; string ← any string; an array type ← a JS array whose elements all fit (a
   * fixed `T[N]` ← exactly N of them); a tuple ← a record keyed by member name when every member
   * is named, else a positional array (abitype's rule), whose members (own properties) all fit —
   * and nothing more: a key that names no member, or an element past the last member, is a misfit
   * (the coercion, `buildTupleNew`, rejects it). `type` must come from {@link normalizeAbiParam} (a
   * `parseAbi` member with no `name` key is unnamed, and a handle's type compares against `''`
   * names). The type-level twin is `FitsArg` (builder/script/calls.ts) — keep the two in lockstep
   * (the overload-lockstep tests pin every shape on both sides).
   */
  private argFits(v: unknown, type: EvsType): boolean {
    if (typeof v === 'object' && v !== null) {
      const ei = EXPR_INTERNALS.get(v);
      if (ei !== undefined) return typesEqual(ei.owner.typeOfValue(ei.id), type);
      const ti = TUPLE_INTERNALS.get(v);
      if (ti !== undefined) return typesEqual(ti.tt, type);
      const ai = ARR_INTERNALS.get(v);
      if (ai !== undefined) return typesEqual(ai.owner.typeOfValue(ai.id), type);
      if (CELL_INTERNALS.has(v) || FIELD_INTERNALS.has(v)) return false;
    }
    if (isTupleType(type) && type.type === 'tuple') {
      if (typeof v !== 'object' || v === null) return false;
      const named = allMembersNamed(type);
      if (Array.isArray(v) === named) return false; // a record iff all named, else an array
      // no key naming no member, no element past the last one
      if (named) {
        const names = new Set(type.components.map((c) => c.name));
        if (Object.keys(v).some((key) => !names.has(key))) return false;
      } else if (Array.isArray(v) && v.length !== type.components.length) {
        return false;
      }
      return type.components.every((c, i) => {
        const key = named ? c.name : i;
        const member: unknown = Object.hasOwn(v, key) ? Reflect.get(v, key) : undefined;
        return member !== undefined && this.argFits(member, abiParamToType(c));
      });
    }
    if (isArrayValueType(type)) {
      if (!Array.isArray(v)) return false;
      // a fixed `T[N]` takes exactly N elements (the coercion would reject any other length)
      const fixed = fixedLengthOf(type);
      if (fixed !== null && v.length !== fixed) return false;
      const elem = elemTypeOf(type);
      return v.every((el: unknown) => this.argFits(el, elem));
    }
    if (typeof type !== 'string') return false;
    if (type === 'bool') return typeof v === 'boolean';
    if (type === 'string') return typeof v === 'string';
    if (type === 'address' || type.startsWith('bytes')) {
      return typeof v === 'string' && v.startsWith('0x');
    }
    if (isNumeric(type)) return typeof v === 'number' || typeof v === 'bigint';
    return false;
  }

  /**
   * Validates the `revertReturns` option (issue #35): `s.call` / `s.tryCall` only, never combined
   * with `struct: true` (revert-decoded outputs carry no names — declare one `t.struct` type
   * instead), and every entry a supported value type (the same vocabulary as ABI outputs, so an
   * unsupported shape gets the same classification `layoutOfType` gives it).
   */
  private revertReturnTypes(
    raw: unknown,
    kind: CallKind,
    wantStruct: boolean,
    label: string,
  ): readonly EvsType[] {
    if (kind !== 'call') {
      const steer =
        kind === 'static'
          ? 'a view/pure read never carries its result in revert data'
          : 'the simulate trampoline frames the target revert itself (bubbled / success=false)';
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: \`revertReturns\` is only supported on s.call / s.tryCall (decode a QuoterV1-style target's REVERT payload as the result) — ${steer}`,
      );
    }
    if (wantStruct) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: \`struct: true\` cannot be combined with \`revertReturns\` (revert-decoded outputs are unnamed) — declare a single \`t.struct(...)\` type in \`revertReturns\` instead`,
      );
    }
    if (!Array.isArray(raw)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: \`revertReturns\` must be an array of types (e.g. \`[t.uint256]\`), got ${describeHost(raw)}`,
      );
    }
    const types = raw.map((ty, i): EvsType => {
      const what = `${label} revertReturns[${i}]`;
      if (!isEvsValueType(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: expected a type (use the \`t\` namespace — t.uint256, t.string, t.struct(...)), got ${describeRejectedHost(ty)}`,
        );
      }
      assertTupleGates(ty, what);
      assertLayout(ty, what);
      return ty;
    });
    return Object.freeze(types);
  }

  /** `s.read({ …, struct: true })` (issue #5 ask #2): compose ONE Tuple from a call's outputs by
   *  emitting a `tuplenew` over the already-decoded output ValueIds. Requires every output to be
   *  named (an unnamed member would degrade viem's object inference to a positional array) and
   *  the names to be distinct (viem's decoded object keeps one value per name). The struct type
   *  is in ABI declaration order, so it round-trips with `t.fromOutputs(abi, name)`. */
  private buildSubcallStruct(
    outputs: readonly PlainAbiParam[],
    outIds: readonly ValueId[],
    callerName: string,
    fname: string,
  ): object {
    if (outputs.length === 0) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${callerName}({ struct: true }): function "${fname}" has no outputs to build a struct from`,
      );
    }
    outputs.forEach((o, i) => {
      if (o.name === '') {
        throw new EvsTypeError(
          'ABI_SHAPE',
          `${callerName}({ struct: true }): output #${i} of "${fname}" is unnamed — every output must be named to decode into a named Tuple (an unnamed member degrades viem's object inference to a positional array); use the default positional result instead`,
        );
      }
    });
    const repeated = repeatedMemberName(outputs.map((o) => o.name));
    if (repeated !== undefined) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${callerName}({ struct: true }): output #${repeated.repeat} of "${fname}" repeats the name ${JSON.stringify(repeated.name)} (also output #${repeated.first}) — ${UNIQUE_MEMBER_NAMES}; use the default positional result instead`,
      );
    }
    const structType: TupleType = Object.freeze({ type: 'tuple', components: outputs });
    const inits = outIds.map((id, i) => ({ index: i, value: id }));
    const structId = this.newValue(structType, `${callerName}(${fname}) struct`);
    this.appendStmt({ k: 'tuplenew', inits, out: structId });
    return makeTuple(this.self, structId, structType);
  }
}
