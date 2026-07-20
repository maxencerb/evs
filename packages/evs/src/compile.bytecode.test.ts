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
 */
import type { Abi } from 'abitype';
import { describe, expect, test } from 'vitest';

import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { t } from './core/types.js';

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

describe('runtime bytecode is byte-stable', () => {
  test('arithmetic + select + literals (no calls)', () => {
    const script = evscript({ name: 'math', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const sum = s.add(a, b);
      const bigger = s.select(s.gt(a, b), a, b);
      const capped = s.select(s.gt(sum, s.lit(t.uint256, 1000n)), s.lit(t.uint256, 1000n), sum);
      return s.return({ sum, bigger, capped });
    });
    expect(compile(script).runtimeBytecode).toMatchSnapshot();
  });

  test('reads: string output, arg + gas cap, tuple-index output, tryRead + select', () => {
    const script = evscript({ name: 'reads', args: [t.address, t.address] }, (s, pool, user) => {
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
    });
    expect(compile(script).runtimeBytecode).toMatchSnapshot();
  });

  test('struct: true read + tryRead (tuple output through the memory decoders)', () => {
    const script = evscript({ name: 'structs', args: [t.address] }, (s, pool) => {
      const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
      const r = s.tryRead({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
      return s.return({ price: slot0.sqrtPriceX96.get(), ok: r.success, tick: r.value.tick.get() });
    });
    expect(compile(script).runtimeBytecode).toMatchSnapshot();
  });

  test('mutable verbs: call / tryCall / simulate / trySimulate', () => {
    const script = evscript({ name: 'writes', args: [t.address, t.address] }, (s, token, to) => {
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
    });
    expect(compile(script).runtimeBytecode).toMatchSnapshot();
  });

  test('array construction + loop-free mutation', () => {
    const script = evscript({ name: 'arr', args: [t.uint256] }, (s, n) => {
      const out = s.newArray(t.uint256, n);
      out.set(0n, 42n);
      return s.return({ all: out });
    });
    expect(compile(script).runtimeBytecode).toMatchSnapshot();
  });

  test('paris target (pre-PUSH0 / @memcpy fork)', () => {
    const script = evscript({ name: 'paris', args: [t.address] }, (s, pool) => {
      const symbol = s.read({ address: pool, abi: erc20Abi, functionName: 'symbol' });
      return s.return({ symbol });
    });
    expect(compile(script, { evmVersion: 'paris' }).runtimeBytecode).toMatchSnapshot();
  });
});
