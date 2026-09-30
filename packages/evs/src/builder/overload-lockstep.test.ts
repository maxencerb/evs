/* oxlint-disable typescript/no-unsafe-type-assertion --
 * the `Loose` cast deliberately defeats the type surface: the recorder must reach each case's
 * outcome on its own (the type-level side is asserted by overload-lockstep.test-d.ts). */
/**
 * Overload-resolution lockstep, recorder side: for every (overload set, args) case of the shared
 * matrix (test/harness/overload-matrix.ts), recording `s.read({ abi, functionName: 'f', args })`
 * reaches the case's `expect` — the recorded overload's signature, an `ABI_SHAPE` ambiguity, or a
 * `TYPE_MISMATCH` no-match. `overload-lockstep.test-d.ts` asserts the same `expect` on the
 * type-level resolver, so the two agree case by case.
 */
import { describe, expect, test } from 'vite-plus/test';

import { overloadCases } from '../../test/harness/overload-matrix.js';
import { EvsTypeError } from '../core/errors.js';
import { functionSignature } from '../core/signature.js';
import { t } from '../core/types.js';
import { walkStmts } from '../ir/nodes.js';
import { evscript } from './script.js';

type Loose = (p: unknown) => unknown;

/** Records case `k` in a throwaway script and returns the recorder's outcome. */
function runtimeOutcome(k: number): string {
  let outcome = '';
  try {
    const script = evscript({ name: 'lockstep', args: [t.address, t.uint256] }, (s, target, x) => {
      const c = overloadCases(s, x)[k];
      if (c === undefined) throw new Error(`no case ${k}`);
      (s.read as Loose)({ address: target, abi: c.abi, functionName: 'f', args: c.args });
      return s.return({ ok: s.lit(t.bool, true) });
    });
    walkStmts(script.ir.body, (st) => {
      if (st.k === 'call') outcome = functionSignature({ ...st.fnAbi });
    });
  } catch (e) {
    if (!(e instanceof EvsTypeError)) throw e;
    if (e.code === 'ABI_SHAPE' && /is ambiguous/.test(e.message)) return 'ambiguous';
    if (e.code === 'TYPE_MISMATCH' && /match none of the overloads/.test(e.message)) return 'none';
    throw e;
  }
  return outcome;
}

// the case list itself (names + expectations) is handle-free, so one dry recording yields it
const cases: { name: string; expect: string }[] = [];
evscript({ name: 'list', args: [t.address, t.uint256] }, (s, _target, x) => {
  for (const c of overloadCases(s, x)) cases.push({ name: c.name, expect: c.expect });
  return s.return({ ok: s.lit(t.bool, true) });
});

describe('the recorder reaches every case of the matrix', () => {
  test.each(cases.map((c, i) => [c.name, c.expect, i] as const))('%s → %s', (_n, want, i) => {
    expect(runtimeOutcome(i)).toBe(want);
  });
});

describe('the recorded overload carries its own output type', () => {
  test('finding 6: a uint256 MutArray records f(uint256[]) returning uint256', () => {
    const i = cases.findIndex((c) => c.name === 'uint256 MutArray vs S[] + uint256[]');
    let outType: unknown;
    evscript({ name: 'out', args: [t.address, t.uint256] }, (s, target, x) => {
      const c = overloadCases(s, x)[i];
      const r = (s.read as Loose)({
        address: target,
        abi: c?.abi,
        functionName: 'f',
        args: c?.args,
      });
      outType = (r as { type: unknown }).type;
      return s.return({ ok: s.lit(t.bool, true) });
    });
    expect(outType).toBe('uint256');
  });

  test('the fixed-length check also rejects a lone wrong-length T[N] literal loudly', () => {
    expect(() =>
      evscript({ name: 'len', args: [t.address] }, (s, target) => {
        (s.read as Loose)({
          address: target,
          abi: [
            {
              type: 'function',
              name: 'g',
              stateMutability: 'view',
              inputs: [{ name: 'x', type: 'uint256[2]' }],
              outputs: [],
            },
          ],
          functionName: 'g',
          args: [[1n, 2n, 3n]],
        });
        return s.return({ ok: s.lit(t.bool, true) });
      }),
    ).toThrow(/must have exactly 2 element\(s\), got 3/);
  });
});
