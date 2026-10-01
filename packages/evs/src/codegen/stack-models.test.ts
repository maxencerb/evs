/**
 * Cross-check of the stack-height models over real lowered programs.
 *
 * `verifyStack` (`asm/verify.ts`) is the authority; it checks the heights of the shared
 * `stackHeights` walk, which the peephole also reads for its depth budget. A third, cheaper
 * walker restates the model for its own purpose: `AsmWriter.peakHeightSince` (whether a
 * speculatively emitted decoder fits the 16-item budget). They share `TERMINATORS`
 * (`asm/ops.ts`), but nothing else forces them to agree, so this suite pins the agreement on a
 * corpus that spans the emitter paths:
 *
 * - `stackHeights` vs `verifyStack`'s budget: at a node where the walk reports checked height
 *   `h`, inserting `16 − h` pushes (then as many POPs) must still verify, and one push more must
 *   trip the budget — so the walk's height is exactly the one the verifier enforces.
 * - `peakHeightSince` vs `stackHeights`: replaying the stream into a writer, the peak from a
 *   checkpoint is the highest checked height the walk reports from that node on.
 */

import { type Abi, parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { AsmWriter, type AsmNode } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { MAX_TEMPLATE_DEPTH, stackHeights, verifyStack } from '../asm/verify.js';
import { evscript, type EvsScript } from '../builder/script.js';
import { namedArg, t } from '../core/types.js';
import { eliminateDeadCode } from '../ir/dce.js';
import { evsPeephole } from './peephole.js';
import { lowerProgram } from './program.js';

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]);
const gridAbi = [
  {
    type: 'function',
    name: 'grid',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple[][]',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
  },
] as const satisfies Abi;

const Boom = t.error('Boom', [namedArg('x', t.uint256)]);

const CORPUS: readonly (() => EvsScript)[] = [
  // calls: string decode, RETURNDATACOPY windows, tryRead zero blocks, decode-fail stubs
  () =>
    evscript({ name: 'reads', args: [t.address, t.address] }, (s, token, user) => {
      const symbol = s.read({ address: token, abi: erc20, functionName: 'symbol' });
      const bal = s.read({ address: token, abi: erc20, functionName: 'balanceOf', args: [user] });
      const dec = s.tryRead({ address: token, abi: erc20, functionName: 'decimals' });
      return s.return({ symbol, bal, decimals: s.select(dec.success, dec.value, 18) });
    }),
  // the speculative array decoders: stack fast path and heap-frame path, plus loops
  () =>
    evscript(
      { name: 'arrays', args: [t.array(t.array(t.uint256)), 'uint256[][][]', t.address] },
      (s, grid, cube, pool) => {
        const total = s.let(t.uint256, 0n);
        s.forEach(grid, (row) => {
          s.forEach(row, (x) => {
            total.set(total.get().add(x));
          });
        });
        const cells = s.read({ address: pool, abi: gridAbi, functionName: 'grid' });
        return s.return({ total: total.get(), cube, rows: cells.length() });
      },
    ),
  // fn subroutines (dynamic return jumps), the simulate trampoline, a custom error, checked pow
  () =>
    evscript(
      { name: 'mixed', args: [t.address, t.uint256, t.uint8], errors: [Boom] },
      (s, token, x, e) => {
        const bump = s.fn('bump', t.uint256, (v) => {
          s.if(s.gt(v, 100n), () => {
            s.throw(Boom, { x: v });
          });
          return s.add(v, 1n);
        });
        const sent = s.simulate({
          address: token,
          abi: erc20,
          functionName: 'transfer',
          args: [token, 1n],
        });
        return s.return({ out: bump(x), p: x.pow(e), sent });
      },
    ),
];

interface Stream {
  readonly name: string;
  readonly nodes: readonly AsmNode[];
}

/** Every stream the walkers see: plain and optimized lowering, before and after the peephole. */
function streams(): readonly Stream[] {
  const out: Stream[] = [];
  for (const make of CORPUS) {
    const script = make();
    for (const evmVersion of ['paris', 'cancun'] as const satisfies readonly EvmVersion[]) {
      for (const optimize of [false, true]) {
        const { nodes } = lowerProgram(eliminateDeadCode(script.ir), { evmVersion, optimize });
        const tag = `${script.name} ${evmVersion}${optimize ? ' optimize' : ''}`;
        out.push({ name: tag, nodes });
        if (optimize) out.push({ name: `${tag} + peephole`, nodes: evsPeephole(nodes) });
      }
    }
  }
  return out;
}

/** Up to `count` evenly spaced indices among those `keep` accepts (bounds the quadratic cost). */
function sample(length: number, count: number, keep: (i: number) => boolean): number[] {
  const all = Array.from({ length }, (_, i) => i).filter(keep);
  const step = Math.max(1, Math.floor(all.length / count));
  return all.filter((_, j) => j % step === 0);
}

const STREAMS: readonly Stream[] = streams();

const NO_PCS: ReadonlyMap<number, number> = new Map();

/**
 * The checked height before each node (`null` in `'any'` regions and unreachable code, where no
 * budget applies), dropping the walk's trailing past-the-end entry.
 */
function checkedHeights(nodes: readonly AsmNode[]): (number | null)[] {
  return stackHeights(nodes)
    .slice(0, nodes.length)
    .map((h) => (typeof h === 'number' ? h : null));
}

// ---------------------------------------------------------------------------
// stackHeights vs verifyStack
// ---------------------------------------------------------------------------

describe('stackHeights agrees with the verifyStack budget', () => {
  const pushes = (n: number): AsmNode[] =>
    Array.from({ length: n }, (): AsmNode => ({ k: 'push', value: 0n }));
  const pops = (n: number): AsmNode[] =>
    Array.from({ length: n }, (): AsmNode => ({ k: 'op', op: 'POP' }));

  for (const stream of STREAMS) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the stream corpus
    test(stream.name, () => {
      const { nodes } = stream;
      verifyStack(nodes, NO_PCS); // the stream itself is clean
      const heights = checkedHeights(nodes);
      // skip the slot between a pushLabel and its JUMP/JUMPI: a padding there would turn the
      // statically-known edge into a dynamic one
      const at = sample(nodes.length, 60, (i) => {
        return heights[i] !== null && nodes[i - 1]?.k !== 'pushLabel';
      });
      expect(at.length).toBeGreaterThan(0);
      for (const i of at) {
        const room = MAX_TEMPLATE_DEPTH - (heights[i] ?? 0);
        const padded = (n: number): AsmNode[] => [
          ...nodes.slice(0, i),
          ...pushes(n),
          ...pops(n),
          ...nodes.slice(i),
        ];
        expect(() => verifyStack(padded(room), NO_PCS), `node ${i}`).not.toThrow();
        expect(() => verifyStack(padded(room + 1), NO_PCS), `node ${i}`).toThrow(
          /exceeds the 16-item template budget/,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// peakHeightSince vs stackHeights
// ---------------------------------------------------------------------------

/** Re-emits `nodes` through the writer API (lowering never emits a bare PUSH op). */
function replay(w: AsmWriter, nodes: readonly AsmNode[]): void {
  for (const node of nodes) {
    const meta = 'note' in node && node.note !== undefined ? { note: node.note } : undefined;
    switch (node.k) {
      case 'op':
        w.op(node.op, meta);
        break;
      case 'push':
        w.push(node.value, meta);
        break;
      case 'pushBytes':
        w.pushBytes(node.bytes, meta);
        break;
      case 'pushLabel':
        w.pushLabel(node.label, meta);
        break;
      case 'label':
        w.label(node.label, node.stack, node.name);
        break;
      case 'dataLabel':
        w.dataLabel(node.label, node.name);
        break;
      case 'data':
        w.data(node.bytes, node.note);
        break;
    }
  }
}

describe('AsmWriter.peakHeightSince agrees with stackHeights', () => {
  for (const stream of STREAMS) {
    // oxlint-disable-next-line vitest/valid-title -- parametrized over the stream corpus
    test(stream.name, () => {
      const { nodes } = stream;
      const heights = checkedHeights(nodes);
      const at = sample(nodes.length, 12, (i) => heights[i] !== null);
      expect(at.length).toBeGreaterThan(0);
      for (const i of at) {
        const w = new AsmWriter();
        replay(w, nodes.slice(0, i));
        const cp = w.checkpoint();
        replay(w, nodes.slice(i));
        expect(w.nodes()).toEqual(nodes); // the replay is faithful
        let expected = 0;
        for (const h of heights.slice(i)) if (h !== null && h > expected) expected = h;
        expect(w.peakHeightSince(cp, heights[i] ?? 0), `from node ${i}`).toBe(expected);
      }
    });
  }
});
