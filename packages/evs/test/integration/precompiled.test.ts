/**
 * Precompiled scripts, end to end: a script serialized by `toPrecompiled()` and rebuilt by
 * `hydrate` from JSON (what a client bundle holds, imported from the compiler-free runtime
 * entry) runs against the node exactly like the artifact, in deployless and state-override mode,
 * and explains a real revert the same way.
 */

import { erc20Abi, getAddress, parseEther } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, namedArg, t } from '../../src/index.js';
import {
  decodeScriptError,
  hydrate,
  isPrecompiledScript,
  type PrecompiledScriptData,
  type PrecompiledScriptDebug,
} from '../../src/runtime.js';
import { MockERC20 } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, deployer, write } from './helpers.js';

const NoBalance = t.error('NoBalance', [namedArg('holder', t.address)]);

const tokenMeta = evscript(
  { name: 'tokenMeta', args: [t.address, t.address], errors: [NoBalance] },
  (s, token, holder) => {
    const symbol = s.read({ address: token, abi: erc20Abi, functionName: 'symbol' });
    const decimals = s.read({ address: token, abi: erc20Abi, functionName: 'decimals' });
    const bal = s.read({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder],
    });
    s.if(bal.eq(0n), () => {
      s.throw(NoBalance, { holder });
    });
    return s.return({ symbol, decimals, bal, doubled: s.mul(bal, 2n) });
  },
);

const compiled = tokenMeta.compile();
const EMPTY_HOLDER = getAddress('0x00000000000000000000000000000000000eff03');

/** The build step: the script and its debug data as the two JSON documents a bundle carries. */
async function serialize(): Promise<{ data: string; debug: string }> {
  const precompiled = compiled.toPrecompiled();
  return { data: JSON.stringify(precompiled), debug: JSON.stringify(await precompiled.debug()) };
}

/** The client: the script rebuilt from that JSON, with the literal ABI type of the source. */
async function load() {
  const json = await serialize();
  const data: PrecompiledScriptData<typeof compiled.abi> = JSON.parse(json.data);
  return hydrate(data, {
    debug: async () => {
      const debug: PrecompiledScriptDebug = JSON.parse(json.debug);
      return { default: debug };
    },
  });
}

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

describe('a precompiled script hydrated from JSON', () => {
  test('is a precompiled script holding the artifact’s bytecode', async () => {
    const script = await load();
    expect(isPrecompiledScript(script)).toBe(true);
    expect(script.runtimeBytecode).toBe(compiled.runtimeBytecode);
    expect(script.initBytecode).toBe(compiled.initBytecode);
  });

  test('deployless: the same result as the artifact', async () => {
    const script = await load();
    const call = { functionName: 'tokenMeta', args: [token, deployer.address] } as const;
    const out = await publicClient.readContract({ ...script.toViem(), ...call });
    expect(out).toStrictEqual({
      symbol: 'WTEST',
      decimals: 18,
      bal: parseEther('123'),
      doubled: parseEther('246'),
    });
    expect(out).toStrictEqual(await publicClient.readContract({ ...compiled.toViem(), ...call }));
  });

  test('state override, at the default address, a custom one and in sender mode', async () => {
    const script = await load();
    const call = { functionName: 'tokenMeta', args: [token, deployer.address] } as const;
    const expected = await publicClient.readContract({
      ...compiled.toViem({ mode: 'stateOverride' }),
      ...call,
    });
    const custom = getAddress('0x00000000000000000000000000000000000eff02');
    const shapes = [
      script.toViem({ mode: 'stateOverride' }),
      script.toViem({ mode: 'stateOverride', address: custom }),
      script.toViem({ mode: 'stateOverride', sender: deployer.address }),
    ];
    for (const shape of shapes) {
      expect(await publicClient.readContract({ ...shape, ...call })).toStrictEqual(expected);
    }
  });

  test('a revert decodes from the ABI and explains like the artifact, in both modes', async () => {
    const script = await load();
    const call = { functionName: 'tokenMeta', args: [token, EMPTY_HOLDER] } as const;
    for (const shape of [script.toViem(), script.toViem({ mode: 'stateOverride' })]) {
      const error: unknown = await publicClient.readContract({ ...shape, ...call }).then(
        () => expect.unreachable('expected the call to revert'),
        (reason: unknown) => reason,
      );
      const decoded = decodeScriptError(script, error);
      expect(decoded).toMatchObject({ name: 'NoBalance', args: { holder: EMPTY_HOLDER } });
      if (decoded === undefined) continue;
      const explained = await script.explainRevert(decoded.raw);
      expect(explained).toStrictEqual(compiled.explainRevert(decoded.raw));
      expect(explained.kind).toBe('script-error');
      expect(explained.errorArgs).toEqual({ holder: EMPTY_HOLDER });
    }
  });
});
