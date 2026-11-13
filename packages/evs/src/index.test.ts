/**
 * The package's runtime export surface, pinned by name, for its two entries: `index.ts` (the
 * main one) and `runtime.ts` (`@maxencerb/evs/runtime`, the compiler-free subset). The exports
 * map blocks every other deep import, so adding, renaming or dropping a runtime export must show
 * up here — and in the PR diff — rather than only in whichever integration test or docs snippet
 * happens to import that name.
 */

import { expect, test } from 'vite-plus/test';

import * as evs from './index.js';
import * as runtime from './runtime.js';

test('runtime exports are exactly the documented public surface', () => {
  expect(Object.keys(evs).toSorted()).toEqual([
    'DEFAULT_SCRIPT_ADDRESS',
    'DEPLOYLESS_MAX_DATA_BYTES',
    'DEPLOYLESS_MAX_RESULT_BYTES',
    'EVS_ERROR_ABI',
    'EvsCompileError',
    'EvsError',
    'EvsInternalError',
    'EvsScopeError',
    'EvsStagingError',
    'EvsTypeError',
    'compile',
    'dce',
    'decodeScriptError',
    'deploylessDataSize',
    'deserializeIr',
    'disassemble',
    'eliminateDeadCode',
    'evsPeephole',
    'evscript',
    'explainDeploylessError',
    'interpret',
    'lookupPc',
    'matchScriptError',
    'namedArg',
    'serializeIr',
    't',
  ]);
  // `dce` is an alias, not a second implementation
  expect(evs.dce).toBe(evs.eliminateDeadCode);
});

test('the runtime entry exports exactly its documented surface, a subset of the main one', () => {
  const names = Object.keys(runtime).toSorted();
  expect(names).toEqual([
    'DEFAULT_SCRIPT_ADDRESS',
    'DEPLOYLESS_MAX_DATA_BYTES',
    'DEPLOYLESS_MAX_RESULT_BYTES',
    'EvsCompileError',
    'EvsError',
    'EvsInternalError',
    'EvsScopeError',
    'EvsStagingError',
    'EvsTypeError',
    'decodeScriptError',
    'deploylessDataSize',
    'explainDeploylessError',
    'hydrate',
    'isPrecompiledScript',
    'matchScriptError',
  ]);
  // `hydrate` and `isPrecompiledScript` are the runtime entry's alone (getting them from the
  // main entry would pull the compiler); everything else is the main entry's own export
  const { hydrate, isPrecompiledScript, ...shared } = runtime;
  expect(evs).not.toHaveProperty('hydrate');
  expect(evs).not.toHaveProperty('isPrecompiledScript');
  const main: Readonly<Record<string, unknown>> = evs;
  expect(Object.entries(shared).filter(([name, value]) => main[name] !== value)).toEqual([]);
  expect(isPrecompiledScript(hydrate)).toBe(false);
});
