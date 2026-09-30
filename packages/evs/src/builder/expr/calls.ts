/**
 * `builder/expr/calls.ts` — the recorder layer for the call verbs: `subcall` (every read / call /
 * simulate verb, strict and try) and overload resolution (`resolveOverload` / `argFits`, in
 * lockstep with the type-level `ResolveOverload` in `builder/script/calls.ts`).
 */

import type { AbiFunction } from 'abitype';

import { toPlainAbiFunction } from '../../abi/artifact.js';
import { layoutOfType } from '../../abi/layout.js';
import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import { functionsByRef, signatureRefName, functionSignature } from '../../core/signature.js';
import {
  type Expr,
  abiParamToType,
  isEvsValueType,
  type EvsType,
  type NamedType,
  typesEqual,
  isTupleType,
  isArrayValueType,
  elemTypeOf,
  fixedLengthOf,
  isNumeric,
  type TupleType,
} from '../../core/types.js';
import type { ValueId, PlainAbiParam } from '../../ir/nodes.js';
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
import { unsafeCast, describeHost, abiInputsOf, signatureList, isRecordObj } from './helpers.js';

interface SubcallShape {
  readonly success: Expr | null;
  readonly value: unknown; // void | Expr | readonly Expr[]
}

/** Sub-calls and overload resolution (a `Recorder` layer). */
export abstract class RecorderCalls extends RecorderControl {
  // -- calls -------------------------------------------------------------------------------

  subcall(p: unknown, mode: 'strict' | 'try', kind: 'static' | 'call' | 'simulate'): SubcallShape {
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
    if (typeof p !== 'object' || p === null) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: expected { address, abi, functionName, args?, gas?, struct?${kind === 'call' ? ', revertReturns?' : ''} }`,
      );
    }
    const params = unsafeCast<{
      address?: unknown;
      abi?: unknown;
      functionName?: unknown;
      args?: unknown;
      gas?: unknown;
      struct?: unknown;
      revertReturns?: unknown;
    }>(p);
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
    // a bare name selects every overload of that name; a canonical signature (`'get(uint256)'`,
    // issue #4) selects exactly one entry and skips argument-based resolution.
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
    // shape-checked above; toPlainAbiFunction validates the evs types, naming the parameter
    const plain = toPlainAbiFunction(unsafeCast<AbiFunction>(item));
    // debug names use the entry's bare name, so a signature `functionName` records the same IR
    const fnTag = plain.name;
    if (params.address === undefined) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: \`address\` is required`);
    }
    const target = this.coerceToId(params.address, 'address', `${label} address`);
    const rawArgs = params.args === undefined ? [] : params.args;
    if (!Array.isArray(rawArgs)) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: \`args\` must be an array`);
    }
    if (rawArgs.length !== plain.inputs.length) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: function "${fname}" expects ${plain.inputs.length} argument(s), got ${rawArgs.length}`,
      );
    }
    const argIds = plain.inputs.map((inp, i) => {
      // abiParamToType turns a `'tuple'` input (carrying components) into a TupleType — coerceToId
      // then routes through its tuple branch (a Tuple handle or a literal struct object).
      const ity = abiParamToType(inp);
      if (!isEvsValueType(ity)) {
        throw new EvsInternalError('INTERNAL', `${label}: unsupported input survived validation`);
      }
      const argLabel = inp.name === '' ? `args[${i}]` : `args[${i}] ("${inp.name}")`;
      return this.coerceToId(rawArgs[i], ity, `${label} ${argLabel}`);
    });
    const gasId =
      params.gas === undefined ? undefined : this.coerceToId(params.gas, 'uint256', `${label} gas`);
    // each out value's type is `abiParamToType(o)` — a `'tuple'` output (head/tail in the
    // returndata) is decoded into a freshly-allocated flat block (codegen/call.ts) and yields a
    // Tuple handle on unwrap; scalars/arrays yield an Expr. Under `revertReturns` the declared
    // types ARE the outputs (the ABI outputs are ignored — the payload comes from the revert).
    const outTypes: readonly EvsType[] =
      revertReturns ??
      plain.outputs.map((o): EvsType => {
        const oty = abiParamToType(o);
        if (!isEvsValueType(oty)) {
          throw new EvsInternalError(
            'INTERNAL',
            `${label}: unsupported output survived validation`,
          );
        }
        return oty;
      });
    const outIds = outTypes.map((oty, i) => {
      const tag =
        outTypes.length === 1 ? `${callerName}(${fnTag})` : `${callerName}(${fnTag})[${i}]`;
      return this.newValue(oty, tag);
    });
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
      ...(revertReturns !== undefined ? { revertReturns } : {}),
    });
    // unwrap a tuple (NOT a tuple ARRAY) out ValueId to a Tuple handle; a composite array
    // (`tuple[]`/`T[][]`/`string[]`) or any scalar/word-array → an Expr (its `.at(i)`/`.length()`
    // yield the element/length handles — a `tuple[]` element `.at(i)` is a `Tuple` handle).
    const handleFor = (id: ValueId, oty: EvsType): Expr | object => this.valueHandle(id, oty);
    let value: unknown;
    if (wantStruct) {
      // opt-in (issue #5 ask #2): decode the (named) outputs into ONE Tuple by composing a
      // `tuplenew` over the already-decoded output ValueIds — the default positional `[many]`
      // shape (above) is unchanged.
      value = this.buildSubcallStruct(plain.outputs, outIds, callerName, fnTag);
    } else {
      const first = outIds[0];
      const firstType = outTypes[0];
      value =
        outIds.length === 0
          ? undefined
          : outIds.length === 1 && first !== undefined && firstType !== undefined
            ? handleFor(first, firstType)
            : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- outTypes is parallel to outIds (same length); the index is always in range
              Object.freeze(outIds.map((id, i) => handleFor(id, outTypes[i] as EvsType)));
    }
    return { success: successId !== undefined ? makeExpr(this.self, successId) : null, value };
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
        return this.argFits(args[i], abiParamToType(unsafeCast<NamedType>(inp)));
      }),
    );
    const picked = fitting[0];
    if (fitting.length === 1 && picked !== undefined) return picked;
    const hint = `pass typed values (an Expr, or s.lit(t.uint8, 1) for a literal) or name the overload by signature (functionName: "${functionSignature(fitting[0] ?? only ?? first ?? {})}")`;
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
   * fixed `T[N]` ← exactly N of them); a tuple ← a record keyed by member name (a positional
   * array/record for an unnamed tuple) whose members all fit. The type-level twin is `FitsArg`
   * (builder/script/calls.ts) — keep the two in lockstep (the overload-lockstep tests pin every
   * shape on both sides).
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
      const positional = type.components.every((c) => c.name === '');
      if (Array.isArray(v) && !positional) return false;
      const rec = unsafeCast<Record<string, unknown>>(v);
      return type.components.every((c, i) => {
        const member = positional ? rec[i] : rec[c.name];
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
    kind: 'static' | 'call' | 'simulate',
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
          `${what}: expected a type (use the \`t\` namespace — t.uint256, t.string, t.struct(...)), got ${describeHost(ty)}`,
        );
      }
      if (isTupleType(ty) && ty.components.length === 0) {
        throw new EvsTypeError('ABI_SHAPE', `${what}: tuple type carries no components`);
      }
      try {
        layoutOfType(ty);
      } catch (e) {
        if (e instanceof EvsTypeError) {
          throw new EvsTypeError(e.code, `${what}: ${e.message.replace(/^layoutOf(Type)?: /, '')}`);
        }
        throw e;
      }
      return ty;
    });
    return Object.freeze(types);
  }

  /** `s.read({ …, struct: true })` (issue #5 ask #2): compose ONE Tuple from a call's outputs by
   *  emitting a `tuplenew` over the already-decoded output ValueIds. Requires every output to be
   *  named (an unnamed member would degrade viem's object inference to a positional array). The
   *  struct type is in ABI declaration order, so it round-trips with `t.fromOutputs(abi, name)`. */
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
    const structType: TupleType = Object.freeze({ type: 'tuple', components: outputs });
    const inits = outIds.map((id, i) => ({ index: i, value: id }));
    const structId = this.newValue(structType, `${callerName}(${fname}) struct`);
    this.appendStmt({ k: 'tuplenew', inits, out: structId });
    return makeTuple(this.self, structId, structType);
  }
}
