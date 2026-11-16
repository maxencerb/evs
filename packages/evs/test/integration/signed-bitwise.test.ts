/**
 * `bitAnd` / `bitOr` / `bitXor` / `bitNot` on `intN`, on anvil.
 *
 * For int8, int24, int64, int128 and int256 and every ordered pair of the boundary operands
 * (negative ones included), a real `eth_call` of the compiled script, in both execution modes,
 * must return what the interpreter computes, what the recorder folds the same operation to
 * over literals, and what JavaScript's own two's-complement operators give. The unit twin
 * (`src/differential/signed-bitwise.test.ts`) runs a denser corpus on the in-process EVM.
 */

import { describe, expect, test } from 'vite-plus/test';

import { interpret, type MockChain } from '../../src/index.js';
import { publicClient } from '../harness/anvil.js';
import {
  foldedSignedBitwise,
  operandPairs,
  runtimeSignedBitwise,
  SIGNED_WIDTHS,
  signedBitwiseReference,
  signedOperands,
  type SignedBitwiseResults,
} from '../harness/signed-bitwise.js';

const NO_CHAIN: MockChain = {
  staticcall: () => {
    throw new Error('the bitwise scripts record no sub-calls');
  },
};

/** The decoded results as bigints: viem decodes an `intN` of 48 bits or less to a number. */
function asBigints(values: Record<string, unknown>): SignedBitwiseResults {
  const word = (key: string): bigint => {
    const v = values[key];
    if (typeof v !== 'bigint' && typeof v !== 'number') {
      throw new Error(`${key}: expected an integer, got ${typeof v}`);
    }
    return BigInt(v);
  };
  return { and: word('and'), or: word('or'), xor: word('xor'), not: word('not') };
}

describe('bitwise operators on intN: anvil vs interpreter, constant folding and reference', () => {
  test.each(SIGNED_WIDTHS)('int%i', async (bits) => {
    const script = runtimeSignedBitwise(bits);
    const compiled = script.compile();
    const modes = [compiled.toViem(), compiled.toViem({ mode: 'stateOverride' })] as const;
    const pairs = operandPairs(signedOperands(bits, { dense: false }));

    const call = async (pair: readonly [bigint, bigint]) =>
      Promise.all(
        modes.map(async (params) =>
          asBigints(
            await publicClient.readContract({
              ...params,
              functionName: script.name,
              // the widths are dynamic over the matrix: viem's `args` type is the representative's
              args: pair as never,
            }),
          ),
        ),
      );
    // bounded concurrency: one connection per in-flight request to this worker's anvil
    const onChain: Awaited<ReturnType<typeof call>>[] = [];
    for (let i = 0; i < pairs.length; i += 16) {
      onChain.push(...(await Promise.all(pairs.slice(i, i + 16).map(call))));
    }

    for (const [index, [a, b]] of pairs.entries()) {
      const label = `int${bits}: ${a}, ${b}`;
      const expected = signedBitwiseReference(bits, a, b);
      const [deployless, stateOverride] = onChain[index] ?? [];
      expect(deployless, `${label} (deployless)`).toEqual(expected);
      expect(stateOverride, `${label} (stateOverride)`).toEqual(expected);

      const interpreted = interpret(script, [a, b] as never, NO_CHAIN).outcome;
      expect(interpreted.kind, `${label}: the interpreter returns`).toBe('return');
      const folded = interpret(foldedSignedBitwise(bits, a, b), [], NO_CHAIN).outcome;
      expect(folded.kind, `${label}: the folded script returns`).toBe('return');
      if (interpreted.kind !== 'return' || folded.kind !== 'return') continue;
      expect(asBigints(interpreted.values), `${label} (interpreter)`).toEqual(expected);
      expect(asBigints(folded.values), `${label} (folded)`).toEqual(expected);
    }
    // negative operands are in: half of the pairs have one on the left
    expect(pairs.filter(([a]) => a < 0n).length).toBeGreaterThanOrEqual(pairs.length / 2 - 8);
  });
});
