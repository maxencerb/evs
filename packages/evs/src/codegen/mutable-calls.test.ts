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
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { execRuntime } from '../../test/harness/evm.js';
import { returner, reverter, RUNTIME_SPIN, word } from '../../test/harness/fixtures.js';
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

/** A second target address for the "script continues after a contained failure" checks. */
const OTHER = '0x00000000000000000000000000000000000000bb' as const;

/** `GAS PUSH0 MSTORE PUSH1 32 PUSH0 RETURN` — a target that returns the gas it was handed. */
const RUNTIME_GASLEFT: Hex = '0x5a5f5260205ff3';

const FRAME_ABI = [
  {
    type: 'function',
    name: 'gasProbe',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'g', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'gasProbeView',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'g', type: 'uint256' }],
  },
] as const satisfies Abi;

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

// ---------------------------------------------------------------------------
// issue #36 — the simulate follow-ups: the `gas` cap bounds the INNER target CALL, and simulate
// sites compose (inside s.fn bodies, one feeding the next).
// ---------------------------------------------------------------------------

describe('issue #36 — `gas` caps the inner target call', () => {
  test('s.simulate / s.call / s.read with `gas`: the target receives at most the cap', async () => {
    const script = evscript({ name: 'probes', args: [t.address, t.uint256] }, (s, frame, cap) => {
      const sim = s.simulate({
        address: frame,
        abi: FRAME_ABI,
        functionName: 'gasProbe',
        gas: cap,
      });
      const call = s.call({ address: frame, abi: FRAME_ABI, functionName: 'gasProbe', gas: cap });
      const read = s.read({
        address: frame,
        abi: FRAME_ABI,
        functionName: 'gasProbeView',
        gas: cap,
      });
      const free = s.simulate({ address: frame, abi: FRAME_ABI, functionName: 'gasProbe' });
      return s.return({ sim, call, read, free });
    });
    const compiled = compile(script);
    const cap = 100_000n;
    const res = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({ abi: compiled.abi, functionName: 'probes', args: [TARGET, cap] }),
      { contracts: { [TARGET]: RUNTIME_GASLEFT } },
    );
    expect(res.success).toBe(true);
    const out = decodeFunctionResult({ abi: compiled.abi, functionName: 'probes', data: res.data });
    // every capped verb hands the target the cap (gasleft() on entry is the cap minus nothing —
    // the CALL's own cost is charged to the caller); the uncapped simulate forwards the lot.
    for (const g of [out.sim, out.call, out.read]) {
      expect(g).toBeLessThanOrEqual(cap);
      expect(g).toBeGreaterThan(cap - 1_000n);
    }
    expect(out.free).toBeGreaterThan(20_000_000n);
    // the reference interpreter carries the cap to the oracle and agrees on the returndata
    const seen: (bigint | undefined)[] = [];
    const oracle: MockChain = {
      staticcall: (req) => {
        seen.push(req.gas);
        return { success: true, data: word(req.gas ?? 0n) };
      },
      call: (req) => {
        seen.push(req.gas);
        return { success: true, data: word(req.gas ?? 0n) };
      },
    };
    const interp = interpret(script.ir, [TARGET, cap], oracle);
    expect(seen).toEqual([cap, cap, cap, undefined]);
    expect(interp.outcome.kind).toBe('return');
  });

  test('a gas-hungry simulated target is CONTAINED by the cap: try → success=false, script continues', async () => {
    const script = evscript({ name: 'contained', args: [t.address, t.address] }, (s, spin, ok) => {
      const r = s.trySimulate({
        address: spin,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1n],
        gas: 50_000n,
      });
      const after = s.read({
        address: ok,
        abi: DEPOSIT_ABI,
        functionName: 'balanceOf',
        args: [ok],
      });
      return s.return({ ok: r.success, shares: r.value, after });
    });
    const compiled = compile(script);
    const res = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({ abi: compiled.abi, functionName: 'contained', args: [TARGET, OTHER] }),
      { contracts: { [TARGET]: RUNTIME_SPIN, [OTHER]: returner(word(7n)) } },
    );
    expect(res.success).toBe(true);
    expect(
      decodeFunctionResult({ abi: compiled.abi, functionName: 'contained', data: res.data }),
    ).toEqual({ ok: false, shares: 0n, after: 7n });
    // the whole script stayed within a small multiple of the cap — the target could not burn the
    // eth_call's budget (30M here)
    expect(res.gasUsed).toBeLessThan(200_000n);
  });

  test('strict s.simulate on a gas-hungry target with a cap: the target OOG bubbles as an empty revert', async () => {
    const script = evscript({ name: 'strictSpin', args: [t.address] }, (s, spin) => {
      const shares = s.simulate({
        address: spin,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1n],
        gas: 50_000n,
      });
      return s.return({ shares });
    });
    const compiled = compile(script);
    const res = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({ abi: compiled.abi, functionName: 'strictSpin', args: [TARGET] }),
      { contracts: { [TARGET]: RUNTIME_SPIN } },
    );
    expect(res.success).toBe(false);
    expect(res.data).toBe('0x'); // the target's out-of-gas has no revert data — bubbled verbatim
    expect(res.gasUsed).toBeLessThan(200_000n);
  });

  test('without a cap the hop still survives a burning target (EIP-150 reserve), but at full price', async () => {
    const script = evscript({ name: 'uncapped', args: [t.address] }, (s, spin) => {
      const r = s.trySimulate({
        address: spin,
        abi: DEPOSIT_ABI,
        functionName: 'deposit',
        args: [1n],
      });
      return s.return({ ok: r.success });
    });
    const compiled = compile(script);
    const res = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({ abi: compiled.abi, functionName: 'uncapped', args: [TARGET] }),
      { contracts: { [TARGET]: RUNTIME_SPIN } },
    );
    // the trampoline keeps 1/64 of its gas after the inner CALL, enough for its MAGIC-tagged
    // REVERT — so the dry-run reports success=false instead of losing the magic …
    expect(res.success).toBe(true);
    expect(
      decodeFunctionResult({ abi: compiled.abi, functionName: 'uncapped', data: res.data }),
    ).toEqual({ ok: false });
    // … but the target burned (almost) the entire 30M budget — exactly what `gas` prevents
    expect(res.gasUsed).toBeGreaterThan(25_000_000n);
  });
});

describe('issue #36 — simulate composes (inside s.fn, chained)', () => {
  test('a simulate inside an s.fn body called twice, and a simulate fed by a simulate', async () => {
    const script = evscript(
      { name: 'nested', args: [t.address, t.uint256] },
      (s, vault, amount) => {
        const preview = s.fn('preview', [t.address, t.uint256], (v, a) =>
          s.simulate({ address: v, abi: DEPOSIT_ABI, functionName: 'deposit', args: [a] }),
        );
        const first = preview(vault, amount);
        const second = preview(vault, first); // the first dry-run's result feeds the next
        const third = s.simulate({
          address: vault,
          abi: DEPOSIT_ABI,
          functionName: 'deposit',
          args: [s.add(first, second)],
        });
        return s.return({ first, second, third });
      },
    );
    const compiled = compile(script);
    // the target doubles whatever amount it is handed (deposit(amount) → 2·amount), as a mock:
    // `PUSH1 4 CALLDATALOAD PUSH1 1 SHL PUSH0 MSTORE PUSH1 32 PUSH0 RETURN`
    const RUNTIME_DOUBLER: Hex = '0x60043560011b5f5260205ff3';
    const res = await execRuntime(
      compiled.runtimeBytecode,
      encodeFunctionData({ abi: compiled.abi, functionName: 'nested', args: [TARGET, 100n] }),
      { contracts: { [TARGET]: RUNTIME_DOUBLER } },
    );
    expect(res.success).toBe(true);
    expect(
      decodeFunctionResult({ abi: compiled.abi, functionName: 'nested', data: res.data }),
    ).toEqual({ first: 200n, second: 400n, third: 1200n });
    // interpreter agreement with the same doubling oracle
    const doubler: MockChain = {
      staticcall: ({ data }) => ({ success: true, data: word(BigInt(`0x${data.slice(10)}`) * 2n) }),
    };
    expect(interpret(script.ir, [TARGET, 100n], doubler).outcome).toEqual({
      kind: 'return',
      data: res.data,
      values: { first: 200n, second: 400n, third: 1200n },
    });
  });
});
