/**
 * Differential suite — a struct out of `Cell.get()`, `s.select()` and `s.lit()`.
 *
 * Each of them hands back a `Tuple` handle for a struct: the script keeps a struct in a cell,
 * picks one of two with `s.select` (over the handles and over their memrefs), builds one with
 * `s.lit`, selects a selected struct again and reads a member of each. The interpreter and both
 * compiled outputs on the harness EVM must agree (`expectAgreement`), on a host-side reference.
 * `test/integration/struct-values.test.ts` runs the bytecode on anvil.
 */

import { getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement } from '../../test/harness/differential.js';
import {
  STRUCT_VALUES_INPUTS,
  structValuesReference,
  structValuesScript,
} from '../../test/harness/struct-values.js';
import { interpret, type MockChain } from '../ir/interp.js';

const NO_CHAIN: MockChain = {
  staticcall: () => {
    throw new Error('the struct-values script records no sub-calls');
  },
};

describe('struct values out of Cell.get, s.select and s.lit', () => {
  test('interpreter and bytecode agree, on the reference', async () => {
    const outcomes = await expectAgreement(structValuesScript, STRUCT_VALUES_INPUTS);
    expect(outcomes.every((o) => o.kind === 'return')).toBe(true);
    for (const [first, a, b] of STRUCT_VALUES_INPUTS) {
      const { outcome } = interpret(structValuesScript, [first, a, b], NO_CHAIN);
      expect(outcome.kind).toBe('return');
      if (outcome.kind !== 'return') continue;
      const expected = structValuesReference(first, a, b);
      expect(outcome.values).toEqual({
        ...expected,
        cellOwner: getAddress(expected.cellOwner),
        pickedExprOwner: getAddress(expected.pickedExprOwner),
        kept: { ...expected.kept, owner: getAddress(expected.kept.owner) },
      });
    }
  });

  test('no statement is recorded for a handle: the IR is the one the memrefs record', () => {
    // a Tuple handle is a view of the same value: what `.expr()` gives records the same select
    const kinds = structValuesScript.ir.body.map((stmt) => stmt.k);
    expect(kinds.filter((k) => k === 'select')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'cellget')).toHaveLength(2);
  });
});
