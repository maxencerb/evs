/**
 * `ir/interp/encode.ts` — the ABI encode shapes (standard head/tail over raw bytes, tuple-aware)
 * the interpreter builds sub-call calldata, the return tuple and revert payloads with.
 */

import { u256ToBytes as wordToBytes, padWordAligned } from '../../core/bytes.js';
import { EvsInternalError } from '../../core/errors.js';
import {
  type EvsType,
  isWordType,
  isTupleType,
  abiParamToType,
  fixedLengthOf,
  elemTypeOf,
  type ArrayType,
  type TupleType,
  stringifyType,
  bitsOf,
  isArrayValueType,
} from '../../core/types.js';
import { asArrayType, type Value, concatBytes, isPlainTuple, type TupleVal } from './values.js';

// ---------------------------------------------------------------------------
// ABI encode (standard head/tail over raw bytes — calldata / return shapes, tuple-aware)
// ---------------------------------------------------------------------------

/**
 * ABI-dynamic (offset word in the head + appended tail): string/bytes always; a dynamic array
 * `T[]` (incl. `tuple[]`) always; a fixed-size array `T[N]` iff its element is dynamic; a plain
 * `tuple` iff any component is dynamic; a word never. Mirrors `abi/layout.ts isDynamic`.
 */
export function abiIsDynamic(type: EvsType): boolean {
  if (isWordType(type)) return false;
  if (type === 'string' || type === 'bytes') return true;
  if (isTupleType(type) && type.type === 'tuple') {
    return type.components.some((c) => abiIsDynamic(abiParamToType(c)));
  }
  const arr = asArrayType(type);
  return fixedLengthOf(arr) === null || abiIsDynamic(elemTypeOf(arr));
}

/** ABI head word count of a type: a static (plain) tuple inlines its components' heads, a static
 *  fixed-size array `T[N]` inlines `N · headWords(T)`; any dynamic type is one offset word. */
export function headWords(type: EvsType): number {
  if (abiIsDynamic(type) || isWordType(type)) return 1;
  if (isTupleType(type) && type.type === 'tuple') {
    return type.components.reduce((n, c) => n + headWords(abiParamToType(c)), 0);
  }
  const arr = asArrayType(type);
  const fixed = fixedLengthOf(arr);
  if (fixed === null) throw new EvsInternalError('INTERNAL', 'interpret: static dynamic array');
  return fixed * headWords(elemTypeOf(arr));
}

/** The item list of an array {@link Value}, asserting the fixed length when the type is `T[N]`
 *  (the memory invariant every producer — decode, literal, `arrnew fixed` — establishes). */
function arrayItems(type: ArrayType | TupleType, value: Value): readonly Value[] {
  if (typeof value === 'bigint' || value.kind !== 'array') {
    throw new EvsInternalError('INTERNAL', 'interpret: array value expected for an array type');
  }
  const fixed = fixedLengthOf(type);
  if (fixed !== null && value.items.length !== fixed) {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: fixed-size array '${stringifyType(type)}' holds ${value.items.length} items`,
    );
  }
  return value.items;
}

/**
 * Encodes a head/tail block over `items` (the standard ABI tuple body): static members (words and
 * static tuples) inline into the head; dynamic members (string/bytes/T[]/dynamic tuple) get a head
 * offset (relative to the block start) and an appended tail. Byte-equal to viem
 * `encodeAbiParameters`.
 */
export function encodeParamsBlock(items: readonly { type: EvsType; value: Value }[]): Uint8Array {
  const headSize = items.reduce((n, it) => n + 32 * headWords(it.type), 0);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailLen = 0;
  for (const item of items) {
    if (abiIsDynamic(item.type)) {
      heads.push(wordToBytes(BigInt(headSize + tailLen)));
      const tail = encodeTail(item.type, item.value);
      tails.push(tail);
      tailLen += tail.length;
    } else {
      heads.push(encodeStatic(item.type, item.value));
    }
  }
  return concatBytes([...heads, ...tails]);
}

/**
 * Packed (`abi.encodePacked`) encoding over `items` (issue #17): a word packs to its exact byte
 * width with no padding (`uintN`/`intN` → the low `N/8` bytes of the canonical word, `address` →
 * 20 bytes, `bool` → 1 byte, `bytesN` → the high `N` bytes); `string`/`bytes` contribute their raw
 * payload with no length prefix; a word-element array packs each element padded to 32 bytes (the
 * Solidity in-array padding rule). Composite types never reach here (validateIr rejects them in
 * packed mode, matching solc's compile error). Byte-equal to viem `encodePacked`.
 */
export function encodePackedBlock(items: readonly { type: EvsType; value: Value }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const item of items) {
    const { type, value } = item;
    if (isWordType(type)) {
      if (typeof value !== 'bigint') {
        throw new EvsInternalError('INTERNAL', `interpret: word value expected for '${type}'`);
      }
      const size = bitsOf(type) / 8; // bool → 1 (bitsOf 8), address → 20 (bitsOf 160)
      const word = wordToBytes(value);
      chunks.push(type.startsWith('bytes') ? word.slice(0, size) : word.slice(32 - size));
      continue;
    }
    if (typeof value === 'bigint' || value.kind === 'tuple') {
      throw new EvsInternalError('INTERNAL', 'interpret: packed encode over a non-packable value');
    }
    if (value.kind === 'bytes') {
      chunks.push(value.bytes); // raw payload, no length prefix
      continue;
    }
    // word-element array: each element is its canonical word — exactly the padded encoding.
    for (const it of value.items) {
      if (typeof it !== 'bigint') {
        throw new EvsInternalError('INTERNAL', 'interpret: packed array element is not a word');
      }
      chunks.push(wordToBytes(it));
    }
  }
  return concatBytes(chunks);
}

/** Encodes an ABI-static value into its inline head bytes: a word (one word), a static tuple
 *  (its components' heads concatenated, recursively), or a static fixed-size array `T[N]` (its N
 *  elements' heads concatenated — no length word). */
function encodeStatic(type: EvsType, value: Value): Uint8Array {
  if (isPlainTuple(type)) {
    if (typeof value === 'bigint' || value.kind !== 'tuple') {
      throw new EvsInternalError('INTERNAL', `interpret: tuple value expected for a static tuple`);
    }
    return encodeParamsBlock(
      type.components.map((c, i) => ({
        type: abiParamToType(c),
        value: tupleField(value, i),
      })),
    );
  }
  if (isArrayValueType(type)) {
    const elem = elemTypeOf(type);
    return concatBytes(arrayItems(type, value).map((it) => encodeStatic(elem, it)));
  }
  if (typeof value !== 'bigint') {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: word value expected for ${stringifyType(type)}`,
    );
  }
  return wordToBytes(value);
}

/**
 * Encodes a dynamic member's tail: a recursive head/tail block (a dynamic plain tuple),
 * `[len][padded payload]` (bytes/string), or a `T[]` array tail (incl. `tuple[]`/`T[][]`).
 */
function encodeTail(type: EvsType, value: Value): Uint8Array {
  if (isPlainTuple(type)) {
    if (typeof value === 'bigint' || value.kind !== 'tuple') {
      throw new EvsInternalError('INTERNAL', `interpret: tuple value expected for a dynamic tuple`);
    }
    return encodeParamsBlock(
      type.components.map((c, i) => ({
        type: abiParamToType(c),
        value: tupleField(value, i),
      })),
    );
  }
  if (typeof value === 'bigint') {
    throw new EvsInternalError('INTERNAL', 'interpret: memref value expected for a dynamic type');
  }
  // string/bytes payload tail
  if (value.kind === 'bytes') {
    const padded = padWordAligned(value.bytes);
    return concatBytes([wordToBytes(BigInt(value.bytes.length)), padded]);
  }
  const arr = asArrayType(type);
  return encodeArrayTail(elemTypeOf(arr), arrayItems(arr, value), fixedLengthOf(arr) !== null);
}

/**
 * Encodes an array tail. A dynamic `T[]` starts with `[len]`; a fixed-size `T[N]` has NO length
 * word (`enc((T,…,T))` per the spec). Then, for a **static** element, each element inlined
 * contiguously (`len · staticSize(E)` bytes, NO offset words); for a **dynamic** element, `len`
 * offset words each relative to the array DATA START `D` (the word after `len`, or the block start
 * for a fixed-size array), then the element tails appended from `D + 32·len`. Word-array encode
 * (every item a word, static element) reduces to `[len]` + one `wordToBytes` per item —
 * byte-identical to the pre-composite path.
 */
function encodeArrayTail(elem: EvsType, items: readonly Value[], fixed: boolean): Uint8Array {
  const lenWord = fixed ? [] : [wordToBytes(BigInt(items.length))];
  if (!abiIsDynamic(elem)) {
    // static element: [len] then each element's inline head bytes, contiguous.
    return concatBytes([...lenWord, ...items.map((it) => encodeStatic(elem, it))]);
  }
  // dynamic element: [len][off0]…[off_{len-1}] (each relative to D = the word after len) then tails.
  const offsetWordsBytes = 32 * items.length;
  const offsets: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailLen = 0;
  for (const it of items) {
    offsets.push(wordToBytes(BigInt(offsetWordsBytes + tailLen)));
    const tail = encodeTail(elem, it);
    tails.push(tail);
    tailLen += tail.length;
  }
  return concatBytes([...lenWord, ...offsets, ...tails]);
}

/** Member `i` of a {@link TupleVal} (validateIr guarantees the index is in range). */
export function tupleField(value: TupleVal, i: number): Value {
  const v = value.fields[i];
  if (v === undefined) {
    throw new EvsInternalError('INTERNAL', `interpret: tuple member ${i} is missing`);
  }
  return v;
}
