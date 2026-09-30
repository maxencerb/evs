/**
 * `ir/interp/decode.ts` — the returndata decode of a sub-call's outputs: exact bounds checks and
 * normalization, the byte-for-byte mirror of the compiled decoder.
 */

import { EvsInternalError } from '../../core/errors.js';
import {
  type NamedType,
  abiParamToType,
  type EvsType,
  isArrayValueType,
  elemTypeOf,
  fixedLengthOf,
  isWordType,
  stringifyType,
} from '../../core/types.js';
import type { PlainAbiFunction } from '../nodes.js';
import { canonWord } from './arith.js';
import { headWords, abiIsDynamic } from './encode.js';
import { type Value, readWord, U64_MAX, isPlainTuple, asArrayType } from './values.js';

// ---------------------------------------------------------------------------
// returndata decode (steps 3–5 — exact bounds + normalization)
// ---------------------------------------------------------------------------

/** `null` = structural decode failure (the per-site `EvsDecodeError` / tryCall-zero trigger). */
export function decodeOutputs(
  outputs: PlainAbiFunction['outputs'],
  data: Uint8Array,
): readonly Value[] | null {
  // top-level outputs are a head/tail block based at byte 0, bounded by the returndata length
  return decodeBlock(outputs, data, 0, data.length);
}

/** ABI head byte size of `params`: a static tuple inlines its whole head (cumulative walk). */
function abiHeadBytes(params: readonly NamedType[]): number {
  return params.reduce((n, p) => n + 32 * headWords(abiParamToType(p)), 0);
}

/**
 * Decodes one ABI head/tail block (`components`) from `data` at `[base, end)`, where dynamic
 * offsets are relative to `base`. Returns the member values (dynamic members own fresh buffers /
 * nested flat blocks, never aliasing). `null` on any structural failure. Mirrors the codegen
 * memory decoder byte-for-byte; static word outputs normalize-don't-revert.
 */
function decodeBlock(
  components: readonly NamedType[],
  data: Uint8Array,
  base: number,
  end: number,
): readonly Value[] | null {
  // staticMinSize guard BEFORE any head read: the head must fit in [base, end)
  if (BigInt(end - base) < BigInt(abiHeadBytes(components))) return null;
  const decoded: Value[] = [];
  let headOff = 0; // cumulative head offset within this block
  for (const p of components) {
    const type = abiParamToType(p);
    if (!abiIsDynamic(type)) {
      // static member (word or static tuple) inlines at base+headOff
      const v = decodeStatic(type, data, base + headOff, end);
      if (v === null) return null;
      decoded.push(v);
      headOff += 32 * headWords(type);
      continue;
    }
    // dynamic member: offset word at base+headOff, relative to base; off ≤ 2^64−1, +32 ≤ end
    const off = readWord(data, base + headOff);
    headOff += 32;
    if (off > U64_MAX) return null;
    const ptr = BigInt(base) + off;
    if (ptr + 32n > BigInt(end)) return null;
    const v = decodeDynamic(type, data, Number(ptr), end);
    if (v === null) return null;
    decoded.push(v);
  }
  return decoded;
}

/** Decodes a static member: word → normalized canonical; static plain tuple → inlined recurse;
 *  static fixed-size array `T[N]` → N elements inlined at `at + i·staticSize(T)` (the caller's
 *  head guard already proved the whole static region fits). */
function decodeStatic(type: EvsType, data: Uint8Array, at: number, end: number): Value | null {
  if (isPlainTuple(type)) {
    const fields = decodeBlock(type.components, data, at, end);
    return fields === null ? null : { kind: 'tuple', fields: [...fields] };
  }
  if (isArrayValueType(type)) {
    const elem = elemTypeOf(type);
    const n = fixedLengthOf(type);
    if (n === null) throw new EvsInternalError('INTERNAL', 'interpret: static dynamic array');
    const staticSize = 32 * headWords(elem);
    const items: Value[] = [];
    for (let i = 0; i < n; i++) {
      const v = decodeStatic(elem, data, at + i * staticSize, end);
      if (v === null) return null;
      items.push(v);
    }
    return { kind: 'array', elem, items };
  }
  if (!isWordType(type)) {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: decodeStatic over non-word '${stringifyType(type)}'`,
    );
  }
  return canonWord(type, readWord(data, at));
}

/** Decodes a dynamic member at `ptr` (dynamic plain tuple → recurse; string/bytes → fresh buffer;
 *  `T[]`/`tuple[]`/`T[][]`/a dynamic-element `T[N]` → element loop). */
function decodeDynamic(type: EvsType, data: Uint8Array, ptr: number, end: number): Value | null {
  if (isPlainTuple(type)) {
    // a dynamic tuple's block starts at ptr; its offsets are relative to ptr
    const fields = decodeBlock(type.components, data, ptr, end);
    return fields === null ? null : { kind: 'tuple', fields: [...fields] };
  }
  if (type === 'string' || type === 'bytes') {
    const len = readWord(data, ptr);
    if (len > U64_MAX) return null;
    if (BigInt(ptr) + 32n + len > BigInt(end)) return null;
    const start = ptr + 32;
    return { kind: 'bytes', bytes: data.slice(start, start + Number(len)) };
  }
  // Array decode. Dynamic `T[]`: `len` at ptr, D = the word after it. Fixed `T[N]`: no length word,
  // len = N, D = ptr. A static element is inlined at D + i·staticSize; a dynamic element is
  // reached via a per-element offset word at D + 32·i, each offset relative to D. Each element
  // is a fresh Value (no aliasing across elements).
  const arr = asArrayType(type);
  const elem = elemTypeOf(arr);
  const fixed = fixedLengthOf(arr);
  let len: bigint;
  let D: number;
  if (fixed === null) {
    len = readWord(data, ptr);
    if (len > U64_MAX) return null;
    D = ptr + 32;
  } else {
    len = BigInt(fixed);
    D = ptr;
  }
  const n = Number(len);
  if (!abiIsDynamic(elem)) {
    // static element: the whole body must fit — D + len·staticSize ≤ end.
    const staticSize = 32 * headWords(elem);
    if (BigInt(D) + BigInt(n) * BigInt(staticSize) > BigInt(end)) return null;
    const items: Value[] = [];
    for (let i = 0; i < n; i++) {
      const v = decodeStatic(elem, data, D + i * staticSize, end);
      if (v === null) return null;
      items.push(v);
    }
    return { kind: 'array', elem, items };
  }
  // dynamic element: the offset word region (len words at [D, D+32·len)) must fit first.
  if (BigInt(D) + 32n * len > BigInt(end)) return null;
  const items: Value[] = [];
  for (let i = 0; i < n; i++) {
    const off = readWord(data, D + 32 * i);
    if (off > U64_MAX) return null;
    const elemPtr = BigInt(D) + off; // offset relative to D (the array data start)
    if (elemPtr + 32n > BigInt(end)) return null;
    const v = decodeDynamic(elem, data, Number(elemPtr), end);
    if (v === null) return null;
    items.push(v);
  }
  return { kind: 'array', elem, items };
}
