/**
 * The walk over a module's relative imports: on a small tree written for the test, and on the
 * evs package the plugin is built against.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizePath } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { importClosureOf } from './import-closure.js';

describe('a tree of modules', () => {
  const MODULES = {
    'entry.js': `
      import { a } from './a.js';
      import fs from 'node:fs';
      import 'a-package';
      export { b } from "./lib/b.js";
      export * from './lib/c.js';
      export const own = a;
      export const later = () => import('./lazy/d.js');
      export const computed = (name) => import(name);
      export const interpolated = (name) => import(\`./lazy/\${name}.js\`);
      export const joined = (name) => import('./lazy/' + name + '.js');
    `,
    'a.js': `import './entry.js'; export const a = 1;`, // a cycle
    'lib/b.js': `export * as up from '../a.js'; export const b = 2;`,
    'lib/c.js': `export const c = 3;`,
    'lazy/d.js': `import '../lib/c.js'; export const again = async () => (await import("./e.js")).default;`,
    'lazy/e.js': `export default 5;`,
    'lazy/never.js': `export default 6;`,
  };

  let root: string;
  const file = (name: string): string => `${root}/${name}`;

  beforeAll(() => {
    root = normalizePath(mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-closure-')));
    for (const [name, code] of Object.entries(MODULES)) {
      mkdirSync(dirname(file(name)), { recursive: true });
      writeFileSync(file(name), code);
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('imports, re-exports and dynamic imports of a string are followed', async () => {
    const { files } = await importClosureOf(file('entry.js'));
    expect([...files].toSorted()).toStrictEqual(
      ['entry.js', 'a.js', 'lib/b.js', 'lib/c.js', 'lazy/d.js', 'lazy/e.js'].map(file).toSorted(),
    );
  });

  test('the files a dynamic import names are the ones loaded on demand', async () => {
    const { onDemand } = await importClosureOf(file('entry.js'));
    expect([...onDemand].toSorted()).toStrictEqual(['lazy/d.js', 'lazy/e.js'].map(file));
  });

  test('a module without imports reaches itself', async () => {
    const closure = await importClosureOf(file('lib/c.js'));
    expect([...closure.files]).toStrictEqual([file('lib/c.js')]);
    expect([...closure.onDemand]).toStrictEqual([]);
  });
});

describe('the evs package', () => {
  const entryOf = (specifier: string): string =>
    normalizePath(createRequire(import.meta.url).resolve(specifier));

  test('its runtime entry reaches no compiler, and loads the explain code on demand', async () => {
    const runtime = entryOf('@maxencerb/evs/runtime');
    const dist = dirname(runtime);
    const { files, onDemand } = await importClosureOf(runtime);

    expect(files).toContain(`${dist}/hydrate.js`);
    expect(files).not.toContain(`${dist}/index.js`);
    expect(files).not.toContain(`${dist}/compile.js`);
    expect([...onDemand]).toStrictEqual([`${dist}/explain.js`]);
  });

  test('its main entry reaches the compiler', async () => {
    const main = entryOf('@maxencerb/evs');
    const { files } = await importClosureOf(main);
    expect(files).toContain(`${dirname(main)}/compile.js`);
  });
});
