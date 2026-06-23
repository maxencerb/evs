/**
 * M3 `abi/layout.ts` — type layouts over v0 ABI type strings / `PlainAbiParam` trees.
 *
 * Contract: docs/design/module-interfaces.md §M3 (frozen) + architecture.md §5 (memory model,
 * canonical word invariant) and §8 (head/tail shapes). v0-limited (no tuples, no `T[N]`, no
 * nested arrays) but recursion-ready: `headBytes` walks `PlainAbiParam` trees and the layout
 * union has room for a future `tuple` member without reshaping the existing ones.
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
  // element) OR a memref pointer to the element's block (composite/dynamic element, §12.1).
  // `elem` is widened to {@link TypeLayout} so the type ADMITS composite-element arrays for the
  // §12.6/§12.7 codegen milestone; today `layoutOf`/`layoutOfType` still only ever PRODUCE a
  // word-element array (composite elements throw `UNSUPPORTED_V0`), so every codegen consumer that
  // assumes `elem.kind === 'word'` is still correct at runtime.
  | { kind: 'array'; abi: string; elem: TypeLayout }
  // a tuple/struct: a flat block of `components.length` words, dynamic iff any component is
  // (architecture.md §5). `components` are the member layouts in declaration order; `abi` carries
  // the tuple tag (`'tuple'` only in v0 — tuple arrays are a follow-up). Built via `layoutOfType`,
  // which is the only entry that handles the {@link TupleType} descriptor object.
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
 * Valid-Solidity-but-deferred shapes get `UNSUPPORTED_V0`; anything else (not a type string
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
      `layoutOf: type ${JSON.stringify(abiType)} is not supported in evs v0 (tuples, fixed-size arrays \`T[N]\`, and nested/non-word arrays are deferred)`,
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
 *  otherwise). One level of array nesting over a composite/dynamic element is supported (§12.3):
 *  `string[]`/`bytes[]` and one-level `T[][]` produce an array-of-composite layout; `T[N]` and
 *  string arrays nested deeper than `[][]` stay deferred. */
export function layoutOf(abiType: string): TypeLayout {
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
 * A tuple is `dynamic` iff any component layout is dynamic. v0-limited: tuple *arrays*
 * (`'tuple[]'`/`'tuple[][]'`) are a follow-up and get `UNSUPPORTED_V0` here; component string
 * arrays remain word-element-only (nested string arrays inside a tuple are a follow-up too — they
 * fail through `layoutOf` with the usual code).
 */
export function layoutOfType(t: EvsType): TypeLayout {
  if (!isTupleType(t)) return layoutOf(t);
  if (t.type === 'tuple') return tupleLayoutOf(t);
  // one level of tuple-array nesting (§12.3): `tuple[]` → an array whose element is the tuple
  // layout. `tuple[][]` (two levels) stays deferred.
  if (t.type === 'tuple[]') {
    return { kind: 'array', abi: 'tuple[]', elem: tupleLayoutOf({ ...t, type: 'tuple' }) };
  }
  throw new EvsTypeError(
    'UNSUPPORTED_V0',
    `layoutOfType: tuple-array type ${JSON.stringify(t.type)} is not supported in evs v0 (only one level of \`tuple[]\` nesting is supported; \`tuple[][]\` is deferred)`,
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
 * tuple. Used by the array encode/decode element loops (§12.2: a static element `E` inlines
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
 * Size in bytes of the ABI head for `params` (architecture §8). Each param occupies one 32-byte
 * head slot UNLESS it is a *static* tuple — an all-static inner tuple is inlined into the head as
 * its own components' head (no offset pointer), so it occupies `headBytes(components)` bytes. A
 * dynamic param (word-dynamic or a dynamic tuple) is a single offset-pointer slot. Each type is
 * validated through `layoutOfType` so non-v0 shapes fail loudly here instead of producing a
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
