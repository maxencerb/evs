/**
 * What a build through the plugin produces: the same scripts as without it, the compiler left
 * out, and what `explainRevert` needs in chunks that load on demand.
 */

import { encodeErrorResult, getAddress } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { isPrecompiledScript, type PrecompiledScript } from '@maxencerb/evs/runtime';

// the same file, without the plugin: Vitest runs it as the plain module it is
import * as direct from './fixtures/app/scripts.evs.ts';
import {
  appRoot,
  buildApp,
  isCompilerModule,
  renderedModules,
  upFrontChunks,
  type Built,
} from './helpers.js';

/** The precompiled script a built module exports under `name`. */
function scriptOf(module: Record<string, unknown>, name: string): PrecompiledScript {
  const value = module[name];
  if (!isPrecompiledScript(value)) throw new TypeError(`\`${name}\` is not a precompiled script`);
  return value;
}

const SCRIPTS = [
  ['sum', direct.sum],
  ['atLeast', direct.atLeast],
  ['chain', direct.default],
] as const;

const CUSTOM_ADDRESS = getAddress('0x00000000000000000000000000000000000eff02');
const SENDER = getAddress('0x00000000000000000000000000000000000eff03');

/** Every shape `toViem()` has. */
function viemShapes(script: PrecompiledScript): unknown[] {
  return [
    script.toViem(),
    script.toViem({ mode: 'deployless' }),
    script.toViem({ mode: 'stateOverride' }),
    script.toViem({ mode: 'stateOverride', address: CUSTOM_ADDRESS }),
    script.toViem({ mode: 'stateOverride', sender: SENDER }),
  ];
}

describe('the scripts of a built app', () => {
  let built: Built;
  let module: Record<string, unknown>;

  beforeAll(async () => {
    built = await buildApp('clean.ts', { write: true });
    module = await built.importEntry();
  });

  test('the output exports what the module exports', () => {
    expect(Object.keys(module).toSorted()).toStrictEqual(
      ['MIN_VALUE', 'atLeast', 'chain', 'settings', 'sum'].toSorted(),
    );
  });

  test.for(SCRIPTS)(
    '%s holds the bytecode the file compiles to without the plugin',
    ([name, expected]) => {
      const script = scriptOf(module, name);
      expect(script.runtimeBytecode).toBe(expected.runtimeBytecode);
      expect(script.initBytecode).toBe(expected.initBytecode);
      expect(script.evmVersion).toBe(expected.evmVersion);
      expect(script.abi).toStrictEqual(expected.abi);
      // and the bytes are in the chunk as text, not derived at run time
      expect(built.entry.code).toContain(expected.runtimeBytecode);
    },
  );

  test.for(SCRIPTS)('%s has the same toViem() in every mode', ([name, expected]) => {
    expect(viemShapes(scriptOf(module, name))).toStrictEqual(viemShapes(expected));
  });

  test('plain data is exported as the values it was', () => {
    expect(module.MIN_VALUE).toBe(10n);
    expect(module.settings).toStrictEqual(direct.settings);
  });

  test('explainRevert loads the debug data and explains like the unbundled script', async () => {
    const script = scriptOf(module, 'atLeast');
    const revert = encodeErrorResult({
      abi: direct.atLeast.abi,
      errorName: 'TooSmall',
      args: [5n],
    });
    const explained = await script.explainRevert(revert);
    expect(explained.kind).toBe('script-error');
    expect(explained).toStrictEqual(await direct.atLeast.explainRevert(revert));
    expect(await script.debug()).toStrictEqual(await direct.atLeast.debug());
  });

  test('no module of the compiler has code in the output', () => {
    expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
  });

  test('the explain code and the debug data are in on-demand chunks', () => {
    const upFront = upFrontChunks(built);
    const onDemand = built.chunks.filter((chunk) => !upFront.includes(chunk));

    const isExplainOrDebug = (id: string): boolean =>
      id.endsWith('/evs/dist/explain.js') || id.startsWith('\0virtual:evs-debug:');
    expect(renderedModules(upFront).filter(isExplainOrDebug)).toStrictEqual([]);
    // one debug chunk per script, and the explain code
    expect(renderedModules(onDemand).filter(isExplainOrDebug)).toHaveLength(SCRIPTS.length + 1);
    for (const chunk of onDemand) expect(built.entry.imports).not.toContain(chunk.fileName);
  });

  test('what the page downloads up front stays small', () => {
    const bytes = upFrontChunks(built).reduce((total, chunk) => total + chunk.code.length, 0);
    // Measured: 8.7 kB minified for the three scripts (bytecode and ABI), their plain data,
    // the runtime entry and Vite's dynamic-import helper. The explain code alone is 36 kB and
    // the compiler over 200 kB, so anything dragged in by mistake lands far above the budget.
    expect(bytes).toBeLessThan(12_000);
  });

  test('one info line says what was precompiled, and nothing warns', () => {
    expect(built.pluginInfo).toStrictEqual(['precompiled 3 scripts from 1 file']);
    expect(built.logs.warnings).toStrictEqual([]);
  });
});

test('a script the app does not use is dropped from the bundle', async () => {
  const built = await buildApp('only-sum.ts');
  const code = built.chunks.map((chunk) => chunk.code).join('\n');
  expect(code).toContain(direct.sum.runtimeBytecode);
  expect(code).not.toContain(direct.atLeast.runtimeBytecode);
  expect(code).not.toContain(direct.default.runtimeBytecode);
  const debugChunks = renderedModules(built.chunks).filter((id) => id.startsWith('\0virtual:'));
  expect(debugChunks).toHaveLength(1);
});

test('the replaced module gets an empty source map, so the bundler does not warn', async () => {
  const built = await buildApp('clean.ts', { config: { build: { sourcemap: true } } });
  expect(built.logs.warnings).toStrictEqual([]);
});

test('the module resolves its imports like the app: aliases and the mode', async () => {
  const built = await buildApp('aliased.evs.ts', {
    write: true,
    config: { mode: 'staging', resolve: { alias: { '~limits': `${appRoot}/limits.ts` } } },
  });
  expect(await built.importEntry()).toMatchObject({ min: 10n, mode: 'staging' });
  // a module without scripts is still a build-time module: plain data only
  expect(built.pluginInfo).toStrictEqual([
    'no script was precompiled: this build has no *.evs.ts module that exports one',
  ]);
});

describe('a server build', () => {
  test('precompiles the scripts too', async () => {
    const built = await buildApp('clean.ts', { write: true, config: { build: { ssr: true } } });
    const module = await built.importEntry();
    for (const [name, expected] of SCRIPTS) {
      expect(viemShapes(scriptOf(module, name))).toStrictEqual(viemShapes(expected));
    }
    expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
  });
});
