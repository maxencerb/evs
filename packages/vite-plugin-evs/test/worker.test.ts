/**
 * Web Workers. Vite bundles a worker apart, with the plugins of `worker.plugins` and none of the
 * app's: the plugin registers itself there, so a worker's scripts are precompiled and its bundle
 * is checked, and the build of the page reports both.
 */

import { join } from 'node:path';

import type { Plugin } from 'vite-plus';
import { describe, expect, test } from 'vite-plus/test';

import { evs } from '../src/index.js';
// the build-time modules of the fixture, run without the plugin
import { inPage } from './fixtures/worker/page.evs.ts';
import { inWorker } from './fixtures/worker/worker.evs.ts';
import { buildApp, buildFailure, packageRoot, type BuildOptions, type Built } from './helpers.js';

const root = join(packageRoot, 'test/fixtures/worker');

async function buildPage(entry: string, options: BuildOptions = {}): Promise<Built> {
  return buildApp(entry, { root, ...options });
}

/** The files of the bundle of the worker `name`, as text by file name. */
function workerFiles(built: Built, name: string): Map<string, string> {
  return new Map(
    built.assets
      .filter((asset) => asset.fileName.startsWith(`assets/${name}-`))
      .map((asset) => [asset.fileName, Buffer.from(asset.source).toString()]),
  );
}

/** A plugin for `worker.plugins` that records the plugins at work in each worker bundle. */
function workerRecorder(): { plugin: Plugin; pluginsAtWork: string[][] } {
  const pluginsAtWork: string[][] = [];
  return {
    pluginsAtWork,
    plugin: {
      name: 'worker-recorder',
      buildStart() {
        pluginsAtWork.push(this.environment.plugins.map((plugin) => plugin.name));
      },
    },
  };
}

describe('a worker that only runs precompiled scripts', () => {
  test('gets them precompiled, with nothing about workers in the config', async () => {
    const built = await buildPage('main.ts');
    const [[, code = ''] = []] = workerFiles(built, 'worker');

    expect(code).toContain(inWorker.runtimeBytecode);
    expect(built.entry.code).toContain(inPage.runtimeBytecode);
    // Measured: 43 kB, the script, the runtime entry and the explain code, which the default
    // worker format (one file, no import) cannot leave to another file. The compiler is 200 kB.
    expect(code.length).toBeLessThan(60_000);
  });

  test('is counted with the page: one line for the build', async () => {
    const built = await buildPage('main.ts');
    expect(built.pluginInfo).toStrictEqual(['precompiled 2 scripts from 2 files']);
    expect(built.logs.warnings).toStrictEqual([]);
  });

  test('keeps the explain code and the debug data on demand when it is an ES module', async () => {
    const built = await buildPage('main.ts', { config: { worker: { format: 'es' } } });
    const [[, code = ''] = []] = workerFiles(built, 'worker');

    expect(code).toContain(inWorker.runtimeBytecode);
    expect(code.length).toBeLessThan(12_000);
    const others = built.assets.map((asset) => asset.fileName);
    expect(others.filter((name) => /^assets\/explain-.*\.js$/.test(name))).toHaveLength(1);
    expect(others.filter((name) => name.includes('worker.evs.inWorker.debug-'))).toHaveLength(1);
    expect(built.pluginInfo).toStrictEqual(['precompiled 2 scripts from 2 files']);
    expect(built.logs.warnings).toStrictEqual([]);
  });

  test('shares a build-time module with the page: it is counted once', async () => {
    const built = await buildPage('main-shared.ts');
    const [[, code = ''] = []] = workerFiles(built, 'worker-shared');
    expect(code).toContain(inPage.runtimeBytecode);
    expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);
    expect(built.logs.warnings).toStrictEqual([]);
  });
});

describe('a worker that compiles at run time', () => {
  test('is in the report of the build, as a chunk loaded in a worker', async () => {
    const built = await buildPage('main-compiling.ts');
    const [workerFile = ''] = workerFiles(built, 'worker-compiling').keys();
    expect(built.pluginInfo).toStrictEqual(['precompiled 2 scripts from 2 files']);

    expect(built.logs.warnings).toHaveLength(1);
    const kilobytes = /about (\d+) kB/.exec(built.pluginWarnings[0] ?? '')?.[1];
    expect(Number(kilobytes)).toBeGreaterThan(100);
    expect(built.pluginWarnings[0]).toBe(
      [
        `The evs compiler is in the client bundle: about ${kilobytes} kB before compression.`,
        '',
        '2 scripts from 2 files were precompiled, but the compiler still ships in:',
        `  ${workerFile}  loaded in a worker`,
        '',
        `It comes in through the modules that import '@maxencerb/evs':`,
        '  worker-compiling.ts',
        '',
        'To keep it out:',
        '  - move the scripts these modules compile into a *.evs.ts file',
        `  - import run-time helpers (decodeScriptError, ...) from '@maxencerb/evs/runtime'`,
        `  - or set evs({ compilerInBundle: 'ignore' }) if compiling in the browser is intended`,
      ].join('\n'),
    );
  });

  test('is reported from two bundles down: a worker started by a worker', async () => {
    const built = await buildPage('main-nested.ts');
    const [workerFile = ''] = workerFiles(built, 'worker-compiling').keys();
    expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);
    expect(built.logs.warnings).toHaveLength(1);
    expect(built.pluginWarnings[0]).toContain(`  ${workerFile}  loaded in a worker\n`);
    expect(built.pluginWarnings[0]).toContain('\n  worker-compiling.ts\n');
  });

  test(`fails the build with compilerInBundle: 'error'`, async () => {
    const message = await buildFailure('main-compiling.ts', {
      root,
      plugin: { compilerInBundle: 'error' },
    });
    expect(message).toContain('The evs compiler is in the client bundle: about ');
    expect(message).toContain('  loaded in a worker\n');
  });

  test(`is not looked at with compilerInBundle: 'ignore'`, async () => {
    const built = await buildPage('main-compiling.ts', { plugin: { compilerInBundle: 'ignore' } });
    expect(built.logs.warnings).toStrictEqual([]);
    expect(built.pluginInfo).toStrictEqual(['precompiled 2 scripts from 2 files']);
  });
});

describe('the worker.plugins of the app', () => {
  test('are kept: the plugin adds itself to them', async () => {
    const recorder = workerRecorder();
    const built = await buildPage('main.ts', {
      config: { worker: { plugins: () => [recorder.plugin] } },
    });
    expect(recorder.pluginsAtWork).toHaveLength(1);
    expect(recorder.pluginsAtWork[0]).toContain('evs:worker');
    expect(built.pluginInfo).toStrictEqual(['precompiled 2 scripts from 2 files']);
  });

  test('can list evs() by hand: it stands down, and nothing is done or said twice', async () => {
    const recorder = workerRecorder();
    const built = await buildPage('main-compiling.ts', {
      config: { worker: { plugins: () => [evs(), recorder.plugin] } },
    });
    const ofEvs = recorder.pluginsAtWork.map((names) =>
      names.filter((name) => name.startsWith('evs')),
    );
    expect(ofEvs).toStrictEqual([['evs:worker']]);
    expect(built.pluginInfo).toStrictEqual(['precompiled 2 scripts from 2 files']);
    expect(built.logs.warnings).toHaveLength(1);
  });

  test('alone, without evs() in plugins: each worker bundle reports for itself', async () => {
    const built = await buildPage('main-compiling.ts', {
      config: { plugins: [], worker: { plugins: () => [evs()] } },
    });
    // the page has no plugin: its build-time module is a plain module, compiled in the browser
    expect(built.entry.code).not.toContain(inPage.runtimeBytecode);
    expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);
    expect(built.pluginWarnings).toHaveLength(1);
    expect(built.pluginWarnings[0]).toContain('  loaded in a worker\n');
  });
});
