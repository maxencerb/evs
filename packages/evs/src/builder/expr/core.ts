/**
 * `builder/expr/core.ts` — the recorder's base layer: value / cell / scope bookkeeping, the
 * visibility (scope) rule, literal and handle coercion (including array and tuple literals),
 * `lit`, and cells.
 */

import {
  canonicalTypeSignature,
  encodeLiteralWord,
  encodeLiteralData,
  missingElement,
} from '../../abi/artifact.js';
import { EvsInternalError, EvsScopeError, EvsTypeError } from '../../core/errors.js';
import {
  type EvsType,
  type Expr,
  isTupleType,
  isArrayValueType,
  stringifyType,
  isWordType,
  isNumeric,
  type WordType,
  type Hex,
  type DynType,
  type ArrayType,
  typesEqual,
  type TupleType,
  elemTypeOf,
  fixedLengthOf,
  type NamedType,
  abiParamToType,
  isMemrefType,
  MAX_FIXED_LENGTH,
} from '../../core/types.js';
import {
  blockDepthMessage,
  MAX_BLOCK_DEPTH,
  type PlainAbiError,
  type ValueInfo,
  type ValueId,
  type CellInfo,
  type FnIr,
  type FnId,
  type CellId,
} from '../../ir/nodes.js';
import {
  makeTuple,
  makeExpr,
  EXPR_INTERNALS,
  CELL_INTERNALS,
  ARR_INTERNALS,
  TUPLE_INTERNALS,
  FIELD_INTERNALS,
  isStagedHandle,
  copiedHandle,
  describeCopiedHandle,
  CellImpl,
} from './handles.js';
import {
  type Scope,
  newScope,
  type ScopeKind,
  type StmtBody,
  type Operand,
  logicalFromCanonical,
  canonicalHex,
  isCompositeElemArray,
  describeHost,
  didYouMean,
  memberName,
  allMembersNamed,
  assertValueType,
  assertLayout,
} from './helpers.js';
import type { Recorder } from './recorder.js';

/**
 * A normalized declared-error entry the recorder checks `s.throw` against (issue #15): the
 * original `t.error` VALUE (identity match), the '' -sentinel param specs (named-record vs
 * positional dispatch), and the IR {@link PlainAbiError} (resolved input names + selector,
 * computed by `builder/script/evscript.ts` — the recorder never touches viem).
 */
export interface RecErrorDecl {
  readonly value: object;
  readonly params: readonly { readonly name: string; readonly type: EvsType }[];
  readonly ir: PlainAbiError;
}

/** The rule a refused struct literal broke, and the way to leave members at zero on purpose. */
const STRUCT_LITERAL_RULE =
  'A struct literal names every member; to leave members at zero, build the struct with s.tuple(type, init)';

/** The `Recorder` base layer (see `builder/expr.ts` for the layer chain). */
export abstract class RecorderCore {
  /** `this` as the full engine: the layers are only ever instantiated as a `Recorder`, and the
   *  handles and internals they hand out are typed against it. */
  protected get self(): Recorder {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    return this as unknown as Recorder;
  }

  readonly name: string;

  protected readonly argsList: readonly { name: string; type: EvsType }[];

  protected readonly values: ValueInfo[] = [];

  private readonly valueScopes: Scope[] = [];

  /** logical values of word-const ValueIds (the folding domain) */
  protected readonly litValues = new Map<ValueId, bigint>();

  protected readonly cellInfos: CellInfo[] = [];

  private readonly cellScopes: Scope[] = [];

  protected readonly fnIrs: (FnIr | null)[] = [];

  protected readonly openFns = new Set<FnId>();

  protected readonly fnCtx: { name: string }[] = [];

  protected readonly mainScope: Scope;

  protected stack: Scope[];

  protected readonly savedStacks: Scope[][] = [];

  /** The body callbacks running right now: every open `s.if`, loop and `s.fn`, across
   *  {@link savedStacks} too (each one is a group of host stack frames inside the last). */
  private openBlocks = 0;

  private nextSite = 0;

  protected sealed = false;

  protected returnsList: { name: string; type: EvsType; value: ValueId }[] | null = null;

  protected returnToken: object | null = null;

  /** positional arg handles, spread into the body callback after `s` (a tuple arg → a Tuple). */
  private readonly argHandleList: readonly (Expr | object)[];

  /** declared custom errors (issue #15) — the `s.throw` allow-list, in declaration order. */
  protected readonly errorDecls: readonly RecErrorDecl[];

  constructor(
    name: string,
    args: readonly { name: string; type: EvsType }[],
    errors: readonly RecErrorDecl[] = [],
  ) {
    this.name = name;
    this.argsList = args;
    this.errorDecls = errors;
    this.mainScope = newScope('main');
    this.stack = [this.mainScope];
    // args bind positionally to ValueIds 0…n-1 (the only binding validate.ts admits); a tuple (NOT
    // a tuple ARRAY) arg yields a Tuple handle, a composite array / scalar an Expr.
    const handles: (Expr | object)[] = args.map((a) => {
      const id = this.newValue(a.type, `args.${a.name}`);
      return this.valueHandle(id, a.type);
    });
    this.argHandleList = Object.freeze(handles);
  }

  // -- handle support ---------------------------------------------------------------------

  argHandles(): readonly (Expr | object)[] {
    return this.argHandleList;
  }

  /** Wraps a ValueId in its handle: a tuple (NOT a tuple ARRAY) → a Tuple handle; else an Expr. */
  protected valueHandle(id: ValueId, type: EvsType): Expr | object {
    return isTupleType(type) && !isArrayValueType(type)
      ? makeTuple(this.self, id, type)
      : makeExpr(this.self, id);
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

  /** `Expr<type> #id ← debugName` — the non-throwing inspect string. */
  describeValue(id: ValueId): string {
    const info = this.values[id];
    if (info === undefined) return `Expr<?> #${id}`;
    const name = info.debugName !== undefined ? ` ← ${info.debugName}` : '';
    return `Expr<${stringifyType(info.type)}> #${id}${name}`;
  }

  /** `#id ← debugName` — names a Tuple / MutArray handle in error messages (no type: a tuple
   *  type would print as its full JSON descriptor). */
  valueRef(id: ValueId): string {
    const name = this.values[id]?.debugName;
    return name === undefined ? `#${id}` : `#${id} ← ${name}`;
  }

  /** `Cell<type> #id` — names a cell in error messages. */
  private describeCell(id: CellId): string {
    const info = this.cellInfos[id];
    return info === undefined ? `Cell<?> #${id}` : `Cell<${stringifyType(info.type)}> #${id}`;
  }

  assertOpen(what: string): void {
    if (!this.sealed) return;
    throw new EvsScopeError(
      'RECORDING_CLOSED',
      `${what}: script "${this.name}" is sealed — s.return(...) already ran; the builder and its handles cannot record anything afterwards`,
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

  appendStmt(body: StmtBody): void {
    this.top().stmts.push({ ...body, site: this.nextSite++ });
  }

  // -- internals --------------------------------------------------------------------------

  protected top(): Scope {
    const s = this.stack[this.stack.length - 1];
    if (s === undefined) {
      throw new EvsInternalError('INTERNAL', `scope stack underflow in script "${this.name}"`);
    }
    return s;
  }

  protected newValue(type: EvsType, debugName?: string): ValueId {
    const id = this.values.length;
    this.values.push(debugName === undefined ? { type } : { type, debugName });
    this.valueScopes.push(this.top());
    return id;
  }

  /**
   * Runs `fn` (a validation that records through the usual coercions) and then undoes everything
   * it recorded: the statements appended to the current block, the values it defined, the consts
   * it interned and the sites it used. Errors still propagate. Nothing it records may outlive it
   * (its ValueIds are gone), and it records into the current block only (it opens no scope).
   */
  protected withRollback<T>(fn: () => T): T {
    const scope = this.top();
    const stmts = scope.stmts.length;
    const consts = scope.consts.size;
    const values = this.values.length;
    const site = this.nextSite;
    try {
      return fn();
    } finally {
      scope.stmts.length = stmts;
      for (const key of [...scope.consts.keys()].slice(consts)) scope.consts.delete(key);
      for (let id = values; id < this.values.length; id++) this.litValues.delete(id);
      this.values.length = values;
      this.valueScopes.length = values;
      this.nextSite = site;
    }
  }

  /**
   * Opens one block level for the callbacks of `what` (`s.if()`, a loop, an `s.fn`), and must be
   * paired with {@link exitBlock}. Past {@link MAX_BLOCK_DEPTH} it throws before the callback
   * runs: each level nests the user's callback and the recorder's own frames on the host stack,
   * and every later pass recurses once per recorded block, so an unbounded script would end in a
   * stack overflow here or in `compile()`.
   */
  protected enterBlock(what: string): void {
    this.assertBlockRoom(what);
    this.openBlocks += 1;
  }

  /** {@link enterBlock}'s check alone, for a verb that records statements before it opens its
   *  block (`s.for`'s counter cell): it must fail before any of them is recorded. */
  protected assertBlockRoom(what: string): void {
    if (this.openBlocks >= MAX_BLOCK_DEPTH) {
      throw new EvsTypeError('UNSUPPORTED_V0', blockDepthMessage(what));
    }
  }

  protected exitBlock(): void {
    this.openBlocks -= 1;
  }

  protected pushScope(kind: ScopeKind): Scope {
    const s = newScope(kind);
    this.stack.push(s);
    return s;
  }

  protected popScope(): void {
    this.stack.pop();
  }

  /** Classifies an operand: a usable Expr of this recorder, or a raw host literal. */
  protected classify(v: unknown, what: string): Operand {
    if (typeof v === 'object' && v !== null) {
      const ei = EXPR_INTERNALS.get(v);
      if (ei !== undefined) {
        const id = this.handleId(ei, 'Expr', what);
        return { kind: 'expr', id, type: this.typeOfValue(id) };
      }
      if (CELL_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a Cell is not an Expr — read a snapshot with .get()`,
        );
      }
      if (ARR_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a MutArray is not an Expr — use .get(i) for an element or .expr() for the array memref`,
        );
      }
      if (TUPLE_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a Tuple is not an Expr — use .expr() for its memref, or pass it where a tuple is expected`,
        );
      }
      if (FIELD_INTERNALS.has(v)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a Field is not an Expr — read a snapshot with .get()`,
        );
      }
      // an Expr of another evs copy: a word-type tag AND the handle methods (a struct literal
      // with a member named `type` has no methods, so it stays a raw literal)
      if (!Array.isArray(v)) {
        const { type: tag, eq } = this.handleProbe(v, what);
        if (typeof tag === 'string' && isWordType(tag) && typeof eq === 'function') {
          throw new EvsScopeError(
            'FOREIGN_HANDLE',
            `${what}: value looks like an Expr handle but was not created by this copy of evs (forged object, or a duplicate @maxencerb/evs install)`,
          );
        }
      }
    }
    return { kind: 'raw', value: v };
  }

  /** The `type` and `eq` of an object that is no handle of this copy of evs, which tell an Expr of
   *  another copy from a literal. An object that inherits from a handle without being one (a
   *  `Proxy` around it, `Object.create(handle)`) runs the handle's own `type` getter, which refuses
   *  a receiver it does not know: that is reported as the operand it is, not as a `.type` read the
   *  user never wrote. */
  private handleProbe(v: object, what: string): { type?: unknown; eq?: unknown } {
    try {
      const { type, eq } = v as { type?: unknown; eq?: unknown };
      return { type, eq };
    } catch (e) {
      if (!(e instanceof EvsTypeError)) throw e;
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: this object stands in for an evs handle without being one (a Proxy around a handle, as a reactive store makes, or an object created from one) — pass the handle itself`,
      );
    }
  }

  /** Scope rule: a value is usable iff its defining scope is on the stack. */
  protected checkVisible(id: ValueId, what: string): void {
    const scope = this.valueScopes[id];
    if (scope === undefined) {
      throw new EvsInternalError('INTERNAL', `ValueId ${id} has no scope in "${this.name}"`);
    }
    if (this.stack.includes(scope)) return;
    const fn = this.fnCtx[this.fnCtx.length - 1];
    if (fn !== undefined && this.savedStacks.some((st) => st.includes(scope))) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `${what}: s.fn("${fn.name}") bodies cannot capture values from the enclosing script (captured ${this.describeValue(id)}) — pass them in as fn params instead`,
      );
    }
    throw new EvsScopeError(
      'SCOPE_VIOLATION',
      `${what}: this value (${this.describeValue(id)}) was recorded in a ${scope.kind} block that has finished recording — values escape blocks only through cells (s.let)`,
    );
  }

  private checkCellVisible(id: CellId, what: string): void {
    const scope = this.cellScopes[id];
    if (scope === undefined) {
      throw new EvsInternalError('INTERNAL', `CellId ${id} has no scope in "${this.name}"`);
    }
    if (this.stack.includes(scope)) return;
    const fn = this.fnCtx[this.fnCtx.length - 1];
    if (fn !== undefined && this.savedStacks.some((st) => st.includes(scope))) {
      throw new EvsScopeError(
        'SCOPE_VIOLATION',
        `${what}: s.fn("${fn.name}") bodies cannot capture cells from the enclosing script (captured ${this.describeCell(id)}) — pass values in as fn params instead`,
      );
    }
    throw new EvsScopeError(
      'SCOPE_VIOLATION',
      `${what}: this cell (${this.describeCell(id)}) was declared in a ${scope.kind} block that has finished recording — declare the cell outside the block instead`,
    );
  }

  protected typeMismatch(what: string, expected: EvsType, got: EvsType): never {
    let suggest = '';
    if (isNumeric(expected) && isNumeric(got)) {
      suggest = expected.startsWith('uint')
        ? ` — convert explicitly with .toUint('${expected}')`
        : ` — convert explicitly with .toInt('${expected}')`;
    }
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: expected '${stringifyType(expected)}', got Expr<'${stringifyType(got)}'>${suggest}`,
    );
  }

  /** Validates a word literal and returns its canonical hex + logical value (no stmt yet). */
  protected wordLiteral(type: WordType, value: unknown): { hex: Hex; logical: bigint } {
    const hex = encodeLiteralWord(type, value);
    return { hex, logical: logicalFromCanonical(type, hex) };
  }

  /** Finds an interned const by key across the open scope stack (top-down). */
  private lookupConst(key: string): ValueId | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const found = this.stack[i]?.consts.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Interns a canonical word const (dedup per (type, hex) across the open scope stack). */
  protected wordConst(type: WordType, logical: bigint, hex?: Hex): ValueId {
    const h = hex ?? canonicalHex(type, logical);
    const key = `w:${type}:${h}`;
    const found = this.lookupConst(key);
    if (found !== undefined) return found;
    const id = this.newValue(type);
    this.appendStmt({ k: 'const', out: id, data: { kind: 'word', hex: h }, type });
    this.litValues.set(id, logical);
    this.top().consts.set(key, id);
    return id;
  }

  /** Interns a dynamic literal as a pre-encoded memref data const. */
  private dataConst(type: DynType | ArrayType, value: unknown): ValueId {
    const hex = encodeLiteralData(type, value);
    const key = `d:${type}:${hex}`;
    const found = this.lookupConst(key);
    if (found !== undefined) return found;
    const id = this.newValue(type);
    this.appendStmt({ k: 'const', out: id, data: { kind: 'data', hex }, type });
    this.top().consts.set(key, id);
    return id;
  }

  /** Coerces an `IntoExpr` to a ValueId of exactly `type` (literal coercion rules). */
  protected coerceToId(v: unknown, type: EvsType, what: string): ValueId {
    // a tuple (NOT tuple-array) target: a Tuple handle (reuse its ValueId — reference) or a literal
    // struct object (build a fresh tuplenew). Routed before classify(), which rejects Tuple/Field
    // handles. A tuple ARRAY (`tuple[]`) is a memref Expr like any other array — it falls through to
    // the Expr path (where the encode milestone's guard fires for a returned/passed composite array).
    if (isTupleType(type) && !isArrayValueType(type)) return this.coerceTupleToId(v, type, what);
    // a bare MutArray handle is accepted where an ARRAY value is expected (issue #5 ask #5): reuse
    // its ValueId verbatim (reference) when the types match — byte-identical IR to passing
    // `.expr()`. Routed before classify(), which rejects MutArray handles with the "use .expr()"
    // message (kept intact for genuinely-wrong positions like arithmetic).
    if (isArrayValueType(type) && typeof v === 'object' && v !== null) {
      const ai = ARR_INTERNALS.get(v);
      if (ai !== undefined) {
        const id = this.handleId(ai, 'MutArray', what);
        const at = this.typeOfValue(id);
        if (!typesEqual(at, type)) this.typeMismatch(what, type, at);
        return id;
      }
    }
    const c = this.classify(v, what);
    if (c.kind === 'expr') {
      if (!typesEqual(c.type, type)) this.typeMismatch(what, type, c.type);
      return c.id;
    }
    if (isWordType(type)) {
      const { hex, logical } = this.wordLiteral(type, c.value);
      return this.wordConst(type, logical, hex);
    }
    if (this.isFlatLiteralOperand(c.value, type)) return this.dataConst(type, c.value);
    // every other memref literal is an array LITERAL built at record time as `arrnew` +
    // per-element construction — reusing the same lowerings as a constructed array (see
    // isFlatLiteralOperand for which ones)
    if (!isArrayValueType(type)) {
      // unreachable: tuples are routed above, string/bytes literals are always flat
      throw new EvsInternalError(
        'INTERNAL',
        `${what}: no literal route for '${stringifyType(type)}'`,
      );
    }
    if (isTupleType(type) && !isCompositeElemArray(type)) {
      // unreachable: every tuple-array type has a composite (tuple) element
      throw new EvsInternalError('INTERNAL', `${what}: tuple array with a word element`);
    }
    return this.buildArrayLiteral(type, c.value, what);
  }

  /**
   * Whether the host value `v`, coerced to the memref `type`, becomes ONE flat pre-encoded data
   * const (`dataConst`, a CODECOPY-materialized data segment). The single authority for that
   * route, shared by {@link coerceToId} and memref equality's record-time hash fold so the two
   * cannot diverge. True for a `string` / `bytes` target, and for a word-element array target
   * whose literal holds no staged handle. False for a staged handle itself (an Expr / Tuple /
   * MutArray / Field), for word and tuple targets, and for the array literals built element-wise
   * instead: a composite-element array (`tuple[]`, `uint256[][]`, `string[]` / `bytes[]`, any
   * `T[N]` over a composite element) or a word-element array mixing in a staged handle
   * (`[x, 1n]` with `x` an Expr). Only the route is decided here: a malformed value still fails in
   * `classify` / `dataConst`.
   */
  protected isFlatLiteralOperand(v: unknown, type: EvsType): type is DynType | ArrayType {
    if (typeof type !== 'string' || isWordType(type) || isStagedHandle(v)) return false;
    if (!isArrayValueType(type)) return true; // string / bytes
    return !isCompositeElemArray(type) && !(Array.isArray(v) && v.some(isStagedHandle));
  }

  /** Builds an array LITERAL element-wise at record time — a composite-element array
   *  (`tuple[]`/`T[][]`/`string[]`/`bytes[]`), a fixed-size `T[N]` over a composite element (whose
   *  literal must have exactly N elements), or a word array holding staged handles:
   *  `arrnew(elem, len)` then `arrset(i, coerceToId(value[i], elem))` per element — reusing the
   *  same IR lowerings as a runtime-constructed array. The result aliases a fresh `[len][p0…]`
   *  block. */
  private buildArrayLiteral(type: ArrayType | TupleType, value: unknown, what: string): ValueId {
    if (!Array.isArray(value)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: a ${stringifyType(type)} literal must be a JS array, got ${describeHost(value)}`,
      );
    }
    assertLayout(type, what);
    const elem = elemTypeOf(type);
    const fixed = fixedLengthOf(type);
    if (fixed !== null && value.length !== fixed) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: a ${stringifyType(type)} literal must have exactly ${fixed} element(s), got ${value.length}`,
      );
    }
    if (value.length > MAX_FIXED_LENGTH) {
      this.certainPanic(what, `literal length ${value.length} is ≥ 2^32`, 0x41);
    }
    // before anything is recorded: an element left out would keep the zero `arrnew` gives it
    const missing = missingElement(value);
    if (missing !== null) throw new EvsTypeError('TYPE_MISMATCH', `${what}${missing}`);
    const lenId = this.coerceToId(value.length, 'uint256', `${what} length`);
    const arrId = this.newValue(type, `${canonicalTypeSignature(type)} literal`);
    this.appendStmt({
      k: 'arrnew',
      elem,
      length: lenId,
      ...(fixed === null ? {} : { fixed }),
      out: arrId,
    });
    // by index: `forEach` skips the holes of a sparse array, which {@link missingElement} refused
    for (let i = 0; i < value.length; i++) {
      const valId = this.coerceToId(value[i], elem, `${what}[${i}]`);
      const iId = this.coerceToId(i, 'uint256', `${what}[${i}] index`);
      this.appendStmt({ k: 'arrset', arr: arrId, i: iId, value: valId });
    }
    return arrId;
  }

  /** Tuple branch of {@link coerceToId}: reuse a Tuple handle's ValueId, or build a
   *  `tuplenew` from a literal struct/positional object. */
  private coerceTupleToId(v: unknown, type: TupleType, what: string): ValueId {
    if (type.type !== 'tuple') {
      // unreachable: coerceToId routes every array type (tuple arrays included) to the array arm
      throw new EvsInternalError('INTERNAL', `${what}: tuple array reached the tuple coercion`);
    }
    if (typeof v === 'object' && v !== null) {
      const ti = TUPLE_INTERNALS.get(v);
      if (ti !== undefined) {
        const id = this.handleId(ti, 'Tuple', what);
        if (!typesEqual(ti.tt, type)) this.typeMismatch(what, type, ti.tt);
        return id; // reference: aliases the SAME flat block
      }
      // an Expr memref of the SAME tuple type (e.g. another tuple's `.expr()`) is also accepted.
      const ei = EXPR_INTERNALS.get(v);
      if (ei !== undefined) {
        const id = this.handleId(ei, 'Expr', what);
        const et = this.typeOfValue(id);
        if (!typesEqual(et, type)) this.typeMismatch(what, type, et);
        return id;
      }
    }
    // a plain object/array literal → build the tuple from its members (buildTupleNew rejects
    // the remaining handles: Cell, Field, MutArray).
    return this.buildTupleNew(type, v, what, `${canonicalTypeSignature(type)} literal`, {
      partial: false,
    });
  }

  /** The ValueId behind an Expr / Tuple / MutArray handle, after the owner check (handles never
   *  cross scripts: `FOREIGN_HANDLE`) and the visibility check ({@link checkVisible}). */
  private handleId(
    h: { readonly owner: Recorder; readonly id: ValueId },
    kind: 'Expr' | 'Tuple' | 'MutArray',
    what: string,
  ): ValueId {
    if (h.owner !== this.self) {
      // an Expr names its type; a Tuple's type would print as its full JSON descriptor
      const ref = kind === 'Expr' ? h.owner.describeValue(h.id) : h.owner.valueRef(h.id);
      throw new EvsScopeError(
        'FOREIGN_HANDLE',
        `${what}: this ${kind} (${ref}) belongs to script "${h.owner.name}" and cannot be used in script "${this.name}" — handles never cross scripts`,
      );
    }
    this.checkVisible(h.id, what);
    return h.id;
  }

  /** The ValueId behind a bare {@link Tuple} / {@link MutArray} handle (owner + visibility
   *  checked), or null when `v` is neither. A bare handle is returnable / passable where a memref
   *  is expected, byte-identical to its `.expr()` (issue #5 asks #1 and #5). */
  protected bareHandleId(v: unknown, what: string): ValueId | null {
    if (typeof v !== 'object' || v === null) return null;
    const ti = TUPLE_INTERNALS.get(v);
    if (ti !== undefined) return this.handleId(ti, 'Tuple', what);
    const ai = ARR_INTERNALS.get(v);
    if (ai !== undefined) return this.handleId(ai, 'MutArray', what);
    return null;
  }

  /** Rejects a staged handle where a tuple LITERAL is read (`s.tuple` init, a tuple slot whose
   *  value is not a same-typed Tuple/Expr): its properties are not members, so reading it as a
   *  record would silently build an all-zero tuple. A spread / `Object.assign` copy of a handle
   *  ({@link copiedHandle}) holds only the members written next to the spread, so it is rejected
   *  when it leaves one of `type`'s members out (that member would be zero-filled); a copy that
   *  names every member loses nothing and is read like any record. */
  private assertNotHandle(v: unknown, type: TupleType, what: string): void {
    if (typeof v !== 'object' || v === null) return;
    const fail = (hint: string): never => {
      throw new EvsTypeError('TYPE_MISMATCH', `${what}: ${hint}`);
    };
    if (CELL_INTERNALS.has(v)) fail('a Cell is not a tuple — read it with .get()');
    if (FIELD_INTERNALS.has(v)) fail('a Field is not a tuple — read it with .get()');
    if (ARR_INTERNALS.has(v)) fail('a MutArray is not a tuple — read an element with .get(i)');
    if (TUPLE_INTERNALS.has(v) || EXPR_INTERNALS.has(v)) {
      fail(
        'init must be a literal of members, not a handle — pass the handle itself where the tuple is expected',
      );
    }
    const src = copiedHandle(v);
    if (src === undefined) return;
    const positional = Array.isArray(v);
    const missing = type.components
      .map((c, i) => (positional ? String(i) : c.name))
      .filter((key) => !Object.hasOwn(v, key));
    if (missing.length === 0) return;
    const { kind } = describeCopiedHandle(src);
    fail(
      `init is a spread/Object.assign copy of ${kind} handle, which copies none of its members — ${missing.map((m) => JSON.stringify(m)).join(', ')} would be zero-filled. Name every member, reading each one with .get() (e.g. { a: x, b: p.b.get() })`,
    );
  }

  /** The ValueId of a position that takes a recorded value but no literal (`s.return`, an `s.fn`
   *  result, `s.encode` / `s.keccak256` values): an Expr, or a bare Tuple / MutArray handle (its
   *  memref, see {@link bareHandleId}). A host literal is a `TYPE_MISMATCH` reading
   *  `${what}: ${rawHint}`. */
  protected valueIdOf(v: unknown, what: string, rawHint: string): ValueId {
    const bare = this.bareHandleId(v, what);
    if (bare !== null) return bare;
    const c = this.classify(v, what);
    if (c.kind !== 'expr') throw new EvsTypeError('TYPE_MISMATCH', `${what}: ${rawHint}`);
    return c.id;
  }

  /** Lowers a tuple literal/init to a `tuplenew` (alloc + zero-fill + MSTORE provided members),
   *  returning the new tuple ValueId. The literal's shape follows abitype's rule
   *  ({@link allMembersNamed}): a record keyed by member name when every member is named, else a
   *  positional array; a key that names no member, or an element past the last member, is
   *  rejected. Members are read from OWN properties only.
   *
   *  `partial` says what a member without a value means. `true` is `s.tuple(type, init?)` alone,
   *  whose documented `init` is partial: an absent `init`, a member left out and a member set to
   *  `undefined` start at zero. `false` is a struct LITERAL, in every position that coerces one (a
   *  call arg, `s.lit`, `s.let`, `Cell.set`, `Field.set`, an array element, an `s.fn` arg, an
   *  `s.throw` arg, a nested member — of an `s.tuple` init too): it names every member with a
   *  value, as its type (`StructLiteral`) and overload resolution (`argFits`) require, so a missing
   *  one is an error here and not a zero sent to a contract.
   *
   *  A literal-zero WORD member is left to the zero-fill (no MSTORE); an omitted memref member
   *  gets its typed zero from codegen (`lowerTupleNew`). `debugName` is the builder origin that
   *  `LOOP_ALLOCATION` and the source map's site details quote: `s.tuple(<members>)` for an
   *  explicit `s.tuple`, `<type> literal` for a coerced struct literal, as for an array literal. */
  protected buildTupleNew(
    type: TupleType,
    init: unknown,
    what: string,
    debugName: string,
    { partial }: { readonly partial: boolean },
  ): ValueId {
    this.assertNotHandle(init, type, what);
    const named = allMembersNamed(type);
    const n = type.components.length;
    const names = type.components.map((c, i) => memberName(c, i));
    let lookup: (comp: NamedType, index: number) => unknown;
    if (init === undefined && partial) {
      lookup = () => undefined;
    } else if (Array.isArray(init)) {
      if (named) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: this struct expects a name-keyed ${partial ? 'init record' : `record ({ ${names.join(', ')} })`}, not a positional array`,
        );
      }
      if (init.length > n) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: too many members — this tuple has ${n}, got ${init.length}`,
        );
      }
      lookup = (_comp, index) => init[index];
    } else if (typeof init === 'object' && init !== null) {
      if (!named) {
        // a tuple with any unnamed member is positional, whatever its other members are called
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: a tuple with an unnamed member takes a positional array of its ${n} member(s) (${names.join(', ')}), not a record — abitype/viem's rule`,
        );
      }
      for (const key of Object.keys(init)) {
        if (!names.includes(key)) {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${what}: unknown member ${JSON.stringify(key)}${didYouMean(key, names)} (expected: ${names.join(', ')})`,
          );
        }
      }
      // own properties only: an omitted member named like an Object.prototype method
      // (`toString`, `constructor`, …) must read as absent, not as the inherited function
      lookup = (comp) =>
        Object.hasOwn(init, comp.name) ? Reflect.get(init, comp.name) : undefined;
    } else if (partial) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: init must be a record of members (or a positional array for a tuple with an unnamed member), got ${describeHost(init)}`,
      );
    } else {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: expected a struct value — ${named ? `a record { ${names.join(', ')} }` : `a positional array of its ${n} member(s)`} or a Tuple handle — got ${describeHost(init)}. ${STRUCT_LITERAL_RULE}`,
      );
    }

    const members = type.components.map((comp, index) => lookup(comp, index));
    if (!partial) {
      // before anything is recorded: a member without a value would be sent as its zero
      const missing = names.filter((_name, index) => members[index] === undefined);
      if (missing.length > 0) {
        const list = missing.map((m) => JSON.stringify(m)).join(', ');
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: the struct literal has no value for member${missing.length === 1 ? '' : 's'} ${list} (left out or undefined; members: ${names.join(', ')}). ${STRUCT_LITERAL_RULE}`,
        );
      }
    }

    const inits: { index: number; value: ValueId }[] = [];
    type.components.forEach((comp, index) => {
      const memberVal = members[index];
      // a partial init's omitted member → its typed zero: a word member is covered by the block's
      // zero-fill; a memref member (string/bytes/T[] → empty, nested tuple → a fresh zeroed block)
      // is set by codegen.
      if (memberVal === undefined) return;
      const memberType = abiParamToType(comp);
      const valId = this.coerceToId(
        memberVal,
        memberType,
        `${what} member "${memberName(comp, index)}"`,
      );
      // a literal-zero word member is already covered by the zero-fill — skip its MSTORE.
      if (!isMemrefType(memberType) && this.litValues.get(valId) === 0n) return;
      inits.push({ index, value: valId });
    });

    const out = this.newValue(type, debugName);
    this.appendStmt({ k: 'tuplenew', inits, out });
    return out;
  }

  protected certainPanic(what: string, reason: string, panic: number): never {
    throw new EvsTypeError(
      'CERTAIN_PANIC',
      `${what}: ${reason} — this would always revert with Panic(0x${panic.toString(16)}) at runtime, so recording refuses it. If a guaranteed runtime panic is intended, route one operand through a cell (s.let(t.uint256, x).get()) and use the result: a result nothing reads is dead code, and compile() drops it with its panic`,
    );
  }

  // -- values & state ---------------------------------------------------------------------

  lit(type: unknown, value: unknown): Expr | object {
    this.assertOpen('s.lit()');
    assertValueType(type, 's.lit()');
    if (isWordType(type)) {
      const { hex, logical } = this.wordLiteral(type, value);
      return makeExpr(this.self, this.wordConst(type, logical, hex));
    }
    // an array or struct literal takes the same route as a coerced one: composite elements (or
    // staged handles among the elements) and struct members build at record time; all-literal word
    // arrays use the const path. A fixed-size type enforces its exact length either way. A struct
    // comes back as a Tuple handle, like every other struct value.
    if (isArrayValueType(type) || isTupleType(type)) {
      return this.valueHandle(this.coerceToId(value, type, 's.lit()'), type);
    }
    return makeExpr(this.self, this.dataConst(type, value));
  }

  letCell(a: unknown, b: unknown): CellImpl {
    this.assertOpen('s.let()');
    // the overload is picked by arity: a type is a string OR a tuple descriptor object, so the
    // first argument's JS kind cannot tell `s.let(type, init)` from `s.let(initExpr)`.
    if (b !== undefined) {
      assertValueType(a, 's.let()');
      return new CellImpl(this.self, this.makeCell(a, b));
    }
    if (typeof a === 'string' || isTupleType(a)) {
      // a malformed type string keeps its "unknown type" diagnosis; only a valid type is missing
      // its init.
      assertValueType(a, 's.let()');
      throw new EvsTypeError('TYPE_MISMATCH', `s.let(type, init): init value is required`);
    }
    // a bare Tuple / MutArray handle gives its type like the Expr of its memref: a struct read
    // from a cell, a field or a call is a Tuple handle
    const bare = this.bareHandleId(a, 's.let()');
    if (bare !== null) return new CellImpl(this.self, this.makeCell(this.typeOfValue(bare), a));
    const c = this.classify(a, 's.let()');
    if (c.kind !== 'expr') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.let(init): init must be an Expr when no type is given — use s.let(type, literal) to type a literal`,
      );
    }
    return new CellImpl(this.self, this.makeCell(c.type, a));
  }

  protected makeCell(type: EvsType, init: unknown): CellId {
    const initId = this.coerceToId(init, type, 's.let() init');
    const cellId = this.cellInfos.length;
    this.cellInfos.push({ type });
    this.cellScopes.push(this.top());
    this.appendStmt({ k: 'cellnew', cell: cellId, init: initId });
    return cellId;
  }

  /** `Cell.get()`: a snapshot, in the handle {@link valueHandle} gives its type (a struct cell
   *  yields a Tuple handle). */
  cellGet(cellId: CellId, what: string): Expr | object {
    this.assertOpen(what);
    this.checkCellVisible(cellId, what);
    return this.valueHandle(this.cellGetId(cellId), this.typeOfCell(cellId));
  }

  protected cellGetId(cellId: CellId): ValueId {
    const out = this.newValue(this.typeOfCell(cellId));
    this.appendStmt({ k: 'cellget', cell: cellId, out });
    return out;
  }

  cellSet(cellId: CellId, value: unknown, what: string): void {
    this.assertOpen(what);
    this.checkCellVisible(cellId, what);
    const valId = this.coerceToId(value, this.typeOfCell(cellId), what);
    this.appendStmt({ k: 'cellset', cell: cellId, value: valId });
  }
}
