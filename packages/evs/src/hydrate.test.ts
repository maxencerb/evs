/**
 * Unit tests — `hydrate.ts` as a client loads it: without the compiler. The explain code is a
 * chunk a client fetches on demand, so when it is imported is part of the contract, and only a
 * file that never imports the compiler can observe it (`compile.ts` imports the explain code
 * statically).
 *
 * The script is therefore written out: the two documents a build step serialized for
 * `double(uint256)`. They do not have to follow the compiler. A later one may emit other bytes,
 * and these two still hydrate and still pair.
 */

import { expect, test, vi } from 'vite-plus/test';

import { hydrate } from './hydrate.js';

const explainCode = vi.hoisted(() => ({ imports: 0 }));

vi.mock('./explain.js', async (importOriginal) => {
  explainCode.imports += 1;
  return importOriginal<typeof import('./explain.js')>();
});

const DATA = {
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
    { type: 'error', name: 'EvsInvalidCalldata', inputs: [] },
    { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
  ],
  runtimeBytecode:
    '0x3661000657005b60c06040526004361061007b575f3560e01c63eee97206146100275761007b565b6024361061007b576004356080526080518060025f1904106100625760020260a0526040516020015f5260a05160405152604051805f510390f35b6011610069565b634e487b7160e01b5f5260045260245ffd5b63f43fed5660e01b5f5260045ffd',
  evmVersion: 'cancun',
} as const;

const DEBUG = {
  version: 1,
  id: '0xb3356908ed9344d8',
  ir: {
    irVersion: 1,
    name: 'double',
    args: [{ name: 'arg0', type: 'uint256' }],
    values: [{ type: 'uint256', debugName: 'args.arg0' }, { type: 'uint256' }, { type: 'uint256' }],
    cells: [],
    fns: [],
    body: [
      {
        k: 'const',
        out: 1,
        data: {
          kind: 'word',
          hex: '0x0000000000000000000000000000000000000000000000000000000000000002',
        },
        type: 'uint256',
        site: 0,
      },
      { k: 'bin', op: 'mul', a: 0, b: 1, out: 2, site: 1 },
    ],
    returns: [{ name: 'doubled', type: 'uint256', value: 2 }],
  },
  sites: [
    { id: 0, kind: 'stmt', detail: 'const' },
    {
      id: 1,
      kind: 'panic',
      detail: 'checked mul args.arg0 * 2 (uint256) — Panic 0x11',
      panicCodes: [17],
    },
  ],
} as const;

const OVERFLOW = '0x4e487b710000000000000000000000000000000000000000000000000000000000000011';

// one test: the import count is the module's, and the steps below are in the order a client
// goes through them
test('the explain code is imported by the first explanation that can succeed, and no sooner', async () => {
  // hydrating and running a script loads nothing
  const bare = hydrate(DATA);
  const script = hydrate(DATA, { debug: () => Promise.resolve(DEBUG) });
  expect(bare.toViem().code).toBe(script.initBytecode);
  expect(script.toViem({ mode: 'stateOverride' }).stateOverride[0].code).toBe(DATA.runtimeBytecode);
  expect(explainCode.imports).toBe(0);

  // without a debug loader the answer is known: nothing is fetched to give it
  await expect(bare.explainRevert(OVERFLOW)).rejects.toMatchObject({
    name: 'EvsError',
    code: 'DEBUG_DATA_MISSING',
  });
  await expect(bare.debug()).rejects.toMatchObject({ code: 'DEBUG_DATA_MISSING' });
  expect(explainCode.imports).toBe(0);

  // with one, the first explanation imports the code, once
  const explanation = await script.explainRevert(OVERFLOW);
  expect(explanation.kind).toBe('panic');
  expect(explanation.candidateSites).toEqual([
    { id: 1, detail: 'checked mul args.arg0 * 2 (uint256) — Panic 0x11' },
  ]);
  expect(explainCode.imports).toBe(1);
  expect(await script.debug()).toBe(DEBUG);
  await script.explainRevert('0x');
  expect(explainCode.imports).toBe(1);
});
