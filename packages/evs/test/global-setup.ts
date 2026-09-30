/**
 * vitest globalSetup for the `integration` project.
 *
 * A prool proxy server multiplexing one anvil instance per vitest worker
 * (`/<VITEST_POOL_ID>` routing, see `test/harness/anvil.ts`). It binds an OS-assigned free port
 * (or `EVS_ANVIL_PORT` when set) and hands it to the workers through `provide('anvilPort')`, so
 * overlapping integration runs (parallel worktrees, agents) never fight over a fixed port.
 */

import { Instance, Server } from 'prool';
import type { TestProject } from 'vite-plus/test/node';

declare module 'vite-plus/test' {
  interface ProvidedContext {
    /** The prool proxy's port (see {@link setup}). */
    anvilPort: number;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = Server.create({
    instance: Instance.anvil({
      // PINNED to the IPv4 loopback. prool's default host is `localhost`: anvil then listens on
      // 127.0.0.1 only, but the proxy's upstream URL `http://localhost:<port>` also resolves to
      // ::1, where nothing listens. The instance port is an ephemeral one and the proxy opens one
      // upstream connection per request, so the kernel eventually hands the ::1 attempt that same
      // port as its source port and the socket self-connects: the proxy reads its own request back
      // as the response (`HPE_INVALID_CONSTANT`), prool's proxy error handler never answers, and
      // the client stalls for viem's 10 s request timeout before retrying.
      host: '127.0.0.1',
      chainId: 31337,
      hardfork: 'Prague', // PINNED — anvil's default `latest` moves over time
      gasLimit: 100_000_000, // headroom over the 30M default for stress tests
    }),
    port: Number(process.env.EVS_ANVIL_PORT ?? 0), // 0 → any free port
  });
  const stop = await server.start();
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await stop();
    throw new Error(`prool proxy: expected a TCP address, got ${String(address)}`);
  }
  project.provide('anvilPort', address.port);
  return async () => {
    await stop();
  };
}
