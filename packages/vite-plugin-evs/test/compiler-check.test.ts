/**
 * The bundle check: a build reports the evs compiler when it reaches the client output, and
 * says where it is and which module brought it.
 */

import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Plugin, Rolldown } from 'vite-plus';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { evs } from '../src/index.js';
import {
  buildApp,
  buildFailure,
  isCompilerModule,
  packageRoot,
  renderedModules,
  upFrontChunks,
} from './helpers.js';

const FIXES = [
  'To keep it out:',
  '  - move the scripts these modules compile into a *.evs.ts file',
  `  - import run-time helpers (decodeScriptError, ...) from '@maxencerb/evs/runtime'`,
  `  - or set evs({ compilerInBundle: 'ignore' }) if compiling in the browser is intended`,
].join('\n');

describe('an app that keeps the compiler out', () => {
  test('one that only runs precompiled scripts is not warned, by the plugin or the bundler', async () => {
    // (the plugin drops a log of the bundler: this build must not need that)
    const built = await buildApp('clean.ts');
    expect(built.logs.warnings).toStrictEqual([]);

    // and the explain code stays in a chunk of its own, which nothing loads up front
    const isExplain = (id: string): boolean => id.endsWith('/evs/dist/explain.js');
    const withExplain = built.chunks.filter((chunk) => renderedModules([chunk]).some(isExplain));
    expect(withExplain).toHaveLength(1);
    expect(upFrontChunks(built)).not.toContain(withExplain[0]);
  });

  test('taking a helper from the main entry is fine: tree shaking drops the compiler', async () => {
    const built = await buildApp('helpers-from-main.ts');
    expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
    expect(built.pluginWarnings).toStrictEqual([]);
  });

  test('and that holds in an app without any build-time module', async () => {
    const built = await buildApp('helpers-only.ts');
    expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
    expect(built.logs.warnings).toStrictEqual([]);
  });
});

describe('an app that also compiles at run time', () => {
  test('behind a static import: the compiler is loaded up front', async () => {
    const built = await buildApp('compiler-static.ts');
    expect(renderedModules(built.chunks).some(isCompilerModule)).toBe(true);
    expect(built.pluginInfo).toStrictEqual(['precompiled 3 scripts from 1 file']);

    expect(built.pluginWarnings).toHaveLength(1);
    const kilobytes = /about (\d+) kB/.exec(built.pluginWarnings[0] ?? '')?.[1];
    expect(Number(kilobytes)).toBeGreaterThan(100);
    expect(built.pluginWarnings[0]).toBe(
      [
        `The evs compiler is in the client bundle: about ${kilobytes} kB before compression.`,
        '',
        '3 scripts from 1 file were precompiled, but the compiler still ships in:',
        `  ${built.entry.fileName}  loaded up front`,
        '',
        `It comes in through the modules that import '@maxencerb/evs':`,
        '  compiler-static.ts',
        '',
        FIXES,
      ].join('\n'),
    );
  });

  test('behind a dynamic import: the compiler is loaded on demand', async () => {
    const built = await buildApp('compiler-dynamic.ts');
    const compilerChunks = built.chunks.filter((chunk) =>
      renderedModules([chunk]).some(isCompilerModule),
    );
    expect(compilerChunks).toHaveLength(1);
    expect(compilerChunks[0]).not.toBe(built.entry);

    expect(built.pluginWarnings).toHaveLength(1);
    const [warning = ''] = built.pluginWarnings;
    expect(warning).toContain(`  ${compilerChunks[0]?.fileName}  loaded on demand\n`);
    expect(warning).not.toContain('loaded up front');
    expect(warning).toContain(
      `It comes in through the modules that import '@maxencerb/evs':\n  compiler-dynamic.ts\n`,
    );
    expect(warning).toContain(FIXES);
  });
});

describe('an app that precompiles nothing', () => {
  const NOTHING_PRECOMPILED =
    'no script was precompiled: this build has no *.evs.ts module that exports one';

  test('is told that the compiler ships, with the plugin installed for nothing', async () => {
    // No build-time module, and no import of the runtime entry: the plugin has nothing of its
    // own in this build, and the compiler is still told apart from the rest of the package.
    const built = await buildApp('compiler-only.ts');
    expect(built.pluginInfo).toStrictEqual([NOTHING_PRECOMPILED]);

    expect(built.pluginWarnings).toHaveLength(1);
    const kilobytes = /about (\d+) kB/.exec(built.pluginWarnings[0] ?? '')?.[1];
    expect(Number(kilobytes)).toBeGreaterThan(100);
    expect(built.pluginWarnings[0]).toBe(
      [
        `The evs compiler is in the client bundle: about ${kilobytes} kB before compression.`,
        '',
        'No script was precompiled, and the compiler ships in:',
        `  ${built.entry.fileName}  loaded up front`,
        '',
        `It comes in through the modules that import '@maxencerb/evs':`,
        '  compiler-only.ts',
        '',
        FIXES,
      ].join('\n'),
    );
  });

  test('is told the same when it takes its helpers from the runtime entry', async () => {
    const built = await buildApp('compiler-with-runtime.ts');
    expect(built.pluginInfo).toStrictEqual([NOTHING_PRECOMPILED]);
    expect(built.pluginWarnings).toHaveLength(1);
    expect(built.pluginWarnings[0]).toContain(
      'No script was precompiled, and the compiler ships in:\n' +
        `  ${built.entry.fileName}  loaded up front\n`,
    );
  });
});

describe('a monorepo whose app does not depend on evs itself', () => {
  // The scripts are in a workspace package next to the app, and only that package has evs
  // installed: `@maxencerb/evs` does not resolve from the app's root. The layout is copied out
  // of the repository, where every directory finds the evs of the plugin package above it.
  let monorepo: string;

  beforeAll(() => {
    monorepo = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-monorepo-'));
    cpSync(join(packageRoot, 'test/fixtures/monorepo'), monorepo, { recursive: true });
    symlinkSync(join(packageRoot, 'node_modules'), join(monorepo, 'lib/node_modules'), 'dir');
  });

  afterAll(() => {
    rmSync(monorepo, { recursive: true, force: true });
  });

  test('is told that the compiler ships: evs is found from the modules of the build', async () => {
    const built = await buildApp('main.ts', { root: join(monorepo, 'app') });
    expect(renderedModules(built.chunks).some(isCompilerModule)).toBe(true);
    expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);

    // the report, and nothing from the bundler about the explain code of evs
    expect(built.logs.warnings).toHaveLength(1);
    expect(built.pluginWarnings).toHaveLength(1);
    expect(built.pluginWarnings[0]).toContain(
      '1 script from 1 file was precompiled, but the compiler still ships in:\n' +
        `  ${built.entry.fileName}  loaded up front\n`,
    );
    expect(built.pluginWarnings[0]).toContain(
      `It comes in through the modules that import '@maxencerb/evs':\n  ../lib/index.ts\n`,
    );
  });
});

describe('a package the bundler names by another path than its real one', () => {
  // The workspace links evs, and the bundler names a linked file by its real path. With
  // `preserveSymlinks` the ids stay under `node_modules`, where an installed package has them.
  // (viem stays out of the bundle: its own dependencies are only found through pnpm's links.)
  const underNodeModules = {
    resolve: { preserveSymlinks: true },
    build: { rollupOptions: { external: [/^viem/] } },
  };
  const isOfEvs = (id: string): boolean => id.includes('/evs/dist/');

  test('a clean app is not warned', async () => {
    const built = await buildApp('clean.ts', { config: underNodeModules });
    const ofEvs = renderedModules(built.chunks).filter(isOfEvs);
    expect(ofEvs).not.toHaveLength(0);
    for (const id of ofEvs) expect(id).toContain('/node_modules/@maxencerb/evs/dist/');
    expect(built.logs.warnings).toStrictEqual([]);
  });

  test('the compiler is reported', async () => {
    const built = await buildApp('compiler-only.ts', { config: underNodeModules });
    expect(built.pluginWarnings).toHaveLength(1);
    expect(built.pluginWarnings[0]).toContain(`  ${built.entry.fileName}  loaded up front\n`);
  });
});

describe('compilerInBundle', () => {
  test(`'error' fails the build with the same report`, async () => {
    const message = await buildFailure('compiler-static.ts', {
      plugin: { compilerInBundle: 'error' },
    });
    expect(message).toContain('The evs compiler is in the client bundle: about ');
    expect(message).toContain('  compiler-static.ts\n');
    expect(message).toContain(FIXES);
  });

  test(`'error' lets a clean app build`, async () => {
    const built = await buildApp('clean.ts', { plugin: { compilerInBundle: 'error' } });
    expect(built.pluginWarnings).toStrictEqual([]);
  });

  test(`'ignore' is silent about the compiler`, async () => {
    const built = await buildApp('compiler-static.ts', { plugin: { compilerInBundle: 'ignore' } });
    expect(renderedModules(built.chunks).some(isCompilerModule)).toBe(true);
    expect(built.logs.warnings).toStrictEqual([]);
    expect(built.pluginInfo).toStrictEqual(['precompiled 3 scripts from 1 file']);
  });
});

describe('the bundler’s own warning about the explain code of evs', () => {
  /** A plugin that records the logs of a build before the evs plugin sees them. */
  function logRecorder(): { plugin: Plugin; logs: Rolldown.RolldownLog[] } {
    const logs: Rolldown.RolldownLog[] = [];
    return { logs, plugin: { name: 'log-recorder', onLog: (_level, log) => void logs.push(log) } };
  }

  const isIneffectiveImport = (log: Rolldown.RolldownLog): boolean =>
    log.code === 'INEFFECTIVE_DYNAMIC_IMPORT';

  test('is dropped: the report of the plugin is what the app can act on', async () => {
    // A precompiled script imports the explain code on demand, the compiler statically.
    const recorder = logRecorder();
    const built = await buildApp('compiler-static.ts', {
      config: { plugins: [recorder.plugin, evs()] },
    });

    const raised = recorder.logs.filter(isIneffectiveImport);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.id).toMatch(/\/evs\/dist\/explain\.js$/);

    expect(built.pluginWarnings).toHaveLength(1);
    expect(built.logs.warnings).toHaveLength(1); // the report, and nothing from the bundler
  });

  test.for([
    ['with the plugin', true],
    ['without it', false],
  ] as const)(
    'is not raised in an app that only compiles at run time, %s',
    async ([, withPlugin]) => {
      // such a bundle imports the explain code statically, from the compiler, and never on demand
      const recorder = logRecorder();
      const built = await buildApp('compiler-only.ts', {
        config: { plugins: [recorder.plugin, ...(withPlugin ? [evs()] : [])] },
      });
      expect(recorder.logs.filter(isIneffectiveImport)).toStrictEqual([]);
      expect(built.logs.warnings).toHaveLength(withPlugin ? 1 : 0); // the plugin's report
    },
  );

  test('is not raised when the compiler is loaded on demand', async () => {
    const recorder = logRecorder();
    const built = await buildApp('compiler-dynamic.ts', {
      config: { plugins: [recorder.plugin, evs()] },
    });
    expect(recorder.logs.filter(isIneffectiveImport)).toStrictEqual([]);
    expect(built.logs.warnings).toHaveLength(1);
  });

  test('the same warning about a module of the app is kept', async () => {
    const built = await buildApp('imported-both-ways.ts');
    const ofBundler = built.logs.warnings.filter((warning) =>
      warning.includes('INEFFECTIVE_DYNAMIC_IMPORT'),
    );
    expect(ofBundler).toHaveLength(1);
    expect(ofBundler[0]).toContain('compiler-static.ts is dynamically imported by');
    expect(built.pluginWarnings).toHaveLength(1);
  });
});

test('a server build is not checked: only a client bundle is downloaded', async () => {
  const built = await buildApp('compiler-static.ts', {
    plugin: { compilerInBundle: 'error' },
    // bundle the dependencies, so the compiler really is in the server output
    config: { build: { ssr: true }, ssr: { noExternal: true } },
  });
  expect(renderedModules(built.chunks).some(isCompilerModule)).toBe(true);
  expect(built.logs.warnings).toStrictEqual([]);
  expect(built.pluginInfo).toStrictEqual([]);
});
