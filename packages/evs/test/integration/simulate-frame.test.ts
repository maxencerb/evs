/**
 * Issue #36 — the `s.simulate` follow-ups, end-to-end on anvil against real state:
 *   - nested simulate: a simulate inside an `s.fn` body (called twice, and from another fn), and
 *     a dry-run whose result feeds the next dry-run — every hop rolls back;
 *   - the `gas` cap: bounds the INNER target call of `s.simulate` (and `s.call` / `s.read`),
 *     observed through `MockFrame.gasProbe`, and contains a gas-burning target (`burnAll`) so the
 *     script survives it;
 *   - sender mode: `toViem({ mode: 'stateOverride', sender })` installs the script AT the sender,
 *     so every sub-call target sees `msg.sender = sender` (a `msg.sender`-keyed write lands on it).
 */

import { getAddress } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { DEFAULT_SCRIPT_ADDRESS, evscript, t } from '../../src/index.js';
import { MockFrame, MockVault } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, deployer } from './helpers.js';

/** anvil's well-known account #1 — a funded EOA with no code, the "chosen sender". */
const SENDER = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const ZERO = '0x0000000000000000000000000000000000000000';

let vault: `0x${string}`;
let frame: `0x${string}`;

beforeAll(async () => {
  vault = await deploy(MockVault.abi, MockVault.bytecode);
  frame = await deploy(MockFrame.abi, MockFrame.bytecode);
});

const totalSharesOnChain = () =>
  publicClient.readContract({ address: vault, abi: MockVault.abi, functionName: 'totalShares' });

describe('nested simulate', () => {
  test('a simulate inside an s.fn body, called twice — both hops roll back', async () => {
    const script = evscript({ name: 'fnSim', args: [t.address, t.uint256] }, (s, v, amount) => {
      const preview = s.fn('preview', [t.address, t.uint256], (target, a) =>
        s.simulate({ address: target, abi: MockVault.abi, functionName: 'deposit', args: [a] }),
      );
      const a = preview(v, amount);
      const b = preview(v, s.div(amount, 2n));
      const total = s.read({ address: v, abi: MockVault.abi, functionName: 'totalShares' });
      return s.return({ a, b, total });
    });
    const compiled = script.compile();
    for (const params of [compiled.toViem(), compiled.toViem({ mode: 'stateOverride' })]) {
      const out = await publicClient.readContract({
        ...params,
        functionName: 'fnSim',
        args: [vault, 100n],
      });
      expect(out).toStrictEqual({ a: 200n, b: 100n, total: 0n });
    }
    expect(await totalSharesOnChain()).toBe(0n);
  });

  test('two levels of s.fn and a chained dry-run: the first result feeds the second', async () => {
    const script = evscript({ name: 'chainSim', args: [t.address, t.uint256] }, (s, v, amount) => {
      const inner = s.fn('inner', [t.address, t.uint256], (target, a) =>
        s.simulate({ address: target, abi: MockVault.abi, functionName: 'deposit', args: [a] }),
      );
      const outer = s.fn('outer', [t.address, t.uint256], (target, a) =>
        s.add(inner(target, a), inner(target, a)),
      );
      const first = outer(v, amount); // 2 · (2·amount)
      const second = s.simulate({
        address: v,
        abi: MockVault.abi,
        functionName: 'deposit',
        args: [first], // the dry-run of a dry-run's result
      });
      const total = s.read({ address: v, abi: MockVault.abi, functionName: 'totalShares' });
      return s.return({ first, second, total });
    });
    const out = await publicClient.readContract({
      ...script.compile().toViem({ mode: 'stateOverride' }),
      functionName: 'chainSim',
      args: [vault, 100n],
    });
    expect(out).toStrictEqual({ first: 400n, second: 800n, total: 0n });
    expect(await totalSharesOnChain()).toBe(0n);
  });
});

describe('the `gas` cap', () => {
  test('bounds the inner target call of s.simulate / s.call / s.read (gasProbe)', async () => {
    const script = evscript({ name: 'probes', args: [t.address, t.uint256] }, (s, f, cap) => {
      const sim = s.simulate({
        address: f,
        abi: MockFrame.abi,
        functionName: 'gasProbe',
        gas: cap,
      });
      const call = s.call({ address: f, abi: MockFrame.abi, functionName: 'gasProbe', gas: cap });
      const read = s.read({
        address: f,
        abi: MockFrame.abi,
        functionName: 'gasProbeView',
        gas: cap,
      });
      const free = s.simulate({ address: f, abi: MockFrame.abi, functionName: 'gasProbe' });
      return s.return({ sim, call, read, free });
    });
    const compiled = script.compile();
    const cap = 100_000n;
    for (const params of [compiled.toViem(), compiled.toViem({ mode: 'stateOverride' })]) {
      const out = await publicClient.readContract({
        ...params,
        functionName: 'probes',
        args: [frame, cap],
      });
      // gasleft() on entry ≤ the cap (the callee's own entry cost is a few hundred gas at most)
      for (const g of [out.sim, out.call, out.read]) {
        expect(g).toBeLessThanOrEqual(cap);
        expect(g).toBeGreaterThan(cap - 2_000n);
      }
      expect(out.free).toBeGreaterThan(1_000_000n); // uncapped: forwards (63/64 of) everything
    }
  });

  test('contains a gas-burning target: s.trySimulate(burnAll, gas) → false, and the script goes on', async () => {
    const script = evscript({ name: 'contained', args: [t.address, t.address] }, (s, f, v) => {
      const burned = s.trySimulate({
        address: f,
        abi: MockFrame.abi,
        functionName: 'burnAll',
        gas: 100_000n,
      });
      const alsoBurned = s.tryCall({
        address: f,
        abi: MockFrame.abi,
        functionName: 'burnAll',
        gas: 100_000n,
      });
      const total = s.read({ address: v, abi: MockVault.abi, functionName: 'totalShares' });
      return s.return({ burned: burned.success, alsoBurned: alsoBurned.success, total });
    });
    const compiled = script.compile();
    for (const params of [compiled.toViem(), compiled.toViem({ mode: 'stateOverride' })]) {
      const out = await publicClient.readContract({
        ...params,
        functionName: 'contained',
        args: [frame, vault],
      });
      expect(out).toStrictEqual({ burned: false, alsoBurned: false, total: 0n });
    }
  });
});

describe('sender mode — toViem({ mode: "stateOverride", sender })', () => {
  const whoSees = evscript({ name: 'whoSees', args: [t.address] }, (s, f) => {
    const viaRead = s.read({ address: f, abi: MockFrame.abi, functionName: 'caller' });
    const viaCall = s.call({ address: f, abi: MockFrame.abi, functionName: 'whoCalls' });
    const viaSimulate = s.simulate({ address: f, abi: MockFrame.abi, functionName: 'whoCalls' });
    const me = s.env('caller');
    const self = s.env('address');
    return s.return({ viaRead, viaCall, viaSimulate, me, self });
  });
  const compiled = whoSees.compile();

  test('every sub-call target — read, call AND the simulated write — sees msg.sender = sender', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride', sender: SENDER }),
      functionName: 'whoSees',
      args: [frame],
    });
    // the script lives AT the sender and self-calls through it; `account` = sender too
    expect(out).toStrictEqual({
      viaRead: SENDER,
      viaCall: SENDER,
      viaSimulate: SENDER,
      me: SENDER,
      self: SENDER,
    });
  });

  test('for contrast: plain stateOverride and deployless targets see the SCRIPT address', async () => {
    const plain = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride' }),
      functionName: 'whoSees',
      args: [frame],
    });
    expect(plain).toStrictEqual({
      viaRead: DEFAULT_SCRIPT_ADDRESS,
      viaCall: DEFAULT_SCRIPT_ADDRESS,
      viaSimulate: DEFAULT_SCRIPT_ADDRESS,
      me: ZERO, // no `account` passed
      self: DEFAULT_SCRIPT_ADDRESS,
    });
    const deployless = await publicClient.readContract({
      ...compiled.toViem(),
      functionName: 'whoSees',
      args: [frame],
    });
    // the counterfactual CREATE2 address — the same for all three verbs, never the sender
    expect(deployless.viaCall).toBe(deployless.self);
    expect(deployless.viaSimulate).toBe(deployless.self);
    expect(deployless.viaRead).toBe(deployless.self);
    expect(deployless.self).not.toBe(SENDER);
  });

  test('a msg.sender-keyed write lands on the sender: s.call(deposit) then balanceOf(sender)', async () => {
    const script = evscript({ name: 'creditsWhom', args: [t.address, t.address] }, (s, v, who) => {
      const shares = s.call({
        address: v,
        abi: MockVault.abi,
        functionName: 'deposit',
        args: [10n],
      });
      const credited = s.read({
        address: v,
        abi: MockVault.abi,
        functionName: 'balanceOf',
        args: [who],
      });
      return s.return({ shares, credited });
    });
    const c = script.compile();
    const asSender = await publicClient.readContract({
      ...c.toViem({ mode: 'stateOverride', sender: SENDER }),
      functionName: 'creditsWhom',
      args: [vault, SENDER],
    });
    expect(asSender).toStrictEqual({ shares: 20n, credited: 20n });
    const asScript = await publicClient.readContract({
      ...c.toViem({ mode: 'stateOverride' }),
      functionName: 'creditsWhom',
      args: [vault, SENDER],
    });
    expect(asScript).toStrictEqual({ shares: 20n, credited: 0n }); // credited the script instead
    expect(await totalSharesOnChain()).toBe(0n); // eth_call: nothing committed either way
  });

  test('`account` after the spread re-targets the OUTER caller only; targets still see the sender', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride', sender: SENDER }),
      functionName: 'whoSees',
      args: [frame],
      account: deployer.address, // overrides the shape's `account: sender`
    });
    expect(out.me).toBe(getAddress(deployer.address));
    expect(out.viaCall).toBe(SENDER);
    expect(out.viaSimulate).toBe(SENDER);
    expect(out.self).toBe(SENDER);
  });
});
