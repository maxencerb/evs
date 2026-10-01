/**
 * vitest globalSetup for the `integration` project.
 *
 * One anvil instance per vitest worker, started lazily by a prool `Pool` keyed on the worker's
 * `VITEST_POOL_ID`. The workers do not send their RPC traffic through this process: a small HTTP
 * registry answers `GET /<poolId>` with that worker's anvil URL (starting the instance on first
 * use), and the worker then talks to anvil directly (see `test/harness/anvil.ts`). The registry
 * binds an OS-assigned free port (or `EVS_ANVIL_PORT` when set) and hands it to the workers
 * through `provide('anvilRegistryPort')`, so overlapping integration runs (parallel worktrees,
 * agents) never fight over a fixed port.
 *
 * Why not prool's proxy `Server` (`http://…/<poolId>` forwarding every request): its http-proxy
 * runs without an upstream agent, which makes it send `connection: close` to anvil, and anvil's
 * `connection: close` answer is copied back to the client. So every RPC cost two fresh TCP
 * connections, one per hop, and the proxy closed its side first: a full run left ~17,000 sockets
 * in TIME_WAIT on loopback, against macOS's 16,384 ephemeral ports. A new connection whose source
 * port still had a TIME_WAIT entry for the proxy's address was reset at connect
 * (`connect ECONNRESET 127.0.0.1:<proxy port>`); viem retries reads, but never
 * `eth_sendRawTransaction` (`retryCount: 0`), so a file's `beforeAll` deployment failed and took
 * the whole file down (about one run in five with 24 files). Direct, keep-alive connections to
 * anvil reuse a handful of sockets per worker instead.
 */

import { createServer } from 'node:http';

import { Instance, Pool } from 'prool';
import type { TestProject } from 'vite-plus/test/node';

declare module 'vite-plus/test' {
  interface ProvidedContext {
    /** The anvil registry's port (see {@link setup}). */
    anvilRegistryPort: number;
  }
}

/** `/<poolId>` → the pool id (a positive integer), else `null`. */
function poolIdOf(url: string | undefined): number | null {
  const id = Number(/^\/(\d+)$/.exec(url ?? '')?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const pool = Pool.define({
    instance: Instance.anvil({
      // PINNED to the IPv4 loopback: the registry hands out `http://<host>:<port>`, and prool's
      // default host `localhost` also resolves to ::1, where anvil does not listen (an attempt
      // there can even self-connect on a recycled ephemeral port and read its own request back).
      host: '127.0.0.1',
      chainId: 31337,
      hardfork: 'Prague', // PINNED — anvil's default `latest` moves over time
      gasLimit: 100_000_000, // headroom over the 30M default for stress tests
    }),
  });

  /** `GET /<poolId>` → `{ url }` of that worker's anvil, started on first use. */
  const lookup = async (url: string | undefined): Promise<{ status: number; body: string }> => {
    const id = poolIdOf(url);
    if (id === null) return { status: 404, body: '' };
    try {
      // a worker's concurrent first lookups share one start (Pool.start dedupes per key)
      const instance = pool.get(id) ?? (await pool.start(id));
      return {
        status: 200,
        body: JSON.stringify({ url: `http://${instance.host}:${instance.port}` }),
      };
    } catch (error) {
      return { status: 500, body: String(error) };
    }
  };
  const server = createServer((request, response) => {
    void lookup(request.url).then(({ status, body }) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(body),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 0 → any free port
    server.listen(Number(process.env.EVS_ANVIL_PORT ?? 0), '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error(`anvil registry: expected a TCP address, got ${String(address)}`);
  }
  project.provide('anvilRegistryPort', address.port);

  return async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await pool.destroyAll();
  };
}
