/**
 * The app with evs: one `readContract`. Built twice by the benchmark, with the plugin and
 * without it, from these same files.
 */
import { createPublicClient, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';

import { poolMeta } from './pool.evs.ts';

const client = createPublicClient({ chain: mainnet, transport: http() });

export const readPool = (pool: Address, holder: Address) =>
  client.readContract({
    ...poolMeta.toViem(),
    functionName: 'poolMeta',
    args: [pool, holder],
  });
