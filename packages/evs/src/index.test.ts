/**
 * The package's runtime export surface, pinned by name. `index.ts` is the single entry point
 * (the exports map blocks deep imports), so adding, renaming or dropping a runtime export must
 * show up here — and in the PR diff — rather than only in whichever integration test or docs
 * snippet happens to import that name.
 */

import { expect, test } from 'vite-plus/test';

import * as evs from './index.js';

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
