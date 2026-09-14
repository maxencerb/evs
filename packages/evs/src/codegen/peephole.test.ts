/**
 * Unit tests — `codegen/peephole.ts` (issue #39): every rewrite as an input → output node
 * stream AND as the same tiny program executed on the in-process EVM before/after; the guard
 * rails (label / pushLabel barriers, the 16-item template budget, the fold size guard);
 * `loc`/`note` inheritance; purity + idempotence; and the constant folders checked opcode by
 * opcode against the EVM itself.
 */

import { describe, expect, test } from 'vite-plus/test';

import { execRuntime } from '../../test/harness/evm.js';
import { assemble, AsmWriter, type AsmNode } from '../asm/assembler.js';
import type { Mnemonic } from '../asm/ops.js';
import { evscript } from '../builder/script.js';
import { bytesToHex } from '../core/bytes.js';
import type { SourceLoc } from '../core/errors.js';
import { t, type Hex } from '../core/types.js';
import { evsPeephole, foldBinary, foldUnary } from './peephole.js';
import { lowerProgram } from './program.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const MAX = (1n << 256n) - 1n;
const LOC_A: SourceLoc = { file: 'a.ts', line: 1, column: 1 };
const LOC_B: SourceLoc = { file: 'b.ts', line: 2, column: 2 };

const push = (value: bigint, meta?: { loc?: SourceLoc; note?: string }): AsmNode => ({
  k: 'push',
  value,
  ...meta,
});
const op = (m: Mnemonic, meta?: { loc?: SourceLoc; note?: string }): AsmNode => ({
  k: 'op',
  op: m,
  ...meta,
});

/** `[…, word] → RETURN word` — the tail every EVM check program ends with. */
const RETURN_TOP: readonly AsmNode[] = [push(0n), op('MSTORE'), push(32n), push(0n), op('RETURN')];

/** Assembles (with the mandatory verifiers) and executes a node stream; returns returndata. */
async function run(nodes: readonly AsmNode[]): Promise<Hex> {
  const { bytecode } = assemble(nodes, { evmVersion: 'cancun' });
  const res = await execRuntime(bytesToHex(bytecode), '0x');
  expect(res.success).toBe(true);
  return res.data;
}

/** Asserts the rewrite and that the original and rewritten programs agree on the EVM. */
async function expectRewrite(input: readonly AsmNode[], expected: readonly AsmNode[]) {
  const out = evsPeephole(input);
  expect(out).toEqual(expected);
  const [before, after] = await Promise.all([run(input), run(out)]);
  expect(after).toBe(before);
  return before;
}

const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;

// ---------------------------------------------------------------------------
// rewrite 1 — store-then-reload
// ---------------------------------------------------------------------------

describe('rewrite 1 — PUSH s MSTORE PUSH s MLOAD → DUP1 PUSH s MSTORE', () => {
  test('rewrites and agrees with the EVM', async () => {
    const data = await expectRewrite(
      [push(7n), push(0x80n), op('MSTORE'), push(0x80n), op('MLOAD'), ...RETURN_TOP],
      [push(7n), op('DUP1'), push(0x80n), op('MSTORE'), ...RETURN_TOP],
    );
    expect(data).toBe(word(7n));
  });

  test('different slots are left alone', () => {
    const input = [push(7n), push(0x80n), op('MSTORE'), push(0xa0n), op('MLOAD'), ...RETURN_TOP];
    expect(evsPeephole(input)).toEqual(input);
  });

  test('chains with rewrite 2 to a fixpoint: store + two reloads → DUP1 DUP1 store', async () => {
    const data = await expectRewrite(
      [
        push(7n),
        push(0x80n),
        op('MSTORE'),
        push(0x80n),
        op('MLOAD'),
        push(0x80n),
        op('MLOAD'),
        op('ADD'),
        ...RETURN_TOP,
      ],
      [push(7n), op('DUP1'), op('DUP1'), push(0x80n), op('MSTORE'), op('ADD'), ...RETURN_TOP],
    );
    expect(data).toBe(word(14n));
  });

  test('the DUP1 inherits the reload loc/note; the store keeps its own nodes by reference', () => {
    const store = push(0x80n, { loc: LOC_A, note: 'store' });
    const mstore = op('MSTORE');
    const input = [
      push(7n),
      store,
      mstore,
      push(0x80n, { loc: LOC_B, note: 'cell 0 →' }),
      op('MLOAD'),
    ];
    const out = evsPeephole([...input, ...RETURN_TOP]);
    expect(out[1]).toEqual({ k: 'op', op: 'DUP1', loc: LOC_B, note: 'cell 0 →' });
    expect(out[2]).toBe(store);
    expect(out[3]).toBe(mstore);
  });

  test('skipped when the extra DUP1 would exceed the 16-item template budget', () => {
    const filler = (n: number): AsmNode[] => Array.from({ length: n }, () => push(1n));
    const window = [push(0x80n), op('MSTORE'), push(0x80n), op('MLOAD')];
    const drain = (n: number): AsmNode[] => Array.from({ length: n }, () => op('POP'));
    // entry height 15 (14 filler + v): input peaks at 16 (legal), rewrite would peak at 17
    const tight = [...filler(15), ...window, ...drain(15), op('STOP')];
    expect(() => assemble(tight, { evmVersion: 'cancun' })).not.toThrow();
    expect(evsPeephole(tight)).toEqual(tight);
    // entry height 14: the rewrite peaks at 16 — applied
    const loose = [...filler(14), ...window, ...drain(14), op('STOP')];
    const out = evsPeephole(loose);
    expect(out).toEqual([
      ...filler(14),
      op('DUP1'),
      push(0x80n),
      op('MSTORE'),
      ...drain(14),
      op('STOP'),
    ]);
    expect(() => assemble(out, { evmVersion: 'cancun' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rewrite 2 — reload-of-reload
// ---------------------------------------------------------------------------

describe('rewrite 2 — PUSH s MLOAD PUSH s MLOAD → PUSH s MLOAD DUP1', () => {
  test('rewrites and agrees with the EVM', async () => {
    // MSTORE8 seeds the last byte of the 0x80 word without forming a store-then-reload window
    const seed = [push(9n), push(0x9fn), op('MSTORE8')];
    const data = await expectRewrite(
      [...seed, push(0x80n), op('MLOAD'), push(0x80n), op('MLOAD'), op('ADD'), ...RETURN_TOP],
      [...seed, push(0x80n), op('MLOAD'), op('DUP1'), op('ADD'), ...RETURN_TOP],
    );
    expect(data).toBe(word(18n));
  });

  test('the DUP1 inherits the second load loc', () => {
    const out = evsPeephole([
      push(0x80n, { loc: LOC_A }),
      op('MLOAD'),
      push(0x80n, { loc: LOC_B }),
      op('MLOAD'),
      op('STOP'),
    ]);
    expect(out[2]).toEqual({ k: 'op', op: 'DUP1', loc: LOC_B });
  });
});

// ---------------------------------------------------------------------------
// rewrite 3 — constant folding
// ---------------------------------------------------------------------------

describe('rewrite 3 — constant folding', () => {
  test('PUSH 0x80 PUSH 0x20 ADD → PUSH 0xa0 (offset arithmetic)', async () => {
    const data = await expectRewrite(
      [push(0x80n), push(0x20n), op('ADD'), ...RETURN_TOP],
      [push(0xa0n), ...RETURN_TOP],
    );
    expect(data).toBe(word(0xa0n));
  });

  test('operand order: PUSH second PUSH top SUB = top − second', async () => {
    const data = await expectRewrite(
      [push(3n), push(5n), op('SUB'), ...RETURN_TOP],
      [push(2n), ...RETURN_TOP],
    );
    expect(data).toBe(word(2n));
  });

  test('unary: PUSH 0 ISZERO → PUSH 1', async () => {
    const data = await expectRewrite(
      [push(0n), op('ISZERO'), ...RETURN_TOP],
      [push(1n), ...RETURN_TOP],
    );
    expect(data).toBe(word(1n));
  });

  test('size guard: a fold that would widen the immediate is skipped', () => {
    // the selector left-alignment every call template emits: 8 bytes in, 33 bytes folded
    const selector = [push(0xa9059cbbn), push(0xe0n), op('SHL'), ...RETURN_TOP];
    expect(evsPeephole(selector)).toEqual(selector);
    // 5 − 3 wraps to a 32-byte word: 5 bytes in, 33 bytes folded
    const wrap = [push(5n), push(3n), op('SUB'), ...RETURN_TOP];
    expect(evsPeephole(wrap)).toEqual(wrap);
    // NOT of a small immediate is a 32-byte word too
    const not = [push(1n), op('NOT'), ...RETURN_TOP];
    expect(evsPeephole(not)).toEqual(not);
  });

  test('the folded push inherits the first defined loc and note', () => {
    const out = evsPeephole([
      push(0x80n, { loc: LOC_A, note: 'base' }),
      push(0x20n, { loc: LOC_B }),
      op('ADD'),
      op('STOP'),
    ]);
    expect(out[0]).toEqual({ k: 'push', value: 0xa0n, loc: LOC_A, note: 'base' });
  });

  test('pushBytes / pushLabel operands are never folded', () => {
    const w = new AsmWriter();
    const l = w.newLabel('x');
    w.pushBytes(Uint8Array.of(0x01));
    w.push(2n);
    w.op('ADD');
    w.pushLabel(l);
    w.push(1n);
    w.op('ADD');
    w.op('POP');
    w.op('POP');
    w.label(l, 0);
    w.op('STOP');
    expect(evsPeephole(w.nodes())).toEqual(w.nodes());
  });
});

// ---------------------------------------------------------------------------
// folders vs the EVM, opcode by opcode
// ---------------------------------------------------------------------------

const BINOPS: readonly Mnemonic[] = [
  'ADD',
  'MUL',
  'SUB',
  'DIV',
  'SDIV',
  'MOD',
  'SMOD',
  'EXP',
  'SIGNEXTEND',
  'LT',
  'GT',
  'SLT',
  'SGT',
  'EQ',
  'AND',
  'OR',
  'XOR',
  'BYTE',
  'SHL',
  'SHR',
  'SAR',
];

const SAMPLES: readonly bigint[] = [
  0n,
  1n,
  2n,
  3n,
  7n,
  31n,
  32n,
  255n,
  256n,
  257n,
  0xdeadbeefn,
  (1n << 255n) - 1n,
  1n << 255n,
  (1n << 255n) + 1n,
  MAX - 1n,
  MAX,
];

/** A focused pair set: every sample against a handful of partners (edge-heavy). */
const PAIRS: readonly (readonly [bigint, bigint])[] = SAMPLES.flatMap((top) =>
  [0n, 1n, 3n, 255n, 1n << 255n, MAX].map((second) => [top, second] as const),
);

describe('foldBinary agrees with the EVM for every foldable opcode', () => {
  for (const mnemonic of BINOPS) {
    // oxlint-disable-next-line vitest/valid-title -- one test per opcode
    test(mnemonic, async () => {
      // one program per opcode: compute every pair into memory, RETURN the whole block
      const nodes: AsmNode[] = [];
      PAIRS.forEach(([top, second], k) => {
        nodes.push(push(second), push(top), op(mnemonic), push(BigInt(32 * k)), op('MSTORE'));
      });
      nodes.push(push(BigInt(32 * PAIRS.length)), push(0n), op('RETURN'));
      const data = await run(nodes);
      PAIRS.forEach(([top, second], k) => {
        const fromEvm = `0x${data.slice(2 + 64 * k, 2 + 64 * (k + 1))}`;
        const folded = foldBinary(mnemonic, top, second);
        expect(folded, `${mnemonic}(top=${top}, second=${second})`).not.toBeNull();
        expect(word(folded ?? 0n), `${mnemonic}(top=${top}, second=${second})`).toBe(fromEvm);
      });
    });
  }

  test('ISZERO / NOT agree with the EVM', async () => {
    const nodes: AsmNode[] = [];
    const unops: readonly Mnemonic[] = ['ISZERO', 'NOT'];
    let k = 0;
    for (const m of unops) {
      for (const x of SAMPLES) {
        nodes.push(push(x), op(m), push(BigInt(32 * k)), op('MSTORE'));
        k += 1;
      }
    }
    nodes.push(push(BigInt(32 * k)), push(0n), op('RETURN'));
    const data = await run(nodes);
    k = 0;
    for (const m of unops) {
      for (const x of SAMPLES) {
        const fromEvm = `0x${data.slice(2 + 64 * k, 2 + 64 * (k + 1))}`;
        expect(word(foldUnary(m, x) ?? -1n), `${m}(${x})`).toBe(fromEvm);
        k += 1;
      }
    }
  });

  test('non-pure / non-binary opcodes are never folded', () => {
    for (const m of ['KECCAK256', 'MLOAD', 'ADDMOD', 'JUMP', 'CALLDATALOAD', 'GAS'] as const) {
      expect(foldBinary(m, 1n, 2n)).toBeNull();
      expect(foldUnary(m, 1n)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// rewrite 4 — identities
// ---------------------------------------------------------------------------

describe('rewrite 4 — identities', () => {
  // opaque operands: the constant folder (which runs first) cannot touch them, so each case
  // exercises exactly the identity under test. CALLER is non-zero; CALLVALUE/CALLDATASIZE are 0.
  const seed = [op('CALLER')]; // the `x` under every pattern
  const y = op('CALLVALUE');
  const z = op('ADDRESS');
  const u = op('CALLDATASIZE');

  const cases: readonly {
    name: string;
    input: readonly AsmNode[];
    expected: readonly AsmNode[];
  }[] = [
    {
      name: 'SWAP1 SWAP1',
      input: [y, op('SWAP1'), op('SWAP1'), op('POP')],
      expected: [y, op('POP')],
    },
    {
      name: 'SWAP3 SWAP3',
      input: [y, z, u, op('SWAP3'), op('SWAP3'), op('POP'), op('POP'), op('POP')],
      expected: [y, z, u, op('POP'), op('POP'), op('POP')],
    },
    { name: 'DUP2 POP', input: [y, op('DUP2'), op('POP'), op('POP')], expected: [y, op('POP')] },
    { name: 'PUSH v POP', input: [push(5n), op('POP')], expected: [] },
    {
      name: 'pushBytes POP',
      input: [{ k: 'pushBytes', bytes: Uint8Array.of(1) }, op('POP')],
      expected: [],
    },
    { name: 'PUSH 0 ADD', input: [push(0n), op('ADD')], expected: [] },
    { name: 'PUSH 0 OR', input: [push(0n), op('OR')], expected: [] },
    { name: 'PUSH 0 XOR', input: [push(0n), op('XOR')], expected: [] },
    { name: 'PUSH 0 SHL', input: [push(0n), op('SHL')], expected: [] },
    { name: 'PUSH 0 SHR', input: [push(0n), op('SHR')], expected: [] },
    { name: 'PUSH 0 SAR', input: [push(0n), op('SAR')], expected: [] },
    { name: 'PUSH 1 MUL', input: [push(1n), op('MUL')], expected: [] },
    { name: 'PUSH 2^256-1 AND', input: [push(MAX), op('AND')], expected: [] },
    { name: 'NOT NOT', input: [op('NOT'), op('NOT')], expected: [] },
    {
      name: 'ISZERO ISZERO ISZERO',
      input: [op('ISZERO'), op('ISZERO'), op('ISZERO')],
      expected: [op('ISZERO')],
    },
    {
      name: 'PUSH 0 MUL → POP PUSH 0',
      input: [push(0n), op('MUL')],
      expected: [op('POP'), push(0n)],
    },
    {
      name: 'PUSH 0 AND → POP PUSH 0',
      input: [push(0n), op('AND')],
      expected: [op('POP'), push(0n)],
    },
  ];

  for (const c of cases) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the case table
    test(c.name, async () => {
      const data = await expectRewrite(
        [...seed, ...c.input, ...RETURN_TOP],
        [...seed, ...c.expected, ...RETURN_TOP],
      );
      // every identity leaves CALLER on top; ISZERO∘ISZERO∘ISZERO and the zeroing rewrites leave 0
      const zero =
        c.name.startsWith('PUSH 0 MUL') ||
        c.name.startsWith('PUSH 0 AND') ||
        c.name.startsWith('ISZERO');
      expect(data).toBe(zero ? word(0n) : word(0x1000000000000000000000000000000000000001n));
    });
  }

  test('non-identities are left alone: PUSH 0 SUB, PUSH 1 DIV, PUSH 1 EXP, SWAP1 SWAP2, pushLabel POP', () => {
    const w = new AsmWriter();
    const l = w.newLabel('x');
    w.push(9n);
    w.push(1n);
    w.push(2n);
    w.push(0n);
    w.op('SUB'); // 0 − 2 wraps to a 32-byte word: the size guard rejects the fold too
    w.op('CALLER');
    w.push(1n);
    w.op('DIV'); // 1 / CALLER — the immediate is the dividend, not the divisor
    w.push(1n);
    w.op('EXP'); // 1 ** x
    w.op('SWAP1');
    w.op('SWAP2');
    w.pushLabel(l);
    w.op('POP');
    w.op('POP');
    w.op('POP');
    w.op('POP');
    w.op('POP');
    w.label(l, 0);
    w.op('STOP');
    expect(evsPeephole(w.nodes())).toEqual(w.nodes());
    expect(() => assemble(w.nodes(), { evmVersion: 'cancun' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// guard rails, purity, fixpoint
// ---------------------------------------------------------------------------

describe('guard rails', () => {
  test('a label is a barrier: no window spans a JUMPDEST', () => {
    const w = new AsmWriter();
    const l = w.newLabel('mid');
    w.push(7n);
    w.push(0x80n);
    w.op('MSTORE');
    w.label(l, 0);
    w.push(0x80n);
    w.op('MLOAD');
    w.op('POP');
    w.op('STOP');
    expect(evsPeephole(w.nodes())).toEqual(w.nodes());
  });

  test('data segments are never touched', () => {
    const w = new AsmWriter();
    const d = w.newLabel('data_0');
    w.op('STOP');
    w.dataLabel(d);
    w.data(Uint8Array.of(0x60, 0x00, 0x01)); // looks like PUSH1 00 ADD, but it is data
    expect(evsPeephole(w.nodes())).toEqual(w.nodes());
  });

  test('the sanctioned RETURNDATACOPY window survives intact', () => {
    const w = new AsmWriter();
    w.returndatacopyAll('zero');
    w.op('STOP');
    const out = evsPeephole(w.nodes());
    expect(out).toEqual(w.nodes());
    expect(() => assemble(out, { evmVersion: 'cancun' })).not.toThrow();
  });

  test('pure: the input array and its nodes are not mutated', () => {
    const input = [push(7n), push(0x80n), op('MSTORE'), push(0x80n), op('MLOAD'), ...RETURN_TOP];
    const snapshot = JSON.stringify(input, (_k, v: unknown) =>
      typeof v === 'bigint' ? `${v}n` : v,
    );
    evsPeephole(input);
    expect(JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(
      snapshot,
    );
  });

  test('idempotent on a real lowered program; the output passes the verifiers on every fork', () => {
    const script = evscript({ name: 'loopy', args: [t.uint256] }, (s, n) => {
      const acc = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
        acc.set(acc.get().add(i));
      });
      return s.return({ acc: acc.get() });
    });
    for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
      const lowered = lowerProgram(script.ir, { evmVersion, locations: true }).nodes;
      const once = evsPeephole(lowered);
      expect(once.length).toBeLessThan(lowered.length);
      expect(evsPeephole(once)).toEqual(once);
      expect(() => assemble(once, { evmVersion })).not.toThrow();
    }
  });
});
