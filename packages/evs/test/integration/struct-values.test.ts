/**
 * A struct out of `Cell.get()`, `s.select()` and `s.lit()`, on anvil.
 *
 * A real `eth_call` of the compiled script, in both execution modes, must return what the
 * interpreter computes and what the host-side reference gives: a struct kept in a cell, one of
 * two picked with `s.select`, one built with `s.lit`, each read through its `Tuple` handle. The
 * unit twin (`src/differential/struct-values.test.ts`) runs the same inputs on the in-process
 * EVM.
 */

import { getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { interpret, type MockChain } from '../../src/index.js';
import { publicClient } from '../harness/anvil.js';
import {
  STRUCT_VALUES_INPUTS,
  structValuesReference,
  structValuesScript,
} from '../harness/struct-values.js';

const NO_CHAIN: MockChain = {
  staticcall: () => {
    throw new Error('the struct-values script records no sub-calls');
  },
};

describe('struct values out of Cell.get, s.select and s.lit: anvil vs interpreter and reference', () => {
  test('both execution modes', async () => {
    const compiled = structValuesScript.compile();
    const modes = [
      ['deployless', compiled.toViem()],
      ['stateOverride', compiled.toViem({ mode: 'stateOverride' })],
    ] as const;
    for (const [first, a, b] of STRUCT_VALUES_INPUTS) {
      const label = `first=${first}, a.amount=${a.amount}, b.amount=${b.amount}`;
      const reference = structValuesReference(first, a, b);
      const expected = {
        ...reference,
        cellOwner: getAddress(reference.cellOwner),
        pickedExprOwner: getAddress(reference.pickedExprOwner),
        kept: { ...reference.kept, owner: getAddress(reference.kept.owner) },
      };
      for (const [mode, params] of modes) {
        const onChain = await publicClient.readContract({
          ...params,
          functionName: structValuesScript.name,
          args: [first, a, b],
        });
        expect(onChain, `${label} (${mode})`).toEqual(expected);
      }
      const { outcome } = interpret(structValuesScript, [first, a, b], NO_CHAIN);
      expect(outcome.kind, `${label}: the interpreter returns`).toBe('return');
      if (outcome.kind === 'return')
        expect(outcome.values, `${label} (interpreter)`).toEqual(expected);
    }
  });
});
