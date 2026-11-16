/**
 * Which modules run at build time: the name, tested on whole ids, and the place of the file,
 * on a small tree written for the test.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { BUILD_TIME_MODULE_NAME, isBuildTimeModule } from './build-time-module.js';

/**
 * Files, by path. Each `*.evs.*` file of the app and of the workspace package is a build-time
 * module; no other file is.
 */
const FILES = [
  // the app
  'app/src/pool.evs.ts',
  'app/src/pool.evs.mts',
  'app/src/pool.evs.js',
  'app/src/pool.evs.mjs',
  'app/src/pool.ts',
  'app/src/evs.ts',
  'app/src/pool.evs.tsx',
  'app/src/pool.evs.json',
  'app/src/pool.evs.ts.map',
  // directories whose name only holds `node_modules`
  'app/node_modules_backup/pool.evs.ts',
  'app/my-node_modules/pool.evs.ts',
  // a package of the workspace, linked below as `app/node_modules/workspace-lib`
  'packages/lib/pool.evs.ts',
  // installed packages, as npm lays them out
  'app/node_modules/installed/dist/pool.evs.js',
  'app/node_modules/@scope/installed/pool.evs.mjs',
  'app/node_modules/installed/node_modules/nested/pool.evs.js',
  // and as pnpm does: in a store, linked below as `app/node_modules/from-store`
  'node_modules/.pnpm/from-store@1.0.0/node_modules/from-store/pool.evs.js',
];

let workspace: string;
const at = (path: string): string => join(workspace, path);

beforeAll(() => {
  workspace = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-modules-'));
  for (const path of FILES) {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), 'export {};\n');
  }
  const link = (target: string, path: string): void => symlinkSync(at(target), at(path), 'dir');
  link('packages/lib', 'app/node_modules/workspace-lib');
  link(
    'node_modules/.pnpm/from-store@1.0.0/node_modules/from-store',
    'app/node_modules/from-store',
  );
  // a link outside of `node_modules` to a package that is installed
  link('app/node_modules/installed', 'app/vendored');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the name of a build-time module', () => {
  test.for([
    '/app/src/pool.evs.ts',
    '/app/src/pool.evs.mts',
    '/app/src/pool.evs.js',
    '/app/src/pool.evs.mjs',
    '/app/src/.evs.ts',
    'C:/app/src/pool.evs.ts',
    '/a päth with spaces/pool.evs.ts',
  ])('%s has it', (id) => {
    expect(BUILD_TIME_MODULE_NAME.test(id)).toBe(true);
  });

  test.for([
    // other names
    '/app/src/pool.ts',
    '/app/src/evs.ts',
    '/app/src/pool-evs.ts',
    '/app/src/pool.evs.tsx',
    '/app/src/pool.evs.cjs',
    '/app/src/pool.evs.json',
    '/app/src/pool.evs.ts.map',
    '/app/src/pool.evs.ts/index.css',
    // a query, on a build-time module and on any other file
    '/app/src/pool.evs.ts?raw',
    '/app/src/pool.evs.ts?url',
    '/app/src/pool.evs.ts?v=1a2b3c4d',
    '/app/src/pool.evs.ts?',
    '/app/src/pool.evs.ts?.evs.ts',
    '/app/scripts/maintenance.ts?.evs.ts',
    '/app/scripts/maintenance.ts?x=1&y=/z.evs.mjs',
    '/app/notes.txt?import&.evs.js',
    '/app/.env?.evs.js',
    // a hash
    '/app/src/pool.evs.ts#',
    '/app/src/pool.evs.ts#.evs.ts',
    '/app/scripts/maintenance.ts#.evs.ts',
    '/app/scripts/maintenance.ts#/pool.evs.js',
    // the virtual module of another plugin
    '\0virtual:generated.evs.ts',
    '\0/app/src/pool.evs.ts',
    '/app/src/pool.evs.ts\0',
    '/app/src/\0pool.evs.ts',
  ])('%j does not', (id) => {
    expect(BUILD_TIME_MODULE_NAME.test(id)).toBe(false);
  });
});

describe('isBuildTimeModule', () => {
  test.for([
    'app/src/pool.evs.ts',
    'app/src/pool.evs.mts',
    'app/src/pool.evs.js',
    'app/src/pool.evs.mjs',
    'app/node_modules_backup/pool.evs.ts',
    'app/my-node_modules/pool.evs.ts',
    'packages/lib/pool.evs.ts',
    // the same workspace package, by its link: what an id is with `resolve.preserveSymlinks`
    'app/node_modules/workspace-lib/pool.evs.ts',
  ])('%s is one', (path) => {
    expect(isBuildTimeModule(at(path))).toBe(true);
  });

  test.for([
    // files without the name
    'app/src/pool.ts',
    'app/src/evs.ts',
    'app/src/pool.evs.tsx',
    'app/src/pool.evs.json',
    'app/src/pool.evs.ts.map',
    // a build-time module asked for with a query or a hash, and another file made to look like one
    'app/src/pool.evs.ts?raw',
    'app/src/pool.evs.ts?v=1a2b3c4d',
    'app/src/pool.evs.ts?.evs.ts',
    'app/src/pool.ts?.evs.ts',
    'app/src/pool.ts?import&.evs.js',
    'app/src/pool.evs.ts#.evs.ts',
    'app/src/pool.ts#.evs.ts',
    // files of installed packages
    'app/node_modules/installed/dist/pool.evs.js',
    'app/node_modules/@scope/installed/pool.evs.mjs',
    'app/node_modules/installed/node_modules/nested/pool.evs.js',
    'node_modules/.pnpm/from-store@1.0.0/node_modules/from-store/pool.evs.js',
    // the same, by links: the real path of each is under `node_modules`
    'app/node_modules/from-store/pool.evs.js',
    'app/vendored/dist/pool.evs.js',
    // no file
    'app/src/missing.evs.ts',
  ])('%s is not', (path) => {
    expect(isBuildTimeModule(at(path))).toBe(false);
  });

  test('nor is the virtual module of another plugin, even named after one', () => {
    expect(isBuildTimeModule('virtual:generated.evs.ts')).toBe(false);
    expect(isBuildTimeModule('\0virtual:generated.evs.ts')).toBe(false);
    expect(isBuildTimeModule(`\0${at('app/src/pool.evs.ts')}`)).toBe(false);
  });

  test('(every file of the table is there)', () => {
    for (const path of FILES) expect(() => realpathSync(at(path))).not.toThrow();
  });
});
