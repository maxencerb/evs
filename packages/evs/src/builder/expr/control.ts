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
import { LoopCtlImpl, makeExpr, recordLoopJump } from './handles.js';
import {
  isRecordObj,
  describeHost,
  didYouMean,
  unsafeCast,
  type Scope,
  assertV0Type,
  assertSyncCallback,
} from './helpers.js';
import { RecorderOps } from './ops.js';

/** The keys of an `s.for` range. */
const RANGE_KEYS: readonly string[] = ['type', 'from', 'until', 'step'];

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
    const { decl, index } = this.findErrorDecl(error, what);
    const n = decl.params.length;
    // a value after the args would be dropped (a trailing `undefined` carries nothing)
    if (argsIn.slice(1).some((extra) => extra !== undefined)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: error "${decl.ir.name}" takes ${n === 0 ? 'no args' : 'its args as one value (a record or a tuple)'}, got ${argsIn.length} values after the error — the extra ones would be dropped`,
      );
    }
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
      const known = decl.params.map((p) => p.name);
      for (const key of Object.keys(a)) {
        if (!known.includes(key)) {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${what}: unknown arg ${JSON.stringify(key)} for error "${decl.ir.name}"${didYouMean(key, known)} (expected: ${known.join(', ')})`,
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

  /** Resolves a thrown value against the declared set, returning the declaration and its index
   *  (the `throw` stmt's `error`): identity first, then a structural name+shape match (a
   *  re-created but equal `t.error` value is accepted). */
  private findErrorDecl(error: unknown, what: string): { decl: RecErrorDecl; index: number } {
    const byIdentity = this.errorDecls.findIndex((d) => d.value === error);
    const declared = this.errorDecls[byIdentity];
    if (declared !== undefined) return { decl: declared, index: byIdentity };
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
    const index = this.errorDecls.findIndex((d) => d.ir.name === name);
    const sameName = this.errorDecls[index];
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
      if (structurallyEqual) return { decl: sameName, index };
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
    this.enterBlock('s.if()');
    try {
      const condId = this.coerceToId(cond, 'bool', 's.if() condition');
      const thenScope = this.pushScope('if-then');
      try {
        assertSyncCallback(unsafeCast<() => unknown>(thenFn)(), 's.if() then branch');
      } finally {
        this.popScope();
      }
      const elseScope = this.pushScope('if-else');
      try {
        if (elseFn !== undefined) {
          assertSyncCallback(unsafeCast<() => unknown>(elseFn)(), 's.if() else branch');
        }
      } finally {
        this.popScope();
      }
      this.appendStmt({ k: 'if', cond: condId, then: thenScope.stmts, else: elseScope.stmts });
    } finally {
      this.exitBlock();
    }
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
      's.while()',
      () => {
        const cond = unsafeCast<() => unknown>(condThunk)();
        assertSyncCallback(cond, 's.while() condition');
        return this.coerceToId(cond, 'bool', 's.while() condition');
      },
      (loop) => {
        assertSyncCallback(
          unsafeCast<(loop: LoopCtlImpl) => unknown>(bodyFn)(loop),
          's.while() body',
        );
      },
    );
  }

  /** Records one `while` statement: one block level for its header and its body together. */
  private whileInternal(
    what: string,
    recordCond: () => ValueId,
    recordBody: (loop: LoopCtlImpl, bodyScope: Scope) => void,
  ): void {
    this.enterBlock(what);
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
    } finally {
      this.exitBlock();
    }
  }

  forStmt(range: unknown, bodyFn: unknown): void {
    this.assertOpen('s.for()');
    if (typeof bodyFn !== 'function') {
      throw new EvsTypeError('TYPE_MISMATCH', `s.for(): body must be a callback (i, loop) => …`);
    }
    if (typeof range !== 'object' || range === null || Array.isArray(range)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.for(): range must be { type?, from, until, step? }`,
      );
    }
    // a key the range does not have is a typo of one it has (`setp`) or an option of another API
    // (`to`): read as absent, it would record a loop the user did not write
    for (const key of Object.keys(range)) {
      if (!RANGE_KEYS.includes(key)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.for(): unknown range key ${JSON.stringify(key)}${didYouMean(key, RANGE_KEYS)} (the range is { type?, from, until, step? })`,
        );
      }
    }
    this.assertBlockRoom('s.for()');
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
    // only an absent step is the default: `null` is a value the caller computed
    if (r.step === null) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.for(): range.step must be an Expr or a literal of '${ty}', got null — leave it out for a step of 1`,
      );
    }
    // a host zero is refused before anything is recorded; a zero that comes as a literal Expr
    // (`s.lit`) only shows once it is coerced
    if (r.step === 0 || r.step === 0n) this.zeroStep();
    // the loop cell + the ONE-TIME snapshots of `until` and `step`
    const cellId = this.makeCell(ty, r.from);
    const untilId = this.coerceToId(r.until, ty, 's.for() range.until');
    const stepId = this.coerceToId(r.step === undefined ? 1 : r.step, ty, 's.for() range.step');
    if (this.litValues.get(stepId) === 0n) this.zeroStep();
    this.counterLoop('s.for()', ty, cellId, untilId, stepId, (iSnap, _iId, loop) => {
      const result = unsafeCast<(i: Expr, loop: LoopCtlShape) => unknown>(bodyFn)(iSnap, loop);
      assertSyncCallback(result, 's.for() body');
    });
  }

  /** A literal step of zero never advances the counter: the recorded loop would only end by
   *  running out of gas (or never start, when `from >= until`). */
  private zeroStep(): never {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `s.for(): range.step is the literal 0 — the counter would never advance, so the loop would run until the call is out of gas. Use a step of at least 1 (for a loop with no counter, s.while)`,
    );
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
    this.assertBlockRoom('s.forEach()');
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
    this.counterLoop('s.forEach()', 'uint256', cellId, lenId, stepId, (iSnap, iId, loop) => {
      const elem = this.indexElem(c.id, elemTy, iId, 's.forEach(…) element');
      const result = unsafeCast<(e: unknown, i: Expr, loop: LoopCtlShape) => unknown>(bodyFn)(
        elem,
        iSnap,
        loop,
      );
      assertSyncCallback(result, 's.forEach() body');
    });
  }

  /**
   * The shared counter-loop core of `s.for` / `s.forEach`: an internal cell, `i < until` in
   * the loop header, and the step recorded before every `continue` and once at the natural end
   * of the body — continue() must execute the step first (for-loops continue to the step).
   *
   * The step is `cell = i + step` where `i` is the header's snapshot (`iId`), not a fresh
   * `cellget`: the cell is internal (no handle ever reaches the user) and only the step writes
   * it, and every step is followed by `continue` or the end of the body, so `cell == i` holds
   * at every step. An outer loop's `continue()` inside an inner loop's BODY is rejected by
   * `recordLoopJump`; inside an inner `s.while` HEADER thunk it is accepted (the guard's
   * `innermostLoopBody()` only looks at `while-body` scopes), and there the recorded `continue`
   * sits outside the inner body, so it targets this counter loop: the step before it still
   * leaves `cell == i` for the next header read. Reusing `i` saves a read per step and ties the step `add(i, 1)` to the header
   * guard `lt(i, until)` in SSA, which lets codegen drop the step's overflow check and
   * `s.forEach`'s element bounds check (`codegen/lower/guards.ts`).
   */
  private counterLoop(
    what: string,
    ty: StringType,
    cellId: CellId,
    untilId: ValueId,
    stepId: ValueId,
    invokeBody: (iSnap: Expr, iId: ValueId, loop: LoopCtlShape) => void,
  ): void {
    // the body's `i` snapshot REUSES the header's cellget: the header dominates the body
    // (validate.ts scoping) and nothing runs between the compare and the body start, so the
    // header read IS the per-iteration counter — no second cellget per iteration (and the step
    // reads it too, see above)
    let iId!: ValueId;
    const emitStep = (): void => {
      const sum = this.newValue(ty);
      this.appendStmt({ k: 'bin', op: 'add', a: iId, b: stepId, out: sum });
      this.appendStmt({ k: 'cellset', cell: cellId, value: sum });
    };
    this.whileInternal(
      what,
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
            recordLoopJump(rawLoop, 'continue', { beforeJump: emitStep });
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
