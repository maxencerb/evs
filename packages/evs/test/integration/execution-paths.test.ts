/**
 * Execution-path mechanics, every release:
 *   - deployless `code` path: toViem() hands viem the INIT bytecode — incl. the raw-runtime
 *     silent-failure canary
 *   - stateOverride at a custom `address`
 *
 * One nontrivial script (cross-call data flow + arithmetic) must return identical, fully-decoded
 * results. The plain three-path matrix (deployless / stateOverride / anvil_setCode) lives in
 * flagship.test.ts (E1, default and optimized) and composite.test.ts (struct outputs).
 */

import { encodeFunctionData, erc20Abi, getAddress, parseEther } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { MockERC20 } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { callExpectRevert, deploy, deployer, write } from './helpers.js';

const tokenMeta = evscript(
  { name: 'tokenMeta', args: [t.address, t.address] },
  (s, token, holder) => {
    const symbol = s.read({ address: token, abi: erc20Abi, functionName: 'symbol' });
    const decimals = s.read({ address: token, abi: erc20Abi, functionName: 'decimals' });
    const bal = s.read({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder],
    });
    const doubled = s.mul(bal, 2n);
    return s.return({ symbol, decimals, bal, doubled });
  },
);

const compiled = tokenMeta.compile();

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

describe('execution-path mechanics', () => {
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
    // behavior was silent empty data; either way the
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
