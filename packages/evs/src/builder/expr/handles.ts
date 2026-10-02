/**
 * `builder/expr/handles.ts` — the staged handle classes (`Expr`, `Cell`, `MutArray`, `Tuple`,
 * `Field`, loop control) and their unforgeable module-private internals, plus the staging traps
 * installed on the `Expr` / `Tuple` prototypes at module load.
 */

import { EvsScopeError, EvsTypeError } from '../../core/errors.js';
import {
  type EvsType,
  type TupleType,
  type Expr,
  abiParamToType,
  installStagingTraps,
} from '../../core/types.js';
import type { ValueId, CellId } from '../../ir/nodes.js';
import type { TupleHandleMember } from '../script/handles.js';
import { unsafeCast, type Scope } from './helpers.js';
import type { Recorder } from './recorder.js';

// ---------------------------------------------------------------------------
// module-private handle internals (unforgeable handles)
// ---------------------------------------------------------------------------

interface ExprInternals {
  readonly owner: Recorder;
  readonly id: ValueId;
}
interface CellInternals {
  readonly owner: Recorder;
  readonly id: CellId;
}
export interface ArrInternals {
  readonly owner: Recorder;
  readonly id: ValueId;
  readonly elem: EvsType; // any value type (word, string/bytes, tuple, or an array — dynamic or fixed)
}
export interface TupleInternals {
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

export const EXPR_INTERNALS = new WeakMap<object, ExprInternals>();
export const CELL_INTERNALS = new WeakMap<object, CellInternals>();
export const ARR_INTERNALS = new WeakMap<object, ArrInternals>();
export const TUPLE_INTERNALS = new WeakMap<object, TupleInternals>();
export const FIELD_INTERNALS = new WeakMap<object, FieldInternals>();

/**
 * The one own enumerable key of every handle a tuple value can sit behind (`Tuple`, `Expr`,
 * `Cell`, `Field`), valued with the handle itself. It is a symbol, so `Object.keys(handle)` stays
 * as it was. Those handles keep their members on a prototype (or have none), so a spread /
 * `Object.assign` copy holds no member — only this mark, which object spread copies — and the
 * recorder rejects such a copy where it reads a record and the copy leaves a member out, instead
 * of silently zero-filling that member.
 */
const HANDLE_COPY_MARK: unique symbol = Symbol('evs.handleCopy');

/** The handle `v` is a spread / `Object.assign` copy of (it carries {@link HANDLE_COPY_MARK}
 *  but is not that handle), else undefined. */
export function copiedHandle(v: object): object | undefined {
  if (!Object.hasOwn(v, HANDLE_COPY_MARK)) return undefined;
  const src: unknown = Reflect.get(v, HANDLE_COPY_MARK);
  return src === v || typeof src !== 'object' || src === null ? undefined : src;
}

/** The kind and value type of a handle {@link copiedHandle} returned (for its diagnostics). */
export function describeCopiedHandle(h: object): { kind: string; type: EvsType | undefined } {
  const ti = TUPLE_INTERNALS.get(h);
  if (ti !== undefined) return { kind: 'a Tuple', type: ti.tt };
  const ei = EXPR_INTERNALS.get(h);
  if (ei !== undefined) return { kind: 'an Expr', type: ei.owner.typeOfValue(ei.id) };
  const ci = CELL_INTERNALS.get(h);
  if (ci !== undefined) return { kind: 'a Cell', type: ci.owner.typeOfCell(ci.id) };
  const fi = FIELD_INTERNALS.get(h);
  if (fi !== undefined) return { kind: 'a Field', type: fi.type };
  return { kind: 'an evs', type: undefined };
}

function markHandle(h: object): void {
  Object.defineProperty(h, HANDLE_COPY_MARK, { value: h, enumerable: true });
}

/**
 * The error for a handle member used without its handle: a method passed on as a callback
 * (`xs.map(x.add)`, `s.if(c, loop.break)`) or stored and called on its own
 * (`const f = x.add; f(y)`) runs with `this` undefined; one invoked on another value
 * (`x.add.call(cell, 1n)`) runs with that value as `this`. Every handle registers its internals
 * when it is built, so those are the only ways the lookups below miss, and they report it as the
 * user's mistake: it names the member (`kind.member`), what it was called on when that was not
 * nothing, and the arrow to write instead, calling through `receiver` with as many parameters as
 * the method declares. A getter (`.type`, a struct field) is only reached detached through its
 * property descriptor; it gets the same message, worded as a read.
 */
function detachedMemberError(
  kind: string,
  receiver: string,
  proto: object,
  member: string,
  self: unknown,
): EvsTypeError {
  const method: unknown = Object.getOwnPropertyDescriptor(proto, member)?.value;
  const article = /^[AEIOU]/.test(kind) ? 'an' : 'a';
  const wrongThis =
    self === undefined ? undefined : `${describeReceiver(self)}, not on ${article} ${kind}`;
  if (typeof method !== 'function') {
    return new EvsTypeError(
      'TYPE_MISMATCH',
      `${kind}.${member} was read ${wrongThis === undefined ? 'without its handle' : `on ${wrongThis}`} — read it on the handle itself: \`${receiver}.${member}\``,
    );
  }
  const params = method.length === 1 ? 'v' : ['a', 'b', 'c'].slice(0, method.length).join(', ');
  const arrow = `\`(${params}) => ${receiver}.${member}(${params})\``;
  if (wrongThis !== undefined) {
    return new EvsTypeError(
      'TYPE_MISMATCH',
      `${kind}.${member} was called on ${wrongThis}. Call it on the handle itself, through an arrow where a function is expected: ${arrow}`,
    );
  }
  return new EvsTypeError(
    'TYPE_MISMATCH',
    `${kind}.${member} was called without its handle: a method passed on as a callback or stored and called on its own (\`const f = ${receiver}.${member}; f(${params})\`) no longer knows which handle it belongs to. Call it on the handle, through an arrow where a function is expected: ${arrow}`,
  );
}

/** What a handle method was wrongly called on, for {@link detachedMemberError}. */
function describeReceiver(self: unknown): string {
  if (self === null) return 'null';
  if (typeof self !== 'object' && typeof self !== 'function') return `a ${typeof self}`;
  if (EXPR_INTERNALS.has(self)) return 'an Expr';
  if (CELL_INTERNALS.has(self)) return 'a Cell';
  if (ARR_INTERNALS.has(self)) return 'a MutArray';
  if (TUPLE_INTERNALS.has(self)) return 'a Tuple';
  if (FIELD_INTERNALS.has(self)) return 'a Field';
  if (self instanceof LoopCtlImpl) return 'a LoopCtl';
  return typeof self === 'function' ? 'a function' : 'an object that is not an evs handle';
}

/** Runtime brand carried by `s.return(...)` tokens (the public `returnBrand` is type-only). */
export const RETURN_BRAND: unique symbol = Symbol('evs.scriptReturn');

/** A staged handle of this builder family (an `Expr`, `Tuple`, `MutArray`, or `Field`) — as
 *  opposed to a plain host literal. */
export function isStagedHandle(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    (EXPR_INTERNALS.has(v) ||
      TUPLE_INTERNALS.has(v) ||
      ARR_INTERNALS.has(v) ||
      FIELD_INTERNALS.has(v))
  );
}

// ---------------------------------------------------------------------------
// the Expr handle (staging traps live on the prototype, installed once below)
// ---------------------------------------------------------------------------

class ExprHandle {
  constructor(owner: Recorder, id: ValueId) {
    EXPR_INTERNALS.set(this, { owner, id });
    markHandle(this);
  }

  get type(): EvsType {
    const i = internalsOf(this, 'type');
    return i.owner.typeOfValue(i.id);
  }

  add(rhs: unknown): Expr {
    return internalsOf(this, 'add').owner.bin('add', this, rhs, '.add()');
  }
  sub(rhs: unknown): Expr {
    return internalsOf(this, 'sub').owner.bin('sub', this, rhs, '.sub()');
  }
  mul(rhs: unknown): Expr {
    return internalsOf(this, 'mul').owner.bin('mul', this, rhs, '.mul()');
  }
  div(rhs: unknown): Expr {
    return internalsOf(this, 'div').owner.bin('div', this, rhs, '.div()');
  }
  mod(rhs: unknown): Expr {
    return internalsOf(this, 'mod').owner.bin('mod', this, rhs, '.mod()');
  }
  pow(exponent: unknown): Expr {
    return internalsOf(this, 'pow').owner.bin('pow', this, exponent, '.pow()');
  }
  addmod(rhs: unknown, modulus: unknown): Expr {
    return internalsOf(this, 'addmod').owner.modArithOp('addmod', this, rhs, modulus, '.addmod()');
  }
  mulmod(rhs: unknown, modulus: unknown): Expr {
    return internalsOf(this, 'mulmod').owner.modArithOp('mulmod', this, rhs, modulus, '.mulmod()');
  }
  wrappingAdd(rhs: unknown): Expr {
    return internalsOf(this, 'wrappingAdd').owner.bin('wrapadd', this, rhs, '.wrappingAdd()');
  }
  wrappingSub(rhs: unknown): Expr {
    return internalsOf(this, 'wrappingSub').owner.bin('wrapsub', this, rhs, '.wrappingSub()');
  }
  wrappingMul(rhs: unknown): Expr {
    return internalsOf(this, 'wrappingMul').owner.bin('wrapmul', this, rhs, '.wrappingMul()');
  }
  mulDiv(rhs: unknown, denominator: unknown): Expr {
    return internalsOf(this, 'mulDiv').owner.modArithOp(
      'muldiv',
      this,
      rhs,
      denominator,
      '.mulDiv()',
    );
  }
  mulDivRoundingUp(rhs: unknown, denominator: unknown): Expr {
    return internalsOf(this, 'mulDivRoundingUp').owner.modArithOp(
      'muldivup',
      this,
      rhs,
      denominator,
      '.mulDivRoundingUp()',
    );
  }
  lt(rhs: unknown): Expr {
    return internalsOf(this, 'lt').owner.bin('lt', this, rhs, '.lt()');
  }
  gt(rhs: unknown): Expr {
    return internalsOf(this, 'gt').owner.bin('gt', this, rhs, '.gt()');
  }
  lte(rhs: unknown): Expr {
    return internalsOf(this, 'lte').owner.bin('lte', this, rhs, '.lte()');
  }
  gte(rhs: unknown): Expr {
    return internalsOf(this, 'gte').owner.bin('gte', this, rhs, '.gte()');
  }
  eq(rhs: unknown): Expr {
    return internalsOf(this, 'eq').owner.bin('eq', this, rhs, '.eq()');
  }
  neq(rhs: unknown): Expr {
    return internalsOf(this, 'neq').owner.bin('neq', this, rhs, '.neq()');
  }
  and(rhs: unknown): Expr {
    return internalsOf(this, 'and').owner.bin('and', this, rhs, '.and()');
  }
  or(rhs: unknown): Expr {
    return internalsOf(this, 'or').owner.bin('or', this, rhs, '.or()');
  }
  not(): Expr {
    return internalsOf(this, 'not').owner.notOp(this, '.not()');
  }
  bitAnd(rhs: unknown): Expr {
    return internalsOf(this, 'bitAnd').owner.bin('bitand', this, rhs, '.bitAnd()');
  }
  bitOr(rhs: unknown): Expr {
    return internalsOf(this, 'bitOr').owner.bin('bitor', this, rhs, '.bitOr()');
  }
  bitXor(rhs: unknown): Expr {
    return internalsOf(this, 'bitXor').owner.bin('bitxor', this, rhs, '.bitXor()');
  }
  bitNot(): Expr {
    return internalsOf(this, 'bitNot').owner.bitNotOp(this, '.bitNot()');
  }
  shl(bits: unknown): Expr {
    return internalsOf(this, 'shl').owner.bin('shl', this, bits, '.shl()');
  }
  shr(bits: unknown): Expr {
    return internalsOf(this, 'shr').owner.bin('shr', this, bits, '.shr()');
  }
  toUint(target: unknown): Expr {
    return internalsOf(this, 'toUint').owner.convertOp('toUint', this, target, '.toUint()');
  }
  toInt(target: unknown): Expr {
    return internalsOf(this, 'toInt').owner.convertOp('toInt', this, target, '.toInt()');
  }
  asAddress(): Expr {
    return internalsOf(this, 'asAddress').owner.convertOp(
      'asAddress',
      this,
      undefined,
      '.asAddress()',
    );
  }
  asUint160(): Expr {
    return internalsOf(this, 'asUint160').owner.convertOp(
      'asUint160',
      this,
      undefined,
      '.asUint160()',
    );
  }
  asUint256(): Expr {
    return internalsOf(this, 'asUint256').owner.convertOp(
      'asUint256',
      this,
      undefined,
      '.asUint256()',
    );
  }
  asBytes32(): Expr {
    return internalsOf(this, 'asBytes32').owner.convertOp(
      'asBytes32',
      this,
      undefined,
      '.asBytes32()',
    );
  }
  asUint(): Expr {
    return internalsOf(this, 'asUint').owner.convertOp('asUint', this, undefined, '.asUint()');
  }
  asBytesN(): Expr {
    return internalsOf(this, 'asBytesN').owner.convertOp(
      'asBytesN',
      this,
      undefined,
      '.asBytesN()',
    );
  }
  asBytes(): Expr {
    return internalsOf(this, 'asBytes').owner.convertOp('asBytes', this, undefined, '.asBytes()');
  }
  asString(): Expr {
    return internalsOf(this, 'asString').owner.convertOp(
      'asString',
      this,
      undefined,
      '.asString()',
    );
  }
  length(): Expr {
    return internalsOf(this, 'length').owner.lenOp(this, '.length()');
  }
  byteAt(i: unknown): Expr {
    return internalsOf(this, 'byteAt').owner.byteAtOp(this, i, '.byteAt()');
  }
  slice(start: unknown, end?: unknown): Expr {
    return internalsOf(this, 'slice').owner.sliceOp(this, start, end, '.slice()');
  }
  at(i: unknown): Expr {
    // the runtime handle is element-typed (a composite element yields a `Tuple`/array handle); the
    // public `Expr.at` overloads narrow it per element type, so the cast is sound.
    return unsafeCast<Expr>(internalsOf(this, 'at').owner.atOp(this, i, '.at()'));
  }
}

function internalsOf(h: object, member: string): ExprInternals {
  const i = EXPR_INTERNALS.get(h);
  if (i === undefined) throw detachedMemberError('Expr', 'x', ExprHandle.prototype, member, h);
  return i;
}

export function makeExpr(owner: Recorder, id: ValueId): Expr {
  return unsafeCast<Expr>(new ExprHandle(owner, id));
}

// ---------------------------------------------------------------------------
// Cell / MutArray / LoopCtl handles
// ---------------------------------------------------------------------------

export class CellImpl {
  constructor(owner: Recorder, id: CellId) {
    CELL_INTERNALS.set(this, { owner, id });
    markHandle(this);
  }

  get type(): EvsType {
    const i = cellInternalsOf(this, 'type');
    return i.owner.typeOfCell(i.id);
  }

  get(): Expr {
    const i = cellInternalsOf(this, 'get');
    return i.owner.cellGet(i.id, 'Cell.get()');
  }

  set(value: unknown): void {
    const i = cellInternalsOf(this, 'set');
    i.owner.cellSet(i.id, value, 'Cell.set()');
  }
}

function cellInternalsOf(h: object, member: string): CellInternals {
  const i = CELL_INTERNALS.get(h);
  if (i === undefined) throw detachedMemberError('Cell', 'cell', CellImpl.prototype, member, h);
  return i;
}

export class MutArrayImpl {
  readonly elemType: EvsType;
  readonly length: Expr;

  constructor(owner: Recorder, arrId: ValueId, elem: EvsType, length: Expr) {
    ARR_INTERNALS.set(this, { owner, id: arrId, elem });
    this.elemType = elem;
    this.length = length;
  }

  set(i: unknown, v: unknown): void {
    const a = arrInternalsOf(this, 'set');
    a.owner.arrSet(a.id, a.elem, i, v, 'MutArray.set()');
  }

  get(i: unknown): Expr | object {
    const a = arrInternalsOf(this, 'get');
    return a.owner.arrGet(a.id, a.elem, i, 'MutArray.get()');
  }

  expr(): Expr {
    const a = arrInternalsOf(this, 'expr');
    return a.owner.arrExpr(a.id, 'MutArray.expr()');
  }
}

function arrInternalsOf(h: object, member: string): ArrInternals {
  const i = ARR_INTERNALS.get(h);
  if (i === undefined)
    throw detachedMemberError('MutArray', 'arr', MutArrayImpl.prototype, member, h);
  return i;
}

// ---------------------------------------------------------------------------
// Tuple / Field handles (composite memrefs)
// ---------------------------------------------------------------------------

/**
 * The names a struct field cannot take as a {@link TupleHandle} accessor: the handle's own
 * methods (`at`, `expr`), the staging traps (`valueOf`, `toString`, `toJSON`), every
 * `Object.prototype` member (`constructor`, `__proto__`, `hasOwnProperty`, …) and `then` (a
 * `then` accessor would make the handle a thenable that `await` silently unwraps). The handle
 * member wins: a field with one of these names gets no accessor and is reached through `.at(i)`.
 * Third-party ABIs keep working that way, and the `Tuple<C>` type drops the same names from its
 * field record ({@link TupleHandleMember}, kept equal to this list by a type test).
 */
export const TUPLE_HANDLE_MEMBERS = Object.freeze([
  'at',
  'expr',
  'then',
  'valueOf',
  'toString',
  'toLocaleString',
  'toJSON',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const satisfies readonly TupleHandleMember[]);

const TUPLE_HANDLE_MEMBER_SET: ReadonlySet<string> = new Set(TUPLE_HANDLE_MEMBERS);

/**
 * A tuple/struct memref handle. It is the pointer to the flat `[w0…w_{n-1}]` block (reference
 * semantics — aliasing the handle shares the block). Named struct fields are accessors on a
 * prototype shared per component list ({@link tupleProtoOf}); positional members go through
 * `.at(i)`; `.expr()` yields the raw memref. Staging traps are installed (like `Expr`) so a stray
 * coercion explodes with a useful message. Instances are created by {@link makeTuple}, never
 * with `new`.
 */
class TupleHandle {
  at(i: unknown): FieldHandle {
    const t = tupleInternalsOf(this, 'at');
    return t.owner.tupleAt(t.id, t.tt, i, 'Tuple.at()');
  }

  expr(): Expr {
    const t = tupleInternalsOf(this, 'expr');
    return t.owner.tupleExpr(t.id, 'Tuple.expr()');
  }
}

// the staging traps live on the prototypes (installed once, not per handle): `this` is the handle
installStagingTraps(ExprHandle.prototype, (h) => describeHandle(EXPR_INTERNALS, h, 'Expr'));
installStagingTraps(TupleHandle.prototype, (h) => describeHandle(TUPLE_INTERNALS, h, 'Tuple'));

function describeHandle(
  internals: WeakMap<object, { owner: Recorder; id: ValueId }>,
  handle: unknown,
  kind: string,
): string {
  const i = typeof handle === 'object' && handle !== null ? internals.get(handle) : undefined;
  return i === undefined ? `${kind}<?>` : i.owner.describeValue(i.id);
}

function tupleInternalsOf(h: object, member: string): TupleInternals {
  const i = TUPLE_INTERNALS.get(h);
  if (i === undefined)
    throw detachedMemberError('Tuple', 'tuple', TupleHandle.prototype, member, h);
  return i;
}

/** One prototype per component list, shared by every handle of that shape. Keyed on
 *  `components` (not the descriptor): an array element's or a member's descriptor is rebuilt per
 *  access around the same frozen component list. */
const TUPLE_PROTOS = new WeakMap<TupleType['components'], object>();

/**
 * The prototype of a {@link TupleHandle} over `tt`: `TupleHandle.prototype` plus one enumerable
 * getter per named component (a fresh Field handle on each read; the member type is computed
 * once here). Positional members and names in {@link TUPLE_HANDLE_MEMBERS} get no accessor. The
 * descriptor map has a null prototype so a component named `__proto__` is an ordinary key rather
 * than the map's prototype.
 */
function tupleProtoOf(tt: TupleType): object {
  const cached = TUPLE_PROTOS.get(tt.components);
  if (cached !== undefined) return cached;
  const fieldProps: PropertyDescriptorMap = Object.create(null);
  tt.components.forEach((comp, index) => {
    if (comp.name === '' || TUPLE_HANDLE_MEMBER_SET.has(comp.name)) return; // reached via .at(i)
    const memberType = abiParamToType(comp);
    fieldProps[comp.name] = {
      enumerable: true,
      get(this: object): object {
        const t = tupleInternalsOf(this, comp.name);
        return t.owner.makeField(t.id, index, memberType);
      },
    };
  });
  const proto: object = Object.create(TupleHandle.prototype, fieldProps);
  TUPLE_PROTOS.set(tt.components, proto);
  return proto;
}

export function makeTuple(owner: Recorder, id: ValueId, tt: TupleType): object {
  const handle: object = Object.create(tupleProtoOf(tt));
  TUPLE_INTERNALS.set(handle, { owner, id, tt });
  markHandle(handle);
  return handle;
}

/**
 * A field handle over one tuple member (Cell-like): `.get()` reads the member (`field` stmt — a
 * composite member follows the pointer to a fresh `Tuple` handle), `.set(v)` writes it (`tupleset`
 * stmt). Module-private like `Cell`.
 */
export class FieldHandle {
  readonly type: EvsType;

  constructor(owner: Recorder, tuple: ValueId, index: number, type: EvsType) {
    FIELD_INTERNALS.set(this, { owner, tuple, index, type });
    this.type = type;
    markHandle(this);
  }

  get(): Expr | object {
    const f = fieldInternalsOf(this, 'get');
    return f.owner.fieldGet(f.tuple, f.index, f.type, 'Field.get()');
  }

  set(value: unknown): void {
    const f = fieldInternalsOf(this, 'set');
    f.owner.fieldSet(f.tuple, f.index, f.type, value, 'Field.set()');
  }
}

function fieldInternalsOf(h: object, member: string): FieldInternals {
  const i = FIELD_INTERNALS.get(h);
  if (i === undefined)
    throw detachedMemberError('Field', 'field', FieldHandle.prototype, member, h);
  return i;
}

export class LoopCtlImpl {
  private readonly owner: Recorder;
  private readonly bodyScope: Scope;

  constructor(owner: Recorder, bodyScope: Scope) {
    this.owner = owner;
    this.bodyScope = bodyScope;
  }

  /** Recording-time scoping check: valid only while the owning loop's body scope is open. */
  guard(what: string): void {
    this.owner.assertOpen(what);
    const innermost = this.owner.innermostLoopBody();
    if (innermost === this.bodyScope) return;
    if (innermost !== null && this.owner.isScopeOnStack(this.bodyScope)) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `${what}: this LoopCtl belongs to an outer loop — break/continue the innermost loop with its own LoopCtl (an unlabeled break targets the innermost loop)`,
      );
    }
    throw new EvsScopeError(
      'SCOPE_VIOLATION',
      `${what}: LoopCtl used outside its owning loop's body — it is only valid while that loop body is recording`,
    );
  }

  emit(kind: 'break' | 'continue'): void {
    this.owner.appendStmt({ k: kind });
  }

  break(): void {
    const loop = loopCtlOf(this, 'break');
    loop.guard('loop.break()');
    loop.emit('break');
  }

  continue(): void {
    const loop = loopCtlOf(this, 'continue');
    loop.guard('loop.continue()');
    loop.emit('continue');
  }
}

function loopCtlOf(h: unknown, member: string): LoopCtlImpl {
  if (h instanceof LoopCtlImpl) return h;
  throw detachedMemberError('LoopCtl', 'loop', LoopCtlImpl.prototype, member, h);
}
