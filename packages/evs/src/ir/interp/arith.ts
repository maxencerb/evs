/**
 * `ir/interp/arith.ts` — checked arithmetic and word ops over canonical words (exact bigint math
 * plus a range check, the solc Panic codes), wrapping arithmetic, `mulDiv`, conversions, and the
 * const / env / zero values.
 */

import { hexToBytes, u256ToBytes } from '../../core/bytes.js';
import { EvsInternalError } from '../../core/errors.js';
import {
  type WordType,
  isSigned,
  bitsOf,
  type EvsType,
  isWordType,
  isBytesN,
  stringifyType,
  type Hex,
  elemTypeOf,
  abiParamToType,
  fixedLengthOf,
  peelArraySuffix,
} from '../../core/types.js';
import type { BinOp, EnvOp, ModArithOp } from '../nodes.js';
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

export function binOp(op: BinOp, type: WordType, a: bigint, b: bigint): bigint {
  switch (op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'mod':
      return arith(op, type, a, b);
    case 'pow':
      return checkedPow(type, a, b);
    case 'wrapadd': // solc `unchecked`: the low N bits of the true result, re-canonicalized
      return canonWord(type, (a + b) & MASK256);
    case 'wrapsub':
      return canonWord(type, (a - b) & MASK256);
    case 'wrapmul':
      return canonWord(type, (a * b) & MASK256);
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
    default: {
      const unknown: never = op; // a compile error here means a BinOp has no case
      throw new EvsInternalError('INTERNAL', `interpret: unknown bin op '${String(unknown)}'`);
    }
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
    default: {
      const unknown: never = op; // a compile error here means an arith op has no case
      throw new EvsInternalError('INTERNAL', `interpret: unknown arith op '${String(unknown)}'`);
    }
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

/**
 * The full-precision ternary ops over uint256, Panic 0x12 on `n == 0`: `addmod` / `mulmod`
 * (issue #10) are `(a op b) % n`; `muldiv` / `muldivup` the floor / ceiling of `a·b / n`, Panic
 * 0x11 when that quotient does not fit uint256 (OpenZeppelin `Math.mulDiv`'s codes).
 */
export function modArith(op: ModArithOp, a: bigint, b: bigint, n: bigint): bigint {
  if (n === 0n) throw panicSignal(0x12);
  switch (op) {
    case 'addmod':
      return (a + b) % n;
    case 'mulmod':
      return (a * b) % n;
    case 'muldiv':
    case 'muldivup': {
      const p = a * b;
      const q = op === 'muldiv' || p % n === 0n ? p / n : p / n + 1n;
      if (q > MASK256) throw panicSignal(0x11);
      return q;
    }
    default: {
      const unknown: never = op; // a compile error here means a ModArithOp has no case
      throw new EvsInternalError('INTERNAL', `interpret: unknown modarith op '${String(unknown)}'`);
    }
  }
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
 * Word `convert`: free widening / reinterpret where lossless; a same-width `bytesN` ↔ `uintN`
 * moves the value between the left-aligned and right-aligned lanes; otherwise the logical value
 * is range-checked against the target (Panic 0x11) — covers checked narrowing,
 * cross-signedness, and `asAddress`'s high-96-bits-zero check uniformly.
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
  if ((from === 'address' && to === 'uint160') || (from === 'uint160' && to === 'address')) {
    return word; // free — both are 160-bit zero-extended words
  }
  if (to === 'address') {
    // asAddress (from uint256 | bytes32): high 96 bits must be zero
    if (word > MASK160) throw panicSignal(0x11);
    return word;
  }
  if (isBytesN(from)) return word >> BigInt(256 - bitsOf(from)); // asUint: lane → low bits
  if (isBytesN(to)) return (word << BigInt(256 - bitsOf(to))) & MASK256; // asBytesN
  const v = logical(from, word);
  const [min, max] = numericRange(to);
  if (v < min || v > max) throw panicSignal(0x11);
  return fromLogical(v);
}

/**
 * `convert` to `string` / `bytes`: `string ↔ bytes` shares the memref (a free reinterpret); a
 * `bytesN` word becomes a fresh payload of its N bytes with the trailing zero bytes trimmed.
 */
export function convertToBytes(from: EvsType, value: Value): Value {
  if (from === 'string' || from === 'bytes') return value;
  if (!isBytesN(from) || typeof value !== 'bigint') {
    throw new EvsInternalError('INTERNAL', `interpret: convert '${stringifyType(from)}' → bytes`);
  }
  const lane = u256ToBytes(value).subarray(0, bitsOf(from) / 8);
  let n = lane.length;
  while (n > 0 && lane[n - 1] === 0) n--;
  return { kind: 'bytes', bytes: lane.slice(0, n) };
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

export function envValue(op: EnvOp, env: ResolvedEnv): bigint {
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
    default: {
      const unknown: never = op; // a compile error here means an EnvOp has no case
      throw new EvsInternalError('INTERNAL', `interpret: unknown env op '${String(unknown)}'`);
    }
  }
}

/**
 * How many array elements {@link zeroValue} materializes for `type`: `N · (1 + slots(T))` for a
 * fixed-size `T[N]`, the members' sum for a plain tuple, `0` for everything else (a dynamic
 * array zeroes to an empty one). The interpreter charges this to its step budget BEFORE it
 * allocates, so a zero of `uint256[1e8][1e8]` fails as `COMPILE_LIMIT` instead of exhausting the
 * host heap. A bigint: four nested `[2^32 − 1]` levels overflow a JS number.
 */
export function zeroFillSlots(type: EvsType): bigint {
  // Peel the suffix chain in a loop, outermost first (`T[a][b]` → `b + b·a + b·a·slots(T)`),
  // recursing only into tuple members, so a long chain costs no host stack (deserialized IR is
  // not depth-gated). `coeff` counts the values of the current inner type; `total` the array
  // elements counted so far. A dynamic suffix ends the walk: that array zeroes to an empty one.
  let total = 0n;
  let coeff = 1n;
  let tag: string = typeof type === 'string' ? type : type.type;
  for (let peeled = peelArraySuffix(tag); peeled !== null; peeled = peelArraySuffix(tag)) {
    if (peeled.length === null) return total;
    coeff *= BigInt(peeled.length);
    total += coeff;
    tag = peeled.inner;
  }
  if (typeof type === 'string') return total; // a word, `string` or `bytes` leaf: no elements
  const members = type.components.reduce((n, c) => n + zeroFillSlots(abiParamToType(c)), 0n);
  return total + coeff * members;
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
