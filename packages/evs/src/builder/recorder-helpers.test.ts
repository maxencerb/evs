/* oxlint-disable typescript/no-unsafe-type-assertion --
 * these tests deliberately defeat the type surface (`as never`) to reach the runtime checks. */
/**
 * Builder unit tests — the recorder's shared helpers, one behavior per call site: the owner +
 * visibility check behind every handle kind (`handleId`), the handle-only value positions
 * (`valueIdOf`), the layout re-wrap (`assertLayout`), operand / branch type unification, the
 * declared-error index of `s.throw`, the overload-ambiguity hint, and the call options (`gas`,
 * `value` and its payable check) surviving the split of `subcall`.
 */
import type { Abi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { EvsError, type EvsErrorCode } from '../core/errors.js';
import { t, type Expr } from '../core/types.js';
import { walkStmts } from '../ir/nodes.js';
import { evscript, type MutArray, type Tuple } from './script.js';

/** Runs `fn`, which must throw an `EvsError` with `code`, and returns the error. */
function catchEvs(fn: () => unknown, code: EvsErrorCode): EvsError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(EvsError);
  const err = thrown as EvsError;
  expect(err.code).toBe(code);
  return err;
}

const Pair = t.struct({ a: t.uint256, b: t.address });

describe('handle ownership + visibility (one check for Expr, Tuple and MutArray)', () => {
  let foreignTuple: Tuple<typeof Pair> | undefined;
  let foreignTupleExpr: Expr | undefined;
  let foreignArr: MutArray<'uint256'> | undefined;
  evscript({ name: 'donor', args: [t.uint256, t.address] }, (s, a, b) => {
    foreignTuple = s.tuple(Pair, { a, b });
    foreignTupleExpr = foreignTuple.expr();
    foreignArr = s.newArray(t.uint256, 2n);
    return s.return({ a });
  });

  test('a foreign Tuple where a tuple is expected names it by ValueId', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'thief', args: [] }, (s) => {
          const f = s.fn('take', [Pair], (p) => p.a.get());
          return s.return({ r: f(foreignTuple as never) });
        }),
      'FOREIGN_HANDLE',
    );
    expect(e.message).toMatch(
      /this Tuple \(#\d+ ← s\.tuple\(a, b\)\) belongs to script "donor" and cannot be used in script "thief"/,
    );
  });

  test('a foreign tuple Expr (`.expr()`) where a tuple is expected names it with its type', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'thief', args: [] }, (s) => {
          const outer = s.tuple(t.struct({ inner: Pair }), { inner: foreignTupleExpr as never });
          return s.return({ outer });
        }),
      'FOREIGN_HANDLE',
    );
    expect(e.message).toMatch(/this Expr \(Expr<.*> #\d+.*\) belongs to script "donor"/);
  });

  test('a foreign MutArray where an array is expected', () => {
    const e = catchEvs(
      () => evscript({ name: 'thief', args: [] }, (s) => s.return({ arr: foreignArr as never })),
      'FOREIGN_HANDLE',
    );
    expect(e.message).toMatch(/this MutArray \(#\d+ ← s\.newArray\(uint256\)\) belongs to script/);
  });

  test('a Tuple from a closed block is a SCOPE_VIOLATION wherever it is reused', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'leak', args: [t.uint256, t.address] }, (s, a, b) => {
          let inner: Tuple<typeof Pair> | undefined;
          s.if(true, () => {
            inner = s.tuple(Pair, { a, b });
          });
          const outer = s.tuple(t.struct({ inner: Pair }), { inner: inner as never });
          return s.return({ outer });
        }),
      'SCOPE_VIOLATION',
    );
    expect(e.message).toMatch(/if-then block that has finished recording/);
  });
});

describe('handle-only value positions reject host literals', () => {
  test('s.return', () => {
    const e = catchEvs(
      () => evscript({ name: 'r', args: [] }, (s) => s.return({ x: 1n as never })),
      'TYPE_MISMATCH',
    );
    expect(e.message).toContain('s.return() value "x": must be an Expr');
    expect(e.message).toContain('s.lit(type, value)');
  });

  test('s.encode / s.keccak256', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'r', args: [t.uint256] }, (s, x) =>
          s.return({ h: s.keccak256(x, 2n as never) }),
        ),
      'TYPE_MISMATCH',
    );
    expect(e.message).toContain('s.keccak256() value #1: must be an Expr');
    expect(e.message).toContain('s.lit(type, value)');
  });

  test('an s.fn result', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'r', args: [t.uint256] }, (s, x) => {
          s.fn('bad', [t.uint256], () => 7n as never);
          return s.return({ x });
        }),
      'TYPE_MISMATCH',
    );
    expect(e.message).toContain('s.fn("bad") result: fn bodies must return an Expr');
    expect(e.message).toContain('got 7n');
  });

  test('bare Tuple / MutArray handles are accepted and alias the same ValueId', () => {
    const script = evscript({ name: 'ok', args: [t.uint256, t.address] }, (s, a, b) => {
      const pair = s.tuple(Pair, { a, b });
      const arr = s.newArray(t.uint256, 1n);
      return s.return({ pair, arr, h: s.keccak256(pair, arr) });
    });
    const [pair, arr] = script.ir.returns;
    const encodes: (readonly number[])[] = [];
    walkStmts(script.ir.body, (st) => {
      if (st.k === 'encode') encodes.push(st.args);
    });
    expect(encodes).toEqual([[pair?.value, arr?.value]]);
  });
});

describe('layout classification keeps each entry point in its messages', () => {
  const tooDeep = 'uint256[][][][][]';
  test.each([
    [
      's.lit()',
      () =>
        evscript({ name: 'l', args: [] }, (s) =>
          s.return({ x: s.lit(tooDeep as never, [] as never) }),
        ),
    ],
    [
      's.newArray()',
      () =>
        evscript({ name: 'l', args: [] }, (s) =>
          s.return({ x: s.newArray('uint256[][][][]' as never, 1n).expr() }),
        ),
    ],
    [
      's.call() revertReturns[0]',
      () =>
        evscript({ name: 'l', args: [t.address] }, (s, who) =>
          s.return({
            x: s.call({
              address: who,
              abi: [
                {
                  type: 'function',
                  name: 'quote',
                  stateMutability: 'nonpayable',
                  inputs: [],
                  outputs: [],
                },
              ],
              functionName: 'quote',
              revertReturns: [tooDeep as never],
            }),
          }),
        ),
    ],
    [
      's.call() revertReturns[1]',
      () =>
        evscript({ name: 'l', args: [t.address] }, (s, who) =>
          s.return({
            x: s.call({
              address: who,
              abi: [
                {
                  type: 'function',
                  name: 'quote',
                  stateMutability: 'nonpayable',
                  inputs: [],
                  outputs: [],
                },
              ],
              functionName: 'quote',
              // a tuple descriptor: classified through `layoutOfType`, not `layoutOf`
              revertReturns: [
                t.uint256,
                { type: 'tuple', components: [{ name: 'x', type: tooDeep }] },
              ] as never,
            }),
          }),
        ),
    ],
  ])('%s', (what, record) => {
    const e = catchEvs(record, 'UNSUPPORTED_V0');
    expect(e.message).toContain(what);
    expect(e.message).not.toMatch(/layoutOf/);
  });
});

describe('operand / branch type unification', () => {
  test('bin: differing numeric widths suggest an explicit conversion', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'u', args: [t.uint8, t.uint16] }, (s, a, b) =>
          s.return({ r: s.add(a, b as never) }),
        ),
      'TYPE_MISMATCH',
    );
    expect(e.message).toContain("s.add(): operand types differ (Expr<'uint8'> vs Expr<'uint16'>)");
    expect(e.message).toContain(".toUint('…') / .toInt('…')");
  });

  test('s.select: differing numeric widths suggest an explicit conversion', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'u', args: [t.bool, t.uint8, t.uint16] }, (s, c, a, b) =>
          s.return({ r: s.select(c, a, b as never) }),
        ),
      'TYPE_MISMATCH',
    );
    expect(e.message).toContain(
      "s.select(): branch types differ (Expr<'uint8'> vs Expr<'uint16'>)",
    );
    expect(e.message).toContain(".toUint('…') / .toInt('…')");
  });

  test('two literals are rejected with the noun of the position', () => {
    const select = catchEvs(
      () => evscript({ name: 'u', args: [t.bool] }, (s, c) => s.return({ r: s.select(c, 1n, 2n) })),
      'TYPE_MISMATCH',
    );
    expect(select.message).toContain('s.select(): at least one branch must be an Expr');
    const bin = catchEvs(
      () => evscript({ name: 'u', args: [] }, (s) => s.return({ r: s.add(1n, 2n) })),
      'TYPE_MISMATCH',
    );
    expect(bin.message).toMatch(/at least one operand must be an Expr/);
  });
});

describe('s.throw records the index of the declared error it resolves to', () => {
  const First = t.error('First', []);
  const Second = t.error('Second', [{ name: 'code', type: t.uint256 }]);
  const throwIndex = (error: unknown): number | undefined => {
    const script = evscript({ name: 'th', args: [t.uint256], errors: [First, Second] }, (s, x) => {
      s.if(x.eq(0n), () => {
        (s.throw as (...args: unknown[]) => void)(error, { code: x });
      });
      return s.return({ x });
    });
    let index: number | undefined;
    walkStmts(script.ir.body, (st) => {
      if (st.k === 'throw') index = st.error;
    });
    return index;
  };

  test('by identity', () => {
    expect(throwIndex(Second)).toBe(1);
  });

  test('by structure (a re-created, equal t.error value)', () => {
    expect(throwIndex(t.error('Second', [{ name: 'code', type: t.uint256 }]))).toBe(1);
  });
});

describe('overload resolution hint', () => {
  const abi = [
    {
      type: 'function',
      name: 'f',
      stateMutability: 'view',
      inputs: [{ name: 'x', type: 'uint8' }],
      outputs: [],
    },
    {
      type: 'function',
      name: 'f',
      stateMutability: 'view',
      inputs: [{ name: 'x', type: 'uint16' }],
      outputs: [],
    },
    {
      type: 'function',
      name: 'f',
      stateMutability: 'view',
      inputs: [{ name: 'x', type: 'address' }],
      outputs: [],
    },
  ] as const satisfies Abi;
  const read = (arg: unknown) => () =>
    evscript({ name: 'o', args: [t.address] }, (s, who) => {
      s.read({ address: who, abi, functionName: 'f', args: [arg] } as never);
      return s.return({ who });
    });

  test('an ambiguous call names the first fitting overload', () => {
    const e = catchEvs(read(1n), 'ABI_SHAPE');
    expect(e.message).toMatch(/fit f\(uint8\), f\(uint16\);.*functionName: "f\(uint8\)"/);
  });

  test('a call no overload fits names the first one of that arity', () => {
    const e = catchEvs(read(true), 'TYPE_MISMATCH');
    expect(e.message).toMatch(/match none of the overloads.*functionName: "f\(uint8\)"/);
  });
});

describe('the split subcall keeps every call option', () => {
  const abi = [
    {
      type: 'function',
      name: 'deposit',
      stateMutability: 'payable',
      inputs: [],
      outputs: [{ name: 'shares', type: 'uint256' }],
    },
    {
      type: 'function',
      name: 'poke',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: [],
    },
  ] as const satisfies Abi;

  test('gas and value reach the recorded call statement (s.call and s.simulate)', () => {
    const script = evscript({ name: 'v', args: [t.address, t.uint256] }, (s, who, wei) => {
      const a = s.call({ address: who, abi, functionName: 'deposit', gas: 50_000n, value: wei });
      const b = s.simulate({ address: who, abi, functionName: 'deposit', value: 7n });
      return s.return({ a, b });
    });
    const calls: {
      kind: string | undefined;
      gas: number | undefined;
      value: number | undefined;
    }[] = [];
    const consts = new Map<number, string>();
    walkStmts(script.ir.body, (st) => {
      if (st.k === 'call') calls.push({ kind: st.kind, gas: st.gas, value: st.value });
      if (st.k === 'const') consts.set(st.out, st.data.hex);
    });
    expect(calls).toHaveLength(2);
    const [call, sim] = calls;
    expect(call?.kind).toBe('call');
    expect(call?.value).toBeTypeOf('number');
    expect(call?.gas).toBeTypeOf('number');
    // the runtime value is the script arg (no const behind it); the literal one is the const 7
    expect(consts.has(call?.value ?? -1)).toBe(false);
    expect(script.ir.values[call?.value ?? -1]?.type).toBe('uint256');
    expect(sim?.kind).toBe('simulate');
    expect(sim?.gas).toBeUndefined();
    expect(BigInt(consts.get(sim?.value ?? -1) ?? '0x0')).toBe(7n);
  });

  test('value on a nonpayable entry is refused after the entry is selected', () => {
    const e = catchEvs(
      () =>
        evscript({ name: 'v', args: [t.address] }, (s, who) => {
          s.call({ address: who, abi, functionName: 'poke', value: 1n } as never);
          return s.return({ who });
        }),
      'TYPE_MISMATCH',
    );
    expect(e.message).toContain('`value` is only accepted for a payable function');
    expect(e.message).toContain('"poke" is nonpayable');
  });
});
