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
 * default to the constants the unit-tier harness (`test/harness/evm.ts` on `@ethereumjs/evm`
 * defaults) exposes to the compiled bytecode: `address` = the fixed SCRIPT address
 * (`0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`), `caller` =
 * `0x1000000000000000000000000000000000000001`, `timestamp` = 0, `blocknumber` = 0,
 * `chainid` = 1 (Mainnet default common). Those defaults match the stateOverride `toViem()`
 * frame shape; `opts.env` overrides them per call so other frames — notably the DEFAULT
 * deployless mode, where `caller` is viem's internal wrapper contract and `address` is a
 * per-script counterfactual CREATE2 address — can be modeled and differential-tested
 * (extension of the frozen §M6 opts, recorded in docs/design/amendments.md).
 *
 * Host-side misuse (wrong arg arity, uncoercible arg values, malformed `MockChain` replies)
 * throws `EvsTypeError`; exceeding `maxSteps` (default 1,000,000; one step per executed
 * statement + one per loop iteration) throws `EvsCompileError(COMPILE_LIMIT)`. Neither is a
 * chain outcome. `validateIr` runs on entry, so garbage IR fails loudly instead of diverging.
 */

import { getAddress, keccak256 as viemKeccak256 } from 'viem';

import { selectorOf } from '../abi/artifact.js';
import {
  bytesToBigInt as readPartialWord,
  bytesToHex,
  hexToBytes,
  isHexString,
  padWordAligned,
  u256ToBytes as wordToBytes,
} from '../core/bytes.js';
import { EvsCompileError, EvsInternalError, EvsTypeError, type SourceLoc } from '../core/errors.js';
import {
  abiParamToType,
  bitsOf,
  elemTypeOf,
  isSigned,
  isTupleType,
  isWordType,
  type ArrayType,
  type EvsType,
  type Hex,
  type NamedType,
  type TupleType,
  type WordType,
} from '../core/types.js';
import type { CellId, PlainAbiFunction, ScriptIr, Stmt, ValueId } from './nodes.js';
import { validateIr } from './validate.js';

// ---------------------------------------------------------------------------
// frozen interface (module-interfaces §M6)
// ---------------------------------------------------------------------------

export interface MockChain {
  staticcall(req: { to: Hex; data: Hex }): { success: boolean; data: Hex };
  /**
   * Optional mutable-subcall oracle for `s.call` / `s.simulate` (issue #1). Defaults to
   * {@link MockChain.staticcall} when omitted.
   *
   * `req.kind` tells the mock which non-static verb is calling (`'call'` = a real CALL frame,
   * `'simulate'` = the self-call/revert dry-run) — but it is **informational only**. The reference
   * interpreter is STATELESS, so returndata is a pure function of `(to, data, chain-state)`: a CALL
   * and the simulate trampoline relay the SAME calldata to the SAME target and read back the SAME
   * bytes; the only real difference is whether the write *persists*, which needs state this oracle
   * deliberately does not model. So a stateless mock MUST return identical data regardless of
   * `kind` — diverging on it would model behavior that cannot physically happen and would break the
   * byte-for-byte agreement with the compiled bytecode. `kind` exists for routing assertions and
   * for a user-built *stateful* mock that chooses to apply-then-roll-back itself; the canonical
   * persistence/rollback semantics are pinned in the integration tier (anvil) against real state.
   */
  call?(req: { to: Hex; data: Hex; kind: 'call' | 'simulate' }): { success: boolean; data: Hex };
}

export interface InterpResult {
  outcome:
    | { kind: 'return'; data: Hex; values: Record<string, unknown> } // data = ABI-encoded returndata
    | { kind: 'revert'; data: Hex }; // byte-exact revert payload
  trace?: readonly { stmtPath: readonly number[]; loc: SourceLoc | null; note: string }[];
}

/**
 * Per-call overrides for the `env` op values (defaults = the stateOverride/unit-harness frame,
 * see the module doc). `s.env('caller')`/`s.env('address')` are execution-frame-dependent —
 * pass the frame's values here to model e.g. the default deployless `toViem()` mode.
 */
export interface InterpEnvOverrides {
  address?: Hex; // 20-byte 0x address — address(this) of the script frame
  caller?: Hex; // 20-byte 0x address — msg.sender of the script frame
  timestamp?: bigint;
  blocknumber?: bigint;
  chainid?: bigint;
}

export function interpret(
  ir: ScriptIr,
  args: readonly unknown[],
  chain: MockChain,
  opts?: { trace?: boolean; maxSteps?: number; env?: InterpEnvOverrides },
): InterpResult {
  validateIr(ir);
  const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: maxSteps must be a positive safe integer, got ${String(maxSteps)}`,
    );
  }
  return new Interp(ir, chain, maxSteps, opts?.trace === true, resolveEnv(opts?.env)).run(args);
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

/** resolved env table — every op carries its canonical word value. */
interface ResolvedEnv {
  readonly address: bigint;
  readonly caller: bigint;
  readonly timestamp: bigint;
  readonly blocknumber: bigint;
  readonly chainid: bigint;
}

const ADDRESS_HEX_RE = /^0x[0-9a-fA-F]{40}$/;

function envAddress(field: 'address' | 'caller', value: Hex | undefined, dflt: bigint): bigint {
  if (value === undefined) return dflt;
  if (typeof value !== 'string' || !ADDRESS_HEX_RE.test(value)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: opts.env.${field} must be a 20-byte 0x address, got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

function envWord(
  field: 'timestamp' | 'blocknumber' | 'chainid',
  value: bigint | undefined,
  dflt: bigint,
): bigint {
  if (value === undefined) return dflt;
  if (typeof value !== 'bigint' || value < 0n || value > MASK256) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: opts.env.${field} must be a bigint in [0, 2^256), got ${String(value)}`,
    );
  }
  return value;
}

function resolveEnv(env: InterpEnvOverrides | undefined): ResolvedEnv {
  return {
    address: envAddress('address', env?.address, ENV_SCRIPT_ADDRESS),
    caller: envAddress('caller', env?.caller, ENV_CALLER),
    timestamp: envWord('timestamp', env?.timestamp, ENV_TIMESTAMP),
    blocknumber: envWord('blocknumber', env?.blocknumber, ENV_BLOCKNUMBER),
    chainid: envWord('chainid', env?.chainid, ENV_CHAINID),
  };
}

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

/**
 * memref payload of a `T[]` value — the `[len][p0]…[p_{len-1}]` block (§12.1). `items` is the
 * element list, mutated in place by `arrset` (reference semantics, like {@link TupleVal}'s
 * `fields`). For a **word** element each item is a canonical `bigint`; for a **composite** element
 * (`tuple[]`, `T[][]`, `string[]`/`bytes[]`) each item is the element's own memref `Value`
 * (TupleVal / ArrayVal / BytesVal) — the slot's pointer in the compiled layout.
 */
interface ArrayVal {
  readonly kind: 'array';
  readonly elem: EvsType;
  readonly items: Value[];
}

/**
 * memref payload of a tuple/struct value — a flat-pointer block of one {@link Value} per member
 * (a word for a static member, a memref for a dynamic/composite one). Reference semantics: the
 * `fields` array is shared (like {@link ArrayVal}'s `words`); `tupleset` mutates `fields[i]` in
 * place, so every alias sees the write (architecture §5/§3).
 */
interface TupleVal {
  readonly kind: 'tuple';
  readonly fields: Value[];
}

/** a word value is its canonical 256-bit slot image (architecture §5). */
type Value = bigint | BytesVal | ArrayVal | TupleVal;

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
  private readonly env: ResolvedEnv;
  private readonly trace: { stmtPath: readonly number[]; loc: SourceLoc | null; note: string }[] =
    [];
  private readonly values = new Map<ValueId, Value>();
  private readonly cells = new Map<CellId, Value>();
  private steps = 0;
  /** fn-name stack for trace-note prefixes (fn-body paths are relative to the fn body). */
  private readonly fnStack: string[] = [];

  constructor(
    ir: ScriptIr,
    chain: MockChain,
    maxSteps: number,
    tracing: boolean,
    env: ResolvedEnv,
  ) {
    this.ir = ir;
    this.chain = chain;
    this.maxSteps = maxSteps;
    this.tracing = tracing;
    this.env = env;
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

  private memref(id: ValueId): BytesVal | ArrayVal | TupleVal {
    const v = this.getValue(id);
    if (typeof v === 'bigint') {
      throw new EvsInternalError('INTERNAL', `interpret: ValueId ${id} is a word, memref expected`);
    }
    return v;
  }

  private asTuple(id: ValueId): TupleVal {
    const m = this.memref(id);
    if (m.kind !== 'tuple') {
      throw new EvsInternalError('INTERNAL', `interpret: ValueId ${id} is not a tuple memref`);
    }
    return m;
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

  /** Child statement path for trace notes — only materialized when tracing (the non-tracing
   *  hot path would otherwise allocate an array per executed statement). */
  private childPath(path: readonly number[], i: number): readonly number[] {
    return this.tracing ? [...path, i] : path;
  }

  private execBlock(stmts: readonly Stmt[], path: readonly number[]): void {
    stmts.forEach((s, i) => {
      this.execStmt(s, this.childPath(path, i));
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
        this.values.set(s.out, envValue(s.op, this.env));
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
        if (i >= BigInt(arr.items.length)) throw panicSignal(0x32);
        const item = arr.items[Number(i)];
        if (item === undefined) {
          throw new EvsInternalError('INTERNAL', `interpret: array index ${Number(i)} is missing`);
        }
        // reference semantics for composite elements: yields the element's word or memref Value.
        this.values.set(s.out, item);
        return;
      }
      case 'len': {
        const m = this.memref(s.a);
        if (m.kind === 'tuple') {
          throw new EvsInternalError('INTERNAL', `interpret: len on a tuple survived validateIr`);
        }
        this.values.set(
          s.out,
          m.kind === 'bytes' ? BigInt(m.bytes.length) : BigInt(m.items.length),
        );
        return;
      }
      case 'arrnew': {
        const len = this.word(s.length);
        if (len >= 1n << 32n) throw panicSignal(0x41);
        // zero-fill each slot with the typed zero (0n for a word element — preserves the
        // pre-composite behavior; a typed memref zero for a composite/dynamic element, §12.5).
        const elem = s.elem;
        const items = Array.from({ length: Number(len) }, () => zeroValue(elem));
        this.values.set(s.out, { kind: 'array', elem, items });
        return;
      }
      case 'tuplenew': {
        const tt = this.typeOf(s.out);
        if (!isPlainTuple(tt)) {
          throw new EvsInternalError(
            'INTERNAL',
            `interpret: tuplenew out is not a plain tuple type`,
          );
        }
        // zero-filled flat block, then overwrite each provided member (reference semantics)
        const fields: Value[] = tt.components.map((c) => zeroValue(abiParamToType(c)));
        for (const init of s.inits) {
          fields[init.index] = this.getValue(init.value);
        }
        this.values.set(s.out, { kind: 'tuple', fields });
        return;
      }
      case 'field': {
        const tup = this.asTuple(s.tuple);
        const v = tup.fields[s.index];
        if (v === undefined) {
          throw new EvsInternalError('INTERNAL', `interpret: field ${s.index} out of range`);
        }
        this.values.set(s.out, v); // reference semantics: shares the member value
        return;
      }
      case 'tupleset': {
        const tup = this.asTuple(s.tuple);
        if (s.index >= tup.fields.length) {
          throw new EvsInternalError('INTERNAL', `interpret: tupleset ${s.index} out of range`);
        }
        tup.fields[s.index] = this.getValue(s.value); // mutates in place — visible via every alias
        return;
      }
      case 'arrset': {
        const arr = this.asArray(s.arr);
        const i = this.word(s.i);
        if (i >= BigInt(arr.items.length)) throw panicSignal(0x32);
        // word element → store the canonical word (preserves canonicalization); composite element
        // → store the element's memref Value by reference (§12.5).
        arr.items[Number(i)] = isWordType(arr.elem) ? this.word(s.value) : this.getValue(s.value);
        return;
      }
      case 'encode': {
        const items = s.args.map((id) => ({ type: this.typeOf(id), value: this.getValue(id) }));
        const bytes = s.mode === 'abi' ? encodeParamsBlock(items) : encodePackedBlock(items);
        this.values.set(s.out, { kind: 'bytes', bytes });
        return;
      }
      case 'keccak256': {
        const m = this.memref(s.a);
        if (m.kind !== 'bytes') {
          throw new EvsInternalError('INTERNAL', `interpret: keccak256 over a non-bytes memref`);
        }
        this.values.set(s.out, BigInt(viemKeccak256(bytesToHex(m.bytes))));
        return;
      }
      case 'throw': {
        // custom-error revert (issue #15): `selector ‖ abi.encode(args)`, byte-exact vs codegen
        const err = (this.ir.errors ?? [])[s.error];
        if (err === undefined) {
          throw new EvsInternalError('INTERNAL', `interpret: throw with unknown error #${s.error}`);
        }
        const items = s.args.map((id) => ({ type: this.typeOf(id), value: this.getValue(id) }));
        const payload = items.length === 0 ? new Uint8Array(0) : encodeParamsBlock(items);
        throw new RevertSignal(concatBytes([hexToBytes(err.selector), payload]));
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
          this.execBlock(s.then, this.childPath(path, 0));
        } else {
          this.execBlock(s.else, this.childPath(path, 1));
        }
        return;
      }
      case 'while': {
        for (;;) {
          this.tick(); // per-iteration charge — guards loops with no statements at all
          this.execBlock(s.header, this.childPath(path, 0));
          if (this.word(s.cond) === 0n) break;
          try {
            this.execBlock(s.body, this.childPath(path, 1));
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
      throw new EvsInternalError(
        'INTERNAL',
        `interpret: bin operand of non-word type '${stringifyType(ta)}'`,
      );
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
          throw new EvsInternalError(
            'INTERNAL',
            `interpret: bitnot on non-word type '${stringifyType(ta)}'`,
          );
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
    // kind 'static' (or absent) → STATICCALL via `staticcall`; 'call'/'simulate' → the mutable
    // oracle `call`, which receives the kind (informational — see the MockChain doc) and defaults
    // to `staticcall` when the host supplied none. Everything below is kind-INDEPENDENT: a stateless
    // oracle decodes/bubbles/zeroes the returndata identically however it was produced (the rollback
    // is unobservable here — pinned in the anvil tier).
    const base = { to, data: bytesToHex(calldata) };
    let res: { success: boolean; data: Hex };
    let oracle: 'call' | 'staticcall';
    if ((s.kind === 'call' || s.kind === 'simulate') && this.chain.call !== undefined) {
      oracle = 'call';
      res = this.chain.call({ ...base, kind: s.kind }); // s.kind narrowed to 'call' | 'simulate'
    } else {
      oracle = 'staticcall';
      res = this.chain.staticcall(base);
    }
    if (typeof res !== 'object' || res === null || typeof res.success !== 'boolean') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `interpret: MockChain.${oracle} returned a malformed result for ${s.fnAbi.name}()`,
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
      this.values.set(out, zeroValue(abiParamToType(p)));
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
      return { type: abiParamToType(p), value: this.getValue(id) };
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
    const anyDynamic = this.ir.returns.some((r) => abiIsDynamic(r.type));
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
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: convert over '${stringifyType(from)}' → '${stringifyType(to)}'`,
    );
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
  // a `data` const array literal is always a word-element block (`[len][w0]…`, CODECOPY-materialized);
  // composite-element arrays are built at runtime (arrnew + arrset), never a data const.
  const elem = asWordElem(elemTypeOf(asArrayType(type)));
  const items = Array.from({ length: len }, (_, i) => readWord(bytes, 32 + 32 * i));
  return { kind: 'array', elem, items };
}

function envValue(op: string, env: ResolvedEnv): bigint {
  switch (op) {
    case 'address':
      return env.address;
    case 'caller':
      return env.caller;
    case 'timestamp':
      return env.timestamp;
    case 'blocknumber':
      return env.blocknumber;
    case 'chainid':
      return env.chainid;
    default:
      throw new EvsInternalError('INTERNAL', `interpret: unknown env op '${op}'`);
  }
}

function zeroValue(type: EvsType): Value {
  if (isPlainTuple(type)) {
    // a plain tuple zeroes to a flat block of zeroed fields (a tuple[] is an array — falls through).
    return { kind: 'tuple', fields: type.components.map((c) => zeroValue(abiParamToType(c))) };
  }
  if (isWordType(type)) return 0n;
  if (type === 'string' || type === 'bytes') return { kind: 'bytes', bytes: new Uint8Array(0) };
  // an array (string array OR tuple[]) zeroes to an empty array carrying its element type.
  return { kind: 'array', elem: elemTypeOf(asArrayType(type)), items: [] };
}

// ---------------------------------------------------------------------------
// ABI encode (standard head/tail over raw bytes — §7.1 / §8.2 shapes, tuple-aware)
// ---------------------------------------------------------------------------

/**
 * ABI-dynamic iff a memref: string/bytes/`T[]` (incl. `tuple[]`) always; a plain `tuple` iff any
 * component is dynamic; a word is static. A tuple-array descriptor (`type === 'tuple[]'`) is an
 * array, NOT a flat tuple, so it is unconditionally dynamic.
 */
function abiIsDynamic(type: EvsType): boolean {
  if (isTupleType(type)) {
    if (type.type !== 'tuple') return true; // tuple[]/tuple[][] are arrays — always dynamic
    return type.components.some((c) => abiIsDynamic(abiParamToType(c)));
  }
  return !isWordType(type);
}

/** ABI head word count of a type: a static (plain) tuple inlines its components' heads; an array
 *  or any dynamic type is one offset word. */
function headWords(type: EvsType): number {
  if (isTupleType(type) && type.type === 'tuple' && !abiIsDynamic(type)) {
    return type.components.reduce((n, c) => n + headWords(abiParamToType(c)), 0);
  }
  return 1;
}

/**
 * Encodes a head/tail block over `items` (the standard ABI tuple body): static members (words and
 * static tuples) inline into the head; dynamic members (string/bytes/T[]/dynamic tuple) get a head
 * offset (relative to the block start) and an appended tail. Byte-equal to viem
 * `encodeAbiParameters`.
 */
function encodeParamsBlock(items: readonly { type: EvsType; value: Value }[]): Uint8Array {
  const headSize = items.reduce((n, it) => n + 32 * headWords(it.type), 0);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailLen = 0;
  for (const item of items) {
    if (abiIsDynamic(item.type)) {
      heads.push(wordToBytes(BigInt(headSize + tailLen)));
      const tail = encodeTail(item.type, item.value);
      tails.push(tail);
      tailLen += tail.length;
    } else {
      heads.push(encodeStatic(item.type, item.value));
    }
  }
  return concatBytes([...heads, ...tails]);
}

/**
 * Packed (`abi.encodePacked`) encoding over `items` (issue #17): a word packs to its exact byte
 * width with no padding (`uintN`/`intN` → the low `N/8` bytes of the canonical word, `address` →
 * 20 bytes, `bool` → 1 byte, `bytesN` → the high `N` bytes); `string`/`bytes` contribute their raw
 * payload with no length prefix; a word-element array packs each element padded to 32 bytes (the
 * Solidity in-array padding rule). Composite types never reach here (validateIr rejects them in
 * packed mode, matching solc's compile error). Byte-equal to viem `encodePacked`.
 */
function encodePackedBlock(items: readonly { type: EvsType; value: Value }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const item of items) {
    const { type, value } = item;
    if (isWordType(type)) {
      if (typeof value !== 'bigint') {
        throw new EvsInternalError('INTERNAL', `interpret: word value expected for '${type}'`);
      }
      const size = bitsOf(type) / 8; // bool → 1 (bitsOf 8), address → 20 (bitsOf 160)
      const word = wordToBytes(value);
      chunks.push(type.startsWith('bytes') ? word.slice(0, size) : word.slice(32 - size));
      continue;
    }
    if (typeof value === 'bigint' || value.kind === 'tuple') {
      throw new EvsInternalError('INTERNAL', 'interpret: packed encode over a non-packable value');
    }
    if (value.kind === 'bytes') {
      chunks.push(value.bytes); // raw payload, no length prefix
      continue;
    }
    // word-element array: each element is its canonical word — exactly the padded encoding.
    for (const it of value.items) {
      if (typeof it !== 'bigint') {
        throw new EvsInternalError('INTERNAL', 'interpret: packed array element is not a word');
      }
      chunks.push(wordToBytes(it));
    }
  }
  return concatBytes(chunks);
}

/** True for a **plain** tuple descriptor (`{type:'tuple'}`) — NOT a tuple array (`tuple[]`). */
function isPlainTuple(type: EvsType): type is TupleType {
  return isTupleType(type) && type.type === 'tuple';
}

/** Encodes an ABI-static value into its inline head bytes: a word (one word) or a static tuple
 *  (its components' heads concatenated, recursively). Arrays are never static, so never reach here. */
function encodeStatic(type: EvsType, value: Value): Uint8Array {
  if (isPlainTuple(type)) {
    if (typeof value === 'bigint' || value.kind !== 'tuple') {
      throw new EvsInternalError('INTERNAL', `interpret: tuple value expected for a static tuple`);
    }
    return encodeParamsBlock(
      type.components.map((c, i) => ({
        type: abiParamToType(c),
        value: tupleField(value, i),
      })),
    );
  }
  if (typeof value !== 'bigint') {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: word value expected for ${stringifyType(type)}`,
    );
  }
  return wordToBytes(value);
}

/**
 * Encodes a dynamic member's tail: a recursive head/tail block (a dynamic plain tuple),
 * `[len][padded payload]` (bytes/string), or a `T[]` array tail (incl. `tuple[]`/`T[][]`).
 */
function encodeTail(type: EvsType, value: Value): Uint8Array {
  if (isPlainTuple(type)) {
    if (typeof value === 'bigint' || value.kind !== 'tuple') {
      throw new EvsInternalError('INTERNAL', `interpret: tuple value expected for a dynamic tuple`);
    }
    return encodeParamsBlock(
      type.components.map((c, i) => ({
        type: abiParamToType(c),
        value: tupleField(value, i),
      })),
    );
  }
  if (typeof value === 'bigint') {
    throw new EvsInternalError('INTERNAL', 'interpret: memref value expected for a dynamic type');
  }
  // string/bytes payload tail
  if (value.kind === 'bytes') {
    const padded = padWordAligned(value.bytes);
    return concatBytes([wordToBytes(BigInt(value.bytes.length)), padded]);
  }
  if (value.kind !== 'array') {
    throw new EvsInternalError('INTERNAL', 'interpret: array value expected for an array type');
  }
  return encodeArrayTail(value.elem, value.items);
}

/**
 * Encodes a `T[]` tail (§12.2): `[len]` then, for a **static** element, each element inlined
 * contiguously (`len · staticSize(E)` bytes, NO offset words); for a **dynamic** element, `len`
 * offset words each relative to the array DATA START `D` (the word after `len`), then the element
 * tails appended from `D + 32·len`. Word-array encode (every item a word, static element) reduces
 * to `[len]` + one `wordToBytes` per item — byte-identical to the pre-composite path.
 */
function encodeArrayTail(elem: EvsType, items: readonly Value[]): Uint8Array {
  const len = wordToBytes(BigInt(items.length));
  if (!abiIsDynamic(elem)) {
    // static element: [len] then each element's inline head bytes, contiguous.
    return concatBytes([len, ...items.map((it) => encodeStatic(elem, it))]);
  }
  // dynamic element: [len][off0]…[off_{len-1}] (each relative to D = the word after len) then tails.
  const offsetWordsBytes = 32 * items.length;
  const offsets: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailLen = 0;
  for (const it of items) {
    offsets.push(wordToBytes(BigInt(offsetWordsBytes + tailLen)));
    const tail = encodeTail(elem, it);
    tails.push(tail);
    tailLen += tail.length;
  }
  return concatBytes([len, ...offsets, ...tails]);
}

/** Member `i` of a {@link TupleVal} (validateIr guarantees the index is in range). */
function tupleField(value: TupleVal, i: number): Value {
  const v = value.fields[i];
  if (v === undefined) {
    throw new EvsInternalError('INTERNAL', `interpret: tuple member ${i} is missing`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// returndata decode (architecture §7.2, steps 3–5 — exact bounds + normalization)
// ---------------------------------------------------------------------------

/** `null` = structural decode failure (the per-site `EvsDecodeError` / tryCall-zero trigger). */
function decodeOutputs(
  outputs: PlainAbiFunction['outputs'],
  data: Uint8Array,
): readonly Value[] | null {
  // top-level outputs are a head/tail block based at byte 0, bounded by the returndata length
  return decodeBlock(outputs, data, 0, data.length);
}

/** ABI head byte size of `params`: a static tuple inlines its whole head (cumulative walk). */
function abiHeadBytes(params: readonly NamedType[]): number {
  return params.reduce((n, p) => n + 32 * headWords(abiParamToType(p)), 0);
}

/**
 * Decodes one ABI head/tail block (`components`) from `data` at `[base, end)`, where dynamic
 * offsets are relative to `base`. Returns the member values (dynamic members own fresh buffers /
 * nested flat blocks, never aliasing). `null` on any structural failure. Mirrors the codegen
 * memory decoder byte-for-byte; static word outputs normalize-don't-revert.
 */
function decodeBlock(
  components: readonly NamedType[],
  data: Uint8Array,
  base: number,
  end: number,
): readonly Value[] | null {
  // staticMinSize guard BEFORE any head read (§7.2 step 3): the head must fit in [base, end)
  if (BigInt(end - base) < BigInt(abiHeadBytes(components))) return null;
  const decoded: Value[] = [];
  let headOff = 0; // cumulative head offset within this block
  for (const p of components) {
    const type = abiParamToType(p);
    if (!abiIsDynamic(type)) {
      // static member (word or static tuple) inlines at base+headOff
      const v = decodeStatic(type, data, base + headOff, end);
      if (v === null) return null;
      decoded.push(v);
      headOff += 32 * headWords(type);
      continue;
    }
    // dynamic member: offset word at base+headOff, relative to base; off ≤ 2^64−1, +32 ≤ end
    const off = readWord(data, base + headOff);
    headOff += 32;
    if (off > U64_MAX) return null;
    const ptr = BigInt(base) + off;
    if (ptr + 32n > BigInt(end)) return null;
    const v = decodeDynamic(type, data, Number(ptr), end);
    if (v === null) return null;
    decoded.push(v);
  }
  return decoded;
}

/** Decodes a static member (word → normalized canonical; static plain tuple → inlined recurse).
 *  An array is never static, so it never reaches here. */
function decodeStatic(type: EvsType, data: Uint8Array, at: number, end: number): Value | null {
  if (isPlainTuple(type)) {
    const fields = decodeBlock(type.components, data, at, end);
    return fields === null ? null : { kind: 'tuple', fields: [...fields] };
  }
  if (!isWordType(type)) {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: decodeStatic over non-word '${stringifyType(type)}'`,
    );
  }
  return canonWord(type, readWord(data, at));
}

/** Decodes a dynamic member at `ptr` (dynamic plain tuple → recurse; string/bytes → fresh buffer;
 *  `T[]`/`tuple[]`/`T[][]` → element loop). */
function decodeDynamic(type: EvsType, data: Uint8Array, ptr: number, end: number): Value | null {
  if (isPlainTuple(type)) {
    // a dynamic tuple's block starts at ptr; its offsets are relative to ptr
    const fields = decodeBlock(type.components, data, ptr, end);
    return fields === null ? null : { kind: 'tuple', fields: [...fields] };
  }
  const len = readWord(data, ptr);
  if (len > U64_MAX) return null;
  if (type === 'string' || type === 'bytes') {
    if (BigInt(ptr) + 32n + len > BigInt(end)) return null;
    const start = ptr + 32;
    return { kind: 'bytes', bytes: data.slice(start, start + Number(len)) };
  }
  // T[] (§12.2 decode): D = data start (word after len). A static element is inlined at
  // D + i·staticSize; a dynamic element is reached via a per-element offset word at D + 32·i,
  // each offset relative to D. Each element is a fresh Value (no aliasing across elements).
  const elem = elemTypeOf(asArrayType(type));
  const D = ptr + 32; // array data start
  const n = Number(len);
  if (!abiIsDynamic(elem)) {
    // static element: the whole body must fit — D + len·staticSize ≤ end.
    const staticSize = 32 * headWords(elem);
    if (BigInt(D) + BigInt(n) * BigInt(staticSize) > BigInt(end)) return null;
    const items: Value[] = [];
    for (let i = 0; i < n; i++) {
      const v = decodeStatic(elem, data, D + i * staticSize, end);
      if (v === null) return null;
      items.push(v);
    }
    return { kind: 'array', elem, items };
  }
  // dynamic element: the offset word region (len words at [D, D+32·len)) must fit first.
  if (BigInt(D) + 32n * len > BigInt(end)) return null;
  const items: Value[] = [];
  for (let i = 0; i < n; i++) {
    const off = readWord(data, D + 32 * i);
    if (off > U64_MAX) return null;
    const elemPtr = BigInt(D) + off; // offset relative to D (the array data start)
    if (elemPtr + 32n > BigInt(end)) return null;
    const v = decodeDynamic(elem, data, Number(elemPtr), end);
    if (v === null) return null;
    items.push(v);
  }
  return { kind: 'array', elem, items };
}

// ---------------------------------------------------------------------------
// script-arg coercion (the JS mirror of the §8.1 calldata trust boundary)
// ---------------------------------------------------------------------------

function coerceArg(name: string, type: EvsType, value: unknown, loc: SourceLoc | null): Value {
  const where = `interpret: argument "${name}" (${stringifyType(type)})`;
  return coerceValue(type, value, where, loc);
}

/** Coerces a host literal to a {@link Value} of `type` (the JS mirror of the §8.1 trust boundary,
 *  recursing through tuple components — named object when all members named, positional otherwise). */
function coerceValue(type: EvsType, value: unknown, where: string, loc: SourceLoc | null): Value {
  if (isPlainTuple(type)) return coerceTuple(type, value, where, loc); // a tuple[] falls through to the array arm
  if (isWordType(type)) return coerceWordArg(type, value, where, loc);
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a string`, { loc });
    }
    return { kind: 'bytes', bytes: TEXT_ENCODER.encode(value) };
  }
  if (type === 'bytes') {
    return { kind: 'bytes', bytes: coerceHexArg(value, null, where, loc) };
  }
  const elem = elemTypeOf(asArrayType(type));
  if (!Array.isArray(value)) {
    throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected an array`, { loc });
  }
  const raw: readonly unknown[] = value;
  // recurse per element: a word element coerces to a canonical word, a composite/dynamic element
  // (tuple/string/bytes/T[]) coerces to its own memref Value (§12.5).
  return {
    kind: 'array',
    elem,
    items: raw.map((el, i) => coerceValue(elem, el, `${where}[${i}]`, loc)),
  };
}

/** Coerces a host literal struct/tuple to a {@link TupleVal}: a name-keyed object when every
 *  member is named (abitype's all-named rule), or a positional array otherwise. */
function coerceTuple(type: TupleType, value: unknown, where: string, loc: SourceLoc | null): Value {
  const comps = type.components;
  const allNamed = comps.every((c) => c.name !== '');
  if (allNamed && !Array.isArray(value)) {
    if (typeof value !== 'object' || value === null) {
      throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a struct object`, { loc });
    }
    return {
      kind: 'tuple',
      fields: comps.map((c) =>
        coerceValue(
          abiParamToType(c),
          // own properties only (Object.entries semantics) — never the prototype chain
          Object.hasOwn(value, c.name) ? (Reflect.get(value, c.name) as unknown) : undefined,
          `${where}.${c.name}`,
          loc,
        ),
      ),
    };
  }
  if (!Array.isArray(value)) {
    throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a positional tuple array`, { loc });
  }
  const items: readonly unknown[] = value;
  if (items.length !== comps.length) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: expected ${comps.length} members, got ${items.length}`,
      { loc },
    );
  }
  return {
    kind: 'tuple',
    fields: comps.map((c, i) => coerceValue(abiParamToType(c), items[i], `${where}[${i}]`, loc)),
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
  if (isPlainTuple(type)) {
    if (typeof value === 'bigint' || value.kind !== 'tuple') {
      throw new EvsInternalError('INTERNAL', `interpret: tuple value expected for a tuple type`);
    }
    return jsTuple(type, value);
  }
  if (isWordType(type)) {
    if (typeof value !== 'bigint') {
      throw new EvsInternalError('INTERNAL', `interpret: word value expected for ${type}`);
    }
    return jsWord(type, value);
  }
  // string/bytes/array (incl. tuple[]) — all memref-valued
  if (typeof value === 'bigint' || value.kind === 'tuple') {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: memref value expected for ${stringifyType(type)}`,
    );
  }
  if (value.kind === 'bytes') {
    return type === 'string' ? TEXT_DECODER.decode(value.bytes) : bytesToHex(value.bytes);
  }
  // an array projects to items.map(jsValueOf) — a flat number/bigint list for word elements, a
  // nested array/object list for composite elements (matching abitype/viem decode shape, §12.5).
  const elem = elemTypeOf(asArrayType(type));
  return value.items.map((item) => jsValueOf(elem, item));
}

/** abitype's tuple projection: an object keyed by component names when ALL members are named,
 *  a positional array otherwise (recursing through members). */
function jsTuple(type: TupleType, value: TupleVal): unknown {
  const comps = type.components;
  const projected = comps.map((c, i) => jsValueOf(abiParamToType(c), tupleField(value, i)));
  if (comps.every((c) => c.name !== '')) {
    const obj: Record<string, unknown> = {};
    comps.forEach((c, i) => {
      obj[c.name] = projected[i];
    });
    return obj;
  }
  return projected;
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

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

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

function readWord(bytes: Uint8Array, offset: number): bigint {
  return readPartialWord(bytes, offset, 32);
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

/**
 * The array types this interp handles (§12): a string array `T[]` whose element is a word,
 * `string`/`bytes`, or a one-level word `T[]` (`uint256[]`, `string[]`, `uint256[][]`), OR a
 * `tuple[]`. Still rejected (still `UNSUPPORTED_V0` at validation): `tuple[][]` and string arrays
 * nested deeper than `[][]`. `T[N]` is not representable as a string array.
 */
function isSupportedArrayType(s: EvsType): s is ArrayType | TupleType {
  if (typeof s !== 'string') return s.type === 'tuple[]';
  if (!s.endsWith('[]')) return false;
  const elem = s.slice(0, -2);
  // element must be a word, string/bytes, or a one-level word array (uint256[] etc.).
  return (
    isWordType(elem) ||
    elem === 'string' ||
    elem === 'bytes' ||
    (elem.endsWith('[]') && isWordType(elem.slice(0, -2)))
  );
}

/** Narrows an array value type (string `T[]` or `tuple[]`) for {@link elemTypeOf}. */
function asArrayType(s: EvsType): ArrayType | TupleType {
  if (isSupportedArrayType(s)) return s;
  throw new EvsInternalError(
    'INTERNAL',
    `interpret: '${stringifyType(s)}' is not a supported array type`,
  );
}

/** Narrows a value type guaranteed (by validateIr) to be a word — used where a word element is
 *  required (data-const array literals, word-array JS projection). */
function asWordElem(t: EvsType): WordType {
  if (!isWordType(t)) {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: expected a word element type, got '${stringifyType(t)}'`,
    );
  }
  return t;
}

/** Human-readable rendering of a value type (tuples → their JSON descriptor). */
function stringifyType(t: EvsType): string {
  return typeof t === 'string' ? t : JSON.stringify(t);
}

/** short trace note per statement (prefixed with the fn-name stack inside fn bodies). */
function noteOf(s: Stmt): string {
  switch (s.k) {
    case 'const':
      return `const ${stringifyType(s.type)}`;
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
      return `arrnew ${stringifyType(s.elem)}[]`;
    case 'arrset':
      return 'arrset';
    case 'tuplenew':
      return 'tuplenew';
    case 'field':
      return `field #${s.index}`;
    case 'tupleset':
      return `tupleset #${s.index}`;
    case 'encode':
      return `encode ${s.mode}`;
    case 'keccak256':
      return 'keccak256';
    case 'throw':
      return `throw errors[${s.error}]`;
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
