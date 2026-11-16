/**
 * The tests of the app, run by the Vitest that the plugin's own tests start. Vitest reads the
 * app's Vite config, so `./scripts.evs.ts` comes precompiled by the plugin here.
 */
import { expect, test } from 'vite-plus/test';

import { aboveLimit as script } from './above-limit.ts';
import { aboveLimit } from './scripts.evs.ts';

test('the script holds the bytecode its sources compile to now', () => {
  expect(aboveLimit.runtimeBytecode).toBe(script.compile().runtimeBytecode);
});

test('the script loads its debug data', async () => {
  expect(await aboveLimit.debug()).toStrictEqual(await script.compile().toPrecompiled().debug());
});
