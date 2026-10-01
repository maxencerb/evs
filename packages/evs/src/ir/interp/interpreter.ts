/**
 * `ir/interp/interpreter.ts` — the reference interpreter's public interface (`interpret`,
 * `MockChain`, `InterpResult`, `InterpEnvOverrides`) and `Interp`, the statement executor: value
 * and cell tables, step budget, tracing, sub-calls against the `MockChain` and `s.fn` calls.
 * The binding invariants are documented on the `ir/interp.ts` barrel.
 */

import { keccak256 as viemKeccak256 } from 'viem';

import { bytesToHex, hexToBytes, u256ToBytes as wordToBytes } from '../../core/bytes.js';
import { EvsTypeError, EvsInternalError, EvsCompileError } from '../../core/errors.js';
import {
  type Hex,
  type EvsType,
  abiParamToType,
  isWordType,
  stringifyType,
} from '../../core/types.js';
import { eliminateDeadCode } from '../dce.js';
import {
  type ScriptIr,
  type ValueId,
  type CellId,
  type Stmt,
  callOutputs,
  type PlainAbiFunction,
} from '../nodes.js';
import { validateIr } from '../validate.js';
import {
  constValue,
  modArith,
  envValue,
  convert,
  zeroValue,
  zeroFillSlots,
  binOp,
  canonWord,
} from './arith.js';
import { coerceArg, jsValueOf } from './coerce.js';
import { decodeOutputs } from './decode.js';
import { encodeParamsBlock, encodePackedBlock, abiIsDynamic } from './encode.js';
import {
  DEFAULT_MAX_STEPS,
  resolveEnv,
  type ResolvedEnv,
  type Value,
  RevertSignal,
  LoopSignal,
  noteOf,
  type BytesVal,
  type ArrayVal,
  type TupleVal,
  panicSignal,
  isPlainTuple,
  concatBytes,
  MASK256,
  hexToBytesChecked,
  decodeErrorSignal,
} from './values.js';

// ---------------------------------------------------------------------------
// public interface
// ---------------------------------------------------------------------------

export interface MockChain {
  /**
   * The STATICCALL oracle (`s.read` / `s.tryRead`; also the fallback for every other verb when
   * {@link MockChain.call} is omitted). `req.gas` is the site's `gas` cap when one was given
   * (absent = forward all) — the interpreter has no gas model, so it is informational: a mock
   * MAY use it to emulate an out-of-gas target (`{ success: false, data: '0x' }`), and the
   * compiled bytecode agrees byte-for-byte with whatever the mock answers.
   */
  staticcall(req: { to: Hex; data: Hex; gas?: bigint }): { success: boolean; data: Hex };
  /**
   * Optional mutable-subcall oracle for `s.call` / `s.simulate` (issue #1). Defaults to
   * {@link MockChain.staticcall} when omitted. `req.gas` is the site's `gas` cap, as above —
   * for `'simulate'` it bounds the INNER target call (the self-call hop forwards all gas).
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
  call?(req: { to: Hex; data: Hex; kind: 'call' | 'simulate'; gas?: bigint }): {
    success: boolean;
    data: Hex;
  };
}

export interface InterpResult {
  outcome:
    | { kind: 'return'; data: Hex; values: Record<string, unknown> } // data = ABI-encoded returndata
    | { kind: 'revert'; data: Hex }; // byte-exact revert payload
  trace?: readonly { stmtPath: readonly number[]; note: string }[];
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

/**
 * Runs `ir` against `chain` with `args`. By default it executes `eliminateDeadCode(ir)` — the
 * IR `compile()` lowers — so the outcome is the shipped bytecode's: a checked op, bounds check
 * or narrowing whose result nothing reads is dead code there, and its Panic with it (see
 * `ir/dce.ts`). `opts.dce: false` executes the IR exactly as recorded instead, every revert
 * guard included. `trace` paths index the IR that ran.
 */
export function interpret(
  ir: ScriptIr,
  args: readonly unknown[],
  chain: MockChain,
  opts?: { trace?: boolean; maxSteps?: number; env?: InterpEnvOverrides; dce?: boolean },
): InterpResult {
  validateIr(ir);
  const program = opts?.dce === false ? ir : eliminateDeadCode(ir);
  const maxSteps = opts?.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: maxSteps must be a positive safe integer, got ${String(maxSteps)}`,
    );
  }
  const env = resolveEnv(opts?.env);
  return new Interp(program, chain, maxSteps, opts?.trace === true, env).run(args);
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
  private readonly trace: { stmtPath: readonly number[]; note: string }[] = [];
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
      );
    }
    ir.args.forEach((a, i) => {
      this.values.set(i, coerceArg(a.name, a.type, args[i]));
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

  /** one budget unit; also charged once per loop iteration (guards zero-stmt loops). Zero-fills
   *  are charged per element by {@link chargeZeroFill}. */
  private tick(): void {
    this.steps += 1;
    if (this.steps > this.maxSteps) {
      throw new EvsCompileError(
        'COMPILE_LIMIT',
        `interpret: script "${this.ir.name}" exceeded maxSteps = ${this.maxSteps} (likely an unbounded loop; raise opts.maxSteps if intentional)`,
      );
    }
  }

  /**
   * Charges `elements` zero-filled array elements to the step budget, one step each (see
   * {@link zeroFillSlots}), BEFORE they are allocated: the EVM pays gas to zero-fill memory,
   * and a zero-fill the remaining budget cannot cover throws `COMPILE_LIMIT` instead of
   * exhausting the host heap (`uint256[1e8][1e8]`, `s.newArray(t.uint256, 2 ** 32 - 1)`).
   */
  private chargeZeroFill(elements: bigint): void {
    if (elements === 0n) return;
    if (elements > BigInt(this.maxSteps - this.steps)) {
      throw new EvsCompileError(
        'COMPILE_LIMIT',
        `interpret: script "${this.ir.name}" exceeded maxSteps = ${this.maxSteps} zero-filling ${elements} array elements (one step each; raise opts.maxSteps if intentional)`,
      );
    }
    this.steps += Number(elements);
  }

  private step(s: Stmt, path: readonly number[]): void {
    this.tick();
    if (this.tracing) {
      const prefix = this.fnStack.length > 0 ? `fn "${this.fnStack.join('"."')}": ` : '';
      this.trace.push({ stmtPath: path, note: `${prefix}${noteOf(s)}` });
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
      case 'modarith': {
        this.values.set(s.out, modArith(s.op, this.word(s.a), this.word(s.b), this.word(s.n)));
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
        // pre-composite behavior; a typed memref zero for a composite/dynamic element).
        const elem = s.elem;
        this.chargeZeroFill(len * (1n + zeroFillSlots(elem)));
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
        // the typed zero of each omitted member, then each provided one (reference semantics).
        // Like the bytecode (`emitZeroMemrefMembers` skips the inits), a provided member is never
        // zero-filled, so only the omitted ones are charged and materialized.
        const given = new Set(s.inits.map((init) => init.index));
        let slots = 0n;
        tt.components.forEach((c, i) => {
          if (!given.has(i)) slots += zeroFillSlots(abiParamToType(c));
        });
        this.chargeZeroFill(slots);
        const fields: Value[] = tt.components.map((c, i) =>
          given.has(i) ? 0n : zeroValue(abiParamToType(c)),
        );
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
        // → store the element's memref Value by reference.
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
  // bin / un ops (see module doc for the exact-math equivalence)
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
        // NOT then re-canonicalize (post-mask / re-sign-extend)
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
  // calls
  // -------------------------------------------------------------------------

  private execCall(s: Extract<Stmt, { k: 'call' }>): void {
    const target = this.word(s.target);
    // the gas cap is evaluated (it is an ordinary uint256 operand) and handed to the oracle as
    // information — the interpreter has no gas model of its own
    const gas = s.gas === undefined ? undefined : this.word(s.gas);
    const calldata = this.encodeCalldata(s.fnAbi, s.args);
    const to: Hex = `0x${target.toString(16).padStart(40, '0')}`;
    // kind 'static' (or absent) → STATICCALL via `staticcall`; 'call'/'simulate' → the mutable
    // oracle `call`, which receives the kind (informational — see the MockChain doc) and defaults
    // to `staticcall` when the host supplied none. Everything below is kind-INDEPENDENT: a stateless
    // oracle decodes/bubbles/zeroes the returndata identically however it was produced (the rollback
    // is unobservable here — pinned in the anvil tier).
    const base = { to, data: bytesToHex(calldata), ...(gas === undefined ? {} : { gas }) };
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
      );
    }
    const data = hexToBytesChecked(res.data, `MockChain returndata for ${s.fnAbi.name}()`);
    if (s.revertReturns === undefined) {
      if (!res.success) {
        if (s.mode === 'strict') throw new RevertSignal(data); // bubble verbatim
        this.zeroCallOuts(s);
        return;
      }
    } else if (res.success) {
      // revert-data-as-result (issue #35): a normal RETURN is the failure — nothing is bubbled
      // (there is no revert payload to bubble); strict lands on the site's decode-fail
      // (`EvsDecodeError(site)`), try zeroes. Only a REVERT payload is ever decoded (below).
      if (s.mode === 'strict') throw decodeErrorSignal(s.site);
      this.zeroCallOuts(s);
      return;
    }
    // the decode schema: `revertReturns` over the revert payload, else the ABI outputs over the
    // returndata — the same guard/bounds sequence either way.
    const decoded = decodeOutputs(callOutputs(s), data);
    if (decoded === null) {
      // structural decode failure (staticMinSize guard / decode bounds)
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
   * tryCall failure values: `success = 0`, word outs = 0, memref outs point at
   * the zero slot ⇒ empty string / empty bytes / empty array. Taken on call failure AND on
   * malformed returndata.
   */
  private zeroCallOuts(s: Extract<Stmt, { k: 'call' }>): void {
    const outputs = callOutputs(s);
    s.outs.forEach((out, i) => {
      const p = outputs[i];
      if (p === undefined) {
        throw new EvsInternalError('INTERNAL', `interpret: call out ${i} has no output schema`);
      }
      const type = abiParamToType(p);
      this.chargeZeroFill(zeroFillSlots(type));
      this.values.set(out, zeroValue(type));
    });
    if (s.successOut !== undefined) this.values.set(s.successOut, 0n);
  }

  /** selector ++ standard ABI args block — byte-equal to viem `encodeFunctionData`. */
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
    // fn-call convention: caller stores args into the callee's param slots …
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
  // return encoding + JS value record
  // -------------------------------------------------------------------------

  private encodeReturn(): { data: Uint8Array; values: Record<string, unknown> } {
    const items = this.ir.returns.map((r) => ({ type: r.type, value: this.getValue(r.value) }));
    const block = encodeParamsBlock(items);
    // dynamic tuple ⇒ top-level 0x20 offset; all-static ⇒ components inline
    const anyDynamic = this.ir.returns.some((r) => abiIsDynamic(r.type));
    const data = anyDynamic ? concatBytes([wordToBytes(32n), block]) : block;
    const values: Record<string, unknown> = {};
    for (const r of this.ir.returns) values[r.name] = jsValueOf(r.type, this.getValue(r.value));
    return { data, values };
  }
}
