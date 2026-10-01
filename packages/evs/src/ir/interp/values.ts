/**
 * `ir/interp/values.ts` — the interpreter's constants and environment defaults, its value model
 * (canonical words, bytes / array / tuple memrefs), the revert and loop-control signals, and the
 * byte / hex / type helpers the other interpreter modules share.
 */

import { PANIC_SELECTOR, EVS_DECODE_ERROR_SELECTOR } from '../../abi/artifact.js';
import {
  hexToBytes,
  u256ToBytes as wordToBytes,
  isHexString,
  bytesToBigInt as readPartialWord,
} from '../../core/bytes.js';
import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import {
  type Hex,
  type EvsType,
  type TupleType,
  isTupleType,
  type ArrayType,
  isArrayValueType,
  stringifyType,
  type WordType,
  isWordType,
} from '../../core/types.js';
import type { Stmt } from '../nodes.js';
import type { InterpEnvOverrides } from './interpreter.js';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_STEPS = 1_000_000;

export const MASK256 = (1n << 256n) - 1n;
export const MASK160 = (1n << 160n) - 1n;
export const U64_MAX = (1n << 64n) - 1n;
export const TWO_POW_255 = 1n << 255n;
export const TWO_POW_256 = 1n << 256n;

/** harness env (test/harness/evm.ts on `@ethereumjs/evm` defaults) — see module doc. */
const ENV_SCRIPT_ADDRESS = 0xcd360ffac9818c4396aa6f4807ebfa72c4b3f530n;
const ENV_CALLER = 0x1000000000000000000000000000000000000001n;
const ENV_TIMESTAMP = 0n;
const ENV_BLOCKNUMBER = 0n;
const ENV_CHAINID = 1n;

/** resolved env table — every op carries its canonical word value. */
export interface ResolvedEnv {
  readonly address: bigint;
  readonly caller: bigint;
  readonly timestamp: bigint;
  readonly blocknumber: bigint;
  readonly chainid: bigint;
}

const ADDRESS_HEX_RE = /^0x[0-9a-fA-F]{40}$/;

function envAddress(field: 'address' | 'caller', value: Hex | undefined, dflt: bigint): bigint {
  if (value === undefined) return dflt;
  if (typeof value !== 'string' || !ADDRESS_HEX_RE.test(value)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: opts.env.${field} must be a 20-byte 0x address, got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

function envWord(
  field: 'timestamp' | 'blocknumber' | 'chainid',
  value: bigint | undefined,
  dflt: bigint,
): bigint {
  if (value === undefined) return dflt;
  if (typeof value !== 'bigint' || value < 0n || value > MASK256) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: opts.env.${field} must be a bigint in [0, 2^256), got ${String(value)}`,
    );
  }
  return value;
}

export function resolveEnv(env: InterpEnvOverrides | undefined): ResolvedEnv {
  return {
    address: envAddress('address', env?.address, ENV_SCRIPT_ADDRESS),
    caller: envAddress('caller', env?.caller, ENV_CALLER),
    timestamp: envWord('timestamp', env?.timestamp, ENV_TIMESTAMP),
    blocknumber: envWord('blocknumber', env?.blocknumber, ENV_BLOCKNUMBER),
    chainid: envWord('chainid', env?.chainid, ENV_CHAINID),
  };
}

/** `Panic(uint256)` / `EvsDecodeError(uint256)` selector bytes. */
const PANIC_SELECTOR_BYTES = hexToBytes(PANIC_SELECTOR);
const DECODE_ERROR_SELECTOR_BYTES = hexToBytes(EVS_DECODE_ERROR_SELECTOR);

// ---------------------------------------------------------------------------
// value model
// ---------------------------------------------------------------------------

/** memref payload of a `string`/`bytes` value — shared by reference. */
export interface BytesVal {
  readonly kind: 'bytes';
  readonly bytes: Uint8Array;
}

/**
 * memref payload of a `T[]` / `T[N]` value — the `[len][p0]…[p_{len-1}]` block (a fixed-size
 * array is laid out identically, with `len === N` always). `items` is the element list, mutated
 * in place by `arrset` (reference semantics, like {@link TupleVal}'s `fields`). For a **word**
 * element each item is a canonical `bigint`; for a **composite** element (`tuple[]`, `T[][]`,
 * `string[]`/`bytes[]`, `T[N][]`, …) each item is the element's own memref `Value` (TupleVal /
 * ArrayVal / BytesVal) — the slot's pointer in the compiled layout.
 */
export interface ArrayVal {
  readonly kind: 'array';
  readonly elem: EvsType;
  readonly items: Value[];
}

/**
 * memref payload of a tuple/struct value — a flat-pointer block of one {@link Value} per member
 * (a word for a static member, a memref for a dynamic/composite one). Reference semantics: the
 * `fields` array is shared (like {@link ArrayVal}'s `words`); `tupleset` mutates `fields[i]` in
 * place, so every alias sees the write.
 */
export interface TupleVal {
  readonly kind: 'tuple';
  readonly fields: Value[];
}

/** a word value is its canonical 256-bit slot image. */
export type Value = bigint | BytesVal | ArrayVal | TupleVal;

// ---------------------------------------------------------------------------
// control-flow / outcome signals (module-private)
// ---------------------------------------------------------------------------

/** unwinds to the top level carrying the byte-exact revert payload. */
export class RevertSignal {
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
}

/** unwinds to the innermost `while` (break/continue lower to jumps at statement boundaries). */
export class LoopSignal {
  readonly ctl: 'break' | 'continue';
  constructor(ctl: 'break' | 'continue') {
    this.ctl = ctl;
  }
}

export function panicSignal(code: number): RevertSignal {
  return new RevertSignal(concatBytes([PANIC_SELECTOR_BYTES, wordToBytes(BigInt(code))]));
}

export function decodeErrorSignal(site: number): RevertSignal {
  return new RevertSignal(concatBytes([DECODE_ERROR_SELECTOR_BYTES, wordToBytes(BigInt(site))]));
}

/** True for a **plain** tuple descriptor (`{type:'tuple'}`) — NOT a tuple array (`tuple[]`). */
export function isPlainTuple(type: EvsType): type is TupleType {
  return isTupleType(type) && type.type === 'tuple';
}

// ---------------------------------------------------------------------------
// bytes / hex / word helpers
// ---------------------------------------------------------------------------

export const TEXT_ENCODER = new TextEncoder();
export const TEXT_DECODER = new TextDecoder();

export function hexToBytesChecked(value: unknown, what: string): Uint8Array {
  if (!isHexString(value)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `interpret: ${what} must be an even-length 0x-hex string`,
    );
  }
  return hexToBytes(value);
}

export function readWord(bytes: Uint8Array, offset: number): bigint {
  return readPartialWord(bytes, offset, 32);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// misc type helpers
// ---------------------------------------------------------------------------

/** Narrows an array value type (any string array or tuple array, dynamic or fixed-size, to any
 *  depth — validateIr already proved the type well-formed) for {@link elemTypeOf}. */
export function asArrayType(s: EvsType): ArrayType | TupleType {
  if (isArrayValueType(s)) return s;
  throw new EvsInternalError(
    'INTERNAL',
    `interpret: '${stringifyType(s)}' is not a supported array type`,
  );
}

/** Narrows a value type guaranteed (by validateIr) to be a word — used where a word element is
 *  required (data-const array literals, word-array JS projection). */
export function asWordElem(t: EvsType): WordType {
  if (!isWordType(t)) {
    throw new EvsInternalError(
      'INTERNAL',
      `interpret: expected a word element type, got '${stringifyType(t)}'`,
    );
  }
  return t;
}

/** short trace note per statement (prefixed with the fn-name stack inside fn bodies). */
export function noteOf(s: Stmt): string {
  switch (s.k) {
    case 'const':
      return `const ${stringifyType(s.type)}`;
    case 'bin':
      return `bin ${s.op}`;
    case 'un':
      return `un ${s.op}`;
    case 'modarith':
      return s.op;
    case 'env':
      return `env ${s.op}`;
    case 'convert':
      return 'convert';
    case 'select':
      return 'select';
    case 'index':
      return 'index';
    case 'len':
      return 'len';
    case 'slice':
      return 'slice';
    case 'arrnew':
      return `arrnew ${stringifyType(s.elem)}[]`;
    case 'arrset':
      return 'arrset';
    case 'tuplenew':
      return 'tuplenew';
    case 'field':
      return `field #${s.index}`;
    case 'tupleset':
      return `tupleset #${s.index}`;
    case 'encode':
      return `encode ${s.mode}`;
    case 'keccak256':
      return 'keccak256';
    case 'throw':
      return `throw errors[${s.error}]`;
    case 'cellnew':
      return `cellnew #${s.cell}`;
    case 'cellget':
      return `cellget #${s.cell}`;
    case 'cellset':
      return `cellset #${s.cell}`;
    case 'call':
      return `call ${s.fnAbi.name}() [${s.mode}] site ${s.site}`;
    case 'fncall':
      return `fncall fns[${s.fn}]`;
    case 'if':
      return 'if';
    case 'while':
      return 'while';
    case 'break':
      return 'break';
    case 'continue':
      return 'continue';
    default:
      return 'stmt';
  }
}
