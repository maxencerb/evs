/**
 * `builder/expr/helpers.ts` — the recorder's scopes and small pure helpers: the `StmtBody`
 * statement shape (a `Stmt` before the recorder stamps its `site`), op tables, literal range /
 * canonical-word conversions, the layout-classifier error re-wrap (`assertLayout`), host-value
 * descriptions, and the constant folders
 * (`foldBin`, `foldModArith`).
 */

import { layoutOfType } from '../../abi/layout.js';
import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import { functionSignature } from '../../core/signature.js';
import {
  type WordType,
  bitsOf,
  isSigned,
  type Hex,
  type StringType,
  type NamedType,
  type ArrayType,
  type TupleType,
  isMemrefType,
  isEvsValueType,
  isTupleType,
  canonicalizeTupleType,
  describeRejectedType,
  elemTypeOf,
  type EvsType,
} from '../../core/types.js';
import type { Stmt, ValueId, BinOp, ModArithOp } from '../../ir/nodes.js';

// ---------------------------------------------------------------------------
// scopes
// ---------------------------------------------------------------------------

export type ScopeKind = 'main' | 'if-then' | 'if-else' | 'while-header' | 'while-body' | 'fn-body';

export interface Scope {
  readonly kind: ScopeKind;
  readonly stmts: Stmt[];
  /** per-scope `(kind:type:hex) → ValueId` const-dedup cache */
  readonly consts: Map<string, ValueId>;
}

export function newScope(kind: ScopeKind): Scope {
  return { kind, stmts: [], consts: new Map() };
}

/** `Omit` applied to each member of a union separately (a plain `Omit` merges the members). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A statement as a recorder layer builds it: one {@link Stmt} variant without its `site`, which
 *  `appendStmt` assigns. Distributive, so each literal is checked against its own variant. */
export type StmtBody = DistributiveOmit<Stmt, 'site'>;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export const CMP_OPS: ReadonlySet<BinOp> = new Set(['lt', 'gt', 'lte', 'gte', 'eq', 'neq']);
export const NUMERIC_OPS: ReadonlySet<BinOp> = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'pow',
  'wrapadd',
  'wrapsub',
  'wrapmul',
]);
/** The ordering comparisons: numeric operands, plus `address` / `bytesN` (unsigned words). */
export const ORDER_OPS: ReadonlySet<BinOp> = new Set(['lt', 'gt', 'lte', 'gte']);
export const BITS_OPS: ReadonlySet<BinOp> = new Set(['bitand', 'bitor', 'bitxor', 'shl', 'shr']);

/**
 * The single funnel for the recording engine's dynamic casts: every call site has just
 * runtime-validated the value's shape (the typed surface lives in `builder/script.ts`).
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a cast helper's T is its point
export function unsafeCast<T>(v: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see doc comment above
  return v as T;
}

export function isRecordObj(it: unknown): it is Record<string, unknown> {
  return typeof it === 'object' && it !== null;
}

/** logical-value range of a word type (intN signed; bytesN as its 8N-bit content). */
export function rangeOf(type: WordType): readonly [bigint, bigint] {
  if (type === 'bool') return [0n, 1n];
  const bits = BigInt(bitsOf(type));
  if (isSigned(type)) return [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
  return [0n, (1n << bits) - 1n];
}

/** canonical 32-byte slot image of a logical value. */
export function canonicalHex(type: WordType, logical: bigint): Hex {
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
export function logicalFromCanonical(type: WordType, hex: Hex): bigint {
  const x = BigInt(hex);
  if (isSigned(type)) return x >= 1n << 255n ? x - (1n << 256n) : x;
  if (type !== 'bool' && type !== 'address' && type.startsWith('bytes')) {
    return x >> (256n - BigInt(bitsOf(type)));
  }
  return x;
}

export function toUnsignedN(type: WordType, v: bigint): bigint {
  const mask = (1n << BigInt(bitsOf(type))) - 1n;
  return v & mask;
}

export function fromUnsignedN(type: WordType, u: bigint): bigint {
  if (!isSigned(type)) return u;
  const bits = BigInt(bitsOf(type));
  return u >> (bits - 1n) === 1n ? u - (1n << bits) : u;
}

/**
 * Validates a type string for the builder surface: anything outside the vocabulary gets
 * `TYPE_MISMATCH`, an array nested deeper than `MAX_ARRAY_DEPTH` gets `UNSUPPORTED_V0`
 * (classification mirrors `abi/layout.ts`).
 */
export function assertV0Type(type: unknown, what: string): asserts type is StringType {
  if (typeof type !== 'string') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: type must be a type string (use the \`t\` namespace), got ${describeHost(type)}`,
    );
  }
  assertLayout(type, what);
}

/**
 * Validates a type (or any type string) through the layout classifier (`abi/layout.ts`),
 * rethrowing its `EvsTypeError` under `what` with the same code: malformed or outside the
 * vocabulary → `TYPE_MISMATCH`, an array nested deeper than `MAX_ARRAY_DEPTH` → `UNSUPPORTED_V0`.
 */
export function assertLayout(type: TupleType | string, what: string): void {
  try {
    layoutOfType(type);
  } catch (e) {
    if (e instanceof EvsTypeError) {
      throw new EvsTypeError(e.code, `${what}: ${e.message.replace(/^layoutOf(Type)?: /, '')}`);
    }
    throw e;
  }
}

/**
 * Validates any value type for the builder surface (`s.lit`, `s.let`): a type string through
 * {@link assertV0Type} (same codes and messages), or a `t.struct` / `t.tuple` / tuple-array
 * descriptor — structurally valid, through the canonicalizer's gates ({@link assertTupleGates}),
 * then classified by its layout (an array nested deeper than `MAX_ARRAY_DEPTH` → `UNSUPPORTED_V0`).
 */
export function assertValueType(type: unknown, what: string): asserts type is EvsType {
  if (typeof type === 'string') {
    assertV0Type(type, what);
    return;
  }
  if (!isEvsValueType(type)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: type must be a \`t\` type (a type string or a t.struct/t.tuple descriptor), got ${describeRejectedHost(type)}`,
    );
  }
  assertTupleGates(type, what);
  assertLayout(type, what);
}

/**
 * The size gates of the one tuple canonicalizer (`canonicalizeTupleType`) for a descriptor the
 * builder records as given: at least one component at every level, the array depth, and the
 * static size of every tuple member — the enclosing type's size measures nothing once it is
 * ABI-dynamic, and the layout classifier does not look for empty tuples. They throw
 * `TYPE_MISMATCH` / `UNSUPPORTED_V0` under `what` while the script records, not as an internal
 * error from the IR validator at compile. A type string carries no tuple, so it passes; the
 * canonical copy is discarded (the recorded type stays the caller's object).
 */
export function assertTupleGates(type: EvsType, what: string): void {
  if (isTupleType(type)) canonicalizeTupleType(type, what);
}

/** {@link describeHost} for a value rejected as a type: a tuple descriptor with a bad member
 *  (a malformed one, or a repeated member name) is described by that member. */
export function describeRejectedHost(v: unknown): string {
  return isTupleType(v) && !isEvsValueType(v) ? describeRejectedType(v) : describeHost(v);
}

export function describeHost(v: unknown): string {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'function') return 'a function';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object' && v !== null) return 'an object';
  return String(v);
}

/**
 * Refuses what an async or a generator function returned where the builder ran a callback. A
 * callback runs once, synchronously, while the script records: an async one is recorded up to its
 * first `await` only (the rest would run after the block, or the script, was closed), and a
 * generator's body does not run at all. `what` names the callback. An async function's promise
 * is given a rejection handler: its continuation fails against the closed recording, and that
 * failure must not surface later as an unhandled rejection in place of this error. The `then` of
 * any other thenable is not called (it may start work of its own).
 */
export function assertSyncCallback(result: unknown, what: string): void {
  if ((typeof result !== 'object' && typeof result !== 'function') || result === null) return;
  const { then, next } = result as { then?: unknown; next?: unknown };
  if (typeof then === 'function') {
    if (result instanceof Promise) result.catch(() => undefined);
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: the callback returned a Promise (an async function) — callbacks run once, synchronously, while the script is recorded, so nothing after its first await would be recorded. Await your data before evscript() and use a plain function`,
    );
  }
  if (typeof next === 'function') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: the callback returned an iterator (a generator function) — callbacks run once, synchronously, while the script is recorded, and a generator's body does not run when it is called. Use a plain function`,
    );
  }
}

/**
 * The entry of `known` closest to `name` when it is close enough to be a typo of it (at most two
 * single-character edits, and fewer than the name is long), else undefined.
 */
function closestName(name: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.min(3, name.length);
  for (const candidate of known) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** The Levenshtein distance between `a` and `b`. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      next.push(Math.min(substitution, (row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/** ` — did you mean "x"?` for an unknown `name` that looks like a typo of a `known` one. */
export function didYouMean(name: string, known: readonly string[]): string {
  const closest = closestName(name, known);
  return closest === undefined ? '' : ` — did you mean ${JSON.stringify(closest)}?`;
}

/** The comma-joined canonical signatures of ABI function entries (overload error messages). */
export function signatureList(fns: readonly Record<string, unknown>[]): string {
  return fns.map(functionSignature).join(', ');
}

/** An ABI function entry's `inputs` (empty when malformed — validated after resolution). */
export function abiInputsOf(fn: Record<string, unknown>): readonly unknown[] {
  const inputs: unknown = fn['inputs'];
  return Array.isArray(inputs) ? inputs : [];
}

/** A tuple member's human-facing name (its struct field name, or `[i]` for a positional member). */
export function memberName(comp: NamedType, index: number): string {
  return comp.name === '' ? `[${index}]` : comp.name;
}

/**
 * The member `name` of a struct record, read as JavaScript reads `record[name]`: an own property,
 * or one found on its prototype chain (a class getter, a Svelte `$state` field, a Lit
 * `@property`, an `Object.create(proto)` record), with `record` as the getter's receiver. A name
 * found only on `Object.prototype` or `Function.prototype` (`toString`, `valueOf`, `__proto__`,
 * …) is no member: it reads as `undefined`, like a member left out. Neither is the `constructor`
 * of a prototype, which is its class (a class body cannot declare a `constructor` accessor), so
 * `constructor` counts only as an own property. The unknown-member checks list own keys, which a
 * getter on a prototype is not.
 */
export function readMember(record: object, name: string): unknown {
  for (let o: object | null = record; o !== null; o = Reflect.getPrototypeOf(o)) {
    if (o === Object.prototype || o === Function.prototype) return undefined;
    if (Object.hasOwn(o, name)) {
      return o !== record && name === 'constructor' ? undefined : Reflect.get(record, name);
    }
  }
  return undefined;
}

/**
 * A raw ABI param/component as a {@link NamedType}, its optional `name` normalized to `''` at
 * every depth. viem's `parseAbi` omits the key for an unnamed member (`(uint256 a, address)` →
 * `[{ name: 'a', … }, { type: 'address' }]`); abitype reads an absent name as unnamed, so the
 * runtime must too — {@link allMembersNamed} and `typesEqual` compare names against `''`. The
 * recorder reads raw (unvalidated) overload inputs through this; anything that is not a plain
 * `{ type: string }` param is left for the post-resolution validation to report.
 */
export function normalizeAbiParam(p: Readonly<Record<string, unknown>>): NamedType {
  const name = typeof p['name'] === 'string' ? p['name'] : '';
  const type = typeof p['type'] === 'string' ? p['type'] : '';
  const comps: unknown = p['components'];
  if (!Array.isArray(comps)) return { name, type };
  return {
    name,
    type,
    components: comps.map((c: unknown) =>
      isRecordObj(c) ? normalizeAbiParam(c) : { name: '', type: '' },
    ),
  };
}

/**
 * abitype's (and viem's) tuple-literal rule: a tuple's host literal is a record keyed by member
 * name only when EVERY member is named; a single unnamed member makes it a positional array.
 * `t` holds normalized components (`name: ''` for unnamed): a raw ABI's absent `name` must go
 * through {@link normalizeAbiParam} first, as abitype reads it as unnamed too. The interpreter's JS boundary (`ir/interp/coerce.ts`) applies the same rule, and the type-level
 * twin is `AllMembersNamed` (core/types/derive.ts).
 */
export function allMembersNamed(t: TupleType): boolean {
  return t.components.every((c) => c.name !== '');
}

/** True for an array type whose ELEMENT is composite/dynamic (a tuple, an inner array, or
 *  string/bytes) — i.e. an `array of pointers` : `tuple[]`, `uint256[][]`, `string[]`,
 *  `bytes[]`. A word-element array (`uint256[]`, `address[]`) is NOT composite. */
export function isCompositeElemArray(type: ArrayType | TupleType): boolean {
  return isMemrefType(elemTypeOf(type));
}

/** A short debug tag for a tuple value's `debugName` (field names, or the positional arity). */
export function tupleDebugTag(t: TupleType): string {
  return allMembersNamed(t)
    ? t.components.map((c) => c.name).join(', ')
    : `${t.components.length} members`;
}

/** A recording-time literal member index for `Tuple.at(i)` (the flat layout has no runtime member
 *  indexing — `i` must be a host number/bigint in `[0, n)`). */
export function asLiteralIndex(i: unknown, n: number, what: string): number {
  let idx: number;
  if (typeof i === 'number' && Number.isSafeInteger(i)) {
    idx = i;
  } else if (typeof i === 'bigint' && i >= 0n && i < BigInt(n)) {
    idx = Number(i);
  } else {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: the member index must be a literal number/bigint in [0, ${n}), got ${describeHost(i)}`,
    );
  }
  if (idx < 0 || idx >= n) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what}: member index ${idx} is out of range for a ${n}-member tuple`,
    );
  }
  return idx;
}

// ---------------------------------------------------------------------------
// classified operands + folding
// ---------------------------------------------------------------------------

export type Operand =
  | { kind: 'expr'; id: ValueId; type: EvsType }
  | { kind: 'raw'; value: unknown };

type Fold = { ok: true; value: bigint } | { ok: false; panic: number; reason: string };

export function foldBin(op: BinOp, type: WordType, a: bigint, b: bigint): Fold {
  switch (op) {
    case 'add':
    case 'sub':
    case 'mul': {
      const r = op === 'add' ? a + b : op === 'sub' ? a - b : a * b;
      const [min, max] = rangeOf(type);
      if (r < min || r > max) {
        const verb = op === 'sub' && !isSigned(type) ? 'underflows' : 'overflows';
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
    case 'pow': {
      // exact power + range check (solc checked `**`); b is the unsigned exponent
      if (b === 0n || a === 0n || a === 1n) return { ok: true, value: b === 0n ? 1n : a };
      if (a === -1n) return { ok: true, value: b % 2n === 0n ? 1n : -1n };
      const [min, max] = rangeOf(type);
      const r = b > 256n ? null : a ** b; // |a| ≥ 2 ⇒ out of range past 2^256 anyway
      if (r === null || r < min || r > max) {
        return { ok: false, panic: 0x11, reason: `${a} ** ${b} overflows ${type}` };
      }
      return { ok: true, value: r };
    }
    case 'wrapadd':
    case 'wrapsub':
    case 'wrapmul': {
      // two's complement wrap into the type's range: the low N bits, re-signed for intN
      const r = op === 'wrapadd' ? a + b : op === 'wrapsub' ? a - b : a * b;
      return { ok: true, value: fromUnsignedN(type, toUnsignedN(type, r)) };
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
      const ua = toUnsignedN(type, a);
      const ub = toUnsignedN(type, b);
      const r = op === 'bitand' ? ua & ub : op === 'bitor' ? ua | ub : ua ^ ub;
      return { ok: true, value: fromUnsignedN(type, r) };
    }
    case 'shl': {
      const sh = b > 256n ? 256n : b;
      const mask = (1n << BigInt(bitsOf(type))) - 1n;
      return { ok: true, value: fromUnsignedN(type, (toUnsignedN(type, a) << sh) & mask) };
    }
    case 'shr': {
      const sh = b > 256n ? 256n : b;
      // SAR for intN (arithmetic — bigint >> floors), logical SHR for uintN/bytesN
      return { ok: true, value: isSigned(type) ? a >> sh : toUnsignedN(type, a) >> sh };
    }
    default: {
      throw new EvsInternalError('INTERNAL', `foldBin: unknown op '${String(op)}'`);
    }
  }
}

const MAX_UINT256 = (1n << 256n) - 1n;

/** The builder-facing name of each ternary op (fold diagnostics). */
const MOD_ARITH_NAMES: Readonly<Record<ModArithOp, string>> = {
  addmod: 'addmod',
  mulmod: 'mulmod',
  muldiv: 'mulDiv',
  muldivup: 'mulDivRoundingUp',
};

/** Folds a ternary uint256 op (`addmod` / `mulmod` / `muldiv` / `muldivup`) on literal operands. */
export function foldModArith(op: ModArithOp, a: bigint, b: bigint, n: bigint): Fold {
  const name = MOD_ARITH_NAMES[op];
  if (n === 0n) {
    const verb = op === 'addmod' || op === 'mulmod' ? 'takes modulo zero' : 'divides by zero';
    return { ok: false, panic: 0x12, reason: `${name}(${a}, ${b}, 0) ${verb}` };
  }
  if (op === 'addmod') return { ok: true, value: (a + b) % n };
  if (op === 'mulmod') return { ok: true, value: (a * b) % n };
  const p = a * b;
  const q = op === 'muldiv' || p % n === 0n ? p / n : p / n + 1n;
  if (q > MAX_UINT256) {
    return { ok: false, panic: 0x11, reason: `${name}(${a}, ${b}, ${n}) overflows uint256` };
  }
  return { ok: true, value: q };
}
