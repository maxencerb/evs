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
