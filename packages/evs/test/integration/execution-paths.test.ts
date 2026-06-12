/**
 * testing.md §3 "Execution paths covered, every release":
 *   1. anvil_setCode + plain readContract
 *   2. stateOverride mode
 *   3. deployless `code` path (initBytecode) — incl. the raw-runtime silent-failure canary
 *
 * One nontrivial script (cross-call data flow + arithmetic) runs through all three paths
 * and must return identical, fully-decoded results.
 */

import { encodeFunctionData, erc20Abi, getAddress, parseEther } from 'viem';
import { beforeAll, describe, expect, test } from 'vitest';

import { arg, evscript, t } from '../../src/index.js';
import { MockERC20 } from '../generated/index.js';
import { publicClient, testClient } from '../harness/anvil.js';
import { callExpectRevert, deploy, deployer, write } from './helpers.js';

const tokenMeta = evscript(
  { name: 'tokenMeta', args: [arg('token', t.address), arg('holder', t.address)] },
  (s) => {
    const symbol = s.call({ address: s.args.token, abi: erc20Abi, functionName: 'symbol' });
    const decimals = s.call({ address: s.args.token, abi: erc20Abi, functionName: 'decimals' });
    const bal = s.call({
      address: s.args.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [s.args.holder],
    });
    const doubled = s.mul(bal, 2n);
    return s.return({ symbol, decimals, bal, doubled });
  },
);

const compiled = tokenMeta.compile();

const SCRIPT_AT = '0x00000000000000000000000000000000000eff01' as const;

let token: `0x${string}`;

beforeAll(async () => {
  token = await deploy(MockERC20.abi, MockERC20.bytecode, ['Wrapped Test', 'WTEST', 18]);
  await write({
    address: token,
    abi: MockERC20.abi,
    functionName: 'mint',
    args: [deployer.address, parseEther('123')],
  });
});

const expected = () => ({
  symbol: 'WTEST',
  decimals: 18,
  bal: parseEther('123'),
  doubled: parseEther('246'),
});

describe('three execution paths', () => {
  test('path 1: anvil_setCode + plain readContract', async () => {
    await testClient.setCode({ address: SCRIPT_AT, bytecode: compiled.runtimeBytecode });
    const out = await publicClient.readContract({
      address: SCRIPT_AT,
      abi: compiled.abi,
      functionName: 'tokenMeta',
      args: [token, deployer.address],
    });
    expect(out).toStrictEqual(expected());
  });

  test('path 2: stateOverride mode', async () => {
    const out = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride' }),
      functionName: 'tokenMeta',
      args: [token, deployer.address],
    });
    expect(out).toStrictEqual(expected());
  });

  test('path 2b: stateOverride at a custom address', async () => {
    const custom = getAddress('0x00000000000000000000000000000000000eff02');
    const viemParams = compiled.toViem({ mode: 'stateOverride', address: custom });
    expect(viemParams.address).toBe(custom);
    const out = await publicClient.readContract({
      ...viemParams,
      functionName: 'tokenMeta',
      args: [token, deployer.address],
    });
    expect(out).toStrictEqual(expected());
  });

  test('path 3: deployless via `code` (initBytecode)', async () => {
    const viemParams = compiled.toViem(); // deployless is the default mode
    expect(viemParams.code).toBe(compiled.initBytecode);
    const out = await publicClient.readContract({
      ...viemParams,
      functionName: 'tokenMeta',
      args: [token, deployer.address],
    });
    expect(out).toStrictEqual(expected());
  });

  test('canary: raw RUNTIME bytecode as `code` fails with a USELESS empty revert (the footgun)', async () => {
    // viem's deployless wrapper CREATE2-executes `code` as initcode. evs runtime bytecode
    // run as initcode hits the dispatcher with EMPTY calldata and reverts, so create2
    // yields the zero address and the wrapper reverts with NO data — the caller gets a
    // generic "execution reverted" with zero diagnostic content. (The historical viem
    // behavior was silent empty data — docs/research/viem-integration.md; either way the
    // misuse is undebuggable, which is why toViem() always hands out initBytecode.)
    // This canary keeps the guard rails honest: if the failure mode ever changes again,
    // revisit the docs and toViem() defaults.
    const raw = await callExpectRevert({
      code: compiled.runtimeBytecode, // WRONG on purpose — must be initBytecode
      data: encodeFunctionData({
        abi: compiled.abi,
        functionName: 'tokenMeta',
        args: [token, deployer.address],
      }),
    });
    expect(raw).toBe('0x'); // empty revert: no EvsInvalidCalldata, no Panic — nothing
  });
});
