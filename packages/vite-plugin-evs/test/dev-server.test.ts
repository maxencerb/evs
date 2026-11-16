/**
 * The dev server: a build-time module is served precompiled, compiled again when a file it
 * imports changes, and its debug data is served on demand. A debug-module URL is only ever
 * answered with what the plugin wrote: the server reads and runs nothing for one. And only the
 * plain URL of a build-time module runs a file: a query, a hash or a place in an installed
 * package leaves the request to Vite.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createServer, type PluginOption, type ViteDevServer } from 'vite-plus';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vite-plus/test';

import { isPrecompiledScript } from '@maxencerb/evs/runtime';

import { evs } from '../src/index.js';
// the module the servers below serve, run without the plugin
import * as direct from './fixtures/dev/watch.evs.ts';
import { installPackagesIn, packageRoot, recordingLogger } from './helpers.js';

/**
 * A directory outside the repository. In it, `app` is what the servers serve: a copy of
 * `fixtures/dev` the tests can edit, with the packages of the plugin package linked into a
 * `node_modules` of its own. What is next to `app` is outside of what a server may serve.
 */
let sandbox: string;
let root: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-'));
  root = join(sandbox, 'app');
  cpSync(join(packageRoot, 'test/fixtures/dev'), root, { recursive: true });
  installPackagesIn(root);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface DevServer {
  readonly vite: ViteDevServer;
  readonly errors: string[];
  /** GETs a URL of the dev server, the way a browser does. */
  get(url: string): Promise<Response>;
  /** GETs a path sent exactly as written. `fetch` and a browser resolve `..` before they send
   *  a request; someone who wants a file the server does not serve sends it as it is. */
  getRaw(path: string): Promise<{ status: number; body: string }>;
}

/**
 * A listening dev server, closed with the test. By default it has a plugin instance of its own
 * (a new server session); `plugins: []` gives the server Vite is without the plugin.
 */
async function startDevServer({
  plugins = [evs()],
}: { plugins?: PluginOption[] } = {}): Promise<DevServer> {
  const { logger } = recordingLogger();
  const errors: string[] = [];
  logger.error = (message) => void errors.push(message);
  const vite = await createServer({
    root,
    configFile: false,
    customLogger: logger,
    plugins,
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, ws: false },
    // (a test writes a `.env` file into the app: with an `envDir`, that restarts the server)
    envDir: false,
    // (the plugin has a dependency pre-bundled: a server without it keeps a cache of its own)
    cacheDir: join(sandbox, plugins.length === 0 ? '.vite-without-plugin' : '.vite'),
    // no dependency scan: the tests ask for single modules
    optimizeDeps: { noDiscovery: true },
  });
  await vite.listen();
  onTestFinished(async () => vite.close());

  const address = vite.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new TypeError('expected a TCP port');
  }
  const { port } = address;
  return {
    vite,
    errors,
    get: async (url) => fetch(`http://127.0.0.1:${port}${url}`),
    getRaw: async (path) => getAsWritten(port, path),
  };
}

/** GETs `path` from the local server on `port`. The path is sent as it is written. */
async function getAsWritten(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    sent.on('error', reject);
    sent.end();
  });
}

async function transform(server: DevServer, url: string): Promise<string> {
  const result = await server.vite.transformRequest(url);
  if (result === null) throw new TypeError(`${url} was not transformed`);
  return result.code;
}

/** The URL the served module imports its script's debug data from. */
function debugUrlIn(code: string): string {
  const url = /debug: \(\) => import\("([^"]+)"\)/.exec(code)?.[1];
  if (url === undefined) throw new TypeError('the module imports no debug data');
  return url;
}

/** The debug data a debug module serves (`export default <json>;`). */
function debugDataIn(code: string): unknown {
  return JSON.parse(code.replace(/^export default /, '').replace(/;\s*$/, ''));
}

const RELOAD =
  'the debug data a page asked for belongs to a version of a *.evs.ts module that is gone. ' +
  'Reload the page.';

describe('a build-time module on the dev server', () => {
  test('is served precompiled, with an empty source map', async () => {
    const server = await startDevServer();
    const result = await server.vite.transformRequest('/watch.evs.ts');
    expect(result?.code).toContain('/* @__PURE__ */ hydrate({"version":1,');
    expect(result?.code).toContain(direct.aboveLimit.runtimeBytecode);
    expect(result?.code).toContain('const _0 = 10n;');
    expect(result?.code).toContain('export { _0 as limit, _1 as aboveLimit };');
    expect(result?.code).not.toContain('evscript'); // the source is gone, and the compiler with it
    expect(result?.map).toStrictEqual({ mappings: '' });
  });

  test.for([
    ['as an import of another module', '/watch.evs.ts?import'],
    ['again after an update, under a new timestamp', '/watch.evs.ts?t=1700000000000'],
  ] as const)('is served precompiled when the browser asks %s', async ([, url]) => {
    // the server takes these queries off before a plugin sees the module's id
    const server = await startDevServer();
    const response = await server.get(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(direct.aboveLimit.runtimeBytecode);
  });

  test('is served as its source text to an import with ?raw', async () => {
    const code = await transform(await startDevServer(), '/watch.evs.ts?raw');
    expect(code).toContain('export default "');
    expect(code).toContain("evscript({ name: 'aboveLimit'");
    expect(code).not.toContain('hydrate(');
  });

  test('is compiled again when a file it imports changes', async () => {
    const server = await startDevServer();
    const before = await transform(server, '/watch.evs.ts');

    const limitFile = join(root, 'limit.ts');
    const original = readFileSync(limitFile, 'utf8');
    onTestFinished(() => writeFileSync(limitFile, original));
    writeFileSync(limitFile, original.replace('10n', '77n'));

    // The watcher reports the change after a moment. Touching the file once more covers a
    // watcher that was not ready for the first write.
    const touch = setTimeout(() => utimesSync(limitFile, new Date(), new Date()), 1500);
    onTestFinished(() => clearTimeout(touch));
    const after = await vi.waitFor(
      async () => {
        const code = await transform(server, '/watch.evs.ts');
        expect(code).not.toBe(before);
        return code;
      },
      { timeout: 10_000, interval: 50 },
    );

    expect(after).toContain('const _0 = 77n;');
    expect(after).not.toContain(direct.aboveLimit.runtimeBytecode); // other bytecode
    // and its debug data is another module, so the browser does not reuse the one it cached
    expect(debugUrlIn(after)).not.toBe(debugUrlIn(before));
    // the module it replaces is not served any more
    expect((await server.get(debugUrlIn(before))).status).toBe(500);
    expect((await server.get(debugUrlIn(after))).status).toBe(200);
  });

  test('is served precompiled to the server environment too', async () => {
    const server = await startDevServer();
    const module = await server.vite.ssrLoadModule('/watch.evs.ts');
    expect(module.limit).toBe(10n);
    const script: unknown = module.aboveLimit;
    if (!isPrecompiledScript(script)) throw new TypeError('expected a precompiled script');
    expect(script.runtimeBytecode).toBe(direct.aboveLimit.runtimeBytecode);
    expect(await script.debug()).toStrictEqual(await direct.aboveLimit.debug());
  });
});

describe('the runtime entry of evs, which only the served code imports', () => {
  // (the dependency scan reads the source of a build-time module, which imports the compiler)
  test('is pre-bundled from the start, so the page is not reloaded for it', async () => {
    const { vite } = await startDevServer();
    expect(vite.config.optimizeDeps.include).toContain('@maxencerb/evs/runtime');
  });

  test('is left to be found when the app’s root does not resolve evs', async () => {
    const vite = await createServer({
      root: sandbox, // no `node_modules` here: evs is a dependency of `app` alone
      configFile: false,
      logLevel: 'silent',
      plugins: [evs()],
      server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true },
    });
    onTestFinished(async () => vite.close());
    expect(vite.config.optimizeDeps.include).toStrictEqual([]);
  });
});

describe('the debug data of a script on the dev server', () => {
  test('is served from the URL the module imports, which names no file', async () => {
    const server = await startDevServer();
    const url = debugUrlIn(await transform(server, '/watch.evs.ts'));
    expect(url).toMatch(
      /^\/@id\/__x00__virtual:evs-debug:[0-9a-f]{8}\/watch\.evs\.aboveLimit\.debug\.js$/,
    );

    const response = await server.get(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(debugDataIn(await response.text())).toStrictEqual(await direct.aboveLimit.debug());
    // (the same request, sent as written: what the tests below rely on)
    expect((await server.getRaw(url)).status).toBe(200);
  });

  test('of a version of the module that is gone is an error that says to reload', async () => {
    const server = await startDevServer();
    const url = debugUrlIn(await transform(server, '/watch.evs.ts'));
    const stale = url.replace(/evs-debug:[0-9a-f]{8}/, 'evs-debug:00000000');

    const response = await server.get(stale);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain(RELOAD);
    expect(server.errors.join('\n')).toContain(RELOAD);
  });

  test('is not served to a page that outlived a restart, until the page reloads', async () => {
    const url = debugUrlIn(await transform(await startDevServer(), '/watch.evs.ts'));

    // The new session has not served the module yet. It does not run it to answer: the URL
    // names no file, and running one for a URL is how a server ends up running any file.
    const restarted = await startDevServer();
    expect((await restarted.get(url)).status).toBe(500);
    expect(restarted.errors.join('\n')).toContain(RELOAD);

    // a reload asks for the module again, and its debug data is the same module as before
    expect((await restarted.get('/watch.evs.ts')).status).toBe(200);
    const response = await restarted.get(url);
    expect(response.status).toBe(200);
    expect(debugDataIn(await response.text())).toStrictEqual(await direct.aboveLimit.debug());
  });
});

// ---------------------------------------------------------------------------
// requests made up by someone who reaches the dev server
// ---------------------------------------------------------------------------

/** What no answer of a server may show. */
const SECRET = 'hunter2-not-to-be-seen';

/**
 * Modules such a request is after, by a name and their path in the sandbox. Each leaves a file
 * behind when something runs it (`markOf`), so a test can tell that nothing did.
 */
const PLANTED_MODULES = {
  /** A module of the app that is no build-time module. */
  maintenance: 'app/scripts/maintenance.ts',
  /** A module of an installed package. */
  postinstall: 'app/node_modules/some-dep/scripts/postinstall.js',
  /** A module of an installed package that has the name of a build-time module. */
  theme: 'app/node_modules/some-dep/theme.evs.js',
  /** A build-time module by its name, outside of what a server serves. */
  probe: 'outside/probe.evs.js',
} as const;

type PlantedModule = keyof typeof PLANTED_MODULES;

/** Files that hold the secret: one the server denies, and one outside of what it serves. */
const SECRET_FILES = ['app/.env', 'outside/secret.txt'] as const;

/** The file the planted module `name` leaves behind when it runs. */
function markOf(name: string): string {
  return join(sandbox, `${name}.ran`);
}

/** The planted modules that ran since the marks were last cleared. */
function modulesThatRan(): string[] {
  return Object.keys(PLANTED_MODULES).filter((name) => existsSync(markOf(name)));
}

function clearMarks(): void {
  for (const name of Object.keys(PLANTED_MODULES)) rmSync(markOf(name), { force: true });
}

function plantFiles(): void {
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(sandbox, path)), { recursive: true });
    writeFileSync(join(sandbox, path), content);
  };
  for (const [name, path] of Object.entries(PLANTED_MODULES)) {
    const mark = JSON.stringify(markOf(name));
    write(path, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${mark}, 'ran');\n`);
  }
  for (const path of SECRET_FILES) write(path, `PASSWORD=${SECRET}\n`);
}

beforeAll(plantFiles);
beforeEach(clearMarks);

test('(a planted module does leave its mark when it runs)', async () => {
  const probe: PlantedModule = 'probe';
  await import(/* @vite-ignore */ pathToFileURL(join(sandbox, PLANTED_MODULES[probe])).href);
  expect(modulesThatRan()).toStrictEqual([probe]);
});

describe('a debug-module URL made up by someone who reaches the dev server', () => {
  /**
   * Two URLs of a debug module whose name holds the path of a file: after the prefix, and where
   * the label is. A server that read a path out of such a name would run or read that file.
   */
  function debugModuleUrls(path: string): string[] {
    return [
      `/@id/__x00__virtual:evs-debug:00000000:${path}.debug.js`,
      `/@id/__x00__virtual:evs-debug:00000000/${path}.debug.js`,
    ];
  }

  function madeUpUrls(): string[] {
    return [
      // a build-time module by its name, outside of what the server serves: reached with `..`
      ...debugModuleUrls(`${root}/../outside/probe.evs.js`),
      ...debugModuleUrls('../outside/probe.evs.js'),
      // a file of the app that is no build-time module: a query made it look like one
      ...debugModuleUrls(`${root}/scripts/maintenance.ts?.evs.ts`),
      // files the server denies, and no modules: the error of running one would quote it
      ...debugModuleUrls(`${root}/.env?.evs.js`),
      ...debugModuleUrls(`${root}/../outside/secret.txt?import&.evs.js`),
    ];
  }

  test('runs no file and shows none: the answer is the error that says to reload', async () => {
    const server = await startDevServer();
    await transform(server, '/watch.evs.ts'); // a session that has precompiled modules

    const urls = madeUpUrls();
    const answers = await Promise.all(
      urls.map(async (url) => {
        const { status, body } = await server.getRaw(url);
        return { url, status, saysToReload: body.includes(RELOAD), shows: body.includes(SECRET) };
      }),
    );
    expect(answers).toStrictEqual(
      urls.map((url) => ({ url, status: 500, saysToReload: true, shows: false })),
    );

    expect(modulesThatRan()).toStrictEqual([]);
    expect(server.errors).toHaveLength(urls.length);
    expect(server.errors.join('\n')).not.toContain(SECRET);
  });
});

describe('a URL that only looks like the one of a build-time module', () => {
  /** Vite serves these as the module is written, for a browser to run. */
  const SERVED_AS_WRITTEN = [
    // a module of the app, behind a query that ends like the name of a build-time module
    '/scripts/maintenance.ts?.evs.ts',
    '/scripts/maintenance.ts?x=1&y=/z.evs.mjs',
    // (the server takes `import` off the query before a plugin sees the module's id)
    '/scripts/maintenance.ts?import&.evs.js',
    // modules of an installed package: behind such a query, and one that has the name itself,
    // as someone asks for it and as the server writes it in an import
    '/node_modules/some-dep/scripts/postinstall.js?.evs.js',
    '/node_modules/some-dep/theme.evs.js',
    '/node_modules/some-dep/theme.evs.js?v=1a2b3c4d',
  ];

  /** Vite refuses these: a file it denies, and a build-time module outside of what it serves. */
  const refused = (): string[] => [
    '/.env?.evs.js',
    '/.env?import&.evs.js',
    `/@fs${sandbox}/outside/probe.evs.js`,
  ];

  /** Vite answers this one with the URL of the file, which it then refuses to serve. */
  const ONLY_NAMED = ['/../outside/secret.txt?import&.evs.js'];

  test('is answered by Vite as if the plugin were not there, and runs nothing', async () => {
    const withPlugin = await startDevServer();
    const withoutPlugin = await startDevServer({ plugins: [] });
    await transform(withPlugin, '/watch.evs.ts'); // a session that has precompiled modules

    const answersOf = async (server: DevServer) => {
      const answersTo = async (urls: readonly string[]) =>
        Promise.all(urls.map(async (url) => ({ url, ...(await server.getRaw(url)) })));
      return {
        servedAsWritten: await answersTo(SERVED_AS_WRITTEN),
        refused: await answersTo(refused()),
        onlyNamed: await answersTo(ONLY_NAMED),
      };
    };

    const ofViteAlone = await answersOf(withoutPlugin);
    expect(await answersOf(withPlugin)).toStrictEqual(ofViteAlone);
    expect(modulesThatRan()).toStrictEqual([]);

    // and Vite alone answers as said above, without the secret
    for (const { url, status, body } of ofViteAlone.servedAsWritten) {
      expect({ url, status }).toStrictEqual({ url, status: 200 });
      expect(body).toContain('writeFileSync('); // the statement that leaves the mark
    }
    for (const { url, status, body } of ofViteAlone.refused) {
      expect({ url, status }).toStrictEqual({ url, status: 403 });
      expect(body).not.toContain(SECRET);
    }
    for (const { url, status, body } of ofViteAlone.onlyNamed) {
      expect({ url, status }).toStrictEqual({ url, status: 200 });
      expect(body).toMatch(/^export default "\/@fs\/[^"]*\/outside\/secret\.txt[^"]*"$/m);
      expect(body).not.toContain(SECRET);
    }
  });
});
