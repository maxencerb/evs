/**
 * prool anvil client helpers (integration tier).
 *
 * One anvil instance per vitest worker (`VITEST_POOL_ID`), started on first use by the registry
 * in `test/global-setup.ts`. Importing this module asks the registry for this worker's anvil URL
 * once (`GET http://127.0.0.1:<anvilRegistryPort>/<poolId>`); every client then talks to anvil
 * directly, over keep-alive connections (see the global setup for why there is no proxy hop).
 */

import {
  createPublicClient,
  createTestClient,
  http,
  type PublicClient,
  type TestClient,
} from 'viem';
import { foundry } from 'viem/chains';
import { inject } from 'vite-plus/test';

import { ANVIL_POLLING_INTERVAL } from './anvil-process.ts';

export const poolId: number = Number(process.env.VITEST_POOL_ID ?? 1);

/** Asks the registry for this worker's anvil URL, starting the instance on first use. */
async function anvilUrl(): Promise<string> {
  const registry = `http://127.0.0.1:${inject('anvilRegistryPort')}/${poolId}`;
  const response = await fetch(registry);
  if (!response.ok) {
    throw new Error(`anvil registry ${registry}: ${response.status} ${await response.text()}`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('url' in body) ||
    typeof body.url !== 'string'
  ) {
    throw new Error(`anvil registry ${registry}: unexpected answer ${JSON.stringify(body)}`);
  }
  return body.url;
}

export const rpcUrl: string = await anvilUrl();

export const publicClient: PublicClient = createPublicClient({
  chain: foundry,
  transport: http(rpcUrl),
  pollingInterval: ANVIL_POLLING_INTERVAL,
});

export const testClient: TestClient = createTestClient({
  chain: foundry,
  mode: 'anvil', // setCode etc.
  transport: http(rpcUrl),
});
