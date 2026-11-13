/**
 * End to end: a fixture app is built through the plugin, the output is imported as a browser
 * would import it, and its scripts run against anvil with viem, in deployless and
 * state-override mode. Nothing here compiles a script: the test holds what the bundle holds.
 */

import { createPublicClient, getAddress, http } from 'viem';
import { foundry } from 'viem/chains';
import { beforeAll, describe, expect, inject, test } from 'vite-plus/test';

import {
  decodeScriptError,
  isPrecompiledScript,
  type PrecompiledScript,
} from '@maxencerb/evs/runtime';

// the same module without the plugin: the reference every result is compared with
import * as direct from '../fixtures/app/scripts.evs.ts';
import { buildApp, isCompilerModule, renderedModules, type Built } from '../helpers.js';

const client = createPublicClient({ chain: foundry, transport: http(inject('anvilUrl')) });

const CALLER = getAddress('0x00000000000000000000000000000000000eff03');

/** The two ways a script reaches the node, as `toViem()` options. */
const MODES = [{ mode: 'deployless' }, { mode: 'stateOverride' }] as const;

let built: Built;
let scripts: Record<'sum' | 'atLeast' | 'chain', PrecompiledScript>;

beforeAll(async () => {
  built = await buildApp('clean.ts', { write: true });
  const { sum, atLeast, chain } = await built.importEntry();
  if (!isPrecompiledScript(sum) || !isPrecompiledScript(atLeast) || !isPrecompiledScript(chain)) {
    throw new TypeError('the built app does not export its three precompiled scripts');
  }
  scripts = { sum, atLeast, chain };
});

test('the bundle under test holds no compiler', () => {
  expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
});

describe('a script from the bundle, against anvil', () => {
  const sumCall = { functionName: 'sum', args: [[1n, 2n, 3n, 2n ** 128n]] } as const;

  test.for(MODES)('$mode: computes over its arguments', async (options) => {
    const result = await client.readContract({ ...scripts.sum.toViem(options), ...sumCall });
    expect(result).toStrictEqual({ total: 6n + 2n ** 128n });
    expect(result).toStrictEqual(
      await client.readContract({ ...direct.sum.toViem(options), ...sumCall }),
    );
  });

  test('state override in sender mode: the script runs as the caller', async () => {
    const shape = scripts.sum.toViem({ mode: 'stateOverride', sender: CALLER });
    expect(await client.readContract({ ...shape, ...sumCall })).toStrictEqual({
      total: 6n + 2n ** 128n,
    });
  });

  test.for(MODES)('$mode: the default export reads the chain', async (options) => {
    const call = { functionName: 'chain' } as const;
    const result = await client.readContract({ ...scripts.chain.toViem(options), ...call });
    expect(result).toMatchObject({ chainId: 31337n });
    expect(result).toStrictEqual(
      await client.readContract({ ...direct.default.toViem(options), ...call }),
    );
  });

  test.for(MODES)('$mode: a value that passes the check is returned', async (options) => {
    const result = await client.readContract({
      ...scripts.atLeast.toViem(options),
      functionName: 'atLeast',
      args: [10n],
    });
    expect(result).toStrictEqual({ value: 10n });
  });

  test.for(MODES)(
    '$mode: a real revert decodes from the ABI and is explained from the on-demand chunks',
    async (options) => {
      const error: unknown = await client
        .readContract({ ...scripts.atLeast.toViem(options), functionName: 'atLeast', args: [9n] })
        .then(
          () => expect.unreachable('expected the call to revert'),
          (reason: unknown) => reason,
        );
      const decoded = decodeScriptError(scripts.atLeast, error);
      if (decoded === undefined) throw new TypeError('expected revert data in the error');
      expect(decoded).toMatchObject({ name: 'TooSmall', args: { value: 9n } });

      // loads the script's debug chunk and the explain chunk of the build
      const explained = await scripts.atLeast.explainRevert(decoded.raw);
      expect(explained.kind).toBe('script-error');
      expect(explained).toStrictEqual(await direct.atLeast.explainRevert(decoded.raw));
    },
  );
});
