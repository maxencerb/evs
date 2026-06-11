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
  isNumeric,
  isSigned,
  isWordType,
  t,
  type ArrayType,
  type EvsType,
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
  'uint256[][]',
  'address[][]',
  'tuple',
  'tuple[]',
  'uint256[2]',
  'address[3]',
  'string[]', // arrays of dynamic types are not v0
  'bytes[]',
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
    for (const s of ['string', 'uint256', 'string[]', 'uint256[][]', 'tuple[]']) {
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

  test('rejects deferred-but-valid-Solidity types with UNSUPPORTED_V0', () => {
    for (const type of ['tuple', 'uint256[][]', 'address[3]', 'string[]', 'tuple[]']) {
      let caught: unknown;
      try {
        arg('x', type as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EvsTypeError);
      const err = caught as EvsTypeError;
      expect(err.code).toBe('UNSUPPORTED_V0');
      expect(err.message).toContain('v0');
      expect(err.loc?.file).toMatch(/types\.test\.ts/);
    }
  });
});

describe('t namespace', () => {
  test('every WordType key + string + bytes, identity-mapped', () => {
    for (const s of [...WORD_TYPES, ...DYN_TYPES]) {
      expect((t as Record<string, unknown>)[s]).toBe(s);
    }
    // 98 word types + string + bytes + array() = 101 keys
    expect(Object.keys(t)).toHaveLength(101);
  });

  test('is frozen', () => {
    expect(Object.isFrozen(t)).toBe(true);
  });

  test('t.array builds word-element array types and validates eagerly', () => {
    expect(t.array(t.address)).toBe('address[]');
    expect(t.array('uint24')).toBe('uint24[]');
    expect(() => t.array('string' as WordType)).toThrow(EvsTypeError);
    expect(() => t.array('uint7' as WordType)).toThrow(EvsTypeError);
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
