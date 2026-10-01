/* oxlint-disable typescript/no-unsafe-type-assertion --
 * exhaustive-table tests cast generated type strings on purpose. */
import { describe, expect, test } from 'vite-plus/test';

import { EvsTypeError } from '../core/errors.js';
import { staticSizeOf, t, type EvsType, type TupleType, type WordType } from '../core/types.js';
import {
  arrayDecodeCharge,
  tupleDecodeCharge,
  headBytes,
  isDynamic,
  layoutOf,
  layoutOfType,
  staticSize,
  type TypeLayout,
} from './layout.js';

// ---------------------------------------------------------------------------
// the full evs type vocabulary, built independently of the implementation
// ---------------------------------------------------------------------------

const UINT_BITS = Array.from({ length: 32 }, (_, i) => 8 * (i + 1)); // 8..256
const BYTES_SIZES = Array.from({ length: 32 }, (_, i) => i + 1); // 1..32

// ---------------------------------------------------------------------------
// golden table over every evs type
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
        length: null,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// rejections
// ---------------------------------------------------------------------------

describe('layoutOf rejections', () => {
  // tuples are descriptor OBJECTS (`layoutOfType`); a tuple type STRING is a misuse, and a
  // malformed array suffix is not a type. Both are TYPE_MISMATCH (nothing is "not supported yet"
  // in the array vocabulary since issue #4).
  const TUPLE_STRINGS = ['tuple', 'tuple[]', 'tuple(uint256,address)'];
  const BAD_SUFFIX = [
    'uint256[0]',
    'uint256[01]',
    'address[x]',
    'uint256[]]',
    'uint256[4294967296]',
  ];
  // every array shape produces a layout: composite elements, any depth, fixed sizes.
  const SUPPORTED = [
    'uint256[][]',
    'address[][]',
    'string[]',
    'bytes[]',
    'uint256[][][]',
    'string[][]',
    'uint256[2]',
    'address[3]',
    'string[2]',
    'uint256[2][]',
    'uint256[][2]',
    'bytes[3][2][]',
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

  test.each(TUPLE_STRINGS)('%j → EvsTypeError(TYPE_MISMATCH): tuples are descriptors', (s) => {
    let caught: unknown;
    try {
      layoutOf(s);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvsTypeError);
    expect((caught as EvsTypeError).code).toBe('TYPE_MISMATCH');
    expect((caught as EvsTypeError).message).toContain(JSON.stringify(s));
    expect((caught as EvsTypeError).message).toContain('descriptor');
  });

  test.each(BAD_SUFFIX)('%j → EvsTypeError(TYPE_MISMATCH): malformed suffix', (s) => {
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

  test.each(SUPPORTED)('%j → array layout', (s) => {
    const l = layoutOf(s);
    expect(l.kind).toBe('array');
    expect(l.abi).toBe(s);
  });

  test('STILL gated (#4): arrays nested deeper than 4 levels → UNSUPPORTED_V0', () => {
    for (const s of ['uint256[][][][][]', 'string[2][][][][]', 'bytes[1][1][1][1][1]']) {
      let caught: unknown;
      try {
        layoutOf(s);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      expect((caught as EvsTypeError).code).toBe('UNSUPPORTED_V0');
    }
    const tooDeep: TupleType = {
      type: 'tuple[][][][][]',
      components: [{ name: 'x', type: 'uint256' }],
    };
    expect(() => layoutOfType(tooDeep)).toThrowError(/at most 4 levels/);
    // a tuple component carrying a too-deep array is rejected through its member layout
    expect(() =>
      layoutOfType({ type: 'tuple', components: [{ name: 'x', type: 'uint8[][][][][]' }] }),
    ).toThrowError(/at most 4 levels/);
    expect(layoutOf('uint256[][][][]').kind).toBe('array');
  });

  test('fixed-size layouts carry their length; dynamic ones null', () => {
    expect(layoutOf('uint256[2]')).toEqual({
      kind: 'array',
      abi: 'uint256[2]',
      elem: layoutOf('uint256'),
      length: 2,
    });
    expect(layoutOf('uint256[2][]')).toMatchObject({ length: null, elem: { length: 2 } });
    expect(layoutOf('uint256[][2]')).toMatchObject({ length: 2, elem: { length: null } });
    expect(layoutOfType(t.array(t.struct({ a: t.uint8 }), 3))).toMatchObject({
      kind: 'array',
      abi: 'tuple[3]',
      length: 3,
      elem: { kind: 'tuple', dynamic: false },
    });
    expect(layoutOfType(t.array(t.array(t.struct({ a: t.uint8 }))))).toMatchObject({
      abi: 'tuple[][]',
      length: null,
      elem: { kind: 'array', abi: 'tuple[]', elem: { kind: 'tuple' } },
    });
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

  test('fixed-size arrays are static iff their element is (ABI spec); staticSize inlines N·elem', () => {
    expect(isDynamic(layoutOf('uint256[2]'))).toBe(false);
    expect(staticSize(layoutOf('uint256[2]'))).toBe(64);
    expect(isDynamic(layoutOf('uint256[2][3]'))).toBe(false);
    expect(staticSize(layoutOf('uint256[2][3]'))).toBe(192);
    expect(isDynamic(layoutOf('string[2]'))).toBe(true);
    expect(isDynamic(layoutOf('uint256[][2]'))).toBe(true);
    expect(isDynamic(layoutOf('uint256[2][]'))).toBe(true);
    const staticTuple2 = layoutOfType(t.array(t.struct({ a: t.uint8, b: t.address }), 2));
    expect(isDynamic(staticTuple2)).toBe(false);
    expect(staticSize(staticTuple2)).toBe(128);
    expect(isDynamic(layoutOfType(t.array(t.struct({ a: t.string }), 2)))).toBe(true);
    // a static fixed array inlines into the head like a static tuple
    expect(
      headBytes([
        { name: '', type: 'uint256[2]' },
        { name: '', type: 'string[2]' },
      ]),
    ).toBe(96);
    expect(() => staticSize(layoutOf('string[2]'))).toThrow(/dynamic/);
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

  test('static tuple params inline their whole head (cumulative walk); unsupported types fail loudly', () => {
    // a STATIC inner tuple occupies headBytes(components) head words, NOT one offset word
    expect(
      headBytes([
        { name: 'a', type: 'uint256' },
        {
          name: 'b',
          type: 'tuple',
          components: [
            { name: 'x', type: 'uint256' },
            { name: 'y', type: 'uint8' },
          ],
        },
      ]),
    ).toBe(32 + 64);
    // a DYNAMIC tuple is a single offset-pointer head word
    expect(
      headBytes([{ name: 'b', type: 'tuple', components: [{ name: 'x', type: 'string' }] }]),
    ).toBe(32);
    // a STATIC fixed-size array inlines its N elements (issue #4); a malformed type throws
    expect(() => headBytes([{ name: 'a', type: 'uint256[0]' }])).toThrowError(EvsTypeError);
    expect(headBytes([{ name: 'a', type: 'uint256[2]' }])).toBe(64);
  });
});

describe('staticSize', () => {
  test('a word is 32 bytes; a static tuple inlines what headBytes gives its components', () => {
    expect(staticSize(layoutOf('uint8'))).toBe(32);
    const components = [
      { name: 'a', type: 'uint256' },
      {
        name: 'b',
        type: 'tuple',
        components: [
          { name: 'x', type: 'address' },
          { name: 'y', type: 'tuple', components: [{ name: 'z', type: 'bytes4' }] },
        ],
      },
    ] as const;
    const nested = layoutOfType({ type: 'tuple', components } as unknown as TupleType);
    expect(staticSize(nested)).toBe(32 * 3);
    expect(staticSize(nested)).toBe(headBytes(components));
  });

  test('a dynamic layout has no static size', () => {
    expect(() => staticSize(layoutOf('string'))).toThrow(/is dynamic/);
    const dynTuple = layoutOfType({
      type: 'tuple',
      components: [{ name: 'x', type: 'bytes' }],
    } as unknown as TupleType);
    expect(() => staticSize(dynTuple)).toThrow(/is dynamic/);
  });
});

// ---------------------------------------------------------------------------
// pathological sizes (regression: a RangeError / an INTERNAL push instead of a coded error)
// ---------------------------------------------------------------------------

/** The `EvsTypeError` code `fn` throws (any other error, or none, fails the test). */
function codeOf(fn: () => unknown): string {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EvsTypeError);
  return (caught as EvsTypeError).code;
}

describe('pathological sizes', () => {
  test('a 50,000-suffix chain is rejected before any recursion (UNSUPPORTED_V0, no RangeError)', () => {
    expect(codeOf(() => layoutOf(`uint256${'[]'.repeat(50_000)}`))).toBe('UNSUPPORTED_V0');
    expect(codeOf(() => layoutOf(`string${'[3]'.repeat(50_000)}`))).toBe('UNSUPPORTED_V0');
    // a malformed leaf keeps its TYPE_MISMATCH precedence over the depth gate
    expect(codeOf(() => layoutOf(`uint7${'[]'.repeat(50_000)}`))).toBe('TYPE_MISMATCH');
    expect(codeOf(() => layoutOf(`tuple${'[]'.repeat(50_000)}`))).toBe('TYPE_MISMATCH');
    const deepTuple = {
      type: `tuple${'[]'.repeat(50_000)}`,
      components: [{ name: 'x', type: 'uint256' }],
    } as unknown as TupleType;
    expect(codeOf(() => layoutOfType(deepTuple))).toBe('UNSUPPORTED_V0');
    expect(codeOf(() => headBytes([{ name: 'a', type: `address${'[]'.repeat(50_000)}` }]))).toBe(
      'UNSUPPORTED_V0',
    );
  });

  test('a static size of 2^32 bytes or more is UNSUPPORTED_V0, never an unsafe-integer size', () => {
    // just below the cap: 32 · (2^27 − 1) = 2^32 − 32 bytes
    expect(staticSize(layoutOf('uint256[134217727]'))).toBe(2 ** 32 - 32);
    expect(headBytes([{ name: 'a', type: 'uint256[134217727]' }])).toBe(2 ** 32 - 32);
    const tooBig = [
      () => layoutOf('uint256[134217728]'),
      // 3.2e17 bytes: compile() used to push this past 2^53 and fail with INTERNAL
      () => layoutOf('uint256[100000000][100000000]'),
      () => headBytes([{ name: 'a', type: 'uint256[100000000][100000000]' }]),
      () => layoutOf('bytes32[4294967295][4294967295][4294967295][4294967295]'),
      // hand-built descriptors (deserialized IR, raw ABI) skip the `t` gates; layout still catches them
      () =>
        layoutOfType({
          type: 'tuple',
          components: [
            { name: 'a', type: 'uint256[67108864]' },
            { name: 'b', type: 'uint256[67108864]' },
          ],
        } as unknown as TupleType),
      () =>
        layoutOfType({
          type: 'tuple[100000000]',
          components: [{ name: 'a', type: 'uint256[100]' }],
        } as unknown as TupleType),
    ];
    for (const fn of tooBig) expect(codeOf(fn)).toBe('UNSUPPORTED_V0');
    expect(() => layoutOf('uint256[100000000][100000000]')).toThrowError(
      /ABI static size of 320000000000000000 bytes — at most 2\^32 − 1/,
    );
    // ABI-dynamic shapes inline one offset word whatever their element count
    expect(isDynamic(layoutOf('string[100000000][100000000]'))).toBe(true);
    expect(headBytes([{ name: 'a', type: 'uint256[100000000][]' }])).toBe(32);
  });

  test('staticSizeOf (core/types, over the type) agrees with staticSize (over the layout)', () => {
    const types: EvsType[] = [
      'uint8',
      'bytes32[3]',
      'uint256[2][3]',
      'string',
      'uint256[]',
      'string[2]',
      t.struct({ a: t.uint8, b: t.array(t.address, 4) }),
      t.array(t.struct({ a: t.uint8, b: t.tuple(t.bool, t.uint16) }), 5),
      t.array(t.struct({ a: t.uint8, s: t.string }), 2),
    ];
    for (const type of types) {
      const layout = layoutOfType(type);
      expect(staticSizeOf(type)).toBe(isDynamic(layout) ? null : BigInt(staticSize(layout)));
    }
  });
});

// ---------------------------------------------------------------------------
// memoization (regression: layouts are cached per type and treated as immutable)
// ---------------------------------------------------------------------------

describe('layout memoization', () => {
  test('layoutOf returns one cached object per type string', () => {
    expect(layoutOf('uint256')).toBe(layoutOf('uint256'));
    expect(layoutOf('uint8[]')).toBe(layoutOf('uint8[]'));
    expect(layoutOf('string')).toBe(layoutOf('string'));
  });

  test('layoutOfType caches per tuple descriptor; equal descriptors stay layout-equal', () => {
    const a: TupleType = {
      type: 'tuple',
      components: [
        { name: 'x', type: 'uint256' },
        { name: 's', type: 'string' },
      ],
    };
    const b: TupleType = { type: 'tuple', components: [...a.components] };
    expect(layoutOfType(a)).toBe(layoutOfType(a)); // same descriptor → cached object
    expect(layoutOfType(b)).not.toBe(layoutOfType(a)); // distinct descriptors…
    expect(layoutOfType(b)).toEqual(layoutOfType(a)); // …but identical layouts
    expect(layoutOfType(a)).toEqual({
      kind: 'tuple',
      abi: 'tuple',
      dynamic: true,
      components: [layoutOf('uint256'), layoutOf('string')],
    });
  });

  test('malformed types still throw (failures are not cached as layouts)', () => {
    const bad: TupleType = {
      type: 'tuple[0]',
      components: [{ name: 'x', type: 'uint256' }],
    };
    expect(() => layoutOfType(bad)).toThrowError(EvsTypeError);
    expect(() => layoutOfType(bad)).toThrowError(EvsTypeError); // idempotent across calls
    expect(() => layoutOf('uint256[0]')).toThrowError(EvsTypeError);
    expect(() => layoutOf('uint256[0]')).toThrowError(EvsTypeError);
    // a `tuple[][]` descriptor is a layout now (issue #4), cached per descriptor
    const arr2: TupleType = { type: 'tuple[][]', components: [{ name: 'x', type: 'uint256' }] };
    expect(layoutOfType(arr2)).toBe(layoutOfType(arr2));
  });
});

describe('decode-work budget charges (shared by codegen and the interpreter)', () => {
  const arrayCharge = (type: string | TupleType, topLevel: boolean, repeated: boolean) => {
    const l = typeof type === 'string' ? layoutOf(type) : layoutOfType(type);
    if (l.kind !== 'array') throw new Error(`${JSON.stringify(type)} is not an array`);
    return arrayDecodeCharge(l, topLevel, repeated);
  };
  const tupleCharge = (type: TupleType, repeated: boolean) => {
    const l = layoutOfType(type);
    if (l.kind !== 'tuple') throw new Error('not a tuple');
    return tupleDecodeCharge(l, repeated);
  };

  test('a dynamic-length T[] charges its length word plus its body, wherever it sits', () => {
    for (const [topLevel, repeated] of [
      [false, false],
      [false, true],
      [true, false],
    ] as const) {
      for (const type of ['uint8[]', 'address[]', 'bool[]', 'int8[]', 'bytes4[]']) {
        if (topLevel) continue; // a narrow output is not charged (below)
        expect(arrayCharge(type, topLevel, repeated)).toEqual({ fixed: 32, perElem: 32 });
      }
      for (const type of ['string[]', 'bytes[]', 'uint256[][]', 'uint8[][]', 'string[2][]']) {
        expect(arrayCharge(type, topLevel, repeated)).toEqual({ fixed: 32, perElem: 32 });
      }
      // static composite elements are inlined in the body: charged at their static size
      expect(arrayCharge('uint256[2][]', topLevel, repeated)).toEqual({ fixed: 32, perElem: 64 });
      const wide = { type: 'tuple[]', components: [{ name: 'a', type: 'uint256[3]' }] } as const;
      expect(arrayCharge(wide, topLevel, repeated)).toEqual({ fixed: 32, perElem: 96 });
    }
  });

  test('aliased word arrays, narrow outputs and static T[N] are never charged', () => {
    for (const repeated of [false, true]) {
      for (const type of ['uint256[]', 'int256[]', 'bytes32[]']) {
        expect(arrayCharge(type, false, repeated)).toBeNull();
      }
      for (const type of ['uint8[2]', 'uint256[2][3]']) {
        expect(arrayCharge(type, false, repeated)).toBeNull();
      }
    }
    expect(arrayCharge('uint8[]', true, false)).toBeNull();
    expect(arrayCharge('address[]', true, false)).toBeNull();
  });

  test('a dynamic T[N] and a dynamic tuple are charged only inside an ABI-dynamic array', () => {
    for (const type of ['string[3]', 'uint256[][2]', 'uint8[][4]']) {
      expect(arrayCharge(type, false, false)).toBeNull();
    }
    expect(arrayCharge('string[3]', false, true)).toEqual({ fixed: 96, perElem: 0 });
    expect(arrayCharge('uint8[][4]', false, true)).toEqual({ fixed: 128, perElem: 0 });

    const dyn: TupleType = {
      type: 'tuple',
      components: [
        { name: 'a', type: 'uint256' },
        { name: 'p', type: 'tuple', components: [{ name: 'x', type: 'uint8[2]' }] },
        { name: 's', type: 'string' },
      ],
    };
    expect(tupleCharge(dyn, false)).toBeNull();
    expect(tupleCharge(dyn, true)).toBe(32 + 64 + 32); // its head
    const stat: TupleType = { type: 'tuple', components: [{ name: 'a', type: 'uint256' }] };
    expect(tupleCharge(stat, true)).toBeNull(); // inlined, charged with its holder
  });
});
