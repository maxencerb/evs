/**
 * Which modules belong to an evs package, and what its runtime entry reaches: on a tree written
 * for the test, shaped like an install (the package under `node_modules`, with a dependency of
 * its own inside it).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizePath } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { evsPackageLookup, isIneffectiveImportInsideEvs, readEvsPackage } from './evs-package.js';

const EVS = 'app/node_modules/@maxencerb/evs';
const OLD_EVS = 'app/node_modules/dependency/node_modules/@maxencerb/evs';

const FILES = {
  'app/package.json': '{ "name": "app" }',
  'app/src/main.js': `import '@maxencerb/evs';`,
  [`${EVS}/package.json`]: JSON.stringify({
    name: '@maxencerb/evs',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './runtime': { types: './dist/runtime.d.ts', default: './dist/runtime.js' },
    },
  }),
  [`${EVS}/dist/index.js`]: `export * from './compile.js'; export * from './runtime.js';`,
  [`${EVS}/dist/runtime.js`]: `export * from './hydrate.js';`,
  [`${EVS}/dist/hydrate.js`]: `import 'viem'; export const explain = () => import('./explain.js');`,
  [`${EVS}/dist/explain.js`]: `export default 1;`,
  [`${EVS}/dist/compile.js`]: `import './explain.js'; export const compile = 2;`,
  // a dependency installed inside the package, with a manifest that has no name further down
  [`${EVS}/node_modules/viem/package.json`]: '{ "name": "viem" }',
  [`${EVS}/node_modules/viem/_esm/package.json`]: '{ "type": "module" }',
  [`${EVS}/node_modules/viem/_esm/index.js`]: `export {};`,
  // a second copy, of a version that has no runtime entry
  [`${OLD_EVS}/package.json`]:
    '{ "name": "@maxencerb/evs", "exports": { ".": "./dist/index.js" } }',
  [`${OLD_EVS}/dist/index.js`]: `export {};`,
  // files in no package at all
  'loose/module.js': `export {};`,
};

let root: string;
const file = (name: string): string => `${root}/${name}`;

beforeAll(() => {
  root = normalizePath(mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-package-')));
  for (const [name, code] of Object.entries(FILES)) {
    mkdirSync(dirname(file(name)), { recursive: true });
    writeFileSync(file(name), code);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the evs package of a module', () => {
  test('is the one whose package.json is the nearest above the module', () => {
    const evsPackageOf = evsPackageLookup();
    expect(evsPackageOf(file(`${EVS}/dist/compile.js`))).toBe(file(EVS));
    expect(evsPackageOf(file(`${EVS}/dist/deeper/still/module.js`))).toBe(file(EVS));
    expect(evsPackageOf(file(`${OLD_EVS}/dist/index.js`))).toBe(file(OLD_EVS));
  });

  test('is found for an id with a query', () => {
    expect(evsPackageLookup()(`${file(`${EVS}/dist/compile.js`)}?v=1a2b/3c`)).toBe(file(EVS));
  });

  test('is not the package a dependency is installed in', () => {
    const evsPackageOf = evsPackageLookup();
    expect(evsPackageOf(file(`${EVS}/node_modules/viem/index.js`))).toBeUndefined();
    // (the nearest manifest decides, also one without a name)
    expect(evsPackageOf(file(`${EVS}/node_modules/viem/_esm/index.js`))).toBeUndefined();
  });

  test('is none for a module of the app, a module in no package, and a virtual module', () => {
    const evsPackageOf = evsPackageLookup();
    expect(evsPackageOf(file('app/src/main.js'))).toBeUndefined();
    expect(evsPackageOf(file('loose/module.js'))).toBeUndefined();
    expect(evsPackageOf('\0virtual:evs-debug:00000000/pool.evs.one.debug.js')).toBeUndefined();
    expect(evsPackageOf(`\0${file(`${EVS}/dist/compile.js`)}?commonjs-proxy`)).toBeUndefined();
    expect(evsPackageOf('relative/module.js')).toBeUndefined();
  });
});

describe('an evs package', () => {
  test('has the entries of its manifest, and the modules its runtime entry reaches', async () => {
    const { mainEntry, runtimeModules } = await readEvsPackage(file(EVS));
    expect(mainEntry).toBe(file(`${EVS}/dist/index.js`));
    expect([...runtimeModules].toSorted()).toStrictEqual(
      ['runtime.js', 'hydrate.js', 'explain.js']
        .map((name) => file(`${EVS}/dist/${name}`))
        .toSorted(),
    );
  });

  test('without a runtime entry has no runtime module: all of it is the compiler’s', async () => {
    const { mainEntry, runtimeModules } = await readEvsPackage(file(OLD_EVS));
    expect(mainEntry).toBe(file(`${OLD_EVS}/dist/index.js`));
    expect(runtimeModules.size).toBe(0);
  });
});

describe('the log of a dynamic import that moves nothing to another chunk', () => {
  const log = (id: string, importers: string[]) => ({
    code: 'INEFFECTIVE_DYNAMIC_IMPORT',
    message: `${id} is dynamically imported by ...`,
    id,
    ids: importers,
  });
  const explain = (): string => file(`${EVS}/dist/explain.js`);
  const insideEvs = (): string[] => [
    file(`${EVS}/dist/hydrate.js`),
    file(`${EVS}/dist/compile.js`),
  ];

  test('is about evs alone when the module and its importers are all modules of evs', () => {
    expect(isIneffectiveImportInsideEvs(log(explain(), insideEvs()), evsPackageLookup())).toBe(
      true,
    );
  });

  test('is the app’s to answer when one of the importers is a module of the app', () => {
    const importers = [file('app/src/main.js'), file(`${EVS}/dist/index.js`)];
    const ofApp = log(file(`${EVS}/dist/index.js`), importers);
    expect(isIneffectiveImportInsideEvs(ofApp, evsPackageLookup())).toBe(false);
  });

  test('is another log when the code is another', () => {
    const other = { ...log(explain(), insideEvs()), code: 'CIRCULAR_DEPENDENCY' };
    expect(isIneffectiveImportInsideEvs(other, evsPackageLookup())).toBe(false);
  });
});
