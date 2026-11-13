/**
 * The dev server: a build-time module is served precompiled, compiled again when a file it
 * imports changes, and its debug data is served on demand. A debug-module URL is only ever
 * answered with what the plugin wrote: the server reads and runs nothing for one.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createServer, type ViteDevServer } from 'vite-plus';
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from 'vite-plus/test';

import { isPrecompiledScript } from '@maxencerb/evs/runtime';

import { evs } from '../src/index.js';
// the module the servers below serve, run without the plugin
import * as direct from './fixtures/dev/watch.evs.ts';
import { packageRoot, recordingLogger } from './helpers.js';

/**
 * A directory outside the repository. In it, `app` is what the servers serve: a copy of
 * `fixtures/dev` the tests can edit, which resolves packages like the plugin package does,
 * through a link. What is next to `app` is outside of what a server may serve.
 */
let sandbox: string;
let root: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-'));
  root = join(sandbox, 'app');
  cpSync(join(packageRoot, 'test/fixtures/dev'), root, { recursive: true });
  symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
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

/** A listening dev server with a plugin instance of its own (a new server session), closed
 *  with the test. */
async function startDevServer(): Promise<DevServer> {
  const { logger } = recordingLogger();
  const errors: string[] = [];
  logger.error = (message) => void errors.push(message);
  const vite = await createServer({
    root,
    configFile: false,
    customLogger: logger,
    plugins: [evs()],
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, ws: false },
    // (a test writes a `.env` file into the app: with an `envDir`, that restarts the server)
    envDir: false,
    cacheDir: join(sandbox, '.vite'),
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
    getRaw: async (path) =>
      new Promise((resolve, reject) => {
        const sent = request({ host: '127.0.0.1', port, path, agent: false }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
        sent.on('error', reject);
        sent.end();
      }),
  };
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

describe('a debug-module URL made up by someone who reaches the dev server', () => {
  const SECRET = 'hunter2-not-to-be-seen';

  /** A module that leaves `marker` behind when something runs it. */
  const leavesMark = (marker: string): string =>
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`;

  /**
   * The files such a URL is after, each with the URL that reached it when the name of a debug
   * module held the path of a file, and the server ran that file to answer.
   */
  function targets(): { file: string; marker: string; urls: string[] }[] {
    const outside = join(sandbox, 'outside');
    const ids = (path: string): string[] =>
      // the id as it was, and the same path where the label is now
      [`virtual:evs-debug:00000000:${path}`, `virtual:evs-debug:00000000/${path}`].map(
        (id) => `/@id/__x00__${id}.debug.js`,
      );
    return [
      {
        // a build-time module by its name, outside of what the server serves: reached with `..`
        file: join(outside, 'probe.evs.js'),
        marker: join(sandbox, 'probe-ran'),
        urls: [...ids(`${root}/../outside/probe.evs.js`), ...ids('../outside/probe.evs.js')],
      },
      {
        // a file of the app that is no build-time module: a query made it look like one
        file: join(root, 'scripts/maintenance.ts'),
        marker: join(sandbox, 'maintenance-ran'),
        urls: ids(`${root}/scripts/maintenance.ts?.evs.ts`),
      },
      {
        // files the server denies, and no modules: running one failed, and the error quoted it
        file: join(root, '.env'),
        marker: join(sandbox, 'env-ran'),
        urls: [
          ...ids(`${root}/.env?.evs.js`),
          ...ids(`${root}/../outside/secret.txt?import&.evs.js`),
        ],
      },
    ];
  }

  beforeAll(() => {
    for (const directory of [join(sandbox, 'outside'), join(root, 'scripts')]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(sandbox, 'outside/secret.txt'), `PASSWORD=${SECRET}\n`);
    for (const { file, marker } of targets()) {
      writeFileSync(file, file.endsWith('.env') ? `API_KEY=${SECRET}\n` : leavesMark(marker));
    }
  });

  test('runs no file and shows none: the answer is the error that says to reload', async () => {
    const server = await startDevServer();
    await transform(server, '/watch.evs.ts'); // a session that has precompiled modules

    const urls = targets().flatMap((target) => target.urls);
    const answers = await Promise.all(
      urls.map(async (url) => {
        const { status, body } = await server.getRaw(url);
        return { url, status, saysToReload: body.includes(RELOAD), shows: body.includes(SECRET) };
      }),
    );
    expect(answers).toStrictEqual(
      urls.map((url) => ({ url, status: 500, saysToReload: true, shows: false })),
    );

    expect(targets().filter(({ marker }) => existsSync(marker))).toStrictEqual([]);
    expect(server.errors).toHaveLength(urls.length);
    expect(server.errors.join('\n')).not.toContain(SECRET);
  });

  test('(the files it was after do leave a mark when they run)', async () => {
    const [probe] = targets();
    if (probe === undefined) throw new TypeError('expected a target');
    onTestFinished(() => rmSync(probe.marker, { force: true }));
    await import(/* @vite-ignore */ pathToFileURL(probe.file).href);
    expect(existsSync(probe.marker)).toBe(true);
  });
});
