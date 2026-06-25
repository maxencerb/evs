import { describe, expect, test } from 'vitest';

import { FORBIDDEN, OPS, type Mnemonic, type OpInfo } from './ops.js';

/**
 * Spot-check table copied independently from docs/research/evm-target.md §2 (hex, stack
 * in/out, fork gating). Top-of-stack-first operand counts.
 */
const EXPECTED: readonly [Mnemonic, number, number, number, OpInfo['since']][] = [
  // [mnemonic, code, pops, pushes, since]
  ['STOP', 0x00, 0, 0, 'frontier'],
  ['ADD', 0x01, 2, 1, 'frontier'],
  ['MUL', 0x02, 2, 1, 'frontier'],
  ['SUB', 0x03, 2, 1, 'frontier'],
  ['DIV', 0x04, 2, 1, 'frontier'],
  ['SDIV', 0x05, 2, 1, 'frontier'],
  ['MOD', 0x06, 2, 1, 'frontier'],
  ['SMOD', 0x07, 2, 1, 'frontier'],
  ['ADDMOD', 0x08, 3, 1, 'frontier'],
  ['MULMOD', 0x09, 3, 1, 'frontier'],
  ['EXP', 0x0a, 2, 1, 'frontier'],
  ['SIGNEXTEND', 0x0b, 2, 1, 'frontier'],
  ['LT', 0x10, 2, 1, 'frontier'],
  ['GT', 0x11, 2, 1, 'frontier'],
  ['SLT', 0x12, 2, 1, 'frontier'],
  ['SGT', 0x13, 2, 1, 'frontier'],
  ['EQ', 0x14, 2, 1, 'frontier'],
  ['ISZERO', 0x15, 1, 1, 'frontier'],
  ['AND', 0x16, 2, 1, 'frontier'],
  ['OR', 0x17, 2, 1, 'frontier'],
  ['XOR', 0x18, 2, 1, 'frontier'],
  ['NOT', 0x19, 1, 1, 'frontier'],
  ['BYTE', 0x1a, 2, 1, 'frontier'],
  ['SHL', 0x1b, 2, 1, 'frontier'],
  ['SHR', 0x1c, 2, 1, 'frontier'],
  ['SAR', 0x1d, 2, 1, 'frontier'],
  ['KECCAK256', 0x20, 2, 1, 'frontier'],
  ['ADDRESS', 0x30, 0, 1, 'frontier'],
  ['CALLER', 0x33, 0, 1, 'frontier'],
  ['CALLVALUE', 0x34, 0, 1, 'frontier'],
  ['CALLDATALOAD', 0x35, 1, 1, 'frontier'],
  ['CALLDATASIZE', 0x36, 0, 1, 'frontier'],
  ['CALLDATACOPY', 0x37, 3, 0, 'frontier'],
  ['CODECOPY', 0x39, 3, 0, 'frontier'],
  ['RETURNDATASIZE', 0x3d, 0, 1, 'frontier'],
  ['RETURNDATACOPY', 0x3e, 3, 0, 'frontier'],
  ['TIMESTAMP', 0x42, 0, 1, 'frontier'],
  ['NUMBER', 0x43, 0, 1, 'frontier'],
  ['CHAINID', 0x46, 0, 1, 'frontier'],
  ['POP', 0x50, 1, 0, 'frontier'],
  ['MLOAD', 0x51, 1, 1, 'frontier'],
  ['MSTORE', 0x52, 2, 0, 'frontier'],
  ['MSTORE8', 0x53, 2, 0, 'frontier'],
  ['JUMP', 0x56, 1, 0, 'frontier'],
  ['JUMPI', 0x57, 2, 0, 'frontier'],
  ['PC', 0x58, 0, 1, 'frontier'],
  ['MSIZE', 0x59, 0, 1, 'frontier'],
  ['GAS', 0x5a, 0, 1, 'frontier'],
  ['JUMPDEST', 0x5b, 0, 0, 'frontier'],
  ['MCOPY', 0x5e, 3, 0, 'cancun'],
  ['PUSH0', 0x5f, 0, 1, 'shanghai'],
  ['CALL', 0xf1, 7, 1, 'frontier'],
  ['STATICCALL', 0xfa, 6, 1, 'frontier'],
  ['RETURN', 0xf3, 2, 0, 'frontier'],
  ['REVERT', 0xfd, 2, 0, 'frontier'],
  ['INVALID', 0xfe, 0, 0, 'frontier'],
];

describe('OPS table vs evm-target §2', () => {
  test.each(EXPECTED)('%s = code 0x%s', (mnemonic, code, pops, pushes, since) => {
    const info = OPS[mnemonic];
    expect(info.code).toBe(code);
    expect(info.pops).toBe(pops);
    expect(info.pushes).toBe(pushes);
    expect(info.since).toBe(since);
  });

  test('PUSH1..PUSH32 are 0x60..0x7f, push 1, pop 0', () => {
    let seen = 0;
    for (const [name, info] of Object.entries(OPS)) {
      const m = /^PUSH([1-9]\d?)$/.exec(name);
      if (m === null) continue;
      seen += 1;
      const n = Number(m[1]);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(32);
      expect(info.code).toBe(0x60 + n - 1);
      expect(info.pops).toBe(0);
      expect(info.pushes).toBe(1);
      expect(info.since).toBe('frontier');
    }
    expect(seen).toBe(32);
  });

  test('DUP1..DUP16 are 0x80..0x8f and encode reach n (pops n, pushes n+1)', () => {
    let seen = 0;
    for (const [name, info] of Object.entries(OPS)) {
      const m = /^DUP(\d+)$/.exec(name);
      if (m === null) continue;
      seen += 1;
      const n = Number(m[1]);
      expect(info.code).toBe(0x80 + n - 1);
      expect(info.pops).toBe(n);
      expect(info.pushes).toBe(n + 1);
      expect(info.since).toBe('frontier');
    }
    expect(seen).toBe(16);
  });

  test('SWAP1..SWAP16 are 0x90..0x9f and encode reach n+1 (pops n+1, pushes n+1)', () => {
    let seen = 0;
    for (const [name, info] of Object.entries(OPS)) {
      const m = /^SWAP(\d+)$/.exec(name);
      if (m === null) continue;
      seen += 1;
      const n = Number(m[1]);
      expect(info.code).toBe(0x90 + n - 1);
      expect(info.pops).toBe(n + 1);
      expect(info.pushes).toBe(n + 1);
      expect(info.since).toBe('frontier');
    }
    expect(seen).toBe(16);
  });

  test('every opcode byte is unique', () => {
    const codes = Object.values(OPS).map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('only MCOPY and PUSH0 are fork-gated', () => {
    const gated = Object.entries(OPS)
      .filter(([, i]) => i.since !== 'frontier')
      .map(([m]) => m)
      .toSorted();
    expect(gated).toEqual(['MCOPY', 'PUSH0']);
  });

  test('OPS is frozen', () => {
    expect(Object.isFrozen(OPS)).toBe(true);
  });
});

describe('FORBIDDEN', () => {
  test('contains exactly the state-touching byte set', () => {
    // CALL (0xf1) is intentionally NOT here: issue #1 admits it for the mutable-call surface
    // (s.call / s.simulate). Every other frame-escaping / state-persisting opcode stays forbidden.
    const expected = [
      0x54, // SLOAD
      0x55, // SSTORE
      0x5c, // TLOAD
      0x5d, // TSTORE
      0xa0, // LOG0
      0xa1, // LOG1
      0xa2, // LOG2
      0xa3, // LOG3
      0xa4, // LOG4
      0xf0, // CREATE
      0xf2, // CALLCODE
      0xf4, // DELEGATECALL
      0xf5, // CREATE2
      0xff, // SELFDESTRUCT
    ];
    expect([...FORBIDDEN].toSorted((a, b) => a - b)).toEqual(expected);
  });

  test('no emittable opcode is forbidden', () => {
    for (const [mnemonic, info] of Object.entries(OPS)) {
      expect(FORBIDDEN.has(info.code), `${mnemonic} must not be forbidden`).toBe(false);
    }
  });
});
