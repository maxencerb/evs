/**
 * Differential suite — `bitAnd` / `bitOr` / `bitXor` / `bitNot` on `intN`.
 *
 * For int8, int24, int64, int128 and int256 and every ordered pair of the boundary operands
 * (negative ones included), four answers must be one: the interpreter and the compiled bytecode
 * on the harness EVM (default output and its `optimize: true` twin, via `expectAgreement`), the
 * constant the recorder folds the same operation to over literals, and JavaScript's own
 * two's-complement operators. `test/integration/signed-bitwise.test.ts` runs the bytecode on
 * anvil.
 */

import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement } from '../../test/harness/differential.js';
import {
  encodeSignedBitwise,
  foldedSignedBitwise,
  operandPairs,
  runtimeSignedBitwise,
  SIGNED_WIDTHS,
  signedBitwiseReference,
  signedOperands,
} from '../../test/harness/signed-bitwise.js';
import { interpret, type MockChain } from '../ir/interp.js';
import { walkStmts } from '../ir/nodes.js';

const NO_CHAIN: MockChain = {
  staticcall: () => {
    throw new Error('the bitwise scripts record no sub-calls');
  },
};

describe('bitwise operators on intN: interpreter, bytecode, constant folding, reference', () => {
  test.each(SIGNED_WIDTHS)('int%i', async (bits) => {
    const pairs = operandPairs(signedOperands(bits, { dense: true }));
    const expected = pairs.map(([a, b]) => ({
      kind: 'return',
      data: encodeSignedBitwise(signedBitwiseReference(bits, a, b)),
    }));

    // the interpreter and both compiled outputs agree, on the reference
    const outcomes = await expectAgreement(runtimeSignedBitwise(bits), pairs);
    expect(outcomes).toEqual(expected);

    // the recorder folds the same operations on literals to the same words
    for (const [index, [a, b]] of pairs.entries()) {
      const { ir } = foldedSignedBitwise(bits, a, b);
      const operations: string[] = [];
      walkStmts(ir.body, (stmt) => {
        if (stmt.k === 'bin' || stmt.k === 'un') operations.push(stmt.op);
      });
      expect(operations, `int${bits} ${a}, ${b}: every operation folded`).toEqual([]);
      const folded = interpret(ir, [], NO_CHAIN).outcome;
      expect(
        { kind: folded.kind, data: folded.data },
        `int${bits} ${a}, ${b}: the folded constants`,
      ).toEqual(expected[index]);
    }
  });

  test('the corpus holds negative operands, and results that differ from the unsigned ones', () => {
    // -256 & 0x0ff0 on an int24: the sign-extended bits take part, the result is positive
    expect(signedBitwiseReference(24, -256n, 0x0ff0n)).toEqual({
      and: 0x0f00n,
      or: -16n,
      xor: -3856n,
      not: 255n,
    });
    for (const bits of SIGNED_WIDTHS) {
      const values = signedOperands(bits, { dense: true });
      expect(values.filter((v) => v < 0n).length).toBeGreaterThanOrEqual(5);
      expect(values).toContain(-(1n << BigInt(bits - 1)));
    }
  });
});
