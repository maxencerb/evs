/**
 * `builder/expr/control.ts` — the recorder layer for control flow: `s.throw` (declared custom
 * errors), `s.if`, and the loops (`s.while`, `s.for`, `s.forEach`).
 */
/* oxlint-disable unicorn/no-thenable --
 * the IR schema names the if-statement branch field `then`. */

import { EvsTypeError } from '../../core/errors.js';
import {
  isEvsValueType,
  typesEqual,
  type StringType,
  isNumeric,
  stringifyType,
  type Expr,
  isArrayValueType,
  elemTypeOf,
} from '../../core/types.js';
import type { ValueId, CellId } from '../../ir/nodes.js';
import type { RecErrorDecl } from './core.js';
import { LoopCtlImpl, makeExpr } from './handles.js';
import { isRecordObj, describeHost, unsafeCast, type Scope, assertV0Type } from './helpers.js';
import { RecorderOps } from './ops.js';

/** `s.throw`, `if` and the loops (a `Recorder` layer). */
export abstract class RecorderControl extends RecorderOps {
  // -- custom errors (issue #15) ----------------------------------------------------------

  /**
   * `s.throw(error, args?)`: records a `throw` stmt reverting with `selector ‖ abi.encode(args)`.
   * The error must be DECLARED on the script def (`errors: [...]`) — the typed surface enforces
   * it statically; this is the record-time backstop for untyped callers. Args are a name-keyed
   * record when every param is named, a positional tuple otherwise, and absent for a
   * zero-param error; each member takes the param type's usual coercions (literal / Expr /
   * Tuple / MutArray handle).
   */
  throwStmt(error: unknown, argsIn: readonly unknown[], what: string): void {
    this.assertOpen(what);
    const decl = this.findErrorDecl(error, what);
    const index = this.errorDecls.indexOf(decl);
    const n = decl.params.length;
    let ids: ValueId[] = [];
    if (n === 0) {
      if (argsIn.length > 0 && argsIn[0] !== undefined) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: error "${decl.ir.name}" declares no parameters — throw it without args`,
        );
      }
    } else if (decl.params.every((p) => p.name !== '')) {
      // fully-named params → ONE name-keyed record (mirrors the s.tuple init shape, but every
      // member is REQUIRED — Solidity has no zero-defaulting on error args)
      const a = argsIn[0];
      if (!isRecordObj(a) || Array.isArray(a)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: error "${decl.ir.name}" takes a named args record — s.throw(${decl.ir.name}, { ${decl.params.map((p) => p.name).join(', ')} })`,
        );
      }
      const known = new Set(decl.params.map((p) => p.name));
      for (const key of Object.keys(a)) {
        if (!known.has(key)) {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${what}: unknown arg ${JSON.stringify(key)} for error "${decl.ir.name}" (expected: ${[...known].join(', ')})`,
          );
        }
      }
      ids = decl.params.map((p) => {
        if (!Object.hasOwn(a, p.name)) {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${what}: missing arg "${p.name}" for error "${decl.ir.name}" — every declared param is required`,
          );
        }
        return this.coerceToId(a[p.name], p.type, `${what} arg "${p.name}"`);
      });
    } else {
      // any bare (unnamed) param → ONE positional tuple
      const a = argsIn[0];
      if (!Array.isArray(a)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: error "${decl.ir.name}" takes a positional args tuple of ${n} value(s)`,
        );
      }
      if (a.length !== n) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: error "${decl.ir.name}" expects ${n} arg(s), got ${a.length}`,
        );
      }
      ids = decl.params.map((p, i) =>
        this.coerceToId(a[i], p.type, `${what} arg #${i}${p.name === '' ? '' : ` ("${p.name}")`}`),
      );
    }
    this.appendStmt({ k: 'throw', error: index, args: ids });
  }

  /** Resolves a thrown value against the declared set: identity first, then a structural
   *  name+shape match (a re-created but equal `t.error` value is accepted). */
  private findErrorDecl(error: unknown, what: string): RecErrorDecl {
    for (const d of this.errorDecls) {
      if (d.value === error) return d;
    }
    if (
      !isRecordObj(error) ||
      error['kind'] !== 'error' ||
      typeof error['name'] !== 'string' ||
      !Array.isArray(error['params'])
    ) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: expected an error declared with t.error(...), got ${describeHost(error)}`,
      );
    }
    const name = error['name'];
    const params: readonly unknown[] = error['params'];
    const sameName = this.errorDecls.find((d) => d.ir.name === name);
    if (sameName !== undefined && sameName.params.length === params.length) {
      const structurallyEqual = sameName.params.every((p, i) => {
        const q = params[i];
        return (
          isRecordObj(q) &&
          q['name'] === p.name &&
          isEvsValueType(q['type']) &&
          typesEqual(q['type'], p.type)
        );
      });
      if (structurallyEqual) return sameName;
    }
    throw new EvsTypeError(
      'ERROR_UNDECLARED',
      `${what}: error "${name}" is not declared by script "${this.name}" — add it to the def's errors: [...] list${sameName !== undefined ? ` (an error named "${name}" IS declared, but with different params)` : ''}`,
    );
  }

  // -- control flow ---------------------------------------------------------------------

  ifStmt(cond: unknown, thenFn: unknown, elseFn: unknown): void {
    this.assertOpen('s.if()');
    if (typeof thenFn !== 'function' || (elseFn !== undefined && typeof elseFn !== 'function')) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.if(): branches must be callbacks — s.if(cond, () => { … }, () => { … }?)`,
      );
    }
    const condId = this.coerceToId(cond, 'bool', 's.if() condition');
    const thenScope = this.pushScope('if-then');
    try {
      unsafeCast<() => void>(thenFn)();
    } finally {
      this.popScope();
    }
    const elseScope = this.pushScope('if-else');
    try {
      if (elseFn !== undefined) unsafeCast<() => void>(elseFn)();
    } finally {
      this.popScope();
    }
    this.appendStmt({ k: 'if', cond: condId, then: thenScope.stmts, else: elseScope.stmts });
  }

  whileStmt(condThunk: unknown, bodyFn: unknown): void {
    this.assertOpen('s.while()');
    if (typeof condThunk !== 'function' || typeof bodyFn !== 'function') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.while(): expected s.while(() => cond, (loop) => { … }) — the condition is a thunk recorded into the loop header`,
      );
    }
    this.whileInternal(
      () => {
        const cond = unsafeCast<() => unknown>(condThunk)();
        return this.coerceToId(cond, 'bool', 's.while() condition');
      },
      (loop) => {
        unsafeCast<(loop: LoopCtlImpl) => void>(bodyFn)(loop);
      },
    );
  }

  private whileInternal(
    recordCond: () => ValueId,
    recordBody: (loop: LoopCtlImpl, bodyScope: Scope) => void,
  ): void {
    const headerScope = this.pushScope('while-header');
    try {
      const condId = recordCond();
      const bodyScope = this.pushScope('while-body'); // child of the header scope
      const loop = new LoopCtlImpl(this.self, bodyScope);
      try {
        recordBody(loop, bodyScope);
      } finally {
        this.popScope();
      }
      this.popScope(); // header
      this.appendStmt({
        k: 'while',
        header: headerScope.stmts,
        cond: condId,
        body: bodyScope.stmts,
      });
      return;
    } catch (e) {
      // unwind any scopes this loop pushed, then rethrow
      while (this.stack.includes(headerScope)) this.popScope();
      throw e;
    }
  }

  forStmt(range: unknown, bodyFn: unknown): void {
    this.assertOpen('s.for()');
    if (typeof bodyFn !== 'function') {
      throw new EvsTypeError('TYPE_MISMATCH', `s.for(): body must be a callback (i, loop) => …`);
    }
    if (typeof range !== 'object' || range === null) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.for(): range must be { type?, from, until, step? }`,
      );
    }
    const r = range as { type?: unknown; from?: unknown; until?: unknown; step?: unknown };
    let ty: StringType;
    if (r.type === undefined) {
      ty = 'uint256'; // `type` is optional (issue #12) — the counter defaults to uint256
    } else {
      assertV0Type(r.type, 's.for() range.type');
      ty = r.type;
    }
    if (!isNumeric(ty)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.for(): range.type must be numeric (uintN/intN), got '${stringifyType(ty)}'`,
      );
    }
    if (r.from === undefined || r.until === undefined) {
      throw new EvsTypeError('TYPE_MISMATCH', `s.for(): range.from and range.until are required`);
    }
    // the loop cell + the ONE-TIME snapshots of `until` and `step`
    const cellId = this.makeCell(ty, r.from);
    const untilId = this.coerceToId(r.until, ty, 's.for() range.until');
    const stepId = this.coerceToId(r.step ?? 1, ty, 's.for() range.step');
    this.counterLoop(ty, cellId, untilId, stepId, (iSnap, _iId, loop) => {
      unsafeCast<(i: Expr, loop: LoopCtlShape) => void>(bodyFn)(iSnap, loop);
    });
  }

  /** `s.forEach(array, (elem, i, loop) => …)` (issue #12): the counter loop over an array
   *  value — `until` is the array's length (snapshot ONCE before the loop, like `s.for`'s
   *  `until`), and each iteration binds `elem` to the bounds-checked `array.at(i)` element
   *  handle (a `Tuple` for a `tuple[]` element, an `Expr` otherwise). */
  forEachStmt(arr: unknown, bodyFn: unknown): void {
    this.assertOpen('s.forEach()');
    if (typeof bodyFn !== 'function') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.forEach(): body must be a callback (elem, i, loop) => …`,
      );
    }
    const c = this.classify(arr, 's.forEach() array');
    if (c.kind !== 'expr' || !isArrayValueType(c.type)) {
      // no MutArray steering here — classify already threw its own `.expr()` hint for one
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.forEach(): expected an Expr of a T[] array type, got ${c.kind === 'expr' ? `'${stringifyType(c.type)}'` : describeHost(arr)}`,
      );
    }
    const elemTy = elemTypeOf(c.type);
    const lenId = this.lenId(c.id, 's.forEach(…) length');
    const cellId = this.makeCell('uint256', 0);
    const stepId = this.wordConst('uint256', 1n);
    // the element load is recorded unconditionally; when the body never reads `elem` the
    // compile-time DCE pass (ir/dce.ts) drops it, bounds check included
    this.counterLoop('uint256', cellId, lenId, stepId, (iSnap, iId, loop) => {
      const elem = this.indexElem(c.id, elemTy, iId, 's.forEach(…) element');
      unsafeCast<(e: unknown, i: Expr, loop: LoopCtlShape) => void>(bodyFn)(elem, iSnap, loop);
    });
  }

  /**
   * The shared counter-loop core of `s.for` / `s.forEach`: an internal cell, `i < until` in
   * the loop header, and the step recorded before every `continue` and once at the natural end
   * of the body — continue() must execute the step first (for-loops continue to the step).
   */
  private counterLoop(
    ty: StringType,
    cellId: CellId,
    untilId: ValueId,
    stepId: ValueId,
    invokeBody: (iSnap: Expr, iId: ValueId, loop: LoopCtlShape) => void,
  ): void {
    const emitStep = (): void => {
      const cur = this.cellGetId(cellId);
      const sum = this.newValue(ty);
      this.appendStmt({ k: 'bin', op: 'add', a: cur, b: stepId, out: sum });
      this.appendStmt({ k: 'cellset', cell: cellId, value: sum });
    };

    // the body's `i` snapshot REUSES the header's cellget: the header dominates the body
    // (validate.ts scoping) and nothing runs between the compare and the body start, so the
    // header read IS the per-iteration counter — no second cellget per iteration
    let iId!: ValueId;
    this.whileInternal(
      () => {
        iId = this.cellGetId(cellId);
        const cond = this.newValue('bool');
        this.appendStmt({ k: 'bin', op: 'lt', a: iId, b: untilId, out: cond });
        return cond;
      },
      (rawLoop) => {
        const iSnap = makeExpr(this.self, iId);
        const wrapped: LoopCtlShape = {
          break: () => {
            rawLoop.break();
          },
          continue: () => {
            rawLoop.guard('loop.continue()');
            emitStep();
            rawLoop.emit('continue');
          },
        };
        invokeBody(iSnap, iId, wrapped);
        emitStep();
      },
    );
  }
}

/** Structural shape handed to loop bodies (cast to the public `LoopCtl` by script.ts). */
interface LoopCtlShape {
  break(): void;
  continue(): void;
}
