// The type-level canonical signatures agree character-for-character with the runtime ones
// (signature.test.ts pins the same fixtures at run time).
import { expectTypeOf, test } from 'vite-plus/test';

import type {
  AbiFunctionSignature,
  AbiParameterSignature,
  AbiParametersSignature,
  SignatureName,
} from './signature.js';

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
] as const;

test('a tuple-array parameter keeps its suffix chain after the expanded components', () => {
  expectTypeOf<
    AbiParameterSignature<(typeof ABI)[0]['inputs'][0]>
  >().toEqualTypeOf<'(uint256,(address[]))[2][]'>();
  expectTypeOf<
    AbiParametersSignature<
      readonly [
        { readonly type: 'uint8' },
        {
          readonly type: 'tuple[]';
          readonly components: readonly [
            { readonly name: 'b'; readonly type: 'bytes32' },
            { readonly type: 'string[]' },
          ];
        },
      ]
    >
  >().toEqualTypeOf<'uint8,(bytes32,string[])[]'>();
  expectTypeOf<AbiParametersSignature<readonly []>>().toEqualTypeOf<''>();
});

test('a function signature, one per overload of a union', () => {
  expectTypeOf<
    AbiFunctionSignature<(typeof ABI)[0]>
  >().toEqualTypeOf<'get((uint256,(address[]))[2][])'>();
  expectTypeOf<AbiFunctionSignature<(typeof ABI)[number]>>().toEqualTypeOf<
    'get((uint256,(address[]))[2][])' | 'get(uint256)'
  >();
});

test('a widened parameter list admits any signature', () => {
  expectTypeOf<
    AbiFunctionSignature<{ name: 'f'; inputs: readonly { type: string }[] }>
  >().toEqualTypeOf<`f(${string})`>();
});

test('SignatureName strips the parameter list', () => {
  expectTypeOf<SignatureName<'get((uint256,(address[]))[2][])'>>().toEqualTypeOf<'get'>();
  expectTypeOf<SignatureName<'get'>>().toEqualTypeOf<'get'>();
});
