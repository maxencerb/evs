import {
  createPublicClient,
  http,
  type ContractFunctionArgs,
  type ContractFunctionReturnType,
} from 'viem';

/**
 * What viem infers from a compiled script: `args` from the script's arguments, the result from
 * its return record. A record has no member order at the type level, so nothing here may depend
 * on one: the same shapes come out under every type checker.
 */
import { evscript, t } from '@maxencerb/evs';
import { hydrate } from '@maxencerb/evs/runtime';

import { vaultAbi } from './abi.js';
import { expectType, type Same } from './assert.js';

type Address = `0x${string}`;
interface PositionValue {
  token: Address;
  amount: bigint;
}

const Position = t.struct({ token: t.address, amount: t.uint256 });

// return keys written in an order that is neither alphabetical nor reverse alphabetical
const report = evscript(
  { name: 'report', args: [t.address, t.address, t.array(Position)] },
  (s, vault, owner, extra) => {
    const held = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'positionsOf',
      args: [owner],
    });
    const first = s.read({
      address: vault,
      abi: vaultAbi,
      functionName: 'positionOf',
      args: [owner],
    });
    return s.return({
      zeta: held.length(),
      alpha: owner,
      mid: s.lit(t.bool, true),
      held,
      extra,
      first,
    });
  },
);

interface Report {
  zeta: bigint;
  alpha: Address;
  mid: boolean;
  held: readonly PositionValue[];
  extra: readonly PositionValue[];
  first: PositionValue;
}

const compiled = report.compile();

type Result = ContractFunctionReturnType<typeof compiled.abi, 'view', 'report'>;
expectType<Same<Result, Report>>();

type Args = ContractFunctionArgs<typeof compiled.abi, 'view', 'report'>;
expectType<Same<Args, readonly [Address, Address, readonly PositionValue[]]>>();

// the documented way to run it, in both modes
const client = createPublicClient({ transport: http('http://127.0.0.1:8545') });
const VAULT: Address = '0x0000000000000000000000000000000000000001';

export async function run(): Promise<bigint> {
  const deployless = await client.readContract({
    ...compiled.toViem(),
    functionName: 'report',
    args: [VAULT, VAULT, [{ token: VAULT, amount: 1n }]],
  });
  expectType<Same<typeof deployless, Report>>();

  const overridden = await client.readContract({
    ...compiled.toViem({ mode: 'stateOverride' }),
    functionName: 'report',
    args: [VAULT, VAULT, []],
  });
  expectType<Same<typeof overridden, Report>>();

  // a precompiled script and its hydrated copy carry the same ABI
  const precompiled = compiled.toPrecompiled();
  const hydrated = hydrate(precompiled.toJSON());
  const fromHydrated = await client.readContract({
    ...hydrated.toViem(),
    functionName: 'report',
    args: [VAULT, VAULT, []],
  });
  expectType<Same<typeof fromHydrated, Report>>();

  await client.readContract({
    ...compiled.toViem(),
    functionName: 'report',
    // @ts-expect-error `amount` is a bigint
    args: [VAULT, VAULT, [{ token: VAULT, amount: 1 }]],
  });

  return deployless.zeta + overridden.zeta + fromHydrated.zeta;
}

// a wide record keeps its keys and stays cheap to check
const wide = evscript({ name: 'wide', args: [t.uint256] }, (s, x) =>
  s.return({
    k00: x,
    k01: x,
    k02: x,
    k03: x,
    k04: x,
    k05: x,
    k06: x,
    k07: x,
    k08: x,
    k09: x,
    k10: x,
    k11: x,
    k12: x,
    k13: x,
    k14: x,
    k15: x,
    k16: x,
    k17: x,
    k18: x,
    k19: x,
    k20: x,
    k21: x,
    k22: x,
    k23: x,
    k24: x,
    k25: x,
    k26: x,
    k27: x,
    k28: x,
    k29: x,
    k30: x,
    k31: x,
    k32: x,
    k33: x,
    k34: x,
    k35: x,
    k36: x,
    k37: x,
    k38: x,
    k39: x,
    k40: x,
    k41: x,
    k42: x,
    k43: x,
    k44: x,
    k45: x,
    k46: x,
    k47: x,
    k48: x,
    k49: x,
  }),
);
const wideCompiled = wide.compile();
type Wide = ContractFunctionReturnType<typeof wideCompiled.abi, 'view', 'wide'>;
expectType<Same<Wide['k00'], bigint>>();
expectType<Same<Wide['k49'], bigint>>();
expectType<Same<keyof Wide extends `k${string}` ? true : false, true>>();
