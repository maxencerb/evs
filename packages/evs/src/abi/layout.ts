/**
 * M3 `abi/layout.ts` — type layouts over v0 ABI type strings / `PlainAbiParam` trees.
 *
 * Contract: docs/design/module-interfaces.md §M3 (frozen) + architecture.md §5 (memory model,
 * canonical word invariant) and §8 (head/tail shapes). v0-limited (no tuples, no `T[N]`, no
 * nested arrays) but recursion-ready: `headBytes` walks `PlainAbiParam` trees and the layout
 * union has room for a future `tuple` member without reshaping the existing ones.
 */

import { EvsTypeError } from '../core/errors.js';
import { captureLoc } from '../core/loc.js';
import { bitsOf, isSigned, isWordType, type WordType } from '../core/types.js';
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
  | { kind: 'array'; abi: string; elem: WordLayout }; // dynamic arrays of words only in v0

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

/** Throws `EvsTypeError` (`UNSUPPORTED_V0` on tuple/`T[N]`/nested, `TYPE_MISMATCH` otherwise). */
export function layoutOf(abiType: string): TypeLayout {
  if (isWordType(abiType)) return wordLayoutOf(abiType);
  if (abiType === 'bytes' || abiType === 'string') return { kind: 'bytes', abi: abiType };
  if (abiType.endsWith('[]')) {
    const elem = abiType.slice(0, -2);
    if (isWordType(elem)) return { kind: 'array', abi: abiType, elem: wordLayoutOf(elem) };
  }
  throw badTypeError(abiType);
}

export function isDynamic(l: TypeLayout): boolean {
  return l.kind !== 'word';
}

/**
 * Size in bytes of the ABI head for `params`. Every v0 type occupies exactly one 32-byte head
 * slot (words inline, dynamic types as an offset pointer), so this is `32 × params.length`;
 * each param type is still validated through `layoutOf` so non-v0 shapes fail loudly here
 * instead of producing a silently-wrong head size.
 */
export function headBytes(params: readonly PlainAbiParam[]): number {
  for (const p of params) layoutOf(p.type);
  return 32 * params.length;
}
