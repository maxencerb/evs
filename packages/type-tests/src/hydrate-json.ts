import { createPublicClient, http, type Abi } from 'viem';

/**
 * A precompiled script read from JSON files. A JSON module has no literal types: `version` is a
 * `number`, the bytecode a `string`, the ABI an array of loose objects. `hydrate` takes that
 * shape and gives a script with a wide ABI, where the same data in an `as const` module keeps
 * what viem infers from it.
 */
import { hydrate, type PrecompiledScript } from '@maxencerb/evs/runtime';

import { expectType, type Same } from './assert.js';
import json from './double.json' with { type: 'json' };

// the JSON module itself: no literal survives
expectType<Same<typeof json.version, number>>();
expectType<Same<typeof json.runtimeBytecode, string>>();

const fromJson = hydrate(json);
expectType<Same<typeof fromJson, PrecompiledScript<Abi>>>();

// the debug data of a JSON module is as wide, and its loader is accepted
const withDebug = hydrate(json, {
  debug: () => import('./double.debug.json', { with: { type: 'json' } }),
});
expectType<Same<typeof withDebug, PrecompiledScript<Abi>>>();

// on one line: the checkers do not report a call that matches no overload at the same place
const notDebugData = () => import('./double.json', { with: { type: 'json' } });
// @ts-expect-error the script's data is not its debug data
hydrate(json, { debug: notDebugData });

// the same data in an `as const` module keeps its literal ABI, whatever the loader resolves to
const literal = hydrate(
  {
    version: 1,
    id: '0xb3356908ed9344d8',
    abi: [
      {
        type: 'function',
        name: 'double',
        stateMutability: 'view',
        inputs: [{ name: 'arg0', type: 'uint256' }],
        outputs: [
          { name: 'result', type: 'tuple', components: [{ name: 'doubled', type: 'uint256' }] },
        ],
      },
    ],
    runtimeBytecode: '0x00',
    evmVersion: 'cancun',
  } as const,
  { debug: () => import('./double.debug.json', { with: { type: 'json' } }) },
);
expectType<Same<(typeof literal)['abi'][0]['name'], 'double'>>();

// `JSON.parse` returns `any`: the script is as wide, and nothing says so
declare const text: string;
const parsed = hydrate(JSON.parse(text));
expectType<Same<(typeof parsed)['abi'], Abi | readonly unknown[]>>();

const client = createPublicClient({ transport: http('http://127.0.0.1:8545') });

export async function run(): Promise<bigint> {
  // a wide ABI: the call is accepted, and nothing is inferred from the script
  const wide = await client.readContract({
    ...fromJson.toViem(),
    functionName: 'double',
    args: [21n],
  });
  expectType<Same<typeof wide, unknown>>();

  const typed = await client.readContract({
    ...literal.toViem(),
    functionName: 'double',
    args: [21n],
  });
  expectType<Same<typeof typed, { doubled: bigint }>>();

  await client.readContract({
    ...literal.toViem(),
    // @ts-expect-error the literal ABI has no such function
    functionName: 'triple',
    args: [21n],
  });

  return typed.doubled;
}
