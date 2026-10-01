/**
 * Dead revert guards on a real node: a checked `sub` whose result nothing reads is dropped by
 * the dead-code elimination pass `compile()` runs, so the `eth_call` returns in both execution
 * modes even when the subtraction would underflow — and `interpret(script.ir)`, which runs the
 * same pass, returns the same value. Only `interpret(…, { dce: false })` (the recorded IR)
 * panics. The in-process slice for every guard kind: `src/differential/dead-revert-guards.test.ts`.
 */

import { describe, expect, test } from 'vite-plus/test';

import { evscript, interpret, t, type MockChain } from '../../src/index.js';
import { publicClient } from '../harness/anvil.js';

const deadSub = evscript({ name: 'deadSub', args: [t.uint256, t.uint256] }, (s, a, b) => {
  a.sub(b); // unused: underflows for a < b, but nothing reads it
  return s.return({ a });
});
const compiled = deadSub.compile();

const noCalls: MockChain = { staticcall: () => ({ success: false, data: '0x' }) };

describe('dead revert guards on anvil', () => {
  test('an unused underflowing sub returns in both modes, and interpret() agrees', async () => {
    const args = [1n, 2n] as const;
    for (const viemParams of [compiled.toViem(), compiled.toViem({ mode: 'stateOverride' })]) {
      const out = await publicClient.readContract({ ...viemParams, functionName: 'deadSub', args });
      expect(out).toStrictEqual({ a: 1n });
    }
    expect(interpret(deadSub.ir, args, noCalls).outcome).toMatchObject({
      kind: 'return',
      values: { a: 1n },
    });
    expect(interpret(deadSub.ir, args, noCalls, { dce: false }).outcome.kind).toBe('revert');
  });
});
