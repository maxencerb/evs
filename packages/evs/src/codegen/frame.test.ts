/**
 * Unit tests — `codegen/frame.ts` (static frame layout).
 *
 * Default layout: slot-order expectations mirror the while-loop worked example: args first
 * (0x80…), then cells, then non-folded values in id order, then per-reachable-fn result
 * regions + return-address spill slots. Folded word consts → `slotOfValue === null`;
 * returned word consts keep a slot; uncalled fns get no region and no value slots.
 *
 * Liveness layout (`optimize: true`, issue #41): disjoint ranges share a slot, args / cells /
 * fn params never do, a value crossing a loop boundary keeps its slot for the whole loop, a
 * value read in one `if` branch stays live through the whole `if`, a `while` cond keeps its
 * slot until the check, fn pools never overlap the main pool, and `frameEnd` shrinks.
 */

import { describe, expect, test } from 'vite-plus/test';

import { EvsInternalError } from '../core/errors.js';
import type { ScriptIr, Stmt, ValueId } from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { fnReturnAddressSlot, layoutFrames } from './frame.js';

// ---------------------------------------------------------------------------
// raw IR fixtures
// ---------------------------------------------------------------------------

const W0 = `0x${'0'.repeat(64)}` as const;
const W1 = `0x${'0'.repeat(63)}1` as const;

/** A `Stmt` minus the bookkeeping the fixture fills in (distributed over the union). */
type StmtBody = Stmt extends infer s ? (s extends Stmt ? Omit<s, 'loc' | 'site'> : never) : never;

let nextSite = 100;
function st(body: StmtBody): Stmt {
  return { loc: null, site: nextSite++, ...body };
}

/** Loop-example IR: arg n; cells total, i; folded consts 0/1; loop values v1…v7; final get. */
function loopIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'sum',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256', loc: null }, // 0: arg n
      { type: 'uint256', loc: null }, // 1: const 0 (folded)
      { type: 'uint256', loc: null }, // 2: v1 = i.get
      { type: 'bool', loc: null }, // 3: v2 = lt
      { type: 'uint256', loc: null }, // 4: v3 = total.get
      { type: 'uint256', loc: null }, // 5: v4 = i.get
      { type: 'uint256', loc: null }, // 6: v5 = add
      { type: 'uint256', loc: null }, // 7: v6 = i.get
      { type: 'uint256', loc: null }, // 8: v7 = add
      { type: 'uint256', loc: null }, // 9: const 1 (folded)
      { type: 'uint256', loc: null }, // 10: total.get (returned)
    ],
    cells: [
      { type: 'uint256', loc: null }, // 0: total
      { type: 'uint256', loc: null }, // 1: i
    ],
    fns: [],
    body: [
      st({ k: 'const', out: 1, data: { kind: 'word', hex: W0 }, type: 'uint256' }),
      st({ k: 'cellnew', cell: 0, init: 1 }),
      st({ k: 'cellnew', cell: 1, init: 1 }),
      st({
        k: 'while',
        header: [
          st({ k: 'cellget', cell: 1, out: 2 }),
          st({ k: 'bin', op: 'lt', a: 2, b: 0, out: 3 }),
        ],
        cond: 3,
        body: [
          st({ k: 'cellget', cell: 0, out: 4 }),
          st({ k: 'cellget', cell: 1, out: 5 }),
          st({ k: 'bin', op: 'add', a: 4, b: 5, out: 6 }),
          st({ k: 'cellset', cell: 0, value: 6 }),
          st({ k: 'cellget', cell: 1, out: 7 }),
          st({ k: 'const', out: 9, data: { kind: 'word', hex: W1 }, type: 'uint256' }),
          st({ k: 'bin', op: 'add', a: 7, b: 9, out: 8 }),
          st({ k: 'cellset', cell: 1, value: 8 }),
        ],
      }),
      st({ k: 'cellget', cell: 0, out: 10 }),
    ],
    returns: [{ name: 'total', type: 'uint256', value: 10 }],
    loc: null,
  };
}

/** fn `double` (called) + fn `ghost` (uncalled). */
function fnIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'twice',
    args: [{ name: 'a', type: 'uint256' }],
    values: [
      { type: 'uint256', loc: null }, // 0: arg a
      { type: 'uint256', loc: null }, // 1: double param x
      { type: 'uint256', loc: null }, // 2: x + x
      { type: 'uint256', loc: null }, // 3: ghost param y
      { type: 'uint256', loc: null }, // 4: y + y
      { type: 'uint256', loc: null }, // 5: fncall out
    ],
    cells: [],
    fns: [
      {
        name: 'double',
        params: [{ name: 'x', type: 'uint256', value: 1 }],
        results: [{ type: 'uint256' }],
        body: [st({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 })],
        resultValues: [2],
        loc: null,
      },
      {
        name: 'ghost',
        params: [{ name: 'y', type: 'uint256', value: 3 }],
        results: [{ type: 'uint256' }],
        body: [st({ k: 'bin', op: 'add', a: 3, b: 3, out: 4 })],
        resultValues: [4],
        loc: null,
      },
    ],
    body: [st({ k: 'fncall', fn: 0, args: [0], outs: [5] })],
    returns: [{ name: 'r', type: 'uint256', value: 5 }],
    loc: null,
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('layoutFrames — slot ordering', () => {
  const ir = loopIr();
  const frame = layoutFrames(ir);

  test('fixture IR is valid', () => {
    expect(() => validateIr(ir)).not.toThrow();
  });

  test('args first, then cells, then values in id order', () => {
    expect(frame.slotOfValue(0)).toBe(0x80); // arg n
    expect(frame.slotOfCell(0)).toBe(0xa0); // total
    expect(frame.slotOfCell(1)).toBe(0xc0); // i
    expect(frame.slotOfValue(2)).toBe(0xe0); // v1
    expect(frame.slotOfValue(3)).toBe(0x100); // v2
    expect(frame.slotOfValue(4)).toBe(0x120);
    expect(frame.slotOfValue(5)).toBe(0x140);
    expect(frame.slotOfValue(6)).toBe(0x160);
    expect(frame.slotOfValue(7)).toBe(0x180);
    expect(frame.slotOfValue(8)).toBe(0x1a0); // v7
    expect(frame.slotOfValue(10)).toBe(0x1c0);
  });

  test('folded word consts have no slot', () => {
    expect(frame.slotOfValue(1)).toBeNull();
    expect(frame.slotOfValue(9)).toBeNull();
  });

  test('frameEnd = 0x80 + 32 × slotCount', () => {
    // 1 arg + 2 cells + 8 values = 11 slots
    expect(frame.frameEnd).toBe(0x80 + 32 * 11);
    expect(frame.frameEnd % 32).toBe(0);
  });

  test('layout is deterministic', () => {
    const again = layoutFrames(ir);
    for (let v = 0; v < ir.values.length; v++) {
      expect(again.slotOfValue(v)).toBe(frame.slotOfValue(v));
    }
    expect(again.slotOfCell(0)).toBe(frame.slotOfCell(0));
    expect(again.slotOfCell(1)).toBe(frame.slotOfCell(1));
    expect(again.frameEnd).toBe(frame.frameEnd);
  });

  test('unknown ids throw EvsInternalError', () => {
    expect(() => frame.slotOfValue(999)).toThrow(EvsInternalError);
    expect(() => frame.slotOfCell(7)).toThrow(EvsInternalError);
    expect(() => frame.fnRegion(0)).toThrow(EvsInternalError);
  });
});

describe('layoutFrames — fn regions', () => {
  const ir = fnIr();
  const frame = layoutFrames(ir);

  test('fixture IR is valid', () => {
    expect(() => validateIr(ir)).not.toThrow();
  });

  test('reachable fn: params alias the param value slots; results + ret slot come last', () => {
    // slots: arg(0)→0x80, param x(1)→0xA0, x+x(2)→0xC0, out(5)→0xE0,
    // then double's result region → 0x100, ret slot → 0x120
    expect(frame.slotOfValue(0)).toBe(0x80);
    expect(frame.slotOfValue(1)).toBe(0xa0);
    expect(frame.slotOfValue(2)).toBe(0xc0);
    expect(frame.slotOfValue(5)).toBe(0xe0);
    const region = frame.fnRegion(0);
    expect(region.params).toEqual([0xa0]);
    expect(region.results).toEqual([0x100]);
    expect(fnReturnAddressSlot(frame, 0)).toBe(0x120);
    expect(frame.frameEnd).toBe(0x140);
  });

  test('uncalled fn: no region, no value slots (dropped)', () => {
    expect(() => frame.fnRegion(1)).toThrow(EvsInternalError);
    expect(() => fnReturnAddressSlot(frame, 1)).toThrow(EvsInternalError);
    expect(() => frame.slotOfValue(3)).toThrow(EvsInternalError);
    expect(() => frame.slotOfValue(4)).toThrow(EvsInternalError);
  });
});

describe('layoutFrames — consts and returns', () => {
  test('a returned word const keeps a slot (return encoder reads memory)', () => {
    const ir: ScriptIr = {
      irVersion: 1,
      name: 'fortyTwo',
      args: [],
      values: [
        { type: 'uint256', loc: null }, // 0: const 42 (returned → slot)
        { type: 'uint256', loc: null }, // 1: const 7 (folded operand)
        { type: 'uint256', loc: null }, // 2: 42 + 7
      ],
      cells: [],
      fns: [],
      body: [
        st({
          k: 'const',
          out: 0,
          data: { kind: 'word', hex: `0x${'0'.repeat(62)}2a` },
          type: 'uint256',
        }),
        st({
          k: 'const',
          out: 1,
          data: { kind: 'word', hex: `0x${'0'.repeat(63)}7` },
          type: 'uint256',
        }),
        st({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 }),
      ],
      returns: [
        { name: 'c', type: 'uint256', value: 0 },
        { name: 's', type: 'uint256', value: 2 },
      ],
      loc: null,
    };
    validateIr(ir);
    const frame = layoutFrames(ir);
    expect(frame.slotOfValue(0)).toBe(0x80); // returned const — materialized
    expect(frame.slotOfValue(1)).toBeNull(); // pure operand — folded
    expect(frame.slotOfValue(2)).toBe(0xa0);
    expect(frame.frameEnd).toBe(0xc0);
  });

  test('dynamic (data) consts always get a slot — they hold the memref pointer', () => {
    const hello = `0x${'0'.repeat(62)}05${'68656c6c6f'.padEnd(64, '0')}` as const;
    const ir: ScriptIr = {
      irVersion: 1,
      name: 'hello',
      args: [],
      values: [{ type: 'string', loc: null }],
      cells: [],
      fns: [],
      body: [st({ k: 'const', out: 0, data: { kind: 'data', hex: hello }, type: 'string' })],
      returns: [{ name: 'greeting', type: 'string', value: 0 }],
      loc: null,
    };
    validateIr(ir);
    const frame = layoutFrames(ir);
    expect(frame.slotOfValue(0)).toBe(0x80);
    expect(frame.frameEnd).toBe(0xa0);
  });
});

// ---------------------------------------------------------------------------
// liveness allocator (optimize: true, issue #41)
// ---------------------------------------------------------------------------

const OPT = { optimize: true } as const;

/** Straight-line chain: env → v1; v2 = v1+v1; v3 = v2+v2; v4 = v3+v3 (returned). Arg unread. */
function chainIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'chain',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256', loc: null }, // 0: arg n (never read)
      { type: 'uint256', loc: null }, // 1: env timestamp
      { type: 'uint256', loc: null }, // 2: v1 + v1
      { type: 'uint256', loc: null }, // 3: v2 + v2
      { type: 'uint256', loc: null }, // 4: v3 + v3 (returned)
    ],
    cells: [],
    fns: [],
    body: [
      st({ k: 'env', op: 'timestamp', out: 1 }),
      st({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 }),
      st({ k: 'bin', op: 'add', a: 2, b: 2, out: 3 }),
      st({ k: 'bin', op: 'add', a: 3, b: 3, out: 4 }),
    ],
    returns: [{ name: 'r', type: 'uint256', value: 4 }],
    loc: null,
  };
}

/** Overlapping + disjoint ranges: v1, v2 live together; v3 = v1+v2; v4; v5 = v3+v4. */
function overlapIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'overlap',
    args: [],
    values: [
      { type: 'uint256', loc: null }, // 0: env          [0, 2]
      { type: 'uint256', loc: null }, // 1: env          [1, 2]
      { type: 'uint256', loc: null }, // 2: v0 + v1      [2, 4]
      { type: 'uint256', loc: null }, // 3: env          [3, 4]
      { type: 'uint256', loc: null }, // 4: v2 + v3      [4, end] (returned)
    ],
    cells: [],
    fns: [],
    body: [
      st({ k: 'env', op: 'timestamp', out: 0 }),
      st({ k: 'env', op: 'blocknumber', out: 1 }),
      st({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 }),
      st({ k: 'env', op: 'chainid', out: 3 }),
      st({ k: 'bin', op: 'add', a: 2, b: 3, out: 4 }),
    ],
    returns: [{ name: 'r', type: 'uint256', value: 4 }],
    loc: null,
  };
}

/** A strict call with two outs, then their sum. */
function twoOutsIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'pair',
    args: [{ name: 'target', type: 'address' }],
    values: [
      { type: 'address', loc: null }, // 0: arg target
      { type: 'uint256', loc: null }, // 1: out a
      { type: 'uint256', loc: null }, // 2: out b
      { type: 'uint256', loc: null }, // 3: a + b (returned)
    ],
    cells: [],
    fns: [],
    body: [
      st({
        k: 'call',
        target: 0,
        fnAbi: {
          name: 'pair',
          selector: '0x1e2f3a4b',
          inputs: [],
          outputs: [
            { name: 'a', type: 'uint256' },
            { name: 'b', type: 'uint256' },
          ],
        },
        args: [],
        outs: [1, 2],
        mode: 'strict',
      }),
      st({ k: 'bin', op: 'add', a: 1, b: 2, out: 3 }),
    ],
    returns: [{ name: 'sum', type: 'uint256', value: 3 }],
    loc: null,
  };
}

/**
 * Loop-carried: `outer` (env, defined before the loop) is read inside the body; the body's
 * last statement defines a fresh value (`v8`), which must NOT take `outer`'s slot.
 *
 *   pos 0  const 0 (folded)          pos 7  body: cellget i → v5
 *   pos 1  cellnew i                 pos 8        v6 = v5 + outer   (reads outer)
 *   pos 2  env → outer (v2)          pos 9        cellset i ← v6
 *   pos 3  while                     pos 10       env → v7
 *   pos 4    header: cellget i → v3  pos 11       v8 = v7 + v7      (last loop position)
 *   pos 5            v4 = v3 < n     pos 12 cellget i → v9 (returned)
 *   pos 6    cond v4 (own position)
 */
function carriedIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'carried',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256', loc: null }, // 0: arg n
      { type: 'uint256', loc: null }, // 1: const 0 (folded)
      { type: 'uint256', loc: null }, // 2: outer = env
      { type: 'uint256', loc: null }, // 3: header cellget i
      { type: 'bool', loc: null }, // 4: cond
      { type: 'uint256', loc: null }, // 5: body cellget i
      { type: 'uint256', loc: null }, // 6: v5 + outer
      { type: 'uint256', loc: null }, // 7: env
      { type: 'uint256', loc: null }, // 8: v7 + v7 (defined at the loop's last position)
      { type: 'uint256', loc: null }, // 9: cellget i after the loop (returned)
    ],
    cells: [{ type: 'uint256', loc: null }],
    fns: [],
    body: [
      st({ k: 'const', out: 1, data: { kind: 'word', hex: W0 }, type: 'uint256' }),
      st({ k: 'cellnew', cell: 0, init: 1 }),
      st({ k: 'env', op: 'timestamp', out: 2 }),
      st({
        k: 'while',
        header: [
          st({ k: 'cellget', cell: 0, out: 3 }),
          st({ k: 'bin', op: 'lt', a: 3, b: 0, out: 4 }),
        ],
        cond: 4,
        body: [
          st({ k: 'cellget', cell: 0, out: 5 }),
          st({ k: 'bin', op: 'add', a: 5, b: 2, out: 6 }),
          st({ k: 'cellset', cell: 0, value: 6 }),
          st({ k: 'env', op: 'blocknumber', out: 7 }),
          st({ k: 'bin', op: 'add', a: 7, b: 7, out: 8 }),
        ],
      }),
      st({ k: 'cellget', cell: 0, out: 9 }),
    ],
    returns: [{ name: 'i', type: 'uint256', value: 9 }],
    loc: null,
  };
}

/** A header value defined AFTER the cond (v4) must not take the cond's slot before the check. */
function condIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'cond',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256', loc: null }, // 0: arg n
      { type: 'uint256', loc: null }, // 1: const 0 (folded)
      { type: 'uint256', loc: null }, // 2: header cellget i
      { type: 'bool', loc: null }, // 3: cond = v2 < n
      { type: 'uint256', loc: null }, // 4: header env after the cond (unread)
      { type: 'uint256', loc: null }, // 5: body v2 + v2
      { type: 'uint256', loc: null }, // 6: cellget after the loop (returned)
    ],
    cells: [{ type: 'uint256', loc: null }],
    fns: [],
    body: [
      st({ k: 'const', out: 1, data: { kind: 'word', hex: W0 }, type: 'uint256' }),
      st({ k: 'cellnew', cell: 0, init: 1 }),
      st({
        k: 'while',
        header: [
          st({ k: 'cellget', cell: 0, out: 2 }),
          st({ k: 'bin', op: 'lt', a: 2, b: 0, out: 3 }),
          st({ k: 'env', op: 'timestamp', out: 4 }),
        ],
        cond: 3,
        body: [
          st({ k: 'bin', op: 'add', a: 2, b: 2, out: 5 }),
          st({ k: 'cellset', cell: 0, value: 5 }),
        ],
      }),
      st({ k: 'cellget', cell: 0, out: 6 }),
    ],
    returns: [{ name: 'i', type: 'uint256', value: 6 }],
    loc: null,
  };
}

/**
 * `if`: v0 (env) is read only in the then-branch; the else-branch defines v3, which must not
 * take v0's slot (v0 is live through the whole `if`); after the `if`, v4 may.
 */
function branchIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'branch',
    args: [],
    values: [
      { type: 'uint256', loc: null }, // 0: env                 (read in then only)
      { type: 'bool', loc: null }, // 1: v0 < v0 (cond)
      { type: 'uint256', loc: null }, // 2: then: v0 + v0
      { type: 'uint256', loc: null }, // 3: else: env
      { type: 'uint256', loc: null }, // 4: after: env (returned)
    ],
    cells: [],
    fns: [],
    body: [
      st({ k: 'env', op: 'timestamp', out: 0 }),
      st({ k: 'bin', op: 'lt', a: 0, b: 0, out: 1 }),
      st({
        k: 'if',
        cond: 1,
        // oxlint-disable-next-line unicorn/no-thenable -- the IR names the if-branch field `then`
        then: [st({ k: 'bin', op: 'add', a: 0, b: 0, out: 2 })],
        else: [st({ k: 'env', op: 'blocknumber', out: 3 })],
      }),
      st({ k: 'env', op: 'chainid', out: 4 }),
    ],
    returns: [{ name: 'r', type: 'uint256', value: 4 }],
    loc: null,
  };
}

/** fn `chain3(x)` = ((x+x)+(x+x))+…: a chain inside the fn; a main temporary live across the call. */
function fnChainIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'fnchain',
    args: [{ name: 'a', type: 'uint256' }],
    values: [
      { type: 'uint256', loc: null }, // 0: arg a
      { type: 'uint256', loc: null }, // 1: param x
      { type: 'uint256', loc: null }, // 2: x + x
      { type: 'uint256', loc: null }, // 3: v2 + v2
      { type: 'uint256', loc: null }, // 4: v3 + v3 (fn result)
      { type: 'uint256', loc: null }, // 5: fncall out
      { type: 'uint256', loc: null }, // 6: main env (live across the call)
      { type: 'uint256', loc: null }, // 7: v5 + v6 (returned)
    ],
    cells: [],
    fns: [
      {
        name: 'chain3',
        params: [{ name: 'x', type: 'uint256', value: 1 }],
        results: [{ type: 'uint256' }],
        body: [
          st({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 }),
          st({ k: 'bin', op: 'add', a: 2, b: 2, out: 3 }),
          st({ k: 'bin', op: 'add', a: 3, b: 3, out: 4 }),
        ],
        resultValues: [4],
        loc: null,
      },
    ],
    body: [
      st({ k: 'env', op: 'timestamp', out: 6 }),
      st({ k: 'fncall', fn: 0, args: [0], outs: [5] }),
      st({ k: 'bin', op: 'add', a: 5, b: 6, out: 7 }),
    ],
    returns: [{ name: 'r', type: 'uint256', value: 7 }],
    loc: null,
  };
}

describe('layoutFrames — liveness allocator (optimize: true, issue #41)', () => {
  test('every fixture IR is valid', () => {
    for (const ir of [
      chainIr(),
      overlapIr(),
      twoOutsIr(),
      carriedIr(),
      condIr(),
      branchIr(),
      fnChainIr(),
    ]) {
      expect(() => validateIr(ir)).not.toThrow();
    }
  });

  test('the default layout is untouched: layoutFrames(ir) ≡ layoutFrames(ir, { optimize: false })', () => {
    for (const ir of [loopIr(), fnIr(), carriedIr(), fnChainIr()]) {
      const plain = layoutFrames(ir);
      const explicit = layoutFrames(ir, { optimize: false });
      for (let v = 0; v < ir.values.length; v++) {
        let a: number | null | 'none' = 'none';
        let b: number | null | 'none' = 'none';
        try {
          a = plain.slotOfValue(v);
        } catch {
          /* uncalled-fn value */
        }
        try {
          b = explicit.slotOfValue(v);
        } catch {
          /* uncalled-fn value */
        }
        expect(b).toBe(a);
      }
      expect(explicit.frameEnd).toBe(plain.frameEnd);
    }
  });

  test('a straight-line chain of temporaries shares ONE slot; frameEnd shrinks', () => {
    const ir = chainIr();
    const plain = layoutFrames(ir);
    const frame = layoutFrames(ir, OPT);
    expect(frame.slotOfValue(0)).toBe(0x80); // arg — dedicated even though never read
    expect(frame.slotOfValue(1)).toBe(0xa0);
    expect(frame.slotOfValue(2)).toBe(0xa0); // v1's last read is the statement defining v2
    expect(frame.slotOfValue(3)).toBe(0xa0);
    expect(frame.slotOfValue(4)).toBe(0xa0); // read by the return encoder after the body
    expect(frame.frameEnd).toBe(0xc0); // 2 slots
    expect(plain.frameEnd).toBe(0x80 + 32 * 5);
  });

  test('disjoint ranges share a slot, overlapping ranges never do', () => {
    const frame = layoutFrames(overlapIr(), OPT);
    const [s0, s1, s2, s3, s4] = [0, 1, 2, 3, 4].map((v) => frame.slotOfValue(v));
    expect(s0).toBe(0x80);
    expect(s1).toBe(0xa0); // v0 still live
    expect(s2).toBe(0x80); // v0 and v1 both die at the add → lowest freed slot
    expect(s3).toBe(0xa0); // v2 live → the other freed slot
    expect(s4).toBe(0x80);
    expect(frame.frameEnd).toBe(0xc0);
  });

  test('two outputs of the same statement never share a slot', () => {
    const frame = layoutFrames(twoOutsIr(), OPT);
    expect(frame.slotOfValue(1)).toBe(0xa0);
    expect(frame.slotOfValue(2)).toBe(0xc0);
    expect(frame.slotOfValue(3)).toBe(0xa0); // both outs die at the add
    expect(frame.frameEnd).toBe(0xe0);
  });

  test('LOCK: a value read inside a loop keeps its slot for the whole loop (back-edge safe)', () => {
    const ir = carriedIr();
    const frame = layoutFrames(ir, OPT);
    const outer = frame.slotOfValue(2);
    expect(outer).toBe(0xc0); // after arg (0x80) and cell (0xa0)
    // no value defined anywhere inside the loop — including the body's LAST statement, whose
    // template stores after the widened range's boundary — may take `outer`'s slot
    for (const v of [3, 4, 5, 6, 7, 8]) {
      expect(frame.slotOfValue(v), `loop value ${v}`).not.toBe(outer);
      expect(frame.slotOfValue(v)).toBe(0xe0); // they all chain through one other slot
    }
    // after the loop `outer` is dead: the next value takes its slot
    expect(frame.slotOfValue(9)).toBe(outer);
    expect(frame.frameEnd).toBe(0x100); // arg + cell + 2 pool slots
    expect(layoutFrames(ir).frameEnd).toBe(0x80 + 32 * 10);
  });

  test('LOCK: a while cond keeps its slot until the check, past later header statements', () => {
    const frame = layoutFrames(condIr(), OPT);
    const cond = frame.slotOfValue(3);
    expect(frame.slotOfValue(4)).not.toBe(cond); // header value after the cond
    expect(frame.slotOfValue(4)).not.toBe(frame.slotOfValue(2)); // `i` is still read in the body
    expect(frame.slotOfValue(5)).toBe(frame.slotOfValue(2)); // body: v2's last read defines v5
    expect(frame.frameEnd).toBe(0x120); // arg, cell, v2, cond, v4
  });

  test('LOCK: a value read in one if-branch stays live through the whole if', () => {
    const frame = layoutFrames(branchIr(), OPT);
    const v0 = frame.slotOfValue(0);
    expect(v0).toBe(0x80);
    expect(frame.slotOfValue(1)).toBe(0xa0);
    expect(frame.slotOfValue(2)).toBe(0xa0); // then-branch temp: the cond is dead
    expect(frame.slotOfValue(3)).not.toBe(v0); // else-branch value: v0 still reserved
    expect(frame.slotOfValue(3)).toBe(0xa0); // exclusive branches share
    expect(frame.slotOfValue(4)).toBe(v0); // after the if v0 is dead
    expect(frame.frameEnd).toBe(0xc0);
  });

  test('LOCK: args and cells are dedicated — no value ever lands on their slots', () => {
    for (const ir of [chainIr(), carriedIr(), condIr(), loopIr(), fnChainIr()]) {
      const frame = layoutFrames(ir, OPT);
      const pinned = new Set<number>();
      for (let i = 0; i < ir.args.length; i++) pinned.add(frame.slotOfValue(i) ?? -1);
      for (let c = 0; c < ir.cells.length; c++) pinned.add(frame.slotOfCell(c));
      const clashes: ValueId[] = [];
      for (let v = ir.args.length; v < ir.values.length; v++) {
        let slot: number | null = null;
        try {
          slot = frame.slotOfValue(v);
        } catch {
          continue; // uncalled-fn value
        }
        if (slot !== null && pinned.has(slot)) clashes.push(v);
      }
      expect(clashes, `${ir.name}: values on pinned slots`).toEqual([]);
    }
  });

  test('fn frames: params dedicated, the fn pool packs its chain, never overlapping the main pool', () => {
    const ir = fnChainIr();
    const frame = layoutFrames(ir, OPT);
    // main: arg 0x80; env (v6) 0xa0; fncall out (v5) 0xc0 (v6 live across the call); v7 → 0xa0
    expect(frame.slotOfValue(6)).toBe(0xa0);
    expect(frame.slotOfValue(5)).toBe(0xc0);
    expect(frame.slotOfValue(7)).toBe(0xa0);
    // fn chain3: param x pinned at 0xe0, its three temporaries share 0x100, results, ret slot
    const region = frame.fnRegion(0);
    expect(region.params).toEqual([0xe0]);
    expect(frame.slotOfValue(1)).toBe(0xe0);
    expect(frame.slotOfValue(2)).toBe(0x100);
    expect(frame.slotOfValue(3)).toBe(0x100);
    expect(frame.slotOfValue(4)).toBe(0x100);
    expect(region.results).toEqual([0x120]);
    expect(fnReturnAddressSlot(frame, 0)).toBe(0x140);
    expect(frame.frameEnd).toBe(0x160);
    expect(layoutFrames(ir).frameEnd).toBe(0x1c0);
    // the simple fn fixture: same shape, uncalled fn still dropped
    const simple = layoutFrames(fnIr(), OPT);
    expect(simple.fnRegion(0).params).toEqual([0xc0]);
    expect(simple.slotOfValue(2)).toBe(0xe0);
    expect(simple.slotOfValue(5)).toBe(0xa0);
    expect(() => simple.fnRegion(1)).toThrow(EvsInternalError);
    expect(() => simple.slotOfValue(3)).toThrow(EvsInternalError);
  });

  test('folded consts stay folded; returned consts keep a slot; layout is deterministic', () => {
    const ir = loopIr();
    const frame = layoutFrames(ir, OPT);
    expect(frame.slotOfValue(1)).toBeNull();
    expect(frame.slotOfValue(9)).toBeNull();
    expect(frame.slotOfValue(0)).toBe(0x80);
    expect(frame.slotOfCell(0)).toBe(0xa0);
    expect(frame.slotOfCell(1)).toBe(0xc0);
    expect(frame.frameEnd).toBeLessThan(layoutFrames(ir).frameEnd);
    const again = layoutFrames(ir, OPT);
    for (let v = 0; v < ir.values.length; v++) {
      expect(again.slotOfValue(v)).toBe(frame.slotOfValue(v));
    }
    expect(again.frameEnd).toBe(frame.frameEnd);
  });
});
