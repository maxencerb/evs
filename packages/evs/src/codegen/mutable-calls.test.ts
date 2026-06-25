/**
 * Issue #1 — end-to-end codegen for the mutable-call surface (`s.call` = CALL; `s.simulate` =
 * self-call trampoline + rollback). Each script is compiled and executed on the in-process EVM
 * harness against a `returner`/`reverter` mock target, and the returndata is cross-checked against
 * the reference interpreter (the differential oracle). The *rollback* itself is invisible to the
 * stateless oracle and the single-shot harness — it is pinned in the anvil integration tier — but
 * the trampoline's returndata path (magic recognition, inner-success branch, decode) is exercised
 * here byte-for-byte.
 */

import type { Abi } from 'abitype';
import { encodeAbiParameters, encodeFunctionData } from 'viem';
import { describe, expect, test } from 'vitest';

import { execRuntime } from '../../test/harness/evm.js';
import { returner, reverter, word } from '../../test/harness/fixtures.js';
import { t } from '../builder/args.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import type { Hex } from '../core/types.js';
import { interpret, type MockChain } from '../ir/interp.js';

const TARGET = '0x00000000000000000000000000000000000000aa' as const;

const DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const SHARES = 4242n;
const SHARES_RET: Hex = word(SHARES);

/** A MockChain whose mutable-subcall oracle returns `SHARES`-encoded data (success). */
function chainReturning(data: Hex): MockChain {
  return {
    staticcall: () => ({ success: true, data }),
    call: () => ({ success: true, data }),
  };
}

describe('issue #1 — s.call (CALL opcode)', () => {
  test('a nonpayable deposit() returns its value through a real CALL frame', async () => {
    const script = evscript({ name: 'depositCall', args: [t.address] }, (s, vault) => {
      const shares = s.call({
        address: vault,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1000n],
      });
      return s.return({ shares });
    });
    const compiled = compile(script);

    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'depositCall',
      args: [TARGET],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata, {
      contracts: { [TARGET]: returner(SHARES_RET) },
    });
    expect(res.success).toBe(true);

    const expected = encodeAbiParameters(
      [{ type: 'tuple', components: [{ name: 'shares', type: 'uint256' }] }],
      [{ shares: SHARES }],
    );
    expect(res.data).toBe(expected);

    // differential oracle: interpret with a CALL oracle returning the same returndata
    const oracle = interpret(script.ir, [TARGET], chainReturning(SHARES_RET));
    expect(oracle.outcome).toMatchObject({ kind: 'return', data: expected });
  });

  test('s.tryCall on a reverting quoter yields success=false and a zero value', async () => {
    const script = evscript({ name: 'quote', args: [t.address] }, (s, quoter) => {
      const r = s.tryCall({
        address: quoter,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1n],
      });
      return s.return({ ok: r.success, shares: r.value });
    });
    const compiled = compile(script);
    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'quote',
      args: [TARGET],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata, {
      contracts: { [TARGET]: reverter('0xdeadbeef') },
    });
    expect(res.success).toBe(true);
    const expected = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'ok', type: 'bool' },
            { name: 'shares', type: 'uint256' },
          ],
        },
      ],
      [{ ok: false, shares: 0n }],
    );
    expect(res.data).toBe(expected);
  });
});

const SWAP_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'path', type: 'bytes' }],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'note', type: 'string' },
    ],
  },
] as const satisfies Abi;

const SWAP_RET: Hex = encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'string' }],
  [777n, 'filled'],
);
const SWAP_EXPECTED: Hex = encodeAbiParameters(
  [
    {
      type: 'tuple',
      components: [
        { name: 'amountOut', type: 'uint256' },
        { name: 'note', type: 'string' },
      ],
    },
  ],
  [{ amountOut: 777n, note: 'filled' }],
);

describe.each(['cancun', 'paris'] as const)(
  'issue #1 — dynamic args + outputs through the wrapper (%s)',
  (evmVersion) => {
    test('s.call: dynamic bytes arg + (uint256, string) outputs', async () => {
      const script = evscript({ name: 'swapCall', args: [t.address] }, (s, router) => {
        const r = s.call({
          address: router,
          abi: SWAP_ABI,
          functionName: 'swap',
          args: ['0xc0ffee'],
          struct: true,
        });
        return s.return({ amountOut: r.amountOut.get(), note: r.note.get() });
      });
      const compiled = compile(script, { evmVersion });
      const calldata = encodeFunctionData({
        abi: compiled.abi,
        functionName: 'swapCall',
        args: [TARGET],
      });
      const res = await execRuntime(compiled.runtimeBytecode, calldata, {
        contracts: { [TARGET]: returner(SWAP_RET) },
      });
      expect(res.success).toBe(true);
      expect(res.data).toBe(SWAP_EXPECTED);
    });

    test('s.simulate: dynamic bytes arg (wrapper relocation) + (uint256, string) outputs', async () => {
      const script = evscript({ name: 'swapSim', args: [t.address] }, (s, router) => {
        const r = s.simulate({
          address: router,
          abi: SWAP_ABI,
          functionName: 'swap',
          args: ['0xc0ffeebabe'],
          struct: true,
        });
        return s.return({ amountOut: r.amountOut.get(), note: r.note.get() });
      });
      const compiled = compile(script, { evmVersion });
      const calldata = encodeFunctionData({
        abi: compiled.abi,
        functionName: 'swapSim',
        args: [TARGET],
      });
      const res = await execRuntime(compiled.runtimeBytecode, calldata, {
        contracts: { [TARGET]: returner(SWAP_RET) },
      });
      expect(res.success).toBe(true);
      expect(res.data).toBe(SWAP_EXPECTED);

      const oracle = interpret(script.ir, [TARGET], chainReturning(SWAP_RET));
      expect(oracle.outcome).toMatchObject({ kind: 'return', data: SWAP_EXPECTED });
    });
  },
);

describe('issue #1 — s.simulate (self-call trampoline + rollback)', () => {
  test('a simulated write returns its value (decoded through the trampoline)', async () => {
    const script = evscript({ name: 'simDeposit', args: [t.address] }, (s, vault) => {
      const shares = s.simulate({
        address: vault,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1000n],
      });
      return s.return({ shares });
    });
    const compiled = compile(script);

    // the bytecode carries the reserved trampoline entrypoint
    expect(compiled.runtimeBytecode.toLowerCase()).toContain('bbde5aa3');

    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'simDeposit',
      args: [TARGET],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata, {
      contracts: { [TARGET]: returner(SHARES_RET) },
    });
    expect(res.success).toBe(true);
    const expected = encodeAbiParameters(
      [{ type: 'tuple', components: [{ name: 'shares', type: 'uint256' }] }],
      [{ shares: SHARES }],
    );
    expect(res.data).toBe(expected);

    const oracle = interpret(script.ir, [TARGET], chainReturning(SHARES_RET));
    expect(oracle.outcome).toMatchObject({ kind: 'return', data: expected });
  });

  test('strict s.simulate bubbles the simulated target revert verbatim', async () => {
    const script = evscript({ name: 'simRevert', args: [t.address] }, (s, vault) => {
      const shares = s.simulate({
        address: vault,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1000n],
      });
      return s.return({ shares });
    });
    const compiled = compile(script);
    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'simRevert',
      args: [TARGET],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata, {
      contracts: { [TARGET]: reverter('0xdeadbeef') },
    });
    expect(res.success).toBe(false);
    expect(res.data).toBe('0xdeadbeef');
  });

  test('s.trySimulate on a reverting target → success=false, zero value', async () => {
    const script = evscript({ name: 'trySim', args: [t.address] }, (s, vault) => {
      const r = s.trySimulate({
        address: vault,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1000n],
      });
      return s.return({ ok: r.success, shares: r.value });
    });
    const compiled = compile(script);
    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'trySim',
      args: [TARGET],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata, {
      contracts: { [TARGET]: reverter('0xdeadbeef') },
    });
    expect(res.success).toBe(true);
    const expected = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'ok', type: 'bool' },
            { name: 'shares', type: 'uint256' },
          ],
        },
      ],
      [{ ok: false, shares: 0n }],
    );
    expect(res.data).toBe(expected);
  });
});
