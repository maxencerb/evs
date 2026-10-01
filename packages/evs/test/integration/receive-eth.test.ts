/**
 * A script accepts empty calldata (the receive path), end-to-end on anvil:
 *   - a bare call into an installed script — with or without value — succeeds with no output;
 *   - a target that pays ETH back to its caller (`MockWETH.withdraw`, WETH9's
 *     `payable(msg.sender).transfer(wad)`: a bare call carrying only the 2,300-gas stipend) works
 *     under `s.call` and `s.simulate` in every execution mode, including sender mode, where the
 *     script replaces the sender's empty code and used to turn a call that succeeds from the plain
 *     account into a revert.
 */

import { BaseError, getAddress, parseEther } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { DEFAULT_SCRIPT_ADDRESS, evscript, t } from '../../src/index.js';
import { MockWETH } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, deployer, walletClient } from './helpers.js';

const SENDER = getAddress(deployer.address); // funded on anvil, and holds WETH after beforeAll
const DEPOSIT = parseEther('1');

let weth: `0x${string}`;

beforeAll(async () => {
  weth = await deploy(MockWETH.abi, MockWETH.bytecode);
  const hash = await walletClient.writeContract({
    address: weth,
    abi: MockWETH.abi,
    functionName: 'deposit',
    value: DEPOSIT,
    account: deployer,
    chain: walletClient.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
});

/** `withdraw(amount)` (the ETH push into the script), then the caller's remaining WETH. */
const unwrap = evscript({ name: 'unwrap', args: [t.address, t.uint256] }, (s, w, amount) => {
  s.call({ address: w, abi: MockWETH.abi, functionName: 'withdraw', args: [amount] });
  const left = s.read({
    address: w,
    abi: MockWETH.abi,
    functionName: 'balanceOf',
    args: [s.env('address')],
  });
  return s.return({ left });
});
const compiled = unwrap.compile();

describe('receive path — empty calldata into the script', () => {
  test('a bare call succeeds with no output, with or without value', async () => {
    const { stateOverride } = compiled.toViem({ mode: 'stateOverride' });
    for (const value of [0n, 1n]) {
      const res = await publicClient.call({
        to: DEFAULT_SCRIPT_ADDRESS,
        data: '0x',
        value,
        account: deployer.address,
        stateOverride,
      });
      expect(res.data).toBeUndefined();
    }
  });

  test('1–3 bytes of calldata still revert EvsInvalidCalldata()', async () => {
    const { stateOverride } = compiled.toViem({ mode: 'stateOverride' });
    const err = await publicClient
      .call({ to: DEFAULT_SCRIPT_ADDRESS, data: '0x01', stateOverride })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaseError);
    const raw = (err as BaseError).walk(
      (e) => typeof (e as { data?: unknown }).data === 'string',
    ) as { data?: `0x${string}` } | null;
    expect(raw?.data).toBeDefined();
    expect(compiled.explainRevert(raw?.data ?? '0x').kind).toBe('evs-invalid-calldata');
  });
});

describe('a target that pays ETH to msg.sender (WETH9-style withdraw)', () => {
  test('withdraw(0) — a zero-value push — succeeds in deployless and stateOverride modes', async () => {
    for (const params of [compiled.toViem(), compiled.toViem({ mode: 'stateOverride' })]) {
      const out = await publicClient.readContract({
        ...params,
        functionName: 'unwrap',
        args: [weth, 0n],
      });
      expect(out).toStrictEqual({ left: 0n });
    }
  });

  test('sender mode: s.call(withdraw(1 ether)) succeeds and burns the sender WETH', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride', sender: SENDER }),
      functionName: 'unwrap',
      args: [weth, DEPOSIT],
    });
    expect(out).toStrictEqual({ left: 0n });
    // eth_call: nothing committed — the sender still holds its WETH on chain
    expect(
      await publicClient.readContract({
        address: weth,
        abi: MockWETH.abi,
        functionName: 'balanceOf',
        args: [SENDER],
      }),
    ).toBe(DEPOSIT);
  });

  test('sender mode: s.simulate / s.trySimulate of withdraw succeed (the trampoline frame receives too)', async () => {
    const script = evscript({ name: 'previewUnwrap', args: [t.address, t.uint256] }, (s, w, a) => {
      s.simulate({ address: w, abi: MockWETH.abi, functionName: 'withdraw', args: [a] });
      const attempt = s.trySimulate({
        address: w,
        abi: MockWETH.abi,
        functionName: 'withdraw',
        args: [a],
      });
      const kept = s.read({
        address: w,
        abi: MockWETH.abi,
        functionName: 'balanceOf',
        args: [s.env('address')],
      });
      return s.return({ ok: attempt.success, kept });
    });
    const out = await publicClient.readContract({
      ...script.compile().toViem({ mode: 'stateOverride', sender: SENDER }),
      functionName: 'previewUnwrap',
      args: [weth, DEPOSIT],
    });
    expect(out).toStrictEqual({ ok: true, kept: DEPOSIT }); // both dry-runs rolled back
  });
});
