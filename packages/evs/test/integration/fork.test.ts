/**
 * Fork-mode suite, env-gated on ANVIL_FORK_URL (RPC_URL also accepted).
 * Spawns a dedicated forked anvil (separate from the per-worker proxy instance) and reads
 * mainnet WETH metadata through a compiled script in both execution modes.
 *
 * Locally: ANVIL_FORK_URL=https://… vp run test:integration
 * CI runs this only on a manual workflow_dispatch of ci.yml (fork-tests job), never per-PR.
 */

import { Instance } from 'prool';
import { createPublicClient, erc20Abi, http, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { getFreePort } from '../harness/anvil.js';

const forkUrl = process.env.ANVIL_FORK_URL ?? process.env.RPC_URL;

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;

const wethMeta = evscript({ name: 'wethMeta', args: [t.address] }, (s, token) => {
  const symbol = s.read({ address: token, abi: erc20Abi, functionName: 'symbol' });
  const decimals = s.read({ address: token, abi: erc20Abi, functionName: 'decimals' });
  return s.return({ symbol, decimals });
});

describe.runIf(forkUrl !== undefined)('fork mode: real mainnet WETH', () => {
  // a free port of its own: clear of the prool proxy and of any concurrent run
  let anvil: ReturnType<typeof Instance.anvil> | undefined;
  let client: PublicClient;

  beforeAll(async () => {
    const port = await getFreePort();
    anvil = Instance.anvil({ forkUrl: forkUrl ?? '', port, chainId: 1 });
    client = createPublicClient({ chain: mainnet, transport: http(`http://127.0.0.1:${port}`) });
    await anvil.start();
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  const compiled = wethMeta.compile();

  test('deployless', async () => {
    const out = await client.readContract({
      ...compiled.toViem(),
      functionName: 'wethMeta',
      args: [WETH],
    });
    expect(out).toStrictEqual({ symbol: 'WETH', decimals: 18 });
  });

  test('stateOverride', async () => {
    const out = await client.readContract({
      ...compiled.toViem({ mode: 'stateOverride' }),
      functionName: 'wethMeta',
      args: [WETH],
    });
    expect(out).toStrictEqual({ symbol: 'WETH', decimals: 18 });
  });
});

// Always-present so the file is never empty; skips itself dynamically without the env var.
test('fork mode is env-gated (set ANVIL_FORK_URL to run it)', (ctx) => {
  if (forkUrl === undefined) ctx.skip();
  expect(forkUrl).toBeDefined();
});
