/**
 * Internal byte/hex/word codecs shared across modules. Dependency-light on purpose (errors
 * only) so every layer — ir, abi, asm, codegen, compile — can use it without cycles. Not part
 * of the public API surface (not re-exported from index.ts).
 */

import { EvsInternalError } from './errors.js';
import type { Hex } from './types.js';

/** 0x-prefixed, even-length hex body — the shape every byte-carrying `Hex` must have. */
export const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export function isHexString(v: unknown): v is Hex {
  return typeof v === 'string' && HEX_BYTES_RE.test(v);
}

/** Decodes 0x-hex into bytes. Assumes a valid even-length body — callers that take untrusted
 *  input validate first (via {@link isHexString} / {@link HEX_BYTES_RE}) to throw their own
 *  domain error. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array, start = 0, end = bytes.length): Hex {
  let s = '';
  for (let i = start; i < end; i++) {
    s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return `0x${s}`;
}

const MASK256 = (1n << 256n) - 1n;

/** Big-endian 32-byte image of `v mod 2^256` (negative inputs land as two's complement). */
export function u256ToBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v & MASK256;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Big-endian read of `size` bytes at `offset`; bytes past the end read as zero. */
export function bytesToBigInt(bytes: Uint8Array, offset = 0, size = 32): bigint {
  let v = 0n;
  for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(bytes[offset + i] ?? 0);
  return v;
}

/** Copy of `bytes` zero-padded up to the next 32-byte boundary. */
export function padWordAligned(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  out.set(bytes);
  return out;
}

/** The 4 selector bytes of `hex`, or an internal error prefixed with `errPrefix`. */
export function selectorBytes(hex: string, errPrefix: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{8}$/.test(hex)) {
    throw new EvsInternalError('INTERNAL', `${errPrefix}: malformed selector ${hex}`);
  }
  return hexToBytes(hex);
}
