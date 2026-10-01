/**
 * `ir/nodes/walk.ts` — the statement def/use tables (shared by `ir/dce` and `codegen/frame`) and
 * `walkStmts`, the statement-tree traversal.
 */

import { EvsInternalError } from '../../core/errors.js';
import type { Stmt, ValueId } from './schema.js';

// ---------------------------------------------------------------------------
// statement def/use tables (shared by ir/dce and codegen/frame)
// ---------------------------------------------------------------------------

/**
 * Every ValueId a statement reads (its operands; its own child blocks excluded — those are
 * walked). Exhaustive over the statement kinds on purpose: a new kind must fail to compile here
 * rather than have its operands go uncounted by DCE liveness or the frame allocator.
 */
export function stmtReads(s: Stmt): readonly ValueId[] {
  switch (s.k) {
    case 'const':
    case 'env':
    case 'cellget':
    case 'break':
    case 'continue':
      return [];
    case 'bin':
      return [s.a, s.b];
    case 'un':
    case 'convert':
    case 'len':
    case 'keccak256':
      return [s.a];
    case 'select':
      return [s.cond, s.a, s.b];
    case 'modarith':
      return [s.a, s.b, s.n];
    case 'index':
      return [s.arr, s.i];
    case 'slice':
      return [s.a, s.start, s.end];
    case 'arrnew':
      return [s.length];
    case 'arrset':
      return [s.arr, s.i, s.value];
    case 'tuplenew':
      return s.inits.map((init) => init.value);
    case 'field':
      return [s.tuple];
    case 'tupleset':
      return [s.tuple, s.value];
    case 'encode':
    case 'throw':
    case 'fncall':
      return s.args;
    case 'cellnew':
      return [s.init];
    case 'cellset':
      return [s.value];
    case 'call':
      return s.gas === undefined ? [s.target, ...s.args] : [s.target, s.gas, ...s.args];
    case 'if':
    case 'while':
      return [s.cond];
    default:
      return unknownStmt(s);
  }
}

/** Every ValueId a statement defines. Exhaustive for the same reason as {@link stmtReads}. */
export function stmtDefs(s: Stmt): readonly ValueId[] {
  switch (s.k) {
    case 'const':
    case 'bin':
    case 'un':
    case 'modarith':
    case 'env':
    case 'convert':
    case 'select':
    case 'index':
    case 'len':
    case 'slice': // the fresh string/bytes memref pointer
    case 'arrnew':
    case 'cellget':
    case 'tuplenew': // the tuple pointer
    case 'field': // the member word or nested pointer
    case 'encode': // the fresh bytes memref pointer
    case 'keccak256': // the bytes32 hash word
      return [s.out];
    case 'call':
      return s.successOut === undefined ? s.outs : [...s.outs, s.successOut];
    case 'fncall':
      return s.outs;
    case 'arrset':
    case 'tupleset':
    case 'throw':
    case 'cellnew':
    case 'cellset':
    case 'if':
    case 'while':
    case 'break':
    case 'continue':
      return [];
    default:
      return unknownStmt(s);
  }
}

function unknownStmt(s: never): never {
  const kind = String((s as { k?: unknown }).k);
  throw new EvsInternalError('INTERNAL', `unknown statement kind '${kind}' survived validateIr`);
}

// ---------------------------------------------------------------------------
// walkStmts — statement-tree traversal
// ---------------------------------------------------------------------------

/**
 * Depth-first, pre-order walk over a statement tree (a statement is visited before its child
 * blocks). `path` alternates statement indices and child-block ordinals so nested positions
 * are unambiguous: the statement at `stmts[2].then[1]` is visited with path `[2, 0, 1]`
 * (`if`: block 0 = `then`, block 1 = `else`; `while`: block 0 = `header`, block 1 = `body`).
 */
export function walkStmts(
  stmts: readonly Stmt[],
  visit: (s: Stmt, path: readonly number[]) => void,
): void {
  walk(stmts, [], visit);
}

function walk(
  stmts: readonly Stmt[],
  prefix: readonly number[],
  visit: (s: Stmt, path: readonly number[]) => void,
): void {
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s === undefined) continue; // sparse arrays cannot occur in well-formed IR
    const path = [...prefix, i];
    visit(s, path);
    switch (s.k) {
      case 'if':
        walk(s.then, [...path, 0], visit);
        walk(s.else, [...path, 1], visit);
        break;
      case 'while':
        walk(s.header, [...path, 0], visit);
        walk(s.body, [...path, 1], visit);
        break;
      default:
        break;
    }
  }
}
