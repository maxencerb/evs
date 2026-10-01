/**
 * Differential suite — builder entry points that typecheck and used to fail at recording:
 * composite `s.let(type, init)` / `s.lit(type, value)`, `s.select` with a folded condition and a
 * composite dropped branch, and a script that catches a failed `s.fn` and carries on.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import { decodeFunctionResult, type Abi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement, EVM_VERSIONS, type AnyScript } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t } from '../core/types.js';

const ONE = '0x0000000000000000000000000000000000000001';
const ZERO = '0x0000000000000000000000000000000000000000';
const Pair = t.struct({ a: t.uint256, b: t.address });
const Duo = t.tuple(t.uint256, t.address);

/** Runs `args` through the agreement runner and decodes the single return outcome. */
async function agreedResult(
  script: AnyScript & { readonly abi: Abi },
  args: readonly unknown[],
  evmVersion: (typeof EVM_VERSIONS)[number],
): Promise<unknown> {
  const [o] = await expectAgreement(script, [args], {}, evmVersion);
  expect(o?.kind).toBe('return');
  return decodeFunctionResult({
    abi: script.abi,
    functionName: script.name,
    data: o?.data ?? '0x',
  });
}

describe.each(EVM_VERSIONS)('typed composite s.let / s.lit [%s]', (evmVersion) => {
  test('struct, positional tuple and tuple[] cells (Solidity: P memory v = P(1, ONE); if (c) v = …)', async () => {
    const script = evscript({ name: 'cells', args: [t.bool, t.uint256] }, (s, c, x) => {
      const lit = s.let(Pair, { a: 1n, b: ONE });
      const fromExpr = s.let(Pair, s.tuple(Pair, { a: x, b: ONE }).expr());
      const positional = s.let(Duo, [5n, ONE]);
      const list = s.let(t.array(Pair), []);
      s.if(c, () => {
        lit.set({ a: 2n, b: ZERO });
        fromExpr.set(s.tuple(Pair, { a: x.add(1n) }).expr());
        positional.set(s.tuple(Duo, [x]).expr());
        list.set([
          { a: 4n, b: ZERO },
          { a: 3n, b: ONE },
        ]);
      });
      return s.return({
        lit: lit.get(),
        fromExpr: fromExpr.get(),
        positional: positional.get(),
        list: list.get(),
      });
    });
    expect(await agreedResult(script, [false, 42n], evmVersion)).toEqual({
      lit: { a: 1n, b: ONE },
      fromExpr: { a: 42n, b: ONE },
      positional: [5n, ONE],
      list: [],
    });
    expect(await agreedResult(script, [true, 42n], evmVersion)).toEqual({
      lit: { a: 2n, b: ZERO },
      fromExpr: { a: 43n, b: ZERO },
      positional: [42n, ZERO],
      list: [
        { a: 4n, b: ZERO },
        { a: 3n, b: ONE },
      ],
    });
  });

  test('s.lit of a struct and of a tuple[]', async () => {
    const script = evscript({ name: 'lits', args: [] }, (s) =>
      s.return({
        p: s.lit(Pair, { a: 5n, b: ONE }),
        ps: s.lit(t.array(Pair), [
          { a: 7n, b: ZERO },
          { a: 2n, b: ONE },
        ]),
      }),
    );
    expect(await agreedResult(script, [], evmVersion)).toEqual({
      p: { a: 5n, b: ONE },
      ps: [
        { a: 7n, b: ZERO },
        { a: 2n, b: ONE },
      ],
    });
  });
});

describe.each(EVM_VERSIONS)('s.select with a folded condition [%s]', (evmVersion) => {
  // the dropped branches are the field-test shapes that used to throw when the condition was known
  // at recording: string[] / uint256[][] / tuple[] literals, a word array holding an Expr, a struct.
  const script = (cond: 'runtime' | 'host' | 'folded') =>
    evscript(
      { name: 'sel', args: [t.bool, t.array(t.string), t.uint256, t.array(Pair)] },
      (s, flag, names, x, items) => {
        const c = cond === 'runtime' ? flag : cond === 'host' ? true : s.lit(t.uint256, 3n).gt(2n);
        return s.return({
          names: s.select(c, names, ['a', 'b']),
          words: s.select(c, s.lit(t.array(t.uint256), [7n]), [x, 1n]),
          grid: s.select(s.not(c), [[1n], [2n, 3n]], s.lit(t.array(t.array(t.uint256)), [])),
          items: s.select(c, items, [{ a: 1n, b: ONE }]),
          item: s.select(c, s.tuple(Pair, { a: x }).expr(), { a: 1n, b: ONE }),
        });
      },
    );
  const args = [true, ['x', 'y'], 9n, [{ a: 4n, b: ONE }]] as const;
  const expected = {
    names: ['x', 'y'],
    words: [7n],
    grid: [],
    items: [{ a: 4n, b: ONE }],
    item: { a: 9n, b: ZERO },
  };

  test.each(['runtime', 'host', 'folded'] as const)(
    'a %s condition returns the chosen branch',
    async (cond) => {
      expect(await agreedResult(script(cond), args, evmVersion)).toEqual(expected);
    },
  );

  test('the dropped branch is dead code: no trace of it in the bytecode', () => {
    // the same script with the chosen branches written directly
    const direct = evscript(
      { name: 'sel', args: [t.bool, t.array(t.string), t.uint256, t.array(Pair)] },
      (s, _flag, names, x, items) => {
        return s.return({
          names,
          words: s.lit(t.array(t.uint256), [7n]),
          grid: s.lit(t.array(t.array(t.uint256)), []),
          items,
          item: s.tuple(Pair, { a: x }).expr(),
        });
      },
    );
    expect(compile(script('folded'), { evmVersion }).runtimeBytecode).toBe(
      compile(direct, { evmVersion }).runtimeBytecode,
    );
  });
});

describe.each(EVM_VERSIONS)('a caught s.fn recording error [%s]', (evmVersion) => {
  test('the failed definition leaves no fn behind; the fallback runs', async () => {
    const script = evscript({ name: 'fallback', args: [t.uint256] }, (s, x) => {
      let inc;
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the seeded recording error
        inc = s.fn('inc', [t.uint256], (a) => a.add(-1 as never));
      } catch {
        inc = s.fn('inc2', [t.uint256], (a) => a.add(1n));
      }
      return s.return({ y: inc(x) });
    });
    expect(script.ir.fns.map((f) => f.name)).toEqual(['inc2']);
    expect(await agreedResult(script, [41n], evmVersion)).toEqual({ y: 42n });
  });
});
