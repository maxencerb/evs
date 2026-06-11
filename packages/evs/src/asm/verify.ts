/**
 * M4 `asm/verify.ts` — the three always-on verification passes (architecture §10).
 *
 * 1. `verifyJumpdests` — consensus-identical JUMPDEST scan (PUSH immediates are not jumpdests).
 * 2. `verifyStack` — stack-height simulation with `checked` and `'any'` label classes.
 * 3. `verifyShapes` — RETURNDATACOPY windows, fork gating, forbidden opcodes.
 *
 * Every failure is an `EvsInternalError` ("bug in evs, please report"): these passes guard
 * compiler output, not user input.
 */

import { EvsInternalError } from '../core/errors.js';
import type { AsmNode, LabelId } from './assembler.js';
import { FORBIDDEN, OPS, type EvmVersion, type Mnemonic } from './ops.js';

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
 * Validates every statically-known jump target against the consensus JUMPDEST rule [evm §3]:
 * a single linear scan from offset 0 in which PUSH immediates are skipped; a `0x5B`
 * encountered *as an opcode* is a valid destination, a `0x5B` inside push data is not.
 * `dataStart` is the offset of the INVALID guard byte (or `bytecode.length` when there is no
 * data segment); no jump target may point at or past it.
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

/** Max simulated depth inside a statement template (DUP/SWAP reach; architecture §5/§10). */
const MAX_TEMPLATE_DEPTH = 16;

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

/**
 * Simulates stack heights across the node stream (architecture §10 pass 2).
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

  let mode: 'checked' | 'any' = 'checked';
  let height = 0;
  let reachable = true;
  let prevPushLabel: LabelId | null = null;

  const checkEdge = (target: LabelId, edgeHeight: number): void => {
    if (dataLabels.has(target)) fail(`jump targets data label ${name(target)}`);
    const ann = annotations.get(target);
    if (ann === undefined) fail(`jump targets undefined label ${name(target)}`);
    if (ann === 'any') return; // panic tails & co. accept any incoming height
    if (mode === 'any') {
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

  for (const node of nodes) {
    switch (node.k) {
      case 'label': {
        if (reachable) {
          // fallthrough into the label
          if (node.stack === 'any') {
            mode = 'any';
            height = 0;
          } else {
            if (mode === 'any') {
              fail(`'any' region falls through into checked label ${name(node.label)}`);
            }
            if (height !== node.stack) {
              fail(
                `stack height mismatch on fallthrough into ${name(node.label)}: fallthrough carries ${height}, label is annotated ${node.stack}`,
              );
            }
            height = node.stack;
          }
        } else {
          reachable = true;
          if (node.stack === 'any') {
            mode = 'any';
            height = 0;
          } else {
            mode = 'checked';
            height = node.stack;
          }
        }
        prevPushLabel = null;
        break;
      }
      case 'dataLabel':
      case 'data': {
        if (reachable) {
          fail(
            mode === 'any'
              ? `'any' region falls through into the data segment — it must terminate in REVERT/RETURN/INVALID`
              : `code falls through into the data segment`,
          );
        }
        prevPushLabel = null;
        break;
      }
      case 'push':
      case 'pushBytes':
      case 'pushLabel': {
        if (!reachable) {
          prevPushLabel = null;
          break;
        }
        height += 1;
        if (mode === 'checked' && height > MAX_TEMPLATE_DEPTH) {
          fail(
            `simulated stack depth ${height} exceeds the ${MAX_TEMPLATE_DEPTH}-item template budget`,
          );
        }
        prevPushLabel = node.k === 'pushLabel' ? node.label : null;
        break;
      }
      case 'op': {
        if (!reachable) {
          prevPushLabel = null;
          break;
        }
        const info = OPS[node.op];
        if (mode === 'checked' && height < info.pops) {
          fail(
            `stack underflow at ${node.op}: needs ${info.pops} item(s), simulated height is ${height}`,
          );
        }
        switch (node.op) {
          case 'JUMP': {
            if (prevPushLabel !== null) {
              checkEdge(prevPushLabel, height - 1);
            } else if (mode === 'any') {
              fail(
                `'any' region performs a dynamic JUMP — its targets cannot be proven to be 'any' labels`,
              );
            }
            height -= 1;
            reachable = false;
            break;
          }
          case 'JUMPI': {
            if (prevPushLabel !== null) {
              checkEdge(prevPushLabel, height - 2);
            } else if (mode === 'any') {
              fail(
                `'any' region performs a dynamic JUMPI — its targets cannot be proven to be 'any' labels`,
              );
            }
            height -= 2;
            break;
          }
          case 'RETURN':
          case 'REVERT':
          case 'STOP':
          case 'INVALID': {
            height -= info.pops;
            reachable = false;
            break;
          }
          default: {
            height += info.pushes - info.pops;
            if (mode === 'checked' && height > MAX_TEMPLATE_DEPTH) {
              fail(
                `simulated stack depth ${height} after ${node.op} exceeds the ${MAX_TEMPLATE_DEPTH}-item template budget`,
              );
            }
            break;
          }
        }
        prevPushLabel = null;
        break;
      }
    }
  }

  if (reachable) {
    fail(
      mode === 'any'
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

const DUP_MNEMONIC_RE = /^DUP(?:[1-9]|1[0-6])$/;

function isDup(node: AsmNode): boolean {
  return node.k === 'op' && DUP_MNEMONIC_RE.test(node.op);
}

/**
 * Shape lints (architecture §7/§10):
 * (a) every RETURNDATACOPY is immediately preceded by the node window
 *     `RETURNDATASIZE, PUSH0, (PUSH0 | DUPn)` — the two intrinsically safe shapes
 *     `(0, 0, rds)` / `(base, 0, rds)`. A `push 0` node counts as PUSH0 (the assembler owns
 *     zero-push lowering, so the window stays fork-portable).
 * (b) no opcode with `since` newer than `opts.evmVersion` (catches a stray MCOPY on paris).
 * (c) no FORBIDDEN opcode byte.
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
    if (FORBIDDEN.has(info.code)) {
      fail(`forbidden opcode ${op} (0x${info.code.toString(16)}) in the node stream`);
    }
    if (op === 'RETURNDATACOPY') {
      const a = nodes[i - 3];
      const b = nodes[i - 2];
      const c = nodes[i - 1];
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
