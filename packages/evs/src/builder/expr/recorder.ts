/**
 * `builder/expr/recorder.ts` — `Recorder`, the recording engine's final layer: user functions
 * (`s.fn` definitions and calls), `s.return`, and `finish` (seals the script into its IR).
 */

import { EvsTypeError, EvsScopeError, EvsInternalError } from '../../core/errors.js';
import {
  IDENT_RE,
  PROTO_RESERVED,
  hasPlainPrototype,
  identProblem,
  normalizeArgsInput,
  type Expr,
  type EvsType,
} from '../../core/types.js';
import { type ValueId, type FnId, type ScriptIr, type FnIr, deepFreeze } from '../../ir/nodes.js';
import { RecorderCalls } from './calls.js';
import { RETURN_BRAND } from './handles.js';
import { describeHost, newScope, unsafeCast } from './helpers.js';

/** A plain (non-array) object: the literal of a struct. */
function isStructLiteral(x: unknown): boolean {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * The fix for a literal passed to `s.return`. `s.lit` types any value whose type is a plain
 * string (words, `string`, `uint256[][]`, `string[]`), but a struct has no string type, so a
 * struct literal goes through `s.tuple` and an array of struct literals through `s.newArray` or
 * a typed member slot.
 */
function returnLiteralFix(v: unknown): string {
  if (Array.isArray(v) && v.some(isStructLiteral)) {
    return 'build a struct array (tuple[]) with s.newArray(type, n), or type the literal through a member of s.tuple(t.struct({ … }), { … })';
  }
  if (isStructLiteral(v)) return 'build a struct with s.tuple(type, value)';
  return 'type a literal with s.lit(type, value)';
}

/** The recording engine behind one `evscript` body; the layers it extends are listed on the
 *  `builder/expr.ts` barrel. */
export class Recorder extends RecorderCalls {
  /** The name of an `s.fn` whose recording failed after an `s.fn` nested in its body was
   *  recorded: the nested definition holds a later FnId, so the failed slot cannot be rolled back
   *  and `finish()` refuses the script. `null` while every failed `s.fn` was rolled back. */
  private unrecoverableFn: string | null = null;

  // -- user functions ----------------------------------------------------------------------

  defineFn(name: unknown, paramsIn: unknown, bodyFn: unknown): (...args: unknown[]) => unknown {
    this.assertOpen('s.fn()');
    if (typeof name !== 'string' || !IDENT_RE.test(name)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.fn(): invalid name ${describeHost(name)}: ${identProblem(name)}`,
      );
    }
    if (typeof bodyFn !== 'function') {
      throw new EvsTypeError('TYPE_MISMATCH', `s.fn("${name}"): body must be a callback`);
    }
    // params take the same declarators as `evscript` args (issue #9), through the same normalizer:
    // a bare `t.*` type (the positional `arg{i}` name), a `namedArg(...)` or a named ABI parameter,
    // alone or in a `readonly` list. Composite (tuple) params are accepted exactly like script
    // args: a composite value is a memref pointer word at runtime, the same as a `string` / `T[]`
    // param, so the caller MSTOREs the pointer into the callee's param slot.
    const params = normalizeArgsInput(paramsIn, {
      owner: `s.fn("${name}")`,
      noun: 'param',
      nameCode: 'TYPE_MISMATCH',
    }).map((p) => ({ name: p.label, type: p.type }));

    // reserve the FnId, push the isolated stack (scope rule) and record the body once. A failed
    // recording (the body or a result check throws) releases the reservation, so a script that
    // catches the error and carries on still finishes; the failed body's statements were only
    // ever in its own scope and are dropped with it.
    const fnId = this.fnIrs.length;
    this.fnIrs.push(null);
    this.openFns.add(fnId);
    const fnScope = newScope('fn-body');
    this.savedStacks.push(this.stack);
    this.stack = [fnScope];
    this.fnCtx.push({ name });
    let resultIds: ValueId[];
    let shape: 'void' | 'single' | 'tuple';
    try {
      const paramEntries = params.map((p) => {
        const id = this.newValue(p.type, `${name}(${p.name})`);
        return { name: p.name, type: p.type, value: id };
      });
      // the same handle dispatch as script args (`valueHandle`): a plain tuple/struct param → a
      // Tuple handle (named field access in the body); a composite ARRAY / scalar → an Expr.
      const handles = paramEntries.map((p) => this.valueHandle(p.value, p.type));
      const r: unknown = unsafeCast<(...a: unknown[]) => unknown>(bodyFn)(...handles);
      // results must be validated while the fn stack is still active
      if (r === undefined) {
        shape = 'void';
        resultIds = [];
      } else if (Array.isArray(r)) {
        shape = 'tuple';
        resultIds = r.map((el, i) => this.requireFnResult(el, name, i));
      } else {
        shape = 'single';
        resultIds = [this.requireFnResult(r, name, null)];
      }
      this.fnIrs[fnId] = {
        name,
        params: paramEntries,
        results: resultIds.map((id) => ({ type: this.typeOfValue(id) })),
        body: fnScope.stmts,
        resultValues: resultIds,
      };
    } catch (e) {
      // nothing can reference the reserved FnId (its handle is returned only on success), so the
      // slot is truncated away — unless an `s.fn` nested in the failed body took a later FnId,
      // whose handle may have escaped through a closure.
      if (this.fnIrs.length === fnId + 1) this.fnIrs.length = fnId;
      else this.unrecoverableFn ??= name;
      throw e;
    } finally {
      const saved = this.savedStacks.pop();
      if (saved !== undefined) this.stack = saved;
      this.fnCtx.pop();
      this.openFns.delete(fnId);
    }
    return (...callArgs: unknown[]) => this.fnCall(fnId, name, shape, callArgs);
  }

  private requireFnResult(v: unknown, fnName: string, index: number | null): ValueId {
    const what =
      index === null ? `s.fn("${fnName}") result` : `s.fn("${fnName}") result [${index}]`;
    // a Tuple / MutArray handle is returnable from a fn body DIRECTLY (composite/array result —
    // issue #5 ask #1): return its ValueId verbatim (byte-identical to `.expr()`) after owner +
    // visibility checks. The fncall result is a single pointer word, so the IR/codegen/validate
    // layers carry it unchanged. classify() (below) still rejects these handles on the arithmetic
    // paths with the "use .expr()" message.
    const bare = this.bareHandleId(v, what);
    if (bare !== null) return bare;
    const c = this.classify(v, what);
    if (c.kind !== 'expr') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: fn bodies must return an Expr, a Tuple, a MutArray, a readonly array of those, or void — got ${describeHost(v)}`,
      );
    }
    return c.id;
  }

  private fnCall(
    fnId: FnId,
    name: string,
    shape: 'void' | 'single' | 'tuple',
    callArgs: readonly unknown[],
  ): unknown {
    this.assertOpen(`fn "${name}"()`);
    if (this.openFns.has(fnId)) {
      // defensive: unconstructible (the handle does not exist inside its own body), but checked
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `fn "${name}" cannot call itself — recursion is not supported in evs scripts`,
      );
    }
    const fn = this.fnIrs[fnId];
    if (fn === null || fn === undefined) {
      throw new EvsInternalError('INTERNAL', `fn "${name}" (FnId ${fnId}) was never recorded`);
    }
    if (callArgs.length !== fn.params.length) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `fn "${name}" expects ${fn.params.length} argument(s), got ${callArgs.length}`,
      );
    }
    const argIds = fn.params.map((p, i) =>
      this.coerceToId(callArgs[i], p.type, `fn "${name}" arg ${i} ("${p.name}")`),
    );
    const outIds = fn.results.map((r, i) => {
      const tag = fn.results.length === 1 ? `${name}(…)` : `${name}(…)[${i}]`;
      return this.newValue(r.type, tag);
    });
    this.appendStmt({ k: 'fncall', fn: fnId, args: argIds, outs: outIds });
    if (shape === 'void') return undefined;
    // wrap each result by its recorded type (issue #5 ask #1): a plain `tuple` result → a Tuple
    // handle (so named field access works at the call site, like `s.call`); a composite array
    // (`tuple[]`) or any scalar/word-array → an Expr. Mirrors `subcall`'s `handleFor`.
    const wrap = (id: ValueId): Expr | object => this.valueHandle(id, this.typeOfValue(id));
    const first = outIds[0];
    if (shape === 'single' && first !== undefined) return wrap(first);
    return Object.freeze(outIds.map((id) => wrap(id)));
  }

  // -- return + sealing ----------------------------------------------------------------------

  ret(values: unknown): object {
    this.assertOpen('s.return()');
    if (this.savedStacks.length > 0) {
      const fn = this.fnCtx[this.fnCtx.length - 1];
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `s.return() cannot be recorded inside an s.fn body${fn === undefined ? '' : ` (fn "${fn.name}")`} — return values from the fn callback instead`,
      );
    }
    if (this.stack.length !== 1) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `s.return() must run exactly once, unconditionally, at the top level of the script — it cannot be recorded inside a ${this.top().kind} block`,
      );
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.return(): expected a record of named Exprs, got ${describeHost(values)}`,
      );
    }
    // a literal `{ __proto__: handle }` key replaced the record's prototype (Object.entries below
    // would never see it); a primitive value is dropped by JS and caught only by `NoProtoKey`.
    if (!hasPlainPrototype(values)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `s.return(): expected a plain object literal of named values, but the record's prototype was replaced — an object-literal \`__proto__\` key does that instead of naming a return value. ${PROTO_RESERVED}`,
      );
    }
    // an empty record would emit a zero-component result tuple: it ABI-encodes to 0 bytes, so every
    // read returns 0x and viem throws "returned no data" (easily misread as "no contract here").
    if (Object.keys(values).length === 0) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `s.return(): the return record must name at least one value — an empty record ABI-encodes to 0x, which viem rejects as "returned no data". For a guard-only script (one that just reverts or succeeds) return a flag instead, e.g. s.return({ ok: s.lit(t.bool, true) })`,
      );
    }
    const returns: { name: string; type: EvsType; value: ValueId }[] = [];
    for (const [key, v] of Object.entries(values)) {
      if (key === '') {
        throw new EvsTypeError(
          'ABI_SHAPE',
          `s.return(): empty-string return keys are rejected — every component must be named or viem degrades the result object to a positional array`,
        );
      }
      if (!IDENT_RE.test(key)) {
        throw new EvsTypeError(
          'ABI_SHAPE',
          `s.return(): invalid return key ${JSON.stringify(key)}: ${identProblem(key)}`,
        );
      }
      // a Tuple / MutArray handle is returnable DIRECTLY (no `.expr()` needed): the bare handle IS
      // the memref, so we return its ValueId verbatim — byte-identical to `handle.expr()`.
      // classify() (below) still rejects these handles on the arithmetic paths with the targeted
      // "use .expr()" message (issue #5 asks #5 / #2's bare-Tuple precedent).
      const bare = this.bareHandleId(v, `s.return() value "${key}"`);
      if (bare !== null) {
        returns.push({ name: key, type: this.typeOfValue(bare), value: bare });
        continue;
      }
      const c = this.classify(v, `s.return() value "${key}"`);
      if (c.kind !== 'expr') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.return() value "${key}": must be an Expr, Tuple or MutArray handle — s.return infers the return ABI from handles, so a literal has no type here: ${returnLiteralFix(v)}`,
        );
      }
      returns.push({ name: key, type: c.type, value: c.id });
    }
    this.returnsList = returns;
    this.sealed = true; // the recorder seals on s.return
    const token = Object.freeze({ [RETURN_BRAND]: values });
    this.returnToken = token;
    return token;
  }

  finish(callbackResult: unknown): {
    ir: ScriptIr;
    returns: readonly { name: string; type: EvsType; value: ValueId }[];
  } {
    if (!this.sealed || this.returnsList === null || this.returnToken === null) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `script "${this.name}": the builder callback completed without calling s.return({...})`,
      );
    }
    if (callbackResult !== this.returnToken) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `script "${this.name}": the builder callback must return the value produced by THIS script's s.return({...})`,
      );
    }
    if (this.unrecoverableFn !== null) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `script "${this.name}": s.fn("${this.unrecoverableFn}") failed to record after an s.fn nested in its body was defined — the script cannot be finished; fix the error instead of catching it`,
      );
    }
    const fns: FnIr[] = this.fnIrs.map((f, i) => {
      if (f === null) {
        throw new EvsInternalError('INTERNAL', `fn slot ${i} was never filled in "${this.name}"`);
      }
      return f;
    });
    const ir: ScriptIr = {
      irVersion: 1,
      name: this.name,
      args: this.argsList.map((a) => ({ name: a.name, type: a.type })),
      values: this.values,
      cells: this.cellInfos,
      fns,
      body: this.mainScope.stmts,
      returns: this.returnsList,
      // omitted when no error is declared — pre-#15 scripts serialize byte-identically
      ...(this.errorDecls.length === 0 ? {} : { errors: this.errorDecls.map((d) => d.ir) }),
    };
    deepFreeze(ir);
    return { ir, returns: this.returnsList };
  }
}
