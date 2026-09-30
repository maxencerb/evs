/**
 * `ir/interp/coerce.ts` — the interpreter's JS boundary: script-arg coercion (the JS mirror of
 * the calldata trust boundary) in, and the JS value projection of `outcome.values` (viem's decode
 * conventions) out.
 */

import { getAddress } from 'viem';

import {
  bytesToBigInt as readPartialWord,
  isHexString,
  hexToBytes,
  bytesToHex,
  u256ToBytes as wordToBytes,
} from '../../core/bytes.js';
import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import {
  type EvsType,
  stringifyType,
  isWordType,
  elemTypeOf,
  fixedLengthOf,
  type TupleType,
  abiParamToType,
  type WordType,
  bitsOf,
} from '../../core/types.js';
import { numericRange, fromLogical, logical } from './arith.js';
import { tupleField } from './encode.js';
import {
  type Value,
  isPlainTuple,
  TEXT_ENCODER,
  asArrayType,
  TEXT_DECODER,
  type TupleVal,
} from './values.js';

// ---------------------------------------------------------------------------
// script-arg coercion (the JS mirror of the calldata trust boundary)
// ---------------------------------------------------------------------------

export function coerceArg(name: string, type: EvsType, value: unknown): Value {
  const where = `interpret: argument "${name}" (${stringifyType(type)})`;
  return coerceValue(type, value, where);
}

/** Coerces a host literal to a {@link Value} of `type` (the JS mirror of the trust boundary,
 *  recursing through tuple components — named object when all members named, positional otherwise). */
function coerceValue(type: EvsType, value: unknown, where: string): Value {
  if (isPlainTuple(type)) return coerceTuple(type, value, where); // a tuple[] falls through to the array arm
  if (isWordType(type)) return coerceWordArg(type, value, where);
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a string`);
    }
    return { kind: 'bytes', bytes: TEXT_ENCODER.encode(value) };
  }
  if (type === 'bytes') {
    return { kind: 'bytes', bytes: coerceHexArg(value, null, where) };
  }
  const arr = asArrayType(type);
  const elem = elemTypeOf(arr);
  if (!Array.isArray(value)) {
    throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected an array`);
  }
  const raw: readonly unknown[] = value;
  const fixed = fixedLengthOf(arr);
  if (fixed !== null && raw.length !== fixed) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: expected exactly ${fixed} element(s), got ${raw.length}`,
    );
  }
  // recurse per element: a word element coerces to a canonical word, a composite/dynamic element
  // (tuple/string/bytes/T[]) coerces to its own memref Value.
  return {
    kind: 'array',
    elem,
    items: raw.map((el, i) => coerceValue(elem, el, `${where}[${i}]`)),
  };
}

/** Coerces a host literal struct/tuple to a {@link TupleVal}: a name-keyed object when every
 *  member is named (abitype's all-named rule), or a positional array otherwise. */
function coerceTuple(type: TupleType, value: unknown, where: string): Value {
  const comps = type.components;
  const allNamed = comps.every((c) => c.name !== '');
  if (allNamed && !Array.isArray(value)) {
    if (typeof value !== 'object' || value === null) {
      throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a struct object`);
    }
    return {
      kind: 'tuple',
      fields: comps.map((c) =>
        coerceValue(
          abiParamToType(c),
          // own properties only (Object.entries semantics) — never the prototype chain
          Object.hasOwn(value, c.name) ? (Reflect.get(value, c.name) as unknown) : undefined,
          `${where}.${c.name}`,
        ),
      ),
    };
  }
  if (!Array.isArray(value)) {
    throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a positional tuple array`);
  }
  const items: readonly unknown[] = value;
  if (items.length !== comps.length) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: expected ${comps.length} members, got ${items.length}`,
    );
  }
  return {
    kind: 'tuple',
    fields: comps.map((c, i) => coerceValue(abiParamToType(c), items[i], `${where}[${i}]`)),
  };
}

function coerceWordArg(type: WordType, value: unknown, where: string): bigint {
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a boolean`);
    }
    return value ? 1n : 0n;
  }
  if (type === 'address') {
    const bytes = coerceHexArg(value, 20, where);
    return readPartialWord(bytes, 0, 20);
  }
  if (type.startsWith('bytes')) {
    const size = Number(type.slice('bytes'.length));
    const bytes = coerceHexArg(value, size, where);
    return readPartialWord(bytes, 0, size) << BigInt(8 * (32 - size)); // left-aligned
  }
  // numeric
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    v = BigInt(value);
  } else {
    throw new EvsTypeError('TYPE_MISMATCH', `${where}: expected a bigint or safe-integer number`);
  }
  const [min, max] = numericRange(type);
  if (v < min || v > max) {
    throw new EvsTypeError('LITERAL_RANGE', `${where}: ${v}n is out of range [${min}, ${max}]`);
  }
  return fromLogical(v);
}

function coerceHexArg(value: unknown, exactBytes: number | null, where: string): Uint8Array {
  if (!isHexString(value)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: expected a 0x-prefixed even-length hex string`,
    );
  }
  const bytes = hexToBytes(value);
  if (exactBytes !== null && bytes.length !== exactBytes) {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `${where}: expected exactly ${exactBytes} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// JS value projection (`outcome.values` — matches viem's decode conventions)
// ---------------------------------------------------------------------------

export function jsValueOf(type: EvsType, value: Value): unknown {
  if (isPlainTuple(type)) {
    if (typeof value === 'bigint' || value.kind !== 'tuple') {
      throw new EvsInternalError('INTERNAL', `interpret: tuple value expected for a tuple type`);
    }
    return jsTuple(type, value);
  }
  if (isWordType(type)) {
    if (typeof value !== 'bigint') {
      throw new EvsInternalError('INTERNAL', `interpret: word value expected for ${type}`);
    }
    return jsWord(type, value);
  }
  // string/bytes/array (incl. tuple[]) — all memref-valued
  if (typeof value === 'bigint' || value.kind === 'tuple') {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: memref value expected for ${stringifyType(type)}`,
    );
  }
  if (value.kind === 'bytes') {
    return type === 'string' ? TEXT_DECODER.decode(value.bytes) : bytesToHex(value.bytes);
  }
  // an array projects to items.map(jsValueOf) — a flat number/bigint list for word elements, a
  // nested array/object list for composite elements (matching abitype/viem decode shape).
  const elem = elemTypeOf(asArrayType(type));
  return value.items.map((item) => jsValueOf(elem, item));
}

/** abitype's tuple projection: an object keyed by component names when ALL members are named,
 *  a positional array otherwise (recursing through members). */
function jsTuple(type: TupleType, value: TupleVal): unknown {
  const comps = type.components;
  const projected = comps.map((c, i) => jsValueOf(abiParamToType(c), tupleField(value, i)));
  if (comps.every((c) => c.name !== '')) {
    const obj: Record<string, unknown> = {};
    comps.forEach((c, i) => {
      obj[c.name] = projected[i];
    });
    return obj;
  }
  return projected;
}

function jsWord(type: WordType, word: bigint): unknown {
  if (type === 'bool') return word === 1n;
  if (type === 'address') {
    return getAddress(`0x${word.toString(16).padStart(40, '0')}`); // checksummed, like viem
  }
  if (type.startsWith('bytes')) {
    const size = Number(type.slice('bytes'.length));
    return bytesToHex(wordToBytes(word).slice(0, size));
  }
  const v = logical(type, word);
  // abitype/viem convention: uintN/intN with N ≤ 48 decode to number, wider to bigint
  return bitsOf(type) <= 48 ? Number(v) : v;
}
