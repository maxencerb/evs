/**
 * `core/types/predicates.ts` — runtime type predicates and metadata (word-type sets, array-suffix
 * parsing, dynamic / packed / array classification, ABI-param conversion) and the internal
 * helpers (`assertEvsType`, `installStagingTraps`, …).
 */

import { EvsTypeError, EvsStagingError } from '../errors.js';
import type {
  StringType,
  TupleType,
  EvsType,
  WordType,
  ArrayType,
  NumericType,
  NamedType,
} from './vocabulary.js';

const UINT_BITS_LIST: readonly number[] = Array.from({ length: 32 }, (_, i) => 8 * (i + 1));

const BYTES_SIZE_LIST: readonly number[] = Array.from({ length: 32 }, (_, i) => i + 1);

function buildWordTypeSets(): {
  word: ReadonlySet<string>;
  numeric: ReadonlySet<string>;
  signed: ReadonlySet<string>;
  bits: ReadonlyMap<string, number>;
} {
  const word = new Set<string>(['address', 'bool']);
  const numeric = new Set<string>();
  const signed = new Set<string>();
  const bits = new Map<string, number>([
    ['address', 160],
    ['bool', 8], // canonical 0/1
  ]);
  for (const n of UINT_BITS_LIST) {
    word.add(`uint${n}`).add(`int${n}`);
    numeric.add(`uint${n}`).add(`int${n}`);
    signed.add(`int${n}`);
    bits.set(`uint${n}`, n);
    bits.set(`int${n}`, n);
  }
  for (const n of BYTES_SIZE_LIST) {
    word.add(`bytes${n}`);
    bits.set(`bytes${n}`, 8 * n);
  }
  return { word, numeric, signed, bits };
}

const SETS = buildWordTypeSets();

// ---------------------------------------------------------------------------
// runtime type predicates / metadata
// ---------------------------------------------------------------------------

// The trailing array suffix of a type string: `[]` (dynamic) or `[N]` (fixed, N ≥ 1 with no
// leading zero). Greedy `(.*)` anchors the match at the LAST suffix, so the inner type keeps its
// own suffix chain (`uint256[2][]` → inner `uint256[2]`, size `[]`).
const ARRAY_SUFFIX_RE = /^(.*)\[([1-9]\d*)?\]$/;
/** A tuple tag: `tuple` followed by zero or more `[]`/`[N]` suffixes. */
const TUPLE_TAG_RE = /^tuple(?:\[(?:[1-9]\d*)?\])*$/;
/** Fixed-size arrays at or above this length cannot be allocated (`arrnew` Panics 0x41 there),
 *  so the vocabulary rejects them outright rather than admitting an unconstructible type. */
export const MAX_FIXED_LENGTH = 0xffffffff;

/**
 * The deepest array nesting evs compiles: at most this many `[]`/`[N]` suffixes on one type
 * (`uint256[][][][]`, `tuple[2][][][]`). Every array level adds live words to the operand stack
 * of the decode templates (one per heap-frame level, five per stack fast-path level — see
 * `codegen/abi.ts`), and the 16-item template budget has to hold them inside tuple members and
 * call-output decodes too, so deeper chains stay `UNSUPPORTED_V0` at every layer (`t.array`,
 * type-string validation, `abi/layout`, `abi/artifact`, `ir/validate`).
 */
export const MAX_ARRAY_DEPTH = 4;

/**
 * Splits one trailing array suffix off a type string: `'uint256[]'` → `{ inner: 'uint256',
 * length: null }`, `'uint256[3][]'` → `{ inner: 'uint256[3]', length: null }`, `'address[2]'` →
 * `{ inner: 'address', length: 2 }`. `null` when `s` has no well-formed trailing suffix (a bare
 * type, or a malformed suffix such as `[0]`/`[01]`/`[x]`). Works on tuple tags too.
 */
export function peelArraySuffix(s: string): { inner: string; length: number | null } | null {
  const m = ARRAY_SUFFIX_RE.exec(s);
  if (m === null) return null;
  const inner = m[1] ?? '';
  const digits = m[2];
  if (digits === undefined) return { inner, length: null };
  const length = Number(digits);
  if (!Number.isSafeInteger(length) || length > MAX_FIXED_LENGTH) return null;
  return { inner, length };
}

/** The number of array suffixes on a (well-formed) type string or tuple tag:
 *  `'uint256'` → 0, `'uint256[2][]'` → 2, `'tuple[][]'` → 2. */
export function arrayDepthOf(s: string): number {
  let depth = 0;
  let cur = s;
  for (let peeled = peelArraySuffix(cur); peeled !== null; peeled = peelArraySuffix(cur)) {
    depth += 1;
    cur = peeled.inner;
  }
  return depth;
}

/**
 * The narrowed #4 gate: throws `UNSUPPORTED_V0` when `s` (a type string or tuple tag) nests
 * arrays deeper than {@link MAX_ARRAY_DEPTH}. Shared by every layer that admits array types so
 * the runtime vocabulary and the codegen budget agree.
 */
export function assertArrayDepth(s: string, context: string): void {
  const depth = arrayDepthOf(s);
  if (depth > MAX_ARRAY_DEPTH) {
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      `${context}: type ${JSON.stringify(s)} nests arrays ${depth} levels deep — at most ${MAX_ARRAY_DEPTH} levels are supported`,
    );
  }
}

/**
 * String type validity: a word, `string`/`bytes`, or an array of such with dynamic (`[]`) or
 * fixed-size (`[N]`) suffixes. Structural only — the depth ceiling ({@link MAX_ARRAY_DEPTH}) is
 * enforced separately with `UNSUPPORTED_V0`. Tuples are objects — see {@link isEvsValueType}.
 */
export function isEvsType(s: string): s is StringType {
  if (isWordType(s) || s === 'string' || s === 'bytes') return true;
  const peeled = peelArraySuffix(s);
  return peeled !== null && isEvsType(peeled.inner);
}

/** A well-formed tuple tag (`'tuple'`, `'tuple[]'`, `'tuple[2]'`, `'tuple[][3]'`, …). */
export function isTupleTag(s: string): s is TupleType['type'] {
  if (!TUPLE_TAG_RE.test(s)) return false;
  // re-walk the suffix chain through `peelArraySuffix` so oversized fixed lengths are rejected
  let cur = s;
  while (cur !== 'tuple') {
    const peeled = peelArraySuffix(cur);
    if (peeled === null) return false;
    cur = peeled.inner;
  }
  return true;
}

/** A composite (tuple/struct) type descriptor — the only non-string {@link EvsType}. */
export function isTupleType(v: unknown): v is TupleType {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as { type?: unknown; components?: unknown };
  return typeof o.type === 'string' && isTupleTag(o.type) && Array.isArray(o.components);
}

/** Any valid {@link EvsType} value (string-encoded or a tuple descriptor). */
export function isEvsValueType(v: unknown): v is EvsType {
  return (
    (typeof v === 'string' && isEvsType(v)) || (isTupleType(v) && componentsValid(v.components))
  );
}

function componentsValid(components: readonly unknown[]): boolean {
  return components.every((c) => {
    if (typeof c !== 'object' || c === null) return false;
    const o = c as { name?: unknown; type?: unknown; components?: unknown };
    if (typeof o.name !== 'string' || typeof o.type !== 'string') return false;
    if (o.type.startsWith('tuple')) {
      return isTupleTag(o.type) && Array.isArray(o.components) && componentsValid(o.components);
    }
    return isEvsType(o.type) && o.components === undefined;
  });
}

export function isWordType(s: string | TupleType): s is WordType {
  return typeof s === 'string' && SETS.word.has(s);
}

/** bitwise/shift operand domain: uintN, intN, bytesN. */
export function isBitsOperand(s: EvsType): s is WordType {
  return isWordType(s) && s !== 'address' && s !== 'bool';
}

/** The array type whose element is `elem` — dynamic (`fixed` omitted/`null`) or fixed-size: a
 *  string element yields `${elem}[]`/`${elem}[N]`; a tuple descriptor (plain or itself a tuple
 *  array) yields the {@link TupleType} with the suffix appended to its tag. Callers pass an
 *  already-validated element type (the result is further classified by `layoutOfType`). */
export function arrayTypeOf(elem: EvsType, fixed: number | null = null): ArrayType | TupleType {
  const suffix = fixed === null ? '[]' : `[${fixed}]`;
  if (typeof elem === 'string') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- elem is a validated StringType; `${elem}${suffix}` is a valid ArrayType (further classified by layoutOfType).
    return `${elem}${suffix}` as ArrayType;
  }
  return Object.freeze({ type: tupleArrayTag(elem.type, fixed), components: elem.components });
}

/** Human-readable rendering of a value type for error messages (a tuple → its JSON descriptor). */
export function stringifyType(type: EvsType): string {
  return typeof type === 'string' ? type : JSON.stringify(type);
}

export function isNumeric(s: EvsType): s is NumericType {
  return typeof s === 'string' && SETS.numeric.has(s);
}

/** `intN` → true; every other evs type (incl. `intN[]`, tuples) → false. */
export function isSigned(s: EvsType): boolean {
  return typeof s === 'string' && SETS.signed.has(s);
}

/** address→160, bool→8 (canonical 0/1), bytesN→8N, uintN/intN→N. */
export function bitsOf(s: WordType): number {
  const bits = SETS.bits.get(s);
  if (bits === undefined) {
    throw new EvsTypeError('TYPE_MISMATCH', `bitsOf: ${JSON.stringify(s)} is not a word type`);
  }
  return bits;
}

/** Memref-valued (not a single stack word): string | bytes | any array (`T[]`/`T[N]`) | tuple. */
export function isDynamicType(s: EvsType): boolean {
  if (typeof s !== 'string') return true; // tuples are always memref pointers
  return s === 'string' || s === 'bytes' || s.endsWith(']');
}

/**
 * True when `abi.encodePacked` accepts a value of this type (issue #17): a word, `string`/`bytes`,
 * or a word-element array — dynamic `T[]` or fixed `T[N]` — whose elements pack padded to 32
 * bytes, per the Solidity spec. Everything Solidity rejects in packed mode — structs, nested
 * arrays, arrays of dynamic elements — is false here; `s.encode` (standard ABI) handles those.
 */
export function isPackedEncodable(s: EvsType): boolean {
  if (typeof s !== 'string') return false; // tuple / tuple[] descriptors
  if (isWordType(s) || s === 'string' || s === 'bytes') return true;
  const peeled = peelArraySuffix(s);
  return peeled !== null && isWordType(peeled.inner);
}

/** An array type — dynamic `T[]` or fixed-size `T[N]`, string array or tuple array. */
export function isArrayValueType(s: EvsType): s is ArrayType | TupleType {
  return typeof s === 'string' ? s.endsWith(']') : s.type !== 'tuple';
}

/** The fixed length `N` of an array type `T[N]`, or `null` for a dynamic `T[]`. Throws for a
 *  non-array type. Only the OUTERMOST suffix is consulted (`uint256[2][]` → `null`). */
export function fixedLengthOf(s: ArrayType | TupleType): number | null {
  const peeled = peelArraySuffix(typeof s === 'string' ? s : s.type);
  if (peeled === null) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `fixedLengthOf: ${typeof s === 'string' ? JSON.stringify(s) : 'a tuple'} is not an array type`,
    );
  }
  return peeled.length;
}

/** The element type of an array type: the outermost suffix peeled off (string arrays), or the
 *  element tuple / tuple-array descriptor with the same components (tuple arrays). */
export function elemTypeOf(s: ArrayType | TupleType): EvsType {
  if (typeof s === 'string') {
    const peeled = peelArraySuffix(s);
    if (peeled !== null && isEvsType(peeled.inner)) return peeled.inner;
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `elemTypeOf: ${JSON.stringify(s)} is not an array type`,
    );
  }
  const peeled = peelArraySuffix(s.type);
  if (s.type === 'tuple' || peeled === null || !isTupleTag(peeled.inner)) {
    throw new EvsTypeError('TYPE_MISMATCH', `elemTypeOf: a tuple is not an array type`);
  }
  // 'tuple[]' → 'tuple', 'tuple[][]' → 'tuple[]', 'tuple[3][]' → 'tuple[3]'
  return Object.freeze({ type: peeled.inner, components: s.components });
}

/** Structural equality of two value types — deep for tuples, `===` for string types. Tuple
 *  descriptors are fresh objects (never reference-equal), so callers must use this, not `===`. */
export function typesEqual(a: EvsType, b: EvsType): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.type !== b.type || a.components.length !== b.components.length) return false;
  return a.components.every((ca, i) => {
    const cb = b.components[i];
    return (
      cb !== undefined && ca.name === cb.name && typesEqual(abiParamToType(ca), abiParamToType(cb))
    );
  });
}

/** A {@link NamedType} / IR `PlainAbiParam` → its {@link EvsType} (a string, or a TupleType when
 *  the param carries `components`). */
export function abiParamToType(p: { type: string; components?: readonly NamedType[] }): EvsType {
  if (p.type.startsWith('tuple') && p.components !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded by startsWith('tuple') + components present
    return { type: p.type as TupleType['type'], components: p.components };
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- non-tuple PlainAbiParam types are string-encoded EvsTypes
  return p.type as EvsType;
}

/** An {@link EvsType} → an abitype param/component with `name`. Inverse of {@link abiParamToType}. */
export function typeToAbiParam(name: string, ty: EvsType): NamedType {
  if (typeof ty === 'string') return Object.freeze({ name, type: ty });
  return Object.freeze({ name, type: ty.type, components: ty.components });
}

export function describeTypeInput(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'bigint') return `${v}n`;
  return JSON.stringify(v);
}

/** The tuple-array tag one suffix deeper than `tag`: `('tuple', null)` → `'tuple[]'`,
 *  `('tuple[]', 2)` → `'tuple[][2]'`. The one place the tag string is rebuilt (shared by the
 *  builder and the validator so the IR/type tags never drift). */
export function tupleArrayTag(tag: TupleType['type'], fixed: number | null): TupleType['type'] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- appending a well-formed `[]`/`[N]` suffix to a tuple tag yields a tuple tag
  return `${tag}${fixed === null ? '[]' : `[${fixed}]`}` as TupleType['type'];
}

// ---------------------------------------------------------------------------
// internal helpers (module-private to evs; not part of the public surface)
// ---------------------------------------------------------------------------

/**
 * Why a type string is NOT a {@link StringType}, for the `TYPE_MISMATCH` message: a tuple written
 * as a string (tuples are descriptor objects), a malformed fixed-size suffix (`[0]`, `[01]`,
 * `[x]`, or ≥ 2^32), or an unknown leaf. Exported for the layout/builder mirrors so every entry
 * point explains a rejection the same way.
 */
export function explainBadTypeString(s: string): string {
  if (s === 'tuple' || s.startsWith('tuple')) {
    return `a tuple type must be a \`t.struct\`/\`t.tuple\` descriptor (or a raw AbiParameter[]), not the string ${JSON.stringify(s)}`;
  }
  // walk the suffix chain inward: the first suffix that does not parse is the malformed one
  let cur = s;
  while (/\[[^\]]*\]$/.test(cur)) {
    const peeled = peelArraySuffix(cur);
    if (peeled === null) {
      return `malformed array suffix in ${JSON.stringify(s)} — a fixed-size array length must be a positive integer below 2^32 with no leading zero (\`T[3]\`), or empty for a dynamic array (\`T[]\`)`;
    }
    cur = peeled.inner;
  }
  return `unknown type ${JSON.stringify(s)} (expected uintN/intN/address/bool/bytesN, string, bytes, an array \`T[]\`/\`T[N]\` of those, or a \`t.struct\`/\`t.tuple\`)`;
}

/**
 * Eager type-string validation: `TYPE_MISMATCH` for anything outside the vocabulary (see
 * {@link explainBadTypeString}), `UNSUPPORTED_V0` for a well-formed array nested deeper than
 * {@link MAX_ARRAY_DEPTH}.
 */
export function assertEvsType(s: string, context: string): asserts s is StringType {
  if (!isEvsType(s)) {
    throw new EvsTypeError('TYPE_MISMATCH', `${context}: ${explainBadTypeString(s)}`);
  }
  assertArrayDepth(s, context);
}

/**
 * @internal Staging-misuse traps shared by every handle implementation.
 *
 * Installs throwing `valueOf` / `toString` / `toJSON` / `Symbol.toPrimitive` on `target`
 * (each throws `EvsStagingError` naming the misused handle), plus a NON-throwing
 * `nodejs.util.inspect.custom` returning the handle's description — printing is debugging, not
 * misuse. `target` is normally a handle class's PROTOTYPE (installed once, not per handle), so
 * the traps receive the handle as `this` and `describe` resolves it; `describe` must tolerate a
 * detached call (`this` not a handle).
 */
export function installStagingTraps(target: object, describe: (handle: unknown) => string): void {
  const explode = (handle: unknown, operation: string): never => {
    throw new EvsStagingError(
      'STAGING_MISUSE',
      `${operation} on a staged handle (${describe(handle)}): evs handles are recorded program values, not host values — use the builder ops (s.add, .eq, s.if, …) instead`,
    );
  };
  const trap = (operation: string): PropertyDescriptor => ({
    value(this: unknown): never {
      return explode(this, operation);
    },
    enumerable: false,
  });
  Object.defineProperties(target, {
    valueOf: trap('valueOf()'),
    toString: trap('toString()'),
    toJSON: trap('toJSON() / JSON.stringify'),
    [Symbol.toPrimitive]: trap('primitive coercion (Symbol.toPrimitive)'),
    [Symbol.for('nodejs.util.inspect.custom')]: {
      value(this: unknown): string {
        return describe(this);
      },
      enumerable: false,
    },
  });
}
