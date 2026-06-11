/**
 * M8 unit tests — `codegen/frame.ts` (static frame layout, architecture §5).
 *
 * Slot-order expectations mirror the worked example in architecture §15.3: args first
 * (0x80…), then cells, then non-folded values in id order, then per-reachable-fn result
 * regions + return-address spill slots. Folded word consts → `slotOfValue === null`;
 * returned word consts keep a slot; uncalled fns get no region and no value slots.
 */

import { describe, expect, test } from 'vitest';

import { EvsInternalError } from '../core/errors.js';
import type { ScriptIr, Stmt } from '../ir/nodes.js';
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

/** §15.3-shaped IR: arg n; cells total, i; folded consts 0/1; loop values v1…v7; final get. */
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

describe('layoutFrames — slot ordering (architecture §15.3)', () => {
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

describe('layoutFrames — fn regions (architecture §9)', () => {
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

  test('uncalled fn: no region, no value slots (dropped per §9)', () => {
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
