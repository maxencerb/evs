/**
 * `asm/verify.ts` — the three always-on verification passes.
 *
 * 1. `verifyJumpdests` — consensus-identical JUMPDEST scan (PUSH immediates are not jumpdests);
 *    the same linear opcode scan rejects any FORBIDDEN opcode byte in the code region.
 * 2. `verifyStack` — stack-height simulation with `checked` and `'any'` label classes, over the
 *    `stackHeights` walk (exported: the peephole's depth budget reads the same heights).
 * 3. `verifyShapes` — RETURNDATACOPY windows, fork gating.
 *
 * Every failure is an `EvsInternalError` ("bug in evs, please report"): these passes guard
 * compiler output, not user input.
 */

import { EvsInternalError } from '../core/errors.js';
import type { AsmNode, LabelId } from './assembler.js';
import { FORBIDDEN, isDupOp, OPS, type EvmVersion, type Mnemonic } from './ops.js';

function fail(message: string): never {
  throw new EvsInternalError('INTERNAL', `asm verifier: ${message}`);
}

// ---------------------------------------------------------------------------
// pass 1 — JUMPDEST scan
// ---------------------------------------------------------------------------

const PUSH1_CODE = 0x60;
const PUSH32_CODE = 0x7f;
const JUMPDEST_CODE = 0x5b;

/**
 * Validates every statically-known jump target against the consensus JUMPDEST rule:
 * a single linear scan from offset 0 in which PUSH immediates are skipped; a `0x5B`
 * encountered *as an opcode* is a valid destination, a `0x5B` inside push data is not.
 * `dataStart` is the offset of the INVALID guard byte (or `bytecode.length` when there is no
 * data segment); no jump target may point at or past it. The scan also rejects every FORBIDDEN
 * opcode (`asm/ops.ts`) it meets — push data and the data segment are skipped, so only real
 * opcodes count.
 */
export function verifyJumpdests(
  bytecode: Uint8Array,
  jumpTargets: ReadonlySet<number>,
  dataStart: number,
): void {
  const valid = new Set<number>();
  let pc = 0;
  while (pc < dataStart) {
    const op = bytecode[pc];
    if (op === undefined) break;
    if (op === JUMPDEST_CODE) valid.add(pc);
    if (FORBIDDEN.has(op)) fail(`forbidden opcode 0x${op.toString(16)} at pc 0x${pc.toString(16)}`);
    if (op >= PUSH1_CODE && op <= PUSH32_CODE) pc += op - PUSH1_CODE + 1;
    pc += 1;
  }
  for (const target of jumpTargets) {
    if (target >= dataStart) {
      fail(
        `jump target 0x${target.toString(16)} points into the data segment (dataStart 0x${dataStart.toString(16)})`,
      );
    }
    if (!valid.has(target)) {
      fail(
        `jump target 0x${target.toString(16)} is not a JUMPDEST opcode (it is either another opcode or a byte inside a PUSH immediate)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// pass 2 — stack-height simulation
// ---------------------------------------------------------------------------

/** Max simulated depth inside a statement template (DUP/SWAP reach). Exported for the
 *  built-in peephole pass, which must respect the same budget when it deepens a window. */
export const MAX_TEMPLATE_DEPTH = 16;

function isZeroPush(node: AsmNode): boolean {
  return (node.k === 'push' && node.value === 0n) || (node.k === 'op' && node.op === 'PUSH0');
}

function labelName(
  label: LabelId,
  names: ReadonlyMap<LabelId, string>,
  labelPcs: ReadonlyMap<LabelId, number>,
): string {
  const name = names.get(label);
  const pc = labelPcs.get(label);
  const at = pc === undefined ? '' : ` (pc 0x${pc.toString(16)})`;
  return name === undefined ? `label #${label}${at}` : `@${name}${at}`;
}

/** Ops that end a region: nothing after them is reachable until the next label. */
function isTerminator(op: Mnemonic): boolean {
  return op === 'RETURN' || op === 'REVERT' || op === 'STOP' || op === 'INVALID';
}

/**
 * The simulated operand-stack height BEFORE a node: a number inside a checked region, `'any'`
 * inside an `'any'` region (whose relative counter no rule reads), `null` where the node is
 * unreachable (after a JUMP or a terminator, until the next label).
 */
export type StackHeight = number | 'any' | null;

/**
 * The stack-height walk shared by `verifyStack` and the peephole's depth budget: entry `i` is
 * the height before `nodes[i]`, and the extra last entry is the height after the stream (non-
 * `null` there means the code falls off the end). Pure and total — it never fails: underflow,
 * mismatches and budget overruns are `verifyStack`'s to report.
 *
 * Transitions: the program starts at 0 (checked); every `label` resets to its annotation (on a
 * verifier-clean stream a reachable fallthrough already carries that height); a push adds 1; an
 * op adds `pushes − pops`; JUMP and the terminators make what follows unreachable; JUMPI pops
 * its two operands and falls through. Data nodes change nothing.
 */
export function stackHeights(nodes: readonly AsmNode[]): StackHeight[] {
  // the state is kept as three plain locals (not one `StackHeight`) so the hot loop stays on
  // small-integer arithmetic; it is encoded once per node.
  let height = 0;
  let inAny = false;
  let reachable = true;
  const heights: StackHeight[] = [];
  for (const node of nodes) {
    heights.push(!reachable ? null : inAny ? 'any' : height);
    switch (node.k) {
      case 'label':
        reachable = true;
        inAny = node.stack === 'any';
        height = node.stack === 'any' ? 0 : node.stack;
        break;
      case 'dataLabel':
      case 'data':
        break;
      case 'push':
      case 'pushBytes':
      case 'pushLabel':
        height += 1;
        break;
      case 'op':
        if (node.op === 'JUMP' || isTerminator(node.op)) {
          reachable = false;
        } else {
          const info = OPS[node.op];
          height += info.pushes - info.pops; // JUMPI: −2, falls through
        }
        break;
    }
  }
  heights.push(!reachable ? null : inAny ? 'any' : height);
  return heights;
}

/**
 * Checks stack heights across the node stream (pass 2), over the `stackHeights` walk.
 *
 * Two label classes: `stack: n` (checked — every statically-known in-edge and the fallthrough
 * must agree with `n`; underflow and template depth > 16 are errors) and `stack: 'any'`
 * (relative counter from 0, may go negative; the region must terminate in
 * REVERT/RETURN/INVALID/STOP or jump only to other `'any'` labels; falling through into a
 * checked label is an error). `main` baseline is 0; fn-entry labels carry 1 in their
 * annotation. Statically-known edges are `pushLabel` nodes immediately followed by JUMP/JUMPI;
 * dynamic jumps (fn returns) are unverifiable edges and are only legal in checked regions.
 */
export function verifyStack(
  nodes: readonly AsmNode[],
  labelPcs: ReadonlyMap<LabelId, number>,
): void {
  // prepass: label annotations + names
  const annotations = new Map<LabelId, number | 'any'>();
  const dataLabels = new Set<LabelId>();
  const names = new Map<LabelId, string>();
  for (const node of nodes) {
    if (node.k === 'label') {
      if (annotations.has(node.label) || dataLabels.has(node.label)) {
        fail(`label ${labelName(node.label, names, labelPcs)} is defined twice`);
      }
      annotations.set(node.label, node.stack);
      if (node.name !== undefined) names.set(node.label, node.name);
    } else if (node.k === 'dataLabel') {
      if (annotations.has(node.label) || dataLabels.has(node.label)) {
        fail(`label ${labelName(node.label, names, labelPcs)} is defined twice`);
      }
      dataLabels.add(node.label);
      if (node.name !== undefined) names.set(node.label, node.name);
    }
  }

  const name = (l: LabelId): string => labelName(l, names, labelPcs);

  /** A statically-known edge into `target`, carrying `edgeHeight` (`'any'` from an 'any' region). */
  const checkEdge = (target: LabelId, edgeHeight: number | 'any'): void => {
    if (dataLabels.has(target)) fail(`jump targets data label ${name(target)}`);
    const ann = annotations.get(target);
    if (ann === undefined) fail(`jump targets undefined label ${name(target)}`);
    if (ann === 'any') return; // panic tails & co. accept any incoming height
    if (edgeHeight === 'any') {
      fail(
        `'any' region jumps to checked label ${name(target)} — 'any' regions must terminate or jump only to 'any' labels`,
      );
    }
    if (edgeHeight !== ann) {
      fail(
        `stack height mismatch on edge to ${name(target)}: edge carries ${edgeHeight}, label is annotated ${ann}`,
      );
    }
  };

  const heights = stackHeights(nodes);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const h = heights[i];
    if (node === undefined || h === undefined || h === null) {
      // unreachable: only a label (which `stackHeights` resets on) can make code live again
      continue;
    }
    switch (node.k) {
      case 'label': {
        // reachable fallthrough into the label
        if (node.stack === 'any') break;
        if (h === 'any') fail(`'any' region falls through into checked label ${name(node.label)}`);
        if (h !== node.stack) {
          fail(
            `stack height mismatch on fallthrough into ${name(node.label)}: fallthrough carries ${h}, label is annotated ${node.stack}`,
          );
        }
        break;
      }
      case 'dataLabel':
      case 'data': {
        fail(
          h === 'any'
            ? `'any' region falls through into the data segment — it must terminate in REVERT/RETURN/INVALID`
            : `code falls through into the data segment`,
        );
      }
      case 'push':
      case 'pushBytes':
      case 'pushLabel': {
        if (h !== 'any' && h + 1 > MAX_TEMPLATE_DEPTH) {
          fail(
            `simulated stack depth ${h + 1} exceeds the ${MAX_TEMPLATE_DEPTH}-item template budget`,
          );
        }
        break;
      }
      case 'op': {
        const info = OPS[node.op];
        if (h !== 'any' && h < info.pops) {
          fail(
            `stack underflow at ${node.op}: needs ${info.pops} item(s), simulated height is ${h}`,
          );
        }
        if (node.op === 'JUMP' || node.op === 'JUMPI') {
          // the edge carries the height left once the jump consumed its operands
          const prev = nodes[i - 1];
          if (prev?.k === 'pushLabel') {
            checkEdge(prev.label, h === 'any' ? 'any' : h - info.pops);
          } else if (h === 'any') {
            fail(
              `'any' region performs a dynamic ${node.op} — its targets cannot be proven to be 'any' labels`,
            );
          }
        } else if (!isTerminator(node.op) && h !== 'any') {
          const after = h + info.pushes - info.pops;
          if (after > MAX_TEMPLATE_DEPTH) {
            fail(
              `simulated stack depth ${after} after ${node.op} exceeds the ${MAX_TEMPLATE_DEPTH}-item template budget`,
            );
          }
        }
        break;
      }
    }
  }

  const end = heights[nodes.length];
  if (end !== null && end !== undefined) {
    fail(
      end === 'any'
        ? `'any' region falls through past the end of the code — it must terminate in REVERT/RETURN/INVALID`
        : `code falls through past the end of the node stream without a terminator`,
    );
  }
}

// ---------------------------------------------------------------------------
// pass 3 — shape lints
// ---------------------------------------------------------------------------

const FORK_RANK: Readonly<Record<EvmVersion | 'frontier', number>> = Object.freeze({
  frontier: 0,
  paris: 1,
  shanghai: 2,
  cancun: 3,
});

function isDup(node: AsmNode): boolean {
  return node.k === 'op' && isDupOp(node.op);
}

/**
 * Length of the node window `verifyShapes` (a) requires immediately before every
 * RETURNDATACOPY. Exported for the peephole pass, which must never rewrite those nodes.
 */
export const SANCTIONED_RETURNDATACOPY_WINDOW = 3;

/**
 * Shape lints:
 * (a) every RETURNDATACOPY is immediately preceded by the node window
 *     `RETURNDATASIZE, PUSH0, (PUSH0 | DUPn)` — the two intrinsically safe shapes
 *     `(0, 0, rds)` / `(base, 0, rds)`. A `push 0` node counts as PUSH0 (the assembler owns
 *     zero-push lowering, so the window stays fork-portable).
 * (b) no opcode with `since` newer than `opts.evmVersion` (catches a stray MCOPY on paris).
 *
 * Forbidden opcodes are not a node-level lint: no `Mnemonic` maps to one (pinned by `ops.test.ts`),
 * so `verifyJumpdests` checks the emitted bytes instead.
 */
export function verifyShapes(nodes: readonly AsmNode[], opts: { evmVersion: EvmVersion }): void {
  const maxRank = FORK_RANK[opts.evmVersion];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === undefined || node.k !== 'op') continue;
    const op: Mnemonic = node.op;
    const info = OPS[op];
    if (FORK_RANK[info.since] > maxRank) {
      fail(`${op} requires evmVersion >= ${info.since}, but the build targets ${opts.evmVersion}`);
    }
    if (op === 'RETURNDATACOPY') {
      const w = SANCTIONED_RETURNDATACOPY_WINDOW;
      const [a, b, c] = i >= w ? nodes.slice(i - w, i) : [];
      const ok =
        a !== undefined &&
        b !== undefined &&
        c !== undefined &&
        a.k === 'op' &&
        a.op === 'RETURNDATASIZE' &&
        isZeroPush(b) &&
        (isZeroPush(c) || isDup(c));
      if (!ok) {
        fail(
          `RETURNDATACOPY at node ${i} is not preceded by the sanctioned window ` +
            `[RETURNDATASIZE, PUSH0, (PUSH0|DUPn)] — only the (0,0,rds)/(base,0,rds) shapes are legal; ` +
            `use AsmWriter.returndatacopyAll`,
        );
      }
    }
  }
}
