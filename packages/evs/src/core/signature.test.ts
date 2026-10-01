// Canonical ABI signatures (core/signature.ts): the overload key shared by the call verbs and
// `t.fromOutputs`. The type-level twin is pinned in signature.test-d.ts on the same fixtures.
import { describe, expect, test } from 'vite-plus/test';

import {
  functionSignature,
  functionsByRef,
  isSignatureRef,
  normalizeSignatureRef,
  parameterSignature,
  signatureRefName,
} from './signature.js';

/** `get` overloaded on a nested tuple array and a scalar, plus a non-function entry of the same
 *  name that lookups must skip. */
const ABI = [
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [
      {
        name: 'ps',
        type: 'tuple[2][]',
        components: [
          { name: 'a', type: 'uint256' },
          { name: 'b', type: 'tuple', components: [{ name: 'c', type: 'address[]' }] },
        ],
      },
    ],
    outputs: [{ name: 'x', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ name: 'y', type: 'bool' }],
  },
  { type: 'event', name: 'get', inputs: [], anonymous: false },
] as const;

describe('parameterSignature', () => {
  test.each([
    ['a scalar', { name: 'x', type: 'uint256' }, 'uint256'],
    ['an unnamed scalar array', { type: 'address[3][]' }, 'address[3][]'],
    [
      'a tuple, expanded to its component list',
      { name: 'p', type: 'tuple', components: [{ type: 'uint256' }, { type: 'address' }] },
      '(uint256,address)',
    ],
    [
      'a tuple array keeps its whole suffix chain',
      { type: 'tuple[2][]', components: [{ type: 'bool' }] },
      '(bool)[2][]',
    ],
    [
      'nested tuples, names dropped',
      {
        name: 'outer',
        type: 'tuple[]',
        components: [
          { name: 'a', type: 'uint8' },
          {
            name: 'inner',
            type: 'tuple[3]',
            components: [{ name: 'b', type: 'bytes32' }, { type: 'string[]' }],
          },
        ],
      },
      '(uint8,(bytes32,string[])[3])[]',
    ],
  ])('%s', (_label, param, expected) => {
    expect(parameterSignature(param)).toBe(expected);
  });

  test.each([
    ['a non-object', 42, '?'],
    ['null', null, '?'],
    ['an array', [], '?'],
    ['a missing type', { name: 'x' }, '?'],
    ['a non-string type', { type: 7 }, '?'],
    // without components there is nothing to expand: the raw tag stays (callers validate)
    ['a tuple without components', { type: 'tuple[]' }, 'tuple[]'],
    ['a malformed component', { type: 'tuple', components: [{ type: 'uint8' }, 0] }, '(uint8,?)'],
  ])('malformed: %s degrades to its raw type', (_label, param, expected) => {
    expect(parameterSignature(param)).toBe(expected);
  });
});

describe('functionSignature', () => {
  test('canonical form of an ABI entry: no names, no spaces, tuples expanded', () => {
    expect(functionSignature(ABI[0])).toBe('get((uint256,(address[]))[2][])');
    expect(functionSignature(ABI[1])).toBe('get(uint256)');
    expect(functionSignature({ name: 'f', inputs: [{ type: 'uint256' }, { type: 'bytes' }] })).toBe(
      'f(uint256,bytes)',
    );
    expect(functionSignature({ name: 'none', inputs: [] })).toBe('none()');
  });

  test('malformed entries degrade instead of throwing', () => {
    expect(functionSignature({ inputs: [{ type: 'uint8' }] })).toBe('?(uint8)');
    expect(functionSignature({ name: 'f' })).toBe('f()');
    expect(functionSignature({ name: 'f', inputs: 'uint256' })).toBe('f()');
  });
});

describe('signature references', () => {
  test('a reference is a signature iff it contains "("', () => {
    expect(isSignatureRef('get(uint256)')).toBe(true);
    expect(isSignatureRef('get')).toBe(false);
  });

  test('whitespace is stripped and the name is everything before "("', () => {
    expect(normalizeSignatureRef(' get( uint256 ,\taddress ) ')).toBe('get(uint256,address)');
    expect(signatureRefName('get(uint256)')).toBe('get');
    expect(signatureRefName('get')).toBe('get');
  });
});

describe('functionsByRef', () => {
  test('a bare name selects every function overload of that name, nothing else', () => {
    const { entries, bySignature } = functionsByRef(ABI, 'get');
    expect(bySignature).toBe(false);
    expect(entries).toEqual([ABI[0], ABI[1]]);
  });

  test('a signature selects exactly the matching overload (whitespace-insensitive)', () => {
    const byTupleArray = functionsByRef(ABI, 'get( (uint256, (address[]))[2][] )');
    expect(byTupleArray.bySignature).toBe(true);
    expect(byTupleArray.entries).toEqual([ABI[0]]);
    expect(functionsByRef(ABI, 'get(uint256)').entries).toEqual([ABI[1]]);
  });

  test('no match: an unknown name or signature, a wrong suffix, junk entries', () => {
    expect(functionsByRef(ABI, 'set').entries).toEqual([]);
    expect(functionsByRef(ABI, 'get(uint8)').entries).toEqual([]);
    expect(functionsByRef(ABI, 'get((uint256,(address[]))[][2])').entries).toEqual([]);
    expect(functionsByRef([null, 42, 'get', { type: 'function' }], 'get').entries).toEqual([]);
  });
});
