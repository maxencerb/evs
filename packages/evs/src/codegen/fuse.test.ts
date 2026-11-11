/* oxlint-disable vitest/expect-expect --
 * the negative cases assert through the `unchanged` helper. */
/**
 * Unit tests — the store–reload fusion pass (`codegen/fuse.ts`, #96): every window form on
 * hand-built node streams, the negatives the accounting and the matcher must refuse, the depth
 * budget and the note handling; then the pass inside `lowerProgram` on compiled scripts (what
 * fuses, what must not). The differential corpus (`differential/fusion.test.ts`) runs the
 * shapes against the interpreter.
 */

import { describe, expect, test } from 'vite-plus/test';

import type { AsmNode } from '../asm/assembler.js';
import type { Mnemonic } from '../asm/ops.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { namedArg, t } from '../core/types.js';
import { eliminateDeadCode } from '../ir/dce.js';
import type { ValueId } from '../ir/nodes.js';
import { fuseStoreReload, type FuseInput } from './fuse.js';
import { evsPeephole } from './peephole.js';
import { lowerProgram } from './program.js';

// ---------------------------------------------------------------------------
// hand-built streams
// ---------------------------------------------------------------------------

const op = (o: Mnemonic, note?: string): AsmNode =>
  note === undefined ? { k: 'op', op: o } : { k: 'op', op: o, note };
const push = (value: number | bigint, note?: string): AsmNode =>
  note === undefined
    ? { k: 'push', value: BigInt(value) }
    : { k: 'push', value: BigInt(value), note };
const pushLabel = (label: number): AsmNode => ({ k: 'pushLabel', label });
const label = (l: number, stack: number | 'any'): AsmNode => ({ k: 'label', label: l, stack });

const V = 7 as ValueId;
const W = 8 as ValueId;
const S = 0x80;

/** A store / load registry over hand-built nodes. */
class Reg {
  readonly stores = new Map<AsmNode, ValueId>();
  readonly loads = new Map<AsmNode, ValueId>();
  readonly queries = new Map<ValueId, number>();
  store(v: ValueId, slot: number, note?: string): AsmNode {
    const node = push(slot, note);
    this.stores.set(node, v);
    this.queries.set(v, (this.queries.get(v) ?? 0) + 1);
    return node;
  }
  load(v: ValueId, slot: number, note?: string): AsmNode {
    const node = push(slot, note);
    this.loads.set(node, v);
    this.queries.set(v, (this.queries.get(v) ?? 0) + 1);
    return node;
  }
  input(): FuseInput {
    return { stores: this.stores, loads: this.loads, queries: this.queries };
  }
}

/** `[ADDRESS]` as the defining value `v` (any 1-item producer works), then the window, then a
 *  consumer and a terminating STOP. */
function stream(window: readonly AsmNode[], prefix: readonly AsmNode[] = [op('ADDRESS')]) {
  return [...prefix, ...window, op('ADD'), op('POP'), op('STOP')];
}

/** The ops / pushes of a stream as short strings (`push 0x80`, `SWAP1`, `pushLabel 3`, …). */
function shape(nodes: readonly AsmNode[]): string[] {
  return nodes.map((n) => {
    switch (n.k) {
      case 'op':
        return n.op;
      case 'push':
        return `push 0x${n.value.toString(16)}`;
      case 'pushLabel':
        return `pushLabel ${n.label}`;
      case 'label':
        return `label ${n.label}`;
      default:
        return n.k;
    }
  });
}

describe('fuseStoreReload: window forms', () => {
  test('n = 0, no L: the store and the reload vanish', () => {
    const r = new Reg();
    const nodes = stream([r.store(V, S), op('MSTORE'), r.load(V, S), op('MLOAD')]);
    const { nodes: out, stats } = fuseStoreReload(nodes, r.input());
    expect(shape(out)).toEqual(['ADDRESS', 'ADD', 'POP', 'STOP']);
    expect(stats).toEqual({ bare: 1 });
  });

  test.each([1, 2])('POP{%i}: SWAPn then the POPs', (n) => {
    const r = new Reg();
    const leftovers = Array.from({ length: n }, () => op('CALLER'));
    const pops = Array.from({ length: n }, () => op('POP'));
    const nodes = stream(
      [r.store(V, S), op('MSTORE'), ...pops, r.load(V, S), op('MLOAD')],
      [...leftovers, op('ADDRESS')],
    );
    const { nodes: out, stats } = fuseStoreReload(nodes, r.input());
    expect(shape(out)).toEqual([
      ...leftovers.map(() => 'CALLER'),
      'ADDRESS',
      `SWAP${n}`,
      ...pops.map(() => 'POP'),
      'ADD',
      'POP',
      'STOP',
    ]);
    expect(stats).toEqual({ P: 1 });
  });

  test('L immediate: L then SWAP1', () => {
    const r = new Reg();
    const nodes = stream([r.store(V, S), op('MSTORE'), push(5), r.load(V, S), op('MLOAD')]);
    const { nodes: out, stats } = fuseStoreReload(nodes, r.input());
    expect(shape(out)).toEqual(['ADDRESS', 'push 0x5', 'SWAP1', 'ADD', 'POP', 'STOP']);
    expect(stats).toEqual({ I: 1 });
  });

  test('L slot load (another word, either side): L then SWAP1', () => {
    for (const other of [S + 32, S - 32, 0x40]) {
      const r = new Reg();
      const nodes = stream([
        r.store(V, S),
        op('MSTORE'),
        push(other),
        op('MLOAD'),
        r.load(V, S),
        op('MLOAD'),
      ]);
      const { nodes: out, stats } = fuseStoreReload(nodes, r.input());
      expect(shape(out)).toEqual([
        'ADDRESS',
        `push 0x${other.toString(16)}`,
        'MLOAD',
        'SWAP1',
        'ADD',
        'POP',
        'STOP',
      ]);
      expect(stats).toEqual({ M: 1 });
    }
  });

  test('L G: the zero guard to an any label stays between L and SWAP1', () => {
    const r = new Reg();
    const window = [
      r.store(V, S),
      op('MSTORE'),
      push(S + 32),
      op('MLOAD'),
      op('DUP1'),
      op('ISZERO'),
      pushLabel(9),
      op('JUMPI'),
      r.load(V, S),
      op('MLOAD'),
    ];
    const nodes = [...stream(window), label(9, 'any'), op('INVALID')];
    const { nodes: out, stats } = fuseStoreReload(nodes, r.input());
    expect(shape(out)).toEqual([
      'ADDRESS',
      'push 0xa0',
      'MLOAD',
      'DUP1',
      'ISZERO',
      'pushLabel 9',
      'JUMPI',
      'SWAP1',
      'ADD',
      'POP',
      'STOP',
      'label 9',
      'INVALID',
    ]);
    expect(stats).toEqual({ MG: 1 });
  });

  test('POP{2} L G (the mul → div shape), immediate L', () => {
    const r = new Reg();
    const window = [
      r.store(V, S),
      op('MSTORE'),
      op('POP'),
      op('POP'),
      push(3),
      op('DUP1'),
      op('ISZERO'),
      pushLabel(9),
      op('JUMPI'),
      r.load(V, S),
      op('MLOAD'),
    ];
    const nodes = [
      ...stream(window, [op('CALLER'), op('CALLER'), op('ADDRESS')]),
      label(9, 'any'),
      op('INVALID'),
    ];
    const { nodes: out, stats } = fuseStoreReload(nodes, r.input());
    expect(shape(out)).toEqual([
      'CALLER',
      'CALLER',
      'ADDRESS',
      'SWAP2',
      'POP',
      'POP',
      'push 0x3',
      'DUP1',
      'ISZERO',
      'pushLabel 9',
      'JUMPI',
      'SWAP1',
      'ADD',
      'POP',
      'STOP',
      'label 9',
      'INVALID',
    ]);
    expect(stats).toEqual({ PIG: 1 });
  });

  test('windows chain: each fusable value fuses independently', () => {
    const r = new Reg();
    const nodes = [
      op('ADDRESS'),
      r.store(V, S),
      op('MSTORE'),
      r.load(V, S),
      op('MLOAD'),
      op('ISZERO'),
      r.store(W, S + 32),
      op('MSTORE'),
      r.load(W, S + 32),
      op('MLOAD'),
      op('POP'),
      op('STOP'),
    ];
    const { nodes: out, stats } = fuseStoreReload(nodes, r.input());
    expect(shape(out)).toEqual(['ADDRESS', 'ISZERO', 'POP', 'STOP']);
    expect(stats).toEqual({ bare: 2 });
  });
});

describe('fuseStoreReload: negatives', () => {
  const unchanged = (nodes: readonly AsmNode[], input: FuseInput): void => {
    const { nodes: out, stats } = fuseStoreReload(nodes, input);
    expect(out).toEqual(nodes);
    expect(stats).toEqual({});
  };

  test('query count 1 (no registered load) and 3 (a third access)', () => {
    const one = new Reg();
    const p = one.store(V, S);
    unchanged(stream([p, op('MSTORE'), push(S), op('MLOAD')]), one.input());

    const three = new Reg();
    const nodes = stream([three.store(V, S), op('MSTORE'), three.load(V, S), op('MLOAD')]);
    three.queries.set(V, 3); // e.g. a call-arg ref or the return encoder also read the slot
    unchanged(nodes, three.input());
  });

  test('a label between the store and the reload', () => {
    const r = new Reg();
    const nodes = [
      op('ADDRESS'),
      r.store(V, S),
      op('MSTORE'),
      label(1, 0),
      r.load(V, S),
      op('MLOAD'),
      op('POP'),
      op('STOP'),
    ];
    unchanged(nodes, r.input());
  });

  test('L loading the same word or an overlapping one', () => {
    for (const other of [S, S + 1, S - 31, S + 31]) {
      const r = new Reg();
      const nodes = stream([
        r.store(V, S),
        op('MSTORE'),
        push(other),
        op('MLOAD'),
        r.load(V, S),
        op('MLOAD'),
      ]);
      unchanged(nodes, r.input());
    }
  });

  test('G jumping to a checked label', () => {
    const r = new Reg();
    const window = [
      r.store(V, S),
      op('MSTORE'),
      push(3),
      op('DUP1'),
      op('ISZERO'),
      pushLabel(9),
      op('JUMPI'),
      r.load(V, S),
      op('MLOAD'),
    ];
    unchanged([...stream(window), label(9, 1), op('STOP')], r.input());
  });

  test('G without an L, and two operand loads between', () => {
    const r = new Reg();
    const g = [
      r.store(V, S),
      op('MSTORE'),
      op('DUP1'),
      op('ISZERO'),
      pushLabel(9),
      op('JUMPI'),
      r.load(V, S),
      op('MLOAD'),
    ];
    unchanged([...stream(g), label(9, 'any'), op('INVALID')], r.input());

    const r2 = new Reg();
    const two = [
      r2.store(V, S),
      op('MSTORE'),
      push(1),
      push(S + 32),
      op('MLOAD'),
      r2.load(V, S),
      op('MLOAD'),
    ];
    unchanged(stream(two), r2.input());
  });

  test('R a load of a different value sharing the slot number', () => {
    const r = new Reg();
    const p = r.store(V, S);
    const other = r.load(W, S); // W shares V's slot under the liveness allocator
    r.queries.set(V, 2); // V's own load sits elsewhere
    unchanged(stream([p, op('MSTORE'), other, op('MLOAD')]), r.input());
  });

  test('the registered reload not adjacent to the window', () => {
    const r = new Reg();
    const nodes = stream([
      r.store(V, S),
      op('MSTORE'),
      op('CALLER'),
      op('ISZERO'),
      op('POP'),
      r.load(V, S),
      op('MLOAD'),
    ]);
    unchanged(nodes, r.input());
  });

  test('a fused form deeper than 16 in a checked region is skipped', () => {
    const window = (r: Reg): AsmNode[] => [
      r.store(V, S),
      op('MSTORE'),
      push(3),
      op('DUP1'),
      op('ISZERO'),
      pushLabel(9),
      op('JUMPI'),
      r.load(V, S),
      op('MLOAD'),
    ];
    // height h before the store (v included): the original peaks at h + 2, the fused form at
    // h + 3
    const at = (h: number): { nodes: AsmNode[]; input: FuseInput } => {
      const r = new Reg();
      const prefix = Array.from({ length: h }, () => op('CALLER'));
      const tail = Array.from({ length: h }, () => op('POP'));
      return {
        nodes: [...prefix, ...window(r), op('ADD'), ...tail, op('STOP'), label(9, 'any')],
        input: r.input(),
      };
    };
    const fits = at(13);
    expect(fuseStoreReload(fits.nodes, fits.input).stats).toEqual({ IG: 1 });
    const over = at(14);
    expect(fuseStoreReload(over.nodes, over.input).nodes).toEqual(over.nodes);
  });
});

describe('fuseStoreReload: purity and notes', () => {
  test('input nodes are never mutated; the reload note moves to the first free node', () => {
    const r = new Reg();
    const p = r.store(V, S, 'store note');
    const l = push(5);
    const reload = r.load(V, S, 'consumer');
    const nodes = stream([p, op('MSTORE'), l, reload, op('MLOAD')]);
    const before = structuredClone(nodes);
    const { nodes: out } = fuseStoreReload(nodes, r.input());
    expect(nodes).toEqual(before);
    expect(l).not.toHaveProperty('note');
    expect(out[1]).toEqual({ k: 'push', value: 5n, note: 'consumer' }); // a copy of L
    expect(out[1]).not.toBe(l);
  });

  test('the store note goes to SWAPn; the reload note to the first node without one', () => {
    const r = new Reg();
    const nodes = stream(
      [r.store(V, S, 'def'), op('MSTORE'), op('POP'), r.load(V, S, 'use'), op('MLOAD')],
      [op('CALLER'), op('ADDRESS')],
    );
    const { nodes: out } = fuseStoreReload(nodes, r.input());
    expect(out.slice(2, 4)).toEqual([
      { k: 'op', op: 'SWAP1', note: 'def' },
      { k: 'op', op: 'POP', note: 'use' },
    ]);
  });

  test('a bare window hands the reload note to the next node of the block', () => {
    const r = new Reg();
    const nodes = stream([r.store(V, S), op('MSTORE'), r.load(V, S, 'use'), op('MLOAD')]);
    const { nodes: out } = fuseStoreReload(nodes, r.input());
    expect(out[1]).toEqual({ k: 'op', op: 'ADD', note: 'use' });
  });
});

// ---------------------------------------------------------------------------
// inside lowerProgram
// ---------------------------------------------------------------------------

/** The optimized lowering of a script (dce'd like compile()), before and after the peephole. */
function lowered(script: { readonly ir: Parameters<typeof eliminateDeadCode>[0] }) {
  const result = lowerProgram(eliminateDeadCode(script.ir), {
    evmVersion: 'cancun',
    optimize: true,
  });
  return { ...result, peeped: evsPeephole(result.nodes) };
}

/** Every `PUSH s MSTORE` / `PUSH s MLOAD` slot address in the static frame (≥ 0x80). */
function frameAccesses(nodes: readonly AsmNode[], kind: 'MSTORE' | 'MLOAD'): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a?.k === 'push' && a.value >= 0x80n && a.value < 0x1000n && b?.k === 'op' && b.op === kind)
      out.push(a.value);
  }
  return out;
}

describe('fusion in lowerProgram (optimize: true)', () => {
  test('optimize: false lowers no fusion at all', () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, x) =>
      s.return({ r: x.add(1n).mul(3n) }),
    );
    expect(lowerProgram(script.ir, { evmVersion: 'cancun' }).fused).toBeNull();
  });

  test("the issue's if (x <= 10): no store of the condition, GT PUSH2 JUMPI", () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, x) => {
      const r = s.let(t.uint256, 0n);
      s.if(x.lte(10n), () => r.set(1n));
      return s.return({ r: r.get() });
    });
    const { peeped, fused } = lowered(script);
    expect(fused).toMatchObject({ bare: 1 });
    const ops = shape(peeped);
    const gt = ops.indexOf('GT');
    expect(ops.slice(gt, gt + 3)).toEqual(['GT', expect.stringMatching(/^pushLabel/), 'JUMPI']);
    // the frame stores left: the arg, the cell init, the cell write and the returned cellget;
    // the condition's slot is never written
    expect(frameAccesses(peeped, 'MSTORE')).toHaveLength(4);
  });

  test('an arithmetic chain keeps no intermediate stores', () => {
    const script = evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, x, y) =>
      s.return({ r: x.add(y).mul(3n).sub(y).div(7n).mod(y) }),
    );
    const { nodes } = lowered(script);
    // the args, then the returned value only
    expect(frameAccesses(nodes, 'MSTORE')).toHaveLength(3);
  });

  test("a loop header's condition is fused", () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, n) => {
      const total = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n }, (i) => total.set(total.get().add(i)));
      return s.return({ total: total.get() });
    });
    const { peeped, fused } = lowered(script);
    expect(fused).toMatchObject({ bare: expect.any(Number) });
    const head = peeped.findIndex((n) => n.k === 'label' && n.name?.startsWith('while_') === true);
    const ops = shape(peeped.slice(head));
    // `lt(i, until)` feeds the header's JUMPI directly: the comparison (flipped to GT, as the
    // template loads the just-stored counter snapshot first) then ISZERO pushLabel JUMPI
    const lt = ops.findIndex((o) => o === 'LT' || o === 'GT');
    expect(ops.slice(lt, lt + 4)).toEqual([
      expect.stringMatching(/^[LG]T$/),
      'ISZERO',
      expect.stringMatching(/^pushLabel/),
      'JUMPI',
    ]);
  });

  test('a value read twice is not fused (x.mul(x), and two later statements)', () => {
    const square = evscript({ name: 'f', args: [t.uint256] }, (s, x) => {
      const y = x.add(1n);
      return s.return({ r: y.mul(y) });
    });
    const sq = lowered(square);
    expect(sq.fused).toEqual({});
    // `y` is stored, then loaded twice (the peephole later turns the second load into a DUP1)
    const ops = shape(sq.nodes);
    const reloads = ops.findIndex(
      (o, k) => o === 'MSTORE' && ops[k + 2] === 'MLOAD' && ops[k + 4] === 'MLOAD',
    );
    expect(ops[reloads - 1]).toBe(ops[reloads + 1]);
    expect(ops[reloads + 1]).toBe(ops[reloads + 3]);

    const twice = evscript({ name: 'f', args: [t.uint256] }, (s, x) => {
      const y = x.add(1n);
      return s.return({ a: y.mul(2n), b: y.mul(3n) });
    });
    // `y` has two readers; only the two products' own stores could fuse — they are returned
    expect(lowered(twice).fused).toEqual({});
  });

  test('a value read only by a call argument, the return record or a later statement: kept', () => {
    const abi = [
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'a', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ] as const;
    const callArg = evscript({ name: 'f', args: [t.uint256] }, (s, x) => {
      const who = x.add(1n).asAddress();
      const b = s.read({
        address: '0x0000000000000000000000000000000000000001',
        abi,
        functionName: 'balanceOf',
        args: [who],
      });
      return s.return({ b });
    });
    // `x + 1` feeds `.asAddress()` (fused); the address itself only reaches the call's encoder
    const ca = lowered(callArg);
    expect(ca.fused).toEqual({ bare: 1 });

    const returned = evscript({ name: 'f', args: [t.uint256] }, (s, x) =>
      s.return({ r: x.add(1n) }),
    );
    expect(lowered(returned).fused).toEqual({});

    const later = evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, x, y) => {
      const a = x.add(1n);
      const b = y.add(2n);
      return s.return({ r: a.add(b) }); // `a` is read two statements after its definition
    });
    // the commutative add loads the just-stored `b` first (fused); `a` keeps its round trip
    const lt = lowered(later);
    expect(lt.fused).toEqual({ bare: 1 });
    const slotOfA = frameAccesses(lt.nodes, 'MSTORE')[2]; // after the two args
    expect(slotOfA).toBeDefined();
    expect(frameAccesses(lt.nodes, 'MLOAD')).toContain(slotOfA);
  });

  test('an s.fn whose last statement defines its result fuses into the epilogue', () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, x) => {
      const inc = s.fn('inc', [namedArg('a', t.uint256)] as const, (a) => a.add(1n).mul(2n));
      return s.return({ r: inc(x) });
    });
    const { nodes, fused } = lowered(script);
    // `a + 1` → mul (bare), the product → the result-region store (bare)
    expect(fused).toEqual({ bare: 2 });
    const entry = nodes.findIndex((n) => n.k === 'label' && n.name === 'fn_inc');
    const body = shape(nodes.slice(entry));
    const mulAt = body.indexOf('MUL');
    expect(body.slice(mulAt + 1, mulAt + 3)).toEqual([
      expect.stringMatching(/^push/), // the result slot
      'MSTORE',
    ]);
  });

  test('compiled optimize: true output is smaller than before the pass, results identical', () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, x) => {
      const r = s.let(t.uint256, 0n);
      s.if(x.lte(10n), () => r.set(x.add(1n).mul(3n).sub(2n)));
      return s.return({ r: r.get() });
    });
    const plain = compile(script).runtimeBytecode.length;
    const optimized = compile(script, { optimize: true }).runtimeBytecode.length;
    expect(optimized).toBeLessThan(plain);
  });
});
