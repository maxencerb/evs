/**
 * `codegen/codec-keys.ts` — @internal the identity of a shared codec body (`codegen/codecs.ts`):
 * one body per key per compile, so two uses share a body exactly when their keys are equal.
 *
 * A leaf module (it imports only `abi/layout.ts`), so the emitters that ask the codec hook for a
 * call (`abi/encode.ts`, `call/static-call.ts`, `call/simulate-call.ts`) and the planner that
 * decides what to share can both build keys without an import cycle.
 */

import { isDynamic, type TypeLayout } from '../abi/layout.js';

/**
 * The four shapes of a top-level composite member of an encode block that can share an encoder
 * body (`encodeMemberKind` in `abi/encode.ts` classifies a layout):
 *
 * - `ST` — a static tuple, inlined into its parent's head;
 * - `SA` — a static fixed-size array `T[N]`, inlined into its parent's head;
 * - `DT` — a dynamic tuple, appended at the tail cursor behind an offset word;
 * - `RA` — a dynamic recursive-codec array (a composite-element `E[]` or a dynamic `T[N]`),
 *   appended at the tail cursor behind an offset word.
 */
export type EncodeMemberKind = 'ST' | 'SA' | 'DT' | 'RA';

/** The site id the program's return encode is counted under (statement site ids are ≥ 0). */
export const RETURNS_SITE = -1;

/**
 * A canonical string for `l`'s shape. With `eraseWords`, every word type is `w` and `string` /
 * `bytes` are both `b`: the ENCODER never inspects a word's type (a word is `pushSrc; MSTORE`)
 * and encodes `string` and `bytes` with the same leaf tail, so `(uint64,address)` and
 * `(uint256,int32)` can share one encoder body. Decoders normalize per word type, so their keys
 * keep the ABI types. Member names never appear.
 */
export function layoutKey(l: TypeLayout, eraseWords: boolean): string {
  switch (l.kind) {
    case 'word':
      return eraseWords ? 'w' : l.abi;
    case 'bytes':
      return eraseWords ? 'b' : l.abi;
    case 'array':
      return `${layoutKey(l.elem, eraseWords)}[${l.length ?? ''}]`;
    default:
      return `(${l.components.map((c) => layoutKey(c, eraseWords)).join(',')})`;
  }
}

/** The key of a shared encoder body for a top-level member of kind `kind` and layout `l`. */
export function encKey(kind: EncodeMemberKind, l: TypeLayout): string {
  return `enc|${kind}|${layoutKey(l, true)}`;
}

/**
 * The key of a shared decoder body for one recursive-codec output of an `s.read` / `s.call` (or
 * `try*`, `revertReturns`) site: its type, its head offset in the returndata (the body's base
 * reads and bounds use it) and its effective decode budget (`effectiveDecodeBudget` in
 * `abi/decode.ts`).
 */
export function decRetKey(l: TypeLayout, headOffset: number, budget: string): string {
  return `dec|ret|${layoutKey(l, false)}|${headOffset}|${budget}`;
}

/**
 * The key of a shared decoder body for the whole outputs tuple of an `s.simulate` /
 * `s.trySimulate` site (`outputs`: the layout of that tuple) under the site's decode budget.
 */
export function decSimKey(outputs: TypeLayout, budget: string): string {
  return `dec|sim|${layoutKey(outputs, false)}|${budget}`;
}

/** Whether an encoder member kind is appended at the tail cursor (behind a head offset word). */
export function isTailMemberKind(kind: EncodeMemberKind): boolean {
  return kind === 'DT' || kind === 'RA';
}

/** The encoder member kind of a top-level composite member layout, `null` for a word or leaf. */
export function encodeMemberKind(l: TypeLayout): EncodeMemberKind | null {
  if (l.kind === 'tuple') return l.dynamic ? 'DT' : 'ST';
  if (l.kind !== 'array' || (l.elem.kind === 'word' && l.length === null)) return null;
  return isDynamic(l) ? 'RA' : 'SA';
}
