/**
 * Type tests — the precompiled script keeps what the artifact's types give: the literal ABI,
 * `toViem()` overloads identical to `CompiledEvsScript`'s (so every shape spreads into viem's
 * `readContract` with the same inference), and error decoding typed from the ABI. `hydrate`
 * types its result from the data it is given.
 */

import type { Abi, Address, PublicClient } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { namedArg, t, type Hex } from './core/types.js';
import type { RevertExplanation } from './explain.js';
import { hydrate } from './hydrate.js';
import {
  isPrecompiledScript,
  type PrecompiledScript,
  type PrecompiledScriptData,
  type PrecompiledScriptDebug,
} from './precompiled.js';
import { decodeScriptError, matchScriptError, type ToViem, type ToViemMode } from './viem.js';

const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const NoBalance = t.error('NoBalance', [namedArg('balance', t.uint256)]);
const NotOwner = t.error('NotOwner');

const position = evscript(
  { name: 'position', args: [t.address, t.address], errors: [NoBalance, NotOwner] },
  (s, token, user) => {
    const symbol = s.read({ address: token, abi: erc20Abi, functionName: 'symbol' });
    const balance = s.read({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [user],
    });
    s.if(balance.eq(0n), () => {
      s.throw(NoBalance, { balance });
    });
    return s.return({ symbol, balance });
  },
);
const compiled = compile(position);
const precompiled = compiled.toPrecompiled();

declare const client: PublicClient;
declare const token: Address;
declare const user: Address;
declare const mode: ToViemMode;
declare const debug: PrecompiledScriptDebug;
declare const wideData: PrecompiledScriptData;

type ExpectedOut = { symbol: string; balance: bigint };

test('toPrecompiled() keeps the literal ABI and narrows the artifact', () => {
  expectTypeOf(precompiled).toEqualTypeOf<PrecompiledScript<typeof compiled.abi>>();
  expectTypeOf(precompiled.abi).toEqualTypeOf(compiled.abi);
  expectTypeOf(precompiled.abi[0]['name']).toEqualTypeOf<'position'>();
  expectTypeOf(precompiled.runtimeBytecode).toEqualTypeOf<Hex>();
  expectTypeOf(precompiled.initBytecode).toEqualTypeOf<Hex>();
  expectTypeOf(precompiled.evmVersion).toEqualTypeOf<'paris' | 'shanghai' | 'cancun'>();
  expectTypeOf(precompiled.toJSON()).toEqualTypeOf<PrecompiledScriptData<typeof compiled.abi>>();
  // the compiler's side of the artifact is gone
  expectTypeOf(precompiled).not.toHaveProperty('ir');
  expectTypeOf(precompiled).not.toHaveProperty('sourceMap');
  expectTypeOf(precompiled).not.toHaveProperty('disassemble');
});

test('toViem is the artifact’s own member type: every overload returns the same type', () => {
  expectTypeOf(precompiled.toViem).toEqualTypeOf(compiled.toViem);
  expectTypeOf(precompiled.toViem).toEqualTypeOf<ToViem<typeof compiled.abi>>();

  expectTypeOf(precompiled.toViem()).toEqualTypeOf(compiled.toViem());
  expectTypeOf(precompiled.toViem({ mode: 'deployless' })).toEqualTypeOf(
    compiled.toViem({ mode: 'deployless' }),
  );
  expectTypeOf(precompiled.toViem({ mode: 'stateOverride' })).toEqualTypeOf(
    compiled.toViem({ mode: 'stateOverride' }),
  );
  expectTypeOf(precompiled.toViem({ mode: 'stateOverride', address: token })).toEqualTypeOf(
    compiled.toViem({ mode: 'stateOverride', address: token }),
  );
  expectTypeOf(precompiled.toViem({ mode: 'stateOverride', sender: user })).toEqualTypeOf(
    compiled.toViem({ mode: 'stateOverride', sender: user }),
  );
  expectTypeOf(precompiled.toViem({ mode })).toEqualTypeOf(compiled.toViem({ mode }));
  expectTypeOf(precompiled.toViem({ mode, address: token, sender: user })).toEqualTypeOf(
    compiled.toViem({ mode, address: token, sender: user }),
  );

  // the shapes themselves, not only their agreement
  expectTypeOf(precompiled.toViem()).toEqualTypeOf<{ abi: typeof compiled.abi; code: Hex }>();
  expectTypeOf(precompiled.toViem({ mode: 'stateOverride' })).not.toHaveProperty('account');
  expectTypeOf(
    precompiled.toViem({ mode: 'stateOverride', sender: user }).account,
  ).toEqualTypeOf<Address>();
});

test('a literal mode keeps its own overload on a precompiled script too', () => {
  expectTypeOf(precompiled.toViem({ mode: 'deployless' })).not.toHaveProperty('address');
  // @ts-expect-error — `address` belongs to the stateOverride shape
  void precompiled.toViem({ mode: 'deployless', address: token });
  // @ts-expect-error — not a mode
  void precompiled.toViem({ mode: 'override' });
  // @ts-expect-error — a literal object with no `mode` key has no overload (call toViem())
  void precompiled.toViem({});
});

test('toViem() spreads into readContract with the artifact’s inference', async () => {
  const deployless = await client.readContract({
    ...precompiled.toViem(),
    functionName: 'position',
    args: [token, user],
  });
  expectTypeOf(deployless).toEqualTypeOf<ExpectedOut>();
  expectTypeOf(deployless).toEqualTypeOf(
    await client.readContract({
      ...compiled.toViem(),
      functionName: 'position',
      args: [token, user],
    }),
  );

  const stateOverride = await client.readContract({
    ...precompiled.toViem({ mode: 'stateOverride', sender: user }),
    functionName: 'position',
    args: [token, user],
    blockNumber: 22_000_000n,
  });
  expectTypeOf(stateOverride).toEqualTypeOf<ExpectedOut>();

  const runTime = await client.readContract({
    ...precompiled.toViem({ mode }),
    functionName: 'position',
    args: [token, user],
  });
  expectTypeOf(runTime).toEqualTypeOf<ExpectedOut>();

  await client.readContract({
    ...precompiled.toViem(),
    // @ts-expect-error — functionName is inferred from the ABI
    functionName: 'positions',
    args: [token, user],
  });
  await client.readContract({
    ...precompiled.toViem(),
    functionName: 'position',
    // @ts-expect-error — args are inferred from the ABI: (address, address)
    args: [token, 1n],
  });
});

test('decodeScriptError / matchScriptError are typed from the precompiled script’s ABI', () => {
  const decoded = decodeScriptError(precompiled, undefined as unknown);
  expectTypeOf(decoded).toEqualTypeOf(decodeScriptError(compiled, undefined as unknown));
  if (decoded !== undefined && decoded.name === 'NoBalance') {
    expectTypeOf(decoded.args).toEqualTypeOf<{ readonly balance: bigint }>();
  }
  if (decoded !== undefined && decoded.name === 'EvsDecodeError') {
    expectTypeOf(decoded.args).toEqualTypeOf<{ readonly site: bigint }>();
  }

  const out = matchScriptError(precompiled, undefined as unknown, {
    NoBalance: ({ balance }) => balance,
    NotOwner: () => 'owner' as const,
    _: () => null,
  });
  expectTypeOf<bigint | 'owner' | null>(out);
  // @ts-expect-error — missing the NotOwner handler (exhaustiveness over declared errors)
  matchScriptError(precompiled, undefined as unknown, { NoBalance: () => 0, _: () => 0 });
});

test('explainRevert() and debug() are asynchronous on a precompiled script', () => {
  expectTypeOf(precompiled.explainRevert('0x')).toEqualTypeOf<Promise<RevertExplanation>>();
  expectTypeOf(precompiled.explainRevert('0x')).resolves.toEqualTypeOf(
    compiled.explainRevert('0x'),
  );
  expectTypeOf(precompiled.debug()).toEqualTypeOf<Promise<PrecompiledScriptDebug>>();
  expectTypeOf<PrecompiledScriptDebug['ir']>().toEqualTypeOf(compiled.ir);
  expectTypeOf<PrecompiledScriptDebug['sites']>().toEqualTypeOf(compiled.sourceMap.sites);
});

test('hydrate types the script from its data: an `as const` ABI stays literal', async () => {
  const data = {
    version: 1,
    abi: [
      {
        type: 'function',
        name: 'price',
        stateMutability: 'view',
        inputs: [{ name: 'asset', type: 'address' }],
        outputs: [
          {
            name: 'result',
            type: 'tuple',
            components: [{ name: 'price', type: 'uint256' }],
          },
        ],
      },
      { type: 'error', name: 'Stale', inputs: [{ name: 'age', type: 'uint256' }] },
    ],
    runtimeBytecode: '0x00',
    evmVersion: 'cancun',
  } as const;
  const script = hydrate(data);
  expectTypeOf(script).toEqualTypeOf<PrecompiledScript<(typeof data)['abi']>>();
  expectTypeOf(script.abi[0]['name']).toEqualTypeOf<'price'>();
  expectTypeOf(script.toJSON().abi).toEqualTypeOf(data.abi);

  const out = await client.readContract({
    ...script.toViem(),
    functionName: 'price',
    args: [token],
  });
  expectTypeOf(out).toEqualTypeOf<{ price: bigint }>();

  const decoded = decodeScriptError(script, undefined as unknown);
  if (decoded !== undefined && decoded.name === 'Stale') {
    expectTypeOf(decoded.args).toEqualTypeOf<{ readonly age: bigint }>();
  }

  // the data of a precompiled script hydrates back to the script's own type
  expectTypeOf(hydrate(precompiled.toJSON())).toEqualTypeOf(precompiled);
  // widened data (parsed JSON) gives the wide default
  expectTypeOf(hydrate(wideData)).toEqualTypeOf<PrecompiledScript>();
});

test('the debug loader takes the data or a module namespace around it', () => {
  const data = precompiled.toJSON();
  expectTypeOf(hydrate(data, { debug: () => Promise.resolve(debug) })).toEqualTypeOf(precompiled);
  void hydrate(data, { debug: () => Promise.resolve({ default: debug }) });
  void hydrate(data, { debug: () => precompiled.debug() });
  // @ts-expect-error — the loader is asynchronous
  void hydrate(data, { debug: () => debug });
  // @ts-expect-error — not debug data
  void hydrate(data, { debug: () => Promise.resolve(data) });
});

test('isPrecompiledScript narrows an unknown value, and every script is one', () => {
  const value: unknown = precompiled;
  if (isPrecompiledScript(value)) {
    expectTypeOf(value).toEqualTypeOf<PrecompiledScript>();
    expectTypeOf(value.abi).toEqualTypeOf<readonly unknown[]>();
  }
  expectTypeOf(precompiled).toMatchTypeOf<PrecompiledScript>();
  expectTypeOf(precompiled.toJSON()).toMatchTypeOf<PrecompiledScriptData>();
});
