/**
 * Golden-bytecode regression tests: snapshot the compiled runtime bytecode of representative
 * scripts spanning the emitter paths — template + recursive calldata encode, word / string /
 * tuple / composite-array outputs, all six calling verbs (strict + try), gas caps, literal
 * and runtime args, and array construction.
 *
 * A snapshot change here means the emitted BYTES changed. That must always be a deliberate
 * codegen change (update the snapshot in the same PR and say why) — never a side effect of a
 * refactor. Execution semantics are covered by the interp/differential/integration tiers;
 * this tier pins byte-for-byte stability.
 *
 * Every case is snapshotted twice: the default output (the `optimize: false` bytes MUST stay
 * identical whatever the optimizer does) and its `optimize: true` twin (issue #39), which is
 * additionally asserted to never be larger.
 */
import type { Abi } from 'abitype';
import { describe, expect, test } from 'vite-plus/test';

import type { EvmVersion } from './asm/ops.js';
import { evscript } from './builder/script.js';
import { compile, type CompiledEvsScript } from './compile.js';
import { namedArg, t, type Hex } from './core/types.js';
import type { ScriptIr } from './ir/nodes.js';

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
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const poolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const satisfies Abi;

const TOKEN = '0xa000000000000000000000000000000000000001' as const;

interface Case {
  readonly name: string;
  readonly script: () => {
    readonly name: string;
    readonly ir: ScriptIr;
    readonly abi: readonly unknown[];
  };
  readonly evmVersion?: EvmVersion;
}

const BYTE_STABLE: readonly Case[] = [
  {
    name: 'arithmetic + select + literals (no calls)',
    script: () =>
      evscript({ name: 'math', args: [t.uint256, t.uint256] }, (s, a, b) => {
        const sum = s.add(a, b);
        const bigger = s.select(s.gt(a, b), a, b);
        const capped = s.select(s.gt(sum, s.lit(t.uint256, 1000n)), s.lit(t.uint256, 1000n), sum);
        return s.return({ sum, bigger, capped });
      }),
  },
  {
    name: 'reads: string output, arg + gas cap, tuple-index output, tryRead + select',
    script: () =>
      evscript({ name: 'reads', args: [t.address, t.address] }, (s, pool, user) => {
        const symbol = s.read({ address: pool, abi: erc20Abi, functionName: 'symbol' });
        const bal = s.read({
          address: pool,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [user],
          gas: 100_000n,
        });
        const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0' });
        const dec = s.tryRead({ address: TOKEN, abi: erc20Abi, functionName: 'decimals' });
        const decimals = s.select(dec.success, dec.value, s.lit(t.uint8, 18));
        return s.return({ symbol, bal, tick: slot0[1], decimals });
      }),
  },
  {
    name: 'struct: true read + tryRead (tuple output through the memory decoders)',
    script: () =>
      evscript({ name: 'structs', args: [t.address] }, (s, pool) => {
        const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
        const r = s.tryRead({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
        return s.return({
          price: slot0.sqrtPriceX96.get(),
          ok: r.success,
          tick: r.value.tick.get(),
        });
      }),
  },
  {
    name: 'mutable verbs: call / tryCall / simulate / trySimulate',
    script: () =>
      evscript({ name: 'writes', args: [t.address, t.address] }, (s, token, to) => {
        const sent = s.call({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 1000n],
        });
        const trySent = s.tryCall({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 1000n],
        });
        const simSent = s.simulate({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 2000n],
        });
        const trySim = s.trySimulate({
          address: token,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [to, 3000n],
        });
        return s.return({
          sent,
          okA: trySent.success,
          sentB: trySent.value,
          simSent,
          okC: trySim.success,
          sentD: trySim.value,
        });
      }),
  },
  {
    name: 'array construction + loop-free mutation',
    script: () =>
      evscript({ name: 'arr', args: [t.uint256] }, (s, n) => {
        const out = s.newArray(t.uint256, n);
        out.set(0n, 42n);
        return s.return({ all: out });
      }),
  },
  {
    name: 'paris target (pre-PUSH0 / @memcpy fork)',
    evmVersion: 'paris',
    script: () =>
      evscript({ name: 'paris', args: [t.address] }, (s, pool) => {
        const symbol = s.read({ address: pool, abi: erc20Abi, functionName: 'symbol' });
        return s.return({ symbol });
      }),
  },
];

const CUSTOM_ERRORS: readonly Case[] = [
  {
    name: 'throw: named args, zero-arg, and a string param (dynamic encode)',
    script: () => {
      const NoBalance = t.error('NoBalance', [namedArg('balance', t.uint256)]);
      const NotOwner = t.error('NotOwner');
      const Reason = t.error('Reason', [namedArg('note', t.string)]);
      return evscript(
        { name: 'guard', args: [t.uint256], errors: [NoBalance, NotOwner, Reason] },
        (s, x) => {
          s.if(x.lt(10n), () => {
            s.throw(NoBalance, { balance: x });
          });
          s.if(x.eq(999n), () => {
            s.throw(NotOwner);
          });
          s.if(x.eq(1000n), () => {
            s.throw(Reason, { note: s.lit(t.string, 'nope') });
          });
          return s.return({ x });
        },
      );
    },
  },
];

function bytesOf(c: Case, optimize: boolean): Hex {
  const options =
    c.evmVersion === undefined ? { optimize } : { optimize, evmVersion: c.evmVersion };
  // CompiledOf<s> is deferred on the structural script type — annotate like the differential suite
  const compiled: CompiledEvsScript = compile(c.script(), options);
  return compiled.runtimeBytecode;
}

describe('runtime bytecode is byte-stable', () => {
  for (const c of BYTE_STABLE) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table; titles are the snapshot keys
    test(c.name, () => {
      expect(bytesOf(c, false)).toMatchSnapshot();
    });
  }
});

describe('custom errors are byte-stable (issue #15)', () => {
  for (const c of CUSTOM_ERRORS) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table; titles are the snapshot keys
    test(c.name, () => {
      expect(bytesOf(c, false)).toMatchSnapshot();
    });
  }
});

describe('optimized twin (optimize: true) is byte-stable (issue #39)', () => {
  for (const c of [...BYTE_STABLE, ...CUSTOM_ERRORS]) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table; titles are the snapshot keys
    test(c.name, () => {
      const plain = bytesOf(c, false);
      const optimized = bytesOf(c, true);
      expect(optimized.length).toBeLessThanOrEqual(plain.length);
      expect(optimized).toMatchSnapshot();
    });
  }
});
