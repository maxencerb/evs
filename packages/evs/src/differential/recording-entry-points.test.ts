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

describe.each(EVM_VERSIONS)(
  'a dropped s.select branch holding a live handle [%s]',
  (evmVersion) => {
    // the dropped `[x]` literal names a live Tuple: it is validated without being recorded, so no
    // dead allocation of it survives (DCE keeps an array store that aliases a live value)
    const S = t.struct({ a: t.uint256 });
    const script = (select: boolean) =>
      evscript({ name: 'drop', args: [t.uint256] }, (s, n) => {
        const x = s.tuple(S, { a: 5n });
        const arr = s.newArray(S, 1n);
        arr.set(0n, x);
        // a Tuple handle as a `tuple[]` literal element: the runtime takes it, the literal type not
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
        const lit = [x] as never;
        const r = select ? s.select(true, arr.expr(), lit) : arr.expr();
        const acc = s.let(t.uint256, 0n);
        s.for({ type: t.uint256, from: 0n, until: n }, () => {
          const q = select ? s.select(false, lit, arr.expr()) : arr.expr();
          acc.set(acc.get().add(q.length()));
        });
        return s.return({ r, x, acc: acc.get() });
      });

    test('the recorded IR is the chosen branch alone', () => {
      expect(script(true).ir).toEqual(script(false).ir);
      expect(compile(script(true), { evmVersion }).runtimeBytecode).toBe(
        compile(script(false), { evmVersion }).runtimeBytecode,
      );
    });

    test('no LOOP_ALLOCATION for the dropped literal in a loop', async () => {
      const codes: string[] = [];
      compile(script(true), { evmVersion, onDiagnostic: (d) => codes.push(d.code) });
      expect(codes).not.toContain('LOOP_ALLOCATION');
      expect(await agreedResult(script(true), [2n], evmVersion)).toEqual({
        r: [{ a: 5n }],
        x: { a: 5n },
        acc: 2n,
      });
    });

    test('an invalid dropped branch still throws, and recording carries on cleanly', () => {
      const Pair2 = t.tuple(t.uint256, t.address);
      const caught = evscript({ name: 'bad', args: [t.uint256] }, (s, x) => {
        const p = s.tuple(Pair2, [x, ONE]);
        // each invalid literal records part of itself (the `7n` const) before it throws
        const drop = (bad: readonly unknown[]) => () =>
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- seeded invalid literals
          s.select(true, p.expr(), bad as never);
        expect(drop([1n, ONE, 2n])).toThrow(/too many members/);
        expect(drop([7n, 'not an address'])).toThrow(/address literal must be/);
        expect(drop([[x]])).toThrow(/uint256 literal must be/);
        return s.return({ p });
      });
      const plain = evscript({ name: 'bad', args: [t.uint256] }, (s, x) =>
        s.return({ p: s.tuple(Pair2, [x, ONE]) }),
      );
      expect(caught.ir).toEqual(plain.ir);
    });
  },
);

describe.each(EVM_VERSIONS)('a handle copy that names every member [%s]', (evmVersion) => {
  test('s.tuple(P, { ...p, a, b }) builds the overriding members (nothing is zero-filled)', async () => {
    const script = evscript({ name: 'full', args: [Pair, t.uint256] }, (s, p, x) =>
      s.return({ r: s.tuple(Pair, { ...p, a: x, b: ONE }) }),
    );
    expect(await agreedResult(script, [{ a: 1n, b: ZERO }, 9n], evmVersion)).toEqual({
      r: { a: 9n, b: ONE },
    });
  });
});

describe.each(EVM_VERSIONS)('struct literals with a `type` member [%s]', (evmVersion) => {
  test('memref .eq() / s.select() read them as tuple literals', async () => {
    const S = t.struct({ type: t.string });
    const script = evscript({ name: 'ty', args: [t.string, t.bool] }, (s, tag, c) => {
      const x = s.tuple(S, { type: tag });
      return s.return({
        isAddress: x.expr().eq({ type: 'address' }),
        notUint: s.neq(x.expr(), { type: 'uint256' }),
        picked: s.select(c, x.expr(), { type: 'bool' }),
      });
    });
    expect(await agreedResult(script, ['address', false], evmVersion)).toEqual({
      isAddress: true,
      notUint: true,
      picked: { type: 'bool' },
    });
    expect(await agreedResult(script, ['uint256', true], evmVersion)).toEqual({
      isAddress: false,
      notUint: false,
      picked: { type: 'uint256' },
    });
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
