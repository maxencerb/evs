/**
 * The dev server: a build-time module is served precompiled, compiled again when a file it
 * imports changes, and its debug data is served on demand, also by a server that has not run
 * the module yet.
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer, type ViteDevServer } from 'vite-plus';
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from 'vite-plus/test';

import { isPrecompiledScript } from '@maxencerb/evs/runtime';

import { evs } from '../src/index.js';
// the module the servers below serve, run without the plugin
import * as direct from './fixtures/dev/watch.evs.ts';
import { packageRoot, recordingLogger } from './helpers.js';

/**
 * The app the servers serve: a copy of `fixtures/dev` the tests can edit, outside the
 * repository. It resolves packages like the plugin package does, through a link.
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-'));
  cpSync(join(packageRoot, 'test/fixtures/dev'), root, { recursive: true });
  symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface DevServer {
  readonly vite: ViteDevServer;
  readonly errors: string[];
  /** GETs a URL of the dev server, the way a browser does. */
  get(url: string): Promise<Response>;
}

/** A dev server with a plugin instance of its own (a new server session), closed with the test. */
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
    server: { middlewareMode: true, ws: false },
    // no dependency scan: the tests ask for single modules
    optimizeDeps: { noDiscovery: true },
  });
  const http: Server = createHttpServer(vite.middlewares);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new TypeError('expected a TCP port');
  const { port } = address;
  onTestFinished(async () => {
    http.close();
    await vite.close();
  });
  return { vite, errors, get: (url) => fetch(`http://127.0.0.1:${port}${url}`) };
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

describe('the debug data of a script on the dev server', () => {
  test('is served from the URL the module imports', async () => {
    const server = await startDevServer();
    const url = debugUrlIn(await transform(server, '/watch.evs.ts'));
    expect(url).toMatch(
      /^\/@id\/__x00__virtual:evs-debug:[0-9a-f]{8}:.*\/watch\.evs\.ts\.debug\.js$/,
    );

    const response = await server.get(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(debugDataIn(await response.text())).toStrictEqual(await direct.aboveLimit.debug());
  });

  test('is served by a server that has not run the module in this session', async () => {
    const url = debugUrlIn(await transform(await startDevServer(), '/watch.evs.ts'));

    const restarted = await startDevServer(); // a page kept open across a restart asks it first
    const response = await restarted.get(url);
    expect(response.status).toBe(200);
    expect(debugDataIn(await response.text())).toStrictEqual(await direct.aboveLimit.debug());
  });

  test('is not a way to make the server run a file it does not serve', async () => {
    // The URL names the module to run. A file outside the app (`server.fs`) is never run.
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'vite-plugin-evs-outside-'));
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'probe.evs.js'), 'globalThis.__evsProbeRan = true;\n');

    const server = await startDevServer();
    const url = `/@id/__x00__virtual:evs-debug:00000000:${outside}/probe.evs.js.debug.js`;
    expect((await server.get(url)).ok).toBe(false);
    expect(Reflect.get(globalThis, '__evsProbeRan')).toBeUndefined();

    // and inside the app, only a build-time module is
    const inside = `/@id/__x00__virtual:evs-debug:00000000:${root}/limit.ts.debug.js`;
    expect((await server.get(inside)).ok).toBe(false);
    expect(server.errors.join('\n')).not.toContain('limit.ts: ');
  });

  test('of a version of the module that is gone is an error that says to reload', async () => {
    const server = await startDevServer();
    const url = debugUrlIn(await transform(server, '/watch.evs.ts'));
    const stale = url.replace(/evs-debug:[0-9a-f]{8}:/, 'evs-debug:00000000:');
    // (in middleware mode the host application answers a failed request: here, nobody)
    expect((await server.get(stale)).ok).toBe(false);
    expect(server.errors.join('\n')).toContain(
      'watch.evs.ts: the debug data a page asked for belongs to a version of this module that ' +
        'is gone. Reload the page.',
    );
  });
});
