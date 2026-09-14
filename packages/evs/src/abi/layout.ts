/**
 * `abi/layout.ts` — type layouts over evs ABI type strings / `PlainAbiParam` trees.
 *
 * Implements the memory model (canonical word invariant) and the ABI head/tail shapes for the
 * whole evs type vocabulary: words, `string`/`bytes`, one-level arrays over any of those or over a
 * tuple (`T[]`, `string[]`, `T[][]`, `tuple[]`), and (nested) tuples. Still rejected with
 * `UNSUPPORTED_V0` (#4): fixed-size `T[N]`, `tuple[][]`, and arrays nested deeper than `[][]`.
 */

import { EvsInternalError, EvsTypeError } from '../core/errors.js';
import { captureLoc } from '../core/loc.js';
import {
  abiParamToType,
  bitsOf,
  isSigned,
  isTupleType,
  isWordType,
  type EvsType,
  type TupleType,
  type WordType,
} from '../core/types.js';
import type { PlainAbiParam } from '../ir/nodes.js';

export type WordLayout = {
  kind: 'word';
  abi: WordType;
  bits: number;
  signed: boolean;
  leftAligned: boolean;
};

export type TypeLayout =
  | WordLayout
  | { kind: 'bytes'; abi: 'bytes' | 'string' }
  // a dynamic array `E[]`: `[len][p0]…[p_{len-1}]` where each slot is an inline word (word
  // element) OR a memref pointer to the element's block (composite/dynamic element).
  // `elem` is any {@link TypeLayout}: `layoutOf`/`layoutOfType` produce word-element arrays as well
  // as one level of composite/dynamic-element arrays (`string[]`, `T[][]`, `tuple[]`); codegen
  // dispatches on `elem.kind` before assuming a word element.
  | { kind: 'array'; abi: string; elem: TypeLayout }
  // a tuple/struct: a flat block of `components.length` words, dynamic iff any component is.
  // `components` are the member layouts in declaration order; `abi` carries the tuple tag
  // (`'tuple'`; a `tuple[]` is an `array` layout whose `elem` is this). Built via `layoutOfType`, which is
  // the only entry that handles the {@link TupleType} descriptor object.
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

/**
 * Valid-Solidity-but-not-yet-supported shapes (#4) get `UNSUPPORTED_V0`; anything else (not a type string
 * at all) gets `TYPE_MISMATCH`. Mirrors the classification in `core/types.ts`.
 */
function isDeferredSolidity(s: string): boolean {
  if (s === 'tuple' || s.startsWith('tuple')) return true; // tuples / tuple arrays
  if (/\[\d+\]$/.test(s)) return true; // fixed-size arrays T[N]
  if (s.endsWith('[]')) return true; // reached only with a non-word element: nested / dynamic
  return false;
}

function badTypeError(abiType: string): EvsTypeError {
  if (isDeferredSolidity(abiType)) {
    return new EvsTypeError(
      'UNSUPPORTED_V0',
      `layoutOf: type ${JSON.stringify(abiType)} is not supported yet (fixed-size arrays \`T[N]\` and arrays nested deeper than \`[][]\` are not supported; tuples must be \`t.struct\`/\`t.tuple\` descriptors)`,
      { loc: captureLoc() },
    );
  }
  return new EvsTypeError(
    'TYPE_MISMATCH',
    `layoutOf: unknown ABI type ${JSON.stringify(abiType)} (expected uintN/intN/address/bool/bytesN, string, bytes, or T[] of a word type)`,
    { loc: captureLoc() },
  );
}

/** Throws `EvsTypeError` (`UNSUPPORTED_V0` on tuple/`T[N]`/deeper nesting, `TYPE_MISMATCH`
 *  otherwise). One level of array nesting over a composite/dynamic element is supported:
 *  `string[]`/`bytes[]` and one-level `T[][]` produce an array-of-composite layout; `T[N]` and
 *  string arrays nested deeper than `[][]` stay deferred. */
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
  if (abiType.endsWith('[]') && !/\[\d+\]$/.test(abiType)) {
    const elem = abiType.slice(0, -2);
    if (isWordType(elem)) return { kind: 'array', abi: abiType, elem: wordLayoutOf(elem) };
    // one level over a composite/dynamic element: `string[]`/`bytes[]`, or one-level `T[][]`.
    // `elem` must be a leaf-dynamic (`string`/`bytes`) or a single word-element array (`T[]`).
    if (elem === 'bytes' || elem === 'string') {
      return { kind: 'array', abi: abiType, elem: { kind: 'bytes', abi: elem } };
    }
    if (elem.endsWith('[]') && !/\[\d+\]$/.test(elem)) {
      const inner = elem.slice(0, -2);
      if (isWordType(inner)) {
        return {
          kind: 'array',
          abi: abiType,
          elem: { kind: 'array', abi: elem, elem: wordLayoutOf(inner) },
        };
      }
    }
  }
  throw badTypeError(abiType);
}

/**
 * Layout of any {@link EvsType}: a {@link TupleType} descriptor → a `tuple` layout (recursing
 * over its components via `abiParamToType`); a string type → the existing string-keyed `layoutOf`.
 * A tuple is `dynamic` iff any component layout is dynamic. One level of tuple array (`'tuple[]'`)
 * is an `array` layout over the tuple layout; `'tuple[][]'` is not supported yet (#4) and gets
 * `UNSUPPORTED_V0` here. Component arrays go through `layoutOf` and share its limits.
 */
export function layoutOfType(t: EvsType): TypeLayout {
  if (!isTupleType(t)) return layoutOf(t);
  const hit = layoutByTuple.get(t);
  if (hit !== undefined) return hit;
  const layout = computeTupleLayout(t);
  layoutByTuple.set(t, layout);
  return layout;
}

function computeTupleLayout(t: TupleType): TypeLayout {
  if (t.type === 'tuple') return tupleLayoutOf(t);
  // one level of tuple-array nesting: `tuple[]` → an array whose element is the tuple
  // layout. `tuple[][]` (two levels) stays deferred.
  if (t.type === 'tuple[]') {
    return { kind: 'array', abi: 'tuple[]', elem: tupleLayoutOf({ ...t, type: 'tuple' }) };
  }
  throw new EvsTypeError(
    'UNSUPPORTED_V0',
    `layoutOfType: tuple-array type ${JSON.stringify(t.type)} is not supported yet (only one level of \`tuple[]\` nesting is supported; \`tuple[][]\` is not)`,
    { loc: captureLoc() },
  );
}

function tupleLayoutOf(t: TupleType): Extract<TypeLayout, { kind: 'tuple' }> {
  const components = t.components.map((c) => layoutOfType(abiParamToType(c)));
  return { kind: 'tuple', abi: t.type, components, dynamic: components.some(isDynamic) };
}

export function isDynamic(l: TypeLayout): boolean {
  if (l.kind === 'tuple') return l.dynamic;
  return l.kind !== 'word';
}

/**
 * Static (head-inlined) byte size of `l`: `32` for a word, `headBytes(components)` for a STATIC
 * tuple. Used by the array encode/decode element loops (a static element `E` inlines
 * `staticSize(E)` bytes per slot). A dynamic layout has no fixed head size — calling this on one
 * is an internal error (the caller must take the dynamic-element path instead).
 */
export function staticSize(l: TypeLayout): number {
  if (l.kind === 'word') return 32;
  if (l.kind === 'tuple' && !l.dynamic) return headBytes(l.components.map(layoutToParam));
  throw new EvsInternalError(
    'INTERNAL',
    `staticSize: ${JSON.stringify(l.abi)} is dynamic — no fixed head size`,
    { loc: captureLoc() },
  );
}

/** Reconstructs the `PlainAbiParam` for a tuple component layout, so `staticSize` can reuse
 *  {@link headBytes} (which walks `PlainAbiParam` trees). Name is irrelevant to head sizing. */
function layoutToParam(l: TypeLayout): PlainAbiParam {
  if (l.kind === 'tuple')
    return { name: '', type: l.abi, components: l.components.map(layoutToParam) };
  return { name: '', type: l.abi };
}

/**
 * Size in bytes of the ABI head for `params`. Each param occupies one 32-byte
 * head slot UNLESS it is a *static* tuple — an all-static inner tuple is inlined into the head as
 * its own components' head (no offset pointer), so it occupies `headBytes(components)` bytes. A
 * dynamic param (word-dynamic or a dynamic tuple) is a single offset-pointer slot. Each type is
 * validated through `layoutOfType` so unsupported shapes fail loudly here instead of producing a
 * silently-wrong head size.
 */
export function headBytes(params: readonly PlainAbiParam[]): number {
  let bytes = 0;
  for (const p of params) {
    const layout = layoutOfType(abiParamToType(p));
    if (layout.kind === 'tuple' && !layout.dynamic) {
      // static inner tuple — its members inline into the head (no offset word)
      bytes += headBytes(p.components ?? []);
    } else {
      bytes += 32;
    }
  }
  return bytes;
}
