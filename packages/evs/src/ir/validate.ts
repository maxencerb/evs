/**
 * M2 `ir/validate.ts` — whole-program semantic validation of a `ScriptIr`.
 *
 * Contract: docs/design/module-interfaces.md §M2 (frozen) + architecture.md §3/§4/§6.
 *
 * Re-checks everything the builder enforces so deserialized IR is as trustworthy as recorded
 * IR (`deserializeIr → validateIr` is the trust boundary): operand types per the op table,
 * def-before-use under the scope rule (a `while` header dominates its body; `if`/`else`
 * branches are isolated; `fn` bodies see params only), unknown ids, single static assignment
 * of every ValueId, cell creation/typing/scoping, `break`/`continue` only inside a loop body,
 * call-graph acyclicity, return-name validity, fnAbi v0-ness, and `successOut` ⇔ try mode.
 *
 * Script args bind positionally to the first `args.length` entries of the value table
 * (ValueIds `0 … args.length-1`) — the only binding the frozen `ScriptIr` shape admits, since
 * `args` entries carry no explicit ValueId and no "load arg" statement kind exists.
 *
 * All failures throw `EvsInternalError` (compiler-produced IR is supposed to be valid — a
 * failure here means a bug in whichever producer built the IR).
 */

import { EvsInternalError, type SourceLoc } from '../core/errors.js';
import {
  abiParamToType,
  bitsOf,
  elemTypeOf,
  isArrayValueType,
  isDynamicType,
  isEvsType,
  isEvsValueType,
  isNumeric,
  isSigned,
  isTupleType,
  isWordType,
  typesEqual,
  type ArrayType,
  type EvsType,
  type WordType,
} from '../core/types.js';
import type {
  CellId,
  FnId,
  PlainAbiFunction,
  PlainAbiParam,
  ScriptIr,
  Stmt,
  ValueId,
} from './nodes.js';

export function validateIr(ir: ScriptIr): void {
  new IrValidator(ir).run();
}

// ---------------------------------------------------------------------------
// implementation (module-private)
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_]\w*$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
const WORD_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const DATA_HEX_RE = /^0x(?:[0-9a-fA-F]{2})+$/;

interface Scope {
  readonly values: Set<ValueId>;
  readonly cells: Set<CellId>;
}

function newScope(): Scope {
  return { values: new Set(), cells: new Set() };
}

class IrValidator {
  private readonly ir: ScriptIr;
  /** global single-static-assignment tracker, indexed by ValueId */
  private readonly valueDefined: boolean[];
  /** every CellId must have exactly one `cellnew`, indexed by CellId */
  private readonly cellCreated: boolean[];
  /** fn → set of fns it fncalls (for acyclicity), indexed by FnId */
  private readonly fnCalls: Set<FnId>[];
  private scopes: Scope[] = [];
  private loopDepth = 0;
  private currentFn: FnId | null = null;

  constructor(ir: ScriptIr) {
    this.ir = ir;
    this.valueDefined = Array.from({ length: ir.values.length }, () => false);
    this.cellCreated = Array.from({ length: ir.cells.length }, () => false);
    this.fnCalls = ir.fns.map(() => new Set<FnId>());
  }

  run(): void {
    this.checkTables();
    this.checkMain();
    this.checkFns();
    this.checkCallGraph();
  }

  // -------------------------------------------------------------------------
  // failure
  // -------------------------------------------------------------------------

  private fail(
    msg: string,
    loc: SourceLoc | null,
    relatedLocs?: readonly { label: string; loc: SourceLoc | null }[],
  ): never {
    throw new EvsInternalError(`INTERNAL`, `invalid ScriptIr "${this.ir.name}": ${msg}`, {
      loc,
      relatedLocs: relatedLocs ?? [],
    });
  }

  // -------------------------------------------------------------------------
  // table sanity (types of values/cells/args/fn signatures)
  // -------------------------------------------------------------------------

  private checkTables(): void {
    const { ir } = this;
    ir.values.forEach((info, i) => {
      if (!isEvsValueType(info.type)) {
        this.fail(`values[${i}] has a non-v0 type ${JSON.stringify(info.type)}`, info.loc);
      }
    });
    ir.cells.forEach((info, i) => {
      if (!isEvsValueType(info.type)) {
        this.fail(`cells[${i}] has a non-v0 type ${JSON.stringify(info.type)}`, info.loc);
      }
    });
    const argNames = new Set<string>();
    ir.args.forEach((a, i) => {
      if (!IDENT_RE.test(a.name)) {
        this.fail(`args[${i}] has an invalid name ${JSON.stringify(a.name)}`, ir.loc);
      }
      if (argNames.has(a.name)) this.fail(`duplicate arg name "${a.name}"`, ir.loc);
      argNames.add(a.name);
      if (!isEvsValueType(a.type)) {
        this.fail(`args[${i}] ("${a.name}") has a non-v0 type ${JSON.stringify(a.type)}`, ir.loc);
      }
      const backing = ir.values[i];
      if (backing === undefined) {
        this.fail(
          `args[${i}] ("${a.name}") has no backing value: script args bind to ValueIds 0…${ir.args.length - 1}`,
          ir.loc,
        );
      }
      if (!typesEqual(backing.type, a.type)) {
        this.fail(
          `args[${i}] ("${a.name}") is declared '${stringifyType(a.type)}' but its backing values[${i}] is '${stringifyType(backing.type)}'`,
          backing.loc,
        );
      }
    });
    ir.fns.forEach((fn, f) => {
      fn.params.forEach((p, i) => {
        if (!isEvsValueType(p.type)) {
          this.fail(
            `fns[${f}].params[${i}] ("${p.name}") has a non-v0 type ${JSON.stringify(p.type)}`,
            fn.loc,
          );
        }
      });
      fn.results.forEach((r, i) => {
        if (!isEvsValueType(r.type)) {
          this.fail(`fns[${f}].results[${i}] has a non-v0 type ${JSON.stringify(r.type)}`, fn.loc);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // main body + returns
  // -------------------------------------------------------------------------

  private checkMain(): void {
    const { ir } = this;
    this.scopes = [newScope()];
    this.loopDepth = 0;
    this.currentFn = null;
    for (let i = 0; i < ir.args.length; i++) {
      this.define(i, null, `args[${i}]`, ir.loc);
    }
    this.walkBlock(ir.body, 'body');
    this.checkReturns();
    this.scopes = [];
  }

  private checkReturns(): void {
    const { ir } = this;
    const names = new Set<string>();
    ir.returns.forEach((r, i) => {
      if (r.name === '') this.fail(`returns[${i}] has an empty name`, ir.loc);
      if (names.has(r.name)) this.fail(`duplicate return name "${r.name}"`, ir.loc);
      names.add(r.name);
      if (!isEvsValueType(r.type)) {
        this.fail(
          `returns[${i}] ("${r.name}") has a non-v0 type ${JSON.stringify(r.type)}`,
          ir.loc,
        );
      }
      this.use(r.value, r.type, `returns[${i}] ("${r.name}")`, ir.loc);
    });
  }

  // -------------------------------------------------------------------------
  // fn bodies (isolated scope stacks: params only) + call graph
  // -------------------------------------------------------------------------

  private checkFns(): void {
    this.ir.fns.forEach((fn, f) => {
      this.currentFn = f;
      this.loopDepth = 0;
      this.scopes = [newScope()];
      fn.params.forEach((p, i) => {
        this.define(p.value, p.type, `fns[${f}].params[${i}] ("${p.name}")`, fn.loc);
      });
      this.walkBlock(fn.body, `fns[${f}].body`);
      if (fn.resultValues.length !== fn.results.length) {
        this.fail(
          `fns[${f}] ("${fn.name}") has ${fn.resultValues.length} resultValues for ${fn.results.length} results`,
          fn.loc,
        );
      }
      fn.resultValues.forEach((rv, i) => {
        const result = fn.results[i];
        if (result === undefined) return; // unreachable: lengths checked above
        this.use(rv, result.type, `fns[${f}].resultValues[${i}]`, fn.loc);
      });
      this.scopes = [];
    });
    this.currentFn = null;
  }

  private checkCallGraph(): void {
    const { ir } = this;
    // 0 = unvisited, 1 = on the DFS stack, 2 = done
    const state = Array.from({ length: ir.fns.length }, () => 0);
    const stack: FnId[] = [];
    const fnName = (f: FnId): string => `fns[${f}] ("${ir.fns[f]?.name ?? '?'}")`;
    const visit = (f: FnId): void => {
      if (state[f] === 1) {
        const cycle = [...stack.slice(stack.indexOf(f)), f].map(fnName).join(' → ');
        this.fail(`call-graph cycle: ${cycle}`, ir.fns[f]?.loc ?? null);
      }
      if (state[f] === 2) return;
      state[f] = 1;
      stack.push(f);
      for (const g of this.fnCalls[f] ?? []) visit(g);
      stack.pop();
      state[f] = 2;
    };
    for (let f = 0; f < ir.fns.length; f++) visit(f);
  }

  // -------------------------------------------------------------------------
  // value/cell bookkeeping under the scope rule
  // -------------------------------------------------------------------------

  private top(): Scope {
    const s = this.scopes[this.scopes.length - 1];
    if (s === undefined) {
      throw new EvsInternalError('INTERNAL', 'validateIr: scope stack underflow');
    }
    return s;
  }

  /**
   * Marks `id` defined by the current statement: range check, single static assignment, and
   * (when `producedType` is non-null) agreement between the value table's declared type and
   * the type the statement produces.
   */
  private define(
    id: ValueId,
    producedType: EvsType | null,
    what: string,
    loc: SourceLoc | null,
  ): void {
    const info = this.ir.values[id];
    if (info === undefined) this.fail(`${what}: unknown ValueId ${id}`, loc);
    if (this.valueDefined[id] === true) {
      this.fail(`${what}: ValueId ${id} is defined more than once`, loc, [
        { label: 'value recorded at', loc: info.loc },
      ]);
    }
    if (producedType !== null && !typesEqual(info.type, producedType)) {
      this.fail(
        `${what}: values[${id}] is declared '${stringifyType(info.type)}' but the statement produces '${stringifyType(producedType)}'`,
        loc,
      );
    }
    this.valueDefined[id] = true;
    this.top().values.add(id);
  }

  /**
   * Checks that `id` is usable here (defined earlier, in a scope currently on the stack) and,
   * when `expected` is non-null, that it has the expected type. Returns the operand's type.
   */
  private use(id: ValueId, expected: EvsType | null, what: string, loc: SourceLoc | null): EvsType {
    const info = this.ir.values[id];
    if (info === undefined) this.fail(`${what}: unknown ValueId ${id}`, loc);
    if (!this.scopes.some((s) => s.values.has(id))) {
      if (this.valueDefined[id] === true) {
        this.fail(`${what}: ValueId ${id} is used outside its defining scope`, loc, [
          { label: 'value recorded at', loc: info.loc },
        ]);
      }
      this.fail(`${what}: ValueId ${id} is used before it is defined`, loc, [
        { label: 'value recorded at', loc: info.loc },
      ]);
    }
    if (expected !== null && !typesEqual(info.type, expected)) {
      this.fail(
        `${what}: operand type mismatch — expected '${stringifyType(expected)}', got values[${id}] of type '${stringifyType(info.type)}'`,
        loc,
      );
    }
    return info.type;
  }

  private cellInfo(cell: CellId, what: string, loc: SourceLoc | null): { type: EvsType } {
    const info = this.ir.cells[cell];
    if (info === undefined) this.fail(`${what}: unknown CellId ${cell}`, loc);
    return info;
  }

  private useCell(cell: CellId, what: string, loc: SourceLoc | null): EvsType {
    const info = this.cellInfo(cell, what, loc);
    if (!this.scopes.some((s) => s.cells.has(cell))) {
      if (this.cellCreated[cell] === true) {
        this.fail(`${what}: CellId ${cell} is used outside its defining scope`, loc);
      }
      this.fail(`${what}: CellId ${cell} is used before its cellnew`, loc);
    }
    return info.type;
  }

  // -------------------------------------------------------------------------
  // statement walk
  // -------------------------------------------------------------------------

  private walkBlock(stmts: readonly Stmt[], path: string): void {
    stmts.forEach((s, i) => {
      this.checkStmt(s, `${path}[${i}]`);
    });
  }

  private checkStmt(s: Stmt, path: string): void {
    switch (s.k) {
      case 'const': {
        const what = `${path} (const)`;
        if (!isEvsValueType(s.type) || isTupleType(s.type)) {
          this.fail(`${what}: non-v0 / non-const type ${JSON.stringify(s.type)}`, s.loc);
        }
        this.checkConstData(s.type, s.data, what, s.loc);
        this.define(s.out, s.type, what, s.loc);
        return;
      }
      case 'bin':
        this.checkBin(s, path);
        return;
      case 'un': {
        const what = `${path} (un ${s.op})`;
        if (s.op === 'not') {
          this.use(s.a, 'bool', what, s.loc);
          this.define(s.out, 'bool', what, s.loc);
          return;
        }
        if (s.op === 'iszero') {
          const ta = this.use(s.a, null, what, s.loc);
          if (!isWordType(ta)) {
            this.fail(`${what}: operand must be a word type, got '${stringifyType(ta)}'`, s.loc);
          }
          this.define(s.out, 'bool', what, s.loc);
          return;
        }
        // bitnot
        const ta = this.use(s.a, null, what, s.loc);
        if (!isBitsOperand(ta)) {
          this.fail(
            `${what}: operand must be uintN/intN/bytesN, got '${stringifyType(ta)}'`,
            s.loc,
          );
        }
        this.define(s.out, ta, what, s.loc);
        return;
      }
      case 'env': {
        const what = `${path} (env ${s.op})`;
        const outType: EvsType = s.op === 'address' || s.op === 'caller' ? 'address' : 'uint256';
        this.define(s.out, outType, what, s.loc);
        return;
      }
      case 'convert': {
        const what = `${path} (convert)`;
        const from = this.use(s.a, null, what, s.loc);
        const outInfo = this.ir.values[s.out];
        if (outInfo === undefined) this.fail(`${what}: unknown ValueId ${s.out}`, s.loc);
        if (!convertOk(from, outInfo.type)) {
          this.fail(
            `${what}: no v0 conversion from '${stringifyType(from)}' to '${stringifyType(outInfo.type)}' (legal: uintN/intN → uintN/intN, uint256|bytes32 → address, uint256 ↔ bytes32)`,
            s.loc,
          );
        }
        this.define(s.out, outInfo.type, what, s.loc);
        return;
      }
      case 'select': {
        const what = `${path} (select)`;
        this.use(s.cond, 'bool', what, s.loc);
        const ta = this.use(s.a, null, what, s.loc);
        this.use(s.b, ta, what, s.loc);
        this.define(s.out, ta, what, s.loc);
        return;
      }
      case 'index': {
        const what = `${path} (index)`;
        const ta = this.use(s.arr, null, what, s.loc);
        if (!isArrayValueType(ta)) {
          this.fail(`${what}: operand must be a T[] array, got '${stringifyType(ta)}'`, s.loc);
        }
        this.use(s.i, 'uint256', what, s.loc);
        this.define(s.out, elemTypeOf(ta), what, s.loc);
        return;
      }
      case 'len': {
        const what = `${path} (len)`;
        const ta = this.use(s.a, null, what, s.loc);
        if (!isDynamicType(ta) || isTupleType(ta)) {
          this.fail(`${what}: operand must be string/bytes/T[], got '${stringifyType(ta)}'`, s.loc);
        }
        this.define(s.out, 'uint256', what, s.loc);
        return;
      }
      case 'arrnew': {
        const what = `${path} (arrnew)`;
        const elem = this.checkElemType(s.elem, what, s.loc);
        this.use(s.length, 'uint256', what, s.loc);
        this.define(s.out, arrayOf(elem), what, s.loc);
        return;
      }
      case 'arrset': {
        const what = `${path} (arrset)`;
        const ta = this.use(s.arr, null, what, s.loc);
        if (!isArrayValueType(ta)) {
          this.fail(`${what}: operand must be a T[] array, got '${stringifyType(ta)}'`, s.loc);
        }
        this.use(s.i, 'uint256', what, s.loc);
        this.use(s.value, elemTypeOf(ta), what, s.loc);
        return;
      }
      case 'tuplenew': {
        const what = `${path} (tuplenew)`;
        const outInfo = this.ir.values[s.out];
        if (outInfo === undefined) this.fail(`${what}: unknown ValueId ${s.out}`, s.loc);
        const tt = outInfo.type;
        if (!isTupleType(tt)) {
          this.fail(`${what}: out value must be a tuple type, got '${stringifyType(tt)}'`, s.loc);
        }
        const seen = new Set<number>();
        s.inits.forEach((init, j) => {
          const comp = tt.components[init.index];
          if (comp === undefined) {
            this.fail(`${what}: init #${j} index ${init.index} out of range`, s.loc);
          }
          if (seen.has(init.index)) {
            this.fail(`${what}: init #${j} writes member ${init.index} twice`, s.loc);
          }
          seen.add(init.index);
          this.use(init.value, abiParamToType(comp), `${what} init #${j}`, s.loc);
        });
        this.define(s.out, tt, what, s.loc);
        return;
      }
      case 'field': {
        const what = `${path} (field)`;
        const ta = this.use(s.tuple, null, what, s.loc);
        if (!isTupleType(ta) || ta.type !== 'tuple') {
          this.fail(`${what}: operand must be a tuple, got '${stringifyType(ta)}'`, s.loc);
        }
        const comp = ta.components[s.index];
        if (comp === undefined) {
          this.fail(`${what}: member index ${s.index} out of range`, s.loc);
        }
        this.define(s.out, abiParamToType(comp), what, s.loc);
        return;
      }
      case 'tupleset': {
        const what = `${path} (tupleset)`;
        const ta = this.use(s.tuple, null, what, s.loc);
        if (!isTupleType(ta) || ta.type !== 'tuple') {
          this.fail(`${what}: operand must be a tuple, got '${stringifyType(ta)}'`, s.loc);
        }
        const comp = ta.components[s.index];
        if (comp === undefined) {
          this.fail(`${what}: member index ${s.index} out of range`, s.loc);
        }
        this.use(s.value, abiParamToType(comp), `${what} value`, s.loc);
        return;
      }
      case 'cellnew': {
        const what = `${path} (cellnew)`;
        const cell = this.cellInfo(s.cell, what, s.loc);
        if (this.cellCreated[s.cell] === true) {
          this.fail(`${what}: cellnew for CellId ${s.cell} appears more than once`, s.loc);
        }
        this.use(s.init, cell.type, what, s.loc);
        this.cellCreated[s.cell] = true;
        this.top().cells.add(s.cell);
        return;
      }
      case 'cellget': {
        const what = `${path} (cellget)`;
        const cellType = this.useCell(s.cell, what, s.loc);
        this.define(s.out, cellType, what, s.loc);
        return;
      }
      case 'cellset': {
        const what = `${path} (cellset)`;
        const cellType = this.useCell(s.cell, what, s.loc);
        this.use(s.value, cellType, what, s.loc);
        return;
      }
      case 'call':
        this.checkCall(s, path);
        return;
      case 'fncall': {
        const what = `${path} (fncall)`;
        const fn = this.ir.fns[s.fn];
        if (fn === undefined) this.fail(`${what}: unknown FnId ${s.fn}`, s.loc);
        if (s.args.length !== fn.params.length) {
          this.fail(
            `${what}: arity mismatch — ${s.args.length} args for fns[${s.fn}] ("${fn.name}") with ${fn.params.length} params`,
            s.loc,
          );
        }
        s.args.forEach((a, i) => {
          const p = fn.params[i];
          if (p === undefined) return; // unreachable: lengths checked above
          this.use(a, p.type, `${what} arg ${i} ("${p.name}")`, s.loc);
        });
        if (s.outs.length !== fn.results.length) {
          this.fail(
            `${what}: arity mismatch — ${s.outs.length} outs for fns[${s.fn}] ("${fn.name}") with ${fn.results.length} results`,
            s.loc,
          );
        }
        s.outs.forEach((out, i) => {
          const r = fn.results[i];
          if (r === undefined) return; // unreachable: lengths checked above
          this.define(out, r.type, `${what} out ${i}`, s.loc);
        });
        if (this.currentFn !== null) this.fnCalls[this.currentFn]?.add(s.fn);
        return;
      }
      case 'if': {
        const what = `${path} (if)`;
        this.use(s.cond, 'bool', what, s.loc);
        this.scopes.push(newScope());
        this.walkBlock(s.then, `${path}.then`);
        this.scopes.pop();
        this.scopes.push(newScope());
        this.walkBlock(s.else, `${path}.else`);
        this.scopes.pop();
        return;
      }
      case 'while': {
        const what = `${path} (while)`;
        // the body scope is a child of the header scope: header values dominate the body
        this.scopes.push(newScope());
        this.walkBlock(s.header, `${path}.header`);
        this.use(s.cond, 'bool', `${what} cond`, s.loc);
        this.scopes.push(newScope());
        this.loopDepth += 1;
        this.walkBlock(s.body, `${path}.body`);
        this.loopDepth -= 1;
        this.scopes.pop();
        this.scopes.pop();
        return;
      }
      case 'break':
      case 'continue': {
        if (this.loopDepth === 0) {
          this.fail(`${path}: '${s.k}' outside a while body`, s.loc);
        }
        return;
      }
      default: {
        // exhaustive over Stmt; reachable only for hand-built garbage
        const kind = String((s as { k: unknown }).k);
        this.fail(`${path}: unknown statement kind '${kind}'`, (s as Stmt).loc);
      }
    }
  }

  private checkBin(s: Extract<Stmt, { k: 'bin' }>, path: string): void {
    const what = `${path} (bin ${s.op})`;
    switch (s.op) {
      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
      case 'mod': {
        const ta = this.use(s.a, null, what, s.loc);
        if (!isNumeric(ta)) {
          this.fail(
            `${what}: operands must be numeric (uintN/intN), got '${stringifyType(ta)}'`,
            s.loc,
          );
        }
        this.use(s.b, ta, what, s.loc);
        this.define(s.out, ta, what, s.loc);
        return;
      }
      case 'lt':
      case 'gt':
      case 'lte':
      case 'gte': {
        const ta = this.use(s.a, null, what, s.loc);
        if (!isNumeric(ta)) {
          this.fail(
            `${what}: operands must be numeric (uintN/intN), got '${stringifyType(ta)}'`,
            s.loc,
          );
        }
        this.use(s.b, ta, what, s.loc);
        this.define(s.out, 'bool', what, s.loc);
        return;
      }
      case 'eq':
      case 'neq': {
        const ta = this.use(s.a, null, what, s.loc);
        if (!isWordType(ta)) {
          this.fail(
            `${what}: eq/neq are word-type-only (memref equality is undefined), got '${stringifyType(ta)}'`,
            s.loc,
          );
        }
        this.use(s.b, ta, what, s.loc);
        this.define(s.out, 'bool', what, s.loc);
        return;
      }
      case 'and':
      case 'or': {
        this.use(s.a, 'bool', what, s.loc);
        this.use(s.b, 'bool', what, s.loc);
        this.define(s.out, 'bool', what, s.loc);
        return;
      }
      case 'bitand':
      case 'bitor':
      case 'bitxor': {
        const ta = this.use(s.a, null, what, s.loc);
        if (!isBitsOperand(ta)) {
          this.fail(
            `${what}: operands must be uintN/intN/bytesN, got '${stringifyType(ta)}'`,
            s.loc,
          );
        }
        this.use(s.b, ta, what, s.loc);
        this.define(s.out, ta, what, s.loc);
        return;
      }
      case 'shl':
      case 'shr': {
        const ta = this.use(s.a, null, what, s.loc);
        if (!isBitsOperand(ta)) {
          this.fail(
            `${what}: shifted operand must be uintN/intN/bytesN, got '${stringifyType(ta)}'`,
            s.loc,
          );
        }
        this.use(s.b, 'uint256', `${what} shift amount`, s.loc);
        this.define(s.out, ta, what, s.loc);
        return;
      }
      default: {
        const op = String((s as { op: unknown }).op);
        this.fail(`${what}: unknown bin op '${op}'`, s.loc);
      }
    }
  }

  private checkCall(s: Extract<Stmt, { k: 'call' }>, path: string): void {
    const what = `${path} (call${s.mode === 'try' ? ' try' : ''} "${s.fnAbi.name}")`;
    this.use(s.target, 'address', `${what} target`, s.loc);
    this.checkPlainAbi(s.fnAbi, what, s.loc);
    if (s.args.length !== s.fnAbi.inputs.length) {
      this.fail(
        `${what}: arity mismatch — ${s.args.length} args for ${s.fnAbi.inputs.length} ABI inputs`,
        s.loc,
      );
    }
    s.args.forEach((a, i) => {
      const p = s.fnAbi.inputs[i];
      if (p === undefined) return; // unreachable: lengths checked above
      this.use(a, abiParamToType(p), `${what} arg ${i} ("${p.name}")`, s.loc);
    });
    if (s.outs.length !== s.fnAbi.outputs.length) {
      this.fail(
        `${what}: arity mismatch — ${s.outs.length} outs for ${s.fnAbi.outputs.length} ABI outputs`,
        s.loc,
      );
    }
    s.outs.forEach((out, i) => {
      const p = s.fnAbi.outputs[i];
      if (p === undefined) return; // unreachable: lengths checked above
      this.define(out, abiParamToType(p), `${what} out ${i} ("${p.name}")`, s.loc);
    });
    if (s.mode === 'try') {
      if (s.successOut === undefined) {
        this.fail(`${what}: a try-mode call must define successOut`, s.loc);
      }
      this.define(s.successOut, 'bool', `${what} successOut`, s.loc);
    } else if (s.successOut !== undefined) {
      this.fail(`${what}: successOut is only legal when mode === 'try'`, s.loc);
    }
    if (s.gas !== undefined) this.use(s.gas, 'uint256', `${what} gas`, s.loc);
  }

  private checkPlainAbi(fnAbi: PlainAbiFunction, what: string, loc: SourceLoc | null): void {
    if (fnAbi.name.length === 0) this.fail(`${what}: fnAbi.name must be non-empty`, loc);
    if (!SELECTOR_RE.test(fnAbi.selector)) {
      this.fail(
        `${what}: fnAbi.selector must be a 4-byte hex string, got ${JSON.stringify(fnAbi.selector)}`,
        loc,
      );
    }
    this.checkAbiParams(fnAbi.inputs, `${what} fnAbi.inputs`, loc);
    this.checkAbiParams(fnAbi.outputs, `${what} fnAbi.outputs`, loc);
  }

  private checkAbiParams(
    params: readonly PlainAbiParam[],
    what: string,
    loc: SourceLoc | null,
  ): void {
    params.forEach((p, i) => this.checkAbiParam(p, `${what}[${i}] ("${p.name}")`, loc));
  }

  private checkAbiParam(p: PlainAbiParam, what: string, loc: SourceLoc | null): void {
    if (p.type.startsWith('tuple')) {
      if (p.type !== 'tuple' && p.type !== 'tuple[]' && p.type !== 'tuple[][]') {
        this.fail(`${what}: unsupported tuple array depth ${JSON.stringify(p.type)}`, loc);
      }
      if (p.components === undefined || p.components.length === 0) {
        this.fail(`${what}: tuple type carries no components`, loc);
      }
      p.components.forEach((c, j) =>
        this.checkAbiParam(c, `${what}.components[${j}] ("${c.name}")`, loc),
      );
      return;
    }
    if (p.components !== undefined) {
      this.fail(`${what}: non-tuple type '${p.type}' must not carry components`, loc);
    }
    if (!isEvsType(p.type)) {
      this.fail(`${what}: type outside the supported set: ${JSON.stringify(p.type)}`, loc);
    }
  }

  /** Element type of an `arrnew`. Word elements only for now (composite-element arrays are a
   *  follow-up); the IR node admits any {@link EvsType} for forward-compatibility. */
  private checkElemType(elem: EvsType, what: string, loc: SourceLoc | null): WordType {
    if (!isWordType(elem)) {
      this.fail(
        `${what}: array element type must be a word type, got ${JSON.stringify(elem)}`,
        loc,
      );
    }
    return elem;
  }

  // -------------------------------------------------------------------------
  // const payload checks (canonical word invariant — architecture §5)
  // -------------------------------------------------------------------------

  private checkConstData(
    type: EvsType,
    data: { kind: 'word' | 'data'; hex: string },
    what: string,
    loc: SourceLoc | null,
  ): void {
    if (isWordType(type)) {
      if (data.kind !== 'word') {
        this.fail(
          `${what}: const of word type '${stringifyType(type)}' must carry kind 'word'`,
          loc,
        );
      }
      if (!WORD_HEX_RE.test(data.hex)) {
        this.fail(`${what}: word const hex must be exactly 32 bytes`, loc);
      }
      const x = BigInt(data.hex);
      if (!isCanonicalWord(type, x)) {
        this.fail(`${what}: ${data.hex} is not a canonical '${stringifyType(type)}' word`, loc);
      }
      return;
    }
    // dynamic type — pre-encoded memref payload [len:32][payload…]
    if (data.kind !== 'data') {
      this.fail(
        `${what}: const of dynamic type '${stringifyType(type)}' must carry kind 'data'`,
        loc,
      );
    }
    if (!DATA_HEX_RE.test(data.hex)) {
      this.fail(`${what}: data const hex is malformed`, loc);
    }
    const totalBytes = (data.hex.length - 2) / 2;
    if (totalBytes < 32) {
      this.fail(`${what}: memref data must start with a 32-byte length word`, loc);
    }
    const len = BigInt(`0x${data.hex.slice(2, 66)}`);
    const payload = BigInt(totalBytes - 32);
    if (isArrayType(type)) {
      if (payload !== 32n * len) {
        this.fail(
          `${what}: array memref payload is ${payload} bytes, expected 32 × len = ${32n * len}`,
          loc,
        );
      }
      const elem = elemTypeOf(type);
      if (!isWordType(elem)) {
        this.fail(
          `${what}: only word-element array consts are supported, got '${stringifyType(type)}'`,
          loc,
        );
      }
      const count = Number(len);
      for (let i = 0; i < count; i++) {
        const word = BigInt(`0x${data.hex.slice(66 + i * 64, 66 + (i + 1) * 64)}`);
        if (!isCanonicalWord(elem, word)) {
          this.fail(`${what}: array element ${i} is not a canonical '${elem}' word`, loc);
        }
      }
      return;
    }
    // string | bytes: payload is the raw bytes, zero-padded to at most the next 32-byte boundary
    const padded = ((len + 31n) >> 5n) << 5n;
    if (payload < len || payload > padded) {
      this.fail(
        `${what}: bytes/string memref payload is ${payload} bytes for declared length ${len} (expected between ${len} and ${padded})`,
        loc,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// type-table helpers
// ---------------------------------------------------------------------------

function isArrayType(s: EvsType): s is ArrayType {
  return typeof s === 'string' && s.endsWith('[]');
}

/** `${WordType}[]` for an `arrnew` whose element validated as a word type. */
function arrayOf(elem: WordType): ArrayType {
  return `${elem}[]`;
}

/** Human-readable rendering of a value type for error messages (tuples → their components). */
function stringifyType(t: EvsType): string {
  return typeof t === 'string' ? t : JSON.stringify(t);
}

/** bitwise/shift operand domain per architecture §6: uintN, intN, bytesN. */
function isBitsOperand(s: EvsType): boolean {
  return isWordType(s) && s !== 'address' && s !== 'bool';
}

/** legal `convert` pairs per architecture §6. */
function convertOk(from: EvsType, to: EvsType): boolean {
  if (isNumeric(from) && isNumeric(to)) return true; // free widening / checked narrowing
  if ((from === 'uint256' || from === 'bytes32') && to === 'address') return true; // asAddress
  if (from === 'bytes32' && to === 'uint256') return true; // free reinterpret
  if (from === 'uint256' && to === 'bytes32') return true; // free reinterpret
  return false;
}

/** canonical word invariant per architecture §5. */
function isCanonicalWord(type: WordType, x: bigint): boolean {
  if (type === 'bool') return x === 0n || x === 1n;
  if (type === 'address') return x < 1n << 160n;
  const bits = BigInt(bitsOf(type));
  if (isNumeric(type)) {
    if (!isSigned(type)) return x < 1n << bits; // uintN: zero-extended
    // intN: sign-extended
    const low = x & ((1n << bits) - 1n);
    const negative = low >> (bits - 1n) === 1n;
    const extended = negative ? low | (((1n << 256n) - 1n) ^ ((1n << bits) - 1n)) : low;
    return x === extended;
  }
  // bytesN: left-aligned — the trailing 256−8N bits must be zero
  return (x & ((1n << (256n - bits)) - 1n)) === 0n;
}
