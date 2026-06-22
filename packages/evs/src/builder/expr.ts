/**
 * M5 `builder/expr.ts` — the module-private recording engine.
 *
 * Contract: docs/design/module-interfaces.md §M5 (implementation invariants 1–7, binding) +
 * architecture.md §3 (value semantics, scope rule, staging traps, constant folding) +
 * api.md §3–§9. This file has no frozen exports of its own — the public surface lives in
 * `builder/script.ts`; everything here is internal to the builder module.
 *
 * Key mechanisms:
 * - Handle internals live in module-private WeakMaps keyed by the handle object
 *   (`{ owner: Recorder; id }`) — unforgeable; lookup miss / owner mismatch →
 *   `EvsScopeError(FOREIGN_HANDLE)` naming both scripts.
 * - Staging traps (`valueOf`/`toString`/`toJSON`/`Symbol.toPrimitive` throw; node inspect is
 *   non-throwing) are installed on every `Expr` handle via core's `installStagingTraps`.
 * - Scope stack: main → (if-then | if-else | while-header → while-body | fn-body). A value is
 *   usable iff its defining scope is on the current stack; the while body is a child of the
 *   header scope; `s.fn` bodies push an isolated stack (params only — no outer capture).
 * - All-literal pure ops (`bin`/`un`/`convert`/`select` with a literal condition) fold at
 *   recording; folds that would certainly Panic throw `EvsTypeError(CERTAIN_PANIC)` with the
 *   documented escape hatch (route one operand through a cell).
 */
/* oxlint-disable unicorn/no-thenable --
 * the frozen IR schema (module-interfaces.md §M2) names the if-statement branch field `then`. */

import type { AbiFunction } from 'abitype';

import { encodeLiteralData, encodeLiteralWord, toPlainAbiFunction } from '../abi/artifact.js';
import { layoutOf } from '../abi/layout.js';
import { EvsInternalError, EvsScopeError, EvsTypeError, type SourceLoc } from '../core/errors.js';
import { captureLoc } from '../core/loc.js';
import {
  abiParamToType,
  bitsOf,
  elemTypeOf,
  installStagingTraps,
  isDynamicType,
  isEvsValueType,
  isNumeric,
  isSigned,
  isTupleType,
  isWordType,
  typesEqual,
  type ArrayType,
  type DynType,
  type EvsType,
  type Expr,
  type Hex,
  type NamedType,
  type StringType,
  type TupleType,
  type WordType,
} from '../core/types.js';
import type {
  BinOp,
  CellId,
  CellInfo,
  EnvOp,
  FnId,
  FnIr,
  ScriptIr,
  Stmt,
  ValueId,
  ValueInfo,
} from '../ir/nodes.js';

// ---------------------------------------------------------------------------
// module-private handle internals (M5 invariant 1)
// ---------------------------------------------------------------------------

interface ExprInternals {
  readonly owner: Recorder;
  readonly id: ValueId;
}
interface CellInternals {
  readonly owner: Recorder;
  readonly id: CellId;
}
interface ArrInternals {
  readonly owner: Recorder;
  readonly id: ValueId;
  readonly elem: WordType;
}
interface TupleInternals {
  readonly owner: Recorder;
  readonly id: ValueId;
  readonly tt: TupleType; // the static descriptor (carries the component types)
}
interface FieldInternals {
  readonly owner: Recorder;
  readonly tuple: ValueId;
  readonly index: number;
  readonly type: EvsType; // the member type (abiParamToType of the component)
}

const EXPR_INTERNALS = new WeakMap<object, ExprInternals>();
const CELL_INTERNALS = new WeakMap<object, CellInternals>();
const ARR_INTERNALS = new WeakMap<object, ArrInternals>();
const TUPLE_INTERNALS = new WeakMap<object, TupleInternals>();
const FIELD_INTERNALS = new WeakMap<object, FieldInternals>();

/** Runtime brand carried by `s.return(...)` tokens (the public `returnBrand` is type-only). */
export const RETURN_BRAND: unique symbol = Symbol('evs.scriptReturn');

// ---------------------------------------------------------------------------
// scopes
// ---------------------------------------------------------------------------

type ScopeKind = 'main' | 'if-then' | 'if-else' | 'while-header' | 'while-body' | 'fn-body';

interface Scope {
  readonly kind: ScopeKind;
  readonly stmts: Stmt[];
  /** per-scope `(kind:type:hex) → ValueId` const-dedup cache (architecture §4) */
  readonly consts: Map<string, ValueId>;
}

function newScope(kind: ScopeKind): Scope {
  return { kind, stmts: [], consts: new Map() };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_]\w*$/;
const ENV_OPS: ReadonlySet<string> = new Set([
  'address',
  'caller',
  'timestamp',
  'blocknumber',
  'chainid',
] satisfies EnvOp[]);
const CMP_OPS: ReadonlySet<BinOp> = new Set(['lt', 'gt', 'lte', 'gte', 'eq', 'neq']);
const NUMERIC_OPS: ReadonlySet<BinOp> = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'lt',
  'gt',
  'lte',
  'gte',
]);
const BITS_OPS: ReadonlySet<BinOp> = new Set(['bitand', 'bitor', 'bitxor', 'shl', 'shr']);

function fmtLoc(loc: SourceLoc | null): string {
  return loc === null ? '<unknown>' : `${loc.file}:${loc.line}:${loc.column}`;
}

function shortLoc(loc: SourceLoc | null): string {
  if (loc === null) return '<unknown>';
  const base = loc.file.split('/').pop() ?? loc.file;
  return `${base}:${loc.line}:${loc.column}`;
}

/**
 * The single funnel for the recording engine's dynamic casts: every call site has just
 * runtime-validated the value's shape (the typed surface lives in `builder/script.ts`).
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a cast helper's T is its point
function unsafeCast<T>(v: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see doc comment above
  return v as T;
}

function isRecordObj(it: unknown): it is Record<string, unknown> {
  return typeof it === 'object' && it !== null;
}

function isEnvOp(s: string): s is EnvOp {
  return ENV_OPS.has(s);
}

/** bitwise/shift operand domain (matches ir/validate's `isBitsOperand`): uintN, intN, bytesN. */
function isBitsOperand(s: EvsType): s is WordType {
  return isWordType(s) && s !== 'address' && s !== 'bool';
}

function isArrayType(s: EvsType): s is ArrayType {
  return typeof s === 'string' && s.endsWith('[]');
}

/** logical-value range of a word type (intN signed; bytesN as its 8N-bit content). */
function rangeOf(type: WordType): readonly [bigint, bigint] {
  if (type === 'bool') return [0n, 1n];
  const bits = BigInt(bitsOf(type));
  if (isSigned(type)) return [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
  return [0n, (1n << bits) - 1n];
}

/** canonical 32-byte slot image of a logical value (architecture §5). */
function canonicalHex(type: WordType, logical: bigint): Hex {
  const MASK_256 = (1n << 256n) - 1n;
  let x: bigint;
  if (isSigned(type)) {
    x = logical & MASK_256; // sign-extended two's complement
  } else if (type !== 'bool' && type !== 'address' && type.startsWith('bytes')) {
    x = logical << (256n - BigInt(bitsOf(type))); // bytesN: left-aligned
  } else {
    x = logical;
  }
  return `0x${x.toString(16).padStart(64, '0')}`;
}

/** logical value of a canonical 32-byte word. */
function logicalFromCanonical(type: WordType, hex: Hex): bigint {
  const x = BigInt(hex);
  if (isSigned(type)) return x >= 1n << 255n ? x - (1n << 256n) : x;
  if (type !== 'bool' && type !== 'address' && type.startsWith('bytes')) {
    return x >> (256n - BigInt(bitsOf(type)));
  }
  return x;
}

function toUnsignedN(type: WordType, v: bigint): bigint {
  const mask = (1n << BigInt(bitsOf(type))) - 1n;
  return v & mask;
}

function fromUnsignedN(type: WordType, u: bigint): bigint {
  if (!isSigned(type)) return u;
  const bits = BigInt(bitsOf(type));
  return u >> (bits - 1n) === 1n ? u - (1n << bits) : u;
}

/**
 * Validates a type string for the builder surface; valid-Solidity-but-deferred shapes get
 * `UNSUPPORTED_V0`, garbage gets `TYPE_MISMATCH` (classification mirrors `abi/layout.ts`).
 */
export function assertV0Type(
  type: unknown,
  what: string,
  loc: SourceLoc | null,
): asserts type is StringType {
  if (typeof type !== 'string') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: type must be a type string (use the \`t\` namespace), got ${describeHost(type)}`,
      { loc },
    );
  }
  try {
    layoutOf(type);
  } catch (e) {
    if (e instanceof EvsTypeError) {
      throw new EvsTypeError(e.code, `${what}: ${e.message.replace(/^layoutOf: /, '')}`, { loc });
    }
    throw e;
  }
}

function describeHost(v: unknown): string {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'function') return 'a function';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object' && v !== null) return 'an object';
  return String(v);
}

/** A tuple member's human-facing name (its struct field name, or `[i]` for a positional member). */
function memberName(comp: NamedType, index: number): string {
  return comp.name === '' ? `[${index}]` : comp.name;
}

/** Human-readable rendering of a value type for error messages (a tuple → its JSON descriptor). */
function stringifyEvsType(t: EvsType): string {
  return typeof t === 'string' ? t : JSON.stringify(t);
}

/** A short debug tag for a tuple value's `debugName` (field names, or the positional arity). */
function tupleDebugTag(t: TupleType): string {
  const named = t.components.filter((c) => c.name !== '');
  return named.length === t.components.length
    ? named.map((c) => c.name).join(', ')
    : `${t.components.length} members`;
}

/** A recording-time literal member index for `Tuple.at(i)` (the flat layout has no runtime member
 *  indexing — `i` must be a host number/bigint in `[0, n)`). */
function asLiteralIndex(i: unknown, n: number, what: string, loc: SourceLoc | null): number {
  let idx: number;
  if (typeof i === 'number' && Number.isSafeInteger(i)) {
    idx = i;
  } else if (typeof i === 'bigint' && i >= 0n && i < BigInt(n)) {
    idx = Number(i);
  } else {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: the member index must be a literal number/bigint in [0, ${n}), got ${describeHost(i)}`,
      { loc },
    );
  }
  if (idx < 0 || idx >= n) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: member index ${idx} is out of range for a ${n}-member tuple`,
      { loc },
    );
  }
  return idx;
}

/** Deep-freezes plain data; accessor properties (lazy SourceLocs) are frozen but not resolved. */
export function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  const descs = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descs)) {
    const d = descs[key];
    if (d === undefined || d.get !== undefined) continue; // keep lazy locs lazy
    deepFreeze(d.value);
  }
}

// ---------------------------------------------------------------------------
// classified operands + folding
// ---------------------------------------------------------------------------

type Operand = { kind: 'expr'; id: ValueId; type: EvsType } | { kind: 'raw'; value: unknown };

type Fold = { ok: true; value: bigint } | { ok: false; panic: number; reason: string };

function foldBin(op: BinOp, type: WordType, a: bigint, b: bigint): Fold {
  switch (op) {
    case 'add':
    case 'sub':
    case 'mul': {
      const wt = type;
      const r = op === 'add' ? a + b : op === 'sub' ? a - b : a * b;
      const [min, max] = rangeOf(wt);
      if (r < min || r > max) {
        const verb = op === 'sub' && !isSigned(wt) ? 'underflows' : 'overflows';
        const sym = op === 'add' ? '+' : op === 'sub' ? '−' : '×';
        return { ok: false, panic: 0x11, reason: `${a} ${sym} ${b} ${verb} ${type}` };
      }
      return { ok: true, value: r };
    }
    case 'div': {
      if (b === 0n) return { ok: false, panic: 0x12, reason: `${a} / 0 divides by zero` };
      const r = a / b; // bigint division truncates toward zero, like EVM SDIV
      const [min, max] = rangeOf(type);
      if (r < min || r > max) {
        return { ok: false, panic: 0x11, reason: `${a} / ${b} overflows ${type}` };
      }
      return { ok: true, value: r };
    }
    case 'mod': {
      if (b === 0n) return { ok: false, panic: 0x12, reason: `${a} % 0 takes modulo zero` };
      return { ok: true, value: a % b }; // sign of the dividend, like EVM SMOD
    }
    case 'lt':
      return { ok: true, value: a < b ? 1n : 0n };
    case 'gt':
      return { ok: true, value: a > b ? 1n : 0n };
    case 'lte':
      return { ok: true, value: a <= b ? 1n : 0n };
    case 'gte':
      return { ok: true, value: a >= b ? 1n : 0n };
    case 'eq':
      return { ok: true, value: a === b ? 1n : 0n };
    case 'neq':
      return { ok: true, value: a === b ? 0n : 1n };
    case 'and':
      return { ok: true, value: a & b };
    case 'or':
      return { ok: true, value: a | b };
    case 'bitand':
    case 'bitor':
    case 'bitxor': {
      const wt = type;
      const ua = toUnsignedN(wt, a);
      const ub = toUnsignedN(wt, b);
      const r = op === 'bitand' ? ua & ub : op === 'bitor' ? ua | ub : ua ^ ub;
      return { ok: true, value: fromUnsignedN(wt, r) };
    }
    case 'shl': {
      const wt = type;
      const sh = b > 256n ? 256n : b;
      const mask = (1n << BigInt(bitsOf(wt))) - 1n;
      return { ok: true, value: fromUnsignedN(wt, (toUnsignedN(wt, a) << sh) & mask) };
    }
    case 'shr': {
      const wt = type;
      const sh = b > 256n ? 256n : b;
      // SAR for intN (arithmetic — bigint >> floors), logical SHR for uintN/bytesN
      return { ok: true, value: isSigned(wt) ? a >> sh : toUnsignedN(wt, a) >> sh };
    }
    default: {
      throw new EvsInternalError('INTERNAL', `foldBin: unknown op '${String(op)}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// the Expr handle (staging traps installed per instance — M5 invariant 2)
// ---------------------------------------------------------------------------

class ExprHandle {
  constructor(owner: Recorder, id: ValueId) {
    EXPR_INTERNALS.set(this, { owner, id });
    installStagingTraps(this, {
      describe: () => owner.describeValue(id),
      recordedAt: () => owner.valueLoc(id),
    });
  }

  get type(): EvsType {
    const i = internalsOf(this);
    return i.owner.typeOfValue(i.id);
  }

  add(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('add', this, rhs, '.add()');
  }
  sub(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('sub', this, rhs, '.sub()');
  }
  mul(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('mul', this, rhs, '.mul()');
  }
  div(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('div', this, rhs, '.div()');
  }
  mod(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('mod', this, rhs, '.mod()');
  }
  lt(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('lt', this, rhs, '.lt()');
  }
  gt(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('gt', this, rhs, '.gt()');
  }
  lte(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('lte', this, rhs, '.lte()');
  }
  gte(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('gte', this, rhs, '.gte()');
  }
  eq(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('eq', this, rhs, '.eq()');
  }
  neq(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('neq', this, rhs, '.neq()');
  }
  and(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('and', this, rhs, '.and()');
  }
  or(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('or', this, rhs, '.or()');
  }
  not(): Expr {
    return internalsOf(this).owner.notOp(this, '.not()');
  }
  bitAnd(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('bitand', this, rhs, '.bitAnd()');
  }
  bitOr(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('bitor', this, rhs, '.bitOr()');
  }
  bitXor(rhs: unknown): Expr {
    return internalsOf(this).owner.bin('bitxor', this, rhs, '.bitXor()');
  }
  bitNot(): Expr {
    return internalsOf(this).owner.bitNotOp(this, '.bitNot()');
  }
  shl(bits: unknown): Expr {
    return internalsOf(this).owner.bin('shl', this, bits, '.shl()');
  }
  shr(bits: unknown): Expr {
    return internalsOf(this).owner.bin('shr', this, bits, '.shr()');
  }
  toUint(target: unknown): Expr {
    return internalsOf(this).owner.convertOp('toUint', this, target, '.toUint()');
  }
  toInt(target: unknown): Expr {
    return internalsOf(this).owner.convertOp('toInt', this, target, '.toInt()');
  }
  asAddress(): Expr {
    return internalsOf(this).owner.convertOp('asAddress', this, undefined, '.asAddress()');
  }
  asUint256(): Expr {
    return internalsOf(this).owner.convertOp('asUint256', this, undefined, '.asUint256()');
  }
  asBytes32(): Expr {
    return internalsOf(this).owner.convertOp('asBytes32', this, undefined, '.asBytes32()');
  }
  length(): Expr {
    return internalsOf(this).owner.lenOp(this, '.length()');
  }
  at(i: unknown): Expr {
    return internalsOf(this).owner.atOp(this, i, '.at()');
  }
}

function internalsOf(h: object): ExprInternals {
  const i = EXPR_INTERNALS.get(h);
  if (i === undefined) {
    throw new EvsInternalError('INTERNAL', 'Expr handle lost its internals');
  }
  return i;
}

function makeExpr(owner: Recorder, id: ValueId): Expr {
  return unsafeCast<Expr>(new ExprHandle(owner, id));
}

// ---------------------------------------------------------------------------
// Cell / MutArray / LoopCtl handles
// ---------------------------------------------------------------------------

export class CellImpl {
  constructor(owner: Recorder, id: CellId) {
    CELL_INTERNALS.set(this, { owner, id });
  }

  get type(): EvsType {
    const i = cellInternalsOf(this);
    return i.owner.typeOfCell(i.id);
  }

  get(): Expr {
    const i = cellInternalsOf(this);
    return i.owner.cellGet(i.id, 'Cell.get()');
  }

  set(value: unknown): void {
    const i = cellInternalsOf(this);
    i.owner.cellSet(i.id, value, 'Cell.set()');
  }
}

function cellInternalsOf(h: object): CellInternals {
  const i = CELL_INTERNALS.get(h);
  if (i === undefined) {
    throw new EvsInternalError('INTERNAL', 'Cell handle lost its internals');
  }
  return i;
}

export class MutArrayImpl {
  readonly elemType: WordType;
  readonly length: Expr;

  constructor(owner: Recorder, arrId: ValueId, elem: WordType, length: Expr) {
    ARR_INTERNALS.set(this, { owner, id: arrId, elem });
    this.elemType = elem;
    this.length = length;
  }

  set(i: unknown, v: unknown): void {
    const a = arrInternalsOf(this);
    a.owner.arrSet(a.id, a.elem, i, v, 'MutArray.set()');
  }

  get(i: unknown): Expr {
    const a = arrInternalsOf(this);
    return a.owner.arrGet(a.id, a.elem, i, 'MutArray.get()');
  }

  expr(): Expr {
    const a = arrInternalsOf(this);
    return a.owner.arrExpr(a.id, 'MutArray.expr()');
  }
}

function arrInternalsOf(h: object): ArrInternals {
  const i = ARR_INTERNALS.get(h);
  if (i === undefined) {
    throw new EvsInternalError('INTERNAL', 'MutArray handle lost its internals');
  }
  return i;
}

// ---------------------------------------------------------------------------
// Tuple / Field handles (composite memrefs — architecture §5; api.md §5)
// ---------------------------------------------------------------------------

/**
 * A tuple/struct memref handle. It is the pointer to the flat `[w0…w_{n-1}]` block (reference
 * semantics — aliasing the handle shares the block). Named struct fields are installed as own
 * accessor properties; positional members go through `.at(i)`; `.expr()` yields the raw memref.
 * Staging traps are installed (like `Expr`) so a stray coercion explodes with a useful message.
 */
class TupleHandle {
  constructor(owner: Recorder, id: ValueId, tt: TupleType) {
    TUPLE_INTERNALS.set(this, { owner, id, tt });
    installStagingTraps(this, {
      describe: () => owner.describeValue(id),
      recordedAt: () => owner.valueLoc(id),
    });
    // expose each NAMED component as an own accessor → a fresh Field handle on read.
    const fieldProps: PropertyDescriptorMap = {};
    tt.components.forEach((comp, index) => {
      if (comp.name === '') return; // positional members are reached via .at(i)
      fieldProps[comp.name] = {
        enumerable: true,
        get: () => owner.makeField(id, index, abiParamToType(comp)),
      };
    });
    Object.defineProperties(this, fieldProps);
  }

  at(i: unknown): FieldHandle {
    const t = tupleInternalsOf(this);
    return t.owner.tupleAt(t.id, t.tt, i, 'Tuple.at()');
  }

  expr(): Expr {
    const t = tupleInternalsOf(this);
    return t.owner.tupleExpr(t.id, 'Tuple.expr()');
  }
}

function tupleInternalsOf(h: object): TupleInternals {
  const i = TUPLE_INTERNALS.get(h);
  if (i === undefined) {
    throw new EvsInternalError('INTERNAL', 'Tuple handle lost its internals');
  }
  return i;
}

function makeTuple(owner: Recorder, id: ValueId, tt: TupleType): object {
  return new TupleHandle(owner, id, tt);
}

/**
 * A field handle over one tuple member (Cell-like): `.get()` reads the member (`field` stmt — a
 * composite member follows the pointer to a fresh `Tuple` handle), `.set(v)` writes it (`tupleset`
 * stmt). Module-private like `Cell`.
 */
class FieldHandle {
  readonly type: EvsType;

  constructor(owner: Recorder, tuple: ValueId, index: number, type: EvsType) {
    FIELD_INTERNALS.set(this, { owner, tuple, index, type });
    this.type = type;
  }

  get(): Expr | object {
    const f = fieldInternalsOf(this);
    return f.owner.fieldGet(f.tuple, f.index, f.type, 'Field.get()');
  }

  set(value: unknown): void {
    const f = fieldInternalsOf(this);
    f.owner.fieldSet(f.tuple, f.index, f.type, value, 'Field.set()');
  }
}

function fieldInternalsOf(h: object): FieldInternals {
  const i = FIELD_INTERNALS.get(h);
  if (i === undefined) {
    throw new EvsInternalError('INTERNAL', 'Field handle lost its internals');
  }
  return i;
}

export class LoopCtlImpl {
  private readonly owner: Recorder;
  private readonly bodyScope: Scope;
  private readonly loopLoc: SourceLoc | null;

  constructor(owner: Recorder, bodyScope: Scope, loopLoc: SourceLoc | null) {
    this.owner = owner;
    this.bodyScope = bodyScope;
    this.loopLoc = loopLoc;
  }

  /** Recording-time scoping check: valid only while the owning loop's body scope is open. */
  guard(what: string, loc: SourceLoc | null): void {
    this.owner.assertOpen(what, loc);
    const innermost = this.owner.innermostLoopBody();
    if (innermost === this.bodyScope) return;
    if (innermost !== null && this.owner.isScopeOnStack(this.bodyScope)) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `${what}: this LoopCtl belongs to an outer loop — break/continue the innermost loop with its own LoopCtl (an unlabeled break targets the innermost loop)`,
        { loc, relatedLocs: [{ label: 'owning loop recorded at', loc: this.loopLoc }] },
      );
    }
    throw new EvsScopeError(
      'SCOPE_VIOLATION',
      `${what}: LoopCtl used outside its owning loop's body — it is only valid while that loop body is recording`,
      { loc, relatedLocs: [{ label: 'owning loop recorded at', loc: this.loopLoc }] },
    );
  }

  emit(kind: 'break' | 'continue', loc: SourceLoc | null): void {
    this.owner.appendStmt({ k: kind }, loc);
  }

  break(): void {
    const loc = captureLoc();
    this.guard('loop.break()', loc);
    this.emit('break', loc);
  }

  continue(): void {
    const loc = captureLoc();
    this.guard('loop.continue()', loc);
    this.emit('continue', loc);
  }
}

// ---------------------------------------------------------------------------
// the Recorder
// ---------------------------------------------------------------------------

interface SubcallShape {
  readonly success: Expr | null;
  readonly value: unknown; // void | Expr | readonly Expr[]
}

export class Recorder {
  readonly name: string;
  readonly scriptLoc: SourceLoc | null;

  private readonly argsList: readonly { name: string; type: EvsType }[];
  private readonly values: ValueInfo[] = [];
  private readonly valueScopes: Scope[] = [];
  /** logical values of word-const ValueIds (the folding domain) */
  private readonly litValues = new Map<ValueId, bigint>();
  private readonly cellInfos: CellInfo[] = [];
  private readonly cellScopes: Scope[] = [];
  private readonly fnIrs: (FnIr | null)[] = [];
  private readonly openFns = new Set<FnId>();
  private readonly fnCtx: { name: string; loc: SourceLoc | null }[] = [];
  private readonly mainScope: Scope;
  private stack: Scope[];
  private readonly savedStacks: Scope[][] = [];
  private nextSite = 0;
  private sealed = false;
  private returnsList: { name: string; type: EvsType; value: ValueId }[] | null = null;
  private returnToken: object | null = null;
  /** positional arg handles, spread into the body callback after `s` (a tuple arg → a Tuple). */
  private readonly argHandleList: readonly (Expr | object)[];

  constructor(
    name: string,
    args: readonly { name: string; type: EvsType }[],
    scriptLoc: SourceLoc | null,
  ) {
    this.name = name;
    this.scriptLoc = scriptLoc;
    this.argsList = args;
    this.mainScope = newScope('main');
    this.stack = [this.mainScope];
    // args bind positionally to ValueIds 0…n-1 (the only binding validate.ts admits); a tuple arg
    // yields a Tuple handle over its arg ValueId, every scalar arg an Expr.
    const handles: (Expr | object)[] = args.map((a) => {
      const id = this.newValue(a.type, scriptLoc, `args.${a.name}`);
      return isTupleType(a.type) ? makeTuple(this, id, a.type) : makeExpr(this, id);
    });
    this.argHandleList = Object.freeze(handles);
  }

  // -- handle support ---------------------------------------------------------------------

  argHandles(): readonly (Expr | object)[] {
    return this.argHandleList;
  }

  typeOfValue(id: ValueId): EvsType {
    const info = this.values[id];
    if (info === undefined) {
      throw new EvsInternalError('INTERNAL', `unknown ValueId ${id} in script "${this.name}"`);
    }
    return info.type;
  }

  typeOfCell(id: CellId): EvsType {
    const info = this.cellInfos[id];
    if (info === undefined) {
      throw new EvsInternalError('INTERNAL', `unknown CellId ${id} in script "${this.name}"`);
    }
    return info.type;
  }

  valueLoc(id: ValueId): SourceLoc | null {
    return this.values[id]?.loc ?? null;
  }

  /** `Expr<type> #id ← debugName at file:line:col` — the non-throwing inspect string. */
  describeValue(id: ValueId): string {
    const info = this.values[id];
    if (info === undefined) return `Expr<?> #${id}`;
    const name = info.debugName !== undefined ? ` ← ${info.debugName}` : '';
    return `Expr<${stringifyEvsType(info.type)}> #${id}${name} at ${shortLoc(info.loc)}`;
  }

  assertOpen(what: string, loc: SourceLoc | null): void {
    if (!this.sealed) return;
    throw new EvsScopeError(
      'RECORDING_CLOSED',
      `${what}: script "${this.name}" is sealed — s.return(...) already ran; the builder and its handles cannot record anything afterwards`,
      { loc, relatedLocs: [{ label: 'script defined at', loc: this.scriptLoc }] },
    );
  }

  innermostLoopBody(): Scope | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (s !== undefined && s.kind === 'while-body') return s;
    }
    return null;
  }

  isScopeOnStack(scope: Scope): boolean {
    return this.stack.includes(scope);
  }

  appendStmt(body: Record<string, unknown>, loc: SourceLoc | null): void {
    // statement bodies are built per the frozen Stmt union (re-checked by ir/validate)
    this.top().stmts.push(unsafeCast<Stmt>({ ...body, loc, site: this.nextSite++ }));
  }

  // -- internals --------------------------------------------------------------------------

  private top(): Scope {
    const s = this.stack[this.stack.length - 1];
    if (s === undefined) {
      throw new EvsInternalError('INTERNAL', `scope stack underflow in script "${this.name}"`);
    }
    return s;
  }

  private newValue(type: EvsType, loc: SourceLoc | null, debugName?: string): ValueId {
    const id = this.values.length;
    this.values.push(debugName === undefined ? { type, loc } : { type, loc, debugName });
    this.valueScopes.push(this.top());
    return id;
  }

  private pushScope(kind: ScopeKind): Scope {
    const s = newScope(kind);
    this.stack.push(s);
    return s;
  }

  private popScope(): void {
    this.stack.pop();
  }

  /** Classifies an operand: a usable Expr of this recorder, or a raw host literal. */
  private classify(v: unknown, what: string, loc: SourceLoc | null): Operand {
    if (typeof v === 'object' && v !== null) {
      const ei = EXPR_INTERNALS.get(v);
      if (ei !== undefined) {
        if (ei.owner !== this) {
          throw new EvsScopeError(
            'FOREIGN_HANDLE',
            `${what}: this Expr belongs to script "${ei.owner.name}" (defined at ${fmtLoc(ei.owner.scriptLoc)}) and cannot be used in script "${this.name}" — handles never cross scripts`,
            {
              loc,
              relatedLocs: [
                { label: `script "${ei.owner.name}" defined at`, loc: ei.owner.scriptLoc },
                { label: 'handle recorded at', loc: ei.owner.valueLoc(ei.id) },
              ],
            },
          );
        }
        this.checkVisible(ei.id, what, loc);
        return { kind: 'expr', id: ei.id, type: this.typeOfValue(ei.id) };
      }
      if (CELL_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a Cell is not an Expr — read a snapshot with .get()`,
          { loc },
        );
      }
      if (ARR_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a MutArray is not an Expr — use .get(i) for an element or .expr() for the array memref`,
          { loc },
        );
      }
      if (TUPLE_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a Tuple is not an Expr — use .expr() for its memref, or pass it where a tuple is expected`,
          { loc },
        );
      }
      if (FIELD_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a Field is not an Expr — read a snapshot with .get()`,
          { loc },
        );
      }
      if (!Array.isArray(v)) {
        const tag = (v as { type?: unknown }).type;
        if (typeof tag === 'string' && isWordType(tag)) {
          throw new EvsScopeError(
            'FOREIGN_HANDLE',
            `${what}: value looks like an Expr handle but was not created by this copy of evs (forged object, or a duplicate @maxencerb/evs install)`,
            { loc },
          );
        }
      }
    }
    return { kind: 'raw', value: v };
  }

  /** Scope rule (M5 invariant 3): a value is usable iff its defining scope is on the stack. */
  private checkVisible(id: ValueId, what: string, loc: SourceLoc | null): void {
    const scope = this.valueScopes[id];
    if (scope === undefined) {
      throw new EvsInternalError('INTERNAL', `ValueId ${id} has no scope in "${this.name}"`);
    }
    if (this.stack.includes(scope)) return;
    const recordedAt = this.valueLoc(id);
    const fn = this.fnCtx[this.fnCtx.length - 1];
    if (fn !== undefined && this.savedStacks.some((st) => st.includes(scope))) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `${what}: s.fn("${fn.name}") bodies cannot capture values from the enclosing script — pass them in as fn params instead`,
        {
          loc,
          relatedLocs: [
            { label: 'captured value recorded at', loc: recordedAt },
            { label: `fn "${fn.name}" defined at`, loc: fn.loc },
          ],
        },
      );
    }
    throw new EvsScopeError(
      'SCOPE_VIOLATION',
      `${what}: this value was recorded in a ${scope.kind} block that has finished recording — values escape blocks only through cells (s.let)`,
      { loc, relatedLocs: [{ label: 'value recorded at', loc: recordedAt }] },
    );
  }

  private checkCellVisible(id: CellId, what: string, loc: SourceLoc | null): void {
    const scope = this.cellScopes[id];
    if (scope === undefined) {
      throw new EvsInternalError('INTERNAL', `CellId ${id} has no scope in "${this.name}"`);
    }
    if (this.stack.includes(scope)) return;
    const info = this.cellInfos[id];
    const fn = this.fnCtx[this.fnCtx.length - 1];
    if (fn !== undefined && this.savedStacks.some((st) => st.includes(scope))) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `${what}: s.fn("${fn.name}") bodies cannot capture cells from the enclosing script — pass values in as fn params instead`,
        {
          loc,
          relatedLocs: [
            { label: 'captured cell recorded at', loc: info?.loc ?? null },
            { label: `fn "${fn.name}" defined at`, loc: fn.loc },
          ],
        },
      );
    }
    throw new EvsScopeError(
      'SCOPE_VIOLATION',
      `${what}: this cell was declared in a ${scope.kind} block that has finished recording — declare the cell outside the block instead`,
      { loc, relatedLocs: [{ label: 'cell declared at', loc: info?.loc ?? null }] },
    );
  }

  private typeMismatch(
    what: string,
    expected: EvsType,
    got: EvsType,
    loc: SourceLoc | null,
  ): never {
    let suggest = '';
    if (isNumeric(expected) && isNumeric(got)) {
      suggest = expected.startsWith('uint')
        ? ` — convert explicitly with .toUint('${expected}')`
        : ` — convert explicitly with .toInt('${expected}')`;
    }
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: expected '${stringifyEvsType(expected)}', got Expr<'${stringifyEvsType(got)}'>${suggest}`,
      { loc },
    );
  }

  /** Validates a word literal and returns its canonical hex + logical value (no stmt yet). */
  private wordLiteral(type: WordType, value: unknown): { hex: Hex; logical: bigint } {
    const hex = encodeLiteralWord(type, value);
    return { hex, logical: logicalFromCanonical(type, hex) };
  }

  /** Interns a canonical word const (dedup per (type, hex) across the open scope stack). */
  private wordConst(type: WordType, logical: bigint, loc: SourceLoc | null, hex?: Hex): ValueId {
    const h = hex ?? canonicalHex(type, logical);
    const key = `w:${type}:${h}`;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const found = this.stack[i]?.consts.get(key);
      if (found !== undefined) return found;
    }
    const id = this.newValue(type, loc);
    this.appendStmt({ k: 'const', out: id, data: { kind: 'word', hex: h }, type }, loc);
    this.litValues.set(id, logical);
    this.top().consts.set(key, id);
    return id;
  }

  /** Interns a dynamic literal as a pre-encoded memref data const. */
  private dataConst(type: DynType | ArrayType, value: unknown, loc: SourceLoc | null): ValueId {
    const hex = encodeLiteralData(type, value);
    const key = `d:${type}:${hex}`;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const found = this.stack[i]?.consts.get(key);
      if (found !== undefined) return found;
    }
    const id = this.newValue(type, loc);
    this.appendStmt({ k: 'const', out: id, data: { kind: 'data', hex }, type }, loc);
    this.top().consts.set(key, id);
    return id;
  }

  /** Coerces an `IntoExpr` to a ValueId of exactly `type` (literal rules of api.md §3). */
  private coerceToId(v: unknown, type: EvsType, what: string, loc: SourceLoc | null): ValueId {
    // a tuple target: a Tuple handle (reuse its ValueId — reference) or a literal struct object
    // (build a fresh tuplenew). Routed before classify(), which rejects Tuple/Field handles.
    if (isTupleType(type)) return this.coerceTupleToId(v, type, what, loc);
    const c = this.classify(v, what, loc);
    if (c.kind === 'expr') {
      if (!typesEqual(c.type, type)) this.typeMismatch(what, type, c.type, loc);
      return c.id;
    }
    if (isWordType(type)) {
      const { hex, logical } = this.wordLiteral(type, c.value);
      return this.wordConst(type, logical, loc, hex);
    }
    return this.dataConst(type, c.value, loc);
  }

  /** Tuple branch of {@link coerceToId} (spec §5): reuse a Tuple handle's ValueId, or build a
   *  `tuplenew` from a literal struct/positional object. */
  private coerceTupleToId(
    v: unknown,
    type: TupleType,
    what: string,
    loc: SourceLoc | null,
  ): ValueId {
    if (type.type !== 'tuple') {
      throw new EvsTypeError(
        'UNSUPPORTED_V0',
        `${what}: tuple-array type ${JSON.stringify(type.type)} is not supported in evs v0 (arrays of tuples are deferred)`,
        { loc },
      );
    }
    if (typeof v === 'object' && v !== null) {
      const ti = TUPLE_INTERNALS.get(v);
      if (ti !== undefined) {
        if (ti.owner !== this) {
          throw new EvsScopeError(
            'FOREIGN_HANDLE',
            `${what}: this Tuple belongs to script "${ti.owner.name}" (defined at ${fmtLoc(ti.owner.scriptLoc)}) and cannot be used in script "${this.name}" — handles never cross scripts`,
            {
              loc,
              relatedLocs: [
                { label: `script "${ti.owner.name}" defined at`, loc: ti.owner.scriptLoc },
                { label: 'handle recorded at', loc: ti.owner.valueLoc(ti.id) },
              ],
            },
          );
        }
        this.checkVisible(ti.id, what, loc);
        if (!typesEqual(ti.tt, type)) this.typeMismatch(what, type, ti.tt, loc);
        return ti.id; // reference: aliases the SAME flat block
      }
      // an Expr memref of the SAME tuple type (e.g. another tuple's `.expr()`) is also accepted.
      const ei = EXPR_INTERNALS.get(v);
      if (ei !== undefined) {
        this.classify(v, what, loc); // ownership + visibility check (rethrows FOREIGN_HANDLE)
        const et = this.typeOfValue(ei.id);
        if (!typesEqual(et, type)) this.typeMismatch(what, type, et, loc);
        return ei.id;
      }
      if (FIELD_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a Field is not a tuple — read it with .get()`,
          { loc },
        );
      }
    }
    // a plain object/array literal → build the tuple from its members.
    return this.buildTupleNew(type, v, what, loc);
  }

  // -- tuples / structs ---------------------------------------------------------------------

  /** `s.tuple(type, init?)`: allocate a flat block, MSTORE provided members (omitted/literal-0 →
   *  no init), return a Tuple handle. */
  tuple(type: unknown, init: unknown): object {
    const loc = captureLoc();
    this.assertOpen('s.tuple()', loc);
    if (!isTupleType(type) || !isEvsValueType(type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.tuple(): type must be a t.struct/t.tuple descriptor (or readonly AbiParameter[]), got ${describeHost(type)}`,
        { loc },
      );
    }
    if (type.type !== 'tuple') {
      throw new EvsTypeError(
        'UNSUPPORTED_V0',
        `s.tuple(): tuple-array type ${JSON.stringify(type.type)} is not supported in evs v0 (arrays of tuples are deferred)`,
        { loc },
      );
    }
    const id = this.buildTupleNew(type, init, 's.tuple()', loc);
    return makeTuple(this, id, type);
  }

  /** Lowers a tuple literal/init to a `tuplenew` (alloc + zero-fill + MSTORE provided members),
   *  returning the new tuple ValueId. Members are name-keyed (struct) or positional (t.tuple);
   *  an omitted or literal-zero member is left to the zero-fill (no MSTORE). */
  private buildTupleNew(
    type: TupleType,
    init: unknown,
    what: string,
    loc: SourceLoc | null,
  ): ValueId {
    const isPositional = type.components.every((c) => c.name === '');
    let lookup: (comp: NamedType, index: number) => unknown;
    if (init === undefined) {
      lookup = () => undefined;
    } else if (Array.isArray(init)) {
      if (!isPositional) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: this struct expects a name-keyed init record, not a positional array`,
          { loc },
        );
      }
      lookup = (_comp, index) => init[index];
    } else if (typeof init === 'object' && init !== null) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded: init is a non-null object here
      const rec = init as Record<string, unknown>;
      lookup = isPositional ? (_comp, index) => rec[index] : (comp) => rec[comp.name];
    } else {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: init must be a record of members (or a positional array for a t.tuple), got ${describeHost(init)}`,
        { loc },
      );
    }

    const inits: { index: number; value: ValueId }[] = [];
    type.components.forEach((comp, index) => {
      const memberVal = lookup(comp, index);
      if (memberVal === undefined) return; // omitted → left zeroed by the block's zero-fill
      const memberType = abiParamToType(comp);
      const valId = this.coerceToId(
        memberVal,
        memberType,
        `${what} member "${memberName(comp, index)}"`,
        loc,
      );
      // a literal-zero word member is already covered by the zero-fill — skip its MSTORE.
      if (this.litValues.get(valId) === 0n) return;
      inits.push({ index, value: valId });
    });

    const out = this.newValue(type, loc, `s.tuple(${tupleDebugTag(type)})`);
    this.appendStmt({ k: 'tuplenew', inits, out }, loc);
    return out;
  }

  /** Builds a fresh Field handle over member `index` of a tuple ValueId. */
  makeField(tupleId: ValueId, index: number, memberType: EvsType): object {
    return new FieldHandle(this, tupleId, index, memberType);
  }

  /** `Tuple.at(i)`: a positional Field handle. The index must be a recording-time literal (the
   *  flat layout has no runtime member indexing). */
  tupleAt(tupleId: ValueId, tt: TupleType, i: unknown, what: string): FieldHandle {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkVisible(tupleId, what, loc);
    const index = asLiteralIndex(i, tt.components.length, what, loc);
    const comp = tt.components[index];
    if (comp === undefined) {
      throw new EvsInternalError('INTERNAL', `tupleAt: component ${index} missing`);
    }
    return new FieldHandle(this, tupleId, index, abiParamToType(comp));
  }

  /** `Tuple.expr()`: the raw memref Expr (reference semantics — aliases the SAME ValueId). */
  tupleExpr(tupleId: ValueId, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkVisible(tupleId, what, loc);
    return makeExpr(this, tupleId);
  }

  /** `Field.get()`: read a member — `field` stmt. A composite member follows the pointer to a
   *  fresh Tuple handle; a scalar member yields an Expr. */
  fieldGet(tupleId: ValueId, index: number, memberType: EvsType, what: string): Expr | object {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkVisible(tupleId, what, loc);
    const out = this.newValue(memberType, loc);
    this.appendStmt({ k: 'field', tuple: tupleId, index, out }, loc);
    return isTupleType(memberType) ? makeTuple(this, out, memberType) : makeExpr(this, out);
  }

  /** `Field.set(v)`: write a member — `tupleset` stmt (`v` coerced to the member type). */
  fieldSet(
    tupleId: ValueId,
    index: number,
    memberType: EvsType,
    value: unknown,
    what: string,
  ): void {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkVisible(tupleId, what, loc);
    const valId = this.coerceToId(value, memberType, what, loc);
    this.appendStmt({ k: 'tupleset', tuple: tupleId, index, value: valId }, loc);
  }

  private certainPanic(what: string, reason: string, panic: number, loc: SourceLoc | null): never {
    throw new EvsTypeError(
      'CERTAIN_PANIC',
      `${what}: ${reason} — this would always revert with Panic(0x${panic.toString(16)}) at runtime, so recording refuses it. If a guaranteed runtime panic is intended, route one operand through a cell: s.let(t.uint256, x).get()`,
      { loc },
    );
  }

  // -- values & state ---------------------------------------------------------------------

  lit(type: unknown, value: unknown): Expr {
    const loc = captureLoc();
    this.assertOpen('s.lit()', loc);
    assertV0Type(type, 's.lit()', loc);
    if (isWordType(type)) {
      const { hex, logical } = this.wordLiteral(type, value);
      return makeExpr(this, this.wordConst(type, logical, loc, hex));
    }
    return makeExpr(this, this.dataConst(type, value, loc));
  }

  letCell(a: unknown, b: unknown): CellImpl {
    const loc = captureLoc();
    this.assertOpen('s.let()', loc);
    let type: EvsType;
    let init: unknown;
    if (typeof a === 'string') {
      assertV0Type(a, 's.let()', loc);
      if (b === undefined) {
        throw new EvsTypeError('TYPE_MISMATCH', `s.let(type, init): init value is required`, {
          loc,
        });
      }
      type = a;
      init = b;
    } else {
      const c = this.classify(a, 's.let()', loc);
      if (c.kind !== 'expr') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.let(init): init must be an Expr when no type is given — use s.let(type, literal) to type a literal`,
          { loc },
        );
      }
      type = c.type;
      init = a;
    }
    return new CellImpl(this, this.makeCell(type, init, loc));
  }

  private makeCell(type: EvsType, init: unknown, loc: SourceLoc | null): CellId {
    const initId = this.coerceToId(init, type, 's.let() init', loc);
    const cellId = this.cellInfos.length;
    this.cellInfos.push({ type, loc });
    this.cellScopes.push(this.top());
    this.appendStmt({ k: 'cellnew', cell: cellId, init: initId }, loc);
    return cellId;
  }

  cellGet(cellId: CellId, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkCellVisible(cellId, what, loc);
    return makeExpr(this, this.cellGetId(cellId, loc));
  }

  private cellGetId(cellId: CellId, loc: SourceLoc | null): ValueId {
    const out = this.newValue(this.typeOfCell(cellId), loc);
    this.appendStmt({ k: 'cellget', cell: cellId, out }, loc);
    return out;
  }

  cellSet(cellId: CellId, value: unknown, what: string): void {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkCellVisible(cellId, what, loc);
    const valId = this.coerceToId(value, this.typeOfCell(cellId), what, loc);
    this.appendStmt({ k: 'cellset', cell: cellId, value: valId }, loc);
  }

  newArray(elem: unknown, length: unknown): MutArrayImpl {
    const loc = captureLoc();
    this.assertOpen('s.newArray()', loc);
    if (typeof elem !== 'string' || !isWordType(elem)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.newArray(): element type must be a word type (uintN/intN/address/bool/bytesN), got ${describeHost(elem)}`,
        { loc },
      );
    }
    const lenId = this.coerceToId(length, 'uint256', 's.newArray() length', loc);
    const lenLit = this.litValues.get(lenId);
    if (lenLit !== undefined && lenLit >= 1n << 32n) {
      this.certainPanic('s.newArray()', `literal length ${lenLit} is ≥ 2^32`, 0x41, loc);
    }
    const arrType: ArrayType = `${elem}[]`;
    const arrId = this.newValue(arrType, loc, `s.newArray(${elem})`);
    this.appendStmt({ k: 'arrnew', elem, length: lenId, out: arrId }, loc);
    const lenOut = this.newValue('uint256', loc, `s.newArray(${elem}).length`);
    this.appendStmt({ k: 'len', a: arrId, out: lenOut }, loc);
    return new MutArrayImpl(this, arrId, elem, makeExpr(this, lenOut));
  }

  arrSet(arrId: ValueId, elem: WordType, i: unknown, v: unknown, what: string): void {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkVisible(arrId, what, loc);
    const iId = this.coerceToId(i, 'uint256', `${what} index`, loc);
    const vId = this.coerceToId(v, elem, `${what} value`, loc);
    this.appendStmt({ k: 'arrset', arr: arrId, i: iId, value: vId }, loc);
  }

  arrGet(arrId: ValueId, elem: WordType, i: unknown, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkVisible(arrId, what, loc);
    const iId = this.coerceToId(i, 'uint256', `${what} index`, loc);
    const out = this.newValue(elem, loc);
    this.appendStmt({ k: 'index', arr: arrId, i: iId, out }, loc);
    return makeExpr(this, out);
  }

  arrExpr(arrId: ValueId, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    this.checkVisible(arrId, what, loc);
    return makeExpr(this, arrId); // aliases the SAME ValueId (reference semantics)
  }

  env(kind: unknown): Expr {
    const loc = captureLoc();
    this.assertOpen('s.env()', loc);
    if (typeof kind !== 'string' || !isEnvOp(kind)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.env(): unknown kind ${describeHost(kind)} (expected 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid')`,
        { loc },
      );
    }
    const op = kind;
    const outType: EvsType = op === 'address' || op === 'caller' ? 'address' : 'uint256';
    const out = this.newValue(outType, loc, `s.env(${op})`);
    this.appendStmt({ k: 'env', op, out }, loc);
    return makeExpr(this, out);
  }

  // -- ops ----------------------------------------------------------------------------------

  bin(op: BinOp, a: unknown, b: unknown, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    const isShift = op === 'shl' || op === 'shr';
    const ca = this.classify(a, `${what} left operand`, loc);
    const cb = this.classify(b, `${what} ${isShift ? 'shift amount' : 'right operand'}`, loc);

    // infer the operation type from the Expr operand(s)
    let ty: EvsType;
    if (isShift) {
      if (ca.kind !== 'expr') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: the shifted operand must be an Expr — type a literal with s.lit(type, value)`,
          { loc },
        );
      }
      ty = ca.type;
    } else if (ca.kind === 'expr' && cb.kind === 'expr') {
      if (!typesEqual(ca.type, cb.type)) {
        let suggest = '';
        if (isNumeric(ca.type) && isNumeric(cb.type)) {
          suggest = ` — make the widths match explicitly with .toUint('…') / .toInt('…')`;
        }
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operand types differ (Expr<'${stringifyEvsType(ca.type)}'> vs Expr<'${stringifyEvsType(cb.type)}'>)${suggest}`,
          { loc },
        );
      }
      ty = ca.type;
    } else if (ca.kind === 'expr') {
      ty = ca.type;
    } else if (cb.kind === 'expr') {
      ty = cb.type;
    } else {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: at least one operand must be an Expr — type a literal with s.lit(type, value)`,
        { loc },
      );
    }

    this.checkBinDomain(op, ty, what, loc);
    const bTy: EvsType = isShift ? 'uint256' : ty;
    const resultTy: EvsType = CMP_OPS.has(op) || op === 'and' || op === 'or' ? 'bool' : ty;

    // resolve operands to (id, logical) pairs without materializing raw literals yet
    const ra = this.resolveOperand(ca, ty, `${what} left operand`, loc);
    const rb = this.resolveOperand(cb, bTy, `${what} right operand`, loc);

    // all-literal fold (M5 invariant 6) — domain checks established ty/resultTy are word types
    if (ra.logical !== null && rb.logical !== null && isWordType(ty) && isWordType(resultTy)) {
      const f = foldBin(op, ty, ra.logical, rb.logical);
      if (!f.ok) this.certainPanic(what, f.reason, f.panic, loc);
      return makeExpr(this, this.wordConst(resultTy, f.value, loc));
    }

    const ia = ra.id ?? this.materializeWord(ty, ra, loc);
    const ib = rb.id ?? this.materializeWord(bTy, rb, loc);
    const out = this.newValue(resultTy, loc);
    this.appendStmt({ k: 'bin', op, a: ia, b: ib, out }, loc);
    return makeExpr(this, out);
  }

  private materializeWord(
    ty: EvsType,
    r: { hex: Hex | null; logical: bigint | null },
    loc: SourceLoc | null,
  ): ValueId {
    if (r.logical === null || !isWordType(ty)) {
      throw new EvsInternalError(
        'INTERNAL',
        `cannot materialize operand of type '${stringifyEvsType(ty)}'`,
      );
    }
    return this.wordConst(ty, r.logical, loc, r.hex ?? undefined);
  }

  private resolveOperand(
    c: Operand,
    ty: EvsType,
    what: string,
    loc: SourceLoc | null,
  ): { id: ValueId | null; logical: bigint | null; hex: Hex | null } {
    if (c.kind === 'expr') {
      if (!typesEqual(c.type, ty)) this.typeMismatch(what, ty, c.type, loc);
      return { id: c.id, logical: this.litValues.get(c.id) ?? null, hex: null };
    }
    if (!isWordType(ty)) {
      // unreachable through bin (domains are word types); defensive
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: '${stringifyEvsType(ty)}' operands must be Exprs`,
        { loc },
      );
    }
    const { hex, logical } = this.wordLiteral(ty, c.value);
    return { id: null, logical, hex };
  }

  private checkBinDomain(op: BinOp, ty: EvsType, what: string, loc: SourceLoc | null): void {
    if (NUMERIC_OPS.has(op)) {
      if (!isNumeric(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operands must be numeric (uintN/intN), got '${stringifyEvsType(ty)}'`,
          { loc },
        );
      }
      return;
    }
    if (op === 'eq' || op === 'neq') {
      if (!isWordType(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: eq/neq compare word types only — memref ('${stringifyEvsType(ty)}') equality is not defined in v0`,
          { loc },
        );
      }
      return;
    }
    if (op === 'and' || op === 'or') {
      if (ty !== 'bool') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operands must be Expr<'bool'>, got '${stringifyEvsType(ty)}'`,
          { loc },
        );
      }
      return;
    }
    if (BITS_OPS.has(op)) {
      if (!isBitsOperand(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operands must be uintN/bytesN (bit-width types), got '${stringifyEvsType(ty)}'`,
          { loc },
        );
      }
      return;
    }
    throw new EvsInternalError('INTERNAL', `unknown bin op '${op}'`);
  }

  notOp(a: unknown, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    const c = this.classify(a, what, loc);
    if (c.kind === 'raw') {
      const { logical } = this.wordLiteral('bool', c.value);
      return makeExpr(this, this.wordConst('bool', 1n - logical, loc));
    }
    if (c.type !== 'bool') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: operand must be Expr<'bool'>, got '${stringifyEvsType(c.type)}'`,
        { loc },
      );
    }
    const lit = this.litValues.get(c.id);
    if (lit !== undefined) return makeExpr(this, this.wordConst('bool', 1n - lit, loc));
    const out = this.newValue('bool', loc);
    this.appendStmt({ k: 'un', op: 'not', a: c.id, out }, loc);
    return makeExpr(this, out);
  }

  bitNotOp(a: unknown, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    const c = this.classify(a, what, loc);
    if (c.kind !== 'expr') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: operand must be an Expr — type a literal with s.lit(type, value)`,
        { loc },
      );
    }
    if (!isBitsOperand(c.type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: operand must be uintN/bytesN (bit-width types), got '${stringifyEvsType(c.type)}'`,
        { loc },
      );
    }
    const ty = c.type;
    const lit = this.litValues.get(c.id);
    if (lit !== undefined) {
      const mask = (1n << BigInt(bitsOf(ty))) - 1n;
      const folded = fromUnsignedN(ty, ~toUnsignedN(ty, lit) & mask);
      return makeExpr(this, this.wordConst(ty, folded, loc));
    }
    const out = this.newValue(ty, loc);
    this.appendStmt({ k: 'un', op: 'bitnot', a: c.id, out }, loc);
    return makeExpr(this, out);
  }

  convertOp(
    kind: 'toUint' | 'toInt' | 'asAddress' | 'asUint256' | 'asBytes32',
    a: unknown,
    target: unknown,
    what: string,
  ): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    const c = this.classify(a, what, loc);
    if (c.kind !== 'expr') {
      throw new EvsTypeError('TYPE_MISMATCH', `${what}: the converted operand must be an Expr`, {
        loc,
      });
    }
    const from = c.type;
    let to: WordType;
    if (kind === 'toUint' || kind === 'toInt') {
      const prefix = kind === 'toUint' ? 'uint' : 'int';
      if (
        typeof target !== 'string' ||
        !target.startsWith(prefix) ||
        !isWordType(target) ||
        !isNumeric(target)
      ) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: target must be a ${prefix}N type, got ${describeHost(target)}`,
          { loc },
        );
      }
      if (!isNumeric(from)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: cannot convert from '${stringifyEvsType(from)}' — the source must be numeric (uintN/intN)`,
          { loc },
        );
      }
      to = target;
    } else if (kind === 'asAddress') {
      if (from !== 'uint256' && from !== 'bytes32') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: only Expr<'uint256'> / Expr<'bytes32'> convert to address, got '${stringifyEvsType(from)}'`,
          { loc },
        );
      }
      to = 'address';
    } else if (kind === 'asUint256') {
      if (from !== 'bytes32') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: only Expr<'bytes32'> reinterprets as uint256, got '${stringifyEvsType(from)}'`,
          { loc },
        );
      }
      to = 'uint256';
    } else {
      if (from !== 'uint256') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: only Expr<'uint256'> reinterprets as bytes32, got '${stringifyEvsType(from)}'`,
          { loc },
        );
      }
      to = 'bytes32';
    }
    const lit = this.litValues.get(c.id);
    if (lit !== undefined) {
      const [min, max] = rangeOf(to);
      if (lit < min || lit > max) {
        this.certainPanic(what, `${lit} does not fit '${to}'`, 0x11, loc);
      }
      return makeExpr(this, this.wordConst(to, lit, loc));
    }
    const out = this.newValue(to, loc);
    this.appendStmt({ k: 'convert', a: c.id, out }, loc);
    return makeExpr(this, out);
  }

  lenOp(a: unknown, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    const c = this.classify(a, what, loc);
    if (c.kind !== 'expr' || !isDynamicType(c.type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: .length() requires an Expr of string/bytes/T[], got ${c.kind === 'expr' ? `'${stringifyEvsType(c.type)}'` : describeHost(a)}`,
        { loc },
      );
    }
    const out = this.newValue('uint256', loc);
    this.appendStmt({ k: 'len', a: c.id, out }, loc);
    return makeExpr(this, out);
  }

  atOp(a: unknown, i: unknown, what: string): Expr {
    const loc = captureLoc();
    this.assertOpen(what, loc);
    const c = this.classify(a, what, loc);
    if (c.kind !== 'expr' || !isArrayType(c.type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: .at(i) requires an Expr of a T[] array type, got ${c.kind === 'expr' ? `'${stringifyEvsType(c.type)}'` : describeHost(a)}`,
        { loc },
      );
    }
    const iId = this.coerceToId(i, 'uint256', `${what} index`, loc);
    const out = this.newValue(elemTypeOf(c.type), loc);
    this.appendStmt({ k: 'index', arr: c.id, i: iId, out }, loc);
    return makeExpr(this, out);
  }

  // -- control flow ---------------------------------------------------------------------

  ifStmt(cond: unknown, thenFn: unknown, elseFn: unknown): void {
    const loc = captureLoc();
    this.assertOpen('s.if()', loc);
    if (typeof thenFn !== 'function' || (elseFn !== undefined && typeof elseFn !== 'function')) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.if(): branches must be callbacks — s.if(cond, () => { … }, () => { … }?)`,
        { loc },
      );
    }
    const condId = this.coerceToId(cond, 'bool', 's.if() condition', loc);
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
    this.appendStmt({ k: 'if', cond: condId, then: thenScope.stmts, else: elseScope.stmts }, loc);
  }

  whileStmt(condThunk: unknown, bodyFn: unknown): void {
    const loc = captureLoc();
    this.assertOpen('s.while()', loc);
    if (typeof condThunk !== 'function' || typeof bodyFn !== 'function') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.while(): expected s.while(() => cond, (loop) => { … }) — the condition is a thunk recorded into the loop header`,
        { loc },
      );
    }
    this.whileInternal(
      loc,
      () => {
        const cond = unsafeCast<() => unknown>(condThunk)();
        return this.coerceToId(cond, 'bool', 's.while() condition', loc);
      },
      (loop) => {
        unsafeCast<(loop: LoopCtlImpl) => void>(bodyFn)(loop);
      },
    );
  }

  private whileInternal(
    loc: SourceLoc | null,
    recordCond: () => ValueId,
    recordBody: (loop: LoopCtlImpl, bodyScope: Scope) => void,
  ): void {
    const headerScope = this.pushScope('while-header');
    try {
      const condId = recordCond();
      const bodyScope = this.pushScope('while-body'); // child of the header scope
      const loop = new LoopCtlImpl(this, bodyScope, loc);
      try {
        recordBody(loop, bodyScope);
      } finally {
        this.popScope();
      }
      this.popScope(); // header
      this.appendStmt(
        { k: 'while', header: headerScope.stmts, cond: condId, body: bodyScope.stmts },
        loc,
      );
      return;
    } catch (e) {
      // unwind any scopes this loop pushed, then rethrow
      while (this.stack.includes(headerScope)) this.popScope();
      throw e;
    }
  }

  forStmt(range: unknown, bodyFn: unknown): void {
    const loc = captureLoc();
    this.assertOpen('s.for()', loc);
    if (typeof bodyFn !== 'function') {
      throw new EvsTypeError('TYPE_MISMATCH', `s.for(): body must be a callback (i, loop) => …`, {
        loc,
      });
    }
    if (typeof range !== 'object' || range === null) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.for(): range must be { type, from, until, step? }`,
        { loc },
      );
    }
    const r = range as { type?: unknown; from?: unknown; until?: unknown; step?: unknown };
    assertV0Type(r.type, 's.for() range.type', loc);
    const ty = r.type;
    if (!isNumeric(ty)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.for(): range.type must be numeric (uintN/intN), got '${stringifyEvsType(ty)}'`,
        { loc },
      );
    }
    if (r.from === undefined || r.until === undefined) {
      throw new EvsTypeError('TYPE_MISMATCH', `s.for(): range.from and range.until are required`, {
        loc,
      });
    }
    // the loop cell + the ONE-TIME snapshots of `until` and `step` (api.md §7)
    const cellId = this.makeCell(ty, r.from, loc);
    const untilId = this.coerceToId(r.until, ty, 's.for() range.until', loc);
    const stepId = this.coerceToId(r.step ?? 1, ty, 's.for() range.step', loc);

    // continue() must execute the step first (api.md §5: "for-loops: to the step"), so the
    // step is recorded before every `continue` and once at the natural end of the body.
    const emitStep = (stepLoc: SourceLoc | null): void => {
      const cur = this.cellGetId(cellId, stepLoc);
      const sum = this.newValue(ty, stepLoc);
      this.appendStmt({ k: 'bin', op: 'add', a: cur, b: stepId, out: sum }, stepLoc);
      this.appendStmt({ k: 'cellset', cell: cellId, value: sum }, stepLoc);
    };

    this.whileInternal(
      loc,
      () => {
        const iv = this.cellGetId(cellId, loc);
        const cond = this.newValue('bool', loc);
        this.appendStmt({ k: 'bin', op: 'lt', a: iv, b: untilId, out: cond }, loc);
        return cond;
      },
      (rawLoop) => {
        const iSnap = makeExpr(this, this.cellGetId(cellId, loc));
        const wrapped: LoopCtlShape = {
          break: () => {
            rawLoop.break();
          },
          continue: () => {
            const cloc = captureLoc();
            rawLoop.guard('loop.continue()', cloc);
            emitStep(cloc);
            rawLoop.emit('continue', cloc);
          },
        };
        unsafeCast<(i: Expr, loop: LoopCtlShape) => void>(bodyFn)(iSnap, wrapped);
        emitStep(loc);
      },
    );
  }

  select(cond: unknown, a: unknown, b: unknown): Expr {
    const loc = captureLoc();
    this.assertOpen('s.select()', loc);
    const ca = this.classify(a, 's.select() first branch', loc);
    const cb = this.classify(b, 's.select() second branch', loc);
    let ty: EvsType;
    if (ca.kind === 'expr' && cb.kind === 'expr') {
      if (!typesEqual(ca.type, cb.type)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.select(): branch types differ (Expr<'${stringifyEvsType(ca.type)}'> vs Expr<'${stringifyEvsType(cb.type)}'>)`,
          { loc },
        );
      }
      ty = ca.type;
    } else if (ca.kind === 'expr') {
      ty = ca.type;
    } else if (cb.kind === 'expr') {
      ty = cb.type;
    } else {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.select(): at least one branch must be an Expr — type a literal with s.lit(type, value)`,
        { loc },
      );
    }
    // literal condition folds (M5 invariant 6): both branches are already-computed values,
    // so picking one is exact — the chosen operand is aliased (or interned, for a literal).
    const cc = this.classify(cond, 's.select() condition', loc);
    let condLit: bigint | null = null;
    if (cc.kind === 'raw') {
      condLit = this.wordLiteral('bool', cc.value).logical;
    } else if (cc.type !== 'bool') {
      this.typeMismatch('s.select() condition', 'bool', cc.type, loc);
    } else {
      condLit = this.litValues.get(cc.id) ?? null;
    }
    if (condLit !== null) {
      const chosen = condLit === 1n ? ca : cb;
      const dropped = condLit === 1n ? cb : ca;
      if (dropped.kind === 'raw') this.validateLiteral(ty, dropped.value); // eager validation
      if (chosen.kind === 'expr') return makeExpr(this, chosen.id);
      return makeExpr(this, this.coerceToId(chosen.value, ty, 's.select() branch', loc));
    }
    const condId = cc.kind === 'expr' ? cc.id : this.coerceToId(cond, 'bool', 's.select()', loc);
    const ia = ca.kind === 'expr' ? ca.id : this.coerceToId(ca.value, ty, 's.select() branch', loc);
    const ib = cb.kind === 'expr' ? cb.id : this.coerceToId(cb.value, ty, 's.select() branch', loc);
    const out = this.newValue(ty, loc);
    this.appendStmt({ k: 'select', cond: condId, a: ia, b: ib, out }, loc);
    return makeExpr(this, out);
  }

  /** Validates a literal against a type without interning it (eager-eval rule for select). */
  private validateLiteral(ty: EvsType, value: unknown): void {
    if (isWordType(ty)) {
      this.wordLiteral(ty, value);
      return;
    }
    if (isTupleType(ty)) {
      // a tuple branch in s.select() is not a host literal — it must already be a built handle.
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.select(): a tuple branch must be a built tuple (s.tuple / a decoded Tuple), not a literal`,
        { loc: captureLoc() },
      );
    }
    encodeLiteralData(ty, value);
  }

  // -- calls -------------------------------------------------------------------------------

  subcall(p: unknown, mode: 'strict' | 'try'): SubcallShape {
    const label = mode === 'try' ? 's.tryCall()' : 's.call()';
    const loc = captureLoc();
    this.assertOpen(label, loc);
    if (typeof p !== 'object' || p === null) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: expected { address, abi, functionName, args?, gas? }`,
        { loc },
      );
    }
    const params = unsafeCast<{
      address?: unknown;
      abi?: unknown;
      functionName?: unknown;
      args?: unknown;
      gas?: unknown;
    }>(p);
    const abi = params.abi;
    if (!Array.isArray(abi)) {
      throw new EvsTypeError('ABI_SHAPE', `${label}: \`abi\` must be an ABI array`, { loc });
    }
    const fname = params.functionName;
    if (typeof fname !== 'string' || fname === '') {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${label}: \`functionName\` is required (got ${describeHost(fname)})`,
        { loc },
      );
    }
    const named = abi.filter(
      (it) => isRecordObj(it) && it['type'] === 'function' && it['name'] === fname,
    );
    if (named.length === 0) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${label}: the provided ABI has no function named "${fname}"`,
        { loc },
      );
    }
    const viewish = named.filter(
      (it) =>
        isRecordObj(it) && (it['stateMutability'] === 'view' || it['stateMutability'] === 'pure'),
    );
    if (viewish.length === 0) {
      const muts = named
        .map((it) => {
          if (!isRecordObj(it)) return 'unspecified';
          const m = it['stateMutability'];
          return typeof m === 'string' ? m : 'unspecified';
        })
        .join('/');
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${label}: function "${fname}" is ${muts} — read scripts can only call view/pure functions`,
        { loc },
      );
    }
    if (viewish.length > 1) {
      throw new EvsTypeError(
        'UNSUPPORTED_V0',
        `${label}: function "${fname}" is overloaded (${viewish.length} view/pure overloads) — overload disambiguation is deferred in v0; prune the ABI to the single intended entry`,
        { loc },
      );
    }
    const item = viewish[0];
    if (item === undefined || !Array.isArray(item['inputs']) || !Array.isArray(item['outputs'])) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${label}: ABI entry for "${fname}" is malformed (missing inputs/outputs arrays)`,
        { loc },
      );
    }
    // shape-checked above; toPlainAbiFunction validates the v0 types, naming the parameter
    const plain = toPlainAbiFunction(unsafeCast<AbiFunction>(item));
    if (params.address === undefined) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: \`address\` is required`, { loc });
    }
    const target = this.coerceToId(params.address, 'address', `${label} address`, loc);
    const rawArgs = params.args === undefined ? [] : params.args;
    if (!Array.isArray(rawArgs)) {
      throw new EvsTypeError('TYPE_MISMATCH', `${label}: \`args\` must be an array`, { loc });
    }
    if (rawArgs.length !== plain.inputs.length) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${label}: function "${fname}" expects ${plain.inputs.length} argument(s), got ${rawArgs.length}`,
        { loc },
      );
    }
    const argIds = plain.inputs.map((inp, i) => {
      // abiParamToType turns a `'tuple'` input (carrying components) into a TupleType — coerceToId
      // then routes through its tuple branch (a Tuple handle or a literal struct object).
      const ity = abiParamToType(inp);
      if (!isEvsValueType(ity)) {
        throw new EvsInternalError('INTERNAL', `${label}: non-v0 input survived validation`);
      }
      const argLabel = inp.name === '' ? `args[${i}]` : `args[${i}] ("${inp.name}")`;
      return this.coerceToId(rawArgs[i], ity, `${label} ${argLabel}`, loc);
    });
    const gasId =
      params.gas === undefined
        ? undefined
        : this.coerceToId(params.gas, 'uint256', `${label} gas`, loc);
    const callerName = mode === 'try' ? 's.tryCall' : 's.call';
    // each out value's type is `abiParamToType(o)` — a `'tuple'` output (head/tail in the
    // returndata) is decoded into a freshly-allocated flat block (codegen/call.ts) and yields a
    // Tuple handle on unwrap; scalars/arrays yield an Expr.
    const outTypes = plain.outputs.map((o): EvsType => {
      const oty = abiParamToType(o);
      if (!isEvsValueType(oty)) {
        throw new EvsInternalError('INTERNAL', `${label}: non-v0 output survived validation`);
      }
      return oty;
    });
    const outIds = outTypes.map((oty, i) => {
      const tag =
        outTypes.length === 1 ? `${callerName}(${fname})` : `${callerName}(${fname})[${i}]`;
      return this.newValue(oty, loc, tag);
    });
    const successId =
      mode === 'try' ? this.newValue('bool', loc, `s.tryCall(${fname}).success`) : undefined;
    this.appendStmt(
      {
        k: 'call',
        target,
        fnAbi: plain,
        args: argIds,
        outs: outIds,
        mode,
        ...(successId !== undefined ? { successOut: successId } : {}),
        ...(gasId !== undefined ? { gas: gasId } : {}),
      },
      loc,
    );
    // unwrap a tuple-typed out ValueId to a Tuple handle, every scalar/array to an Expr.
    const handleFor = (id: ValueId, oty: EvsType): Expr | object =>
      isTupleType(oty) ? makeTuple(this, id, oty) : makeExpr(this, id);
    const first = outIds[0];
    const firstType = outTypes[0];
    const value: unknown =
      outIds.length === 0
        ? undefined
        : outIds.length === 1 && first !== undefined && firstType !== undefined
          ? handleFor(first, firstType)
          : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- outTypes is parallel to outIds (same length); the index is always in range
            Object.freeze(outIds.map((id, i) => handleFor(id, outTypes[i] as EvsType)));
    return { success: successId !== undefined ? makeExpr(this, successId) : null, value };
  }

  // -- user functions ----------------------------------------------------------------------

  defineFn(name: unknown, paramsIn: unknown, bodyFn: unknown): (...args: unknown[]) => unknown {
    const loc = captureLoc();
    this.assertOpen('s.fn()', loc);
    if (typeof name !== 'string' || !IDENT_RE.test(name)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.fn(): name must be a non-empty identifier, got ${describeHost(name)}`,
        { loc },
      );
    }
    if (!Array.isArray(paramsIn)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.fn("${name}"): params must be a readonly ArgSpec[] tuple (use arg(name, type))`,
        { loc },
      );
    }
    if (typeof bodyFn !== 'function') {
      throw new EvsTypeError('TYPE_MISMATCH', `s.fn("${name}"): body must be a callback`, { loc });
    }
    const seen = new Set<string>();
    const params = paramsIn.map((spec: unknown, i) => {
      const sp: Record<string, unknown> = isRecordObj(spec) ? spec : {};
      const pName = sp['name'];
      const pType = sp['type'];
      if (typeof pName !== 'string' || !IDENT_RE.test(pName)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.fn("${name}") param #${i}: invalid name ${describeHost(pName)} (must be a non-empty identifier)`,
          { loc },
        );
      }
      if (seen.has(pName)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.fn("${name}") param #${i}: duplicate param name "${pName}"`,
          { loc },
        );
      }
      seen.add(pName);
      assertV0Type(pType, `s.fn("${name}") param "${pName}"`, loc);
      return { name: pName, type: pType };
    });

    // reserve the FnId, push the isolated stack (M5 invariant 3) and record the body once
    const fnId = this.fnIrs.length;
    this.fnIrs.push(null);
    this.openFns.add(fnId);
    const fnScope = newScope('fn-body');
    this.savedStacks.push(this.stack);
    this.stack = [fnScope];
    this.fnCtx.push({ name, loc });
    let resultIds: ValueId[];
    let shape: 'void' | 'single' | 'tuple';
    try {
      const paramEntries = params.map((p) => {
        const id = this.newValue(p.type, loc, `${name}(${p.name})`);
        return { name: p.name, type: p.type, value: id };
      });
      const handles = paramEntries.map((p) => makeExpr(this, p.value));
      const r: unknown = unsafeCast<(...a: Expr[]) => unknown>(bodyFn)(...handles);
      // results must be validated while the fn stack is still active
      if (r === undefined) {
        shape = 'void';
        resultIds = [];
      } else if (Array.isArray(r)) {
        shape = 'tuple';
        resultIds = r.map((el, i) => this.requireFnResult(el, name, i, loc));
      } else {
        shape = 'single';
        resultIds = [this.requireFnResult(r, name, null, loc)];
      }
      this.fnIrs[fnId] = {
        name,
        params: paramEntries,
        results: resultIds.map((id) => ({ type: this.typeOfValue(id) })),
        body: fnScope.stmts,
        resultValues: resultIds,
        loc,
      };
    } finally {
      const saved = this.savedStacks.pop();
      if (saved !== undefined) this.stack = saved;
      this.fnCtx.pop();
    }
    this.openFns.delete(fnId);
    return (...callArgs: unknown[]) => this.fnCall(fnId, name, shape, callArgs);
  }

  private requireFnResult(
    v: unknown,
    fnName: string,
    index: number | null,
    loc: SourceLoc | null,
  ): ValueId {
    const what =
      index === null ? `s.fn("${fnName}") result` : `s.fn("${fnName}") result [${index}]`;
    const c = this.classify(v, what, loc);
    if (c.kind !== 'expr') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: fn bodies must return an Expr, a readonly Expr[] tuple, or void — got ${describeHost(v)}`,
        { loc },
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
    const loc = captureLoc();
    this.assertOpen(`fn "${name}"()`, loc);
    if (this.openFns.has(fnId)) {
      // defensive: unconstructible (the handle does not exist inside its own body), but checked
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `fn "${name}" cannot call itself — recursion is not supported in evs scripts`,
        { loc },
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
        { loc },
      );
    }
    const argIds = fn.params.map((p, i) =>
      this.coerceToId(callArgs[i], p.type, `fn "${name}" arg ${i} ("${p.name}")`, loc),
    );
    const outIds = fn.results.map((r, i) => {
      const tag = fn.results.length === 1 ? `${name}(…)` : `${name}(…)[${i}]`;
      return this.newValue(r.type, loc, tag);
    });
    this.appendStmt({ k: 'fncall', fn: fnId, args: argIds, outs: outIds }, loc);
    if (shape === 'void') return undefined;
    const first = outIds[0];
    if (shape === 'single' && first !== undefined) return makeExpr(this, first);
    return Object.freeze(outIds.map((id) => makeExpr(this, id)));
  }

  // -- return + sealing ----------------------------------------------------------------------

  ret(values: unknown): object {
    const loc = captureLoc();
    this.assertOpen('s.return()', loc);
    if (this.savedStacks.length > 0) {
      const fn = this.fnCtx[this.fnCtx.length - 1];
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `s.return() cannot be recorded inside an s.fn body — return values from the fn callback instead`,
        { loc, relatedLocs: [{ label: 'fn defined at', loc: fn?.loc ?? null }] },
      );
    }
    if (this.stack.length !== 1) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `s.return() must run exactly once, unconditionally, at the top level of the script — it cannot be recorded inside a ${this.top().kind} block`,
        { loc },
      );
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.return(): expected a record of named Exprs, got ${describeHost(values)}`,
        { loc },
      );
    }
    const returns: { name: string; type: EvsType; value: ValueId }[] = [];
    for (const [key, v] of Object.entries(values)) {
      if (key === '') {
        throw new EvsTypeError(
          'ABI_SHAPE',
          `s.return(): empty-string return keys are rejected — every component must be named or viem degrades the result object to a positional array`,
          { loc },
        );
      }
      if (!IDENT_RE.test(key)) {
        throw new EvsTypeError(
          'ABI_SHAPE',
          `s.return(): invalid return key ${JSON.stringify(key)} (must be an identifier)`,
          { loc },
        );
      }
      // a Tuple handle is returnable DIRECTLY (no `.expr()` needed): the bare handle IS the
      // memref, so we return its ValueId verbatim — byte-identical to `tuple.expr()`. classify()
      // (below) still rejects tuples on the arithmetic paths with the "use .expr()" message.
      if (typeof v === 'object' && v !== null) {
        const ti = TUPLE_INTERNALS.get(v);
        if (ti !== undefined) {
          if (ti.owner !== this) {
            throw new EvsScopeError(
              'FOREIGN_HANDLE',
              `s.return() value "${key}": this Tuple belongs to script "${ti.owner.name}" (defined at ${fmtLoc(ti.owner.scriptLoc)}) and cannot be used in script "${this.name}" — handles never cross scripts`,
              {
                loc,
                relatedLocs: [
                  { label: `script "${ti.owner.name}" defined at`, loc: ti.owner.scriptLoc },
                  { label: 'handle recorded at', loc: ti.owner.valueLoc(ti.id) },
                ],
              },
            );
          }
          this.checkVisible(ti.id, `s.return() value "${key}"`, loc);
          returns.push({ name: key, type: this.typeOfValue(ti.id), value: ti.id });
          continue;
        }
      }
      const c = this.classify(v, `s.return() value "${key}"`, loc);
      if (c.kind !== 'expr') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.return() value "${key}": must be an Expr — type a literal with s.lit(type, value)`,
          { loc },
        );
      }
      returns.push({ name: key, type: c.type, value: c.id });
    }
    this.returnsList = returns;
    this.sealed = true; // M5 invariant 7: the recorder seals on s.return
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
        { loc: this.scriptLoc },
      );
    }
    if (callbackResult !== this.returnToken) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `script "${this.name}": the builder callback must return the value produced by THIS script's s.return({...})`,
        { loc: this.scriptLoc },
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
      loc: this.scriptLoc,
    };
    deepFreeze(ir);
    return { ir, returns: this.returnsList };
  }
}

/** Structural shape handed to loop bodies (cast to the public `LoopCtl` by script.ts). */
export interface LoopCtlShape {
  break(): void;
  continue(): void;
}
