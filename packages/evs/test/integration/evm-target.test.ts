/**
 * A script compiled for a fork the node does not run, on real nodes: one anvil pinned to Shanghai
 * and one to Paris (each a dedicated instance, apart from the per-worker one, which runs Prague).
 *
 * The same cause fails in two unrelated ways, and each has its explanation:
 *   - state-override mode: the node's own unsupported-opcode error, which is not a revert —
 *     `explainUnsupportedOpcode` reads it and names a target that runs;
 *   - deployless mode: an empty revert — `explainRevert('0x')` leads with the opcodes.
 * The node text is pinned too, as the docs name it.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import {
  compile,
  decodeScriptError,
  evscript,
  explainDeploylessError,
  explainUnsupportedOpcode,
  t,
  type EvmVersion,
} from '../../src/index.js';
import { ANVIL_POLLING_INTERVAL, spawnAnvil, type Anvil } from '../harness/anvil-process.ts';

/** Copies memory and pushes zero: `MCOPY` and `PUSH0` on cancun, `PUSH0` alone on shanghai. */
const echo = evscript({ name: 'echo', args: [t.string, t.bytes] }, (s, text, raw) =>
  s.return({ text, raw, hash: s.keccak256(raw) }),
);
const ARGS = ['evs', '0x1234'] as const;
const RESULT = {
  text: 'evs',
  raw: '0x1234',
  hash: '0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432',
};

/** Runs `call` and returns what it threw (fails the test when it does not throw). */
async function failure(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to fail');
}

describe.each([
  { hardfork: 'Shanghai', tooNew: ['cancun'], runs: ['shanghai', 'paris'] },
  { hardfork: 'Paris', tooNew: ['cancun', 'shanghai'], runs: ['paris'] },
] as const)('anvil on $hardfork', ({ hardfork, tooNew, runs }) => {
  let anvil: Anvil | undefined;
  let client: PublicClient;

  beforeAll(async () => {
    anvil = await spawnAnvil({ args: { hardfork } });
    client = createPublicClient({
      chain: foundry,
      transport: http(anvil.url),
      pollingInterval: ANVIL_POLLING_INTERVAL,
    });
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  const read = (evmVersion: EvmVersion, mode: 'deployless' | 'stateOverride') =>
    client.readContract({
      ...compile(echo, { evmVersion }).toViem({ mode }),
      functionName: 'echo',
      args: ARGS,
    });

  test.each(runs)('a %s build runs in both modes', async (evmVersion) => {
    expect(await read(evmVersion, 'deployless')).toStrictEqual(RESULT);
    expect(await read(evmVersion, 'stateOverride')).toStrictEqual(RESULT);
  });

  test.each(tooNew)(
    'a %s build in state-override mode: the node error is explained, and its target runs',
    async (evmVersion) => {
      const compiled = compile(echo, { evmVersion });
      const error = await failure(() => read(evmVersion, 'stateOverride'));
      // not a revert, not a deployless limit
      expect(decodeScriptError(compiled, error)).toBeUndefined();
      expect(explainDeploylessError(error)).toBeUndefined();

      const why = explainUnsupportedOpcode(compiled, error);
      expect(why?.kind).toBe('unsupported-opcode');
      expect(why?.nodeMessage).toMatch(/^EVM error:? NotActivated$/);
      expect(why?.opcode).toBeUndefined(); // revm names no opcode
      expect(why?.recompileWith).toBe('paris');
      expect(why?.message).toContain("recompile with evmVersion 'paris'");
      // the precompiled script explains it the same
      expect(explainUnsupportedOpcode(compiled.toPrecompiled(), error)).toStrictEqual(why);

      expect(await read(why?.recompileWith ?? evmVersion, 'stateOverride')).toStrictEqual(RESULT);
    },
  );

  test.each(tooNew)(
    'a %s build in deployless mode: an empty revert, whose explanation leads with the opcodes',
    async (evmVersion) => {
      const compiled = compile(echo, { evmVersion });
      const error = await failure(() => read(evmVersion, 'deployless'));
      expect(decodeScriptError(compiled, error)).toStrictEqual({ name: 'empty', raw: '0x' });
      // the node says only "execution reverted": nothing for the node-text helpers
      expect(explainUnsupportedOpcode(compiled, error)).toBeUndefined();
      expect(explainDeploylessError(error)).toBeUndefined();
      expect(compiled.explainRevert('0x').message).toMatch(
        new RegExp(
          '^empty revert payload \\(no returndata\\) — possible causes: \\(1\\) an opcode the ' +
            `node does not have at this block: the runtime uses .+ \\(evmVersion '${evmVersion}'\\)`,
        ),
      );
    },
  );
});
