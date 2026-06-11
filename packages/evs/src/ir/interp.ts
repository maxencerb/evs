/**
 * M6 `ir/interp.ts` — the reference interpreter over `ScriptIr` against a `MockChain`.
 *
 * Contract: docs/design/module-interfaces.md §M6 (frozen) + architecture.md §4 ("the
 * differential oracle"), §5 (canonical word invariant), §6 (checked-arithmetic table —
 * NORMATIVE), §7 (call semantics: bubbling, staticMinSize guard, decode bounds, normalization,
 * tryCall zeroing), §8 (ABI encode shapes).
 *
 * Binding invariant: bit-for-bit agreement with the compiled bytecode on both returndata and
 * revert payloads. Consequences baked in here:
 *
 * - Every word value is held as its canonical 256-bit slot image (uintN zero-extended, intN
 *   sign-extended two's complement, bool ∈ {0,1}, bytesN left-aligned, address 160-bit
 *   zero-extended) and every operation re-establishes the invariant exactly where the codegen
 *   templates do.
 * - Checked arithmetic implements architecture §6 via exact bigint math + range check on the
 *   true result. For canonical operands this is *provably identical* to the table's EVM-level
 *   checks: the §6 width cases (div-back for `uintN, N>128` MUL; the lone `int256 −1 × −2^255`
 *   case; SIGNEXTEND fixpoints; the explicit `int256 −2^255 / −1` SDIV check) are exactly the
 *   conditions under which the true result leaves the operand type's range. Panic codes:
 *   0x11 overflow, 0x12 div/mod by zero, 0x32 bounds, 0x41 over-allocation.
 * - ABI bytes (sub-call calldata, return tuple, revert payloads) are constructed manually over
 *   raw bytes — never through a UTF-8 round trip — so callee-provided non-UTF-8 `string`
 *   payloads survive byte-exactly. The shapes are standard ABI, byte-equal to viem's
 *   `encodeFunctionData` / `encodeAbiParameters` for valid values (differential-tested).
 * - Memrefs (string/bytes/T[]) have reference semantics: `select`, cells, fn params/results
 *   copy pointers, exactly like the slot-copying codegen.
 *
 * Environment ops: `MockChain` deliberately has no environment surface, so `env` statements
 * return the constants the unit-tier harness (`test/harness/evm.ts` on `@ethereumjs/evm`
 * defaults) exposes to the compiled bytecode: `address` = the fixed SCRIPT address
 * (`0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`), `caller` =
 * `0x1000000000000000000000000000000000000001`, `timestamp` = 0, `blocknumber` = 0,
 * `chainid` = 1 (Mainnet default common).
 *
 * Host-side misuse (wrong arg arity, uncoercible arg values, malformed `MockChain` replies)
 * throws `EvsTypeError`; exceeding `maxSteps` (default 1,000,000; one step per executed
 * statement + one per loop iteration) throws `EvsCompileError(COMPILE_LIMIT)`. Neither is a
 * chain outcome. `validateIr` runs on entry, so garbage IR fails loudly instead of diverging.
 */

import { getAddress } from 'viem';

import { selectorOf } from '../abi/artifact.js';
import { EvsCompileError, EvsInternalError, EvsTypeError, type SourceLoc } from '../core/errors.js';
import {
  bitsOf,
  elemTypeOf,
  isSigned,
  isWordType,
  type ArrayType,
  type EvsType,
  type Hex,
  type WordType,
} from '../core/types.js';
import type { CellId, PlainAbiFunction, ScriptIr, Stmt, ValueId } from './nodes.js';
import { validateIr } from './validate.js';

// ---------------------------------------------------------------------------
// frozen interface (module-interfaces §M6)
// ---------------------------------------------------------------------------

export interface MockChain {
  staticcall(req: { to: Hex; data: Hex }): { success: boolean; data: Hex };
}

export interface InterpResult {
  outcome:
    | { kind: 'return'; data: Hex; values: Record<string, unknown> } // data = ABI-encoded returndata
    | { kind: 'revert'; data: Hex }; // byte-exact revert payload
  trace?: readonly { stmtPath: readonly number[]; loc: SourceLoc | null; note: string }[];
}

export function interpret(
  ir: ScriptIr,
  args: readonly unknown[],
  chain: MockChain,
  opts?: { trace?: boolean; maxSteps?: number },
): InterpResult {
  validateIr(ir);
  const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: maxSteps must be a positive safe integer, got ${String(maxSteps)}`,
    );
  }
  return new Interp(ir, chain, maxSteps, opts?.trace === true).run(args);
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS = 1_000_000;

const MASK256 = (1n << 256n) - 1n;
const MASK160 = (1n << 160n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const TWO_POW_255 = 1n << 255n;
const TWO_POW_256 = 1n << 256n;

/** harness env (test/harness/evm.ts on `@ethereumjs/evm` defaults) — see module doc. */
const ENV_SCRIPT_ADDRESS = 0xcd360ffac9818c4396aa6f4807ebfa72c4b3f530n;
const ENV_CALLER = 0x1000000000000000000000000000000000000001n;
const ENV_TIMESTAMP = 0n;
const ENV_BLOCKNUMBER = 0n;
const ENV_CHAINID = 1n;

/** `Panic(uint256)` selector bytes — evm-target §5. */
const PANIC_SELECTOR = Uint8Array.of(0x4e, 0x48, 0x7b, 0x71);
/** `EvsDecodeError(uint256)` selector — single source of truth is M3's selectorOf. */
const DECODE_ERROR_SELECTOR = hexToBytes(selectorOf('EvsDecodeError', ['uint256']));

// ---------------------------------------------------------------------------
// value model
// ---------------------------------------------------------------------------

/** memref payload of a `string`/`bytes` value — shared by reference. */
interface BytesVal {
  readonly kind: 'bytes';
  readonly bytes: Uint8Array;
}

/** memref payload of a `T[]` value — `words` is mutated in place by `arrset`. */
interface ArrayVal {
  readonly kind: 'array';
  readonly elem: WordType;
  readonly words: bigint[];
}

/** a word value is its canonical 256-bit slot image (architecture §5). */
type Value = bigint | BytesVal | ArrayVal;

// ---------------------------------------------------------------------------
// control-flow / outcome signals (module-private)
// ---------------------------------------------------------------------------

/** unwinds to the top level carrying the byte-exact revert payload. */
class RevertSignal {
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
}

/** unwinds to the innermost `while` (break/continue lower to jumps at statement boundaries). */
class LoopSignal {
  readonly ctl: 'break' | 'continue';
  constructor(ctl: 'break' | 'continue') {
    this.ctl = ctl;
  }
}

function panicSignal(code: number): RevertSignal {
  return new RevertSignal(concatBytes([PANIC_SELECTOR, wordToBytes(BigInt(code))]));
}

function decodeErrorSignal(site: number): RevertSignal {
  return new RevertSignal(concatBytes([DECODE_ERROR_SELECTOR, wordToBytes(BigInt(site))]));
}

// ---------------------------------------------------------------------------
// interpreter core
// ---------------------------------------------------------------------------

class Interp {
  private readonly ir: ScriptIr;
  private readonly chain: MockChain;
  private readonly maxSteps: number;
  private readonly tracing: boolean;
  private readonly trace: { stmtPath: readonly number[]; loc: SourceLoc | null; note: string }[] =
    [];
  private readonly values = new Map<ValueId, Value>();
  private readonly cells = new Map<CellId, Value>();
  private steps = 0;
  /** fn-name stack for trace-note prefixes (fn-body paths are relative to the fn body). */
  private readonly fnStack: string[] = [];

  constructor(ir: ScriptIr, chain: MockChain, maxSteps: number, tracing: boolean) {
    this.ir = ir;
    this.chain = chain;
    this.maxSteps = maxSteps;
    this.tracing = tracing;
  }

  run(args: readonly unknown[]): InterpResult {
    const { ir } = this;
    if (args.length !== ir.args.length) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `interpret: script "${ir.name}" takes ${ir.args.length} argument(s), got ${args.length}`,
        { loc: ir.loc },
      );
    }
    ir.args.forEach((a, i) => {
      this.values.set(i, coerceArg(a.name, a.type, args[i], ir.loc));
    });
    let outcome: InterpResult['outcome'];
    try {
      this.execBlock(ir.body, []);
      const { data, values } = this.encodeReturn();
      outcome = { kind: 'return', data: bytesToHex(data), values };
    } catch (e) {
      if (e instanceof RevertSignal) {
        outcome = { kind: 'revert', data: bytesToHex(e.data) };
      } else if (e instanceof LoopSignal) {
        throw new EvsInternalError(
          'INTERNAL',
          `interpret: '${e.ctl}' escaped its loop — validateIr should have rejected this IR`,
        );
      } else {
        throw e;
      }
    }
    return this.tracing ? { outcome, trace: this.trace } : { outcome };
  }

  // -------------------------------------------------------------------------
  // bookkeeping
  // -------------------------------------------------------------------------

  /** one budget unit; also charged once per loop iteration (guards zero-stmt loops). */
  private tick(): void {
    this.steps += 1;
    if (this.steps > this.maxSteps) {
      throw new EvsCompileError(
        'COMPILE_LIMIT',
        `interpret: script "${this.ir.name}" exceeded maxSteps = ${this.maxSteps} (likely an unbounded loop; raise opts.maxSteps if intentional)`,
        { loc: this.ir.loc },
      );
    }
  }

  private step(s: Stmt, path: readonly number[]): void {
    this.tick();
    if (this.tracing) {
      const prefix = this.fnStack.length > 0 ? `fn "${this.fnStack.join('"."')}": ` : '';
      this.trace.push({ stmtPath: path, loc: s.loc, note: `${prefix}${noteOf(s)}` });
    }
  }

  private getValue(id: ValueId): Value {
    const v = this.values.get(id);
    if (v === undefined) {
      throw new EvsInternalError(
        'INTERNAL',
        `interpret: ValueId ${id} read before it was computed — validateIr should have rejected this IR`,
      );
    }
    return v;
  }

  private word(id: ValueId): bigint {
    const v = this.getValue(id);
    if (typeof v !== 'bigint') {
      throw new EvsInternalError('INTERNAL', `interpret: ValueId ${id} is a memref, word expected`);
    }
    return v;
  }

  private memref(id: ValueId): BytesVal | ArrayVal {
    const v = this.getValue(id);
    if (typeof v === 'bigint') {
      throw new EvsInternalError('INTERNAL', `interpret: ValueId ${id} is a word, memref expected`);
    }
    return v;
  }

  private typeOf(id: ValueId): EvsType {
    const info = this.ir.values[id];
    if (info === undefined) {
      throw new EvsInternalError('INTERNAL', `interpret: unknown ValueId ${id}`);
    }
    return info.type;
  }

  // -------------------------------------------------------------------------
  // statement execution
  // -------------------------------------------------------------------------

  private execBlock(stmts: readonly Stmt[], path: readonly number[]): void {
    stmts.forEach((s, i) => {
      this.execStmt(s, [...path, i]);
    });
  }

  private execStmt(s: Stmt, path: readonly number[]): void {
    this.step(s, path);
    switch (s.k) {
      case 'const': {
        this.values.set(s.out, constValue(s.type, s.data));
        return;
      }
      case 'bin': {
        this.execBin(s);
        return;
      }
      case 'un': {
        this.execUn(s);
        return;
      }
      case 'env': {
        this.values.set(s.out, envValue(s.op));
        return;
      }
      case 'convert': {
        this.values.set(s.out, convert(this.typeOf(s.a), this.typeOf(s.out), this.word(s.a)));
        return;
      }
      case 'select': {
        // eager on both sides — both values already computed; pointer select for memrefs.
        this.values.set(s.out, this.word(s.cond) !== 0n ? this.getValue(s.a) : this.getValue(s.b));
        return;
      }
      case 'index': {
        const arr = this.asArray(s.arr);
        const i = this.word(s.i);
        if (i >= BigInt(arr.words.length)) throw panicSignal(0x32);
        this.values.set(s.out, arr.words[Number(i)] ?? 0n);
        return;
      }
      case 'len': {
        const m = this.memref(s.a);
        this.values.set(
          s.out,
          m.kind === 'bytes' ? BigInt(m.bytes.length) : BigInt(m.words.length),
        );
        return;
      }
      case 'arrnew': {
        const len = this.word(s.length);
        if (len >= 1n << 32n) throw panicSignal(0x41);
        const words = Array.from({ length: Number(len) }, () => 0n);
        this.values.set(s.out, { kind: 'array', elem: s.elem, words });
        return;
      }
      case 'arrset': {
        const arr = this.asArray(s.arr);
        const i = this.word(s.i);
        if (i >= BigInt(arr.words.length)) throw panicSignal(0x32);
        arr.words[Number(i)] = this.word(s.value);
        return;
      }
      case 'cellnew': {
        this.cells.set(s.cell, this.getValue(s.init));
        return;
      }
      case 'cellget': {
        const v = this.cells.get(s.cell);
        if (v === undefined) {
          throw new EvsInternalError('INTERNAL', `interpret: CellId ${s.cell} read before cellnew`);
        }
        this.values.set(s.out, v);
        return;
      }
      case 'cellset': {
        this.cells.set(s.cell, this.getValue(s.value));
        return;
      }
      case 'call': {
        this.execCall(s);
        return;
      }
      case 'fncall': {
        this.execFnCall(s);
        return;
      }
      case 'if': {
        if (this.word(s.cond) !== 0n) {
          this.execBlock(s.then, [...path, 0]);
        } else {
          this.execBlock(s.else, [...path, 1]);
        }
        return;
      }
      case 'while': {
        for (;;) {
          this.tick(); // per-iteration charge — guards loops with no statements at all
          this.execBlock(s.header, [...path, 0]);
          if (this.word(s.cond) === 0n) break;
          try {
            this.execBlock(s.body, [...path, 1]);
          } catch (e) {
            if (!(e instanceof LoopSignal)) throw e;
            if (e.ctl === 'break') break;
            // continue: fall through to the next iteration (re-executes the header)
          }
        }
        return;
      }
      case 'break':
      case 'continue': {
        throw new LoopSignal(s.k);
      }
      default: {
        const kind = String((s as { k: unknown }).k);
        throw new EvsInternalError('INTERNAL', `interpret: unknown statement kind '${kind}'`);
      }
    }
  }

  private asArray(id: ValueId): ArrayVal {
    const m = this.memref(id);
    if (m.kind !== 'array') {
      throw new EvsInternalError('INTERNAL', `interpret: ValueId ${id} is not an array memref`);
    }
    return m;
  }

  // -------------------------------------------------------------------------
  // bin / un ops (architecture §6 — see module doc for the exact-math equivalence)
  // -------------------------------------------------------------------------

  private execBin(s: Extract<Stmt, { k: 'bin' }>): void {
    const a = this.word(s.a);
    const b = this.word(s.b);
    const ta = this.typeOf(s.a);
    if (!isWordType(ta)) {
      throw new EvsInternalError('INTERNAL', `interpret: bin operand of non-word type '${ta}'`);
    }
    this.values.set(s.out, binOp(s.op, ta, a, b));
  }

  private execUn(s: Extract<Stmt, { k: 'un' }>): void {
    const a = this.word(s.a);
    switch (s.op) {
      case 'not': // bool not — ISZERO on a canonical 0/1 word
      case 'iszero': {
        this.values.set(s.out, a === 0n ? 1n : 0n);
        return;
      }
      case 'bitnot': {
        const ta = this.typeOf(s.a);
        if (!isWordType(ta)) {
          throw new EvsInternalError('INTERNAL', `interpret: bitnot on non-word type '${ta}'`);
        }
        // NOT then re-canonicalize (post-mask / re-sign-extend — §6 "Bitwise")
        this.values.set(s.out, canonWord(ta, ~a & MASK256));
        return;
      }
      default: {
        const op = String((s as { op: unknown }).op);
        throw new EvsInternalError('INTERNAL', `interpret: unknown un op '${op}'`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // calls (architecture §7)
  // -------------------------------------------------------------------------

  private execCall(s: Extract<Stmt, { k: 'call' }>): void {
    const target = this.word(s.target);
    if (s.gas !== undefined) this.word(s.gas); // evaluated; the interpreter has no gas model
    const calldata = this.encodeCalldata(s.fnAbi, s.args);
    const to: Hex = `0x${target.toString(16).padStart(40, '0')}`;
    const res = this.chain.staticcall({ to, data: bytesToHex(calldata) });
    if (typeof res !== 'object' || res === null || typeof res.success !== 'boolean') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `interpret: MockChain.staticcall returned a malformed result for ${s.fnAbi.name}()`,
        { loc: s.loc },
      );
    }
    const data = hexToBytesChecked(res.data, `MockChain returndata for ${s.fnAbi.name}()`, s.loc);
    if (!res.success) {
      if (s.mode === 'strict') throw new RevertSignal(data); // bubble verbatim (§7.2 step 2)
      this.zeroCallOuts(s);
      return;
    }
    const decoded = decodeOutputs(s.fnAbi.outputs, data);
    if (decoded === null) {
      // structural decode failure (§7.2 steps 3/5)
      if (s.mode === 'strict') throw decodeErrorSignal(s.site);
      this.zeroCallOuts(s);
      return;
    }
    s.outs.forEach((out, i) => {
      const v = decoded[i];
      if (v === undefined) {
        throw new EvsInternalError('INTERNAL', `interpret: call out ${i} missing after decode`);
      }
      this.values.set(out, v);
    });
    if (s.successOut !== undefined) this.values.set(s.successOut, 1n);
  }

  /**
   * tryCall failure values (§7.2 step 6): `success = 0`, word outs = 0, memref outs point at
   * the zero slot ⇒ empty string / empty bytes / empty array. Taken on call failure AND on
   * malformed returndata.
   */
  private zeroCallOuts(s: Extract<Stmt, { k: 'call' }>): void {
    s.outs.forEach((out, i) => {
      const p = s.fnAbi.outputs[i];
      if (p === undefined) {
        throw new EvsInternalError('INTERNAL', `interpret: call out ${i} has no ABI output`);
      }
      this.values.set(out, zeroValue(asEvsType(p.type)));
    });
    if (s.successOut !== undefined) this.values.set(s.successOut, 0n);
  }

  /** selector ++ standard ABI args block — byte-equal to viem `encodeFunctionData` (§7.1). */
  private encodeCalldata(fnAbi: PlainAbiFunction, argIds: readonly ValueId[]): Uint8Array {
    const items = argIds.map((id, i) => {
      const p = fnAbi.inputs[i];
      if (p === undefined) {
        throw new EvsInternalError('INTERNAL', `interpret: call arg ${i} has no ABI input`);
      }
      return { type: asEvsType(p.type), value: this.getValue(id) };
    });
    return concatBytes([hexToBytes(fnAbi.selector), encodeParamsBlock(items)]);
  }

  private execFnCall(s: Extract<Stmt, { k: 'fncall' }>): void {
    const fn = this.ir.fns[s.fn];
    if (fn === undefined) {
      throw new EvsInternalError('INTERNAL', `interpret: unknown FnId ${s.fn}`);
    }
    // §9 convention: caller stores args into the callee's param slots …
    s.args.forEach((a, i) => {
      const p = fn.params[i];
      if (p === undefined) {
        throw new EvsInternalError('INTERNAL', `interpret: fncall arg ${i} has no param`);
      }
      this.values.set(p.value, this.getValue(a));
    });
    this.fnStack.push(fn.name);
    try {
      this.execBlock(fn.body, []);
    } finally {
      this.fnStack.pop();
    }
    // … then copies result slots to per-callsite out slots (two calls never alias).
    s.outs.forEach((out, i) => {
      const rv = fn.resultValues[i];
      if (rv === undefined) {
        throw new EvsInternalError('INTERNAL', `interpret: fncall out ${i} has no resultValue`);
      }
      this.values.set(out, this.getValue(rv));
    });
  }

  // -------------------------------------------------------------------------
  // return encoding (architecture §8.2) + JS value record
  // -------------------------------------------------------------------------

  private encodeReturn(): { data: Uint8Array; values: Record<string, unknown> } {
    const items = this.ir.returns.map((r) => ({ type: r.type, value: this.getValue(r.value) }));
    const block = encodeParamsBlock(items);
    // dynamic tuple ⇒ top-level 0x20 offset; all-static ⇒ components inline (§8.2 step 1)
    const anyDynamic = this.ir.returns.some((r) => !isWordType(r.type));
    const data = anyDynamic ? concatBytes([wordToBytes(32n), block]) : block;
    const values: Record<string, unknown> = {};
    for (const r of this.ir.returns) values[r.name] = jsValueOf(r.type, this.getValue(r.value));
    return { data, values };
  }
}

// ---------------------------------------------------------------------------
// checked arithmetic + word ops (architecture §6 — normative table)
// ---------------------------------------------------------------------------

function binOp(op: string, type: WordType, a: bigint, b: bigint): bigint {
  switch (op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'mod':
      return arith(op, type, a, b);
    case 'lt':
      return logical(type, a) < logical(type, b) ? 1n : 0n;
    case 'gt':
      return logical(type, a) > logical(type, b) ? 1n : 0n;
    case 'lte': // ISZERO(GT)
      return logical(type, a) <= logical(type, b) ? 1n : 0n;
    case 'gte': // ISZERO(LT)
      return logical(type, a) >= logical(type, b) ? 1n : 0n;
    case 'eq':
      return a === b ? 1n : 0n;
    case 'neq':
      return a === b ? 0n : 1n;
    case 'and': // eager bool AND on canonical 0/1 words
      return a & b;
    case 'or':
      return a | b;
    case 'bitand':
      return canonWord(type, a & b);
    case 'bitor':
      return canonWord(type, a | b);
    case 'bitxor':
      return canonWord(type, a ^ b);
    case 'shl': {
      // SHL then mask/sign-extend to width (Solidity shifts are unchecked)
      const r = b >= 256n ? 0n : (a << b) & MASK256;
      return canonWord(type, r);
    }
    case 'shr': {
      if (isSigned(type)) {
        // SAR — canonical-preserving on a sign-extended operand
        const sa = toSigned256(a);
        const r = b >= 256n ? (sa < 0n ? -1n : 0n) : sa >> b;
        return canonWord(type, r & MASK256);
      }
      // logical SHR for uintN/bytesN, then re-mask to width (bytesN: bits shifted out of the
      // left-aligned lane are cleared — matches the codegen post-mask)
      const r = b >= 256n ? 0n : a >> b;
      return canonWord(type, r);
    }
    default:
      throw new EvsInternalError('INTERNAL', `interpret: unknown bin op '${op}'`);
  }
}

/**
 * add/sub/mul/div/mod with solc ≥0.8 checked semantics. Exact bigint math + range check on
 * the true result — identical to the §6 EVM check sequences for canonical operands (incl.
 * uint192 mul wrap-past-2^256, int256 `−2^255 / −1`, intN `minN / −1`, `−1 × −2^255`).
 */
function arith(
  op: 'add' | 'sub' | 'mul' | 'div' | 'mod',
  type: WordType,
  aw: bigint,
  bw: bigint,
): bigint {
  const a = logical(type, aw);
  const b = logical(type, bw);
  const [min, max] = numericRange(type);
  let r: bigint;
  switch (op) {
    case 'add':
      r = a + b;
      break;
    case 'sub':
      r = a - b;
      break;
    case 'mul':
      r = a * b;
      break;
    case 'div':
      if (b === 0n) throw panicSignal(0x12);
      r = a / b; // bigint division truncates toward zero — exactly SDIV/DIV
      break;
    case 'mod':
      if (b === 0n) throw panicSignal(0x12);
      r = a % b; // bigint remainder follows the dividend's sign — exactly SMOD/MOD
      break;
    default:
      throw new EvsInternalError('INTERNAL', `interpret: unknown arith op '${String(op)}'`);
  }
  if (r < min || r > max) throw panicSignal(0x11); // Panic 0x11 (overflow/underflow)
  return fromLogical(r);
}

function numericRange(type: WordType): readonly [bigint, bigint] {
  const bits = BigInt(bitsOf(type));
  return isSigned(type)
    ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n]
    : [0n, (1n << bits) - 1n];
}

/** canonical word → logical integer (signed for intN; the raw word otherwise). */
function logical(type: WordType, word: bigint): bigint {
  return isSigned(type) ? toSigned256(word) : word;
}

/** logical integer (in range, so |v| < 2^255) → canonical 256-bit word. */
function fromLogical(v: bigint): bigint {
  return v < 0n ? v + TWO_POW_256 : v;
}

function toSigned256(word: bigint): bigint {
  return word >= TWO_POW_255 ? word - TWO_POW_256 : word;
}

/**
 * Normalize an arbitrary 256-bit word to the canonical slot image of `type` (architecture §5):
 * uintN masked, intN SIGNEXTENDed, bool ISZERO ISZERO, address masked to 160 bits, bytesN
 * masked to its left-aligned lane. Used at the trust boundaries (returndata words, arg
 * coercion) and wherever an op can denormalize.
 */
function canonWord(type: WordType, word: bigint): bigint {
  if (type === 'bool') return word === 0n ? 0n : 1n;
  if (type === 'address') return word & MASK160;
  const bits = BigInt(bitsOf(type));
  if (type.startsWith('bytes')) {
    const laneMask = ((1n << bits) - 1n) << (256n - bits);
    return word & laneMask;
  }
  const low = word & ((1n << bits) - 1n);
  if (!isSigned(type)) return low;
  const negative = (low >> (bits - 1n)) & 1n;
  return negative === 1n ? low | (MASK256 ^ ((1n << bits) - 1n)) : low;
}

/**
 * `convert` (§6): free widening / reinterpret where lossless; otherwise the logical value is
 * range-checked against the target (Panic 0x11) — covers checked narrowing, cross-signedness,
 * and `asAddress`'s high-96-bits-zero check uniformly.
 */
function convert(from: EvsType, to: EvsType, word: bigint): bigint {
  if (!isWordType(from) || !isWordType(to)) {
    throw new EvsInternalError('INTERNAL', `interpret: convert over '${from}' → '${to}'`);
  }
  if ((from === 'uint256' && to === 'bytes32') || (from === 'bytes32' && to === 'uint256')) {
    return word; // free reinterpret — both occupy the full word
  }
  if (to === 'address') {
    // asAddress (from uint256 | bytes32): high 96 bits must be zero
    if (word > MASK160) throw panicSignal(0x11);
    return word;
  }
  const v = logical(from, word);
  const [min, max] = numericRange(to);
  if (v < min || v > max) throw panicSignal(0x11);
  return fromLogical(v);
}

// ---------------------------------------------------------------------------
// const / env / zero values
// ---------------------------------------------------------------------------

function constValue(type: EvsType, data: { kind: 'word' | 'data'; hex: Hex }): Value {
  if (data.kind === 'word') return BigInt(data.hex); // canonical per validateIr
  // [len:32][payload…] memref — a fresh buffer per execution, like CODECOPY materialization
  const bytes = hexToBytes(data.hex);
  const len = Number(readWord(bytes, 0));
  if (isWordType(type) || type === 'string' || type === 'bytes') {
    if (isWordType(type)) {
      throw new EvsInternalError('INTERNAL', `interpret: data const of word type '${type}'`);
    }
    return { kind: 'bytes', bytes: bytes.slice(32, 32 + len) };
  }
  const elem = elemTypeOf(type);
  const words = Array.from({ length: len }, (_, i) => readWord(bytes, 32 + 32 * i));
  return { kind: 'array', elem, words };
}

function envValue(op: string): bigint {
  switch (op) {
    case 'address':
      return ENV_SCRIPT_ADDRESS;
    case 'caller':
      return ENV_CALLER;
    case 'timestamp':
      return ENV_TIMESTAMP;
    case 'blocknumber':
      return ENV_BLOCKNUMBER;
    case 'chainid':
      return ENV_CHAINID;
    default:
      throw new EvsInternalError('INTERNAL', `interpret: unknown env op '${op}'`);
  }
}

function zeroValue(type: EvsType): Value {
  if (isWordType(type)) return 0n;
  if (type === 'string' || type === 'bytes') return { kind: 'bytes', bytes: new Uint8Array(0) };
  return { kind: 'array', elem: elemTypeOf(asArrayType(type)), words: [] };
}

// ---------------------------------------------------------------------------
// ABI encode (standard head/tail over raw bytes — §7.1 / §8.2 shapes)
// ---------------------------------------------------------------------------

/** heads ++ tails; dynamic heads carry offsets relative to the start of the block. */
function encodeParamsBlock(items: readonly { type: EvsType; value: Value }[]): Uint8Array {
  const headSize = 32 * items.length;
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailLen = 0;
  for (const item of items) {
    if (isWordType(item.type)) {
      if (typeof item.value !== 'bigint') {
        throw new EvsInternalError('INTERNAL', `interpret: word value expected for ${item.type}`);
      }
      heads.push(wordToBytes(item.value));
      continue;
    }
    heads.push(wordToBytes(BigInt(headSize + tailLen)));
    const tail = encodeTail(item.value);
    tails.push(tail);
    tailLen += tail.length;
  }
  return concatBytes([...heads, ...tails]);
}

/** `[len][payload zero-padded to a word boundary]` (bytes/string) or `[len][words]` (T[]). */
function encodeTail(value: Value): Uint8Array {
  if (typeof value === 'bigint') {
    throw new EvsInternalError('INTERNAL', 'interpret: memref value expected for a dynamic type');
  }
  if (value.kind === 'bytes') {
    const padded = new Uint8Array(Math.ceil(value.bytes.length / 32) * 32);
    padded.set(value.bytes, 0);
    return concatBytes([wordToBytes(BigInt(value.bytes.length)), padded]);
  }
  return concatBytes([wordToBytes(BigInt(value.words.length)), ...value.words.map(wordToBytes)]);
}

// ---------------------------------------------------------------------------
// returndata decode (architecture §7.2, steps 3–5 — exact bounds + normalization)
// ---------------------------------------------------------------------------

/** `null` = structural decode failure (the per-site `EvsDecodeError` / tryCall-zero trigger). */
function decodeOutputs(
  outputs: PlainAbiFunction['outputs'],
  data: Uint8Array,
): readonly Value[] | null {
  const rds = BigInt(data.length);
  // staticMinSize guard BEFORE any head read (§7.2 step 3)
  if (rds < 32n * BigInt(outputs.length)) return null;
  const decoded: Value[] = [];
  for (let i = 0; i < outputs.length; i++) {
    const p = outputs[i];
    if (p === undefined) return null; // unreachable: i < outputs.length
    const type = asEvsType(p.type);
    const head = readWord(data, 32 * i);
    if (isWordType(type)) {
      // static word output: normalize-don't-revert (§7.2 step 4)
      decoded.push(canonWord(type, head));
      continue;
    }
    // dynamic output (§7.2 step 5): off ≤ 2^64−1, off + 32 ≤ rds
    const off = head;
    if (off > U64_MAX) return null;
    if (off + 32n > rds) return null;
    const len = readWord(data, Number(off));
    if (len > U64_MAX) return null;
    if (type === 'string' || type === 'bytes') {
      if (off + 32n + len > rds) return null;
      const start = Number(off) + 32;
      decoded.push({ kind: 'bytes', bytes: data.slice(start, start + Number(len)) });
      continue;
    }
    // T[]: off + 32 + 32·len ≤ rds; elements normalized eagerly (§7.2 step 5)
    if (off + 32n + 32n * len > rds) return null;
    const elem = elemTypeOf(type);
    const base = Number(off) + 32;
    const words = Array.from({ length: Number(len) }, (_, j) =>
      canonWord(elem, readWord(data, base + 32 * j)),
    );
    decoded.push({ kind: 'array', elem, words });
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// script-arg coercion (the JS mirror of the §8.1 calldata trust boundary)
// ---------------------------------------------------------------------------

function coerceArg(name: string, type: EvsType, value: unknown, loc: SourceLoc | null): Value {
  const where = `interpret: argument "${name}" (${type})`;
  if (isWordType(type)) return coerceWordArg(type, value, where, loc);
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a string`, { loc });
    }
    return { kind: 'bytes', bytes: new TextEncoder().encode(value) };
  }
  if (type === 'bytes') {
    return { kind: 'bytes', bytes: coerceHexArg(value, null, where, loc) };
  }
  const elem = elemTypeOf(asArrayType(type));
  if (!Array.isArray(value)) {
    throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected an array`, { loc });
  }
  const items: readonly unknown[] = value;
  return {
    kind: 'array',
    elem,
    words: items.map((el, i) => coerceWordArg(elem, el, `${where}[${i}]`, loc)),
  };
}

function coerceWordArg(
  type: WordType,
  value: unknown,
  where: string,
  loc: SourceLoc | null,
): bigint {
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a boolean`, { loc });
    }
    return value ? 1n : 0n;
  }
  if (type === 'address') {
    const bytes = coerceHexArg(value, 20, where, loc);
    return readPartialWord(bytes, 0, 20);
  }
  if (type.startsWith('bytes')) {
    const size = Number(type.slice('bytes'.length));
    const bytes = coerceHexArg(value, size, where, loc);
    return readPartialWord(bytes, 0, size) << BigInt(8 * (32 - size)); // left-aligned
  }
  // numeric
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    v = BigInt(value);
  } else {
    throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a bigint or safe-integer number`, {
      loc,
    });
  }
  const [min, max] = numericRange(type);
  if (v < min || v > max) {
    throw new EvsTypeError('LITERAL_RANGE', `${where}: ${v}n is out of range [${min}, ${max}]`, {
      loc,
    });
  }
  return fromLogical(v);
}

function coerceHexArg(
  value: unknown,
  exactBytes: number | null,
  where: string,
  loc: SourceLoc | null,
): Uint8Array {
  if (!isHexString(value)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: expected a 0x-prefixed even-length hex string`,
      { loc },
    );
  }
  const bytes = hexToBytes(value);
  if (exactBytes !== null && bytes.length !== exactBytes) {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `${where}: expected exactly ${exactBytes} bytes, got ${bytes.length}`,
      { loc },
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// JS value projection (`outcome.values` — matches viem's decode conventions)
// ---------------------------------------------------------------------------

function jsValueOf(type: EvsType, value: Value): unknown {
  if (isWordType(type)) {
    if (typeof value !== 'bigint') {
      throw new EvsInternalError('INTERNAL', `interpret: word value expected for ${type}`);
    }
    return jsWord(type, value);
  }
  if (typeof value === 'bigint') {
    throw new EvsInternalError('INTERNAL', `interpret: memref value expected for ${type}`);
  }
  if (value.kind === 'bytes') {
    return type === 'string' ? new TextDecoder().decode(value.bytes) : bytesToHex(value.bytes);
  }
  const elem = elemTypeOf(asArrayType(type));
  return value.words.map((w) => jsWord(elem, w));
}

function jsWord(type: WordType, word: bigint): unknown {
  if (type === 'bool') return word === 1n;
  if (type === 'address') {
    return getAddress(`0x${word.toString(16).padStart(40, '0')}`); // checksummed, like viem
  }
  if (type.startsWith('bytes')) {
    const size = Number(type.slice('bytes'.length));
    return bytesToHex(wordToBytes(word).slice(0, size));
  }
  const v = logical(type, word);
  // abitype/viem convention: uintN/intN with N ≤ 48 decode to number, wider to bigint
  return bitsOf(type) <= 48 ? Number(v) : v;
}

// ---------------------------------------------------------------------------
// bytes / hex / word helpers
// ---------------------------------------------------------------------------

function isHexString(v: unknown): v is Hex {
  return typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
}

function hexToBytes(hex: Hex): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function hexToBytesChecked(value: unknown, what: string, loc: SourceLoc | null): Uint8Array {
  if (!isHexString(value)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: ${what} must be an even-length 0x-hex string`,
      { loc },
    );
  }
  return hexToBytes(value);
}

function bytesToHex(bytes: Uint8Array): Hex {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `0x${s}`;
}

function wordToBytes(word: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = word & MASK256;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function readWord(bytes: Uint8Array, offset: number): bigint {
  return readPartialWord(bytes, offset, 32);
}

function readPartialWord(bytes: Uint8Array, offset: number, size: number): bigint {
  let v = 0n;
  for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(bytes[offset + i] ?? 0);
  return v;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// misc type helpers
// ---------------------------------------------------------------------------

function isV0ArrayType(s: string): s is ArrayType {
  return s.endsWith('[]') && isWordType(s.slice(0, -2));
}

function asEvsType(s: string): EvsType {
  if (isWordType(s) || s === 'string' || s === 'bytes' || isV0ArrayType(s)) return s;
  throw new EvsInternalError('INTERNAL', `interpret: non-v0 ABI type '${s}' survived validateIr`);
}

function asArrayType(s: EvsType): ArrayType {
  if (isV0ArrayType(s)) return s;
  throw new EvsInternalError('INTERNAL', `interpret: '${s}' is not a v0 array type`);
}

/** short trace note per statement (prefixed with the fn-name stack inside fn bodies). */
function noteOf(s: Stmt): string {
  switch (s.k) {
    case 'const':
      return `const ${s.type}`;
    case 'bin':
      return `bin ${s.op}`;
    case 'un':
      return `un ${s.op}`;
    case 'env':
      return `env ${s.op}`;
    case 'convert':
      return 'convert';
    case 'select':
      return 'select';
    case 'index':
      return 'index';
    case 'len':
      return 'len';
    case 'arrnew':
      return `arrnew ${s.elem}[]`;
    case 'arrset':
      return 'arrset';
    case 'cellnew':
      return `cellnew #${s.cell}`;
    case 'cellget':
      return `cellget #${s.cell}`;
    case 'cellset':
      return `cellset #${s.cell}`;
    case 'call':
      return `call ${s.fnAbi.name}() [${s.mode}] site ${s.site}`;
    case 'fncall':
      return `fncall fns[${s.fn}]`;
    case 'if':
      return 'if';
    case 'while':
      return 'while';
    case 'break':
      return 'break';
    case 'continue':
      return 'continue';
    default:
      return 'stmt';
  }
}
