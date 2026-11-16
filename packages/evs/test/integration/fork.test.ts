/**
 * Fork-mode suite, env-gated on ANVIL_FORK_URL and on nothing else (`harness/fork-url.ts`).
 * Starts an anvil of its own that forks the given node (the per-worker anvil of the other
 * files is a fresh local chain) and reads mainnet WETH metadata through a compiled script in
 * both execution modes.
 *
 * Locally: ANVIL_FORK_URL=https://… vp run test:integration
 * CI runs this only on a manual workflow_dispatch of ci.yml (fork-tests job), never per-PR.
 */

import { createPublicClient, erc20Abi, http, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { spawnAnvil, type Anvil } from '../harness/anvil-process.ts';
import { forkUrlOf } from '../harness/fork-url.ts';

const forkUrl = forkUrlOf(process.env);

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const;

const wethMeta = evscript({ name: 'wethMeta', args: [t.address] }, (s, token) => {
  const symbol = s.read({ address: token, abi: erc20Abi, functionName: 'symbol' });
  const decimals = s.read({ address: token, abi: erc20Abi, functionName: 'decimals' });
  return s.return({ symbol, decimals });
});

describe.runIf(forkUrl !== undefined)('fork mode: real mainnet WETH', () => {
  let anvil: Anvil | undefined;
  let client: PublicClient;

  beforeAll(async () => {
    if (forkUrl === undefined) throw new Error('unreachable: the suite is gated on forkUrl');
    // anvil reads the remote chain before it listens: more time than a local start, and less
    // than the hook's, so a node that does not answer is reported as such
    anvil = await spawnAnvil({ args: { forkUrl, chainId: 1 }, startTimeoutMs: 45_000 });
    client = createPublicClient({ chain: mainnet, transport: http(anvil.url) });
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
// When set, the value must be a usable RPC URL — a clear failure here beats an anvil CLI error.
test('fork mode is env-gated (set ANVIL_FORK_URL to run it)', (ctx) => {
  if (forkUrl === undefined) {
    ctx.skip();
    return;
  }
  expect(URL.parse(forkUrl)?.protocol ?? 'ANVIL_FORK_URL is not a URL').toMatch(/^(https?|wss?):$/);
});
