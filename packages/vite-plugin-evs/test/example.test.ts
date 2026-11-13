/**
 * The example app (`examples/vite-precompile`) builds through the plugin, taken from `src/`
 * here, without a warning and without the compiler.
 */

import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

// the example's script, run without the plugin
import { poolTokens } from '../../../examples/vite-precompile/src/pool.evs.ts';
import { buildApp, isCompilerModule, packageRoot, renderedModules } from './helpers.js';

const exampleRoot = join(packageRoot, '../../examples/vite-precompile');

test('examples/vite-precompile builds clean', async () => {
  const built = await buildApp('index.html', { root: exampleRoot });

  expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);
  expect(built.logs.warnings).toStrictEqual([]);
  expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
  // the page's script is the precompiled one: its bytecode is in the chunk as text
  expect(built.entry.code).toContain(poolTokens.runtimeBytecode);
});
