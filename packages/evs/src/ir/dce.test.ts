/* oxlint-disable unicorn/no-thenable --
 * the IR schema names the if-statement branch field `then`. */
/**
 * `ir/dce.ts` unit tests — hand-built IR per statement kind, the liveness seeds (returns,
 * throw, call, live cells, impure fns), aliasing through composite values, idempotence, the
 * documented revert-guard decision (and `interpret()` following it unless `dce: false`), and
 * source-map resolution after the pass. The whole builder corpus is gated separately by
 * `differential/*.test.ts` (`interpret(ir, { dce: false }) == interpret(ir) == bytecode`, except
 * for the dead-revert-guard cases, where only the last two must agree).
 */
import { describe, expect, test } from 'vite-plus/test';

import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { namedArg, t, type EvsType, type Hex } from '../core/types.js';
import { dce, eliminateDeadCode } from './dce.js';
import { interpret, type MockChain } from './interp.js';
import {
  deepFreeze,
  serializeIr,
  walkStmts,
  type PlainAbiFunction,
  type ScriptIr,
  type Stmt,
  type ValueInfo,
} from './nodes.js';
import { validateIr } from './validate.js';

// ---------------------------------------------------------------------------
// fixture builders (the nodes.test.ts conventions)
// ---------------------------------------------------------------------------

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let nextSite = 0;
function mk(body: DistOmit<Stmt, 'site'>): Stmt {
  return { site: nextSite++, ...body };
}

function vi(type: EvsType, debugName?: string): ValueInfo {
  return debugName === undefined ? { type } : { type, debugName };
}

function ir(p: Partial<ScriptIr>): ScriptIr {
  nextSite = 0;
  return {
    irVersion: 1,
    name: 'fixture',
    args: [],
    values: [],
    cells: [],
    fns: [],
    body: [],
    returns: [],
    ...p,
  };
}

function wordHex(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

const constU = (out: number, n: bigint): Stmt =>
  mk({ k: 'const', out, data: { kind: 'word', hex: wordHex(n) }, type: 'uint256' });

const ADDR: EvsType = 'address';
const POINT: EvsType = { type: 'tuple', components: [{ name: 'x', type: 'uint256' }] };
const POINTS: EvsType = { type: 'tuple[]', components: [{ name: 'x', type: 'uint256' }] };

const getterAbi: PlainAbiFunction = {
  name: 'get',
  selector: '0x6d4ce63c',
  inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
};

const NO_CHAIN: MockChain = {
  staticcall: () => ({ success: true, data: wordHex(7n) }),
};

function kinds(stmts: readonly Stmt[]): string[] {
  const out: string[] = [];
  walkStmts(stmts, (s) => out.push(s.k));
  return out;
}

/** The child blocks of a `while` statement (identity-comparable), or undefined. */
function whileBlocks(s: Stmt | undefined): { header: unknown; body: unknown } | undefined {
  return s?.k === 'while' ? { header: s.header, body: s.body } : undefined;
}

function allStmts(x: ScriptIr): Stmt[] {
  const out: Stmt[] = [];
  walkStmts(x.body, (s) => out.push(s));
  for (const fn of x.fns) walkStmts(fn.body, (s) => out.push(s));
  return out;
}

/** The pass output must re-validate and be a fixpoint; the tables must be untouched. */
function check(x: ScriptIr): ScriptIr {
  expect(() => validateIr(x)).not.toThrow();
  const out = eliminateDeadCode(x);
  expect(() => validateIr(out)).not.toThrow();
  expect(eliminateDeadCode(out)).toBe(out); // idempotent, by identity
  expect(out.values).toBe(x.values);
  expect(out.cells).toBe(x.cells);
  expect(out.returns).toBe(x.returns);
  // a rebuilt IR is frozen like a recorded one (the fixtures themselves are not; untouched
  // blocks are reused by identity)
  expect(out === x || Object.isFrozen(out)).toBe(true);
  expect(out.body === x.body || Object.isFrozen(out.body)).toBe(true);
  return out;
}

// ---------------------------------------------------------------------------
// pure statement kinds
// ---------------------------------------------------------------------------

describe('pure statements with dead results are dropped', () => {
  test('every pure kind — only the return chain survives, statement objects reused', () => {
    // values: 0 a(arg uint256) 1 b(arg address) 2 arr(arg uint256[]) 3 pts(arg tuple[])
    //         4 live sum   5..21 dead outs
    const x = ir({
      name: 'pure',
      args: [
        { name: 'a', type: 'uint256' },
        { name: 'b', type: ADDR },
        { name: 'arr', type: 'uint256[]' },
        { name: 'pts', type: POINTS },
      ],
      values: [
        vi('uint256'),
        vi(ADDR),
        vi('uint256[]'),
        vi(POINTS),
        vi('uint256', 'sum'), // 4 live
        vi('uint256'), // 5 const
        vi('uint256'), // 6 bin
        vi('bool'), // 7 un (iszero)
        vi(ADDR), // 8 env
        vi('uint8'), // 9 convert
        vi('uint256'), // 10 select
        vi('uint256'), // 11 index
        vi('uint256'), // 12 len
        vi('uint256[]'), // 13 arrnew
        vi(POINT), // 14 tuplenew
        vi('uint256'), // 15 field
        vi('bytes'), // 16 encode
        vi('bytes32'), // 17 keccak256
        vi('uint256'), // 18 cellget
        vi('bool'), // 19 select cond
        vi('uint256'), // 20 account balance
        vi('bytes32'), // 21 account codehash
      ],
      cells: [vi('uint256')],
      body: [
        mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 4 }), // live: returned
        constU(5, 1n),
        mk({ k: 'bin', op: 'mul', a: 0, b: 5, out: 6 }),
        mk({ k: 'un', op: 'iszero', a: 0, out: 7 }),
        mk({ k: 'env', op: 'caller', out: 8 }),
        mk({ k: 'account', op: 'balance', a: 8, out: 20 }),
        mk({ k: 'account', op: 'codehash', a: 1, out: 21 }),
        mk({ k: 'convert', a: 0, out: 9 }),
        mk({ k: 'un', op: 'iszero', a: 0, out: 19 }),
        mk({ k: 'select', cond: 19, a: 0, b: 5, out: 10 }),
        mk({ k: 'index', arr: 2, i: 0, out: 11 }),
        mk({ k: 'len', a: 2, out: 12 }),
        mk({ k: 'arrnew', elem: 'uint256', length: 0, out: 13 }),
        mk({ k: 'arrset', arr: 13, i: 5, value: 0 }), // mutation of a dead allocation
        mk({ k: 'tuplenew', inits: [{ index: 0, value: 0 }], out: 14 }),
        mk({ k: 'tupleset', tuple: 14, index: 0, value: 6 }),
        mk({ k: 'field', tuple: 14, index: 0, out: 15 }),
        mk({ k: 'encode', mode: 'abi', args: [0, 1], out: 16 }),
        mk({ k: 'keccak256', a: 16, out: 17 }),
        mk({ k: 'cellnew', cell: 0, init: 0 }),
        mk({ k: 'cellget', cell: 0, out: 18 }), // a cellget nobody reads: dead, and so is its cell
      ],
      returns: [{ name: 'sum', type: 'uint256', value: 4 }],
    });
    const out = check(x);
    expect(kinds(out.body)).toEqual(['bin']);
    expect(out.body[0]).toBe(x.body[0]);
    expect(serializeIr(out)).not.toBe(serializeIr(x));
  });

  test('an IR with nothing dead is returned by identity', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('uint256')],
      body: [constU(1, 2n), mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 })],
      returns: [{ name: 'r', type: 'uint256', value: 2 }],
    });
    expect(eliminateDeadCode(x)).toBe(x);
    expect(dce).toBe(eliminateDeadCode);
  });
});

// ---------------------------------------------------------------------------
// liveness seeds
// ---------------------------------------------------------------------------

describe('liveness seeds', () => {
  test('a value guarding a throw stays, and so does the if around it', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('bool'), vi('uint256')],
      errors: [{ name: 'TooBig', selector: '0x11223344', inputs: [] }],
      body: [
        constU(1, 100n),
        mk({ k: 'bin', op: 'gt', a: 0, b: 1, out: 2 }),
        mk({ k: 'if', cond: 2, then: [mk({ k: 'throw', error: 0, args: [] })], else: [] }),
        mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 3 }), // dead
      ],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    const out = check(x);
    expect(kinds(out.body)).toEqual(['const', 'bin', 'if', 'throw']);
  });

  test('call statements with dead results stay, in every kind and mode', () => {
    const x = ir({
      args: [{ name: 'to', type: ADDR }],
      values: [
        vi(ADDR),
        vi('uint256'),
        vi('uint256'),
        vi('uint256'),
        vi('uint256'),
        vi('bool'),
        vi('uint256'),
      ],
      body: [
        mk({ k: 'call', target: 0, fnAbi: getterAbi, args: [], outs: [1], mode: 'strict' }),
        mk({
          k: 'call',
          target: 0,
          fnAbi: getterAbi,
          args: [],
          outs: [2],
          mode: 'strict',
          kind: 'call',
        }),
        mk({
          k: 'call',
          target: 0,
          fnAbi: getterAbi,
          args: [],
          outs: [3],
          mode: 'strict',
          kind: 'simulate',
        }),
        mk({
          k: 'call',
          target: 0,
          fnAbi: getterAbi,
          args: [],
          outs: [4],
          mode: 'try',
          successOut: 5,
        }),
        constU(6, 1n), // dead
      ],
      returns: [],
    });
    const out = check(x);
    expect(kinds(out.body)).toEqual(['call', 'call', 'call', 'call']);
  });

  test('a gas value feeding a call is live', () => {
    const x = ir({
      args: [{ name: 'to', type: ADDR }],
      values: [vi(ADDR), vi('uint256'), vi('uint256')],
      body: [
        constU(1, 50_000n),
        mk({ k: 'call', target: 0, fnAbi: getterAbi, args: [], outs: [2], mode: 'strict', gas: 1 }),
      ],
      returns: [],
    });
    expect(kinds(check(x).body)).toEqual(['const', 'call']);
  });

  test('a set on a never-read cell is dropped with its cellnew and the value chain', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('uint256')],
      cells: [vi('uint256')],
      body: [
        mk({ k: 'cellnew', cell: 0, init: 0 }),
        constU(1, 1n),
        mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 }),
        mk({ k: 'cellset', cell: 0, value: 2 }),
      ],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    expect(check(x).body).toEqual([]);
  });

  test('a cell read anywhere keeps every set on it, even inside a dead-looking branch', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('bool'), vi('uint256')],
      cells: [vi('uint256')],
      body: [
        mk({ k: 'cellnew', cell: 0, init: 0 }),
        constU(1, 1n),
        mk({ k: 'un', op: 'iszero', a: 0, out: 2 }),
        mk({ k: 'if', cond: 2, then: [mk({ k: 'cellset', cell: 0, value: 1 })], else: [] }),
        mk({ k: 'cellget', cell: 0, out: 3 }),
      ],
      returns: [{ name: 'r', type: 'uint256', value: 3 }],
    });
    expect(kinds(check(x).body)).toEqual(['cellnew', 'const', 'un', 'if', 'cellset', 'cellget']);
  });

  test('an if whose branches are entirely dead is dropped, its condition chain with it', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('bool'), vi('uint256'), vi('uint256')],
      body: [
        mk({ k: 'un', op: 'iszero', a: 0, out: 1 }),
        mk({
          k: 'if',
          cond: 1,
          then: [constU(2, 1n)],
          else: [mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 3 })],
        }),
      ],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    expect(check(x).body).toEqual([]);
  });

  test('a while always stays (with break/continue); dead work inside it goes', () => {
    // values: 0 a  1 i(cellget)  2 cond  3 one  4 next  5 dead  6 flag
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [
        vi('uint256'),
        vi('uint256'),
        vi('bool'),
        vi('uint256'),
        vi('uint256'),
        vi('uint256'),
        vi('bool'),
      ],
      cells: [vi('uint256')],
      body: [
        constU(3, 1n),
        mk({ k: 'cellnew', cell: 0, init: 3 }),
        mk({
          k: 'while',
          header: [
            mk({ k: 'cellget', cell: 0, out: 1 }),
            mk({ k: 'bin', op: 'lt', a: 1, b: 0, out: 2 }),
          ],
          cond: 2,
          body: [
            mk({ k: 'bin', op: 'mul', a: 1, b: 1, out: 5 }), // dead
            mk({ k: 'un', op: 'iszero', a: 1, out: 6 }),
            mk({ k: 'if', cond: 6, then: [mk({ k: 'continue' })], else: [mk({ k: 'break' })] }),
            mk({ k: 'bin', op: 'add', a: 1, b: 3, out: 4 }),
            mk({ k: 'cellset', cell: 0, value: 4 }),
          ],
        }),
      ],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    const out = check(x);
    expect(kinds(out.body)).toEqual([
      'const',
      'cellnew',
      'while',
      'cellget',
      'bin',
      'un',
      'if',
      'continue',
      'break',
      'bin',
      'cellset',
    ]);
    const rebuilt = whileBlocks(out.body[2]);
    const original = whileBlocks(x.body[2]);
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.header).toBe(original?.header); // untouched header block reused by identity
    expect(rebuilt?.body).not.toBe(original?.body); // the body lost a statement: rebuilt, frozen
    expect(Object.isFrozen(rebuilt?.body)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// if liveness: cascades through cells, nesting, linear cost
// ---------------------------------------------------------------------------

/**
 * `K` sibling `if`s chained through cells: `if_0` sets `c_0` when `a > 0`; `if_i` reads `c_{i-1}`
 * in its condition and sets `c_i`. With `returnLast`, the script returns `c_{K-1}` — liveness then
 * flows back to front, one `if` (and one cell) at a time; otherwise it returns `a` and nothing
 * survives. values: 0 a  1 zero  then per i: cond_i (and g_i, the `c_{i-1}` read, for i > 0);
 * last: the final read.
 */
function cascadeIr(K: number, returnLast: boolean): ScriptIr {
  const base = ir({ args: [{ name: 'a', type: 'uint256' }] }); // first: resets the site counter
  const values: ValueInfo[] = [vi('uint256'), vi('uint256')];
  const value = (type: EvsType): number => values.push(vi(type)) - 1;
  const body: Stmt[] = [constU(1, 0n)];
  for (let c = 0; c < K; c++) body.push(mk({ k: 'cellnew', cell: c, init: 1 }));
  for (let i = 0; i < K; i++) {
    let lhs = 0;
    if (i > 0) {
      lhs = value('uint256');
      body.push(mk({ k: 'cellget', cell: i - 1, out: lhs }));
    }
    const cond = value('bool');
    body.push(mk({ k: 'bin', op: 'gt', a: lhs, b: 1, out: cond }));
    body.push(mk({ k: 'if', cond, then: [mk({ k: 'cellset', cell: i, value: 0 })], else: [] }));
  }
  const last = value('uint256');
  body.push(mk({ k: 'cellget', cell: K - 1, out: last }));
  return {
    ...base,
    values,
    cells: Array.from({ length: K }, () => vi('uint256')),
    body,
    returns: [{ name: 'r', type: 'uint256', value: returnLast ? last : 0 }],
  };
}

/**
 * `D` nested `if`s (`if_d` sits in `if_{d-1}`'s `then`), each condition computed inside the
 * enclosing branch next to a dead `mul`; only the `innermost` statement can be live.
 * values: 0 a  then per level: cond_d, dead_d.
 */
function nestedIr(D: number, innermost: () => Stmt, extra: Partial<ScriptIr> = {}): ScriptIr {
  const base = ir({ args: [{ name: 'a', type: 'uint256' }] }); // first: resets the site counter
  const values: ValueInfo[] = [vi('uint256')];
  const value = (type: EvsType): number => values.push(vi(type)) - 1;
  const level = (d: number): Stmt[] => {
    if (d === D) return [innermost()];
    const cond = value('bool');
    const dead = value('uint256');
    return [
      mk({ k: 'un', op: 'iszero', a: 0, out: cond }),
      mk({ k: 'bin', op: 'mul', a: 0, b: 0, out: dead }), // dead at every level
      mk({ k: 'if', cond, then: level(d + 1), else: [] }),
    ];
  };
  return {
    ...base,
    values,
    body: level(0),
    returns: [{ name: 'a', type: 'uint256', value: 0 }],
    ...extra,
  };
}

/** Counts every read of an `if`'s `then` / `else` (the pass's only way into a branch). */
function countBranchReads(x: ScriptIr): { reads: () => number; ifs: number } {
  let reads = 0;
  let ifs = 0;
  const instrument = (stmts: readonly Stmt[]): void => {
    for (const s of stmts) {
      if (s.k === 'while') {
        instrument(s.header);
        instrument(s.body);
      }
      if (s.k !== 'if') continue;
      ifs++;
      for (const key of ['then', 'else'] as const) {
        const block = s[key];
        instrument(block);
        Object.defineProperty(s, key, {
          enumerable: true,
          get: () => {
            reads++;
            return block;
          },
        });
      }
    }
  };
  instrument(x.body);
  return { reads: () => reads, ifs };
}

describe('if liveness', () => {
  test('a cascade of ifs chained through cells stays whole when its last cell is returned', () => {
    const x = cascadeIr(3, true);
    const out = check(x);
    expect(out).toBe(x); // nothing is dead: every if, cellset and condition chain survives
    expect(kinds(out.body).filter((k) => k === 'if' || k === 'cellset')).toEqual([
      'if',
      'cellset',
      'if',
      'cellset',
      'if',
      'cellset',
    ]);
  });

  test('the same cascade is dropped entirely when its last cell is never read', () => {
    expect(check(cascadeIr(3, false)).body).toEqual([]);
  });

  test('a throw three ifs deep keeps every enclosing if and its condition', () => {
    const x = nestedIr(3, () => mk({ k: 'throw', error: 0, args: [] }), {
      errors: [{ name: 'Deep', selector: '0x11223344', inputs: [] }],
    });
    const out = check(x);
    expect(kinds(out.body)).toEqual(['un', 'if', 'un', 'if', 'un', 'if', 'throw']);
  });

  test('a returned-cell write three ifs deep keeps every enclosing if; a dead one drops them', () => {
    const withCell = (returned: boolean): ScriptIr => {
      const x = nestedIr(3, () => mk({ k: 'cellset', cell: 0, value: 0 }));
      const read = x.values.length;
      return {
        ...x,
        values: [...x.values, vi('uint256')],
        cells: [vi('uint256')],
        body: [
          mk({ k: 'cellnew', cell: 0, init: 0 }),
          ...x.body,
          mk({ k: 'cellget', cell: 0, out: read }),
        ],
        returns: [{ name: 'r', type: 'uint256', value: returned ? read : 0 }],
      };
    };
    expect(kinds(check(withCell(true)).body)).toEqual([
      'cellnew',
      'un',
      'if',
      'un',
      'if',
      'un',
      'if',
      'cellset',
      'cellget',
    ]);
    expect(check(withCell(false)).body).toEqual([]);
  });

  test('an if around a while stays (the while is a seed); a dead if inside the loop goes', () => {
    // values: 0 a  1 cond(outer)  2 cond(inner)  3 dead
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('bool'), vi('bool'), vi('uint256')],
      body: [
        mk({ k: 'un', op: 'iszero', a: 0, out: 1 }),
        mk({
          k: 'if',
          cond: 1,
          then: [
            mk({
              k: 'while',
              header: [],
              cond: 1,
              body: [
                mk({ k: 'un', op: 'iszero', a: 1, out: 2 }),
                mk({ k: 'if', cond: 2, then: [constU(3, 1n)], else: [] }), // dead
                mk({ k: 'break' }),
              ],
            }),
          ],
          else: [],
        }),
      ],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    expect(kinds(check(x).body)).toEqual(['un', 'if', 'while', 'break']);
  });

  // The pass reaches branch contents only through `then`/`else`, so counting those reads bounds
  // its work: a constant per `if` (index, mutation bucketing, seeding, rebuild), however the
  // ifs are arranged. A per-round re-scan of every not-yet-live `if` grows with the depth of
  // the nest (each `if` re-walked from every ancestor) or the length of the cascade (one round
  // per link).
  test.each([
    [
      '200 nested ifs, only the innermost statement live',
      () =>
        nestedIr(200, () => mk({ k: 'throw', error: 0, args: [] }), {
          errors: [{ name: 'Deep', selector: '0x11223344', inputs: [] }],
        }),
    ],
    ['a 200-if cascade through cells', () => cascadeIr(200, true)],
  ])('branch reads stay linear in the number of ifs: %s', (_name, make) => {
    const x = make();
    const before = eliminateDeadCode(x); // the uninstrumented result, for comparison
    const counter = countBranchReads(x);
    const out = eliminateDeadCode(x);
    expect(counter.ifs).toBe(200);
    expect(counter.reads()).toBeLessThanOrEqual(16 * counter.ifs); // ~11 per if here
    expect(serializeIr(out)).toBe(serializeIr(before));
  });
});

// ---------------------------------------------------------------------------
// aliasing through composite values
// ---------------------------------------------------------------------------

describe('aliasing', () => {
  test('a tupleset through an index alias of a returned array stays', () => {
    // values: 0 pts(arg) 1 zero 2 elem(index alias) 3 v
    const x = ir({
      args: [{ name: 'pts', type: POINTS }],
      values: [vi(POINTS), vi('uint256'), vi(POINT), vi('uint256')],
      body: [
        constU(1, 0n),
        constU(3, 9n),
        mk({ k: 'index', arr: 0, i: 1, out: 2 }),
        mk({ k: 'tupleset', tuple: 2, index: 0, value: 3 }),
      ],
      returns: [{ name: 'pts', type: POINTS, value: 0 }],
    });
    expect(kinds(check(x).body)).toEqual(['const', 'const', 'index', 'tupleset']);
  });

  test('a tupleset on a tuplenew init stays when the outer tuple is returned', () => {
    const OUTER: EvsType = {
      type: 'tuple',
      components: [{ name: 'p', type: 'tuple', components: [{ name: 'x', type: 'uint256' }] }],
    };
    // values: 0 inner 1 outer 2 v 3 dead
    const x = ir({
      values: [vi(POINT), vi(OUTER), vi('uint256'), vi('uint256')],
      body: [
        constU(2, 5n),
        mk({ k: 'tuplenew', inits: [], out: 0 }),
        mk({ k: 'tuplenew', inits: [{ index: 0, value: 0 }], out: 1 }),
        mk({ k: 'tupleset', tuple: 0, index: 0, value: 2 }),
        mk({ k: 'bin', op: 'add', a: 2, b: 2, out: 3 }),
      ],
      returns: [{ name: 'o', type: OUTER, value: 1 }],
    });
    expect(kinds(check(x).body)).toEqual(['const', 'tuplenew', 'tuplenew', 'tupleset']);
  });

  test('a mutation of a dead allocation goes with it, but a live alias through a cell keeps it', () => {
    // values: 0 n 1 arr 2 zero 3 fromCell 4 dead arr 5 v
    const x = ir({
      args: [{ name: 'n', type: 'uint256' }],
      values: [
        vi('uint256'),
        vi('uint256[]'),
        vi('uint256'),
        vi('uint256[]'),
        vi('uint256[]'),
        vi('uint256'),
      ],
      cells: [vi('uint256[]')],
      body: [
        constU(2, 0n),
        constU(5, 1n),
        mk({ k: 'arrnew', elem: 'uint256', length: 0, out: 1 }),
        mk({ k: 'cellnew', cell: 0, init: 1 }),
        mk({ k: 'arrnew', elem: 'uint256', length: 0, out: 4 }),
        mk({ k: 'arrset', arr: 4, i: 2, value: 5 }), // dead allocation ⇒ dropped
        mk({ k: 'arrset', arr: 1, i: 2, value: 5 }), // aliased with the returned cellget ⇒ kept
        mk({ k: 'cellget', cell: 0, out: 3 }),
      ],
      returns: [{ name: 'r', type: 'uint256[]', value: 3 }],
    });
    expect(kinds(check(x).body)).toEqual([
      'const',
      'const',
      'arrnew',
      'cellnew',
      'arrset',
      'cellget',
    ]);
  });
});

// ---------------------------------------------------------------------------
// fns
// ---------------------------------------------------------------------------

describe('fns', () => {
  const fnValues = [vi('uint256'), vi('uint256'), vi('uint256'), vi('uint256'), vi('uint256')];
  // values: 0 a(arg) 1 p(param) 2 fn body out 3 fncall out 4 fn dead
  const pureFn = {
    name: 'double',
    params: [{ name: 'p', type: 'uint256' as const, value: 1 }],
    results: [{ type: 'uint256' as const }],
    body: [
      mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 }),
      mk({ k: 'bin', op: 'mul', a: 1, b: 1, out: 4 }), // dead inside the fn
    ],
    resultValues: [2],
  };

  test('a fncall to a pure fn with dead outs is dropped; the fn body is DCEd on its own', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: fnValues,
      fns: [pureFn],
      body: [mk({ k: 'fncall', fn: 0, args: [0], outs: [3] })],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    const out = check(x);
    expect(out.body).toEqual([]);
    expect(kinds(out.fns[0]?.body ?? [])).toEqual(['bin']);
    expect(out.fns[0]?.resultValues).toBe(pureFn.resultValues);
  });

  test('a fncall whose out is used stays, with its args', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: fnValues,
      fns: [pureFn],
      body: [mk({ k: 'fncall', fn: 0, args: [0], outs: [3] })],
      returns: [{ name: 'r', type: 'uint256', value: 3 }],
    });
    expect(kinds(check(x).body)).toEqual(['fncall']);
  });

  test('a fncall to an impure fn (a sub-call in its body) stays even with dead outs', () => {
    // values: 0 to(arg) 1 p(param) 2 call out 3 fncall out
    const x = ir({
      args: [{ name: 'to', type: ADDR }],
      values: [vi(ADDR), vi(ADDR), vi('uint256'), vi('uint256')],
      fns: [
        {
          name: 'probe',
          params: [{ name: 'p', type: ADDR, value: 1 }],
          results: [{ type: 'uint256' }],
          body: [
            mk({ k: 'call', target: 1, fnAbi: getterAbi, args: [], outs: [2], mode: 'strict' }),
          ],
          resultValues: [2],
        },
      ],
      body: [mk({ k: 'fncall', fn: 0, args: [0], outs: [3] })],
      returns: [],
    });
    expect(kinds(check(x).body)).toEqual(['fncall']);
  });

  test('impurity is transitive through fncalls, and a while makes a fn impure', () => {
    // values: 0 a(arg) 1 p(param of looper) 2 cond 3 q(param of wrapper) 4 wrapper out 5 main out
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [
        vi('uint256'),
        vi('uint256'),
        vi('bool'),
        vi('uint256'),
        vi('uint256'),
        vi('uint256'),
      ],
      fns: [
        {
          name: 'looper',
          params: [{ name: 'p', type: 'uint256', value: 1 }],
          results: [],
          body: [
            mk({
              k: 'while',
              header: [mk({ k: 'un', op: 'iszero', a: 1, out: 2 })],
              cond: 2,
              body: [mk({ k: 'break' })],
            }),
          ],
          resultValues: [],
        },
        {
          name: 'wrapper',
          params: [{ name: 'q', type: 'uint256', value: 3 }],
          results: [{ type: 'uint256' }],
          body: [mk({ k: 'fncall', fn: 0, args: [3], outs: [] })],
          resultValues: [3],
        },
      ],
      body: [mk({ k: 'fncall', fn: 1, args: [0], outs: [4] })],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    const out = check(x);
    expect(kinds(out.body)).toEqual(['fncall']);
    expect(kinds(out.fns[1]?.body ?? [])).toEqual(['fncall']);
  });

  test('a fn mutating memory aliased with a param is impure', () => {
    // a tupleset through a tuple param (an arrset may only target an arrnew in the same body)
    // values: 0 pt(arg) 1 p(param) 2 v 3 unused out
    const pt = { type: 'tuple', components: [{ name: 'x', type: 'uint256' }] } as const;
    const x = ir({
      args: [{ name: 'pt', type: pt }],
      values: [vi(pt), vi(pt), vi('uint256'), vi('uint256')],
      fns: [
        {
          name: 'poke',
          params: [{ name: 'p', type: pt, value: 1 }],
          results: [{ type: 'uint256' }],
          body: [constU(2, 1n), mk({ k: 'tupleset', tuple: 1, index: 0, value: 2 })],
          resultValues: [2],
        },
      ],
      body: [mk({ k: 'fncall', fn: 0, args: [0], outs: [3] })],
      returns: [{ name: 'pt', type: pt, value: 0 }],
    });
    const out = check(x);
    expect(kinds(out.body)).toEqual(['fncall']);
    expect(kinds(out.fns[0]?.body ?? [])).toEqual(['const', 'tupleset']);
  });
});

// ---------------------------------------------------------------------------
// the revert-guard decision (documented in the module doc)
// ---------------------------------------------------------------------------

describe('revert guards are not side effects', () => {
  test('a checked add that only fed a dead value is dropped: the overflow no longer panics', () => {
    const MAX = (1n << 256n) - 1n;
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('uint256')],
      body: [constU(1, MAX), mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 })],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    const out = check(x);
    expect(out.body).toEqual([]);
    // the recorded IR panics; what ships (and what interpret() runs by default) returns
    expect(interpret(x, [1n], NO_CHAIN, { dce: false }).outcome.kind).toBe('revert'); // Panic(0x11)
    for (const shipped of [interpret(out, [1n], NO_CHAIN), interpret(x, [1n], NO_CHAIN)]) {
      expect(shipped.outcome).toMatchObject({ kind: 'return', values: { a: 1n } });
    }
  });

  test('pow / mulmod / addmod are pure: dead ones go with their Panic 0x11 / 0x12 (issue #10)', () => {
    const MAX = (1n << 256n) - 1n;
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('uint256'), vi('uint256'), vi('uint256')],
      body: [
        constU(1, 0n),
        mk({ k: 'bin', op: 'pow', a: 0, b: 0, out: 2 }), // MAX ** MAX overflows
        mk({ k: 'modarith', op: 'mulmod', a: 0, b: 2, n: 1, out: 3 }), // modulus 0
        mk({ k: 'modarith', op: 'addmod', a: 0, b: 0, n: 1, out: 4 }), // modulus 0
      ],
      returns: [{ name: 'a', type: 'uint256', value: 0 }],
    });
    const out = check(x);
    expect(out.body).toEqual([]);
    expect(interpret(x, [MAX], NO_CHAIN, { dce: false }).outcome.kind).toBe('revert');
    expect(interpret(x, [MAX], NO_CHAIN).outcome).toMatchObject({
      kind: 'return',
      values: { a: MAX },
    });
    // a live one keeps its operands (and its guard)
    const live = ir({ ...x, returns: [{ name: 'r', type: 'uint256', value: 4 }] });
    expect(check(live).body).toEqual([live.body[0], live.body[3]]);
  });

  test('the same add feeding a return is untouched and keeps panicking', () => {
    const MAX = (1n << 256n) - 1n;
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('uint256')],
      body: [constU(1, MAX), mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 })],
      returns: [{ name: 'r', type: 'uint256', value: 2 }],
    });
    expect(check(x)).toBe(x);
    expect(interpret(x, [1n], NO_CHAIN).outcome.kind).toBe('revert');
    expect(interpret(x, [1n], NO_CHAIN, { dce: false }).outcome.kind).toBe('revert');
  });

  test('a dead pure s.fn call goes with the Panic inside it; interpret() follows compile()', () => {
    const script = evscript({ name: 'deadFn', args: [t.uint256] }, (s, a) => {
      const inc = s.fn('inc', [namedArg('x', t.uint256)] as const, (x) => x.add(1n));
      inc(a); // pure, result unused: dropped, and the overflow inside with it
      return s.return({ a });
    });
    const MAX = (1n << 256n) - 1n;
    expect(kinds(eliminateDeadCode(script.ir).body)).toEqual([]);
    expect(interpret(script.ir, [MAX], NO_CHAIN, { dce: false }).outcome.kind).toBe('revert');
    expect(interpret(script.ir, [MAX], NO_CHAIN).outcome).toMatchObject({
      kind: 'return',
      values: { a: MAX },
    });
  });

  test('trace paths index the IR that ran: dce(ir) by default, the recorded IR under dce: false', () => {
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('uint256'), vi('uint256')],
      body: [
        constU(1, 1n),
        mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 }), // dead
        mk({ k: 'bin', op: 'mul', a: 0, b: 1, out: 3 }), // returned
      ],
      returns: [{ name: 'r', type: 'uint256', value: 3 }],
    });
    const paths = (opts: { dce?: boolean }) =>
      interpret(x, [2n], NO_CHAIN, { ...opts, trace: true }).trace?.map((e) => e.stmtPath);
    expect(paths({})).toEqual([[0], [1]]);
    expect(paths({ dce: false })).toEqual([[0], [1], [2]]);
  });

  test('interpret() reuses the pass per frozen IR and re-runs it on a mutable one', () => {
    const MAX = (1n << 256n) - 1n;
    // returns `a`; the checked `a + 1` is dead until `returns` is pointed at it
    const returns: { name: string; type: EvsType; value: number }[] = [
      { name: 'r', type: 'uint256', value: 0 },
    ];
    const x = ir({
      args: [{ name: 'a', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256'), vi('uint256')],
      body: [constU(1, 1n), mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 })],
      returns,
    });
    expect(interpret(x, [MAX], NO_CHAIN).outcome.kind).toBe('return');
    returns[0] = { name: 'r', type: 'uint256', value: 2 }; // the add is live now
    expect(interpret(x, [MAX], NO_CHAIN).outcome.kind).toBe('revert'); // no stale dce(ir)
    // a frozen IR (recorded or deserialized) gets the same answer on every call
    returns[0] = { name: 'r', type: 'uint256', value: 0 };
    deepFreeze(x);
    for (let i = 0; i < 3; i++) {
      const run = interpret(x, [MAX], NO_CHAIN, { trace: true });
      expect(run.outcome.kind).toBe('return');
      expect(run.trace?.map((e) => e.stmtPath)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// builder-level: the forEach special case is gone, source maps survive the pass
// ---------------------------------------------------------------------------

describe('through compile()', () => {
  test('s.forEach without `elem` compiles byte-identically to the manual counter loop', () => {
    const counted = evscript({ name: 'counted', args: [t.array(t.uint256)] }, (s, xs) => {
      const count = s.let(t.uint256, 0n);
      s.forEach(xs, () => {
        count.set(count.get().add(1n));
      });
      return s.return({ count: count.get() });
    });
    const manual = evscript({ name: 'counted', args: [t.array(t.uint256)] }, (s, xs) => {
      const count = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: xs.length() }, () => {
        count.set(count.get().add(1n));
      });
      return s.return({ count: count.get() });
    });
    // recorded: one index in the forEach spelling, none in the manual one …
    expect(allStmts(counted.ir).filter((s) => s.k === 'index')).toHaveLength(1);
    expect(allStmts(manual.ir).filter((s) => s.k === 'index')).toHaveLength(0);
    // … compiled: the same bytes
    expect(compile(counted).runtimeBytecode).toBe(compile(manual).runtimeBytecode);
    expect(compile(counted).ir).toBe(counted.ir); // the artifact still carries the recorded IR
  });

  test('source-map lookups and revert explanations resolve after the pass', () => {
    const script = evscript({ name: 'guarded', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const dead = a.mul(b); // never read: dropped (its site never reaches the map)
      const live = a.add(b); // returned: its Panic(0x11) site must resolve
      void dead;
      return s.return({ live });
    });
    const compiled = compile(script);
    const optimized = eliminateDeadCode(script.ir);
    const liveSites = new Set(allStmts(optimized).map((s) => s.site));
    const droppedSites = allStmts(script.ir)
      .map((s) => s.site)
      .filter((id) => !liveSites.has(id));
    expect(droppedSites).toHaveLength(1);
    // every site in the map is a surviving statement; the dropped one is absent
    for (const site of compiled.sourceMap.sites) expect(liveSites.has(site.id)).toBe(true);
    expect(compiled.sourceMap.sites.some((site) => droppedSites.includes(site.id))).toBe(false);
    // every code byte still maps to a segment
    const last = compiled.sourceMap.segments.at(-1);
    expect(last).toBeDefined();
    expect(compiled.sourceMap.segments[0]?.pc).toBe(0);
    // the live add's overflow explanation points at its recorded site
    const panic11 = `0x4e487b71${(0x11).toString(16).padStart(64, '0')}` as const;
    const explained = compiled.explainRevert(panic11);
    expect(explained.kind).toBe('panic');
    expect(explained.candidateSites?.map((c) => c.id)).toContain(
      allStmts(optimized).find((s) => s.k === 'bin' && s.op === 'add')?.site,
    );
    expect(explained.candidateSites?.map((c) => c.id)).not.toContain(droppedSites[0]);
    expect(compiled.disassemble().format()).toContain('ADD');
  });
});
