/**
 * prool anvil client helpers (integration tier).
 *
 * Viem's production pattern: one anvil instance per vitest worker, routed through the prool
 * proxy server started by `test/global-setup.ts` (`http://127.0.0.1:8545/<poolId>`).
 */

import {
  createPublicClient,
  createTestClient,
  http,
  type PublicClient,
  type TestClient,
} from 'viem';
import { foundry } from 'viem/chains';

export const poolId: number = Number(process.env.VITEST_POOL_ID ?? 1);

export const rpcUrl: string = `http://127.0.0.1:8545/${poolId}`;

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
