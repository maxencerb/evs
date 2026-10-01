/**
 * `ir/interp/decode.ts` — the returndata decode of a sub-call's outputs: exact bounds checks,
 * normalization and the decode-work budget, the byte-for-byte mirror of the compiled decoder.
 */

import {
  arrayDecodeCharge,
  DECODE_BUDGET_SLACK,
  layoutOfType,
  tupleDecodeCharge,
} from '../../abi/layout.js';
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

/**
 * The bytes a decode may still charge (see `DECODE_BUDGET_SLACK` in `abi/layout.ts`): every block
 * `arrayDecodeCharge` / `tupleDecodeCharge` selects is charged once its bounds hold, at the same
 * blocks and for the same amounts as the compiled decoder; running out is a decode failure.
 */
interface DecodeBudget {
  left: number;
}

/** Charges `bytes` (if any) to `budget`; false once the budget is spent. */
function charge(budget: DecodeBudget, bytes: number | null): boolean {
  if (bytes === null) return true;
  budget.left -= bytes;
  return budget.left >= 0;
}

/** `null` = structural decode failure (the per-site `EvsDecodeError` / tryCall-zero trigger). */
export function decodeOutputs(
  outputs: PlainAbiFunction['outputs'],
  data: Uint8Array,
): readonly Value[] | null {
  const budget: DecodeBudget = { left: data.length + DECODE_BUDGET_SLACK };
  // top-level outputs are a head/tail block based at byte 0, bounded by the returndata length
  return decodeBlock(outputs, data, 0, data.length, budget, true);
}

/** ABI head byte size of `params`: a static tuple inlines its whole head (cumulative walk). */
function abiHeadBytes(params: readonly NamedType[]): number {
  return params.reduce((n, p) => n + 32 * headWords(abiParamToType(p)), 0);
}

/**
 * Decodes one ABI head/tail block (`components`) from `data` at `[base, end)`, where dynamic
 * offsets are relative to `base`. Returns the member values (dynamic members own fresh buffers /
 * nested flat blocks, never aliasing). `null` on any structural failure. Mirrors the codegen
 * memory decoder byte-for-byte; static word outputs normalize-don't-revert. `outputs`: this block
 * is the call's output list (its members are top-level outputs); `repeated`: it sits inside an
 * element of an ABI-dynamic array (see `arrayDecodeCharge`).
 */
function decodeBlock(
  components: readonly NamedType[],
  data: Uint8Array,
  base: number,
  end: number,
  budget: DecodeBudget,
  outputs = false,
  repeated = false,
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
    const v = decodeDynamic(type, data, Number(ptr), end, budget, outputs, repeated);
    if (v === null) return null;
    decoded.push(v);
  }
  return decoded;
}

/** Decodes a static member: word → normalized canonical; static plain tuple → inlined recurse;
 *  static fixed-size array `T[N]` → N elements inlined at `at + i·staticSize(T)` (the caller's
 *  head guard already proved the whole static region fits). Never charges the decode-work budget:
 *  a static value is inlined, charged with the block that holds it. */
function decodeStatic(type: EvsType, data: Uint8Array, at: number, end: number): Value | null {
  if (isPlainTuple(type)) {
    // a static tuple has no dynamic member, so its block never reaches the budget
    const fields = decodeBlock(type.components, data, at, end, { left: 0 });
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
 *  `T[]`/`tuple[]`/`T[][]`/a dynamic-element `T[N]` → element loop). `topLevel`: the value is
 *  itself one of the call's outputs; `repeated`: it sits inside an ABI-dynamic array's element. */
function decodeDynamic(
  type: EvsType,
  data: Uint8Array,
  ptr: number,
  end: number,
  budget: DecodeBudget,
  topLevel = false,
  repeated = false,
): Value | null {
  if (isPlainTuple(type)) {
    // a dynamic tuple's block starts at ptr; its offsets are relative to ptr. Its head must fit
    // (the compiled decoder bounds it before it charges, and charges before it allocates the
    // tuple's block; a framed sub-tuple's two-word frame, uncharged scratch, is allocated between
    // the bound and the charge — invisible here, since the interpreter keeps no frames)
    if (BigInt(end - ptr) < BigInt(abiHeadBytes(type.components))) return null;
    const layout = layoutOfType(type);
    if (layout.kind !== 'tuple') throw new EvsInternalError('INTERNAL', 'interpret: tuple layout');
    if (!charge(budget, tupleDecodeCharge(layout, repeated))) return null;
    const fields = decodeBlock(type.components, data, ptr, end, budget, false, repeated);
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
  // the decode-work budget, charged once the body bound below holds (the compiled decoder charges
  // right after it, before allocating the block); the elements of this ABI-dynamic array decode
  // `repeated`
  const layout = layoutOfType(arr);
  if (layout.kind !== 'array') throw new EvsInternalError('INTERNAL', 'interpret: array layout');
  const c = arrayDecodeCharge(layout, topLevel, repeated);
  const blockCharge = c === null ? null : c.fixed + c.perElem * n;
  if (!abiIsDynamic(elem)) {
    // static element: the whole body must fit — D + len·staticSize ≤ end.
    const staticSize = 32 * headWords(elem);
    if (BigInt(D) + BigInt(n) * BigInt(staticSize) > BigInt(end)) return null;
    if (!charge(budget, blockCharge)) return null;
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
  if (!charge(budget, blockCharge)) return null;
  const items: Value[] = [];
  for (let i = 0; i < n; i++) {
    const off = readWord(data, D + 32 * i);
    if (off > U64_MAX) return null;
    const elemPtr = BigInt(D) + off; // offset relative to D (the array data start)
    if (elemPtr + 32n > BigInt(end)) return null;
    const v = decodeDynamic(elem, data, Number(elemPtr), end, budget, false, true);
    if (v === null) return null;
    items.push(v);
  }
  return { kind: 'array', elem, items };
}
