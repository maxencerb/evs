/**
 * `ir/interp/arith.ts` — checked arithmetic and word ops over canonical words (exact bigint math
 * plus a range check, the solc Panic codes), conversions, and the const / env / zero values.
 */

import { hexToBytes } from '../../core/bytes.js';
import { EvsInternalError } from '../../core/errors.js';
import {
  type WordType,
  isSigned,
  bitsOf,
  type EvsType,
  isWordType,
  stringifyType,
  type Hex,
  elemTypeOf,
  abiParamToType,
  fixedLengthOf,
} from '../../core/types.js';
import type { ModArithOp } from '../nodes.js';
import {
  MASK256,
  panicSignal,
  TWO_POW_256,
  TWO_POW_255,
  MASK160,
  type Value,
  readWord,
  asWordElem,
  asArrayType,
  type ResolvedEnv,
  isPlainTuple,
} from './values.js';

// ---------------------------------------------------------------------------
// checked arithmetic + word ops
// ---------------------------------------------------------------------------

export function binOp(op: string, type: WordType, a: bigint, b: bigint): bigint {
  switch (op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'mod':
      return arith(op, type, a, b);
    case 'pow':
      return checkedPow(type, a, b);
    case 'lt':
      return logical(type, a) < logical(type, b) ? 1n : 0n;
    case 'gt':
      return logical(type, a) > logical(type, b) ? 1n : 0n;
    case 'lte': // ISZERO(GT)
      return logical(type, a) <= logical(type, b) ? 1n : 0n;
    case 'gte': // ISZERO(LT)
      return logical(type, a) >= logical(type, b) ? 1n : 0n;
    case 'eq':
      return a === b ? 1n : 0n;
    case 'neq':
      return a === b ? 0n : 1n;
    case 'and': // eager bool AND on canonical 0/1 words
      return a & b;
    case 'or':
      return a | b;
    case 'bitand':
      return canonWord(type, a & b);
    case 'bitor':
      return canonWord(type, a | b);
    case 'bitxor':
      return canonWord(type, a ^ b);
    case 'shl': {
      // SHL then mask/sign-extend to width (Solidity shifts are unchecked)
      const r = b >= 256n ? 0n : (a << b) & MASK256;
      return canonWord(type, r);
    }
    case 'shr': {
      if (isSigned(type)) {
        // SAR — canonical-preserving on a sign-extended operand
        const sa = toSigned256(a);
        const r = b >= 256n ? (sa < 0n ? -1n : 0n) : sa >> b;
        return canonWord(type, r & MASK256);
      }
      // logical SHR for uintN/bytesN, then re-mask to width (bytesN: bits shifted out of the
      // left-aligned lane are cleared — matches the codegen post-mask)
      const r = b >= 256n ? 0n : a >> b;
      return canonWord(type, r);
    }
    default:
      throw new EvsInternalError('INTERNAL', `interpret: unknown bin op '${op}'`);
  }
}

/**
 * add/sub/mul/div/mod with solc ≥0.8 checked semantics. Exact bigint math + range check on
 * the true result — identical to the compiled EVM check sequences for canonical operands (incl.
 * uint192 mul wrap-past-2^256, int256 `−2^255 / −1`, intN `minN / −1`, `−1 × −2^255`).
 */
function arith(
  op: 'add' | 'sub' | 'mul' | 'div' | 'mod',
  type: WordType,
  aw: bigint,
  bw: bigint,
): bigint {
  const a = logical(type, aw);
  const b = logical(type, bw);
  const [min, max] = numericRange(type);
  let r: bigint;
  switch (op) {
    case 'add':
      r = a + b;
      break;
    case 'sub':
      r = a - b;
      break;
    case 'mul':
      r = a * b;
      break;
    case 'div':
      if (b === 0n) throw panicSignal(0x12);
      r = a / b; // bigint division truncates toward zero — exactly SDIV/DIV
      break;
    case 'mod':
      if (b === 0n) throw panicSignal(0x12);
      r = a % b; // bigint remainder follows the dividend's sign — exactly SMOD/MOD
      break;
    default:
      throw new EvsInternalError('INTERNAL', `interpret: unknown arith op '${String(op)}'`);
  }
  if (r < min || r > max) throw panicSignal(0x11); // Panic 0x11 (overflow/underflow)
  return fromLogical(r);
}

/**
 * `a ** e` with solc ≥0.8 checked semantics (issue #10): the exact integer power, Panic 0x11
 * when it falls outside the base type's range; `0 ** 0 == 1`. The exponent is an unsigned word.
 * Every solc exponentiation template (the literal-base EXP paths, the square-and-multiply
 * loops, the signed first-iteration split) computes exactly this.
 */
function checkedPow(type: WordType, aw: bigint, e: bigint): bigint {
  const a = logical(type, aw);
  const [min, max] = numericRange(type);
  if (e === 0n) return 1n;
  if (a === 0n || a === 1n) return fromLogical(a);
  if (a === -1n) return fromLogical(e % 2n === 0n ? 1n : -1n);
  // |a| ≥ 2 ⇒ |a|^256 ≥ 2^256 is out of range for every width: no huge bigint powers
  if (e > 256n) throw panicSignal(0x11);
  const r = a ** e;
  if (r < min || r > max) throw panicSignal(0x11);
  return fromLogical(r);
}

/** `addmod` / `mulmod` (issue #10): full-precision `(a op b) % n` over uint256, Panic 0x12 on n == 0. */
export function modArith(op: ModArithOp, a: bigint, b: bigint, n: bigint): bigint {
  if (n === 0n) throw panicSignal(0x12);
  return (op === 'addmod' ? a + b : a * b) % n;
}

export function numericRange(type: WordType): readonly [bigint, bigint] {
  const bits = BigInt(bitsOf(type));
  return isSigned(type)
    ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n]
    : [0n, (1n << bits) - 1n];
}

/** canonical word → logical integer (signed for intN; the raw word otherwise). */
export function logical(type: WordType, word: bigint): bigint {
  return isSigned(type) ? toSigned256(word) : word;
}

/** logical integer (in range, so |v| < 2^255) → canonical 256-bit word. */
export function fromLogical(v: bigint): bigint {
  return v < 0n ? v + TWO_POW_256 : v;
}

function toSigned256(word: bigint): bigint {
  return word >= TWO_POW_255 ? word - TWO_POW_256 : word;
}

/**
 * Normalize an arbitrary 256-bit word to the canonical slot image of `type`:
 * uintN masked, intN SIGNEXTENDed, bool ISZERO ISZERO, address masked to 160 bits, bytesN
 * masked to its left-aligned lane. Used at the trust boundaries (returndata words, arg
 * coercion) and wherever an op can denormalize.
 */
export function canonWord(type: WordType, word: bigint): bigint {
  if (type === 'bool') return word === 0n ? 0n : 1n;
  if (type === 'address') return word & MASK160;
  const bits = BigInt(bitsOf(type));
  if (type.startsWith('bytes')) {
    const laneMask = ((1n << bits) - 1n) << (256n - bits);
    return word & laneMask;
  }
  const low = word & ((1n << bits) - 1n);
  if (!isSigned(type)) return low;
  const negative = (low >> (bits - 1n)) & 1n;
  return negative === 1n ? low | (MASK256 ^ ((1n << bits) - 1n)) : low;
}

/**
 * `convert`: free widening / reinterpret where lossless; otherwise the logical value is
 * range-checked against the target (Panic 0x11) — covers checked narrowing, cross-signedness,
 * and `asAddress`'s high-96-bits-zero check uniformly.
 */
export function convert(from: EvsType, to: EvsType, word: bigint): bigint {
  if (!isWordType(from) || !isWordType(to)) {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: convert over '${stringifyType(from)}' → '${stringifyType(to)}'`,
    );
  }
  if ((from === 'uint256' && to === 'bytes32') || (from === 'bytes32' && to === 'uint256')) {
    return word; // free reinterpret — both occupy the full word
  }
  if (to === 'address') {
    // asAddress (from uint256 | bytes32): high 96 bits must be zero
    if (word > MASK160) throw panicSignal(0x11);
    return word;
  }
  const v = logical(from, word);
  const [min, max] = numericRange(to);
  if (v < min || v > max) throw panicSignal(0x11);
  return fromLogical(v);
}

// ---------------------------------------------------------------------------
// const / env / zero values
// ---------------------------------------------------------------------------

export function constValue(type: EvsType, data: { kind: 'word' | 'data'; hex: Hex }): Value {
  if (data.kind === 'word') return BigInt(data.hex); // canonical per validateIr
  // [len:32][payload…] memref — a fresh buffer per execution, like CODECOPY materialization
  const bytes = hexToBytes(data.hex);
  const len = Number(readWord(bytes, 0));
  if (isWordType(type) || type === 'string' || type === 'bytes') {
    if (isWordType(type)) {
      throw new EvsInternalError('INTERNAL', `interpret: data const of word type '${type}'`);
    }
    return { kind: 'bytes', bytes: bytes.slice(32, 32 + len) };
  }
  // a `data` const array literal is always a word-element block (`[len][w0]…`, CODECOPY-materialized);
  // composite-element arrays are built at runtime (arrnew + arrset), never a data const.
  const elem = asWordElem(elemTypeOf(asArrayType(type)));
  const items = Array.from({ length: len }, (_, i) => readWord(bytes, 32 + 32 * i));
  return { kind: 'array', elem, items };
}

export function envValue(op: string, env: ResolvedEnv): bigint {
  switch (op) {
    case 'address':
      return env.address;
    case 'caller':
      return env.caller;
    case 'timestamp':
      return env.timestamp;
    case 'blocknumber':
      return env.blocknumber;
    case 'chainid':
      return env.chainid;
    default:
      throw new EvsInternalError('INTERNAL', `interpret: unknown env op '${op}'`);
  }
}

export function zeroValue(type: EvsType): Value {
  if (isPlainTuple(type)) {
    // a plain tuple zeroes to a flat block of zeroed fields (a tuple[] is an array — falls through).
    return { kind: 'tuple', fields: type.components.map((c) => zeroValue(abiParamToType(c))) };
  }
  if (isWordType(type)) return 0n;
  if (type === 'string' || type === 'bytes') return { kind: 'bytes', bytes: new Uint8Array(0) };
  // a dynamic array (string array OR tuple[]) zeroes to an EMPTY array carrying its element
  // type; a fixed-size array `T[N]` to N typed-zero elements (its length is part of the type).
  const arr = asArrayType(type);
  const elem = elemTypeOf(arr);
  const fixed = fixedLengthOf(arr);
  return {
    kind: 'array',
    elem,
    items: fixed === null ? [] : Array.from({ length: fixed }, () => zeroValue(elem)),
  };
}
