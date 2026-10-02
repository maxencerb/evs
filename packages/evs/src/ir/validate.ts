/**
 * `ir/validate.ts` — whole-program semantic validation of a `ScriptIr`.
 *
 * Re-checks the builder's invariants so deserialized IR cannot reach codegen in a shape the
 * builder never records (`deserializeIr → validateIr` is the trust boundary): every type in the
 * tables and ABIs (no zero-component tuple, at most `MAX_ARRAY_DEPTH` array levels, no ABI-static
 * level of `MAX_STATIC_SIZE` bytes or more), operand types per the op table, def-before-use under
 * the scope rule (a `while` header dominates its body; `if`/`else` branches are isolated; `fn`
 * bodies see params only), unknown ids, single static assignment of every ValueId, cell
 * creation/typing/scoping, `break`/`continue` only inside a loop body, call-graph acyclicity,
 * return names, fnAbi type validity, `successOut` ⇔ try mode, and in-place writes only where the
 * builder emits them (`arrset` on an `arrnew`).
 *
 * One builder rule is deliberately NOT an IR rule: `returns` may be empty. The builder refuses
 * `s.return({})` because viem cannot decode empty returndata, but an empty-returns program is
 * well-formed (it returns `0x`, identically in the interpreter and the bytecode), and IR-level
 * fixtures rely on it.
 *
 * Script args bind positionally to the first `args.length` entries of the value table
 * (ValueIds `0 … args.length-1`) — the only binding the `ScriptIr` shape admits, since
 * `args` entries carry no explicit ValueId and no "load arg" statement kind exists.
 *
 * All failures throw `EvsInternalError` (compiler-produced IR is supposed to be valid — a
 * failure here means a bug in whichever producer built the IR), except the `MAX_STATIC_SIZE`
 * gate: the builder records a raw-ABI tuple param whose members each fit but whose total does
 * not, so that gate throws the `EvsTypeError` (`UNSUPPORTED_V0`) of the `t` constructors and
 * `abi/layout`.
 */

import { EvsInternalError } from '../core/errors.js';
import {
  abiParamToType,
  arrayDepthOf,
  arrayTypeOf,
  bitsOf,
  elemTypeOf,
  fixedLengthOf,
  gateStaticLevels,
  IDENT_RE,
  identProblem,
  isArrayValueType,
  isBitsOperand,
  isBytesN,
  isStringType,
  isEvsValueType,
  describeRejectedType,
  isLengthType,
  isNumeric,
  isOrdered,
  isPackedEncodable,
  isSigned,
  isTupleTag,
  isTupleType,
  isWordType,
  wordStaticSize,
  MAX_ARRAY_DEPTH,
  repeatedMemberName,
  stringifyType,
  typeToAbiParam,
  typesEqual,
  type ArrayType,
  type EvsType,
  type TupleType,
  type WordType,
} from '../core/types.js';
import {
  callOutputs,
  type CellId,
  type FnId,
  type PlainAbiFunction,
  type PlainAbiParam,
  type ScriptIr,
  type Stmt,
  type ValueId,
} from './nodes.js';

export function validateIr(ir: ScriptIr): void {
  new IrValidator(ir).run();
}

// ---------------------------------------------------------------------------
// implementation (module-private)
// ---------------------------------------------------------------------------

const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
const WORD_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const DATA_HEX_RE = /^0x(?:[0-9a-fA-F]{2})+$/;

/** The statement variant(s) of kind `K`. */
type StmtOf<K extends Stmt['k']> = Extract<Stmt, { k: K }>;

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
  /** word-const ValueIds → their canonical value (a fixed-size `arrnew` must take a const length
   *  equal to its declared `fixed` size, so the memory length word always equals `N`) */
  private readonly constWords = new Map<ValueId, bigint>();
  /** ValueIds defined by an `arrnew`: the only blocks an `arrset` may write. Every other array
   *  value may alias memory the program does not own — a full-word `T[]` call output, or a
   *  full-word array inside a composite arg, points into the returndata/calldata snapshot,
   *  whose bytes two decoded values can share — so writing it would make the bytecode diverge
   *  from the interpreter's fresh copies. The builder only hands out `MutArray` handles over
   *  `s.newArray` results, so it never emits anything else. */
  private readonly arrnewOuts = new Set<ValueId>();
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

  private fail(msg: string): never {
    throw new EvsInternalError(`INTERNAL`, `invalid ScriptIr "${this.ir.name}": ${msg}`);
  }

  // -------------------------------------------------------------------------
  // table sanity (types of values/cells/args/fn signatures)
  // -------------------------------------------------------------------------

  private checkTables(): void {
    const { ir } = this;
    ir.values.forEach((info, i) => this.checkValueType(info.type, `values[${i}]`));
    ir.cells.forEach((info, i) => this.checkValueType(info.type, `cells[${i}]`));
    const argNames = new Set<string>();
    ir.args.forEach((a, i) => {
      if (!IDENT_RE.test(a.name)) {
        this.fail(
          `args[${i}] has an invalid name ${JSON.stringify(a.name)}: ${identProblem(a.name)}`,
        );
      }
      if (argNames.has(a.name)) this.fail(`duplicate arg name "${a.name}"`);
      argNames.add(a.name);
      this.checkValueType(a.type, `args[${i}] ("${a.name}")`);
      const backing = ir.values[i];
      if (backing === undefined) {
        this.fail(
          `args[${i}] ("${a.name}") has no backing value: script args bind to ValueIds 0…${ir.args.length - 1}`,
        );
      }
      if (!typesEqual(backing.type, a.type)) {
        this.fail(
          `args[${i}] ("${a.name}") is declared '${stringifyType(a.type)}' but its backing values[${i}] is '${stringifyType(backing.type)}'`,
        );
      }
    });
    ir.fns.forEach((fn, f) => {
      fn.params.forEach((p, i) => {
        this.checkValueType(p.type, `fns[${f}].params[${i}] ("${p.name}")`);
      });
      fn.results.forEach((r, i) => this.checkValueType(r.type, `fns[${f}].results[${i}]`));
    });
    // declared custom errors (issue #15): unique identifier names, 4-byte selectors, and
    // resolved (non-empty, per-error-unique) input names over evs types.
    const errorNames = new Set<string>();
    (ir.errors ?? []).forEach((e, i) => {
      if (!IDENT_RE.test(e.name)) {
        this.fail(
          `errors[${i}] has an invalid name ${JSON.stringify(e.name)}: ${identProblem(e.name)}`,
        );
      }
      if (errorNames.has(e.name)) this.fail(`duplicate error name "${e.name}"`);
      errorNames.add(e.name);
      if (!SELECTOR_RE.test(e.selector)) {
        this.fail(
          `errors[${i}] ("${e.name}") selector must be a 4-byte hex string, got ${JSON.stringify(e.selector)}`,
        );
      }
      const inputNames = new Set<string>();
      e.inputs.forEach((p, j) => {
        if (!IDENT_RE.test(p.name)) {
          this.fail(
            `errors[${i}] ("${e.name}") input #${j} has an invalid name ${JSON.stringify(p.name)}: ${identProblem(p.name)}`,
          );
        }
        if (inputNames.has(p.name)) {
          this.fail(`errors[${i}] ("${e.name}") has a duplicate input name "${p.name}"`);
        }
        inputNames.add(p.name);
        this.checkAbiParam(p, `errors[${i}] ("${e.name}") input #${j}`);
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
      this.define(i, null, `args[${i}]`);
    }
    this.walkBlock(ir.body, 'body');
    this.checkReturns();
    this.scopes = [];
  }

  private checkReturns(): void {
    const { ir } = this;
    const names = new Set<string>();
    ir.returns.forEach((r, i) => {
      if (r.name === '') this.fail(`returns[${i}] has an empty name`);
      // the names become the script ABI's output names and the decoded result's keys
      if (!IDENT_RE.test(r.name)) {
        this.fail(`returns[${i}] has an invalid name ${JSON.stringify(r.name)}`);
      }
      if (names.has(r.name)) this.fail(`duplicate return name "${r.name}"`);
      names.add(r.name);
      this.checkValueType(r.type, `returns[${i}] ("${r.name}")`);
      this.use(r.value, r.type, `returns[${i}] ("${r.name}")`);
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
        this.define(p.value, p.type, `fns[${f}].params[${i}] ("${p.name}")`);
      });
      this.walkBlock(fn.body, `fns[${f}].body`);
      if (fn.resultValues.length !== fn.results.length) {
        this.fail(
          `fns[${f}] ("${fn.name}") has ${fn.resultValues.length} resultValues for ${fn.results.length} results`,
        );
      }
      fn.resultValues.forEach((rv, i) => {
        const result = fn.results[i];
        if (result === undefined) return; // unreachable: lengths checked above
        this.use(rv, result.type, `fns[${f}].resultValues[${i}]`);
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
        this.fail(`call-graph cycle: ${cycle}`);
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
  private define(id: ValueId, producedType: EvsType | null, what: string): void {
    const info = this.ir.values[id];
    if (info === undefined) this.fail(`${what}: unknown ValueId ${id}`);
    if (this.valueDefined[id] === true) {
      this.fail(`${what}: ValueId ${id} is defined more than once`);
    }
    if (producedType !== null && !typesEqual(info.type, producedType)) {
      this.fail(
        `${what}: values[${id}] is declared '${stringifyType(info.type)}' but the statement produces '${stringifyType(producedType)}'`,
      );
    }
    this.valueDefined[id] = true;
    this.top().values.add(id);
  }

  /**
   * Checks that `id` is usable here (defined earlier, in a scope currently on the stack) and,
   * when `expected` is non-null, that it has the expected type. Returns the operand's type.
   */
  private use(id: ValueId, expected: EvsType | null, what: string): EvsType {
    const info = this.ir.values[id];
    if (info === undefined) this.fail(`${what}: unknown ValueId ${id}`);
    if (!this.scopes.some((s) => s.values.has(id))) {
      if (this.valueDefined[id] === true) {
        this.fail(`${what}: ValueId ${id} is used outside its defining scope`);
      }
      this.fail(`${what}: ValueId ${id} is used before it is defined`);
    }
    if (expected !== null && !typesEqual(info.type, expected)) {
      this.fail(
        `${what}: operand type mismatch — expected '${stringifyType(expected)}', got values[${id}] of type '${stringifyType(info.type)}'`,
      );
    }
    return info.type;
  }

  private cellInfo(cell: CellId, what: string): { type: EvsType } {
    const info = this.ir.cells[cell];
    if (info === undefined) this.fail(`${what}: unknown CellId ${cell}`);
    return info;
  }

  private useCell(cell: CellId, what: string): EvsType {
    const info = this.cellInfo(cell, what);
    if (!this.scopes.some((s) => s.cells.has(cell))) {
      if (this.cellCreated[cell] === true) {
        this.fail(`${what}: CellId ${cell} is used outside its defining scope`);
      }
      this.fail(`${what}: CellId ${cell} is used before its cellnew`);
    }
    return info.type;
  }

  // -------------------------------------------------------------------------
  // statement walk — `checkStmt` dispatches each kind to its family's checker
  // -------------------------------------------------------------------------

  private walkBlock(stmts: readonly Stmt[], path: string): void {
    stmts.forEach((s, i) => {
      this.checkStmt(s, `${path}[${i}]`);
    });
  }

  private checkStmt(s: Stmt, path: string): void {
    switch (s.k) {
      case 'const':
        return this.checkConst(s, path);
      case 'bin':
        return this.checkBin(s, path);
      case 'modarith':
      case 'un':
      case 'env':
      case 'account':
      case 'convert':
      case 'select':
        return this.checkWordOp(s, path);
      case 'index':
      case 'slice':
      case 'len':
      case 'arrnew':
      case 'arrset':
        return this.checkArrayStmt(s, path);
      case 'tuplenew':
      case 'field':
      case 'tupleset':
        return this.checkTupleStmt(s, path);
      case 'encode':
      case 'keccak256':
        return this.checkBytesStmt(s, path);
      case 'throw':
        return this.checkThrow(s, path);
      case 'cellnew':
      case 'cellget':
      case 'cellset':
        return this.checkCellStmt(s, path);
      case 'call':
        return this.checkCall(s, path);
      case 'fncall':
        return this.checkFnCall(s, path);
      case 'if':
      case 'while':
      case 'break':
      case 'continue':
        return this.checkControl(s, path);
      default:
        return this.unknownStmt(s, path);
    }
  }

  /**
   * The `default` of every statement switch: `s: never` makes a missing case a compile error,
   * and the runtime throw rejects hand-built garbage (deserialized IR is shape-checked first).
   */
  private unknownStmt(s: never, path: string): never {
    const kind = String((s as { k?: unknown }).k);
    return this.fail(`${path}: unknown statement kind '${kind}'`);
  }

  private checkConst(s: StmtOf<'const'>, path: string): void {
    const what = `${path} (const)`;
    if (!isEvsValueType(s.type) || isTupleType(s.type)) {
      this.fail(`${what}: unsupported / non-const type ${JSON.stringify(s.type)}`);
    }
    this.checkConstData(s.type, s.data, what);
    this.define(s.out, s.type, what);
    if (s.data.kind === 'word') this.constWords.set(s.out, BigInt(s.data.hex));
  }

  private checkBin(s: StmtOf<'bin'>, path: string): void {
    const what = `${path} (bin ${s.op})`;
    switch (s.op) {
      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
      case 'mod':
      case 'wrapadd':
      case 'wrapsub':
      case 'wrapmul': {
        const ta = this.use(s.a, null, what);
        if (!isNumeric(ta)) {
          this.fail(`${what}: operands must be numeric (uintN/intN), got '${stringifyType(ta)}'`);
        }
        this.use(s.b, ta, what);
        this.define(s.out, ta, what);
        return;
      }
      case 'pow': {
        // checked exponentiation (issue #10): numeric base, UNSIGNED exponent of any width (solc)
        const ta = this.use(s.a, null, what);
        if (!isNumeric(ta)) {
          this.fail(`${what}: base must be numeric (uintN/intN), got '${stringifyType(ta)}'`);
        }
        const tb = this.use(s.b, null, `${what} exponent`);
        if (!isNumeric(tb) || isSigned(tb)) {
          this.fail(`${what}: exponent must be an unsigned uintN, got '${stringifyType(tb)}'`);
        }
        this.define(s.out, ta, what);
        return;
      }
      case 'lt':
      case 'gt':
      case 'lte':
      case 'gte': {
        const ta = this.use(s.a, null, what);
        if (!isOrdered(ta)) {
          this.fail(
            `${what}: operands must be ordered (uintN/intN/address/bytesN), got '${stringifyType(ta)}'`,
          );
        }
        this.use(s.b, ta, what);
        this.define(s.out, 'bool', what);
        return;
      }
      case 'eq':
      case 'neq': {
        const ta = this.use(s.a, null, what);
        if (!isWordType(ta)) {
          this.fail(
            `${what}: eq/neq are word-type-only (memref equality is undefined), got '${stringifyType(ta)}'`,
          );
        }
        this.use(s.b, ta, what);
        this.define(s.out, 'bool', what);
        return;
      }
      case 'and':
      case 'or': {
        this.use(s.a, 'bool', what);
        this.use(s.b, 'bool', what);
        this.define(s.out, 'bool', what);
        return;
      }
      case 'bitand':
      case 'bitor':
      case 'bitxor': {
        const ta = this.use(s.a, null, what);
        if (!isBitsOperand(ta)) {
          this.fail(`${what}: operands must be uintN/intN/bytesN, got '${stringifyType(ta)}'`);
        }
        this.use(s.b, ta, what);
        this.define(s.out, ta, what);
        return;
      }
      case 'shl':
      case 'shr': {
        const ta = this.use(s.a, null, what);
        if (!isBitsOperand(ta)) {
          this.fail(
            `${what}: shifted operand must be uintN/intN/bytesN, got '${stringifyType(ta)}'`,
          );
        }
        this.use(s.b, 'uint256', `${what} shift amount`);
        this.define(s.out, ta, what);
        return;
      }
      default: {
        const op: never = s.op; // a compile error here means a BinOp has no case
        this.fail(`${what}: unknown bin op '${String(op)}'`);
      }
    }
  }

  /**
   * The other single-word operations: addmod/mulmod/muldiv/muldivup, unary ops, env and account
   * reads, convert, select.
   */
  private checkWordOp(
    s: StmtOf<'modarith' | 'un' | 'env' | 'account' | 'convert' | 'select'>,
    path: string,
  ): void {
    switch (s.k) {
      case 'modarith': {
        // addmod / mulmod (issue #10) and muldiv / muldivup: uint256 only, like Solidity's
        // builtins and FullMath
        const what = `${path} (modarith ${s.op})`;
        const { op } = s;
        let third: string;
        switch (op) {
          case 'addmod':
          case 'mulmod':
            third = 'modulus';
            break;
          case 'muldiv':
          case 'muldivup':
            third = 'denominator';
            break;
          default: {
            const unknown: never = op; // a compile error here means a ModArithOp has no case
            return this.fail(`${what}: unknown modarith op '${String(unknown)}'`);
          }
        }
        this.use(s.a, 'uint256', what);
        this.use(s.b, 'uint256', what);
        this.use(s.n, 'uint256', `${what} ${third}`);
        this.define(s.out, 'uint256', what);
        return;
      }
      case 'un': {
        const what = `${path} (un ${s.op})`;
        const { op } = s;
        switch (op) {
          case 'not': {
            this.use(s.a, 'bool', what);
            this.define(s.out, 'bool', what);
            return;
          }
          case 'iszero': {
            const ta = this.use(s.a, null, what);
            if (!isWordType(ta)) {
              this.fail(`${what}: operand must be a word type, got '${stringifyType(ta)}'`);
            }
            this.define(s.out, 'bool', what);
            return;
          }
          case 'bitnot': {
            const ta = this.use(s.a, null, what);
            if (!isBitsOperand(ta)) {
              this.fail(`${what}: operand must be uintN/intN/bytesN, got '${stringifyType(ta)}'`);
            }
            this.define(s.out, ta, what);
            return;
          }
          default: {
            const unknown: never = op; // a compile error here means a UnOp has no case
            return this.fail(`${what}: unknown un op '${String(unknown)}'`);
          }
        }
      }
      case 'env': {
        const what = `${path} (env ${s.op})`;
        const { op } = s;
        switch (op) {
          case 'address':
          case 'caller':
            this.define(s.out, 'address', what);
            return;
          case 'timestamp':
          case 'blocknumber':
          case 'chainid':
            this.define(s.out, 'uint256', what);
            return;
          default: {
            const unknown: never = op; // a compile error here means an EnvOp has no case
            return this.fail(`${what}: unknown env op '${String(unknown)}'`);
          }
        }
      }
      case 'account': {
        const what = `${path} (account ${s.op})`;
        const { op } = s;
        let out: EvsType;
        switch (op) {
          case 'balance':
          case 'codesize':
            out = 'uint256';
            break;
          case 'codehash':
            out = 'bytes32';
            break;
          default: {
            const unknown: never = op; // a compile error here means an AccountOp has no case
            return this.fail(`${what}: unknown account op '${String(unknown)}'`);
          }
        }
        this.use(s.a, 'address', what);
        this.define(s.out, out, what);
        return;
      }
      case 'convert': {
        const what = `${path} (convert)`;
        const from = this.use(s.a, null, what);
        const to = this.declaredType(s.out, what);
        if (!convertOk(from, to)) {
          this.fail(
            `${what}: no conversion from '${stringifyType(from)}' to '${stringifyType(to)}' (legal: uintN/intN → uintN/intN, uint256|bytes32|uint160 → address, address → uint160, bytesN ↔ the same-width uintN, string ↔ bytes, bytesN → string)`,
          );
        }
        this.define(s.out, to, what);
        return;
      }
      case 'select': {
        const what = `${path} (select)`;
        this.use(s.cond, 'bool', what);
        const ta = this.use(s.a, null, what);
        this.use(s.b, ta, what);
        this.define(s.out, ta, what);
        return;
      }
      default:
        return this.unknownStmt(s, path);
    }
  }

  // -------------------------------------------------------------------------
  // memrefs: arrays, tuples, bytes
  // -------------------------------------------------------------------------

  private checkArrayStmt(
    s: StmtOf<'index' | 'slice' | 'len' | 'arrnew' | 'arrset'>,
    path: string,
  ): void {
    const what = `${path} (${s.k})`;
    switch (s.k) {
      case 'index': {
        const ta = this.use(s.arr, null, what);
        this.use(s.i, 'uint256', what);
        if (ta === 'string' || ta === 'bytes') {
          this.define(s.out, 'bytes1', what); // `.byteAt(i)`
          return;
        }
        if (!isArrayValueType(ta)) {
          this.fail(
            `${what}: operand must be a T[] array or string/bytes, got '${stringifyType(ta)}'`,
          );
        }
        this.define(s.out, elemTypeOf(ta), what);
        return;
      }
      case 'slice': {
        const ta = this.use(s.a, null, what);
        if (ta !== 'string' && ta !== 'bytes') {
          this.fail(`${what}: operand must be string/bytes, got '${stringifyType(ta)}'`);
        }
        this.use(s.start, 'uint256', `${what} start`);
        this.use(s.end, 'uint256', `${what} end`);
        this.define(s.out, ta, what);
        return;
      }
      case 'len': {
        const ta = this.use(s.a, null, what);
        // string/bytes or any array (word/string/tuple element) — a PLAIN tuple has no length.
        if (!isLengthType(ta)) {
          this.fail(`${what}: operand must be string/bytes/T[], got '${stringifyType(ta)}'`);
        }
        this.define(s.out, 'uint256', what);
        return;
      }
      case 'arrnew': {
        const elem = this.checkElemType(s.elem, what);
        this.use(s.length, 'uint256', what);
        if (s.fixed !== undefined) this.checkFixedLength(s.fixed, s.length, what);
        this.define(s.out, arrayTypeOf(elem, s.fixed ?? null), what); // elem validated by checkElemType
        this.arrnewOuts.add(s.out);
        return;
      }
      case 'arrset': {
        const ta = this.useArray(s.arr, what);
        if (!this.arrnewOuts.has(s.arr)) {
          this.fail(
            `${what}: ValueId ${s.arr} is not an arrnew result — only arrays built by arrnew (s.newArray) can be written in place`,
          );
        }
        this.use(s.i, 'uint256', what);
        this.use(s.value, elemTypeOf(ta), what);
        return;
      }
      default:
        return this.unknownStmt(s, path);
    }
  }

  /** Uses `id` as the array operand of `arrset`: any `T[]` / `T[N]` value. */
  private useArray(id: ValueId, what: string): ArrayType | TupleType {
    const ta = this.use(id, null, what);
    if (!isArrayValueType(ta)) {
      this.fail(`${what}: operand must be a T[] array, got '${stringifyType(ta)}'`);
    }
    return ta;
  }

  /**
   * A fixed-size `arrnew` (`elem[N]`): the length operand must be the word const N, so the
   * block's length word (what `.length`/encode/decode all read) provably equals N.
   */
  private checkFixedLength(fixed: number, length: ValueId, what: string): void {
    if (!Number.isSafeInteger(fixed) || fixed < 1 || fixed > 0xffffffff) {
      this.fail(`${what}: fixed length must be an integer in [1, 2^32), got ${fixed}`);
    }
    const lit = this.constWords.get(length);
    if (lit === undefined || lit !== BigInt(fixed)) {
      this.fail(
        `${what}: a fixed-size arrnew (${fixed}) must take a word const length equal to ${fixed}${lit === undefined ? ' (the length operand is not a const)' : ` (got ${lit})`}`,
      );
    }
  }

  private checkTupleStmt(s: StmtOf<'tuplenew' | 'field' | 'tupleset'>, path: string): void {
    const what = `${path} (${s.k})`;
    switch (s.k) {
      case 'tuplenew': {
        const tt = this.declaredType(s.out, what);
        // a plain tuple only: a tuple ARRAY tag (`tuple[]`, `tuple[2]`) would make codegen lay
        // out a flat member block that every later array op reads as `[len][elements…]`
        if (!isTupleType(tt) || tt.type !== 'tuple') {
          this.fail(`${what}: out value must be a plain tuple type, got '${stringifyType(tt)}'`);
        }
        const seen = new Set<number>();
        s.inits.forEach((init, j) => {
          const comp = tt.components[init.index];
          if (comp === undefined) {
            this.fail(`${what}: init #${j} index ${init.index} out of range`);
          }
          if (seen.has(init.index)) {
            this.fail(`${what}: init #${j} writes member ${init.index} twice`);
          }
          seen.add(init.index);
          this.use(init.value, abiParamToType(comp), `${what} init #${j}`);
        });
        this.define(s.out, tt, what);
        return;
      }
      case 'field':
        this.define(s.out, this.tupleMember(s.tuple, s.index, what), what);
        return;
      case 'tupleset':
        this.use(s.value, this.tupleMember(s.tuple, s.index, what), `${what} value`);
        return;
      default:
        return this.unknownStmt(s, path);
    }
  }

  /** The type of member `index` of the plain-tuple operand `tuple` (`field` / `tupleset`). */
  private tupleMember(tuple: ValueId, index: number, what: string): EvsType {
    const ta = this.use(tuple, null, what);
    if (!isTupleType(ta) || ta.type !== 'tuple') {
      this.fail(`${what}: operand must be a tuple, got '${stringifyType(ta)}'`);
    }
    const comp = ta.components[index];
    if (comp === undefined) {
      this.fail(`${what}: member index ${index} out of range`);
    }
    return abiParamToType(comp);
  }

  private checkBytesStmt(s: StmtOf<'encode' | 'keccak256'>, path: string): void {
    switch (s.k) {
      case 'encode': {
        const what = `${path} (encode ${s.mode})`;
        if (s.args.length === 0) {
          this.fail(`${what}: at least one value is required`);
        }
        s.args.forEach((a, i) => {
          const ta = this.use(a, null, `${what} value #${i}`);
          if (s.mode === 'packed' && !isPackedEncodable(ta)) {
            this.fail(
              `${what} value #${i}: '${stringifyType(ta)}' cannot be packed-encoded (abi.encodePacked supports words, string/bytes, and word-element arrays only)`,
            );
          }
        });
        this.define(s.out, 'bytes', what);
        return;
      }
      case 'keccak256': {
        const what = `${path} (keccak256)`;
        const ta = this.use(s.a, null, what);
        if (ta !== 'bytes' && ta !== 'string') {
          this.fail(`${what}: operand must be bytes/string, got '${stringifyType(ta)}'`);
        }
        this.define(s.out, 'bytes32', what);
        return;
      }
      default:
        return this.unknownStmt(s, path);
    }
  }

  /** The type the value table declares for `id` — for statements whose output type is not
   *  derived from their operands (`convert`'s target, `tuplenew`'s tuple). */
  private declaredType(id: ValueId, what: string): EvsType {
    const info = this.ir.values[id];
    if (info === undefined) this.fail(`${what}: unknown ValueId ${id}`);
    return info.type;
  }

  // -------------------------------------------------------------------------
  // cells
  // -------------------------------------------------------------------------

  private checkCellStmt(s: StmtOf<'cellnew' | 'cellget' | 'cellset'>, path: string): void {
    const what = `${path} (${s.k})`;
    switch (s.k) {
      case 'cellnew': {
        const cell = this.cellInfo(s.cell, what);
        if (this.cellCreated[s.cell] === true) {
          this.fail(`${what}: cellnew for CellId ${s.cell} appears more than once`);
        }
        this.use(s.init, cell.type, what);
        this.cellCreated[s.cell] = true;
        this.top().cells.add(s.cell);
        return;
      }
      case 'cellget':
        this.define(s.out, this.useCell(s.cell, what), what);
        return;
      case 'cellset':
        this.use(s.value, this.useCell(s.cell, what), what);
        return;
      default:
        return this.unknownStmt(s, path);
    }
  }

  // -------------------------------------------------------------------------
  // control flow + reverts
  // -------------------------------------------------------------------------

  private checkControl(s: StmtOf<'if' | 'while' | 'break' | 'continue'>, path: string): void {
    switch (s.k) {
      case 'if': {
        this.use(s.cond, 'bool', `${path} (if)`);
        this.scopes.push(newScope());
        this.walkBlock(s.then, `${path}.then`);
        this.scopes.pop();
        this.scopes.push(newScope());
        this.walkBlock(s.else, `${path}.else`);
        this.scopes.pop();
        return;
      }
      case 'while': {
        // the body scope is a child of the header scope: header values dominate the body
        this.scopes.push(newScope());
        this.walkBlock(s.header, `${path}.header`);
        this.use(s.cond, 'bool', `${path} (while) cond`);
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
          this.fail(`${path}: '${s.k}' outside a while body`);
        }
        return;
      }
      default:
        return this.unknownStmt(s, path);
    }
  }

  private checkThrow(s: StmtOf<'throw'>, path: string): void {
    const err = (this.ir.errors ?? [])[s.error];
    if (err === undefined) {
      this.fail(`${path} (throw): unknown error index ${s.error}`);
    }
    const what = `${path} (throw "${err.name}")`;
    if (s.args.length !== err.inputs.length) {
      this.fail(
        `${what}: arity mismatch — ${s.args.length} args for ${err.inputs.length} declared inputs`,
      );
    }
    s.args.forEach((a, i) => {
      const p = err.inputs[i];
      if (p === undefined) return; // unreachable: lengths checked above
      this.use(a, abiParamToType(p), `${what} arg ${i} ("${p.name}")`);
    });
  }

  // -------------------------------------------------------------------------
  // calls: internal fns + external sub-calls
  // -------------------------------------------------------------------------

  private checkFnCall(s: StmtOf<'fncall'>, path: string): void {
    const what = `${path} (fncall)`;
    const fn = this.ir.fns[s.fn];
    if (fn === undefined) this.fail(`${what}: unknown FnId ${s.fn}`);
    if (s.args.length !== fn.params.length) {
      this.fail(
        `${what}: arity mismatch — ${s.args.length} args for fns[${s.fn}] ("${fn.name}") with ${fn.params.length} params`,
      );
    }
    s.args.forEach((a, i) => {
      const p = fn.params[i];
      if (p === undefined) return; // unreachable: lengths checked above
      this.use(a, p.type, `${what} arg ${i} ("${p.name}")`);
    });
    if (s.outs.length !== fn.results.length) {
      this.fail(
        `${what}: arity mismatch — ${s.outs.length} outs for fns[${s.fn}] ("${fn.name}") with ${fn.results.length} results`,
      );
    }
    s.outs.forEach((out, i) => {
      const r = fn.results[i];
      if (r === undefined) return; // unreachable: lengths checked above
      this.define(out, r.type, `${what} out ${i}`);
    });
    if (this.currentFn !== null) this.fnCalls[this.currentFn]?.add(s.fn);
  }

  private checkCall(s: StmtOf<'call'>, path: string): void {
    const what = `${path} (call${s.mode === 'try' ? ' try' : ''} "${s.fnAbi.name}")`;
    if (s.kind !== undefined && s.kind !== 'static' && s.kind !== 'call' && s.kind !== 'simulate') {
      this.fail(`${what}: kind must be 'static' | 'call' | 'simulate', got ${String(s.kind)}`);
    }
    this.use(s.target, 'address', `${what} target`);
    this.checkPlainAbi(s.fnAbi, what);
    if (s.args.length !== s.fnAbi.inputs.length) {
      this.fail(
        `${what}: arity mismatch — ${s.args.length} args for ${s.fnAbi.inputs.length} ABI inputs`,
      );
    }
    s.args.forEach((a, i) => {
      const p = s.fnAbi.inputs[i];
      if (p === undefined) return; // unreachable: lengths checked above
      this.use(a, abiParamToType(p), `${what} arg ${i} ("${p.name}")`);
    });
    // revert-data-as-result (issue #35): `revertReturns` replaces the ABI outputs as the decode
    // schema. It is a `kind: 'call'` feature only (STATICCALL reads have no reverting-quoter use;
    // the simulate trampoline carries its own revert framing). `callOutputs` reads each entry, so
    // it runs only after the entries passed the type guard below.
    if (s.revertReturns !== undefined) {
      if (s.kind !== 'call') {
        this.fail(
          `${what}: revertReturns is only legal when kind === 'call' (s.call / s.tryCall), got kind ${s.kind === undefined ? "'static' (absent)" : `'${s.kind}'`}`,
        );
      }
      s.revertReturns.forEach((ty, i) => {
        if (!isEvsValueType(ty)) {
          this.fail(`${what}: revertReturns[${i}] is not a supported EvsType`);
        }
      });
      this.checkAbiParams(callOutputs(s), `${what} revertReturns`);
    }
    const outputs = callOutputs(s);
    const schema = s.revertReturns === undefined ? 'ABI outputs' : 'revertReturns';
    if (s.outs.length !== outputs.length) {
      this.fail(`${what}: arity mismatch — ${s.outs.length} outs for ${outputs.length} ${schema}`);
    }
    s.outs.forEach((out, i) => {
      const p = outputs[i];
      if (p === undefined) return; // unreachable: lengths checked above
      this.define(out, abiParamToType(p), `${what} out ${i} ("${p.name}")`);
    });
    if (s.mode === 'try') {
      if (s.successOut === undefined) {
        this.fail(`${what}: a try-mode call must define successOut`);
      }
      this.define(s.successOut, 'bool', `${what} successOut`);
    } else if (s.successOut !== undefined) {
      this.fail(`${what}: successOut is only legal when mode === 'try'`);
    }
    if (s.gas !== undefined) this.use(s.gas, 'uint256', `${what} gas`);
    if (s.value !== undefined) {
      if (s.kind !== 'call' && s.kind !== 'simulate') {
        this.fail(
          `${what}: value is only legal when kind is 'call' or 'simulate' (STATICCALL sends no value), got kind ${s.kind === undefined ? "'static' (absent)" : `'${s.kind}'`}`,
        );
      }
      this.use(s.value, 'uint256', `${what} value`);
    }
  }

  // -------------------------------------------------------------------------
  // ABI params + array element types
  // -------------------------------------------------------------------------

  private checkPlainAbi(fnAbi: PlainAbiFunction, what: string): void {
    if (fnAbi.name.length === 0) this.fail(`${what}: fnAbi.name must be non-empty`);
    if (!SELECTOR_RE.test(fnAbi.selector)) {
      this.fail(
        `${what}: fnAbi.selector must be a 4-byte hex string, got ${JSON.stringify(fnAbi.selector)}`,
      );
    }
    this.checkAbiParams(fnAbi.inputs, `${what} fnAbi.inputs`);
    this.checkAbiParams(fnAbi.outputs, `${what} fnAbi.outputs`);
  }

  private checkAbiParams(params: readonly PlainAbiParam[], what: string): void {
    params.forEach((p, i) => this.checkAbiParam(p, `${what}[${i}] ("${p.name}")`));
  }

  /**
   * A type the builder can record: well-formed, no zero-component tuple at any nesting level, no
   * member name repeated within a tuple, no type string or tuple tag nested deeper than
   * {@link MAX_ARRAY_DEPTH} arrays, and no ABI-static level of {@link MAX_STATIC_SIZE} bytes or
   * more. Applied to every type the IR declares (value/cell tables, args, fn signatures, returns,
   * ABI params); a statement's result type is covered through the value table, which `define`
   * checks it against.
   */
  private checkValueType(type: EvsType, what: string): void {
    if (!isEvsValueType(type)) {
      const issue = isTupleType(type) ? ` (${describeRejectedType(type)})` : '';
      this.fail(`${what} has an unsupported type ${JSON.stringify(type)}${issue}`);
    }
    this.checkAbiParam(typeToAbiParam('', type), what);
  }

  /**
   * Checks `p` and returns its ABI static size (`null` when it is ABI-dynamic), measured bottom-up:
   * a tuple's size is its members' sum as each member's own check returned it, so gating every
   * level stays one linear pass over the param (re-measuring each subtree with `staticSizeOf`
   * would be quadratic in the tuple nesting depth).
   */
  private checkAbiParam(p: PlainAbiParam, what: string): bigint | null {
    if (p.type.startsWith('tuple')) {
      if (!isTupleTag(p.type)) {
        this.fail(`${what}: malformed tuple tag ${JSON.stringify(p.type)}`);
      }
      this.checkArrayDepth(p.type, what);
      if (p.components === undefined || p.components.length === 0) {
        this.fail(`${what}: tuple type carries no components`);
      }
      // the builder's distinct-names rule (viem decodes a named tuple into an object keyed by
      // member name): a hand-built or deserialized IR must not reintroduce a repeat
      const repeated = repeatedMemberName(p.components.map((c) => c.name));
      if (repeated !== undefined) {
        this.fail(
          `${what}: components[${repeated.repeat}] repeats the member name ${JSON.stringify(repeated.name)} (also components[${repeated.first}])`,
        );
      }
      // every member is checked (and gated on its own) before the tuple is measured: a tuple
      // with a dynamic member has no static size of its own
      let members: bigint | null = 0n;
      for (const [j, c] of p.components.entries()) {
        const member = this.checkAbiParam(c, `${what}.components[${j}] ("${c.name}")`);
        members = members === null || member === null ? null : members + member;
      }
      const sum = members;
      return gateStaticLevels(p.type, () => sum, this.sizeContext(what));
    }
    if (p.components !== undefined) {
      this.fail(`${what}: non-tuple type '${p.type}' must not carry components`);
    }
    if (!isStringType(p.type)) {
      this.fail(`${what}: type outside the supported set: ${JSON.stringify(p.type)}`);
    }
    this.checkArrayDepth(p.type, what);
    return gateStaticLevels(p.type, wordStaticSize, this.sizeContext(what));
  }

  /** The context of the `MAX_STATIC_SIZE` gate's `UNSUPPORTED_V0`, the one the `t` constructors
   *  and `abi/layout` share. */
  private sizeContext(what: string): string {
    return `ScriptIr "${this.ir.name}" ${what}`;
  }

  /** The array-depth ceiling the builder, `abi/layout` and the decoders share. */
  private checkArrayDepth(tag: string, what: string): void {
    const depth = arrayDepthOf(tag);
    if (depth > MAX_ARRAY_DEPTH) {
      this.fail(
        `${what}: ${JSON.stringify(tag)} nests arrays ${depth} levels deep — at most ${MAX_ARRAY_DEPTH} levels are supported`,
      );
    }
  }

  /**
   * Element type of an `arrnew`: any value type — a word, `string`/`bytes`, a tuple, or any array
   * (dynamic or fixed-size, to any depth: `uint256[]` → `uint256[][]`, `tuple[]` → `tuple[][]`,
   * `uint256[2]` → `uint256[2][]`, …). Only a malformed type is rejected.
   */
  private checkElemType(elem: EvsType, what: string): EvsType {
    // the same well-formedness gate as every declared type (one check, one message)
    this.checkValueType(elem, `${what} element type`);
    // the narrowed #4 gate: the resulting array must stay within MAX_ARRAY_DEPTH (the element
    // already carries up to MAX_ARRAY_DEPTH − 1 suffixes).
    const tag = typeof elem === 'string' ? elem : elem.type;
    if (arrayDepthOf(tag) >= MAX_ARRAY_DEPTH) {
      this.fail(
        `${what}: an array of ${stringifyType(elem)} nests arrays deeper than ${MAX_ARRAY_DEPTH} levels — not supported`,
      );
    }
    return elem;
  }

  // -------------------------------------------------------------------------
  // const payload checks (canonical word invariant)
  // -------------------------------------------------------------------------

  private checkConstData(
    type: EvsType,
    data: { kind: 'word' | 'data'; hex: string },
    what: string,
  ): void {
    if (isWordType(type)) {
      if (data.kind !== 'word') {
        this.fail(`${what}: const of word type '${stringifyType(type)}' must carry kind 'word'`);
      }
      if (!WORD_HEX_RE.test(data.hex)) {
        this.fail(`${what}: word const hex must be exactly 32 bytes`);
      }
      const x = BigInt(data.hex);
      if (!isCanonicalWord(type, x)) {
        this.fail(`${what}: ${data.hex} is not a canonical '${stringifyType(type)}' word`);
      }
      return;
    }
    // dynamic type — pre-encoded memref payload [len:32][payload…]
    if (data.kind !== 'data') {
      this.fail(`${what}: const of dynamic type '${stringifyType(type)}' must carry kind 'data'`);
    }
    if (!DATA_HEX_RE.test(data.hex)) {
      this.fail(`${what}: data const hex is malformed`);
    }
    const totalBytes = (data.hex.length - 2) / 2;
    if (totalBytes < 32) {
      this.fail(`${what}: memref data must start with a 32-byte length word`);
    }
    const len = BigInt(`0x${data.hex.slice(2, 66)}`);
    const payload = BigInt(totalBytes - 32);
    if (isArrayType(type)) {
      if (payload !== 32n * len) {
        this.fail(
          `${what}: array memref payload is ${payload} bytes, expected 32 × len = ${32n * len}`,
        );
      }
      const fixed = fixedLengthOf(type);
      if (fixed !== null && len !== BigInt(fixed)) {
        this.fail(
          `${what}: fixed-size array const '${stringifyType(type)}' carries length ${len}, expected exactly ${fixed}`,
        );
      }
      const elem = elemTypeOf(type);
      if (!isWordType(elem)) {
        this.fail(
          `${what}: only word-element array consts are supported, got '${stringifyType(type)}'`,
        );
      }
      const count = Number(len);
      for (let i = 0; i < count; i++) {
        const word = BigInt(`0x${data.hex.slice(66 + i * 64, 66 + (i + 1) * 64)}`);
        if (!isCanonicalWord(elem, word)) {
          this.fail(`${what}: array element ${i} is not a canonical '${elem}' word`);
        }
      }
      return;
    }
    // string | bytes: payload is the raw bytes, zero-padded to at most the next 32-byte boundary
    const padded = ((len + 31n) >> 5n) << 5n;
    if (payload < len || payload > padded) {
      this.fail(
        `${what}: bytes/string memref payload is ${payload} bytes for declared length ${len} (expected between ${len} and ${padded})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// type-table helpers
// ---------------------------------------------------------------------------

function isArrayType(s: EvsType): s is ArrayType {
  return typeof s === 'string' && s.endsWith(']');
}

/** legal `convert` pairs (the builder's `toUint`/`toInt` and `as*` conversions). */
function convertOk(from: EvsType, to: EvsType): boolean {
  if (isNumeric(from) && isNumeric(to)) return true; // free widening / checked narrowing
  if ((from === 'uint256' || from === 'bytes32') && to === 'address') return true; // checked
  if ((from === 'uint160' && to === 'address') || (from === 'address' && to === 'uint160')) {
    return true; // free
  }
  if (from === 'bytes32' && to === 'uint256') return true; // free reinterpret
  if (from === 'uint256' && to === 'bytes32') return true; // free reinterpret
  // same-width bytesN ↔ uintN (asUint / asBytesN): a shift between the two lanes
  if (isBytesN(from) && isNumeric(to) && !isSigned(to)) return bitsOf(from) === bitsOf(to);
  if (isNumeric(from) && !isSigned(from) && isBytesN(to)) return bitsOf(from) === bitsOf(to);
  if ((from === 'string' && to === 'bytes') || (from === 'bytes' && to === 'string')) {
    return true; // free reinterpret (the same memref)
  }
  if (isBytesN(from) && to === 'string') return true; // a fresh string, trailing zeros trimmed
  return false;
}

/** canonical word invariant. */
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
