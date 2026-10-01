/**
 * `abi/layout.ts` — type layouts over evs ABI type strings / `PlainAbiParam` trees.
 *
 * Implements the memory model (canonical word invariant) and the ABI head/tail shapes for the
 * whole evs type vocabulary: words, `string`/`bytes`, (nested) tuples, and arrays over any
 * element — dynamic `T[]` and fixed-size `T[N]` alike (`uint256[2]`, `tuple[][]`, `string[][]`,
 * `uint256[][][]`, `address[3][]`, …) — up to `MAX_ARRAY_DEPTH` suffixes; deeper chains, and
 * ABI-static types larger than `MAX_STATIC_SIZE` bytes, are rejected with `UNSUPPORTED_V0`. A raw
 * `'tuple…'` type STRING is rejected with `TYPE_MISMATCH` (tuples are descriptor objects, see
 * {@link layoutOfType}).
 *
 * Fixed-size arrays: in MEMORY a `T[N]` is laid out exactly like a `T[]` — a length-prefixed
 * `[N][slot0 … slot_{N-1}]` block (inline words for a word element, pointers otherwise) whose
 * length word always equals `N` — so every runtime op (`.length`, `.at`, `forEach`, `arrset`,
 * cells, fn params) reuses the dynamic-array machinery unchanged. Only the ABI codec differs:
 * `T[N]` has NO length word on the wire, it is ABI-static when `T` is static (`N · staticSize(T)`
 * bytes inlined into the head, like a static tuple) and ABI-dynamic when `T` is dynamic
 * (offset-pointer head, tail = `N` offset words relative to the array block start + the element
 * tails — `enc((T,…,T))` per the spec).
 */

import { EvsInternalError, EvsTypeError } from '../core/errors.js';
import {
  abiParamToType,
  assertArrayDepth,
  bitsOf,
  explainBadTypeString,
  isEvsType,
  isSigned,
  isTupleTag,
  isTupleType,
  isWordType,
  MAX_STATIC_SIZE,
  peelArraySuffix,
  quoteTypeString,
  staticSizeMessage,
  type EvsType,
  type TupleType,
  type WordType,
} from '../core/types.js';
import type { PlainAbiParam } from '../ir/nodes.js';

type WordLayout = {
  kind: 'word';
  abi: WordType;
  bits: number;
  signed: boolean;
  leftAligned: boolean;
};

export type TypeLayout =
  | WordLayout
  | { kind: 'bytes'; abi: 'bytes' | 'string' }
  // an array `E[]` (`length: null`) or `E[N]` (`length: N`): in memory `[len][p0]…[p_{len-1}]`
  // where each slot is an inline word (word element) OR a memref pointer to the element's block
  // (composite/dynamic element); `len === N` always for a fixed-size array. `elem` is any
  // {@link TypeLayout} — arrays nest (up to `MAX_ARRAY_DEPTH`). ABI-static iff fixed-size with a
  // static element (see {@link isDynamic}); codegen dispatches on `elem.kind`/`length` before
  // assuming the flat word-element `T[]` shape.
  | { kind: 'array'; abi: string; elem: TypeLayout; length: number | null }
  // a tuple/struct: a flat block of `components.length` words, dynamic iff any component is.
  // `components` are the member layouts in declaration order; `abi` carries the tuple tag
  // (`'tuple'`; a `tuple[]`/`tuple[N]` is an `array` layout whose `elem` is this). Built via
  // `layoutOfType`, which is the only entry that handles the {@link TupleType} descriptor object.
  | { kind: 'tuple'; abi: string; components: TypeLayout[]; dynamic: boolean };

function wordLayoutOf(abi: WordType): WordLayout {
  return {
    kind: 'word',
    abi,
    bits: bitsOf(abi),
    signed: isSigned(abi),
    // bytesN is the only left-aligned word class; address/bool/uintN/intN are right-aligned
    leftAligned: abi.startsWith('bytes'),
  };
}

/** `TYPE_MISMATCH` for anything that is not a type string of the vocabulary — a tuple written as a
 *  string, a malformed array suffix, or an unknown leaf (classification shared with `core/types`). */
function badTypeError(abiType: string): EvsTypeError {
  return new EvsTypeError('TYPE_MISMATCH', `layoutOf: ${explainBadTypeString(abiType)}`);
}

/** Layout of a string-encoded type (word, `string`/`bytes`, or an array of those — dynamic or
 *  fixed-size). Throws `EvsTypeError`: `TYPE_MISMATCH` for a tuple STRING or junk,
 *  `UNSUPPORTED_V0` for arrays nested deeper than `MAX_ARRAY_DEPTH` or a static size past
 *  `MAX_STATIC_SIZE` bytes. */
export function layoutOf(abiType: string): TypeLayout {
  const hit = layoutByString.get(abiType);
  if (hit !== undefined) return hit;
  const layout = computeLayoutOf(abiType);
  layoutByString.set(abiType, layout);
  return layout;
}

// Layouts are pure functions of the type and treated as immutable by every consumer, so they
// memoize safely: string types through a Map (the vocabulary is small), tuple descriptors
// through a WeakMap keyed on the descriptor object (stable identity inside one IR).
const layoutByString = new Map<string, TypeLayout>();
const layoutByTuple = new WeakMap<TupleType, TypeLayout>();

function computeLayoutOf(abiType: string): TypeLayout {
  if (isWordType(abiType)) return wordLayoutOf(abiType);
  if (abiType === 'bytes' || abiType === 'string') return { kind: 'bytes', abi: abiType };
  // the whole string is validated BEFORE recursing, so a hostile suffix chain never recurses
  // once per suffix: a malformed leaf (or a tuple string) is TYPE_MISMATCH for the OUTER string,
  // then the narrowed #4 gate — arrays nest at most MAX_ARRAY_DEPTH levels
  const peeled = peelArraySuffix(abiType);
  if (peeled === null || !isEvsType(abiType)) throw badTypeError(abiType);
  assertArrayDepth(abiType, 'layoutOf');
  // recurse on the element — `layoutOf` (not `computeLayoutOf`) so inner types memoize too
  const elem = layoutOf(peeled.inner);
  return assertLayoutSize(
    { kind: 'array', abi: abiType, elem, length: peeled.length },
    abiType,
    'layoutOf',
  );
}

/**
 * The `MAX_STATIC_SIZE` gate on a freshly built layout: an ABI-static layout whose size reaches
 * 2^32 bytes is `UNSUPPORTED_V0` (codegen pushes static sizes as immediates, which must stay
 * exact). Its members were gated when they were built, so `staticSize` is exact up to this
 * level's own product or sum; a size past 2^53 prints rounded, which only the message sees.
 */
function assertLayoutSize<L extends TypeLayout>(layout: L, type: string, context: string): L {
  if (isDynamic(layout)) return layout;
  const size = staticSize(layout);
  if (size > MAX_STATIC_SIZE) {
    throw new EvsTypeError('UNSUPPORTED_V0', staticSizeMessage(context, type, size));
  }
  return layout;
}

/**
 * Layout of any {@link EvsType}: a {@link TupleType} descriptor → a `tuple` layout (recursing
 * over its components via `abiParamToType`), or — for an array tag (`'tuple[]'`, `'tuple[2]'`,
 * `'tuple[][]'`, …) — an `array` layout over the one-suffix-peeled descriptor; a string type →
 * the string-keyed `layoutOf`. A tuple is `dynamic` iff any component layout is dynamic.
 * Component arrays go through `layoutOf` and share its rules (a tag nested deeper than
 * `MAX_ARRAY_DEPTH` is `UNSUPPORTED_V0`, a malformed tag `TYPE_MISMATCH`).
 */
export function layoutOfType(t: EvsType): TypeLayout {
  if (typeof t === 'string') return layoutOf(t);
  if (!isTupleType(t)) {
    // a descriptor object with a malformed tag (`tuple[0]`) or shape
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `layoutOfType: malformed tuple descriptor (type ${JSON.stringify((t as { type?: unknown }).type)})`,
    );
  }
  const hit = layoutByTuple.get(t);
  if (hit !== undefined) return hit;
  const layout = computeTupleLayout(t);
  layoutByTuple.set(t, layout);
  return layout;
}

function computeTupleLayout(t: TupleType): TypeLayout {
  if (t.type === 'tuple') return tupleLayoutOf(t);
  const peeled = peelArraySuffix(t.type);
  if (peeled === null || !isTupleTag(peeled.inner)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `layoutOfType: malformed tuple tag ${quoteTypeString(t.type)}`,
    );
  }
  // the narrowed #4 gate: tuple arrays nest at most MAX_ARRAY_DEPTH levels
  assertArrayDepth(t.type, 'layoutOfType');
  const elem = layoutOfType({ type: peeled.inner, components: t.components });
  return assertLayoutSize(
    { kind: 'array', abi: t.type, elem, length: peeled.length },
    t.type,
    'layoutOfType',
  );
}

function tupleLayoutOf(t: TupleType): Extract<TypeLayout, { kind: 'tuple' }> {
  const components = t.components.map((c) => layoutOfType(abiParamToType(c)));
  return assertLayoutSize(
    { kind: 'tuple', abi: t.type, components, dynamic: components.some(isDynamic) },
    t.type,
    'layoutOfType',
  );
}

/** ABI-dynamic (offset-pointer head + appended tail): `string`/`bytes`, any `T[]`, a `T[N]` whose
 *  element is dynamic, and a tuple with a dynamic member. Static: words, `T[N]` over a static
 *  element, and all-static tuples — those inline into the head. */
export function isDynamic(l: TypeLayout): boolean {
  switch (l.kind) {
    case 'word':
      return false;
    case 'bytes':
      return true;
    case 'array':
      return l.length === null || isDynamic(l.elem);
    default:
      return l.dynamic;
  }
}

/**
 * Static (head-inlined) byte size of `l`: `32` for a word, the components' sizes summed for a
 * STATIC tuple, `N · staticSize(elem)` for a static fixed-size array. Used by the head walk and
 * the array element loops (a static element `E` inlines `staticSize(E)` bytes per slot). A
 * dynamic layout has no fixed head size — calling this on one is an internal error (the caller
 * must take the dynamic path instead).
 */
export function staticSize(l: TypeLayout): number {
  if (l.kind === 'word') return 32;
  if (l.kind === 'tuple' && !l.dynamic) return l.components.reduce((n, c) => n + staticSize(c), 0);
  if (l.kind === 'array' && l.length !== null && !isDynamic(l.elem)) {
    return l.length * staticSize(l.elem);
  }
  throw new EvsInternalError(
    'INTERNAL',
    `staticSize: ${JSON.stringify(l.abi)} is dynamic — no fixed head size`,
  );
}

/**
 * Size in bytes of the ABI head for `params`: each param occupies one 32-byte offset slot when
 * dynamic, else its full static size inlined (a static tuple's members, a static fixed-size
 * array's `N` elements — no offset pointer). Each type is validated through `layoutOfType` so
 * unsupported shapes fail loudly here instead of producing a silently-wrong head size.
 */
export function headBytes(params: readonly PlainAbiParam[]): number {
  let bytes = 0;
  for (const p of params) {
    const layout = layoutOfType(abiParamToType(p));
    bytes += isDynamic(layout) ? 32 : staticSize(layout);
  }
  return bytes;
}
