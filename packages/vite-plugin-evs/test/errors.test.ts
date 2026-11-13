/**
 * The builds the plugin refuses. Each message names the file and the export, and says what to
 * change: the texts are part of the plugin's interface, so the tests quote them in full.
 */

import { describe, expect, test } from 'vite-plus/test';

import { buildFailure } from './helpers.js';

describe('an export that cannot be precompiled', () => {
  test('a function: a script factory', async () => {
    expect(await buildFailure('errors/factory.evs.ts')).toContain(
      'errors/factory.evs.ts: the export `constant` is a function, and a function cannot be ' +
        'precompiled. If it builds a script, turn its parameters into script arguments, or call ' +
        'it here with values known at build time.',
    );
  });

  test('a script that was not compiled', async () => {
    expect(await buildFailure('errors/uncompiled.evs.ts')).toContain(
      'errors/uncompiled.evs.ts: the export `one` is a script that was not compiled. Export ' +
        '`evscript(...).compile().toPrecompiled()`.',
    );
  });

  test('a compiled script that was not narrowed', async () => {
    expect(await buildFailure('errors/compiled.evs.ts')).toContain(
      'errors/compiled.evs.ts: the export `default` is a compiled script, which holds the ' +
        'whole output of the compiler. Add `.toPrecompiled()` after `.compile()` to export the ' +
        'part a client runs.',
    );
  });

  test('a precompiled script inside another value', async () => {
    expect(await buildFailure('errors/nested-script.evs.ts')).toContain(
      'errors/nested-script.evs.ts: the export `scripts.one` is a precompiled script inside ' +
        'another value. Give each script an export of its own, so the bundler can drop the ' +
        'ones a page does not use.',
    );
  });

  test('a value that is not plain data, named by its path', async () => {
    expect(await buildFailure('errors/class-instance.evs.ts')).toContain(
      'errors/class-instance.evs.ts: the export `config.cache` is an instance of Map, which ' +
        'cannot be written into the bundle. A *.evs.ts module exports precompiled scripts and ' +
        'plain data (what JSON holds, plus bigint and undefined).',
    );
  });
});

describe('a module that throws while it runs', () => {
  test('a script that fails to compile keeps the compiler’s message and its stack', async () => {
    const message = await buildFailure('errors/compile-error.evs.ts');
    expect(message).toContain(
      'errors/compile-error.evs.ts: the module threw while it ran at build time.\n' +
        'EvsCompileError: compile: unknown evmVersion "homestead"',
    );
    expect(message).toMatch(/\n {4}at .*compile-error\.evs\.ts/); // a frame in the module
    expect(message).not.toContain('runs in Node');
  });

  test('a module that touches `window` is told where it runs', async () => {
    const message = await buildFailure('errors/window.evs.ts');
    expect(message).toContain(
      'errors/window.evs.ts: the module threw while it ran at build time.\n' +
        'ReferenceError: window is not defined\n' +
        '`window` does not exist here: a *.evs.ts module runs in Node at build time. Keep ' +
        'browser code out of it and out of the files it imports.',
    );
    expect(message).toMatch(/\n {4}at .*window\.evs\.ts:\d+/); // a frame in the module
  });
});
