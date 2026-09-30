/**
 * prool anvil client helpers (integration tier).
 *
 * Viem's production pattern: one anvil instance per vitest worker, routed through the prool
 * proxy server started by `test/global-setup.ts` (`http://127.0.0.1:<anvilPort>/<poolId>`, the
 * port being whatever free one the global setup bound and provided).
 */

import { createServer } from 'node:net';

import {
  createPublicClient,
  createTestClient,
  http,
  type PublicClient,
  type TestClient,
} from 'viem';
import { foundry } from 'viem/chains';
import { inject } from 'vite-plus/test';

export const poolId: number = Number(process.env.VITEST_POOL_ID ?? 1);

export const rpcUrl: string = `http://127.0.0.1:${inject('anvilPort')}/${poolId}`;

export const publicClient: PublicClient = createPublicClient({
  chain: foundry,
  transport: http(rpcUrl),
  // anvil automines, so a receipt is there by the time the hash comes back; viem's default
  // 4 s polling interval turns every missed first poll into a 4 s stall in `waitFor*`.
  pollingInterval: 50,
});

export const testClient: TestClient = createTestClient({
  chain: foundry,
  mode: 'anvil', // setCode etc.
  transport: http(rpcUrl),
});

/** An OS-assigned free TCP port on 127.0.0.1, for suites that spawn their own anvil. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
