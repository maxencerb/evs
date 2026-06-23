/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-base-to-string, typescript/no-unnecessary-template-expression --
 * exhaustive-table tests cast generated type strings on purpose, and the staging-trap suite
 * deliberately performs the host coercions the traps exist to intercept. */
import { describe, expect, test } from 'vitest';

import { EvsStagingError, EvsTypeError } from './errors.js';
import {
  arg,
  bitsOf,
  elemTypeOf,
  installStagingTraps,
  isDynamicType,
  isEvsType,
  isEvsValueType,
  isNumeric,
  isSigned,
  isTupleType,
  isWordType,
  t,
  typesEqual,
  type ArrayType,
  type EvsType,
  type TupleType,
  type WordType,
} from './types.js';

// ---------------------------------------------------------------------------
// the full v0 vocabulary, built independently of the implementation
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

// Nested arrays (`uint256[][]`, `string[]`, …) are now in the string-encoded vocabulary
// (`isEvsType` accepts them — represented for the deferred composite-array follow-up; the
// builder/codegen still restrict them). `tuple`/`tuple[]` are NOT string-encoded (they are
// TupleType objects), so `isEvsType` rejects those strings.
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
  'uint256[2]',
  'address[3]',
  'function',
  'Uint256',
  ' uint256',
  'uint256 ',
];

describe('isEvsType / isWordType (exhaustive v0 table)', () => {
  test(`accepts every v0 type string (${ALL_EVS_TYPES.length} total)`, () => {
    expect(WORD_TYPES).toHaveLength(98);
    expect(ALL_EVS_TYPES).toHaveLength(198);
    for (const s of ALL_EVS_TYPES) expect(isEvsType(s)).toBe(true);
    for (const s of WORD_TYPES) expect(isWordType(s)).toBe(true);
    for (const s of [...DYN_TYPES, ...ARRAY_TYPES]) expect(isWordType(s)).toBe(false);
  });

  test('rejects non-v0 type strings', () => {
    for (const s of REJECTED) {
      expect(isEvsType(s)).toBe(false);
      expect(isWordType(s)).toBe(false);
    }
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

  test('throws EvsTypeError on a non-word type', () => {
    for (const s of ['uint7', 'string', 'address[]', 'tuple']) {
      expect(() => bitsOf(s as WordType)).toThrow(EvsTypeError);
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

  test('isDynamicType: string | bytes | T[]', () => {
    for (const s of [...DYN_TYPES, ...ARRAY_TYPES]) expect(isDynamicType(s as EvsType)).toBe(true);
    for (const s of WORD_TYPES) expect(isDynamicType(s as EvsType)).toBe(false);
  });

  test('elemTypeOf round-trips every array type', () => {
    for (const w of WORD_TYPES) expect(elemTypeOf(`${w}[]` as ArrayType)).toBe(w);
    // nested string arrays peel one [] (now in the vocabulary)
    expect(elemTypeOf('string[]' as ArrayType)).toBe('string');
    expect(elemTypeOf('uint256[][]' as ArrayType)).toBe('uint256[]');
    // non-array strings (and the non-string `tuple[]` tag) have no string element type
    for (const s of ['string', 'uint256', 'tuple[]']) {
      expect(() => elemTypeOf(s as ArrayType)).toThrow(EvsTypeError);
    }
  });
});

describe('arg()', () => {
  test('returns a frozen ArgSpec', () => {
    const a = arg('pool', t.address);
    expect(a).toEqual({ name: 'pool', type: 'address' });
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('accepts identifier names', () => {
    for (const name of ['_x', 'A1', 'pool_2', 'camelCase', '__proto', 'x']) {
      expect(arg(name, 'uint256').name).toBe(name);
    }
  });

  test('rejects invalid names with EvsTypeError + call-site loc', () => {
    for (const name of ['', '1abc', 'a-b', 'a b', 'é', 'foo.bar', 'a$', ' x']) {
      let caught: unknown;
      try {
        arg(name, 'uint256');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('TYPE_MISMATCH');
      expect(err.message).toContain(JSON.stringify(name));
      expect(err.loc).not.toBeNull();
      expect(err.loc?.file).toMatch(/types\.test\.ts/);
      expect(err.loc?.line).toBeGreaterThan(0);
    }
  });

  test('rejects unknown type strings with TYPE_MISMATCH', () => {
    for (const type of ['uint7', 'bytes33', 'Uint256', 'foo']) {
      let caught: unknown;
      try {
        arg('x', type as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('TYPE_MISMATCH');
      expect(err.loc?.file).toMatch(/types\.test\.ts/);
    }
  });

  test('rejects deferred fixed-size-array Solidity types with UNSUPPORTED_V0', () => {
    // fixed-size arrays `T[N]` stay deferred (nested dynamic arrays + tuples are now in the
    // string/tuple vocabulary, so they are no longer rejected by arg()).
    for (const type of ['address[3]', 'uint256[2]', 'address[3][]']) {
      let caught: unknown;
      try {
        arg('x', type as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('UNSUPPORTED_V0');
      expect(err.message).toContain('not supported');
      expect(err.loc?.file).toMatch(/types\.test\.ts/);
    }
  });
});

describe('t namespace', () => {
  test('every WordType key + string + bytes, identity-mapped', () => {
    for (const s of [...WORD_TYPES, ...DYN_TYPES]) {
      expect((t as Record<string, unknown>)[s]).toBe(s);
    }
    // 98 word types + string + bytes + array() + struct() + tuple() + fromOutputs() +
    // fromAbiParameter() = 105 keys
    expect(Object.keys(t)).toHaveLength(105);
  });

  test('is frozen', () => {
    expect(Object.isFrozen(t)).toBe(true);
  });

  test('t.array builds array types and validates eagerly', () => {
    expect(t.array(t.address)).toBe('address[]');
    expect(t.array('uint24')).toBe('uint24[]');
    // dynamic/array element types are now in the vocabulary (the deferred follow-up)
    expect(t.array('string' as WordType)).toBe('string[]');
    expect(t.array('uint24[]' as WordType)).toBe('uint24[][]');
    // genuinely-invalid element types still throw eagerly
    expect(() => t.array('uint7' as WordType)).toThrow(EvsTypeError);
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

  test('isDynamicType: a tuple is always memref-valued', () => {
    expect(isDynamicType(t.struct({ x: t.uint256 }))).toBe(true);
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

  test('overloaded function name is a v0 deferral', () => {
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
    expect(() => t.fromOutputs(overloaded, 'f')).toThrow(/overloaded/);
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
  installStagingTraps(target, {
    describe: () => 'Expr<uint256> #4 ← s.call(token0) at pools.ts:9:18',
    recordedAt: () => ({ file: 'pools.ts', line: 9, column: 18 }),
  });
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

  test('the thrown error cites the misuse site and the recording site', () => {
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
    expect(err.loc?.file).toMatch(/types\.test\.ts/); // misuse site
    expect(err.relatedLocs).toEqual([
      { label: 'handle recorded at', loc: { file: 'pools.ts', line: 9, column: 18 } },
    ]);
  });

  test('nodejs.util.inspect.custom is NON-throwing and returns the description', () => {
    const x = makeHandle();
    const inspect = x[Symbol.for('nodejs.util.inspect.custom')] as () => string;
    expect(inspect()).toBe('Expr<uint256> #4 ← s.call(token0) at pools.ts:9:18');
  });

  test('traps are non-enumerable (the handle still JSON-walks its data props only)', () => {
    const x = makeHandle();
    expect(Object.keys(x)).toEqual(['type']);
  });
});
