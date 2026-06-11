/* oxlint-disable typescript/no-unsafe-type-assertion --
 * exhaustive-table tests cast generated type strings on purpose. */
import { describe, expect, test } from 'vitest';

import { EvsTypeError } from '../core/errors.js';
import type { WordType } from '../core/types.js';
import { headBytes, isDynamic, layoutOf, type TypeLayout } from './layout.js';

// ---------------------------------------------------------------------------
// the full v0 vocabulary, built independently of the implementation
// ---------------------------------------------------------------------------

const UINT_BITS = Array.from({ length: 32 }, (_, i) => 8 * (i + 1)); // 8..256
const BYTES_SIZES = Array.from({ length: 32 }, (_, i) => i + 1); // 1..32

// ---------------------------------------------------------------------------
// golden table over every v0 type
// ---------------------------------------------------------------------------

describe('layoutOf golden table', () => {
  test('uintN → right-aligned unsigned words', () => {
    for (const n of UINT_BITS) {
      expect(layoutOf(`uint${n}`)).toEqual({
        kind: 'word',
        abi: `uint${n}`,
        bits: n,
        signed: false,
        leftAligned: false,
      });
    }
  });

  test('intN → right-aligned signed words', () => {
    for (const n of UINT_BITS) {
      expect(layoutOf(`int${n}`)).toEqual({
        kind: 'word',
        abi: `int${n}`,
        bits: n,
        signed: true,
        leftAligned: false,
      });
    }
  });

  test('bytesN → LEFT-aligned words of 8N bits', () => {
    for (const n of BYTES_SIZES) {
      expect(layoutOf(`bytes${n}`)).toEqual({
        kind: 'word',
        abi: `bytes${n}`,
        bits: 8 * n,
        signed: false,
        leftAligned: true,
      });
    }
  });

  test('address / bool', () => {
    expect(layoutOf('address')).toEqual({
      kind: 'word',
      abi: 'address',
      bits: 160,
      signed: false,
      leftAligned: false,
    });
    expect(layoutOf('bool')).toEqual({
      kind: 'word',
      abi: 'bool',
      bits: 8, // canonical 0/1
      signed: false,
      leftAligned: false,
    });
  });

  test('string / bytes → bytes layouts', () => {
    expect(layoutOf('string')).toEqual({ kind: 'bytes', abi: 'string' });
    expect(layoutOf('bytes')).toEqual({ kind: 'bytes', abi: 'bytes' });
  });

  test('every word-element T[] → array layout wrapping the element word layout', () => {
    const wordTypes: string[] = [
      'address',
      'bool',
      ...UINT_BITS.flatMap((n) => [`uint${n}`, `int${n}`]),
      ...BYTES_SIZES.map((n) => `bytes${n}`),
    ];
    for (const w of wordTypes) {
      expect(layoutOf(`${w}[]`)).toEqual({
        kind: 'array',
        abi: `${w}[]`,
        elem: layoutOf(w),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// rejections
// ---------------------------------------------------------------------------

describe('layoutOf rejections', () => {
  const DEFERRED = [
    'tuple',
    'tuple[]',
    'tuple(uint256,address)',
    'uint256[2]',
    'address[3]',
    'uint256[][]',
    'address[][]',
    'string[]', // arrays of dynamic types are not v0
    'bytes[]',
  ];
  const UNKNOWN = [
    '',
    'uint',
    'uint7',
    'uint0',
    'uint264',
    'bytes0',
    'bytes33',
    'function',
    'Uint256',
    '(uint256)',
  ];

  test.each(DEFERRED)('%j → EvsTypeError(UNSUPPORTED_V0)', (s) => {
    let caught: unknown;
    try {
      layoutOf(s);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvsTypeError);
    expect((caught as EvsTypeError).code).toBe('UNSUPPORTED_V0');
    expect((caught as EvsTypeError).message).toContain(JSON.stringify(s));
  });

  test.each(UNKNOWN)('%j → EvsTypeError(TYPE_MISMATCH)', (s) => {
    let caught: unknown;
    try {
      layoutOf(s);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvsTypeError);
    expect((caught as EvsTypeError).code).toBe('TYPE_MISMATCH');
    expect((caught as EvsTypeError).message).toContain(JSON.stringify(s));
  });
});

// ---------------------------------------------------------------------------
// isDynamic / headBytes
// ---------------------------------------------------------------------------

describe('isDynamic', () => {
  test('words are static; string/bytes/T[] are dynamic', () => {
    expect(isDynamic(layoutOf('uint256'))).toBe(false);
    expect(isDynamic(layoutOf('int8'))).toBe(false);
    expect(isDynamic(layoutOf('address'))).toBe(false);
    expect(isDynamic(layoutOf('bool'))).toBe(false);
    expect(isDynamic(layoutOf('bytes32'))).toBe(false);
    expect(isDynamic(layoutOf('string'))).toBe(true);
    expect(isDynamic(layoutOf('bytes'))).toBe(true);
    expect(isDynamic(layoutOf('uint256[]'))).toBe(true);
    expect(isDynamic(layoutOf('bytes32[]'))).toBe(true);
  });

  test('hand-built layouts (independent of layoutOf)', () => {
    const word: TypeLayout = {
      kind: 'word',
      abi: 'uint8' as WordType,
      bits: 8,
      signed: false,
      leftAligned: false,
    };
    expect(isDynamic(word)).toBe(false);
    expect(isDynamic({ kind: 'bytes', abi: 'string' })).toBe(true);
  });
});

describe('headBytes', () => {
  test('32 × params.length, regardless of static/dynamic mix', () => {
    expect(headBytes([])).toBe(0);
    expect(headBytes([{ name: 'a', type: 'uint256' }])).toBe(32);
    expect(
      headBytes([
        { name: 'a', type: 'uint8' },
        { name: 'b', type: 'string' },
        { name: 'c', type: 'address[]' },
      ]),
    ).toBe(96);
  });

  test('non-v0 param types fail loudly instead of mis-sizing the head', () => {
    expect(() =>
      headBytes([
        { name: 'a', type: 'uint256' },
        { name: 'b', type: 'tuple', components: [{ name: 'x', type: 'uint256' }] },
      ]),
    ).toThrowError(EvsTypeError);
    expect(() => headBytes([{ name: 'a', type: 'uint256[2]' }])).toThrowError(EvsTypeError);
  });
});
