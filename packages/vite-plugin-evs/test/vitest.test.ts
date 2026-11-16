/**
 * An app tested with Vitest: Vitest reads the app's Vite config, so the plugin precompiles the
 * build-time modules of a test run too. Vitest can keep the transform of a module on disk
 * between two runs (`fsModuleCache`), under a key made of the module's own source. A build-time
 * module must never come from there: what the plugin writes for it depends on every file the
 * module imports, and its debug data only exists in the run that compiled it.
 */

import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { Plugin } from 'vite-plus';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';
import { createVitest } from 'vite-plus/test/node';

import { evs } from '../src/index.js';
import { installPackagesIn, packageRoot } from './helpers.js';

/** A copy of `fixtures/vitest` outside the repository, which the tests edit. */
let app: string;

/** Where the runs keep their module cache: each run finds what the runs before it left. */
const moduleCache = (): string => join(app, '.vitest-cache');

beforeAll(() => {
  app = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-vitest-'));
  cpSync(join(packageRoot, 'test/fixtures/vitest'), app, { recursive: true });
  installPackagesIn(app);
});

afterAll(() => {
  rmSync(app, { recursive: true, force: true });
});

/** What one run of the app's tests gave. */
interface TestRun {
  /** The state of each test, by its name. */
  readonly tests: Readonly<Record<string, string>>;
  /** The messages of the errors of the tests that failed, and of the run itself. */
  readonly errors: readonly string[];
  /** The code the plugin wrote for `scripts.evs.ts` in this run, once per time it wrote it. */
  readonly precompiled: readonly string[];
}

/**
 * Runs the tests of the app once, in a Vitest of its own: a new process would do the same. The
 * plugin instance is new, so it remembers nothing of an earlier run, and the module cache on
 * disk is the one of the earlier runs.
 */
async function runAppTests(): Promise<TestRun> {
  const precompiled: string[] = [];
  /** Sees what the plugin before it wrote for the build-time module. */
  const observer: Plugin = {
    name: 'observe-precompiled',
    transform(code, id) {
      if (id.endsWith('/scripts.evs.ts')) precompiled.push(code);
      return null;
    },
  };

  // what the run prints stays out of this run's output
  const discard = (): Writable => new Writable({ write: (_chunk, _encoding, done) => done() });
  // a failing run sets the exit code of the process, which here is the one of this test run
  const { exitCode } = process;
  const vitest = await createVitest(
    {
      root: app,
      config: false,
      watch: false,
      include: ['*.test.ts'],
      fsModuleCache: true,
      fsModuleCachePath: moduleCache(),
    },
    { plugins: [evs(), observer], cacheDir: join(app, '.vite') },
    { stdout: discard(), stderr: discard() },
  );
  try {
    const { testModules, unhandledErrors } = await vitest.start();
    const tests = testModules.flatMap((module) => [...module.children.allTests()]);
    return {
      tests: Object.fromEntries(tests.map((each) => [each.name, each.result().state])),
      errors: [
        ...tests.flatMap((each) => each.result().errors ?? []).map((error) => error.message),
        ...testModules.flatMap((module) => module.errors()).map((error) => error.message),
        ...unhandledErrors.map(String),
      ],
      precompiled,
    };
  } finally {
    await vitest.close();
    process.exitCode = exitCode;
  }
}

/**
 * The modules in the cache on disk that hold something the plugin wrote: the ABI of the
 * script, or its debug data. Both name the script as JSON does, and no source file does.
 */
function cachedPluginOutput(): string[] {
  return readdirSync(moduleCache(), { recursive: true, encoding: 'utf8' })
    .filter((name) => !name.endsWith('.json'))
    .map((name) => readFileSync(join(moduleCache(), name), 'utf8'))
    .filter((code) => code.includes('"name":"aboveLimit"'));
}

const ALL_PASSED = {
  'the script holds the bytecode its sources compile to now': 'passed',
  'the script loads its debug data': 'passed',
};

describe('a build-time module in an app tested with Vitest, module cache on disk', () => {
  test('is precompiled by the plugin in a first run', async () => {
    const run = await runAppTests();
    expect(run.errors).toStrictEqual([]);
    expect(run.tests).toStrictEqual(ALL_PASSED);
    expect(run.precompiled).toHaveLength(1);
    expect(run.precompiled[0]).toContain('/* @__PURE__ */ hydrate({"version":1,');
    expect(run.precompiled[0]).toContain('"name":"aboveLimit"');
  });

  test('and is not kept for the next run, nor is its debug data', () => {
    // (the other modules of the app are: the cache is in use)
    expect(readdirSync(moduleCache()).length).toBeGreaterThan(1);
    expect(cachedPluginOutput()).toStrictEqual([]);
  });

  test('is compiled again in the next run, and its debug data loads', async () => {
    const run = await runAppTests();
    expect(run.errors).toStrictEqual([]);
    expect(run.tests).toStrictEqual(ALL_PASSED);
    expect(run.precompiled).toHaveLength(1);
  });

  test('holds what its sources compile to after an edit to a file it imports', async () => {
    const before = await runAppTests();

    const limitFile = join(app, 'limit.ts');
    writeFileSync(limitFile, readFileSync(limitFile, 'utf8').replace('10n', '77n'));
    const after = await runAppTests();

    expect(after.errors).toStrictEqual([]);
    expect(after.tests).toStrictEqual(ALL_PASSED);
    expect(after.precompiled).toHaveLength(1);
    expect(after.precompiled[0]).not.toBe(before.precompiled[0]);
  });
});
