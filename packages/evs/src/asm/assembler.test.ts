import { describe, expect, test } from 'vite-plus/test';

import { EvsInternalError } from '../core/errors.js';
import { AsmWriter, assemble, CodeBuffer, codeSize, type AsmNode } from './assembler.js';
import { encodedPushWidth, EVM_VERSIONS } from './ops.js';
import { lookupPc } from './sourcemap.js';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

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

  test('op/push/pushBytes/pushLabel record nodes with their note', () => {
    const w = new AsmWriter();
    const l = w.newLabel();
    w.op('ADD', { note: 'checked add' });
    w.push(5n, { note: 'literal' });
    w.pushBytes(Uint8Array.of(0xde, 0xad));
    w.pushLabel(l);
    expect(w.nodes()).toEqual([
      { k: 'op', op: 'ADD', note: 'checked add' },
      { k: 'push', value: 5n, note: 'literal' },
      { k: 'pushBytes', bytes: Uint8Array.of(0xde, 0xad) },
      { k: 'pushLabel', label: l },
    ]);
  });

  test('label names: a placement name wins over the allocation name; notes only when given', () => {
    const w = new AsmWriter();
    const a = w.newLabel('allocated');
    const b = w.newLabel('blob');
    w.label(a, 'any', 'placed');
    w.dataLabel(b, 'renamed');
    w.data(Uint8Array.of(1));
    w.data(Uint8Array.of(2), 'second');
    expect(w.nodes()).toEqual([
      { k: 'label', label: a, stack: 'any', name: 'placed' },
      { k: 'dataLabel', label: b, name: 'renamed' },
      { k: 'data', bytes: Uint8Array.of(1) },
      { k: 'data', bytes: Uint8Array.of(2), note: 'second' },
    ]);
    // `exactOptionalPropertyTypes`: an absent note is absent, not `note: undefined`
    expect(w.nodes().filter((n) => 'note' in n && n.note === undefined)).toEqual([]);
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

  test('isReferenced tracks pushLabel references only', () => {
    const w = new AsmWriter();
    const used = w.newLabel('used');
    const placedOnly = w.newLabel('placed');
    const allocatedOnly = w.newLabel('allocated');
    expect(w.isReferenced(used)).toBe(false);
    w.pushLabel(used);
    w.op('JUMP');
    w.label(placedOnly, 'any');
    w.label(used, 'any');
    w.op('STOP');
    expect(w.isReferenced(used)).toBe(true);
    expect(w.isReferenced(placedOnly)).toBe(false); // defining a label is not a reference
    expect(w.isReferenced(allocatedOnly)).toBe(false);
    // an allocated-but-never-placed, never-referenced label assembles fine
    expect(() => assemble(w.nodes(), { evmVersion: 'cancun' })).not.toThrow();
  });

  test('nodes() returns a copy', () => {
    const w = new AsmWriter();
    w.op('STOP');
    const snapshot = w.nodes();
    w.op('STOP');
    expect(snapshot).toHaveLength(1);
  });
});

describe('AsmWriter — checkpoint / rollback', () => {
  test('rollback discards nodes, reuses label ids, forgets names and references', () => {
    const w = new AsmWriter();
    const tail = w.newLabel('tail');
    w.push(1n);
    const before = w.nodes();
    const cp = w.checkpoint();

    const scratch = w.newLabel('scratch');
    w.pushLabel(tail);
    w.pushLabel(scratch);
    w.op('JUMPI');
    w.label(scratch, 0);
    expect(w.isReferenced(tail)).toBe(true);
    expect(w.isReferenced(scratch)).toBe(true);

    w.rollback(cp);
    expect(w.nodes()).toEqual(before);
    expect(w.isReferenced(tail)).toBe(false); // only the discarded code referenced it
    expect(w.isReferenced(scratch)).toBe(false);
    // the id is handed out again, without the discarded label's name
    const reused = w.newLabel();
    expect(reused).toBe(scratch);
    w.label(reused, 0);
    expect(w.nodes().at(-1)).toEqual({ k: 'label', label: reused, stack: 0 });
  });

  test('a reference made before the checkpoint survives the rollback', () => {
    const w = new AsmWriter();
    const tail = w.newLabel('tail');
    w.pushLabel(tail);
    const cp = w.checkpoint();
    w.pushLabel(tail); // already referenced: not a new reference to undo
    w.rollback(cp);
    expect(w.isReferenced(tail)).toBe(true);
    expect(w.nodes()).toEqual([{ k: 'pushLabel', label: tail }]);
  });

  test('nested checkpoints roll back independently (inner, then outer)', () => {
    const w = new AsmWriter();
    const outer = w.checkpoint();
    const a = w.newLabel('a');
    w.pushLabel(a);
    const inner = w.checkpoint();
    const b = w.newLabel('b');
    w.pushLabel(b);

    w.rollback(inner);
    expect(w.isReferenced(a)).toBe(true);
    expect(w.isReferenced(b)).toBe(false);
    expect(w.newLabel()).toBe(b);

    w.rollback(outer);
    expect(w.nodes()).toEqual([]);
    expect(w.isReferenced(a)).toBe(false);
    expect(w.newLabel()).toBe(a);
  });
});

describe('AsmWriter — peakHeightSince', () => {
  test('measures only the nodes emitted since the checkpoint, from the entry height', () => {
    const w = new AsmWriter();
    w.push(1n);
    w.push(2n);
    w.push(3n); // before the checkpoint: not counted
    const cp = w.checkpoint();
    expect(w.peakHeightSince(cp, 3)).toBe(3); // nothing emitted yet
    w.push(4n);
    w.push(5n);
    w.op('ADD');
    w.op('POP');
    expect(w.peakHeightSince(cp, 3)).toBe(5);
    expect(w.peakHeightSince(cp, 10)).toBe(12);
  });

  test('a checked label resets the height to its annotation', () => {
    const w = new AsmWriter();
    const cp = w.checkpoint();
    const l = w.newLabel();
    w.push(1n); // 1
    w.label(l, 6); // reset to 6
    w.push(2n); // 7
    w.op('POP');
    expect(w.peakHeightSince(cp, 0)).toBe(7);
  });

  test("an 'any' region (failure stub) is skipped until the next checked label", () => {
    const w = new AsmWriter();
    const cp = w.checkpoint();
    const stub = w.newLabel();
    const next = w.newLabel();
    w.push(1n); // 1
    w.op('STOP');
    w.label(stub, 'any');
    for (let i = 0; i < 20; i++) w.push(0n); // never counted
    w.op('REVERT');
    w.label(next, 2);
    w.push(9n); // 3
    expect(w.peakHeightSince(cp, 0)).toBe(3);
  });

  test.each(['JUMP', 'RETURN', 'REVERT', 'STOP', 'INVALID'] as const)(
    '%s ends liveness until the next label',
    (end) => {
      const w = new AsmWriter();
      const cp = w.checkpoint();
      const l = w.newLabel();
      w.push(1n);
      w.push(1n);
      w.op(end);
      for (let i = 0; i < 10; i++) w.push(0n); // dead code: not counted
      w.label(l, 1);
      w.push(0n); // 2
      expect(w.peakHeightSince(cp, 0)).toBe(2);
    },
  );

  test('JUMPI does not end liveness (the fallthrough continues)', () => {
    const w = new AsmWriter();
    const cp = w.checkpoint();
    const l = w.newLabel();
    w.push(1n);
    w.pushLabel(l);
    w.op('JUMPI'); // 0
    w.push(1n);
    w.push(2n);
    w.push(3n); // 3
    expect(w.peakHeightSince(cp, 0)).toBe(3);
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
      [1n << 64n, `6801${'00'.repeat(8)}`],
      [0x0102030405060708090an, '690102030405060708090a'],
      [(1n << 256n) - 1n, `7f${'ff'.repeat(32)}`],
    ];
    for (const [value, expected] of cases) {
      const { bytecode } = assemble(program(value), { evmVersion: 'cancun' });
      expect(hex(bytecode)).toBe(`${expected}505f5ff3`);
    }
  });

  test('encodedPushWidth (the peephole size guard) matches the lowered width on every fork', () => {
    const values = [0n, 1n, 0xffn, 0x100n, 0xffffn, 1n << 128n, (1n << 256n) - 1n];
    for (const evmVersion of EVM_VERSIONS) {
      for (const value of values) {
        const { bytecode } = assemble([{ k: 'push', value }], { evmVersion, verify: false });
        expect(bytecode.length, `${value} on ${evmVersion}`).toBe(
          encodedPushWidth(value, evmVersion),
        );
      }
    }
  });

  test('codeSize (the codec cost model) matches the assembled length on every fork', () => {
    const w = new AsmWriter();
    const loop = w.newLabel('loop');
    const blob = w.newLabel('blob');
    w.label(loop, 0);
    w.push(0);
    w.push(0x1234);
    w.pushBytes(Uint8Array.of(0, 1, 2));
    w.op('POP');
    w.op('POP');
    w.op('POP');
    w.pushLabel(blob);
    w.op('POP');
    w.pushLabel(loop);
    w.op('JUMP');
    w.dataLabel(blob);
    w.data(Uint8Array.of(9, 9, 9, 9));
    for (const evmVersion of EVM_VERSIONS) {
      const { bytecode } = assemble(w.nodes(), { evmVersion });
      // the assembler's INVALID guard before the data region is not part of codeSize
      expect(codeSize(w.nodes(), evmVersion) + 1, `on ${evmVersion}`).toBe(bytecode.length);
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

  const pastPush2Reach = (): AsmNode[] => {
    const nodes: AsmNode[] = [
      { k: 'pushLabel', label: 0 },
      { k: 'op', op: 'POP' },
    ];
    // 2200 × (PUSH32 + 32 bytes + POP) = 74,800 bytes of filler past the 16-bit boundary
    for (let i = 0; i < 2200; i++) {
      nodes.push({ k: 'pushBytes', bytes: new Uint8Array(32) }, { k: 'op', op: 'POP' });
    }
    nodes.push({ k: 'label', label: 0, stack: 'any' }, { k: 'op', op: 'STOP' });
    return nodes;
  };

  test('label beyond 0xffff cannot be patched (PUSH2 reach assertion)', () => {
    expect(() => assemble(pastPush2Reach(), { evmVersion: 'cancun', verify: false })).toThrow(
      /PUSH2 fixups cannot reach/,
    );
  });

  test('onLayout sees the final length + label pcs before fixups, and can reject first', () => {
    const seen: { totalLen: number; label0: number | undefined }[] = [];
    const reject = new Error('too big');
    expect(() =>
      assemble(pastPush2Reach(), {
        evmVersion: 'cancun',
        verify: false,
        onLayout: (totalLen, labelPcs) => {
          seen.push({ totalLen, label0: labelPcs.get(0) });
          throw reject;
        },
      }),
    ).toThrow(reject);
    // 3 (PUSH2) + 1 (POP) + 2200 × 34 + 1 (JUMPDEST) + 1 (STOP)
    expect(seen).toEqual([{ totalLen: 74_806, label0: 74_804 }]);

    // a hook that accepts leaves the output untouched
    const w = new AsmWriter();
    w.push(1n);
    w.op('STOP');
    let calls = 0;
    const hooked = assemble(w.nodes(), {
      evmVersion: 'cancun',
      onLayout: (totalLen) => {
        calls++;
        expect(totalLen).toBe(3);
      },
    });
    expect(calls).toBe(1);
    expect(hooked.bytecode).toEqual(assemble(w.nodes(), { evmVersion: 'cancun' }).bytecode);
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
    w.pushLabel(main);
    w.op('JUMP');
    w.label(main, 0);
    w.push(0x2an, { note: 'answer' });
    w.op('POP');
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
    expect(answer).toBeDefined();
    expect(sourceMap.segments.some((s) => s.note === 'data segment guard')).toBe(true);
    expect(sourceMap.segments.some((s) => s.note === 'blob bytes')).toBe(true);
  });
});

describe('assemble — layout buffer', () => {
  test('grows past its initial capacity without losing bytes (large data blob, few nodes)', () => {
    const blob = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff);
    const w = new AsmWriter();
    const data = w.newLabel('blob');
    w.push(1n);
    w.op('POP');
    w.op('STOP');
    w.dataLabel(data);
    w.data(blob);
    const { bytecode, labelPcs } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(bytecode.length).toBe(4 + 1 + blob.length);
    expect(hex(bytecode.subarray(0, 5))).toBe('60015000fe');
    expect(labelPcs.get(data)).toBe(5);
    expect(bytecode.subarray(5)).toEqual(blob);
  });

  test('a long code stream lays out the same as its instructions one by one', () => {
    const w = new AsmWriter();
    let expected = '';
    for (let i = 1; i <= 3000; i++) {
      w.push(BigInt(i));
      w.op('POP');
      const imm = i.toString(16).padStart(i > 0xff ? 4 : 2, '0');
      expected += `${i > 0xff ? '61' : '60'}${imm}50`;
    }
    w.op('STOP');
    const { bytecode } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(hex(bytecode)).toBe(`${expected}00`);
  });
});

describe('assemble — sourceMap segment coalescing', () => {
  test('adjacent nodes with the same note share one segment; a note change starts a new one', () => {
    const w = new AsmWriter();
    const main = w.newLabel('main');
    w.pushLabel(main);
    w.op('JUMP');
    w.label(main, 0);
    w.push(1n, { note: 'add' });
    w.push(2n, { note: 'add' });
    w.op('ADD', { note: 'add' });
    w.op('POP', { note: 'drop' });
    w.op('STOP');
    const { bytecode, sourceMap } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(sourceMap.segments).toEqual([
      { pc: 0, len: 4 }, // PUSH2 main + JUMP: no note, one run
      { pc: 4, len: 1, note: '@main' }, // JUMPDEST
      { pc: 5, len: 5, note: 'add' }, // PUSH1 1, PUSH1 2, ADD
      { pc: 10, len: 1, note: 'drop' },
      { pc: 11, len: 1 },
    ]);
    expect(bytecode.length).toBe(12);
    // every pc answers its instruction's own note
    const notes = Array.from({ length: bytecode.length }, (_, pc) => lookupPc(sourceMap, pc)?.note);
    expect(notes).toEqual([
      ...Array<undefined>(4).fill(undefined),
      '@main',
      ...Array<string>(5).fill('add'),
      'drop',
      undefined,
    ]);
  });

  test('the data guard keeps its own segment between same-note code and data', () => {
    const w = new AsmWriter();
    const blob = w.newLabel();
    w.op('STOP', { note: 'x' });
    w.dataLabel(blob);
    w.data(Uint8Array.of(1, 2), 'x');
    w.data(Uint8Array.of(3), 'x');
    const { sourceMap } = assemble(w.nodes(), { evmVersion: 'cancun' });
    expect(sourceMap.segments).toEqual([
      { pc: 0, len: 1, note: 'x' },
      { pc: 1, len: 1, note: 'data segment guard' },
      { pc: 2, len: 3, note: 'x' }, // two same-note blobs, one run
    ]);
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

  test('a hook-injected bare PUSH1..PUSH32 op node is rejected at layout, even with verify off', () => {
    // `[PUSH1] RETURN` would assemble to `60 f3`: the RETURN byte becomes PUSH1's immediate while
    // the stack verifier still simulates a +1 push followed by a RETURN, so the program it
    // certifies is not the one the bytes run. The rule is a layout invariant, not a lint.
    for (const op of ['PUSH1', 'PUSH2', 'PUSH20', 'PUSH32'] as const) {
      const injectBefore = (nodes: readonly AsmNode[]): AsmNode[] => [
        ...nodes.slice(0, -1),
        { k: 'op', op },
        ...nodes.slice(-1),
      ];
      for (const verify of [true, false]) {
        const run = (): void => {
          assemble(program(1n), { evmVersion: 'cancun', peephole: injectBefore, verify });
        };
        expect(run).toThrow(EvsInternalError);
        expect(run).toThrow(
          new RegExp(
            `op node '${op}' is not allowed — PUSH immediates must be push/pushBytes/pushLabel nodes`,
          ),
        );
      }
    }
  });

  test('a bare PUSH0 op node stays legal (no immediate) and is fork-gated by the verifier', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'PUSH0' },
      { k: 'op', op: 'PUSH0' },
      { k: 'op', op: 'RETURN' },
    ];
    expect(hex(assemble(nodes, { evmVersion: 'cancun' }).bytecode)).toBe('5f5ff3');
    expect(() => assemble(nodes, { evmVersion: 'paris' })).toThrow(EvsInternalError);
  });

  test('an op node with an unknown mnemonic is rejected as an EvsInternalError', () => {
    // a JavaScript hook is not held to the `Mnemonic` type
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    const nodes = [{ k: 'op', op: 'NOPE' }] as unknown as readonly AsmNode[];
    const run = (): void => {
      assemble(nodes, { evmVersion: 'cancun', verify: false });
    };
    expect(run).toThrow(EvsInternalError);
    expect(run).toThrow(/unknown mnemonic 'NOPE'/);
  });

  test('a push node whose value is a JS number is rejected as an EvsInternalError on every fork', () => {
    // a JavaScript hook is not held to `value: bigint`: a number `0` used to miss the `=== 0n`
    // branch and assemble to a bare PUSH0 even on paris (which no verifier gates), and any other
    // number threw a raw `TypeError: Cannot mix BigInt and other types`
    for (const value of [0, 5, 0x1234]) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
      const injected = { k: 'push', value } as unknown as AsmNode;
      const prepend = (nodes: readonly AsmNode[]): AsmNode[] => [
        injected,
        { k: 'op', op: 'POP' },
        ...nodes,
      ];
      for (const evmVersion of ['paris', 'cancun'] as const) {
        for (const verify of [true, false]) {
          const run = (): void => {
            assemble([{ k: 'op', op: 'STOP' }], { evmVersion, peephole: prepend, verify });
          };
          expect(run).toThrow(EvsInternalError);
          expect(run).toThrow(/push value must be a bigint, got number/);
        }
      }
    }
    // control: the bigint spelling still lowers to `PUSH1 00` on paris
    const ok = assemble([{ k: 'op', op: 'STOP' }], {
      evmVersion: 'paris',
      peephole: (nodes) => [{ k: 'push', value: 0n }, { k: 'op', op: 'POP' }, ...nodes],
    });
    expect(hex(ok.bytecode)).toBe('60005000');
  });

  test('CodeBuffer.minimalPush refuses zero instead of writing a bare PUSH0', () => {
    // defence in depth behind assemble()'s bigint + `=== 0n` gates: width 0 would write
    // `PUSH1_CODE - 1` (0x5f, PUSH0) whatever the fork
    const zero = new CodeBuffer(0);
    const run = (): void => {
      zero.minimalPush(0n);
    };
    expect(run).toThrow(EvsInternalError);
    expect(run).toThrow(/minimalPush needs a non-zero value, got 0/);
    expect(zero.pc).toBe(0);
    // control: non-zero values take their minimal width
    const ok = new CodeBuffer(0);
    ok.minimalPush(1n);
    ok.minimalPush(0x1234n);
    expect(hex(ok.finish())).toBe('6001611234');
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
