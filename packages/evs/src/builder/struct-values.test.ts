/* oxlint-disable typescript/no-unsafe-type-assertion --
 * the recording legs defeat the type surface (`as never`, loosely typed handles) to show that
 * what the types refuse is what recording refuses, and what they accept is recorded. */
/**
 * The recording side of `struct-values.test-d.ts`: a struct out of `Cell.get()`, `s.select()` and
 * `s.lit()` is a `Tuple` handle at recording too, the values the types now accept in the struct
 * and array positions are recorded, and what they now refuse is refused at recording. A handle
 * records nothing of its own: a script spelled with handles records the IR of the one spelled
 * with memrefs.
 */
import { parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { EvsTypeError } from '../core/errors.js';
import { t } from '../core/types.js';
import { interpret, type MockChain } from '../ir/interp.js';
import { serializeIr } from '../ir/nodes.js';
import { evscript, type ScriptBuilder } from './script.js';

const S = t.struct({ a: t.uint256, b: t.address });
const N = t.struct({ inner: S, n: t.uint256 });
const ADDR = '0x00000000000000000000000000000000000000aa';
const abi = parseAbi([
  'struct In { uint256 a; address b; }',
  'struct Nest { In inner; uint256 n; }',
  'function nest(Nest n) view returns (uint256)',
  'function arr(In[] ps) view returns (uint256)',
  'function fixed3(uint8[3] xs) view returns (uint256)',
]);
const ONE_WORD: MockChain = {
  staticcall: () => ({ success: true, data: `0x${'00'.repeat(31)}01` }),
};

/** The handle kind a value is at recording: what its own members say. */
function kindOf(v: unknown): 'Tuple' | 'Expr' {
  const h = v as { expr?: unknown; add?: unknown };
  if (typeof h.expr === 'function' && h.add === undefined) return 'Tuple';
  return 'Expr';
}

describe('a struct out of Cell.get, s.select and s.lit is a Tuple handle', () => {
  test('each of them, and the members read through it', () => {
    const kinds: string[] = [];
    const script = evscript({ name: 'p', args: [t.bool, S, S] }, (s, flag, x, y) => {
      const cell = s.let(S, x.expr());
      s.if(flag, () => cell.set(y));
      const fromCell = cell.get();
      const picked = s.select(flag, x.expr(), y.expr());
      const lit = s.lit(S, { a: 5n, b: ADDR });
      kinds.push(kindOf(fromCell), kindOf(picked), kindOf(lit));
      kinds.push(kindOf(s.let(t.uint256, 1n).get()), kindOf(s.lit(t.array(S), [x])));
      return s.return({ a: fromCell.a.get(), b: picked.b.get(), c: lit.a.get() });
    });
    expect(kinds).toEqual(['Tuple', 'Tuple', 'Tuple', 'Expr', 'Expr']);
    const run = interpret(script, [true, { a: 1n, b: ADDR }, { a: 2n, b: ADDR }], ONE_WORD);
    expect(run.outcome).toMatchObject({ kind: 'return', values: { a: 2n, c: 5n } });
  });

  test('a handle records nothing of its own: the IR is the one of the memref spelling', () => {
    const record = (handles: boolean) =>
      evscript({ name: 'p', args: [t.bool, S, S] }, (s, flag, x, y) => {
        const picked = handles ? s.select(flag, x, y) : s.select(flag, x.expr(), y.expr());
        const cell = handles ? s.let(picked) : s.let(S, picked);
        const again = s.select(flag, cell.get(), x.expr());
        return s.return({ again, same: s.eq(again, picked) });
      });
    expect(serializeIr(record(true).ir)).toBe(serializeIr(record(false).ir));
    expect(record(true).compile().runtimeBytecode).toBe(record(false).compile().runtimeBytecode);
  });

  test('s.select and the one-argument s.let take a bare MutArray handle too', () => {
    const script = evscript({ name: 'p', args: [t.bool] }, (s, flag) => {
      const a = s.newArray(t.uint256, 1n);
      const b = s.newArray(t.uint256, 2n);
      const cell = s.let(s.select(flag, a, b));
      return s.return({ n: cell.get().length() });
    });
    expect(interpret(script, [false], ONE_WORD).outcome).toMatchObject({ values: { n: 2n } });
  });
});

/** The handles of the script {@link recordWith} runs a body in, typed loosely: each body below
 *  is a shape `struct-values.test-d.ts` checks on the real handle types. */
interface LooseHandles {
  readonly u256: never;
  readonly addr: never;
  readonly tup: never;
  readonly tupExpr: never;
  readonly tarr: never;
  readonly flag: never;
  readonly target: never;
}

/** Records `body` in a script with the handles the positions below need. */
function recordWith(body: (s: ScriptBuilder, h: LooseHandles) => unknown): void {
  evscript(
    { name: 'p', args: [t.uint256, t.address, S, t.array(S), t.bool, t.address] },
    (s, u256, addr, tup, tarr, flag, target) => {
      const h = {
        u256,
        addr,
        tup,
        tupExpr: tup.expr(),
        tarr,
        flag,
        target,
      } as unknown as LooseHandles;
      body(s, h);
      return s.return({ ok: flag });
    },
  );
}

describe('what the types accept in a struct or array position, recording takes', () => {
  const ACCEPTED: readonly (readonly [string, (s: ScriptBuilder, h: LooseHandles) => unknown])[] = [
    ['s.lit(S, { a: u256, b })', (s, h) => s.lit(S, { a: h.u256, b: ADDR })],
    [
      's.lit(t.array(S), [tup, { a, b }])',
      (s, h) => s.lit(t.array(S), [h.tup, { a: h.u256, b: h.addr }]),
    ],
    ['s.let(S, tup)', (s, h) => s.let(S, h.tup)],
    ['s.let(t.array(S), smarr)', (s) => s.let(t.array(S), s.newArray(S, 1n))],
    [
      's.let(t.array(t.uint256), marr)',
      (s) => s.let(t.array(t.uint256), s.newArray(t.uint256, 2n)),
    ],
    ['Cell<S>.set(tup)', (s, h) => s.let(S, { a: 1n, b: ADDR }).set(h.tup)],
    [
      's.select(flag, tup.expr(), { a, b })',
      (s, h) => s.select(h.flag, h.tupExpr, { a: h.u256, b: ADDR } as never),
    ],
    ['s.select(flag, tarr, [tup])', (s, h) => s.select(h.flag, h.tarr, [h.tup] as never)],
    ['tup.expr().eq(tup)', (s, h) => s.eq(h.tupExpr, h.tup)],
    [
      'nested member: { inner: Expr<S>, n }',
      (s, h) =>
        s.read({
          address: h.target,
          abi,
          functionName: 'nest',
          args: [{ inner: h.tupExpr, n: 1n }],
        }),
    ],
    [
      'tuple[] element: [Expr<S>]',
      (s, h) => s.read({ address: h.target, abi, functionName: 'arr', args: [[h.tupExpr]] }),
    ],
    ['Field.set(Expr<S>)', (s, h) => s.tuple(N).inner.set(h.tupExpr)],
    ['s.tuple(N, { inner: Expr<S> })', (s, h) => s.tuple(N, { inner: h.tupExpr })],
  ];
  test.each(ACCEPTED)('%s', (_label, body) => {
    expect(() => recordWith(body)).not.toThrow();
  });
});

describe('what the types refuse in those positions, recording refuses', () => {
  const REFUSED: readonly (readonly [
    string,
    (s: ScriptBuilder, h: LooseHandles) => unknown,
    RegExp,
  ])[] = [
    [
      's.lit(t.array(t.uint256, 3), [1n])',
      (s) => s.lit(t.array(t.uint256, 3), [1n] as never),
      /uint256\[3\] literal must have exactly 3 element\(s\), got 1/,
    ],
    [
      'fixed3([1, 2])',
      (s, h) => s.read({ address: h.target, abi, functionName: 'fixed3', args: [[1, 2] as never] }),
      /uint8\[3\] literal must have exactly 3 element\(s\), got 2/,
    ],
    [
      's.tuple(t.array(S))',
      (s) => s.tuple(t.array(S) as never),
      /is an ARRAY of tuples, not a tuple/,
    ],
    [
      's.encodePacked(string[])',
      (s) => s.encodePacked(s.lit(t.array(t.string), ['a']) as never),
      /cannot be packed-encoded/,
    ],
    ['s.encodePacked(tuple[])', (s, h) => s.encodePacked(h.tarr), /cannot be packed-encoded/],
    ['s.encodePacked(Tuple)', (s, h) => s.encodePacked(h.tup), /cannot be packed-encoded/],
    [
      's.encodePacked(MutArray<string>)',
      (s) => s.encodePacked(s.newArray(t.string, 1n) as never),
      /cannot be packed-encoded/,
    ],
    ['s.lit(t.uint256, u256)', (s, h) => s.lit(t.uint256, h.u256), /uint256/],
  ];
  test.each(REFUSED)('%s', (_label, body, message) => {
    let caught: unknown;
    try {
      recordWith(body);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvsTypeError);
    expect((caught as EvsTypeError).code).toBe('TYPE_MISMATCH');
    expect((caught as EvsTypeError).message).toMatch(message);
  });
});
