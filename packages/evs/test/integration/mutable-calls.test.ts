/**
 * Issue #1 — the mutable-call surface against real anvil state (the tier that observes the one
 * thing the stateless unit oracle cannot: whether a write PERSISTS).
 *
 * The whole demonstration runs INSIDE a single `eth_call` against a freshly-deployed MockVault:
 *
 * - `s.call(vault.deposit(amount))` opens a real CALL frame, so the write lands in the eth_call's
 *   state and a SUBSEQUENT `s.read(vault.totalShares())` in the same script SEES it (mutation).
 * - `s.simulate(vault.deposit(amount))` runs the write in a self-call sub-frame that REVERTS, so
 *   the later `s.read(vault.totalShares())` sees the ORIGINAL value (non-mutation / rollback) while
 *   the simulate still reads back the returned `shares` value.
 *
 * Either way the eth_call itself never commits, so the on-chain `totalShares` is unchanged after —
 * asserted at the end of each test.
 */

import { encodeFunctionData } from 'viem';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { MockQuoter, MockVault } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { callExpectRevert, deploy } from './helpers.js';

let vault: `0x${string}`;
let quoter: `0x${string}`;

beforeEach(async () => {
  vault = await deploy(MockVault.abi, MockVault.bytecode);
  quoter = await deploy(MockQuoter.abi, MockQuoter.bytecode);
});

/** `s.call(deposit)` then `s.read(totalShares)` — the write is visible to the later read. */
const callThenRead = evscript(
  { name: 'callThenRead', args: [t.address, t.uint256] },
  (s, v, amount) => {
    const shares = s.call({
      address: v,
      abi: MockVault.abi,
      functionName: 'deposit',
      args: [amount],
    });
    const total = s.read({ address: v, abi: MockVault.abi, functionName: 'totalShares' });
    return s.return({ shares, total });
  },
);

/** `s.simulate(deposit)` then `s.read(totalShares)` — the write is rolled back (invisible). */
const simulateThenRead = evscript(
  { name: 'simulateThenRead', args: [t.address, t.uint256] },
  (s, v, amount) => {
    const shares = s.simulate({
      address: v,
      abi: MockVault.abi,
      functionName: 'deposit',
      args: [amount],
    });
    const total = s.read({ address: v, abi: MockVault.abi, functionName: 'totalShares' });
    return s.return({ shares, total });
  },
);

const compiledCallThenRead = callThenRead.compile();
const compiledSimulateThenRead = simulateThenRead.compile();

describe('s.call commits the write within the eth_call (mutation observed)', () => {
  test('a later read sees the deposit (deployless + stateOverride)', async () => {
    const args = [vault, 100n] as const;
    for (const params of [
      compiledCallThenRead.toViem(),
      compiledCallThenRead.toViem({ mode: 'stateOverride' }),
    ]) {
      const out = await publicClient.readContract({
        ...params,
        functionName: 'callThenRead',
        args,
      });
      // deposit(100) → 200 shares minted; the subsequent totalShares() read sees the mutation
      expect(out).toStrictEqual({ shares: 200n, total: 200n });
    }
    // ...and the eth_call committed NOTHING: on-chain totalShares is still 0
    const onChain = await publicClient.readContract({
      address: vault,
      abi: MockVault.abi,
      functionName: 'totalShares',
    });
    expect(onChain).toBe(0n);
  });
});

describe('s.simulate rolls the write back (non-mutation observed)', () => {
  test('a later read sees the ORIGINAL value, yet the return value is read back', async () => {
    const args = [vault, 100n] as const;
    for (const params of [
      compiledSimulateThenRead.toViem(),
      compiledSimulateThenRead.toViem({ mode: 'stateOverride' }),
    ]) {
      const out = await publicClient.readContract({
        ...params,
        functionName: 'simulateThenRead',
        args,
      });
      // the dry-run returns shares = 200, but its write was rolled back → totalShares reads 0
      expect(out).toStrictEqual({ shares: 200n, total: 0n });
    }
    const onChain = await publicClient.readContract({
      address: vault,
      abi: MockVault.abi,
      functionName: 'totalShares',
    });
    expect(onChain).toBe(0n);
  });

  test('isolation: a committed s.call and a rolled-back s.simulate compose correctly', async () => {
    // s.call(deposit 10) commits (+20); s.simulate(deposit 1000) rolls back; the final read sees
    // only the committed 20.
    const mixed = evscript({ name: 'mixed', args: [t.address] }, (s, v) => {
      const committed = s.call({
        address: v,
        abi: MockVault.abi,
        functionName: 'deposit',
        args: [10n],
      });
      const dryRun = s.simulate({
        address: v,
        abi: MockVault.abi,
        functionName: 'deposit',
        args: [1000n],
      });
      const total = s.read({ address: v, abi: MockVault.abi, functionName: 'totalShares' });
      return s.return({ committed, dryRun, total });
    });
    const out = await publicClient.readContract({
      ...mixed.compile().toViem({ mode: 'stateOverride' }),
      functionName: 'mixed',
      args: [vault],
    });
    expect(out).toStrictEqual({ committed: 20n, dryRun: 2000n, total: 20n });
  });
});

describe('s.call for a non-view quoter (the canonical CALL use case)', () => {
  test('a nonpayable quoter that cannot run under STATICCALL returns its quote', async () => {
    const quote = evscript({ name: 'quote', args: [t.address, t.uint256] }, (s, q, amountIn) => {
      const amountOut = s.call({
        address: q,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInput',
        args: [amountIn],
      });
      return s.return({ amountOut });
    });
    const out = await publicClient.readContract({
      ...quote.compile().toViem({ mode: 'stateOverride' }),
      functionName: 'quote',
      args: [quoter, 100n],
    });
    expect(out).toStrictEqual({ amountOut: 150n }); // 100 * 3 / 2
  });

  test('s.tryCall on a reverting (QuoterV1-style) quoter WITHOUT revertReturns → success=false', async () => {
    // quoteExactInputReverting declares no outputs (it reverts with raw bytes): without the
    // revertReturns opt-in a revert is still a failure — s.tryCall reports success=false.
    const quote = evscript({ name: 'tryQuote', args: [t.address, t.uint256] }, (s, q, amountIn) => {
      const r = s.tryCall({
        address: q,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInputReverting',
        args: [amountIn],
      });
      return s.return({ ok: r.success });
    });
    const out = await publicClient.readContract({
      ...quote.compile().toViem({ mode: 'stateOverride' }),
      functionName: 'tryQuote',
      args: [quoter, 100n],
    });
    expect(out).toStrictEqual({ ok: false });
  });
});

describe('revertReturns (issue #35) — the QuoterV1 pattern against real anvil state', () => {
  test('s.call decodes the revert payload of quoteExactInputReverting as the quote', async () => {
    const quote = evscript({ name: 'quoteV1', args: [t.address, t.uint256] }, (s, q, amountIn) => {
      const amountOut = s.call({
        address: q,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInputReverting',
        args: [amountIn],
        revertReturns: [t.uint256], // the ABI declares no outputs; the amount is in the revert data
      });
      return s.return({ amountOut });
    });
    const out = await publicClient.readContract({
      ...quote.compile().toViem({ mode: 'stateOverride' }),
      functionName: 'quoteV1',
      args: [quoter, 100n],
    });
    expect(out).toStrictEqual({ amountOut: 150n }); // 100 * 3 / 2, read back from the revert
  });

  test('s.tryCall + revertReturns: revert → success=true + value; normal return → success=false', async () => {
    const quote = evscript(
      { name: 'tryQuoteV1', args: [t.address, t.uint256] },
      (s, q, amountIn) => {
        const v1 = s.tryCall({
          address: q,
          abi: MockQuoter.abi,
          functionName: 'quoteExactInputReverting',
          args: [amountIn],
          revertReturns: [t.uint256],
        });
        // a QuoterV2-style function RETURNS normally: under revertReturns that is the failure
        const v2 = s.tryCall({
          address: q,
          abi: MockQuoter.abi,
          functionName: 'quoteExactInput',
          args: [amountIn],
          revertReturns: [t.uint256],
        });
        return s.return({ ok1: v1.success, out1: v1.value, ok2: v2.success, out2: v2.value });
      },
    );
    const out = await publicClient.readContract({
      ...quote.compile().toViem({ mode: 'stateOverride' }),
      functionName: 'tryQuoteV1',
      args: [quoter, 100n],
    });
    expect(out).toStrictEqual({ ok1: true, out1: 150n, ok2: false, out2: 0n });
  });

  test('strict s.call + revertReturns on a normally-returning target → EvsDecodeError(site), not a bubble', async () => {
    const quote = evscript({ name: 'v2asV1', args: [t.address, t.uint256] }, (s, q, amountIn) => {
      const amountOut = s.call({
        address: q,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInput',
        args: [amountIn],
        revertReturns: [t.uint256],
      });
      return s.return({ amountOut });
    });
    const compiled = quote.compile();
    const override = compiled.toViem({ mode: 'stateOverride' });
    const raw = await callExpectRevert({
      to: override.address,
      stateOverride: override.stateOverride,
      data: encodeFunctionData({ abi: compiled.abi, functionName: 'v2asV1', args: [quoter, 100n] }),
    });
    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('evs-decode');
    expect(explained.message).toContain('decoding call quoteExactInput() revert data failed');
  });
});

describe('s.simulate revert handling', () => {
  test('strict s.simulate bubbles the simulated target revert (Error(string))', async () => {
    const sim = evscript({ name: 'simRevert', args: [t.address] }, (s, v) => {
      const shares = s.simulate({
        address: v,
        abi: MockVault.abi,
        functionName: 'depositOrRevert',
        args: [0n],
      });
      return s.return({ shares });
    });
    const compiled = sim.compile();
    const override = compiled.toViem({ mode: 'stateOverride' });
    const raw = await callExpectRevert({
      to: override.address,
      stateOverride: override.stateOverride,
      data: encodeFunctionData({ abi: compiled.abi, functionName: 'simRevert', args: [vault] }),
    });
    // Error("ZERO_AMOUNT") bubbled verbatim from the simulated write
    const explained = compiled.explainRevert(raw);
    expect(explained.kind).toBe('error-string');
    expect(explained.message).toContain('ZERO_AMOUNT');
  });

  test('s.trySimulate on a reverting target → success=false, zero value', async () => {
    const sim = evscript({ name: 'trySimRevert', args: [t.address] }, (s, v) => {
      const r = s.trySimulate({
        address: v,
        abi: MockVault.abi,
        functionName: 'depositOrRevert',
        args: [0n],
      });
      return s.return({ ok: r.success, shares: r.value });
    });
    const out = await publicClient.readContract({
      ...sim.compile().toViem({ mode: 'stateOverride' }),
      functionName: 'trySimRevert',
      args: [vault],
    });
    expect(out).toStrictEqual({ ok: false, shares: 0n });
  });
});
