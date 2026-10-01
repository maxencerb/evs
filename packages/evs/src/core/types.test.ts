/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-base-to-string, typescript/no-unnecessary-template-expression --
 * exhaustive-table tests cast generated type strings on purpose, and the staging-trap suite
 * deliberately performs the host coercions the traps exist to intercept. */
import { describe, expect, test } from 'vite-plus/test';

import { evscript } from '../builder/script.js';
import { EvsInternalError, EvsStagingError, EvsTypeError, type EvsErrorCode } from './errors.js';
import {
  arrayDepthOf,
  bitsOf,
  elemTypeOf,
  fixedLengthOf,
  gateStaticLevels,
  installStagingTraps,
  isTupleTag,
  peelArraySuffix,
  isMemrefType,
  isStringType,
  isEvsValueType,
  isNumeric,
  isSigned,
  isTupleType,
  isWordType,
  MAX_ARRAY_DEPTH,
  MAX_STATIC_SIZE,
  namedArg,
  t,
  staticSizeOf,
  typesEqual,
  wordStaticSize,
  type ArrayType,
  type EvsType,
  type TupleType,
  type WordType,
} from './types.js';

// ---------------------------------------------------------------------------
// the full evs type vocabulary, built independently of the implementation
// ---------------------------------------------------------------------------

const UINT_BITS = Array.from({ length: 32 }, (_, i) => 8 * (i + 1)); // 8..256
const BYTES_SIZES = Array.from({ length: 32 }, (_, i) => i + 1); // 1..32

const UINT_TYPES = UINT_BITS.map((n) => `uint${n}`);
const INT_TYPES = UINT_BITS.map((n) => `int${n}`);
const BYTES_TYPES = BYTES_SIZES.map((n) => `bytes${n}`);
const WORD_TYPES = ['address', 'bool', ...UINT_TYPES, ...INT_TYPES, ...BYTES_TYPES];
const DYN_TYPES = ['string', 'bytes'];
const ARRAY_TYPES = WORD_TYPES.map((w) => `${w}[]`);
const ALL_EVS_TYPES = [...WORD_TYPES, ...DYN_TYPES, ...ARRAY_TYPES];

// Nested arrays (`uint256[][]`, `string[]`, …) are in the string-encoded vocabulary and
// `isStringType` accepts them. `tuple`/`tuple[]` are NOT string-encoded (they are TupleType
// objects), so `isStringType` rejects those strings.
const REJECTED = [
  '',
  'uint',
  'int',
  'uint7',
  'uint0',
  'uint264',
  'uint08', // non-canonical spelling
  'int7',
  'int512',
  'bytes0',
  'bytes33',
  'tuple',
  'tuple[]',
  'uint256[0]',
  'address[01]',
  'uint256[x]',
  'uint256[4294967296]',
  'function',
  'Uint256',
  ' uint256',
  'uint256 ',
];

describe('isStringType / isWordType (exhaustive table)', () => {
  test(`accepts every evs type string (${ALL_EVS_TYPES.length} total)`, () => {
    expect(WORD_TYPES).toHaveLength(98);
    expect(ALL_EVS_TYPES).toHaveLength(198);
    for (const s of ALL_EVS_TYPES) expect(isStringType(s)).toBe(true);
    for (const s of WORD_TYPES) expect(isWordType(s)).toBe(true);
    for (const s of [...DYN_TYPES, ...ARRAY_TYPES]) expect(isWordType(s)).toBe(false);
  });

  test('rejects unsupported type strings', () => {
    for (const s of REJECTED) {
      expect(isStringType(s)).toBe(false);
      expect(isWordType(s)).toBe(false);
    }
  });

  test('accepts fixed-size arrays and any nesting depth (issue #4)', () => {
    for (const s of [
      'uint256[2]',
      'address[3]',
      'string[2]',
      'uint256[2][]',
      'uint256[][2]',
      'uint256[][][]',
      'string[][]',
      'bytes[][3][]',
      'uint8[99][99][99][99]',
    ]) {
      expect(isStringType(s)).toBe(true);
      expect(isMemrefType(s as EvsType)).toBe(true);
    }
    expect(peelArraySuffix('uint256[2][]')).toEqual({ inner: 'uint256[2]', length: null });
    expect(peelArraySuffix('uint256[][2]')).toEqual({ inner: 'uint256[]', length: 2 });
    expect(peelArraySuffix('uint256')).toBeNull();
    expect(peelArraySuffix('uint256[0]')).toBeNull();
    expect(fixedLengthOf('uint256[2]')).toBe(2);
    expect(fixedLengthOf('uint256[2][]')).toBeNull();
    expect(fixedLengthOf(t.array(t.struct({ a: t.uint8 }), 4))).toBe(4);
    // a non-array type never reaches it from user input: an internal error
    expect(() => fixedLengthOf('uint256' as ArrayType)).toThrow(EvsInternalError);
    expect(isTupleTag('tuple[2][]')).toBe(true);
    expect(isTupleTag('tuple[0]')).toBe(false);
    expect(isTupleTag('tuple(uint256)')).toBe(false);
  });
});

describe('bitsOf (exhaustive table)', () => {
  test('address→160, bool→8 (canonical 0/1), bytesN→8N, uintN/intN→N', () => {
    expect(bitsOf('address')).toBe(160);
    expect(bitsOf('bool')).toBe(8);
    for (const n of UINT_BITS) {
      expect(bitsOf(`uint${n}` as WordType)).toBe(n);
      expect(bitsOf(`int${n}` as WordType)).toBe(n);
    }
    for (const n of BYTES_SIZES) {
      expect(bitsOf(`bytes${n}` as WordType)).toBe(8 * n);
    }
  });

  test('throws EvsInternalError on a non-word type (callers classify first)', () => {
    for (const s of ['uint7', 'string', 'address[]', 'tuple']) {
      expect(() => bitsOf(s as WordType)).toThrow(EvsInternalError);
    }
  });
});

describe('predicates', () => {
  test('isNumeric: uintN/intN only', () => {
    for (const s of [...UINT_TYPES, ...INT_TYPES]) expect(isNumeric(s as EvsType)).toBe(true);
    for (const s of ['address', 'bool', 'bytes32', 'string', 'bytes', 'uint8[]', 'int8[]']) {
      expect(isNumeric(s as EvsType)).toBe(false);
    }
  });

  test('isSigned: intN → true, everything else → false', () => {
    for (const s of INT_TYPES) expect(isSigned(s as EvsType)).toBe(true);
    for (const s of [...UINT_TYPES, 'address', 'bool', 'bytes32', 'string', 'int8[]']) {
      expect(isSigned(s as EvsType)).toBe(false);
    }
  });

  test('isMemrefType: string | bytes | T[]', () => {
    for (const s of [...DYN_TYPES, ...ARRAY_TYPES]) expect(isMemrefType(s as EvsType)).toBe(true);
    for (const s of WORD_TYPES) expect(isMemrefType(s as EvsType)).toBe(false);
  });

  test('elemTypeOf round-trips every array type', () => {
    for (const w of WORD_TYPES) expect(elemTypeOf(`${w}[]`)).toBe(w);
    // nested string arrays peel one [] (now in the vocabulary)
    expect(elemTypeOf('string[]')).toBe('string');
    expect(elemTypeOf('uint256[][]')).toBe('uint256[]');
    // fixed-size suffixes peel too, outermost first
    expect(elemTypeOf('uint256[2]')).toBe('uint256');
    expect(elemTypeOf('uint256[2][]')).toBe('uint256[2]');
    expect(elemTypeOf('uint256[][2]')).toBe('uint256[]');
    expect(elemTypeOf('uint256[][][]')).toBe('uint256[][]');
    // non-array strings (and the non-string `tuple[]` tag) have no string element type
    for (const s of ['string', 'uint256', 'tuple[]']) {
      expect(() => elemTypeOf(s as ArrayType)).toThrow(EvsInternalError);
    }
  });
});

describe('namedArg()', () => {
  test('returns a frozen ArgSpec', () => {
    const a = namedArg('pool', t.address);
    expect(a).toEqual({ name: 'pool', type: 'address' });
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('accepts identifier names', () => {
    for (const name of ['_x', 'A1', 'pool_2', 'camelCase', '__proto', 'x']) {
      expect(namedArg(name, 'uint256').name).toBe(name);
    }
  });

  test('rejects invalid names with EvsTypeError', () => {
    for (const name of ['', '1abc', 'a-b', 'a b', 'é', 'foo.bar', 'a$', ' x']) {
      let caught: unknown;
      try {
        namedArg(name, 'uint256');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('TYPE_MISMATCH');
      expect(err.message).toContain(JSON.stringify(name));
    }
  });

  test('rejects unknown type strings with TYPE_MISMATCH', () => {
    for (const type of ['uint7', 'bytes33', 'Uint256', 'foo']) {
      let caught: unknown;
      try {
        namedArg('x', type as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('TYPE_MISMATCH');
    }
  });

  test('accepts composite (t.struct/t.tuple) types — the full EvsType vocabulary (issue #25)', () => {
    const MarketParams = t.struct({ loanToken: t.address, lltv: t.uint256 });
    const named = namedArg('marketParams', MarketParams);
    expect(named.name).toBe('marketParams');
    expect(named.type).toBe(MarketParams); // the descriptor passes through untouched
    expect(Object.isFrozen(named)).toBe(true);

    const positional = t.tuple(t.address, t.uint24);
    expect(namedArg('pair', positional).type).toBe(positional);
    const structArray = t.array(MarketParams);
    expect(namedArg('markets', structArray).type).toBe(structArray);
  });

  test('rejects malformed tuple descriptors with TYPE_MISMATCH (issue #25)', () => {
    const bad = [
      { type: 'tuple' }, // no components
      { type: 'tuple', components: [{ name: 'x', type: 'uint7' }] }, // invalid member type
      { notAType: true },
      42n,
    ];
    for (const type of bad) {
      let caught: unknown;
      try {
        namedArg('x', type as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('TYPE_MISMATCH');
    }
  });

  test('accepts fixed-size arrays; a malformed suffix is TYPE_MISMATCH with the explanation', () => {
    for (const type of ['address[3]', 'uint256[2]', 'address[3][]', 'string[][2]']) {
      expect(namedArg('x', type as never).type).toBe(type);
    }
    for (const type of ['address[0]', 'uint256[01]', 'address[3][x]']) {
      let caught: unknown;
      try {
        namedArg('x', type as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('TYPE_MISMATCH');
      expect(err.message).toContain('malformed array suffix');
    }
    // a tuple written as a STRING is a misuse, explained as such
    let caught: unknown;
    try {
      namedArg('x', 'tuple[]' as never);
    } catch (e) {
      caught = e;
    }
    expect((caught as EvsTypeError).code).toBe('TYPE_MISMATCH');
    expect((caught as EvsTypeError).message).toContain('descriptor');
  });
});

describe('t namespace', () => {
  test('every WordType key + string + bytes, identity-mapped', () => {
    for (const s of [...WORD_TYPES, ...DYN_TYPES]) {
      expect((t as Record<string, unknown>)[s]).toBe(s);
    }
    // 98 word types + string + bytes + array() + struct() + tuple() + error() +
    // fromOutputs() + fromAbiParameter() = 106 keys
    expect(Object.keys(t)).toHaveLength(106);
  });

  test('is frozen', () => {
    expect(Object.isFrozen(t)).toBe(true);
  });

  test('t.array builds array types and validates eagerly', () => {
    expect(t.array(t.address)).toBe('address[]');
    expect(t.array('uint24')).toBe('uint24[]');
    // dynamic/array element types are in the vocabulary
    expect(t.array('string' as WordType)).toBe('string[]');
    expect(t.array('uint24[]' as WordType)).toBe('uint24[][]');
    // any depth (issue #4)
    expect(t.array(t.array(t.array(t.uint256)))).toBe('uint256[][][]');
    // genuinely-invalid element types still throw eagerly
    expect(() => t.array('uint7' as WordType)).toThrow(EvsTypeError);
  });

  test('t.array(elem, n) builds fixed-size array types (issue #4)', () => {
    expect(t.array(t.uint256, 2)).toBe('uint256[2]');
    expect(t.array(t.array(t.uint256, 2))).toBe('uint256[2][]');
    expect(t.array(t.array(t.string), 3)).toBe('string[][3]');
    expect(t.array(t.array(t.uint256, 2), 3)).toBe('uint256[2][3]');
    const P = t.struct({ a: t.uint8 });
    expect(t.array(P, 2)).toEqual({ type: 'tuple[2]', components: [{ name: 'a', type: 'uint8' }] });
    expect(t.array(t.array(P), 2).type).toBe('tuple[][2]');
    expect(t.array(t.array(P, 2)).type).toBe('tuple[2][]');
    expect(elemTypeOf(t.array(P, 2))).toEqual(P);
    // the length must be a positive integer below 2^32
    for (const n of [0, -1, 1.5, 2 ** 32, 'x']) {
      expect(() => t.array(t.uint256, n as never)).toThrow(EvsTypeError);
    }
  });

  test('STILL gated (#4): arrays nest at most MAX_ARRAY_DEPTH levels → UNSUPPORTED_V0', () => {
    expect(MAX_ARRAY_DEPTH).toBe(4);
    expect(arrayDepthOf('uint256')).toBe(0);
    expect(arrayDepthOf('uint256[2][]')).toBe(2);
    expect(arrayDepthOf('tuple[][3][]')).toBe(3);
    const four = t.array(t.array(t.array(t.array(t.uint256))));
    expect(four).toBe('uint256[][][][]');
    const P = t.struct({ a: t.uint8 });
    const fourTuple = t.array(t.array(t.array(t.array(P), 2)));
    expect(fourTuple.type).toBe('tuple[][2][][]');
    const deep = [
      () => t.array(four),
      () => t.array(four as never, 2),
      () => t.array(fourTuple),
      () => namedArg('x', 'uint256[][][][][]' as never),
      () => namedArg('x', 'string[2][][][][]' as never),
    ];
    for (const build of deep) {
      let caught: unknown;
      try {
        build();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      expect((caught as EvsTypeError).code).toBe('UNSUPPORTED_V0');
      expect((caught as EvsTypeError).message).toMatch(/nests arrays 5 levels deep — at most 4/);
    }
    // the structural predicate still recognizes the vocabulary; only the ceiling is gated
    expect(isStringType('uint256[][][][][]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pathological type sizes: hostile suffix chains and static sizes past MAX_STATIC_SIZE
// ---------------------------------------------------------------------------

/** The code (and message) a type constructor throws, failing on a non-evs error or no throw. */
function codeOf(build: () => unknown): { code: string; message: string } {
  let caught: unknown;
  try {
    build();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EvsTypeError);
  return { code: (caught as EvsTypeError).code, message: (caught as EvsTypeError).message };
}

describe('pathological type sizes', () => {
  // 50,000 suffixes overflowed the host stack (a raw RangeError) before the depth gate ran
  const deep = `uint256${'[]'.repeat(50_000)}`;
  const outputsAbi = (type: string) =>
    [
      {
        type: 'function',
        name: 'f',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type }],
      },
    ] as const;

  test('a 50,000-suffix chain is UNSUPPORTED_V0 at every t entry point, not a RangeError', () => {
    const entries: (() => unknown)[] = [
      () => t.array(deep as never),
      () => t.array(deep as never, 2),
      () => t.fromAbiParameter({ name: '', type: deep } as never),
      () => t.fromOutputs(outputsAbi(deep) as never, 'f' as never),
      () => t.struct({ x: deep as never }),
      () => t.tuple(deep as never),
      () => namedArg('x', deep as never),
      () =>
        t.fromAbiParameter({
          name: '',
          type: `tuple${'[]'.repeat(50_000)}`,
          components: [{ name: 'a', type: 'uint8' }],
        } as never),
      () =>
        t.struct({
          x: { type: `tuple${'[2]'.repeat(50_000)}`, components: [{ name: 'a', type: 'uint8' }] },
        } as never),
    ];
    for (const build of entries) {
      const { code, message } = codeOf(build);
      expect(code).toBe('UNSUPPORTED_V0');
      expect(message).toMatch(/nests arrays 50000 levels deep — at most 4/);
      // the type is quoted cut short, not 100,000 characters verbatim
      expect(message.length).toBeLessThan(400);
      expect(message).toMatch(/"… \(\d{6} characters\)/);
    }
    // the structural predicate stays a total function (no depth gate, no recursion)
    expect(isStringType(deep)).toBe(true);
    expect(arrayDepthOf(deep)).toBe(50_000);
  });

  test('a malformed leaf under a long chain stays TYPE_MISMATCH (the leaf is checked first)', () => {
    const bad = codeOf(() => t.array(`uint7${'[]'.repeat(50_000)}` as never));
    expect(bad.code).toBe('TYPE_MISMATCH');
    expect(bad.message).toMatch(/unknown type "uint7\[\]\[\]/);
    expect(codeOf(() => t.array(`${deep}[0]` as never)).code).toBe('TYPE_MISMATCH');
  });

  test('peelArraySuffix peels only the last suffix, as before the linear rewrite', () => {
    expect(peelArraySuffix('uint256[2][]')).toEqual({ inner: 'uint256[2]', length: null });
    expect(peelArraySuffix('uint256[][7]')).toEqual({ inner: 'uint256[]', length: 7 });
    expect(peelArraySuffix('[]')).toEqual({ inner: '', length: null });
    for (const s of ['uint256', 'uint256[0]', 'uint256[07]', 'uint256[x]', 'uint256[]]', ']']) {
      expect(peelArraySuffix(s)).toBeNull();
    }
    expect(peelArraySuffix('uint256[4294967295]')?.length).toBe(2 ** 32 - 1);
    expect(peelArraySuffix('uint256[4294967296]')).toBeNull();
  });

  test('staticSizeOf: bytes inlined into an ABI head, null when ABI-dynamic', () => {
    expect(staticSizeOf('uint8')).toBe(32n);
    expect(staticSizeOf('uint256[3][2]')).toBe(192n);
    expect(staticSizeOf(t.array(t.struct({ a: t.uint8, b: t.bool }), 2))).toBe(128n);
    expect(staticSizeOf('uint256[100000000][100000000]')).toBe(320_000_000_000_000_000n);
    for (const dyn of ['string', 'bytes', 'uint256[]', 'string[2]', 'uint256[][2]']) {
      expect(staticSizeOf(dyn as EvsType)).toBeNull();
    }
    expect(staticSizeOf(t.struct({ a: t.uint8, s: t.string }))).toBeNull();
  });

  test('a static size of 2^32 bytes or more is UNSUPPORTED_V0; just below it is accepted', () => {
    expect(MAX_STATIC_SIZE).toBe(2 ** 32 - 1);
    // 32 · (2^27 − 1) = 2^32 − 32 bytes fits; 32 · 2^27 = 2^32 does not
    expect(t.array(t.uint256, 2 ** 27 - 1)).toBe('uint256[134217727]');
    // a dynamic element (string) makes the array ABI-dynamic: only its offset is inlined
    expect(t.array(t.array(t.string, 100_000_000), 100_000_000)).toBe(
      'string[100000000][100000000]',
    );
    const half = t.array(t.uint256, 2 ** 26); // 2^31 bytes each
    const tooBig: (() => unknown)[] = [
      () => t.array(t.uint256, 2 ** 27),
      () => t.array(t.array(t.uint256, 100_000_000), 100_000_000),
      () => namedArg('x', 'uint256[100000000][100000000]' as never),
      () => t.fromAbiParameter({ name: '', type: 'uint256[100000000][100000000]' } as never),
      // ABI-dynamic, but each element inlines 3.2e17 bytes (abi/layout gates level by level)
      () => t.fromAbiParameter({ name: '', type: 'uint256[100000000][100000000][]' } as never),
      () => namedArg('x', 'uint256[100000000][100000000][]' as never),
      () => t.struct({ a: half, b: half }),
      () => t.tuple(half, half),
      () => t.array(t.struct({ a: t.array(t.uint256, 1000) }), 1_000_000),
      () => t.array([{ name: 'a', type: 'uint256[1000]' }] as never, 1_000_000),
      () =>
        t.fromOutputs(
          [
            {
              type: 'function',
              name: 'f',
              stateMutability: 'view',
              inputs: [],
              outputs: [
                { name: 'a', type: 'uint256[67108864]' },
                { name: 'b', type: 'uint256[67108864]' },
              ],
            },
          ] as never,
          'f' as never,
        ),
    ];
    for (const build of tooBig) {
      const { code, message } = codeOf(build);
      expect(code).toBe('UNSUPPORTED_V0');
      expect(message).toMatch(/has an ABI static size of \d+ bytes — at most 2\^32 − 1/);
    }
    expect(codeOf(tooBig[1] ?? (() => undefined)).message).toContain('320000000000000000 bytes');
  });

  test("gateStaticLevels: the whole tag's size from its leaf's, gating the outermost static level", () => {
    // the bottom-up form validateIr walks a tree with: the caller measures the bare leaf
    expect(gateStaticLevels('uint256[3][2]', wordStaticSize, 'ctx')).toBe(192n);
    expect(gateStaticLevels('tuple[2]', () => 64n, 'ctx')).toBe(128n);
    expect(gateStaticLevels('uint256[2][]', wordStaticSize, 'ctx')).toBeNull();
    expect(gateStaticLevels('string[2]', wordStaticSize, 'ctx')).toBeNull();
    expect(gateStaticLevels('tuple[2]', () => null, 'ctx')).toBeNull();
    // the leaf is called on the bare tag, every suffix peeled
    const seen: string[] = [];
    gateStaticLevels(
      'tuple[][3]',
      (leaf) => {
        seen.push(leaf);
        return 32n;
      },
      'ctx',
    );
    expect(seen).toEqual(['tuple']);
    // an ABI-dynamic tag still gates its outermost static level, named in the message
    const { code, message } = codeOf(() =>
      gateStaticLevels('uint256[65536][65536][]', wordStaticSize, 'ctx'),
    );
    expect(code).toBe('UNSUPPORTED_V0');
    expect(message).toBe(
      'ctx: type "uint256[65536][65536]" has an ABI static size of 137438953472 bytes — at most 2^32 − 1 bytes are supported',
    );
    expect(codeOf(() => gateStaticLevels('tuple', () => 2n ** 32n, 'ctx')).message).toMatch(
      /type "tuple" has an ABI static size of 4294967296 bytes/,
    );
    expect(gateStaticLevels('tuple', () => 2n ** 32n - 1n, 'ctx')).toBe(2n ** 32n - 1n);
  });

  test('an oversized static tuple member of an ABI-dynamic type is rejected too', () => {
    // the enclosing type has a string member, so its own static size is null and measures
    // nothing; the tuple member (3.2e11 bytes) is gated on its own, like a string member
    const big = {
      name: 'x',
      type: 'tuple[100000000]',
      components: [{ name: 'y', type: 'uint256[100]' }],
    };
    const str = { name: 's', type: 'string' };
    const tooBig: (() => unknown)[] = [
      () =>
        t.fromOutputs(
          [
            {
              type: 'function',
              name: 'get',
              stateMutability: 'view',
              inputs: [],
              outputs: [big, str],
            },
          ] as never,
          'get' as never,
        ),
      () => t.fromAbiParameter({ name: '', type: 'tuple', components: [str, big] } as never),
      () => t.array([str, big] as never),
      () => t.struct({ s: t.string, x: big } as never),
      () => t.tuple(t.string, big as never),
      // nested one level down, inside a static tuple member of a dynamic struct
      () => t.struct({ s: t.string, inner: { type: 'tuple', components: [big] } } as never),
    ];
    for (const build of tooBig) {
      const { code, message } = codeOf(build);
      expect(code).toBe('UNSUPPORTED_V0');
      expect(message).toMatch(/"tuple\[100000000\]" has an ABI static size of 320000000000 bytes/);
    }
    // the same member at a size that fits is accepted
    const ok = { ...big, type: 'tuple[1000]' };
    expect(
      t.fromAbiParameter({ name: '', type: 'tuple', components: [str, ok] } as never),
    ).toMatchObject({
      type: 'tuple',
    });
  });
});

// ---------------------------------------------------------------------------
// composite types (t.struct / t.tuple / t.array of tuples) — issue #2
// ---------------------------------------------------------------------------

describe('t.struct / t.tuple (composite types)', () => {
  test('t.struct builds a named-component tuple in insertion order, frozen', () => {
    const pos = t.struct({ liquidity: t.uint128, owner: t.address });
    expect(pos).toEqual({
      type: 'tuple',
      components: [
        { name: 'liquidity', type: 'uint128' },
        { name: 'owner', type: 'address' },
      ],
    });
    expect(Object.isFrozen(pos)).toBe(true);
    expect(Object.isFrozen(pos.components)).toBe(true);
    expect(isTupleType(pos)).toBe(true);
    expect(isEvsValueType(pos)).toBe(true);
  });

  test('t.tuple builds positional (unnamed) components', () => {
    const tup = t.tuple(t.uint256, t.bool);
    expect(tup).toEqual({
      type: 'tuple',
      components: [
        { name: '', type: 'uint256' },
        { name: '', type: 'bool' },
      ],
    });
  });

  test('nested struct + dynamic and array members are accepted', () => {
    const nested: TupleType = t.struct({
      inner: t.struct({ a: t.bool, b: t.bytes32 }),
      ids: t.array(t.uint256),
      blob: t.bytes,
    });
    expect(nested.components.map((c) => c.type)).toEqual(['tuple', 'uint256[]', 'bytes']);
    expect(nested.components[0]?.components).toEqual([
      { name: 'a', type: 'bool' },
      { name: 'b', type: 'bytes32' },
    ]);
  });

  test('t.array(struct) builds a tuple[] type; elemTypeOf peels one []', () => {
    const arr = t.array(t.struct({ x: t.uint256 }));
    expect(arr).toMatchObject({ type: 'tuple[]' });
    const elem = elemTypeOf(arr);
    expect(elem).toMatchObject({ type: 'tuple' });
  });

  test('t.struct rejects empty records and non-identifier field names', () => {
    expect(() => t.struct({})).toThrow(EvsTypeError);
    expect(() => t.struct({ '1bad': t.uint256 } as never)).toThrow(EvsTypeError);
  });

  test('typesEqual is structural for tuples (fresh objects never === )', () => {
    const a = t.struct({ x: t.uint256, y: t.address });
    const b = t.struct({ x: t.uint256, y: t.address });
    expect(a).not.toBe(b);
    expect(typesEqual(a, b)).toBe(true);
    expect(typesEqual(a, t.struct({ x: t.uint256, y: t.bool }))).toBe(false);
    expect(typesEqual(a, t.struct({ z: t.uint256, y: t.address }))).toBe(false); // name differs
    expect(typesEqual('uint256', a)).toBe(false);
  });

  test('isMemrefType: a tuple is always memref-valued', () => {
    expect(isMemrefType(t.struct({ x: t.uint256 }))).toBe(true);
  });
});

describe('t.fromOutputs / t.fromAbiParameter (ABI → type derivation, issue #5)', () => {
  const slot0Outputs = [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'unlocked', type: 'bool' },
  ] as const;
  const poolAbi = [
    { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: slot0Outputs },
    {
      type: 'function',
      name: 'fee',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint24' }],
    },
    { type: 'function', name: 'poke', stateMutability: 'view', inputs: [], outputs: [] },
    {
      type: 'function',
      name: 'positions',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        {
          name: '',
          type: 'tuple',
          components: [
            { name: 'liquidity', type: 'uint128' },
            { name: 'owner', type: 'address' },
          ],
        },
      ],
    },
  ] as const;

  test('multi-named-output function → a named struct in ABI declaration order', () => {
    const Slot0 = t.fromOutputs(poolAbi, 'slot0');
    expect(isTupleType(Slot0)).toBe(true);
    const comps = (Slot0 as TupleType).components;
    expect(comps.map((c) => c.name)).toEqual(['sqrtPriceX96', 'tick', 'unlocked']);
    expect(comps.map((c) => c.type)).toEqual(['uint160', 'int24', 'bool']);
  });

  test('single scalar output → the scalar type string', () => {
    expect(t.fromOutputs(poolAbi, 'fee')).toBe('uint24');
  });

  test('single tuple output → that tuple type', () => {
    const Pos = t.fromOutputs(poolAbi, 'positions');
    expect(Pos).toMatchObject({
      type: 'tuple',
      components: [
        { name: 'liquidity', type: 'uint128' },
        { name: 'owner', type: 'address' },
      ],
    });
  });

  test('the derived struct is structurally a valid, usable t.* type', () => {
    const Slot0 = t.fromOutputs(poolAbi, 'slot0');
    expect(isEvsValueType(Slot0)).toBe(true);
    // and it round-trips: a hand-written t.struct in the SAME order is typesEqual to it.
    const Hand = t.struct({ sqrtPriceX96: t.uint160, tick: t.int24, unlocked: t.bool });
    expect(typesEqual(Slot0, Hand)).toBe(true);
  });

  test('errors: unknown fn, no outputs, non-ABI input', () => {
    expect(() => t.fromOutputs(poolAbi, 'missing')).toThrow(/no function named/);
    expect(() => t.fromOutputs(poolAbi, 'poke')).toThrow(/no outputs/);
    expect(() => t.fromOutputs({} as never, 'slot0')).toThrow(/ABI array/);
  });

  test('overloaded function: named by signature (issue #4)', () => {
    const overloaded = [
      {
        type: 'function',
        name: 'f',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: 'a', type: 'uint256' }],
      },
      {
        type: 'function',
        name: 'f',
        stateMutability: 'view',
        inputs: [{ name: 'x', type: 'uint256' }],
        outputs: [{ name: 'b', type: 'bool' }],
      },
    ] as const;
    // no args to resolve by: an overloaded bare name is ambiguous — the signature names one
    expect(() => t.fromOutputs(overloaded, 'f')).toThrow(/overloaded \(f\(\), f\(uint256\)\)/);
    expect(t.fromOutputs(overloaded, 'f()')).toBe('uint256');
    expect(t.fromOutputs(overloaded, 'f(uint256)')).toBe('bool');
    expect(() => t.fromOutputs(overloaded, 'f(uint8)')).toThrow(/no function with signature/);
  });

  test('a repeated member name is rejected, at the top level or nested (TYPE_MISMATCH)', () => {
    // viem decodes a tuple whose members are all named into a name-keyed object, so the second
    // `a` would silently overwrite the first; Solidity cannot emit such an ABI, a hand-written
    // one can
    const outputsOf = (outputs: readonly unknown[]) =>
      [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [], outputs }] as never;
    const pair = [
      { name: 'a', type: 'uint256' },
      { name: 'a', type: 'address' },
    ];
    const cases: readonly (readonly [() => unknown, RegExp])[] = [
      [
        () => t.fromOutputs(outputsOf(pair), 'get'),
        /^t\.fromOutputs\("get"\) component #1: duplicate member name "a" \(also component #0\)/,
      ],
      [
        () => t.fromOutputs(outputsOf([{ name: 'p', type: 'tuple', components: pair }]), 'get'),
        /^t\.fromOutputs\("get"\) component #0 component #1: duplicate member name "a"/,
      ],
      [
        () => t.fromAbiParameter({ name: 'p', type: 'tuple', components: pair } as never),
        /^t\.fromAbiParameter\(\) component #0 component #1: duplicate member name "a"/,
      ],
    ];
    for (const [run, message] of cases) {
      let caught: unknown;
      try {
        run();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      expect((caught as EvsTypeError).code).toBe('TYPE_MISMATCH');
      expect((caught as EvsTypeError).message).toMatch(message);
    }
  });

  test('isEvsValueType rejects a repeated member name at any level; positional members pass', () => {
    const pair = [
      { name: 'a', type: 'uint256' },
      { name: 'a', type: 'address' },
    ];
    expect(isEvsValueType({ type: 'tuple', components: pair })).toBe(false);
    expect(isEvsValueType({ type: 'tuple[]', components: pair })).toBe(false);
    expect(
      isEvsValueType({
        type: 'tuple',
        components: [{ name: 'p', type: 'tuple', components: pair }],
      }),
    ).toBe(false);
    expect(
      isEvsValueType({
        type: 'tuple',
        components: [
          { name: '', type: 'uint256' },
          { name: '', type: 'address' },
        ],
      }),
    ).toBe(true);
  });

  test('fromAbiParameter maps a scalar / tuple parameter to its EvsType', () => {
    expect(t.fromAbiParameter({ name: 'x', type: 'uint256' })).toBe('uint256');
    expect(t.fromAbiParameter({ name: 'xs', type: 'address[]' })).toBe('address[]');
    expect(
      t.fromAbiParameter({
        name: 'p',
        type: 'tuple',
        components: [{ name: 'a', type: 'uint8' }],
      }),
    ).toMatchObject({ type: 'tuple', components: [{ name: 'a', type: 'uint8' }] });
  });
});

function makeHandle(): Record<PropertyKey, unknown> {
  const target: Record<PropertyKey, unknown> = { type: 'uint256' };
  installStagingTraps(target, (h) => (h === target ? 'Expr<uint256> #4 ← s.read(token0)' : '?'));
  return target;
}

describe('staging traps (installStagingTraps)', () => {
  test('valueOf throws EvsStagingError', () => {
    const x = makeHandle();
    expect(() => (x as { valueOf(): unknown }).valueOf()).toThrow(EvsStagingError);
  });

  test('arithmetic coercion (Symbol.toPrimitive) throws EvsStagingError', () => {
    const x = makeHandle();
    expect(() => (x as unknown as number) + 1).toThrow(EvsStagingError);
  });

  test('template-literal coercion throws EvsStagingError', () => {
    const x = makeHandle();
    expect(() => `${x as unknown as string}`).toThrow(EvsStagingError);
  });

  test('String() / toString throws EvsStagingError', () => {
    const x = makeHandle();
    expect(() => String(x)).toThrow(EvsStagingError);
    expect(() => (x as { toString(): string }).toString()).toThrow(EvsStagingError);
  });

  test('JSON.stringify (toJSON) throws EvsStagingError', () => {
    const x = makeHandle();
    expect(() => JSON.stringify(x)).toThrow(EvsStagingError);
  });

  test('the thrown error names the misused handle', () => {
    const x = makeHandle();
    let caught: unknown;
    try {
      JSON.stringify(x);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvsStagingError);
    const err = caught as EvsStagingError;
    expect(err.code).toBe('STAGING_MISUSE');
    expect(err.message).toContain('Expr<uint256> #4');
  });

  test('nodejs.util.inspect.custom is NON-throwing and returns the description', () => {
    const x = makeHandle();
    const inspect = x[Symbol.for('nodejs.util.inspect.custom')] as (this: unknown) => string;
    expect(inspect.call(x)).toBe('Expr<uint256> #4 ← s.read(token0)');
  });

  test('traps are non-enumerable (the handle still JSON-walks its data props only)', () => {
    const x = makeHandle();
    expect(Object.keys(x)).toEqual(['type']);
  });
});

describe('t.error (issue #15)', () => {
  test('builds a frozen error value with normalized params and a literal ABI entry', () => {
    const e = t.error('NoBalance', [namedArg('balance', t.uint256), t.address]);
    expect(e.kind).toBe('error');
    expect(e.name).toBe('NoBalance');
    expect(e.params).toEqual([
      { name: 'balance', type: 'uint256' },
      { name: '', type: 'address' },
    ]);
    // bare params get the positional arg{i} fallback in the ABI inputs
    expect(e.abi).toEqual({
      type: 'error',
      name: 'NoBalance',
      inputs: [
        { name: 'balance', type: 'uint256' },
        { name: 'arg1', type: 'address' },
      ],
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.abi)).toBe(true);
    expect(Object.isFrozen(e.params)).toBe(true);
  });

  test('zero-param and lone-declarator sugar', () => {
    expect(t.error('NotOwner').params).toEqual([]);
    expect(t.error('One', t.uint256).abi.inputs).toEqual([{ name: 'arg0', type: 'uint256' }]);
    expect(t.error('Named', namedArg('x', t.uint256)).abi.inputs).toEqual([
      { name: 'x', type: 'uint256' },
    ]);
  });

  test('struct params expand to named tuple components', () => {
    const e = t.error('Detail', [namedArg('info', t.struct({ code: t.uint256, note: t.string }))]);
    expect(e.abi.inputs).toEqual([
      {
        name: 'info',
        type: 'tuple',
        components: [
          { name: 'code', type: 'uint256' },
          { name: 'note', type: 'string' },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// tuple descriptors: one canonicalizer behind every entry point
// ---------------------------------------------------------------------------

describe('tuple descriptors: the same rules at every entry point', () => {
  const U8 = { name: 'a', type: 'uint8' };
  /** A one-member tuple wrapping `member`, so each rule is exercised below the top level. */
  const wrap = (member: unknown): unknown => ({ type: 'tuple', components: [member] });

  const MALFORMED: readonly (readonly [string, unknown, EvsErrorCode])[] = [
    ['an empty tuple', { type: 'tuple', components: [] }, 'TYPE_MISMATCH'],
    ['an empty nested tuple', wrap({ name: 'x', type: 'tuple', components: [] }), 'TYPE_MISMATCH'],
    ['an unknown leaf', wrap({ name: 'x', type: 'uint7' }), 'TYPE_MISMATCH'],
    [
      'an unknown leaf carrying components',
      wrap({ name: 'x', type: 'garbage', components: [] }),
      'TYPE_MISMATCH',
    ],
    [
      'a malformed nested tag',
      wrap({ name: 'x', type: 'tuple[0]', components: [U8] }),
      'TYPE_MISMATCH',
    ],
    ['a nested tuple without components', wrap({ name: 'x', type: 'tuple' }), 'TYPE_MISMATCH'],
    ['a member without a type', wrap({ name: 'x' }), 'TYPE_MISMATCH'],
    ['a non-object member', wrap(42), 'TYPE_MISMATCH'],
    ['a leaf nested too deep', wrap({ name: 'x', type: 'uint256[][][][][]' }), 'UNSUPPORTED_V0'],
    [
      'a tuple tag nested too deep',
      wrap({ name: 'x', type: 'tuple[][][][][]', components: [U8] }),
      'UNSUPPORTED_V0',
    ],
    [
      'a member past the static size cap',
      wrap({ name: 'x', type: 'uint256[100000000][100]' }),
      'UNSUPPORTED_V0',
    ],
    [
      'a repeated member name',
      { type: 'tuple', components: [U8, { name: 'a', type: 'address' }] },
      'TYPE_MISMATCH',
    ],
    [
      'a repeated nested member name',
      wrap({ name: 'x', type: 'tuple', components: [U8, { name: 'a', type: 'address' }] }),
      'TYPE_MISMATCH',
    ],
  ];

  /** The slice of the builder these probes drive with untyped (malformed) descriptors. */
  interface Loose {
    tuple(type: unknown): unknown;
    fn(name: string, params: readonly unknown[], body: () => unknown): unknown;
  }
  /** Records a script whose body first runs `probe` on the untyped builder. */
  const record = (probe: (s: Loose) => void): unknown =>
    evscript({ name: 'x' }, (s) => {
      probe(s as unknown as Loose);
      return s.return({ ok: s.lit(t.bool, true) });
    });

  const ENTRY_POINTS: readonly (readonly [string, (descriptor: unknown) => unknown])[] = [
    ['namedArg', (d) => namedArg('x', d as never)],
    ['t.tuple', (d) => t.tuple(d as never)],
    ['t.struct', (d) => t.struct({ s: d } as never)],
    ['t.array', (d) => t.array(d as never)],
    ['t.error', (d) => t.error('E', [d] as never)],
    ['t.fromAbiParameter', (d) => t.fromAbiParameter({ name: 'p', ...(d as object) } as never)],
    [
      'evscript args',
      (d) =>
        evscript({ name: 'x', args: [d] as never }, (s) => s.return({ ok: s.lit(t.bool, true) })),
    ],
    [
      'evscript named args',
      (d) =>
        evscript({ name: 'x', args: [{ name: 'x', type: d }] as never }, (s) =>
          s.return({ ok: s.lit(t.bool, true) }),
        ),
    ],
    ['s.fn params', (d) => record((s) => s.fn('f', [d], () => undefined))],
    ['s.tuple', (d) => record((s) => s.tuple(d))],
  ];

  for (const [entry, build] of ENTRY_POINTS) {
    test.each(MALFORMED)(`${entry}: rejects %s`, (_label, descriptor, code) => {
      let caught: unknown;
      try {
        build(descriptor);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      expect((caught as EvsTypeError).code).toBe(code);
    });
  }

  test("isEvsValueType stays structural: the size gates are the canonicalizer's", () => {
    // an empty tuple, too-deep arrays and oversized members are well-formed structurally (the IR
    // validator reports an empty tuple in its own words); every other case, a repeated member
    // name included, is malformed
    const structural = new Set(['an empty tuple', 'an empty nested tuple']);
    for (const [label, descriptor, code] of MALFORMED) {
      expect(isEvsValueType(descriptor)).toBe(code === 'UNSUPPORTED_V0' || structural.has(label));
    }
  });

  test('errors name the member by its path', () => {
    const nested = wrap({
      name: 'x',
      type: 'tuple',
      components: [U8, { name: 'y', type: 'uint7' }],
    });
    expect(() => t.struct({ s: nested } as never)).toThrow(
      /^t\.struct\(\) field "s" component #0 component #1: unknown type "uint7"/,
    );
    expect(() => t.tuple(wrap({ name: 'x', type: 'tuple', components: [] }) as never)).toThrow(
      /^t\.tuple\(\) member #0 component #0: a tuple must have at least one component$/,
    );
    expect(() => namedArg('q', wrap({ name: 'x', type: 'uint256[][][][][]' }) as never)).toThrow(
      /^argument "q" component #0: type "uint256\[\]\[\]\[\]\[\]\[\]" nests arrays 5 levels deep/,
    );
    const repeated = wrap({
      name: 'x',
      type: 'tuple',
      components: [U8, { name: 'a', type: 'bool' }],
    });
    expect(() => t.struct({ s: repeated } as never)).toThrow(
      /^t\.struct\(\) field "s" component #0 component #1: duplicate member name "a" \(also component #0\) — member names must be unique within a tuple: viem decodes a named tuple into an object keyed by member name/,
    );
  });

  test('unnamed members never clash: only a repeated non-empty name is rejected', () => {
    const positional = {
      type: 'tuple',
      components: [
        { name: '', type: 'uint8' },
        { name: '', type: 'uint8' },
        { name: 'a', type: 'bool' },
      ],
    } as const;
    expect(t.tuple(t.uint8, t.uint8).components.map((c) => c.name)).toEqual(['', '']);
    expect(t.tuple(positional).components[0]).toEqual({ name: '', ...positional });
    expect(t.fromAbiParameter({ name: 'p', ...positional })).toEqual(positional);
    expect(namedArg('p', positional).type).toBe(positional);
  });

  test('the t constructors canonicalize: names default to "", stray components drop', () => {
    const loose = wrap({ type: 'uint8', components: [] }); // abitype's `name` is optional
    const canonical = { type: 'tuple', components: [{ name: '', type: 'uint8' }] };
    const built: readonly unknown[] = [
      t.tuple(loose as never).components[0],
      t.struct({ s: loose } as never).components[0],
      t.array(loose as never),
      t.fromAbiParameter(loose as never),
    ];
    const [member, field, array, fromAbi] = built;
    expect(member).toEqual({ name: '', ...canonical });
    expect(field).toEqual({ name: 's', ...canonical });
    expect(array).toEqual({ ...canonical, type: 'tuple[]' });
    expect(fromAbi).toEqual(canonical);
    for (const v of built) {
      expect(Object.isFrozen(v)).toBe(true);
      expect(Object.isFrozen((v as TupleType).components)).toBe(true);
      expect(Object.isFrozen((v as TupleType).components[0])).toBe(true);
    }
    // the declarators keep requiring the canonical form (and keep the caller's object)
    expect(isEvsValueType(loose)).toBe(false);
    expect(() => namedArg('x', loose as never)).toThrow(/components\[0\] has no string `name`/);
    const canon = t.tuple(t.uint8);
    expect(namedArg('x', canon).type).toBe(canon);
  });
});
