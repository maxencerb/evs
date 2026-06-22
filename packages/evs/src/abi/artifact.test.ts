/* oxlint-disable typescript/no-unsafe-type-assertion --
 * rejection matrices deliberately feed wrongly-typed values through the public signatures. */
import type { AbiFunction, AbiParameter } from 'abitype';
import { encodeAbiParameters } from 'viem';
import { describe, expect, test } from 'vitest';

import { EvsTypeError } from '../core/errors.js';
import { t } from '../core/types.js';
import type { ArrayType, DynType, WordType } from '../core/types.js';
import {
  buildScriptAbi,
  encodeLiteralData,
  encodeLiteralWord,
  EVS_ERROR_ABI,
  selectorOf,
  toPlainAbiFunction,
} from './artifact.js';

/** viem oracle with wide param typing (the values side becomes `readonly unknown[]`). */
function viemEncode(type: string, value: unknown): `0x${string}` {
  const params: readonly AbiParameter[] = [{ type }];
  return encodeAbiParameters(params, [value]);
}

function catchEvs(fn: () => unknown): EvsTypeError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EvsTypeError);
  return caught as EvsTypeError;
}

// ---------------------------------------------------------------------------
// EVS_ERROR_ABI
// ---------------------------------------------------------------------------

describe('EVS_ERROR_ABI', () => {
  test('exact shape (architecture §11)', () => {
    expect(EVS_ERROR_ABI).toEqual([
      { type: 'error', name: 'EvsInvalidCalldata', inputs: [] },
      { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

describe('selectorOf', () => {
  test('known constants', () => {
    expect(selectorOf('symbol', [])).toBe('0x95d89b41');
    expect(selectorOf('balanceOf', ['address'])).toBe('0x70a08231');
    expect(selectorOf('transfer', ['address', 'uint256'])).toBe('0xa9059cbb');
  });

  test('evs error selectors (computed once via selectorOf — the codegen constants)', () => {
    expect(selectorOf('EvsInvalidCalldata', [])).toBe('0xf43fed56');
    expect(selectorOf('EvsDecodeError', ['uint256'])).toBe('0x20cf27b7');
  });
});

// ---------------------------------------------------------------------------
// toPlainAbiFunction
// ---------------------------------------------------------------------------

describe('toPlainAbiFunction', () => {
  const balanceOf: AbiFunction = {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  };

  test('adds the selector and flattens params', () => {
    expect(toPlainAbiFunction(balanceOf)).toEqual({
      name: 'balanceOf',
      selector: '0x70a08231',
      inputs: [{ name: 'owner', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    });
  });

  test('missing param names become empty strings', () => {
    const fn: AbiFunction = {
      type: 'function',
      name: 'slot0',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ type: 'uint160' }, { name: 'tick', type: 'int24' }],
    };
    expect(toPlainAbiFunction(fn)).toEqual({
      name: 'slot0',
      selector: selectorOf('slot0', []),
      inputs: [],
      outputs: [
        { name: '', type: 'uint160' },
        { name: 'tick', type: 'int24' },
      ],
    });
  });

  test('result is frozen', () => {
    const plain = toPlainAbiFunction(balanceOf);
    expect(Object.isFrozen(plain)).toBe(true);
    expect(Object.isFrozen(plain.inputs)).toBe(true);
    expect(Object.isFrozen(plain.inputs[0])).toBe(true);
    expect(Object.isFrozen(plain.outputs)).toBe(true);
  });

  test('rejects non-v0 input types, naming function and parameter', () => {
    const fn: AbiFunction = {
      type: 'function',
      name: 'observe',
      stateMutability: 'view',
      inputs: [{ name: 'secondsAgos', type: 'uint32[3]' }],
      outputs: [],
    };
    const err = catchEvs(() => toPlainAbiFunction(fn));
    expect(err.code).toBe('UNSUPPORTED_V0');
    expect(err.message).toContain('observe');
    expect(err.message).toContain('secondsAgos');
    expect(err.message).toContain('input');
  });

  test('accepts a tuple output, recursing into its components', () => {
    const fn: AbiFunction = {
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
            { name: 'operator', type: 'address' },
          ],
        },
      ],
    };
    const plain = toPlainAbiFunction(fn);
    expect(plain.outputs[0]).toEqual({
      name: '',
      type: 'tuple',
      components: [
        { name: 'liquidity', type: 'uint128' },
        { name: 'operator', type: 'address' },
      ],
    });
  });

  test('rejects a tuple ARRAY output (deferred), naming the unnamed parameter by index', () => {
    const fn: AbiFunction = {
      type: 'function',
      name: 'positions',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        { name: '', type: 'tuple[]', components: [{ name: 'liquidity', type: 'uint128' }] },
      ],
    };
    const err = catchEvs(() => toPlainAbiFunction(fn));
    expect(err.code).toBe('UNSUPPORTED_V0');
    expect(err.message).toContain('positions');
    expect(err.message).toContain('#0');
    expect(err.message).toContain('output');
  });
});

// ---------------------------------------------------------------------------
// encodeLiteralWord
// ---------------------------------------------------------------------------

describe('encodeLiteralWord', () => {
  test('goldens (canonical 32-byte words, architecture §5)', () => {
    expect(encodeLiteralWord('uint8', 5)).toBe(`0x${'0'.repeat(62)}05`);
    expect(encodeLiteralWord('uint256', 2n ** 256n - 1n)).toBe(`0x${'f'.repeat(64)}`);
    expect(encodeLiteralWord('int8', -1n)).toBe(`0x${'f'.repeat(64)}`); // sign-extended
    expect(encodeLiteralWord('int24', -2)).toBe(`0x${'f'.repeat(63)}e`);
    expect(encodeLiteralWord('int256', -(2n ** 255n))).toBe(`0x8${'0'.repeat(63)}`);
    expect(encodeLiteralWord('bool', true)).toBe(`0x${'0'.repeat(63)}1`);
    expect(encodeLiteralWord('bool', false)).toBe(`0x${'0'.repeat(64)}`);
    expect(encodeLiteralWord('address', `0x${'aa'.repeat(20)}`)).toBe(
      `0x${'0'.repeat(24)}${'aa'.repeat(20)}`, // right-aligned
    );
    expect(encodeLiteralWord('bytes4', '0xdeadbeef')).toBe(`0xdeadbeef${'0'.repeat(56)}`); // LEFT-aligned
  });

  test('address checksum NOT enforced (api.md §3): mixed-case is lowercased, not rejected', () => {
    // deliberately NOT a valid EIP-55 checksum casing
    const mixed = '0xAaAaAAaaAaaaAaAaAaaAAAaaAAAAaAaAAaaaAaAa';
    expect(encodeLiteralWord('address', mixed)).toBe(`0x${'0'.repeat(24)}${'aa'.repeat(20)}`);
  });

  const DIFFERENTIAL: readonly [WordType, unknown][] = [
    ['uint8', 0n],
    ['uint8', 255],
    ['uint48', 2 ** 48 - 1],
    ['uint128', 2n ** 128n - 1n],
    ['uint192', 2n ** 191n],
    ['uint256', 123456789n],
    ['int8', -128],
    ['int8', 127n],
    ['int128', -(2n ** 127n)],
    ['int256', -1n],
    ['int256', 2n ** 255n - 1n],
    ['bool', true],
    ['bool', false],
    ['address', `0x${'12'.repeat(20)}`],
    ['bytes1', '0xff'],
    ['bytes20', `0x${'34'.repeat(20)}`],
    ['bytes32', `0x${'56'.repeat(32)}`],
  ];

  test.each(DIFFERENTIAL)('differential vs viem encodeAbiParameters: %s %s', (type, value) => {
    expect(encodeLiteralWord(type, value)).toBe(viemEncode(type, value));
  });

  test('rejections: range / safety / shape', () => {
    expect(catchEvs(() => encodeLiteralWord('uint8', 256)).code).toBe('LITERAL_RANGE');
    expect(catchEvs(() => encodeLiteralWord('uint8', -1n)).code).toBe('LITERAL_RANGE');
    expect(catchEvs(() => encodeLiteralWord('int8', 128n)).code).toBe('LITERAL_RANGE');
    expect(catchEvs(() => encodeLiteralWord('int8', -129n)).code).toBe('LITERAL_RANGE');
    expect(catchEvs(() => encodeLiteralWord('uint256', 2n ** 256n)).code).toBe('LITERAL_RANGE');
    // unsafe numbers must come in as bigints
    expect(catchEvs(() => encodeLiteralWord('uint256', Number.MAX_SAFE_INTEGER + 1)).code).toBe(
      'LITERAL_RANGE',
    );
    expect(catchEvs(() => encodeLiteralWord('uint256', 1.5)).code).toBe('LITERAL_RANGE');
    // wrong JS kinds
    expect(catchEvs(() => encodeLiteralWord('uint256', '5')).code).toBe('TYPE_MISMATCH');
    expect(catchEvs(() => encodeLiteralWord('bool', 1)).code).toBe('TYPE_MISMATCH');
    expect(catchEvs(() => encodeLiteralWord('address', 42)).code).toBe('TYPE_MISMATCH');
    // hex shape
    expect(catchEvs(() => encodeLiteralWord('address', '0x1234')).code).toBe('LITERAL_RANGE');
    expect(catchEvs(() => encodeLiteralWord('address', `0x${'gg'.repeat(20)}`)).code).toBe(
      'LITERAL_RANGE',
    );
    expect(catchEvs(() => encodeLiteralWord('bytes4', '0xdeadbe')).code).toBe('LITERAL_RANGE');
    expect(catchEvs(() => encodeLiteralWord('bytes4', '0xdeadbeefff')).code).toBe('LITERAL_RANGE');
    // not a word type at all (runtime-defensive)
    expect(catchEvs(() => encodeLiteralWord('string' as WordType, 'x')).code).toBe('TYPE_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// encodeLiteralData
// ---------------------------------------------------------------------------

const LEN = (n: number): string => n.toString(16).padStart(64, '0');

describe('encodeLiteralData', () => {
  test('goldens ([len:32][payload…] memref bytes, architecture §5)', () => {
    expect(encodeLiteralData('string', 'hello')).toBe(`0x${LEN(5)}68656c6c6f${'0'.repeat(54)}`);
    expect(encodeLiteralData('string', '')).toBe(`0x${LEN(0)}`);
    expect(encodeLiteralData('bytes', '0xdeadbeef')).toBe(`0x${LEN(4)}deadbeef${'0'.repeat(56)}`);
    expect(encodeLiteralData('bytes', '0x')).toBe(`0x${LEN(0)}`);
    expect(encodeLiteralData('uint256[]', [1n, 2n])).toBe(`0x${LEN(2)}${LEN(1)}${LEN(2)}`);
    expect(encodeLiteralData('uint8[]', [])).toBe(`0x${LEN(0)}`);
    // elements stored as canonical words: int8 −1 sign-extends
    expect(encodeLiteralData('int8[]', [-1, 2])).toBe(`0x${LEN(2)}${'f'.repeat(64)}${LEN(2)}`);
    // exactly 32 payload bytes: no extra padding word
    expect(encodeLiteralData('bytes', `0x${'ab'.repeat(32)}`)).toBe(
      `0x${LEN(32)}${'ab'.repeat(32)}`,
    );
  });

  const DIFFERENTIAL: readonly [DynType | ArrayType, unknown][] = [
    ['string', 'hello'],
    ['string', ''],
    ['string', 'héllo wörld ✓🚀'], // UTF-8 multi-byte
    ['string', 'x'.repeat(33)], // crosses a word boundary
    ['bytes', '0x'],
    ['bytes', '0xdeadbeef'],
    ['bytes', `0x${'42'.repeat(67)}`],
    ['uint256[]', []],
    ['uint256[]', [0n, 1n, 2n ** 256n - 1n]],
    ['int24[]', [-(2 ** 23), 2 ** 23 - 1, 0]],
    ['address[]', [`0x${'12'.repeat(20)}`, `0x${'34'.repeat(20)}`]],
    ['bool[]', [true, false, true]],
    ['bytes4[]', ['0xdeadbeef', '0x00000001']],
  ];

  test.each(DIFFERENTIAL)(
    'differential vs viem: memref equals the ABI tail of %s',
    (type, value) => {
      const viaViem = viemEncode(type, value);
      // single dynamic param ⇒ head is one offset word (0x20); the tail is the memref
      expect(viaViem.slice(2, 66)).toBe(LEN(32));
      expect(encodeLiteralData(type, value)).toBe(`0x${viaViem.slice(66)}`);
    },
  );

  test('mixed-case address elements are lowercased (checksum not enforced)', () => {
    const mixed = '0xAaAaAAaaAaaaAaAaAaaAAAaaAAAAaAaAAaaaAaAa';
    expect(encodeLiteralData('address[]', [mixed])).toBe(
      `0x${LEN(1)}${'0'.repeat(24)}${'aa'.repeat(20)}`,
    );
  });

  test('rejections', () => {
    expect(catchEvs(() => encodeLiteralData('string', 42)).code).toBe('TYPE_MISMATCH');
    expect(catchEvs(() => encodeLiteralData('bytes', 'deadbeef')).code).toBe('TYPE_MISMATCH');
    expect(catchEvs(() => encodeLiteralData('bytes', '0xabc')).code).toBe('LITERAL_RANGE'); // odd length
    expect(catchEvs(() => encodeLiteralData('uint8[]', '0x01')).code).toBe('TYPE_MISMATCH');
    // word types must go through encodeLiteralWord
    expect(catchEvs(() => encodeLiteralData('uint256' as DynType, 1n)).code).toBe('TYPE_MISMATCH');
    // non-v0 dynamic shapes
    expect(catchEvs(() => encodeLiteralData('string[]' as ArrayType, ['a'])).code).toBe(
      'UNSUPPORTED_V0',
    );
  });

  test('element errors name the index', () => {
    const err = catchEvs(() => encodeLiteralData('uint8[]', [1, 256]));
    expect(err.code).toBe('LITERAL_RANGE');
    expect(err.message).toContain('uint8[][1]');
    const err2 = catchEvs(() => encodeLiteralData('address[]', [`0x${'12'.repeat(20)}`, '0x99']));
    expect(err2.code).toBe('LITERAL_RANGE');
    expect(err2.message).toContain('address[][1]');
  });
});

// ---------------------------------------------------------------------------
// buildScriptAbi — the runtime mirror
// ---------------------------------------------------------------------------

describe('buildScriptAbi', () => {
  // args are now a positional EvsType list (auto-named arg0, arg1, … — script args carry no
  // names after the composite-types rewrite; viem infers `args` positionally regardless).
  const args = ['address', 'uint24'] as const;
  const returns = [
    { name: 'token0', type: 'address' },
    { name: 'symbol0', type: 'string' },
    { name: 'tick', type: 'int24' },
  ] as const;

  test('[function, EvsInvalidCalldata, EvsDecodeError] — orders preserved', () => {
    const abi = buildScriptAbi('poolMeta', args, returns);
    expect(abi).toEqual([
      {
        type: 'function',
        name: 'poolMeta',
        stateMutability: 'view',
        inputs: [
          { name: 'arg0', type: 'address' }, // = args list order, auto-named
          { name: 'arg1', type: 'uint24' },
        ],
        outputs: [
          {
            name: 'result',
            type: 'tuple',
            components: [
              { name: 'token0', type: 'address' }, // = returns insertion order
              { name: 'symbol0', type: 'string' },
              { name: 'tick', type: 'int24' },
            ],
          },
        ],
      },
      EVS_ERROR_ABI[0],
      EVS_ERROR_ABI[1],
    ]);
    // the error items are the shared constants, not copies
    expect(abi[1]).toBe(EVS_ERROR_ABI[0]);
    expect(abi[2]).toBe(EVS_ERROR_ABI[1]);
  });

  test('zero args / single return', () => {
    expect(buildScriptAbi('now_', [], [{ name: 'ts', type: 'uint256' }])[0]).toEqual({
      type: 'function',
      name: 'now_',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: 'result', type: 'tuple', components: [{ name: 'ts', type: 'uint256' }] }],
    });
  });

  test('output is deep-frozen', () => {
    const abi = buildScriptAbi('poolMeta', args, returns);
    const fn = abi[0] as Extract<(typeof abi)[number], { type: 'function' }>;
    expect(Object.isFrozen(abi)).toBe(true);
    expect(Object.isFrozen(fn)).toBe(true);
    expect(Object.isFrozen(fn.inputs)).toBe(true);
    expect(Object.isFrozen(fn.inputs[0])).toBe(true);
    expect(Object.isFrozen(fn.outputs)).toBe(true);
    expect(Object.isFrozen(fn.outputs[0])).toBe(true);
  });

  test('validation: names and v0 types', () => {
    expect(catchEvs(() => buildScriptAbi('not a name', args, returns)).code).toBe('ABI_SHAPE');
    // empty return keys would break viem's object inference (abitype §4.3) — hard error
    expect(catchEvs(() => buildScriptAbi('s', args, [{ name: '', type: 'address' }])).code).toBe(
      'ABI_SHAPE',
    );
    expect(
      catchEvs(() =>
        buildScriptAbi('s', args, [
          { name: 'x', type: 'uint8' },
          { name: 'x', type: 'uint8' },
        ]),
      ).code,
    ).toBe('ABI_SHAPE');
    // an invalid arg TYPE is reported against its auto-name (arg0), not a user-supplied name
    const badType = catchEvs(() => buildScriptAbi('s', ['uint256[2]' as 'uint256'], returns));
    expect(badType.code).toBe('UNSUPPORTED_V0');
    expect(badType.message).toContain('"arg0"');
  });

  test('tuple arg + tuple return expand to named-component tuple ABI params', () => {
    const params = t.struct({ tokenIn: t.address, fee: t.uint24 });
    const pos = t.struct({ liquidity: t.uint128, owner: t.address });
    const abi = buildScriptAbi('quote', [params], [{ name: 'pos', type: pos }]);
    const fn = abi[0] as Extract<(typeof abi)[number], { type: 'function' }>;
    expect(fn.inputs).toEqual([
      {
        name: 'arg0',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'fee', type: 'uint24' },
        ],
      },
    ]);
    const resultTuple = fn.outputs[0] as { components: readonly AbiParameter[] };
    expect(resultTuple.components).toEqual([
      {
        name: 'pos',
        type: 'tuple',
        components: [
          { name: 'liquidity', type: 'uint128' },
          { name: 'owner', type: 'address' },
        ],
      },
    ]);
  });
});
