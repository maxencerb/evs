import { describe, expect, test } from 'vitest';

import { EvsTypeError, type SourceLoc } from '../core/errors.js';
import { AsmWriter, assemble, type AsmNode } from './assembler.js';
import { disassemble } from './disasm.js';
import type { EvmVersion, Mnemonic } from './ops.js';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const LOC: SourceLoc = { file: '/home/dev/app/pools.ts', line: 9, column: 18 };

describe('disassemble — basics', () => {
  test('RUNTIME_42 golden listing', () => {
    const d = disassemble('0x602a60005260206000f3');
    expect(d.lines.map((l) => l.mnemonic)).toEqual([
      'PUSH1',
      'PUSH1',
      'MSTORE',
      'PUSH1',
      'PUSH1',
      'RETURN',
    ]);
    expect(d.lines.map((l) => l.pushValue)).toEqual([
      '0x2a',
      '0x00',
      undefined,
      '0x20',
      '0x00',
      undefined,
    ]);
    expect(d.lines.map((l) => l.pc)).toEqual([0, 2, 4, 5, 7, 9]);
    expect(d.lines.map((l) => l.raw)).toEqual([
      '0x602a',
      '0x6000',
      '0x52',
      '0x6020',
      '0x6000',
      '0xf3',
    ]);
  });

  test('accepts Uint8Array input', () => {
    const d = disassemble(Uint8Array.of(0x5f, 0x00));
    expect(d.lines.map((l) => l.mnemonic)).toEqual(['PUSH0', 'STOP']);
  });

  test('unknown bytes disassemble as UNKNOWN_0x.. with 1-byte raw', () => {
    const d = disassemble('0x0c5b');
    expect(d.lines[0]?.mnemonic).toBe('UNKNOWN_0x0c');
    expect(d.lines[0]?.raw).toBe('0x0c');
    expect(d.lines[1]?.mnemonic).toBe('JUMPDEST');
  });

  test('a truncated trailing PUSH consumes the remaining bytes', () => {
    const d = disassemble('0x61ff'); // PUSH2 with only one immediate byte present
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]?.mnemonic).toBe('PUSH2');
    expect(d.lines[0]?.raw).toBe('0x61ff');
    expect(d.lines[0]?.pushValue).toBe('0xff');
  });

  test('rejects malformed hex input with EvsTypeError', () => {
    expect(() => disassemble('0x60g0')).toThrow(EvsTypeError); // non-hex characters
    expect(() => disassemble('0x123')).toThrow(EvsTypeError); // odd length
  });
});

describe('disassemble — sourceMap annotations', () => {
  const build = () => {
    const w = new AsmWriter();
    const loop = w.newLabel('loop');
    w.label(loop, 0);
    w.push(1n, { loc: LOC, note: 'condition' });
    w.pushLabel(loop, { loc: LOC });
    w.op('JUMPI');
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    return assemble(w.nodes(), { evmVersion: 'cancun' });
  };

  test('labels, jump targets, locs and notes are attached', () => {
    const { bytecode, sourceMap } = build();
    const d = disassemble(bytecode, sourceMap);

    const head = d.lines[0];
    expect(head?.mnemonic).toBe('JUMPDEST');
    expect(head?.label).toBe('loop');

    const push1 = d.lines[1];
    expect(push1?.note).toBe('condition');
    expect(push1?.loc).toEqual(LOC);

    const target = d.lines[2];
    expect(target?.mnemonic).toBe('PUSH2');
    expect(target?.pushValue).toBe('0x0000');
    expect(target?.targetLabel).toBe('loop');
  });

  test('format() renders labels, immediates, target arrows and locs', () => {
    const { bytecode, sourceMap } = build();
    const text = disassemble(bytecode, sourceMap).format();
    expect(text).toContain('@loop:');
    expect(text).toContain('PUSH2 0x0000 → @loop');
    expect(text).toContain('; condition — /home/dev/app/pools.ts:9:18');
    expect(text.split('\n')[0]).toBe('@loop:');
  });

  test('format({ locs: false }) drops file locations but keeps notes', () => {
    const { bytecode, sourceMap } = build();
    const text = disassemble(bytecode, sourceMap).format({ locs: false });
    expect(text).toContain('; condition');
    expect(text).not.toContain('pools.ts');
  });
});

// ---------------------------------------------------------------------------
// assemble → disassemble round-trip property test
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const OP_POOL: readonly Mnemonic[] = [
  'STOP',
  'ADD',
  'MUL',
  'SUB',
  'ISZERO',
  'POP',
  'MLOAD',
  'MSTORE',
  'CALLER',
  'ADDRESS',
  'CALLDATASIZE',
  'RETURNDATASIZE',
  'GAS',
  'DUP1',
  'DUP7',
  'SWAP1',
  'SWAP12',
  'EQ',
  'NOT',
  'RETURN',
  'REVERT',
];

interface GeneratedProgram {
  nodes: readonly AsmNode[];
  expectedCodeMnemonics: readonly string[];
}

function generateProgram(rand: () => number, evmVersion: EvmVersion): GeneratedProgram {
  const nodes: AsmNode[] = [];
  const expected: string[] = [];
  const definedLabels: number[] = [];
  let nextLabel = 0;

  const pushExpectation = (value: bigint): void => {
    if (value === 0n) {
      expected.push(evmVersion === 'paris' ? 'PUSH1' : 'PUSH0');
      return;
    }
    let h = value.toString(16);
    if (h.length % 2 === 1) h = `0${h}`;
    expected.push(`PUSH${h.length / 2}`);
  };

  const count = 10 + Math.floor(rand() * 30);
  for (let i = 0; i < count; i++) {
    const roll = rand();
    if (roll < 0.35) {
      const op = OP_POOL[Math.floor(rand() * OP_POOL.length)] ?? 'STOP';
      nodes.push({ k: 'op', op });
      expected.push(op);
    } else if (roll < 0.6) {
      const width = Math.floor(rand() * 33); // 0 → value 0
      let value = 0n;
      for (let b = 0; b < width; b++) {
        value = (value << 8n) | BigInt(Math.floor(rand() * 256));
      }
      nodes.push({ k: 'push', value });
      pushExpectation(value);
    } else if (roll < 0.75) {
      const width = 1 + Math.floor(rand() * 32);
      const bytes = new Uint8Array(width);
      for (let b = 0; b < width; b++) bytes[b] = Math.floor(rand() * 256);
      nodes.push({ k: 'pushBytes', bytes });
      expected.push(`PUSH${width}`);
    } else if (roll < 0.9) {
      const label = nextLabel;
      nextLabel += 1;
      definedLabels.push(label);
      nodes.push({ k: 'label', label, stack: 'any' });
      expected.push('JUMPDEST');
    } else if (definedLabels.length > 0) {
      const label = definedLabels[Math.floor(rand() * definedLabels.length)] ?? 0;
      nodes.push({ k: 'pushLabel', label });
      expected.push('PUSH2');
    }
  }

  nodes.push({ k: 'op', op: 'STOP' });
  expected.push('STOP');

  if (rand() < 0.5) {
    const len = 1 + Math.floor(rand() * 40);
    const bytes = new Uint8Array(len);
    for (let b = 0; b < len; b++) bytes[b] = Math.floor(rand() * 256);
    nodes.push({ k: 'data', bytes });
    expected.push('INVALID'); // the guard byte is the last code-section instruction
  }

  return { nodes, expectedCodeMnemonics: expected };
}

describe('disassemble — assemble round-trip property', () => {
  test('raw bytes concatenation reproduces the bytecode and code mnemonics match the nodes', () => {
    for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
      for (let seed = 1; seed <= 25; seed++) {
        const rand = lcg(seed * 7919 + evmVersion.length);
        const { nodes, expectedCodeMnemonics } = generateProgram(rand, evmVersion);
        const { bytecode } = assemble(nodes, { evmVersion, verify: false });
        const d = disassemble(bytecode);

        const rawConcat = d.lines.map((l) => l.raw.slice(2)).join('');
        expect(rawConcat).toBe(hex(bytecode));

        const mnemonics = d.lines.slice(0, expectedCodeMnemonics.length).map((l) => l.mnemonic);
        expect(mnemonics).toEqual(expectedCodeMnemonics);
      }
    }
  });
});
