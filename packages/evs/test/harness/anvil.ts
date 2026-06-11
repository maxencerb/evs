/**
 * M10 `test/harness/anvil.ts` — prool anvil client helpers (integration tier).
 *
 * Contract: docs/design/module-interfaces.md §M10 + testing.md §3 (viem's production
 * pattern): one anvil instance per vitest worker, routed through the prool proxy server
 * started by `test/global-setup.ts` (`http://127.0.0.1:8545/<poolId>`).
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
});

export const testClient: TestClient = createTestClient({
  chain: foundry,
  mode: 'anvil', // setCode etc.
  transport: http(rpcUrl),
});
