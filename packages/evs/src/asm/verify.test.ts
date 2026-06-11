import { describe, expect, test } from 'vitest';

import { EvsInternalError } from '../core/errors.js';
import { AsmWriter, type AsmNode } from './assembler.js';
import { verifyJumpdests, verifyShapes, verifyStack } from './verify.js';

const bytes = (hexStr: string): Uint8Array => {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hexStr.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
};

const NO_PCS = new Map<number, number>();

describe('verifyJumpdests', () => {
  test('accepts a JUMPDEST opcode target', () => {
    // 5b 600057 — JUMPDEST; PUSH1 00; JUMPI(target 0)
    const code = bytes('5b600057');
    expect(() => verifyJumpdests(code, new Set([0]), code.length)).not.toThrow();
  });

  test('catches a 0x5B planted inside PUSH data (consensus rule)', () => {
    // 61 5b5b 00 — PUSH2 0x5b5b; STOP. Offsets 1 and 2 are immediates, not opcodes.
    const code = bytes('615b5b00');
    expect(() => verifyJumpdests(code, new Set([1]), code.length)).toThrow(EvsInternalError);
    expect(() => verifyJumpdests(code, new Set([2]), code.length)).toThrow(/not a JUMPDEST/);
  });

  test('a 0x5B directly after a PUSH immediate IS a valid target', () => {
    // 60 5b 5b — PUSH1 0x5b; JUMPDEST. Offset 1 is data, offset 2 is the opcode.
    const code = bytes('605b5b');
    expect(() => verifyJumpdests(code, new Set([2]), code.length)).not.toThrow();
    expect(() => verifyJumpdests(code, new Set([1]), code.length)).toThrow(EvsInternalError);
  });

  test('rejects a non-JUMPDEST opcode target', () => {
    const code = bytes('005b'); // STOP; JUMPDEST
    expect(() => verifyJumpdests(code, new Set([0]), code.length)).toThrow(/not a JUMPDEST/);
  });

  test('rejects targets inside the data segment, even on a 0x5B byte', () => {
    // code: 5b 00 | guard fe | data 5b
    const code = bytes('5b00fe5b');
    expect(() => verifyJumpdests(code, new Set([3]), 2)).toThrow(/data segment/);
    expect(() => verifyJumpdests(code, new Set([0]), 2)).not.toThrow();
  });

  test('rejects targets past the end of code', () => {
    const code = bytes('5b00');
    expect(() => verifyJumpdests(code, new Set([7]), code.length)).toThrow(EvsInternalError);
  });
});

describe('verifyStack — checked labels', () => {
  test('accepts a straight-line terminated program', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n },
      { k: 'push', value: 2n },
      { k: 'op', op: 'ADD' },
      { k: 'op', op: 'POP' },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURN' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).not.toThrow();
  });

  test('accepts agreeing in-edge + fallthrough joins', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n }, // [x]
      { k: 'push', value: 1n }, // [cond, x]
      { k: 'pushLabel', label: 0 }, // [t, cond, x]
      { k: 'op', op: 'JUMPI' }, // edge to 0 at height 1; fallthrough height 1
      { k: 'label', label: 0, stack: 1 },
      { k: 'op', op: 'POP' },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURN' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).not.toThrow();
  });

  test('catches a seeded off-by-one in-edge (label annotation mismatch)', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n },
      { k: 'push', value: 1n },
      { k: 'pushLabel', label: 0 },
      { k: 'op', op: 'JUMPI' }, // edge carries height 1
      { k: 'op', op: 'POP' },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURN' },
      { k: 'label', label: 0, stack: 2, name: 'join' }, // annotated 2 — off by one
      { k: 'op', op: 'POP' },
      { k: 'op', op: 'POP' },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURN' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/@join/);
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/edge carries 1, label is annotated 2/);
  });

  test('catches a fallthrough height mismatch into a checked label', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n }, // height 1 at fallthrough
      { k: 'label', label: 0, stack: 0 },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/fallthrough carries 1/);
  });

  test('catches stack underflow', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'POP' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/underflow/);
  });

  test('DUP/SWAP reach counts as underflow when too deep', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n },
      { k: 'op', op: 'DUP2' }, // needs 2 items, has 1
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/underflow/);
  });

  test('catches template depth > 16', () => {
    const nodes: AsmNode[] = [];
    for (let i = 0; i < 17; i++) nodes.push({ k: 'push', value: 1n });
    nodes.push({ k: 'op', op: 'STOP' });
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/16-item template budget/);
  });

  test('catches code falling past the end without a terminator', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n },
      { k: 'op', op: 'POP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/falls through past the end/);
  });

  test('catches code falling into the data segment', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n },
      { k: 'op', op: 'POP' },
      { k: 'data', bytes: Uint8Array.of(1, 2) },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/falls through into the data segment/);
  });

  test('catches a jump to an undefined label and to a data label', () => {
    const toUndefined: readonly AsmNode[] = [
      { k: 'pushLabel', label: 42 },
      { k: 'op', op: 'JUMP' },
    ];
    expect(() => verifyStack(toUndefined, NO_PCS)).toThrow(/undefined label/);

    const toData: readonly AsmNode[] = [
      { k: 'pushLabel', label: 7 },
      { k: 'op', op: 'JUMP' },
      { k: 'dataLabel', label: 7 },
      { k: 'data', bytes: Uint8Array.of(1) },
    ];
    expect(() => verifyStack(toData, NO_PCS)).toThrow(/data label/);
  });

  test('catches duplicate label definitions', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 0 },
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 0 },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/defined twice/);
  });

  test('fn subroutine pattern: entry label carries baseline 1, dynamic JUMP returns', () => {
    const ret = 0;
    const fn = 1;
    const nodes: readonly AsmNode[] = [
      { k: 'pushLabel', label: ret }, // return address
      { k: 'pushLabel', label: fn },
      { k: 'op', op: 'JUMP' }, // edge to fn at height 1 (the return address)
      { k: 'label', label: ret, stack: 0 },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURN' },
      { k: 'label', label: fn, stack: 1, name: 'fn_sum' },
      { k: 'push', value: 5n },
      { k: 'op', op: 'POP' }, // net-zero body
      { k: 'op', op: 'JUMP' }, // dynamic return jump — pops the return address
    ];
    expect(() => verifyStack(nodes, NO_PCS)).not.toThrow();
  });
});

/** The §15.0 shared panic tail: relative counter, goes negative, terminates in REVERT. */
const panicTailCorpus = (): readonly AsmNode[] => [
  // main: checked region with a conditional edge into the tail
  { k: 'push', value: 1n },
  { k: 'push', value: 1n },
  { k: 'pushLabel', label: 0 },
  { k: 'op', op: 'JUMPI' }, // edge to @panic_overflow ('any') from checked: OK
  { k: 'op', op: 'POP' },
  { k: 'push', value: 0n },
  { k: 'push', value: 0n },
  { k: 'op', op: 'RETURN' },
  // @panic_overflow: JUMPDEST PUSH1 0x11 PUSH2 @panic JUMP
  { k: 'label', label: 0, stack: 'any', name: 'panic_overflow' },
  { k: 'push', value: 0x11n },
  { k: 'pushLabel', label: 1 },
  { k: 'op', op: 'JUMP' }, // 'any' → 'any' edge: OK
  // @panic: the code value is BELOW the relative baseline — counter goes negative
  { k: 'label', label: 1, stack: 'any', name: 'panic' },
  { k: 'pushBytes', bytes: Uint8Array.of(0x4e, 0x48, 0x7b, 0x71) },
  { k: 'push', value: 0xe0n },
  { k: 'op', op: 'SHL' },
  { k: 'push', value: 0n },
  { k: 'op', op: 'MSTORE' }, // rel 0
  { k: 'push', value: 4n },
  { k: 'op', op: 'MSTORE' }, // rel −1: pops the [code] that lives below the baseline
  { k: 'push', value: 0x24n },
  { k: 'push', value: 0n },
  { k: 'op', op: 'REVERT' }, // terminates the region
];

describe("verifyStack — 'any' labels", () => {
  test("accepts the panic-tail corpus (relative counter may go negative, 'any'→'any' edges)", () => {
    expect(() => verifyStack(panicTailCorpus(), NO_PCS)).not.toThrow();
  });

  test("accepts fallthrough from one 'any' region into another", () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 1n },
      { k: 'pushLabel', label: 0 },
      { k: 'op', op: 'JUMPI' },
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 'any', name: 'panic_divzero' },
      { k: 'push', value: 0x12n },
      // falls through into @panic_common
      { k: 'label', label: 1, stack: 'any', name: 'panic_common' },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'REVERT' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).not.toThrow();
  });

  test("rejects an 'any' region that falls through into a checked label", () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 'any', name: 'stub' },
      { k: 'push', value: 7n },
      { k: 'label', label: 1, stack: 1, name: 'rejoin' },
      { k: 'op', op: 'POP' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/falls through into checked label @rejoin/);
  });

  test("rejects an 'any' region that jumps to a checked label", () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 'any', name: 'stub' },
      { k: 'pushLabel', label: 1 },
      { k: 'op', op: 'JUMP' },
      { k: 'label', label: 1, stack: 0, name: 'main2' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/'any' region jumps to checked label/);
  });

  test("rejects an 'any' region that does not terminate (end of stream)", () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 'any', name: 'stub' },
      { k: 'push', value: 1n },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/must terminate in REVERT\/RETURN\/INVALID/);
  });

  test("rejects a dynamic JUMP inside an 'any' region", () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 'any', name: 'stub' },
      { k: 'push', value: 4n },
      { k: 'op', op: 'JUMP' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).toThrow(/dynamic JUMP/);
  });

  test("INVALID terminates an 'any' region", () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'STOP' },
      { k: 'label', label: 0, stack: 'any', name: 'stub' },
      { k: 'op', op: 'INVALID' },
    ];
    expect(() => verifyStack(nodes, NO_PCS)).not.toThrow();
  });
});

describe('verifyShapes — RETURNDATACOPY windows', () => {
  test('accepts both sanctioned shapes from the writer', () => {
    const w = new AsmWriter();
    // bubble path
    w.returndatacopyAll('zero');
    // snapshot path with the destination 1-deep
    w.push(0x80n);
    w.returndatacopyAll({ dupDepth: 1 });
    w.op('POP');
    w.push(0n);
    w.push(0n);
    w.op('RETURN');
    expect(() => verifyShapes(w.nodes(), { evmVersion: 'cancun' })).not.toThrow();
    expect(() => verifyShapes(w.nodes(), { evmVersion: 'paris' })).not.toThrow(); // push-0 spelling is fork-portable
  });

  test('accepts the explicit PUSH0-op spelling of the window', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'RETURNDATASIZE' },
      { k: 'op', op: 'PUSH0' },
      { k: 'op', op: 'PUSH0' },
      { k: 'op', op: 'RETURNDATACOPY' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyShapes(nodes, { evmVersion: 'cancun' })).not.toThrow();
  });

  test('catches a hand-mangled window (wrong offset operand)', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'RETURNDATASIZE' },
      { k: 'push', value: 32n }, // offset 32 — NOT the safe shape
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURNDATACOPY' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyShapes(nodes, { evmVersion: 'cancun' })).toThrow(/sanctioned window/);
  });

  test('catches a missing RETURNDATASIZE (literal size)', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 64n },
      { k: 'push', value: 0n },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURNDATACOPY' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyShapes(nodes, { evmVersion: 'cancun' })).toThrow(/sanctioned window/);
  });

  test('catches a reordered window', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURNDATASIZE' },
      { k: 'push', value: 0n },
      { k: 'op', op: 'RETURNDATACOPY' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyShapes(nodes, { evmVersion: 'cancun' })).toThrow(/sanctioned window/);
  });

  test('catches a RETURNDATACOPY with no window at all (stream too short)', () => {
    const nodes: readonly AsmNode[] = [{ k: 'op', op: 'RETURNDATACOPY' }];
    expect(() => verifyShapes(nodes, { evmVersion: 'cancun' })).toThrow(/sanctioned window/);
  });
});

describe('verifyShapes — fork gating and forbidden ops', () => {
  test('MCOPY on paris and shanghai is rejected; on cancun it passes', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'MCOPY' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyShapes(nodes, { evmVersion: 'paris' })).toThrow(/MCOPY requires/);
    expect(() => verifyShapes(nodes, { evmVersion: 'shanghai' })).toThrow(/MCOPY requires/);
    expect(() => verifyShapes(nodes, { evmVersion: 'cancun' })).not.toThrow();
  });

  test('an explicit PUSH0 op node on paris is rejected', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'op', op: 'PUSH0' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyShapes(nodes, { evmVersion: 'paris' })).toThrow(/PUSH0 requires/);
    expect(() => verifyShapes(nodes, { evmVersion: 'shanghai' })).not.toThrow();
  });

  test('push-value nodes are fork-agnostic (assembler owns the lowering)', () => {
    const nodes: readonly AsmNode[] = [
      { k: 'push', value: 0n },
      { k: 'op', op: 'POP' },
      { k: 'op', op: 'STOP' },
    ];
    expect(() => verifyShapes(nodes, { evmVersion: 'paris' })).not.toThrow();
  });
});
