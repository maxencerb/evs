/**
 * `ir/nodes/schema.ts` — the ScriptIr node inventory: ids, the value / cell / fn tables, the
 * statement union, the plain ABI shapes, and the op vocabularies (`BinOp`, `isEnvOp`, …).
 */

import { type ArgType, type EvsType, type Hex, typeToAbiParam } from '../../core/types.js';

export type ValueId = number;
export type CellId = number;
export type FnId = number;
export type SiteId = number;

export interface ScriptIr {
  readonly irVersion: 1;
  readonly name: string;
  readonly args: readonly { name: string; type: ArgType }[];
  readonly values: readonly ValueInfo[]; // indexed by ValueId
  readonly cells: readonly CellInfo[]; // indexed by CellId
  readonly fns: readonly FnIr[]; // indexed by FnId, topologically recorded
  readonly body: readonly Stmt[];
  readonly returns: readonly { name: string; type: EvsType; value: ValueId }[];
  // declared custom errors (issue #15), indexed by `throw` stmts' `error` field. OPTIONAL and
  // omitted when empty, so pre-#15 serialized IR round-trips byte-identically (the `call.kind`
  // precedent); absent ⇒ no error may be thrown.
  readonly errors?: readonly PlainAbiError[];
}

export interface ValueInfo {
  readonly type: EvsType;
  readonly debugName?: string;
}

export interface CellInfo {
  readonly type: EvsType;
  readonly debugName?: string;
}

export interface FnIr {
  readonly name: string;
  readonly params: readonly { name: string; type: EvsType; value: ValueId }[];
  readonly results: readonly { type: EvsType }[];
  readonly body: readonly Stmt[];
  readonly resultValues: readonly ValueId[];
}

export type BinOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'pow' // checked exponentiation (solc `**`): `a` numeric, `b` (the exponent) any uintN
  | 'lt'
  | 'gt'
  | 'lte'
  | 'gte'
  | 'eq'
  | 'neq'
  | 'and'
  | 'or'
  | 'bitand'
  | 'bitor'
  | 'bitxor'
  | 'shl'
  | 'shr';
export type UnOp = 'not' | 'bitnot' | 'iszero';
/** Full-precision modular ops (issue #10): `(a op b) % n` over uint256, Panic 0x12 on `n == 0`. */
export type ModArithOp = 'addmod' | 'mulmod';
export type EnvOp = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid';

export type ConstData =
  | { kind: 'word'; hex: Hex } // canonical 32-byte value
  | { kind: 'data'; hex: Hex }; // pre-encoded memref payload [len:32][payload…]

export interface PlainAbiParam {
  readonly name: string;
  readonly type: string;
  readonly components?: readonly PlainAbiParam[];
}

export interface PlainAbiFunction {
  readonly name: string;
  readonly selector: Hex;
  readonly inputs: readonly PlainAbiParam[];
  readonly outputs: readonly PlainAbiParam[];
}

/** A declared custom error (issue #15) — the IR mirror of a `t.error` value: resolved
 *  (non-empty, unique) input names, plus the precomputed 4-byte selector (like
 *  {@link PlainAbiFunction} — lowering and explainRevert never recompute keccak). */
export interface PlainAbiError {
  readonly name: string;
  readonly selector: Hex;
  readonly inputs: readonly PlainAbiParam[];
}

export type Stmt = { readonly site: SiteId } & (
  | { k: 'const'; out: ValueId; data: ConstData; type: EvsType }
  | { k: 'bin'; op: BinOp; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'un'; op: UnOp; a: ValueId; out: ValueId }
  // ADDMOD / MULMOD (issue #10): uint256 operands, `n` the modulus (Panic 0x12 when zero)
  | { k: 'modarith'; op: ModArithOp; a: ValueId; b: ValueId; n: ValueId; out: ValueId }
  | { k: 'env'; op: EnvOp; out: ValueId }
  | { k: 'convert'; a: ValueId; out: ValueId } // semantics from values[a].type → values[out].type
  | { k: 'select'; cond: ValueId; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'index'; arr: ValueId; i: ValueId; out: ValueId }
  | { k: 'len'; a: ValueId; out: ValueId }
  // `fixed` (OPTIONAL, additive since #4): present for a fixed-size array `elem[N]` — the out
  // value's type is then `elem[N]` and `length` MUST be a word const equal to `N` (validateIr
  // checks it), so the memory block's length word always equals `N`. Absent ⇒ a dynamic `elem[]`
  // (pre-#4 IR deserializes unchanged).
  | { k: 'arrnew'; elem: EvsType; length: ValueId; fixed?: number; out: ValueId }
  | { k: 'arrset'; arr: ValueId; i: ValueId; value: ValueId }
  // composite (tuple/struct) construction + member access. The out/tuple ValueId's
  // `values[id].type` carries the {@link TupleType} (with components); these nodes hold only the
  // member index. A tuple is a memref to a packed `[field0…fieldN]` block (one word per member,
  // a nested pointer for dynamic/composite members).
  | { k: 'tuplenew'; inits: readonly { index: number; value: ValueId }[]; out: ValueId }
  | { k: 'field'; tuple: ValueId; index: number; out: ValueId }
  | { k: 'tupleset'; tuple: ValueId; index: number; value: ValueId }
  // ABI encoding + hashing (issue #17). `encode` materializes the standard (`abi.encode`) or
  // packed (`abi.encodePacked`) encoding of its args into a fresh `bytes` memref; `keccak256`
  // hashes a `bytes`/`string` memref's payload into a `bytes32` word. `s.keccak256(...args)`
  // records standard-encode-then-hash (`keccak256(abi.encode(...))` — issue #24), skipping the
  // encode when the single arg is already `bytes`/`string` (Solidity's `keccak256(bytes)`).
  | { k: 'encode'; mode: 'abi' | 'packed'; args: readonly ValueId[]; out: ValueId }
  | { k: 'keccak256'; a: ValueId; out: ValueId }
  // custom-error revert (issue #15): terminates with `selector ‖ abi.encode(args)` revert data.
  // `error` indexes `ir.errors`; `args` match the error's inputs positionally (arity + types
  // enforced by validateIr). No out — the statement never falls through.
  | { k: 'throw'; error: number; args: readonly ValueId[] }
  | { k: 'cellnew'; cell: CellId; init: ValueId }
  | { k: 'cellget'; cell: CellId; out: ValueId }
  | { k: 'cellset'; cell: CellId; value: ValueId }
  | {
      k: 'call';
      target: ValueId;
      fnAbi: PlainAbiFunction;
      args: readonly ValueId[];
      outs: readonly ValueId[];
      mode: 'strict' | 'try';
      // call frame + state semantics (issue #1):
      //   'static'   — STATICCALL: view/pure reads, no state change possible (s.read/s.tryRead).
      //   'call'     — CALL: a non-static frame for non-view targets (Uniswap quoters, calls that
      //                don't usefully persist state); the write is NOT rolled back within the
      //                script (s.call/s.tryCall).
      //   'simulate' — CALL via a self-call + revert macro: a true write is dry-run and its return
      //                value read back, with the write's state rolled back and isolated from later
      //                reads in the same script (s.simulate/s.trySimulate).
      // OPTIONAL/defaulting to 'static' so v1 serialized IR (no `kind`) deserializes unchanged.
      kind?: 'static' | 'call' | 'simulate';
      successOut?: ValueId;
      gas?: ValueId;
      // revert-data-as-result (issue #35, `kind: 'call'` only): the output types carried by the
      // target's REVERT payload (the QuoterV1 pattern). When present it REPLACES `fnAbi.outputs`
      // as the decode schema — `outs` are typed by and decoded from the revert data via the
      // same sequence (staticMinSize guard, 2^64 bounds) as normal outputs — and the
      // success/failure branches swap: a REVERT is the value path, a normal RETURN is the
      // failure (strict → `EvsDecodeError(site)`; try → success=0 + zeroed outs). OPTIONAL so
      // v1 serialized IR without it round-trips unchanged (the `kind` precedent).
      revertReturns?: readonly EvsType[];
    }
  | { k: 'fncall'; fn: FnId; args: readonly ValueId[]; outs: readonly ValueId[] }
  | { k: 'if'; cond: ValueId; then: readonly Stmt[]; else: readonly Stmt[] }
  | { k: 'while'; header: readonly Stmt[]; cond: ValueId; body: readonly Stmt[] }
  | { k: 'break' }
  | { k: 'continue' }
);

// ---------------------------------------------------------------------------
// call helpers
// ---------------------------------------------------------------------------

/**
 * The decode schema of a `call` statement's `outs`: its `revertReturns` (issue #35 — unnamed
 * params built from the declared types, decoded from the REVERT payload) when present, else the
 * ABI `outputs`. Every consumer of a call's outputs (validate, interp, codegen) reads the schema
 * through this one helper so the two sources can never disagree.
 */
export function callOutputs(s: Extract<Stmt, { k: 'call' }>): readonly PlainAbiParam[] {
  if (s.revertReturns === undefined) return s.fnAbi.outputs;
  return s.revertReturns.map((ty) => typeToAbiParam('', ty));
}

const BIN_OPS: ReadonlySet<string> = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'pow',
  'lt',
  'gt',
  'lte',
  'gte',
  'eq',
  'neq',
  'and',
  'or',
  'bitand',
  'bitor',
  'bitxor',
  'shl',
  'shr',
] satisfies BinOp[]);
const UN_OPS: ReadonlySet<string> = new Set(['not', 'bitnot', 'iszero'] satisfies UnOp[]);
const MOD_ARITH_OPS: ReadonlySet<string> = new Set(['addmod', 'mulmod'] satisfies ModArithOp[]);
const ENV_OPS: ReadonlySet<string> = new Set([
  'address',
  'caller',
  'timestamp',
  'blocknumber',
  'chainid',
] satisfies EnvOp[]);

export function isBinOp(s: string): s is BinOp {
  return BIN_OPS.has(s);
}
export function isUnOp(s: string): s is UnOp {
  return UN_OPS.has(s);
}
export function isModArithOp(s: string): s is ModArithOp {
  return MOD_ARITH_OPS.has(s);
}
/** An {@link EnvOp} name (shared with the builder's `s.env` check). */
export function isEnvOp(s: string): s is EnvOp {
  return ENV_OPS.has(s);
}
