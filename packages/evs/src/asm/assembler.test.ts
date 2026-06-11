import { describe, expect, test } from 'vitest';

import { EvsInternalError, type SourceLoc } from '../core/errors.js';
import { AsmWriter, assemble, type AsmNode } from './assembler.js';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const LOC: SourceLoc = { file: '/home/dev/app/pools.ts', line: 9, column: 18 };

describe('AsmWriter', () => {
  test('newLabel returns increasing ids and remembers names', () => {
    const w = new AsmWriter();
    const a = w.newLabel('first');
    const b = w.newLabel();
    expect(b).toBe(a + 1);
    w.label(a, 0);
    w.dataLabel(b);
    expect(w.nodes()).toEqual([
      { k: 'label', label: a, stack: 0, name: 'first' },
      { k: 'dataLabel', label: b },
    ]);
  });

  test('op/push/pushBytes/pushLabel record nodes with loc and note', () => {
    const w = new AsmWriter();
    const l = w.newLabel();
    w.op('ADD', { loc: LOC, note: 'checked add' });
    w.push(5n, { note: 'literal' });
    w.pushBytes(Uint8Array.of(0xde, 0xad), { loc: null });
    w.pushLabel(l);
    expect(w.nodes()).toEqual([
      { k: 'op', op: 'ADD', loc: LOC, note: 'checked add' },
      { k: 'push', value: 5n, note: 'literal' },
      { k: 'pushBytes', bytes: Uint8Array.of(0xde, 0xad), loc: null },
      { k: 'pushLabel', label: l },
    ]);
  });

  test('push accepts numbers and rejects unsafe / out-of-range values', () => {
    const w = new AsmWriter();
    w.push(7);
    expect(w.nodes()).toEqual([{ k: 'push', value: 7n }]);
    expect(() => w.push(1.5)).toThrow(EvsInternalError);
    expect(() => w.push(Number.MAX_SAFE_INTEGER + 2)).toThrow(EvsInternalError);
    expect(() => w.push(-1n)).toThrow(EvsInternalError);
    expect(() => w.push(1n << 256n)).toThrow(EvsInternalError);
    expect(() => w.push((1n << 256n) - 1n)).not.toThrow();
  });

  test('pushBytes enforces 1..32 bytes and stores a defensive copy', () => {
    const w = new AsmWriter();
    expect(() => w.pushBytes(new Uint8Array(0))).toThrow(EvsInternalError);
    expect(() => w.pushBytes(new Uint8Array(33))).toThrow(EvsInternalError);
    const buf = Uint8Array.of(1, 2, 3);
    w.pushBytes(buf);
    buf[0] = 0xff;
    const node = w.nodes()[0];
    expect(node?.k === 'pushBytes' && node.bytes[0]).toBe(1);
  });

  test('op() rejects the PUSH family (assembler owns immediates)', () => {
    const w = new AsmWriter();
    expect(() => w.op('PUSH0')).toThrow(EvsInternalError);
    expect(() => w.op('PUSH1')).toThrow(EvsInternalError);
    expect(() => w.op('PUSH32')).toThrow(EvsInternalError);
  });

  test("returndatacopyAll('zero') emits the bubble shape", () => {
    const w = new AsmWriter();
    w.returndatacopyAll('zero');
    expect(w.nodes()).toEqual([
      { k: 'op', op: 'RETURNDATASIZE' },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURNDATACOPY' },
    ]);
  });

  test('returndatacopyAll({ dupDepth }) emits the snapshot shape with DUP<n+2>', () => {
    const w = new AsmWriter();
    w.returndatacopyAll({ dupDepth: 1 });
    expect(w.nodes()).toEqual([
      { k: 'op', op: 'RETURNDATASIZE' },
      { k: 'push', value: 0n },
      { k: 'op', op: 'DUP3' },
      { k: 'op', op: 'RETURNDATACOPY' },
    ]);
  });

  test('returndatacopyAll dupDepth bounds: 1..14 (DUP3..DUP16)', () => {
    expect(() => new AsmWriter().returndatacopyAll({ dupDepth: 0 })).toThrow(EvsInternalError);
    expect(() => new AsmWriter().returndatacopyAll({ dupDepth: 15 })).toThrow(EvsInternalError);
    expect(() => new AsmWriter().returndatacopyAll({ dupDepth: 14 })).not.toThrow();
  });

  test('nodes() returns a copy', () => {
    const w = new AsmWriter();
    w.op('STOP');
    const snapshot = w.nodes();
    w.op('STOP');
    expect(snapshot).toHaveLength(1);
  });
});

const program = (value: bigint): readonly AsmNode[] => [
  { k: 'push', value },
  { k: 'op', op: 'POP' },
  { k: 'push', value: 0n },
  { k: 'push', value: 0n },
  { k: 'op', op: 'RETURN' },
];

describe('assemble — push lowering', () => {
  test('push 0 lowers to PUSH0 on shanghai and cancun', () => {
    for (const evmVersion of ['shanghai', 'cancun'] as const) {
      const { bytecode } = assemble(program(0n), { evmVersion });
      expect(hex(bytecode)).toBe('5f505f5ff3');
    }
  });

  test('push 0 lowers to PUSH1 00 on paris', () => {
    const { bytecode } = assemble(program(0n), { evmVersion: 'paris' });
    expect(hex(bytecode)).toBe('60005060006000f3');
  });

  test('minimal-width PUSHn selection', () => {
    const cases: readonly [bigint, string][] = [
      [1n, '6001'],
      [0xffn, '60ff'],
      [0x100n, '610100'],
      [0xffffn, '61ffff'],
      [0x010000n, '62010000'],
      [(1n << 256n) - 1n, `7f${'ff'.repeat(32)}`],
    ];
    for (const [value, expected] of cases) {
      const { bytecode } = assemble(program(value), { evmVersion: 'cancun' });
      expect(hex(bytecode)).toBe(`${expected}505f5ff3`);
    }
  });

  test('pushBytes keeps exact width (no narrowing)', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'pushBytes', bytes: Uint8Array.of(0x00, 0x2a) }, // PUSH2 002a — NOT PUSH1 2a
      { k: 'op', op: 'POP' },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURN' },
    ];
    const { bytecode } = assemble(nodes, { evmVersion: 'cancun' });
    expect(hex(bytecode)).toBe('61002a505f5ff3');
  });
});

describe('assemble — label fixups', () => {
  test('backward jump golden (loop)', () => {
    const w = new AsmWriter();
    const loop = w.newLabel('loop');
    w.label(loop, 0);
    w.push(1n);
    w.pushLabel(loop);
    w.op('JUMPI');
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    const { bytecode, labelPcs } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(hex(bytecode)).toBe('5b6001610000575f5ff3');
    expect(labelPcs.get(loop)).toBe(0);
  });

  test('forward jump golden (patched big-endian)', () => {
    const w = new AsmWriter();
    const start = w.newLabel('start');
    const end = w.newLabel('end');
    w.pushLabel(end);
    w.op('JUMP');
    w.label(start, 0);
    w.push(1n);
    w.push(2n);
    w.op('ADD');
    w.op('POP');
    w.pushLabel(end);
    w.op('JUMP');
    w.label(end, 0);
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    const { bytecode, labelPcs } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(labelPcs.get(start)).toBe(4);
    expect(labelPcs.get(end)).toBe(15);
    expect(hex(bytecode)).toBe('61000f565b60016002015061000f565b5f5ff3');
  });

  test('pushLabel is always PUSH2, even for tiny targets', () => {
    const w = new AsmWriter();
    const l = w.newLabel();
    w.label(l, 0);
    w.push(1n);
    w.pushLabel(l); // target 0 — still 61 00 00
    w.op('JUMPI');
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    const { bytecode } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(hex(bytecode)).toContain('610000');
  });

  test('undefined label throws EvsInternalError', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'pushLabel', label: 99 },
      { k: 'op', op: 'JUMP' },
    ];
    expect(() => assemble(nodes, { evmVersion: 'cancun', verify: false })).toThrow(
      /undefined label/,
    );
  });

  test('duplicate label definition throws EvsInternalError', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'label', label: 0, stack: 0 },
      { k: 'label', label: 0, stack: 0 },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => assemble(nodes, { evmVersion: 'cancun', verify: false })).toThrow(/defined twice/);
  });

  test('label beyond 0xffff cannot be patched (PUSH2 reach)', () => {
    const nodes: AsmNode[] = [
      { k: 'pushLabel', label: 0 },
      { k: 'op', op: 'POP' },
    ];
    // 2200 × (PUSH32 + 32 bytes) = 72,600 bytes of filler past the 16-bit boundary
    for (let i = 0; i < 2200; i++) {
      nodes.push({ k: 'pushBytes', bytes: new Uint8Array(32) }, { k: 'op', op: 'POP' });
    }
    nodes.push({ k: 'label', label: 0, stack: 'any' }, { k: 'op', op: 'STOP' });
    expect(() => assemble(nodes, { evmVersion: 'cancun', verify: false })).toThrow(
      /PUSH2 fixups cannot reach/,
    );
  });
});

describe('assemble — data segments', () => {
  test('data is preceded by exactly one INVALID guard byte; dataLabel points past it', () => {
    const w = new AsmWriter();
    const blob = w.newLabel('blob');
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    w.dataLabel(blob);
    w.data(Uint8Array.of(0xde, 0xad, 0xbe, 0xef), 'test blob');
    const { bytecode, labelPcs } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(hex(bytecode)).toBe('5f5ff3fedeadbeef');
    expect(labelPcs.get(blob)).toBe(4); // first byte after the 0xFE guard
  });

  test('pushLabel may reference a dataLabel (CODECOPY source) and is patched', () => {
    const w = new AsmWriter();
    const blob = w.newLabel('blob');
    w.push(4n); // size
    w.pushLabel(blob); // offset (data segment)
    w.push(0n); // dst
    w.op('CODECOPY');
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    w.dataLabel(blob);
    w.data(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    const { bytecode, labelPcs } = assemble(w.nodes(), { evmVersion: 'cancun' });
    // 6004 61000b 5f 39 5f 5f f3 fe deadbeef — the PUSH2 carries the data offset 0x000b
    expect(hex(bytecode)).toBe('600461000b5f395f5ff3fedeadbeef');
    expect(labelPcs.get(blob)).toBe(0x0b);
  });

  test('multiple data nodes share the single guard', () => {
    const w = new AsmWriter();
    const a = w.newLabel();
    const b = w.newLabel();
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    w.dataLabel(a);
    w.data(Uint8Array.of(0x01, 0x02));
    w.dataLabel(b);
    w.data(Uint8Array.of(0x03));
    const { bytecode, labelPcs } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(hex(bytecode)).toBe('5f5ff3fe010203');
    expect(labelPcs.get(a)).toBe(4);
    expect(labelPcs.get(b)).toBe(6);
  });

  test('code after a data node is rejected (codegen must place data last)', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'STOP' },
      { k: 'data', bytes: Uint8Array.of(1) },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => assemble(nodes, { evmVersion: 'cancun', verify: false })).toThrow(
      /data segments must be last/,
    );
  });
});

describe('assemble — sourceMap', () => {
  test('segments cover every byte, sorted and non-overlapping; labels and notes recorded', () => {
    const w = new AsmWriter();
    const main = w.newLabel('main');
    const blob = w.newLabel('blob');
    w.pushLabel(main, { loc: LOC });
    w.op('JUMP');
    w.label(main, 0);
    w.push(0x2an, { loc: LOC, note: 'answer' });
    w.op('POP', { loc: null });
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    w.dataLabel(blob);
    w.data(Uint8Array.of(9, 9), 'blob bytes');
    const { bytecode, sourceMap } = assemble(w.nodes(), { evmVersion: 'cancun' });

    let next = 0;
    for (const seg of sourceMap.segments) {
      expect(seg.pc).toBe(next);
      expect(seg.len).toBeGreaterThan(0);
      next += seg.len;
    }
    expect(next).toBe(bytecode.length);

    expect(sourceMap.version).toBe(1);
    expect(sourceMap.sites).toEqual([]);
    // pushLabel(3) + JUMP(1) → main at pc 4; …RETURN at pc 10, guard at 11 → blob at pc 12
    expect(sourceMap.labels).toEqual([
      { pc: 4, name: 'main' },
      { pc: 12, name: 'blob' },
    ]);
    const answer = sourceMap.segments.find((s) => s.note === 'answer');
    expect(answer?.loc).toEqual(LOC);
    expect(sourceMap.segments.some((s) => s.note === 'data segment guard')).toBe(true);
    expect(sourceMap.segments.some((s) => s.note === 'blob bytes')).toBe(true);
  });
});

const dropPushPop = (nodes: readonly AsmNode[]): AsmNode[] => {
  const out: AsmNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const cur = nodes[i];
    const nxt = nodes[i + 1];
    if (cur?.k === 'push' && nxt?.k === 'op' && nxt.op === 'POP') {
      i += 1;
      continue;
    }
    if (cur !== undefined) out.push(cur);
  }
  return out;
};

describe('assemble — hooks and verification wiring', () => {
  test('peephole hook runs before layout (default identity)', () => {
    const w = new AsmWriter();
    w.push(1n);
    w.op('POP');
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    const plain = assemble(w.nodes(), { evmVersion: 'cancun' });
    const peeped = assemble(w.nodes(), { evmVersion: 'cancun', peephole: dropPushPop });
    expect(hex(plain.bytecode)).toBe('6001505f5ff3');
    expect(hex(peeped.bytecode)).toBe('5f5ff3');
  });

  test('verification is on by default and catches a stack bug', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'POP' }, // underflow at baseline 0
      { k: 'op', op: 'STOP' },
    ];
    expect(() => assemble(nodes, { evmVersion: 'cancun' })).toThrow(EvsInternalError);
    expect(() => assemble(nodes, { evmVersion: 'cancun', verify: false })).not.toThrow();
  });

  test('verification failures carry the bug-report marker', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'POP' },
      { k: 'op', op: 'STOP' },
    ];
    const run = (): void => {
      assemble(nodes, { evmVersion: 'cancun' });
    };
    expect(run).toThrow(EvsInternalError);
    expect(run).toThrow(/bug in evs, please report/);
  });
});
