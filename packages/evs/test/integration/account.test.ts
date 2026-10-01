/**
 * Account reads against real chain state: `s.balance` / `s.codeSize` / `s.codeHash` (BALANCE,
 * EXTCODESIZE, EXTCODEHASH) must equal `eth_getBalance` / `eth_getCode` (length, keccak256) at
 * the same block, in both `toViem()` modes, for a funded contract, a used EOA and an address
 * with no state at all. The script's own balance (SELFBALANCE) is frame-dependent: the
 * stateOverride address's override balance, and zero at the deployless counterfactual address.
 * Sender mode swaps only the sender's code: its own reads see the script runtime there.
 */

import { getAddress, keccak256, size, zeroHash, type Address } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { MockERC20 } from '../generated/index.js';
import { publicClient, testClient } from '../harness/anvil.js';
import { deploy, deployer } from './helpers.js';

const probe = evscript({ name: 'probe', args: [t.address] }, (s, who) =>
  s.return({ bal: s.balance(who), size: s.codeSize(who), hash: s.codeHash(who) }),
).compile();

const mine = evscript({ name: 'mine', args: [] }, (s) =>
  s.return({ bal: s.balance(s.env('address')), size: s.codeSize(s.env('address')) }),
).compile();

/** No code, no balance, no nonce on the anvil chain: EXTCODEHASH is zero. */
const NOBODY: Address = getAddress('0x00000000000000000000000000000000000e5b01');

let token: Address;

beforeAll(async () => {
  token = await deploy(MockERC20.abi, MockERC20.bytecode, ['Account Probe', 'ACCT', 18]);
  await testClient.setBalance({ address: token, value: 12_345n });
});

/** What the node reports for `address` at `blockNumber`. */
async function expected(address: Address, blockNumber: bigint) {
  const [bal, code, nonce] = await Promise.all([
    publicClient.getBalance({ address, blockNumber }),
    publicClient.getCode({ address, blockNumber }),
    publicClient.getTransactionCount({ address, blockNumber }),
  ]);
  const runtime = code ?? '0x';
  const empty = bal === 0n && nonce === 0 && runtime === '0x';
  return { bal, size: BigInt(size(runtime)), hash: empty ? zeroHash : keccak256(runtime) };
}

describe('s.balance / s.codeSize / s.codeHash vs eth_getBalance / eth_getCode', () => {
  test.each(['deployless', 'stateOverride'] as const)('%s mode', async (mode) => {
    // cacheTime 0: viem caches the block number, which would pin a block before the deploy
    const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
    const params = mode === 'deployless' ? probe.toViem() : probe.toViem({ mode });
    const accounts = [token, deployer.address, NOBODY] as const; // contract, used EOA, no state
    const [got, want] = await Promise.all([
      Promise.all(
        accounts.map((address) =>
          publicClient.readContract({
            ...params,
            functionName: 'probe',
            args: [address],
            blockNumber,
          }),
        ),
      ),
      Promise.all(accounts.map((address) => expected(address, blockNumber))),
    ]);
    expect(got).toStrictEqual(want);
    // the three accounts cover the three EXTCODEHASH outcomes
    expect(want.map((w) => w.hash === zeroHash)).toEqual([false, false, true]);
    expect(want[1]?.hash).toBe(keccak256('0x'));
  });
});

describe("the script's own account (SELFBALANCE, frame-dependent)", () => {
  test('stateOverride: the override balance, and the script runtime as code', async () => {
    const params = mine.toViem({ mode: 'stateOverride' });
    const [entry] = params.stateOverride;
    if (entry === undefined) throw new Error('toViem: missing the state-override entry');
    const out = await publicClient.readContract({
      ...params,
      stateOverride: [{ ...entry, balance: 777n }],
      functionName: 'mine',
    });
    expect(out).toStrictEqual({ bal: 777n, size: BigInt(size(mine.runtimeBytecode)) });
  });

  test("sender mode: the sender's real balance, but the script runtime as its code", async () => {
    // an EOA sender: the override swaps its code (none) for the script's runtime, so it reads as
    // a contract from inside the script; its balance is untouched
    const sender = deployer.address;
    const out = await publicClient.readContract({
      ...probe.toViem({ mode: 'stateOverride', sender }),
      functionName: 'probe',
      args: [sender],
    });
    expect(out).toStrictEqual({
      bal: await publicClient.getBalance({ address: sender }),
      size: BigInt(size(probe.runtimeBytecode)),
      hash: keccak256(probe.runtimeBytecode),
    });
    expect(await publicClient.getCode({ address: sender })).toBeUndefined();
  });

  test('deployless: the counterfactual script address holds nothing', async () => {
    const out = await publicClient.readContract({ ...mine.toViem(), functionName: 'mine' });
    expect(out).toStrictEqual({ bal: 0n, size: BigInt(size(mine.runtimeBytecode)) });
  });
});
