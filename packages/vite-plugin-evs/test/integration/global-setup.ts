/**
 * vitest globalSetup for the `plugin-integration` project: one anvil for the run, started
 * through prool on a free port. The tests read its URL with `inject('anvilUrl')`.
 */

import { createServer } from 'node:net';

import { Instance } from 'prool';
import type { TestProject } from 'vite-plus/test/node';

declare module 'vite-plus/test' {
  interface ProvidedContext {
    /** The RPC URL of the run's anvil. */
    anvilUrl: string;
  }
}

/** An OS-assigned free TCP port on the IPv4 loopback. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const anvil = Instance.anvil({
    host: '127.0.0.1', // anvil does not listen on ::1, where `localhost` can resolve
    port: await freePort(),
    chainId: 31337,
    hardfork: 'Prague', // pinned, like the library's integration tests
  });
  await anvil.start();
  project.provide('anvilUrl', `http://${anvil.host}:${anvil.port}`);
  return async () => {
    await anvil.stop();
  };
}
