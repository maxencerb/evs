/**
 * Unit tests — `core/bytes.ts`, the internal byte/hex/word codecs shared across modules.
 * These helpers replaced per-module copies (compile, interp, codegen, disasm), so the tests
 * pin the exact semantics every former call site relied on: past-the-end reads as zero,
 * two's-complement wrapping, and strict shape validation where advertised.
 */
import { describe, expect, test } from 'vitest';

import {
  bytesToBigInt,
  bytesToHex,
  HEX_BYTES_RE,
  hexToBytes,
  isHexString,
  padWordAligned,
  selectorBytes,
  u256ToBytes,
} from './bytes.js';
import { EvsInternalError } from './errors.js';

describe('isHexString / HEX_BYTES_RE', () => {
  test('accepts 0x-prefixed even-length hex (including empty)', () => {
    expect(isHexString('0x')).toBe(true);
    expect(isHexString('0x00')).toBe(true);
    expect(isHexString('0xdeadBEEF')).toBe(true);
  });

  test('rejects odd length, missing prefix, non-hex chars, non-strings', () => {
    expect(isHexString('0x0')).toBe(false);
    expect(isHexString('ff')).toBe(false);
    expect(isHexString('0xzz')).toBe(false);
    expect(isHexString(255)).toBe(false);
    expect(isHexString(null)).toBe(false);
    expect(HEX_BYTES_RE.test('0xabc')).toBe(false);
  });
});

describe('hexToBytes / bytesToHex', () => {
  test('round-trips byte-exactly', () => {
    expect(hexToBytes('0x')).toEqual(new Uint8Array(0));
    expect(hexToBytes('0x00ff10')).toEqual(new Uint8Array([0, 255, 16]));
    expect(bytesToHex(new Uint8Array([0, 255, 16]))).toBe('0x00ff10');
    expect(bytesToHex(hexToBytes('0xdeadbeef'))).toBe('0xdeadbeef');
  });

  test('bytesToHex slices [start, end) and reads past the end as zero bytes', () => {
    const bytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
    expect(bytesToHex(bytes, 1, 3)).toBe('0xbbcc');
    expect(bytesToHex(bytes, 0, 0)).toBe('0x');
    // the disassembler tolerates a truncated trailing push by reading zeros past the end
    expect(bytesToHex(bytes, 2, 5)).toBe('0xcc0000');
  });
});

describe('u256ToBytes / bytesToBigInt', () => {
  test('encodes big-endian 32-byte words', () => {
    expect(u256ToBytes(0n)).toEqual(new Uint8Array(32));
    const one = u256ToBytes(1n);
    expect(one[31]).toBe(1);
    expect(one.slice(0, 31)).toEqual(new Uint8Array(31));
    expect(u256ToBytes((1n << 256n) - 1n)).toEqual(new Uint8Array(32).fill(0xff));
  });

  test('wraps mod 2^256 with two’s complement for negative inputs', () => {
    expect(u256ToBytes(-1n)).toEqual(new Uint8Array(32).fill(0xff));
    expect(u256ToBytes(1n << 256n)).toEqual(new Uint8Array(32));
  });

  test('round-trips with bytesToBigInt', () => {
    for (const v of [0n, 1n, 255n, 1n << 128n, (1n << 256n) - 1n]) {
      expect(bytesToBigInt(u256ToBytes(v))).toBe(v);
    }
  });

  test('bytesToBigInt honors offset/size and reads past the end as zero', () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03]);
    expect(bytesToBigInt(bytes, 0, 2)).toBe(0x0102n);
    expect(bytesToBigInt(bytes, 1, 2)).toBe(0x0203n);
    // ABI word read over short data zero-fills the tail (the decoders rely on this)
    expect(bytesToBigInt(bytes, 0)).toBe(0x010203n << (8n * 29n));
    expect(bytesToBigInt(bytes, 2, 4)).toBe(0x03000000n);
  });
});

describe('padWordAligned', () => {
  test('pads up to the next 32-byte boundary without mutating the input', () => {
    expect(padWordAligned(new Uint8Array(0))).toEqual(new Uint8Array(0));
    const one = new Uint8Array([0xff]);
    const padded = padWordAligned(one);
    expect(padded.length).toBe(32);
    expect(padded[0]).toBe(0xff);
    expect(padded.slice(1)).toEqual(new Uint8Array(31));
    expect(one.length).toBe(1);
    expect(padWordAligned(new Uint8Array(32)).length).toBe(32);
    expect(padWordAligned(new Uint8Array(33)).length).toBe(64);
  });
});

describe('selectorBytes', () => {
  test('decodes exactly 4 selector bytes', () => {
    expect(selectorBytes('0x95d89b41', 'test')).toEqual(new Uint8Array([0x95, 0xd8, 0x9b, 0x41]));
  });

  test('rejects malformed selectors with the caller’s error prefix', () => {
    for (const bad of ['0x1234', '0x1234567890', '12345678', '0x1234567z']) {
      expect(() => selectorBytes(bad, 'codegen/test')).toThrow(EvsInternalError);
      expect(() => selectorBytes(bad, 'codegen/test')).toThrow(
        `codegen/test: malformed selector ${bad}`,
      );
    }
  });
});
