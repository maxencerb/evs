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
 * slot until the check, fn pools never overlap the main pool, and `frameEnd` shrinks. Nested
 * regions widen in cascade, a range spanning a whole `if` / `while` gives up its end-of-range
 * handoff, and a seeded differential holds the allocator slot for slot to a naive reference
 * model of the same rules.
 */

import { describe, expect, test } from 'vite-plus/test';

import { EvsInternalError } from '../core/errors.js';
import {
  stmtDefs,
  stmtReads,
  type ScriptIr,
  type Stmt,
  type ValueId,
  type ValueInfo,
} from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { fnReturnAddressSlot, layoutFrames } from './frame.js';

// ---------------------------------------------------------------------------
// raw IR fixtures
// ---------------------------------------------------------------------------

const W0 = `0x${'0'.repeat(64)}` as const;
const W1 = `0x${'0'.repeat(63)}1` as const;

/** A `Stmt` minus the bookkeeping the fixture fills in (distributed over the union). */
type StmtBody = Stmt extends infer s ? (s extends Stmt ? Omit<s, 'site'> : never) : never;

let nextSite = 100;
function st(body: StmtBody): Stmt {
  return { site: nextSite++, ...body };
}

/** Loop-example IR: arg n; cells total, i; folded consts 0/1; loop values v1…v7; final get. */
function loopIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'sum',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256' }, // 0: arg n
      { type: 'uint256' }, // 1: const 0 (folded)
      { type: 'uint256' }, // 2: v1 = i.get
      { type: 'bool' }, // 3: v2 = lt
      { type: 'uint256' }, // 4: v3 = total.get
      { type: 'uint256' }, // 5: v4 = i.get
      { type: 'uint256' }, // 6: v5 = add
      { type: 'uint256' }, // 7: v6 = i.get
      { type: 'uint256' }, // 8: v7 = add
      { type: 'uint256' }, // 9: const 1 (folded)
      { type: 'uint256' }, // 10: total.get (returned)
    ],
    cells: [
      { type: 'uint256' }, // 0: total
      { type: 'uint256' }, // 1: i
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
  };
}

/** fn `double` (called) + fn `ghost` (uncalled). */
function fnIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'twice',
    args: [{ name: 'a', type: 'uint256' }],
    values: [
      { type: 'uint256' }, // 0: arg a
      { type: 'uint256' }, // 1: double param x
      { type: 'uint256' }, // 2: x + x
      { type: 'uint256' }, // 3: ghost param y
      { type: 'uint256' }, // 4: y + y
      { type: 'uint256' }, // 5: fncall out
    ],
    cells: [],
    fns: [
      {
        name: 'double',
        params: [{ name: 'x', type: 'uint256', value: 1 }],
        results: [{ type: 'uint256' }],
        body: [st({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 })],
        resultValues: [2],
      },
      {
        name: 'ghost',
        params: [{ name: 'y', type: 'uint256', value: 3 }],
        results: [{ type: 'uint256' }],
        body: [st({ k: 'bin', op: 'add', a: 3, b: 3, out: 4 })],
        resultValues: [4],
      },
    ],
    body: [st({ k: 'fncall', fn: 0, args: [0], outs: [5] })],
    returns: [{ name: 'r', type: 'uint256', value: 5 }],
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
        { type: 'uint256' }, // 0: const 42 (returned → slot)
        { type: 'uint256' }, // 1: const 7 (folded operand)
        { type: 'uint256' }, // 2: 42 + 7
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
      values: [{ type: 'string' }],
      cells: [],
      fns: [],
      body: [st({ k: 'const', out: 0, data: { kind: 'data', hex: hello }, type: 'string' })],
      returns: [{ name: 'greeting', type: 'string', value: 0 }],
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
      { type: 'uint256' }, // 0: arg n (never read)
      { type: 'uint256' }, // 1: env timestamp
      { type: 'uint256' }, // 2: v1 + v1
      { type: 'uint256' }, // 3: v2 + v2
      { type: 'uint256' }, // 4: v3 + v3 (returned)
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
  };
}

/** Overlapping + disjoint ranges: v1, v2 live together; v3 = v1+v2; v4; v5 = v3+v4. */
function overlapIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'overlap',
    args: [],
    values: [
      { type: 'uint256' }, // 0: env          [0, 2]
      { type: 'uint256' }, // 1: env          [1, 2]
      { type: 'uint256' }, // 2: v0 + v1      [2, 4]
      { type: 'uint256' }, // 3: env          [3, 4]
      { type: 'uint256' }, // 4: v2 + v3      [4, end] (returned)
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
  };
}

/** A strict call with two outs, then their sum. */
function twoOutsIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'pair',
    args: [{ name: 'target', type: 'address' }],
    values: [
      { type: 'address' }, // 0: arg target
      { type: 'uint256' }, // 1: out a
      { type: 'uint256' }, // 2: out b
      { type: 'uint256' }, // 3: a + b (returned)
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
      { type: 'uint256' }, // 0: arg n
      { type: 'uint256' }, // 1: const 0 (folded)
      { type: 'uint256' }, // 2: outer = env
      { type: 'uint256' }, // 3: header cellget i
      { type: 'bool' }, // 4: cond
      { type: 'uint256' }, // 5: body cellget i
      { type: 'uint256' }, // 6: v5 + outer
      { type: 'uint256' }, // 7: env
      { type: 'uint256' }, // 8: v7 + v7 (defined at the loop's last position)
      { type: 'uint256' }, // 9: cellget i after the loop (returned)
    ],
    cells: [{ type: 'uint256' }],
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
  };
}

/** A header value defined AFTER the cond (v4) must not take the cond's slot before the check. */
function condIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'cond',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256' }, // 0: arg n
      { type: 'uint256' }, // 1: const 0 (folded)
      { type: 'uint256' }, // 2: header cellget i
      { type: 'bool' }, // 3: cond = v2 < n
      { type: 'uint256' }, // 4: header env after the cond (unread)
      { type: 'uint256' }, // 5: body v2 + v2
      { type: 'uint256' }, // 6: cellget after the loop (returned)
    ],
    cells: [{ type: 'uint256' }],
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
      { type: 'uint256' }, // 0: env                 (read in then only)
      { type: 'bool' }, // 1: v0 < v0 (cond)
      { type: 'uint256' }, // 2: then: v0 + v0
      { type: 'uint256' }, // 3: else: env
      { type: 'uint256' }, // 4: after: env (returned)
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
  };
}

/** fn `chain3(x)` = ((x+x)+(x+x))+…: a chain inside the fn; a main temporary live across the call. */
function fnChainIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'fnchain',
    args: [{ name: 'a', type: 'uint256' }],
    values: [
      { type: 'uint256' }, // 0: arg a
      { type: 'uint256' }, // 1: param x
      { type: 'uint256' }, // 2: x + x
      { type: 'uint256' }, // 3: v2 + v2
      { type: 'uint256' }, // 4: v3 + v3 (fn result)
      { type: 'uint256' }, // 5: fncall out
      { type: 'uint256' }, // 6: main env (live across the call)
      { type: 'uint256' }, // 7: v5 + v6 (returned)
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
      },
    ],
    body: [
      st({ k: 'env', op: 'timestamp', out: 6 }),
      st({ k: 'fncall', fn: 0, args: [0], outs: [5] }),
      st({ k: 'bin', op: 'add', a: 5, b: 6, out: 7 }),
    ],
    returns: [{ name: 'r', type: 'uint256', value: 7 }],
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

// ---------------------------------------------------------------------------
// liveness allocator — nested regions, spanned regions (the `widened` flag)
// ---------------------------------------------------------------------------

/**
 * `v1` is defined before an `if` (or a `while`, or nothing) placed between it and its real last
 * read `v4 = v1 + v1`. `between` builds the statement(s) between; values 2… are theirs.
 */
function spanIr(between: 'nothing' | 'if' | 'while'): ScriptIr {
  const values: ValueInfo[] = [
    { type: 'uint256' }, // 0: arg n
    { type: 'uint256' }, // 1: v1 = env (spans `between`)
    { type: 'uint256' }, // 2: v4 = v1 + v1 (returned)
  ];
  const fresh = (type: 'uint256' | 'bool'): ValueId => values.push({ type }) - 1;
  const body: Stmt[] = [
    st({ k: 'cellnew', cell: 0, init: 0 }),
    st({ k: 'env', op: 'timestamp', out: 1 }),
  ];
  if (between === 'if') {
    const cond = fresh('bool');
    body.push(st({ k: 'bin', op: 'lt', a: 0, b: 0, out: cond }));
    body.push(
      st({
        k: 'if',
        cond,
        // oxlint-disable-next-line unicorn/no-thenable -- the IR names the if-branch field `then`
        then: [st({ k: 'env', op: 'chainid', out: fresh('uint256') })],
        else: [],
      }),
    );
  } else if (between === 'while') {
    const i = fresh('uint256');
    const cond = fresh('bool');
    body.push(
      st({
        k: 'while',
        header: [
          st({ k: 'cellget', cell: 0, out: i }),
          st({ k: 'bin', op: 'lt', a: i, b: 0, out: cond }),
        ],
        cond,
        body: [st({ k: 'cellset', cell: 0, value: i })],
      }),
    );
  }
  body.push(st({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 }));
  return {
    irVersion: 1,
    name: `span-${between}`,
    args: [{ name: 'n', type: 'uint256' }],
    values,
    cells: [{ type: 'uint256' }],
    fns: [],
    body,
    returns: [{ name: 'r', type: 'uint256', value: 2 }],
  };
}

/**
 * Cascading widening: `v1` is read in a loop nested in an `if` branch — widened to the loop,
 * which then crosses into the `if`, so it stays live through the else-branch too.
 *
 *   pos 0  cellnew c ← n            pos 6           v4 = v3 < n
 *   pos 1  env → v1                 pos 7         cond v4
 *   pos 2  v2 = n < n               pos 8         body: v5 = v3 + v1   (v1's last read)
 *   pos 3  if v2                    pos 9               cellset c ← v5
 *   pos 4    then: while            pos 10   else: env → v6
 *   pos 5            cellget c → v3 pos 11 env → v7 (returned)
 */
function cascadeIr(): ScriptIr {
  return {
    irVersion: 1,
    name: 'cascade',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256' }, // 0: arg n
      { type: 'uint256' }, // 1: v1 = env
      { type: 'bool' }, // 2: if cond
      { type: 'uint256' }, // 3: header cellget c
      { type: 'bool' }, // 4: loop cond
      { type: 'uint256' }, // 5: v3 + v1
      { type: 'uint256' }, // 6: else-branch env
      { type: 'uint256' }, // 7: after the if (returned)
    ],
    cells: [{ type: 'uint256' }],
    fns: [],
    body: [
      st({ k: 'cellnew', cell: 0, init: 0 }),
      st({ k: 'env', op: 'timestamp', out: 1 }),
      st({ k: 'bin', op: 'lt', a: 0, b: 0, out: 2 }),
      st({
        k: 'if',
        cond: 2,
        // oxlint-disable-next-line unicorn/no-thenable -- the IR names the if-branch field `then`
        then: [
          st({
            k: 'while',
            header: [
              st({ k: 'cellget', cell: 0, out: 3 }),
              st({ k: 'bin', op: 'lt', a: 3, b: 0, out: 4 }),
            ],
            cond: 4,
            body: [
              st({ k: 'bin', op: 'add', a: 3, b: 1, out: 5 }),
              st({ k: 'cellset', cell: 0, value: 5 }),
            ],
          }),
        ],
        else: [st({ k: 'env', op: 'chainid', out: 6 })],
      }),
      st({ k: 'env', op: 'blocknumber', out: 7 }),
    ],
    returns: [{ name: 'r', type: 'uint256', value: 7 }],
  };
}

/**
 * Nested loops: `v3`, defined in the outer body, is read only inside the inner loop — widened
 * to the inner loop, NOT to the outer one, so `v7` (after the inner loop) may take its slot.
 *
 *   pos 0  cellnew c ← n                 pos 7    header: cellget c → v4
 *   pos 1  while                         pos 8            v5 = v4 < n
 *   pos 2    header: cellget c → v1      pos 9    cond v5
 *   pos 3            v2 = v1 < n         pos 10   body: v6 = v4 + v3
 *   pos 4    cond v2                     pos 11         cellset c ← v6
 *   pos 5    body: env → v3              pos 12   env → v7 (unread)
 *   pos 6          while                 pos 13 cellget c → v8 (returned)
 */
function nestedLoopsIr(): ScriptIr {
  const innerLoop = st({
    k: 'while',
    header: [st({ k: 'cellget', cell: 0, out: 4 }), st({ k: 'bin', op: 'lt', a: 4, b: 0, out: 5 })],
    cond: 5,
    body: [
      st({ k: 'bin', op: 'add', a: 4, b: 3, out: 6 }),
      st({ k: 'cellset', cell: 0, value: 6 }),
    ],
  });
  return {
    irVersion: 1,
    name: 'nested',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      { type: 'uint256' }, // 0: arg n
      { type: 'uint256' }, // 1: outer header cellget
      { type: 'bool' }, // 2: outer cond
      { type: 'uint256' }, // 3: outer body env (read in the inner loop)
      { type: 'uint256' }, // 4: inner header cellget
      { type: 'bool' }, // 5: inner cond
      { type: 'uint256' }, // 6: v4 + v3
      { type: 'uint256' }, // 7: outer body env after the inner loop
      { type: 'uint256' }, // 8: cellget after the loops (returned)
    ],
    cells: [{ type: 'uint256' }],
    fns: [],
    body: [
      st({ k: 'cellnew', cell: 0, init: 0 }),
      st({
        k: 'while',
        header: [
          st({ k: 'cellget', cell: 0, out: 1 }),
          st({ k: 'bin', op: 'lt', a: 1, b: 0, out: 2 }),
        ],
        cond: 2,
        body: [
          st({ k: 'env', op: 'timestamp', out: 3 }),
          innerLoop,
          st({ k: 'env', op: 'chainid', out: 7 }),
        ],
      }),
      st({ k: 'cellget', cell: 0, out: 8 }),
    ],
    returns: [{ name: 'r', type: 'uint256', value: 8 }],
  };
}

describe('layoutFrames — liveness allocator: nested and spanned regions', () => {
  test('every fixture IR is valid', () => {
    for (const ir of [
      spanIr('nothing'),
      spanIr('if'),
      spanIr('while'),
      cascadeIr(),
      nestedLoopsIr(),
    ]) {
      expect(() => validateIr(ir), `fixture ${ir.name}`).not.toThrow();
    }
  });

  test('LOCK: a range spanning a whole if / while keeps its slot through its last read', () => {
    // straight line: v1's last read is the statement defining v4, which takes v1's slot
    const plain = layoutFrames(spanIr('nothing'), OPT);
    expect(plain.slotOfValue(2)).toBe(plain.slotOfValue(1));
    // with a whole `if` / `while` lying strictly inside v1's range, that handoff is given up
    // although v4's read is real — the conservative `widened` flag, kept so `optimize: true`
    // layouts do not change (see `LiveRange.widened` in frame.ts)
    for (const between of ['if', 'while'] as const) {
      const frame = layoutFrames(spanIr(between), OPT);
      expect(frame.slotOfValue(2), `between: ${between}`).not.toBe(frame.slotOfValue(1));
    }
  });

  test('LOCK: widening cascades — a loop inside an if branch widens to the loop, then the if', () => {
    const frame = layoutFrames(cascadeIr(), OPT);
    const v1 = frame.slotOfValue(1);
    expect(v1).toBe(0xc0); // after arg (0x80) and cell (0xa0)
    for (const v of [2, 3, 4, 5]) expect(frame.slotOfValue(v), `value ${v}`).not.toBe(v1);
    expect(frame.slotOfValue(6), 'else-branch value').not.toBe(v1);
    expect(frame.slotOfValue(7), 'after the if').toBe(v1);
  });

  test('LOCK: a value read only in an inner loop is widened to that loop, not the outer one', () => {
    const frame = layoutFrames(nestedLoopsIr(), OPT);
    const v3 = frame.slotOfValue(3);
    for (const v of [4, 5, 6]) expect(frame.slotOfValue(v), `inner value ${v}`).not.toBe(v3);
    expect(frame.slotOfValue(7), 'after the inner loop').toBe(v3);
  });
});

// ---------------------------------------------------------------------------
// liveness allocator — seeded differential against a reference model
// ---------------------------------------------------------------------------

/*
 * The reference model is the allocator's first, deliberately naive formulation: every value
 * checked against every region innermost-first, and a linear scan that rescans its active
 * list and re-sorts its free list per value (O(V·R) and O(V²)). `frame.ts` walks a region
 * tree and keeps both lists in heaps; the two must agree slot for slot on random nested IRs.
 * A deliberate change to the allocation rules changes both.
 */

interface RefRegion {
  loop: boolean;
  start: number;
  end: number;
}

interface RefRange {
  start: number;
  end: number;
  widened: boolean;
}

/** Reference: the pool's slot ordinals (main body only — the fixtures have no fns). */
function referenceOrdinals(ir: ScriptIr, pool: ReadonlySet<ValueId>): Map<ValueId, number> {
  const defAt = new Map<ValueId, number>();
  const reads: { pos: number; value: ValueId }[] = [];
  const regions: RefRegion[] = [];
  let count = 0;
  const visit = (block: readonly Stmt[]): void => {
    for (const s of block) {
      const pos = count++;
      if (s.k !== 'while') for (const v of stmtReads(s)) reads.push({ pos, value: v });
      for (const v of stmtDefs(s)) if (pool.has(v)) defAt.set(v, pos);
      if (s.k === 'if') {
        visit(s.then);
        visit(s.else);
        regions.push({ loop: false, start: pos, end: count - 1 });
      } else if (s.k === 'while') {
        visit(s.header);
        reads.push({ pos: count++, value: s.cond });
        visit(s.body);
        regions.push({ loop: true, start: pos, end: count - 1 });
      }
    }
  };
  visit(ir.body);
  for (const r of ir.returns) reads.push({ pos: count, value: r.value });

  const ranges = new Map<ValueId, RefRange>();
  for (const [v, pos] of defAt) ranges.set(v, { start: pos, end: pos, widened: false });
  for (const { pos, value } of reads) {
    const r = ranges.get(value);
    if (r === undefined) continue;
    expect(pos, 'fixtures never read before the definition').toBeGreaterThanOrEqual(r.start);
    r.end = Math.max(r.end, pos);
  }
  regions.sort((x, y) => y.start - x.start);
  for (const r of ranges.values()) {
    for (const g of regions) {
      const intersects = r.start <= g.end && r.end >= g.start;
      const contained = r.start >= g.start && r.end <= g.end;
      if (!intersects || contained) continue;
      if (g.loop) {
        r.start = Math.min(r.start, g.start);
        r.end = Math.max(r.end, g.end);
        r.widened = true;
      } else if (r.start < g.start && r.end > g.start) {
        r.end = Math.max(r.end, g.end);
        r.widened = true;
      }
    }
  }

  const order = [...ranges].toSorted(([va, ra], [vb, rb]) => ra.start - rb.start || va - vb);
  const ordinals = new Map<ValueId, number>();
  let active: (RefRange & { ordinal: number })[] = [];
  const free: number[] = [];
  let size = 0;
  for (const [v, r] of order) {
    const released = (a: RefRange): boolean =>
      a.end < r.start || (a.end === r.start && a.start < r.start && !a.widened);
    for (const a of active) if (released(a)) free.push(a.ordinal);
    active = active.filter((a) => !released(a));
    free.sort((x, y) => x - y);
    const ordinal = free.shift() ?? size++;
    ordinals.set(v, ordinal);
    active.push({ ...r, ordinal });
  }
  return ordinals;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(seed: number): {
  int: (max: number) => number;
  pick: <T>(items: readonly T[]) => T;
} {
  const rnd = mulberry32(seed);
  const int = (max: number): number => Math.floor(rnd() * max);
  return {
    int,
    pick: (items) => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error('pick on empty list');
      return item;
    },
  };
}

/** A random, valid, nested main body over one arg `n` and one cell (no fns). */
function randomNestedIr(seed: number): ScriptIr {
  const g = makeGen(seed);
  const values: ValueInfo[] = [{ type: 'uint256' }]; // 0: arg n
  const fresh = (type: 'uint256' | 'bool'): ValueId => values.push({ type }) - 1;
  interface Scope {
    words: ValueId[];
    bools: ValueId[];
  }
  const child = (s: Scope): Scope => ({ words: [...s.words], bools: [...s.bools] });

  const block = (scope: Scope, depth: number, len: number): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < len; i++) {
      const roll = g.int(depth < 4 ? 10 : 7);
      if (roll <= 1) {
        const out1 = fresh('uint256');
        out.push(st({ k: 'env', op: 'timestamp', out: out1 }));
        scope.words.push(out1);
      } else if (roll <= 3) {
        const out1 = fresh('uint256');
        out.push(
          st({ k: 'bin', op: 'add', a: g.pick(scope.words), b: g.pick(scope.words), out: out1 }),
        );
        scope.words.push(out1);
      } else if (roll === 4) {
        const out1 = fresh('bool');
        out.push(
          st({ k: 'bin', op: 'lt', a: g.pick(scope.words), b: g.pick(scope.words), out: out1 }),
        );
        scope.bools.push(out1);
      } else if (roll === 5) {
        out.push(st({ k: 'cellset', cell: 0, value: g.pick(scope.words) }));
      } else if (roll === 6) {
        const out1 = fresh('uint256');
        out.push(st({ k: 'cellget', cell: 0, out: out1 }));
        scope.words.push(out1);
      } else if (roll <= 8 && scope.bools.length > 0) {
        out.push(
          st({
            k: 'if',
            cond: g.pick(scope.bools),
            // oxlint-disable-next-line unicorn/no-thenable -- the IR names the if-branch field `then`
            then: block(child(scope), depth + 1, g.int(4)),
            else: block(child(scope), depth + 1, g.int(3)),
          }),
        );
      } else {
        const inner = child(scope);
        const header = block(inner, depth + 1, g.int(3));
        const i1 = fresh('uint256');
        const cond = fresh('bool');
        header.push(st({ k: 'cellget', cell: 0, out: i1 }));
        header.push(st({ k: 'bin', op: 'lt', a: i1, b: g.pick(inner.words), out: cond }));
        inner.words.push(i1);
        out.push(st({ k: 'while', header, cond, body: block(inner, depth + 1, g.int(5)) }));
      }
    }
    return out;
  };

  const top: Scope = { words: [0], bools: [] };
  const body = [st({ k: 'cellnew', cell: 0, init: 0 }), ...block(top, 0, 4 + g.int(8))];
  const returned = [g.pick(top.words), g.pick(top.words)];
  return {
    irVersion: 1,
    name: `nested-${seed}`,
    args: [{ name: 'n', type: 'uint256' }],
    values,
    cells: [{ type: 'uint256' }],
    fns: [],
    body,
    returns: returned.map((value, i) => ({ name: `r${i}`, type: 'uint256', value })),
  };
}

describe('layoutFrames — liveness allocator matches the reference model (seeded)', () => {
  test('slot for slot on 300 random nested IRs', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const ir = randomNestedIr(seed);
      expect(() => validateIr(ir), `seed ${seed}`).not.toThrow();
      const pool = new Set<ValueId>();
      for (let v = ir.args.length; v < ir.values.length; v++) pool.add(v);
      const ordinals = referenceOrdinals(ir, pool);
      const base = 0x80 + 32 * (ir.args.length + ir.cells.length);
      const frame = layoutFrames(ir, OPT);
      for (const [v, ordinal] of ordinals) {
        expect(frame.slotOfValue(v), `seed ${seed}, ValueId ${v}`).toBe(base + 32 * ordinal);
      }
      const size = Math.max(-1, ...ordinals.values()) + 1;
      expect(frame.frameEnd, `seed ${seed}`).toBe(base + 32 * size);
    }
  });
});
