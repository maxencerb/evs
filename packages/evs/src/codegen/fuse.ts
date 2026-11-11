/**
 * `codegen/fuse.ts` — store–reload fusion (#96), the `optimize: true` pass that keeps a
 * single-use temporary on the stack instead of sending it through its frame slot.
 *
 * Every statement template is net-zero: it ends with `storeOut` (`PUSH s MSTORE`) and its
 * consumer reloads the operand with `loadOperand` (`PUSH s MLOAD`), even when the consumer is
 * the very next statement. The peephole's store-then-reload rewrite turns an adjacent pair into
 * `DUP1 PUSH s MSTORE`, but it cannot drop the store: `evsPeephole` is a pure function of the
 * node stream and has no use information. This pass has it, from codegen's own accounting, and
 * runs as the last step of `lowerProgram` (before the peephole sees the stream).
 *
 * **Accounting** (`lowerProgram`, `lower/context.ts`). Two `FrameLayout` calls hand out a
 * value's slot address: `slotOfValue(v)`, and `fnRegion(f)`, whose `params` are the slots of the
 * fn's param values. Under `optimize` the layout is wrapped in a counting gateway
 * (`countingLayout`, `program.ts`) that counts both: every non-null `slotOfValue(v)` counts one
 * query of `v`, and every `fnRegion(f)` counts one query of each param value of `f`, so a param
 * is never fusable however it comes to be stored. `storeOut` emits
 * exactly one `PUSH s MSTORE` per query and registers its `push` node as "the store of `v`";
 * `loadOperand` (slot arm) emits exactly one `PUSH s MLOAD` per query and registers its `push`
 * as "a load of `v`" (`FusionLog`, keyed by node identity). A value is **fusable** iff it was
 * queried exactly twice and both queries are its one registered store and its one registered
 * load: then no other instruction addresses its slot on its behalf (a call-arg ref, the return
 * encoder, a second load, a second store would each be a third query), and values sharing the
 * slot under the liveness allocator only ever read their own stores. Counts may over-count
 * (speculative emission rolled back, the site table and diagnostics after emission) — that only
 * loses a fusion — but never under-count, which is why the pass runs after `collectSites` and
 * the diagnostics. (The codec planner's dry runs never touch the counting layout: they emit
 * into scratch writers with their own refs.)
 *
 * **Windows.** At a registered store `P = PUSH s` of a fusable `v`, the pass matches
 *
 *   P MSTORE   POP{n}   [ L [ G ] ]   R MLOAD
 *
 * - `POP{n}`: `0 ≤ n ≤ 16` POPs, the defining template's leftover operands (the 256-bit checked
 *   `mul`, the int256 `add` / `sub` and the signed `mul` templates end `storeOut; POP; POP`);
 *   `MAX_POPS = 16` (the deepest `SWAPn`) is a ceiling for totality, which the 16-item template
 *   budget never lets a checked region reach;
 * - `L`: one other operand load — a `push` not followed by `MLOAD` (an immediate), or
 *   `PUSH x MLOAD` with `|x − s| ≥ 32` (a different memory word);
 * - `G` (only after `L`): `DUP1 ISZERO pushLabel(ℓ) JUMPI` with ℓ an `'any'` label (the `div` /
 *   `mod` zero guard jumping to a shared panic tail);
 * - `R`: the node registered as the load of `v` (by identity), then `MLOAD`;
 *
 * and replaces it with `[SWAPn POP{n}] [L [G] SWAP1]` (nothing at all for `n = 0` without `L`).
 * Why each form is right:
 * - memory: the removed store's word is read by nothing but `R` (fusable), and `L` reads a
 *   different word, so dropping the store and the reload changes no observable load;
 * - stack, `n = 0`, no `L`: `[v] → store → [] → reload → [v]` becomes `[v]`;
 * - stack, `POP{n}`: `[v, a₁…aₙ]` → store, n POPs, reload → `[v]`; `SWAPn` then n POPs → `[v]`;
 * - stack, `L`: `[] → L → [b] → reload → [v, b]` becomes `[v] → L → [b, v] → SWAP1 → [v, b]`;
 * - `G`: on the fallthrough the stack is `[b, v]` where it was `[b]`, which the trailing `SWAP1`
 *   fixes; the taken branch lands on an `'any'` label, where the height does not matter (the
 *   tail reverts);
 * - no `label` node can sit inside a window (it breaks the match), so a fused value never
 *   crosses a JUMPDEST and never changes the height at a checked label or jump: every label
 *   keeps its annotated height (statement-level labels sit at the statement baseline), and the
 *   mandatory verifiers (`asm/verify.ts`) re-check every label's annotated height on the fused
 *   stream on every compile;
 * - depth: inside a window the fused code is at most one item deeper than the original; a window
 *   that would exceed the 16-item template budget in a checked region is left alone (the same
 *   `stackHeights` walk the peephole's budget and `verifyStack` use).
 * A value whose store and reload do not form such a window keeps its frame round trip (and a
 * fused value keeps its now-unused frame slot; under the liveness allocator that costs nothing
 * measurable).
 *
 * Source map: input nodes are never mutated (a node that gains a `note` is copied). `R`'s note
 * (the consuming statement's annotation when the reload was its first node) moves to the first
 * replacement node without one, else to the first later node of the same block that can carry
 * one and has none; `P`'s note moves to `SWAPn` when one is emitted. A note with nowhere to go is
 * dropped.
 */

import type { AsmNode, LabelId } from '../asm/assembler.js';
import { OPS, type Mnemonic } from '../asm/ops.js';
import { MAX_TEMPLATE_DEPTH, stackHeights } from '../asm/verify.js';
import type { ValueId } from '../ir/nodes.js';

/** What the pass needs from one lowering (see the module doc). */
export interface FuseInput {
  /** The registered `storeOut` push nodes, with their value. */
  readonly stores: ReadonlyMap<AsmNode, ValueId>;
  /** The registered `loadOperand` push nodes, with their value. */
  readonly loads: ReadonlyMap<AsmNode, ValueId>;
  /** How many times each value's slot was handed out by the counting `slotOfValue`. */
  readonly queries: ReadonlyMap<ValueId, number>;
}

/**
 * How many windows of each form fused, keyed `[P][I|M][G]` (`P`: leftover POPs; `I`: an
 * immediate `L`; `M`: a memory-load `L`; `G`: the zero guard), `bare` for the plain
 * `P MSTORE R MLOAD`.
 */
export type FuseStats = Record<string, number>;

/** `SWAP1` … `SWAP16`, by depth − 1. */
const SWAPS: readonly Mnemonic[] = [
  'SWAP1',
  'SWAP2',
  'SWAP3',
  'SWAP4',
  'SWAP5',
  'SWAP6',
  'SWAP7',
  'SWAP8',
  'SWAP9',
  'SWAP10',
  'SWAP11',
  'SWAP12',
  'SWAP13',
  'SWAP14',
  'SWAP15',
  'SWAP16',
];

/** Most leftover operands a template leaves under its result (`SWAP16` is the deepest swap). */
const MAX_POPS = 16;

type OpNode = Extract<AsmNode, { k: 'op' }>;
type PushNode = Extract<AsmNode, { k: 'push' }>;

/** A matched window: `len` input nodes from the store, to be replaced by `out`. */
interface Window {
  readonly len: number;
  readonly out: readonly AsmNode[];
  readonly form: string;
  /** Whether `out` opens with the `SWAPn` of leftover POPs. */
  readonly swaps: boolean;
  /** The `note` of the removed store push / reload push. */
  readonly storeNote: string | undefined;
  readonly reloadNote: string | undefined;
}

/**
 * The store–reload fusion pass. Pure: returns a new stream (surviving nodes by reference, noted
 * copies and fresh `SWAP` nodes otherwise) and the per-form counts.
 */
export function fuseStoreReload(
  nodes: readonly AsmNode[],
  input: FuseInput,
): { nodes: AsmNode[]; stats: FuseStats } {
  const stats: FuseStats = {};
  if (input.stores.size === 0 || input.loads.size === 0) return { nodes: [...nodes], stats };
  const anyLabels = new Set<LabelId>();
  for (const node of nodes)
    if (node.k === 'label' && node.stack === 'any') anyLabels.add(node.label);
  const heights = stackHeights(nodes);

  const out: AsmNode[] = [];
  // a reload note waiting for the next node of the block that can carry it
  let pending: string | undefined;
  const emit = (node: AsmNode): void => {
    if (node.k === 'label' || node.k === 'dataLabel') {
      pending = undefined;
      out.push(node);
      return;
    }
    if (pending !== undefined && node.note === undefined) {
      out.push({ ...node, note: pending });
      pending = undefined;
      return;
    }
    out.push(node);
  };

  let i = 0;
  while (i < nodes.length) {
    const win = matchWindow(nodes, i, input, anyLabels);
    if (win !== null && withinBudget(heights[i], win.out)) {
      stats[win.form] = (stats[win.form] ?? 0) + 1;
      const replaced = placeNotes(win);
      if (replaced.leftover !== undefined && pending === undefined) pending = replaced.leftover;
      for (const node of replaced.out) emit(node);
      i += win.len;
      continue;
    }
    const node = nodes[i];
    if (node !== undefined) emit(node);
    i += 1;
  }
  return { nodes: out, stats };
}

/** Matches the window of the module doc at `nodes[i]`, or `null`. */
function matchWindow(
  nodes: readonly AsmNode[],
  i: number,
  input: FuseInput,
  anyLabels: ReadonlySet<LabelId>,
): Window | null {
  const p = nodes[i];
  if (!isPush(p) || !isOp(nodes[i + 1], 'MSTORE')) return null;
  const v = input.stores.get(p);
  if (v === undefined || input.queries.get(v) !== 2) return null;
  const s = p.value;

  let j = i + 2;
  const pops: AsmNode[] = [];
  while (isOp(nodes[j], 'POP') && pops.length < MAX_POPS) {
    const pop = nodes[j];
    if (pop !== undefined) pops.push(pop);
    j += 1;
  }
  const n = pops.length;

  const isReload = (k: number): boolean => {
    const r = nodes[k];
    return isPush(r) && input.loads.get(r) === v && r.value === s && isOp(nodes[k + 1], 'MLOAD');
  };
  const swapN = (): AsmNode[] =>
    n === 0 ? [] : [{ k: 'op', op: SWAPS[n - 1] ?? 'SWAP16' }, ...pops];
  const tag = (l: string, g: boolean): string => {
    const form = `${n > 0 ? 'P' : ''}${l}${g ? 'G' : ''}`;
    return form === '' ? 'bare' : form;
  };
  const notes = (r: number) => ({
    swaps: n > 0,
    storeNote: p.note,
    reloadNote: noteOf(nodes[r]),
  });

  // P MSTORE POP{n} R MLOAD
  if (isReload(j)) {
    return { len: j + 2 - i, out: swapN(), form: tag('', false), ...notes(j) };
  }

  // L: an immediate, or a load of another word
  const l = nodes[j];
  if (!isPush(l)) return null;
  let lNodes: AsmNode[];
  let lKind: 'I' | 'M';
  if (isOp(nodes[j + 1], 'MLOAD')) {
    if (absDiff(l.value, s) < 32n) return null;
    const mload = nodes[j + 1];
    if (mload === undefined) return null;
    lNodes = [l, mload];
    lKind = 'M';
  } else {
    lNodes = [l];
    lKind = 'I';
  }
  let k = j + lNodes.length;

  // G: DUP1 ISZERO pushLabel(ℓ) JUMPI, ℓ an 'any' label
  let gNodes: AsmNode[] = [];
  const g0 = nodes[k];
  const g1 = nodes[k + 1];
  const g2 = nodes[k + 2];
  const g3 = nodes[k + 3];
  if (
    isOp(g0, 'DUP1') &&
    isOp(g1, 'ISZERO') &&
    g2 !== undefined &&
    g2.k === 'pushLabel' &&
    anyLabels.has(g2.label) &&
    isOp(g3, 'JUMPI')
  ) {
    gNodes = [g0, g1, g2, g3];
    k += 4;
  }
  if (!isReload(k)) return null;
  return {
    len: k + 2 - i,
    out: [...swapN(), ...lNodes, ...gNodes, { k: 'op', op: 'SWAP1' }],
    form: tag(lKind, gNodes.length > 0),
    ...notes(k),
  };
}

/**
 * Moves the removed nodes' notes onto the replacement (copying the nodes that gain one): the
 * store's onto `SWAPn` (the first replacement node, when `n > 0`), the reload's onto the first
 * replacement node still without one. `leftover` is the reload note when no replacement node
 * could take it (the caller hands it to the next node of the block).
 */
function placeNotes(win: Window): { out: AsmNode[]; leftover: string | undefined } {
  const out = [...win.out];
  const first = out[0];
  if (win.storeNote !== undefined && win.swaps && first !== undefined && first.k === 'op') {
    out[0] = { ...first, note: win.storeNote };
  }
  let leftover = win.reloadNote;
  if (leftover !== undefined) {
    for (let k = 0; k < out.length; k++) {
      const node = out[k];
      if (node === undefined || node.k === 'label' || node.k === 'dataLabel') continue;
      if (node.note !== undefined) continue;
      out[k] = { ...node, note: leftover };
      leftover = undefined;
      break;
    }
  }
  return { out, leftover };
}

/**
 * Whether the replacement, run from the height before the window, stays within the template
 * budget. Only checked regions carry one (`'any'` regions and unreachable code are not budgeted
 * by `verifyStack`).
 */
function withinBudget(height: number | 'any' | null | undefined, out: readonly AsmNode[]): boolean {
  if (typeof height !== 'number') return true;
  let h = height;
  let peak = h;
  for (const node of out) {
    if (node.k === 'push' || node.k === 'pushBytes' || node.k === 'pushLabel') h += 1;
    else if (node.k === 'op') h += OPS[node.op].pushes - OPS[node.op].pops;
    if (h > peak) peak = h;
  }
  return peak <= MAX_TEMPLATE_DEPTH;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function noteOf(node: AsmNode | undefined): string | undefined {
  return node === undefined || node.k === 'label' || node.k === 'dataLabel' ? undefined : node.note;
}

function isPush(node: AsmNode | undefined): node is PushNode {
  return node !== undefined && node.k === 'push';
}

function isOp(node: AsmNode | undefined, op: Mnemonic): node is OpNode {
  return node !== undefined && node.k === 'op' && node.op === op;
}
