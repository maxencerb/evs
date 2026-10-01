/**
 * `codegen/program.ts` — `lowerProgram`, the single entry point `compile.ts` consumes
 * (the optimizer seam; `opts.optimize` picks the liveness-based frame allocator, #41).
 *
 * Program layout:
 *
 *   receive     cds == 0 → STOP (accept ETH and bare calls); else → @dispatch
 *   prologue    PUSH frameEnd PUSH1 0x40 MSTORE
 *   dispatch    cds < 4 → @badcd; selector mismatch → @badcd; else → @main
 *   @main       arg decode · body statement templates · return encode RETURN
 *   @fn_*       subroutines — uncalled fns dropped
 *   @dfail_*    per-strict-site decode-fail stubs → @decode_revert
 *   tails       @panic_* / @panic / @decode_revert / @badcd (+ @memcpy pre-cancun) — only
 *               the referenced ones, so they must stay the last code region
 *   INVALID     data segments (dataLabel-addressed blobs, content-deduplicated) — LAST
 *
 * tryCall zero blocks are emitted inline at their call sites (they rejoin the program —
 * codegen/call.ts). Diagnostics (`LOOP_ALLOCATION`, `LARGE_FRAME`, `ENV_FRAME_DEPENDENT`)
 * are returned for compile.ts to forward via `onDiagnostic`; nothing is logged.
 */

import { canonicalTypeSignature, selectorOf } from '../abi/artifact.js';
import { AsmWriter, type AsmNode, type LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import type { SourceMap } from '../asm/sourcemap.js';
import { bytesToHex, selectorBytes } from '../core/bytes.js';
import { EvsInternalError, type EvsDiagnostic } from '../core/errors.js';
import { walkStmts, type FnId, type ScriptIr, type Stmt } from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { emitCalldataDecode, emitReturnEncode, type SlotRef } from './abi.js';
import { layoutFrames, type FrameLayout } from './frame.js';
import { emitFnSubroutines, lowerInternals, lowerStmts, type LowerCtx } from './lower.js';
import { FRAME_BASE, FREE_PTR } from './memory.js';
import {
  emitSimulateTrampoline,
  SIMULATE_TRAMPOLINE_LABEL,
  SIMULATE_TRAMPOLINE_SELECTOR,
  SIMULATE_TRAMPOLINE_SELECTOR_NUM,
} from './simulate.js';
import { collectSites } from './sites.js';
import { createSharedTails, emitDecodeFailStub, emitSharedTails } from './tails.js';

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

export interface LowerResult {
  nodes: readonly AsmNode[];
  frameEnd: number;
  sites: SourceMap['sites'];
  labelNames: ReadonlyMap<LabelId, string>;
  diagnostics: readonly EvsDiagnostic[]; // LOOP_ALLOCATION etc. — compile.ts forwards
}

/**
 * Frames larger than this trip the `LARGE_FRAME` warning (the threshold is a judgment call:
 * 32 KiB ≈ 1,020 slots is far beyond any reasonable read script and the point where
 * quadratic memory-expansion gas starts to register).
 */
const LARGE_FRAME_BYTES = 0x8000;

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/program: ${message}`);
}

export function lowerProgram(
  ir: ScriptIr,
  opts: { evmVersion: EvmVersion; optimize?: boolean },
): LowerResult {
  validateIr(ir);
  // `optimize` (compile's single optimizer switch) selects the liveness-based frame allocator
  // (issue #41); the default keeps one slot per value so the default bytes never move.
  const frame = layoutFrames(ir, { optimize: opts.optimize ?? false });
  const w = new AsmWriter();
  const evm = { evmVersion: opts.evmVersion };
  const tails = createSharedTails(w, evm);

  // -- data segment manager (content-deduplicated; emitted last) ------------------------
  const segments: { label: LabelId; name: string; bytes: Uint8Array }[] = [];
  const segmentByContent = new Map<string, LabelId>();
  const dataSeg = (bytes: Uint8Array): LabelId => {
    const key = bytesToHex(bytes);
    const hit = segmentByContent.get(key);
    if (hit !== undefined) return hit;
    const name = `data_${segments.length}`;
    const label = w.newLabel(name);
    segmentByContent.set(key, label);
    segments.push({ label, name, bytes: bytes.slice() });
    return label;
  };

  const ctx: LowerCtx = {
    ir,
    frame,
    tails,
    opts: evm,
    loop: null,
    dataSeg,
  };
  const state = lowerInternals(ctx);

  // -- receive: empty calldata succeeds with no output, whatever the value ------------------
  // A script has no function a bare call could mean, but a target paying ETH back to its caller
  // (WETH.withdraw's `msg.sender.transfer`, a DEX swap to native ETH) makes exactly that call into
  // the script, and in sender mode the script replaces the sender's empty code — so rejecting it
  // breaks calls that succeed from the plain account. This region runs before the prologue and
  // costs 15 gas on the empty path, well under the 2,300 stipend of `transfer`/`send`; 1–3 bytes
  // of calldata still fall through to the size floor below and revert EvsInvalidCalldata().
  const dispatch = w.newLabel('dispatch');
  w.op('CALLDATASIZE');
  w.pushLabel(dispatch);
  w.op('JUMPI');
  w.op('STOP', { note: 'empty calldata: receive' });
  w.label(dispatch, 0);

  // -- prologue: free-pointer init --------------------------------
  w.push(frame.frameEnd, { note: 'frameEnd' });
  w.push(FREE_PTR);
  w.op('MSTORE', { note: 'free-ptr init' });

  // -- simulate trampoline (issue #1): if any `s.simulate` site exists anywhere in the IR, the
  // bytecode carries a second internal entrypoint reached by a reserved selector. Detect it across
  // the body and ALL recorded fns (a simulate inside an uncalled, dropped fn just leaves the
  // trampoline unreachable — a few dozen bytes; unlike the shared tails, which are emitted only
  // when referenced, the trampoline is not reference-tracked).
  let hasSimulate = false;
  const markSimulate = (s: Stmt): void => {
    if (s.k === 'call' && s.kind === 'simulate') hasSimulate = true;
  };
  walkStmts(ir.body, markSimulate);
  for (const fn of ir.fns) if (fn !== undefined) walkStmts(fn.body, markSimulate);
  const trampoline = hasSimulate ? w.newLabel(SIMULATE_TRAMPOLINE_LABEL) : null;

  // -- dispatcher: size floor, selector match, fallback EvsInvalidCalldata --------
  // tuple args expand to their canonical `(t1,t2,…)` signature so the dispatcher selector is
  // byte-identical to viem's over the tuple-expanded ScriptAbi inputs.
  const argTypes = ir.args.map((a) => canonicalTypeSignature(a.type));
  const selector = selectorOf(ir.name, argTypes);
  if (
    trampoline !== null &&
    Number.parseInt(selector.slice(2), 16) === SIMULATE_TRAMPOLINE_SELECTOR_NUM
  ) {
    throw internal(
      `script selector ${selector} collides with the reserved simulate trampoline selector ${SIMULATE_TRAMPOLINE_SELECTOR} — rename the script`,
    );
  }
  const main = w.newLabel('main');
  w.push(4);
  w.op('CALLDATASIZE');
  w.op('LT'); // [cds < 4]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI');
  w.push(0);
  w.op('CALLDATALOAD');
  w.push(0xe0);
  w.op('SHR'); // [selector]
  // simulate trampoline route (issue #1) — DUP1 keeps the selector for the main compare below.
  // When there is no simulate site the dispatcher is byte-identical to the pre-issue-#1 shape.
  if (trampoline !== null) {
    w.op('DUP1');
    w.pushBytes(selectorBytes(SIMULATE_TRAMPOLINE_SELECTOR, 'codegen/program'), {
      note: 'simulate trampoline selector',
    });
    w.op('EQ');
    w.pushLabel(trampoline);
    w.op('JUMPI'); // [selector]
  }
  w.pushBytes(selectorBytes(selector, 'codegen/program'), {
    note: `selector ${ir.name}(${argTypes.join(',')})`,
  });
  w.op('EQ');
  w.pushLabel(main);
  w.op('JUMPI');
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMP'); // fallback — named EvsInvalidCalldata()
  w.label(main, 0);

  // -- arg decode ------------------------------------------------------------------
  const argRefs: SlotRef[] = ir.args.map((a, i) => {
    const slot = frame.slotOfValue(i);
    if (slot === null) throw internal(`arg #${i} ("${a.name}") has no frame slot`);
    return { slot, type: a.type };
  });
  emitCalldataDecode(w, argRefs, tails);

  // -- body --------------------------------------------------------------------------------
  lowerStmts(w, ir.body, ctx);

  // -- return encode — ends with RETURN ---------------------------------------------
  const components = ir.returns.map((r) => {
    const slot = frame.slotOfValue(r.value);
    if (slot === null) {
      throw internal(`return "${r.name}" references folded ValueId ${r.value} with no slot`);
    }
    return { name: r.name, ref: { slot, type: r.type } };
  });
  emitReturnEncode(w, components, tails, evm);

  // -- fn subroutines (only fns reached through fncall — uncalled fns dropped) ---------
  emitFnSubroutines(w, ctx);

  // -- simulate trampoline entrypoint (issue #1) — a self-contained REVERT-terminated region ----
  if (trampoline !== null) emitSimulateTrampoline(w, trampoline);

  // -- per-site decode-fail stubs (strict calls) + shared tails ----------------
  // Shared tails are emitted only when referenced, so they must come after every region that
  // can `pushLabel` one (body, fn subroutines, trampoline, dfail stubs — all above).
  for (const stub of state.dfailStubs) emitDecodeFailStub(w, stub.label, stub.site, tails);
  emitSharedTails(w, tails);

  // -- data segments LAST (the assembler plants the INVALID guard) -------------------------
  for (const seg of segments) {
    w.dataLabel(seg.label, seg.name);
    w.data(seg.bytes, seg.name);
  }

  const nodes = w.nodes();
  return {
    nodes,
    frameEnd: frame.frameEnd,
    sites: collectSites(ctx, state.fnQueue),
    labelNames: collectLabelNames(nodes),
    diagnostics: collectDiagnostics(ir, frame, state.fnQueue),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function collectLabelNames(nodes: readonly AsmNode[]): ReadonlyMap<LabelId, string> {
  const names = new Map<LabelId, string>();
  for (const node of nodes) {
    if ((node.k === 'label' || node.k === 'dataLabel') && node.name !== undefined) {
      names.set(node.label, node.name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// diagnostics — LOOP_ALLOCATION + LARGE_FRAME + ENV_FRAME_DEPENDENT
// ---------------------------------------------------------------------------

/** Statements that allocate memory at runtime (call-with-outputs snapshots returndata; a
 *  `tuplenew` bump-allocates its flat block; an `encode` materializes a fresh bytes memref). */
function stmtAllocates(s: Stmt): boolean {
  return (
    s.k === 'arrnew' ||
    s.k === 'tuplenew' ||
    s.k === 'encode' ||
    (s.k === 'call' && s.outs.length > 0) ||
    (s.k === 'const' && s.data.kind === 'data')
  );
}

/**
 * `s.env('caller')` / `s.env('address')` lower to bare CALLER/ADDRESS — sound, but the value
 * is execution-frame-dependent and the two `toViem()` modes run the script in different
 * frames: in the DEFAULT deployless mode `caller` is viem's internal wrapper contract and
 * `address` is a per-script counterfactual CREATE2 address (neither controllable), while in
 * stateOverride mode `caller` is the `account` call parameter and `address` is the chosen
 * override address. timestamp/blocknumber/chainid are block context — identical across modes —
 * so the warning is scoped to caller+address.
 */
const ENV_FRAME_MESSAGES: Partial<Record<string, string>> = {
  caller:
    `s.env('caller') is execution-frame-dependent: in the default deployless toViem() mode ` +
    `msg.sender is viem's internal wrapper contract — NOT the eth_call \`account\`; ` +
    `caller-relative reads require toViem({ mode: 'stateOverride' }) plus the \`account\` ` +
    `call parameter`,
  address:
    `s.env('address') is execution-frame-dependent: in the default deployless toViem() mode ` +
    `address(this) is a per-script counterfactual CREATE2 address; use ` +
    `toViem({ mode: 'stateOverride' }) for a stable, controllable script address`,
};

function collectDiagnostics(
  ir: ScriptIr,
  frame: FrameLayout,
  emittedFns: readonly FnId[],
): readonly EvsDiagnostic[] {
  const diagnostics: EvsDiagnostic[] = [];

  // fn bodies allocating transitively (the call graph is acyclic; the seen-set keeps
  // the walk finite even on malformed input).
  const fnAllocMemo = new Map<FnId, boolean>();
  const fnAllocates = (f: FnId, seen: ReadonlySet<FnId>): boolean => {
    const memo = fnAllocMemo.get(f);
    if (memo !== undefined) return memo;
    if (seen.has(f)) return false;
    const fn = ir.fns[f];
    let result = false;
    if (fn !== undefined) {
      const nested = new Set(seen).add(f);
      walkStmts(fn.body, (s) => {
        if (stmtAllocates(s) || (s.k === 'fncall' && fnAllocates(s.fn, nested))) result = true;
      });
    }
    fnAllocMemo.set(f, result);
    return result;
  };

  const visit = (stmts: readonly Stmt[], inLoop: boolean): void => {
    for (const s of stmts) {
      // a fncall whose callee transitively allocates is itself a per-iteration allocation
      const callsAllocatingFn = s.k === 'fncall' && fnAllocates(s.fn, new Set());
      if (inLoop && (stmtAllocates(s) || callsAllocatingFn)) {
        const what =
          s.k === 'arrnew'
            ? `s.newArray(${typeof s.elem === 'string' ? s.elem : JSON.stringify(s.elem)}, …)`
            : s.k === 'tuplenew'
              ? 's.tuple(…) (flat-block allocation)'
              : s.k === 'encode'
                ? `s.${s.mode === 'abi' ? 'encode' : 'encodePacked'}(…) (fresh bytes memref)`
                : s.k === 'call'
                  ? `the call to ${s.fnAbi.name}() (returndata snapshot)`
                  : s.k === 'fncall'
                    ? `the call to fn "${ir.fns[s.fn]?.name ?? s.fn}" (its body allocates)`
                    : 'a dynamic literal materialization';
        diagnostics.push({
          severity: 'warning',
          code: 'LOOP_ALLOCATION',
          message:
            `${what} allocates memory on every loop iteration; evs never resets the free ` +
            `pointer, so memory grows monotonically for the lifetime of the call`,
        });
      }
      if (s.k === 'env') {
        const message = ENV_FRAME_MESSAGES[s.op];
        if (message !== undefined) {
          diagnostics.push({
            severity: 'warning',
            code: 'ENV_FRAME_DEPENDENT',
            message,
          });
        }
      }
      if (s.k === 'if') {
        visit(s.then, inLoop);
        visit(s.else, inLoop);
      } else if (s.k === 'while') {
        visit(s.header, true);
        visit(s.body, true);
      }
    }
  };
  visit(ir.body, false);
  for (const f of emittedFns) {
    const fn = ir.fns[f];
    if (fn !== undefined) visit(fn.body, false);
  }
  if (frame.frameEnd > LARGE_FRAME_BYTES) {
    diagnostics.push({
      severity: 'warning',
      code: 'LARGE_FRAME',
      message:
        `the static frame spans ${frame.frameEnd} bytes (${(frame.frameEnd - FRAME_BASE) / 32} slots); ` +
        `memory-expansion gas grows quadratically — consider splitting the script`,
    });
  }
  return diagnostics;
}
