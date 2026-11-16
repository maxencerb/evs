/**
 * Build-time modules and the packages of an app. A file of an installed package is never one,
 * whatever its name: it is bundled and served like any module, in a build and in the dev server
 * alike. A file of a workspace package is one: it is linked into `node_modules`, and its real
 * path is outside of it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createServer } from 'vite-plus';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
} from 'vite-plus/test';

import { evs } from '../src/index.js';
import { buildApp, installPackagesIn, isCompilerModule, renderedModules } from './helpers.js';

/** The global a file of the installed package counts its runs in. A build runs in this process. */
const RUNS = 'acmeScriptsRuns';

const script = (name: string, value: string): string =>
  `export const ${name} = evscript({ name: '${name}' }, (s) =>\n` +
  `  s.return({ ${name}: s.lit(t.uint256, ${value}) }),\n)\n  .compile()\n  .toPrecompiled();\n`;

/** A workspace, by path. `app/node_modules/workspace-lib` is a link to `packages/lib`. */
const FILES = {
  // the app
  'app/main.js': `export { three } from 'acme-scripts';\nexport { two } from 'workspace-lib';\n`,
  'app/workspace-only.js': `export { two } from 'workspace-lib';\n`,

  // a package as a registry installs it, published with the file names its sources had
  'app/node_modules/acme-scripts/package.json': JSON.stringify({
    name: 'acme-scripts',
    version: '1.0.0',
    type: 'module',
    exports: './dist/index.js',
  }),
  'app/node_modules/acme-scripts/dist/index.js': `export { three } from './supply.evs.js';\n`,
  'app/node_modules/acme-scripts/dist/supply.evs.js':
    `import { evscript, t } from '@maxencerb/evs';\n` +
    `globalThis.${RUNS} = (globalThis.${RUNS} ?? 0) + 1;\n` +
    script('three', '3n'),

  // a package of the workspace, used from its sources
  'packages/lib/package.json': JSON.stringify({
    name: 'workspace-lib',
    version: '1.0.0',
    type: 'module',
    exports: './index.ts',
  }),
  'packages/lib/index.ts': `export { two } from './pool.evs.ts';\n`,
  'packages/lib/pool.evs.ts':
    `import { evscript, t } from '@maxencerb/evs';\n` + script('two', '2n'),
};

let workspace: string;
let root: string;

beforeAll(() => {
  workspace = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-dependencies-'));
  root = join(workspace, 'app');
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), content);
  }
  symlinkSync(join(workspace, 'packages/lib'), join(root, 'node_modules/workspace-lib'), 'dir');
  // at the root of the workspace, where the app and both packages find evs
  installPackagesIn(workspace);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** How many times the installed package's file ran in this process. */
function runsOfInstalledFile(): number {
  const runs: unknown = Reflect.get(globalThis, RUNS);
  return typeof runs === 'number' ? runs : 0;
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, RUNS);
});

describe('a build', () => {
  test('bundles the file of an installed package as it is written, and does not run it', async () => {
    const built = await buildApp('main.js', { root });
    expect(runsOfInstalledFile()).toBe(0);

    // the file is in the bundle as a module that compiles its script in the browser
    const code = built.chunks.map((chunk) => chunk.code).join('\n');
    expect(code).toContain(`globalThis.${RUNS}`);
    expect(renderedModules(built.chunks).some(isCompilerModule)).toBe(true);

    // only the workspace package's module was precompiled, and the report names the other one
    expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);
    expect(built.pluginWarnings).toHaveLength(1);
    expect(built.pluginWarnings[0]).toContain(
      `It comes in through the modules that import '@maxencerb/evs':\n` +
        `  node_modules/acme-scripts/dist/supply.evs.js\n`,
    );
  });

  test('precompiles the build-time module of a workspace package', async () => {
    const built = await buildApp('workspace-only.js', { root });
    expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);
    expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
    expect(built.logs.warnings).toStrictEqual([]);
  });

  test('precompiles it too when the bundler names it by its link under node_modules', async () => {
    const built = await buildApp('workspace-only.js', {
      root,
      // (viem stays out of the bundle: its own dependencies are only found through pnpm's links)
      config: {
        resolve: { preserveSymlinks: true },
        build: { rollupOptions: { external: [/^viem/] } },
      },
    });
    expect(renderedModules(built.chunks)).toContain(
      join(root, 'node_modules/workspace-lib/pool.evs.ts'),
    );
    expect(built.pluginInfo).toStrictEqual(['precompiled 1 script from 1 file']);
    expect(renderedModules(built.chunks).filter(isCompilerModule)).toStrictEqual([]);
  });
});

describe('the dev server', () => {
  async function startDevServer() {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [evs()],
      server: { middlewareMode: true, ws: false },
      cacheDir: join(workspace, '.vite'),
      // no dependency scan: the tests ask for single modules
      optimizeDeps: { noDiscovery: true },
    });
    onTestFinished(async () => server.close());
    return server;
  }

  /** The URL `code` imports the module named `name` from. */
  function importedUrl(code: string, name: string): string {
    const url = new RegExp(`from "([^"]*${name}[^"]*)"`).exec(code)?.[1];
    if (url === undefined) throw new TypeError(`no import of ${name} in:\n${code}`);
    return url;
  }

  test('serves the file of an installed package to a page as it is written', async () => {
    const server = await startDevServer();
    const codeOf = async (url: string): Promise<string> =>
      (await server.transformRequest(url))?.code ?? '';

    // from the app's module to the file, by the URLs the server writes in each import
    const packageUrl = importedUrl(await codeOf('/main.js'), 'acme-scripts');
    const fileUrl = importedUrl(await codeOf(packageUrl), 'supply.evs.js');
    expect(fileUrl).toMatch(/^\/node_modules\/acme-scripts\/dist\/supply\.evs\.js\?v=[0-9a-f]+$/);
    expect(await codeOf(fileUrl)).toContain(`globalThis.${RUNS}`);
    // and by its plain URL
    expect(await codeOf('/node_modules/acme-scripts/dist/supply.evs.js')).toContain(
      `globalThis.${RUNS}`,
    );
    expect(runsOfInstalledFile()).toBe(0);
  });

  test('transforms it for the server environment as it is written too', async () => {
    // (the server environment has no dependency optimizer, so the module's id has no query)
    const server = await startDevServer();
    const result = await server.environments.ssr.transformRequest(
      '/node_modules/acme-scripts/dist/supply.evs.js',
    );
    expect(result?.code).toContain(`globalThis.${RUNS}`);
    expect(result?.code).not.toContain('hydrate(');
    expect(runsOfInstalledFile()).toBe(0);
  });

  test('serves the build-time module of a workspace package precompiled', async () => {
    const server = await startDevServer();
    const main = await server.transformRequest('/workspace-only.js');
    const packageUrl = importedUrl(main?.code ?? '', 'packages/lib');
    const index = await server.transformRequest(packageUrl);
    const moduleUrl = importedUrl(index?.code ?? '', 'pool.evs.ts');
    expect((await server.transformRequest(moduleUrl))?.code).toContain(
      '/* @__PURE__ */ hydrate({"version":1,',
    );
  });
});
