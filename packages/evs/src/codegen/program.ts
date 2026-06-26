/**
 * M8 `codegen/program.ts` — `lowerProgram`, the single entry point `compile.ts` consumes
 * (the optimizer seam — architecture §1/§11).
 *
 * Program layout (architecture §11):
 *
 *   prologue    PUSH frameEnd PUSH1 0x40 MSTORE
 *   dispatch    cds < 4 → @badcd; selector mismatch → @badcd; else → @main
 *   @main       arg decode (§8.1) · body statement templates · return encode (§8.2) RETURN
 *   @fn_*       subroutines (§9) — uncalled fns dropped
 *   @dfail_*    per-strict-site decode-fail stubs → @decode_revert
 *   tails       @panic_* / @panic / @decode_revert / @badcd (+ @memcpy pre-cancun)
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
import { EvsInternalError, type EvsDiagnostic, type SourceLoc } from '../core/errors.js';
import { walkStmts, type FnId, type ScriptIr, type SiteId, type Stmt } from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { emitCalldataDecode, emitReturnEncode, type SlotRef } from './abi.js';
import { layoutFrames, type FrameLayout } from './frame.js';
import { emitFnSubroutines, lowerInternals, lowerStmts, type LowerCtx } from './lower.js';
import {
  emitSimulateTrampoline,
  SIMULATE_TRAMPOLINE_SELECTOR,
  SIMULATE_TRAMPOLINE_SELECTOR_NUM,
} from './simulate.js';
import { createSharedTails, emitDecodeFailStub, emitSharedTails } from './tails.js';

// ---------------------------------------------------------------------------
// frozen contract (module-interfaces §M8)
// ---------------------------------------------------------------------------

export interface LowerResult {
  nodes: readonly AsmNode[];
  frameEnd: number;
  sites: SourceMap['sites'];
  labelNames: ReadonlyMap<LabelId, string>;
  diagnostics: readonly EvsDiagnostic[]; // LOOP_ALLOCATION etc. — compile.ts forwards
}

/**
 * Frames larger than this trip the `LARGE_FRAME` warning (no pinned threshold exists in the
 * design docs; 32 KiB ≈ 1,020 slots is far beyond any reasonable read script and the point
 * where quadratic memory-expansion gas starts to register).
 */
const LARGE_FRAME_BYTES = 0x8000;

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/program: ${message}`);
}

export function lowerProgram(
  ir: ScriptIr,
  opts: { evmVersion: EvmVersion; locations: boolean },
): LowerResult {
  validateIr(ir);
  const frame = layoutFrames(ir);
  const w = new AsmWriter();
  const evm = { evmVersion: opts.evmVersion };
  const tails = createSharedTails(w, evm);

  // -- data segment manager (content-deduplicated; emitted last) ------------------------
  const segments: { label: LabelId; name: string; bytes: Uint8Array }[] = [];
  const segmentByContent = new Map<string, LabelId>();
  const dataSeg = (bytes: Uint8Array): LabelId => {
    let key = '';
    for (const b of bytes) key += b.toString(16).padStart(2, '0');
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
    fnBaseline: 0,
    dataSeg,
    siteOf: (s: Stmt): SiteId => s.site,
  };
  const state = lowerInternals(ctx);
  state.locations = opts.locations;

  // -- prologue: free-pointer init (architecture §5/§11) --------------------------------
  w.push(frame.frameEnd, { note: 'frameEnd' });
  w.push(0x40);
  w.op('MSTORE', { note: 'free-ptr init' });

  // -- simulate trampoline (issue #1): if any `s.simulate` site exists anywhere in the IR, the
  // bytecode carries a second internal entrypoint reached by a reserved selector. Detect it across
  // the body and ALL recorded fns (a simulate inside an uncalled, dropped fn just leaves the
  // trampoline unreachable — a few dozen bytes, like the always-emitted shared tails).
  let hasSimulate = false;
  const markSimulate = (s: Stmt): void => {
    if (s.k === 'call' && s.kind === 'simulate') hasSimulate = true;
  };
  walkStmts(ir.body, markSimulate);
  for (const fn of ir.fns) if (fn !== undefined) walkStmts(fn.body, markSimulate);
  const trampoline = hasSimulate ? w.newLabel('simulate_trampoline') : null;

  // -- dispatcher (§11): size floor, selector match, fallback EvsInvalidCalldata --------
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
    w.pushBytes(selectorBytes(SIMULATE_TRAMPOLINE_SELECTOR), {
      note: 'simulate trampoline selector',
    });
    w.op('EQ');
    w.pushLabel(trampoline);
    w.op('JUMPI'); // [selector]
  }
  w.pushBytes(selectorBytes(selector), { note: `selector ${ir.name}(${argTypes.join(',')})` });
  w.op('EQ');
  w.pushLabel(main);
  w.op('JUMPI');
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMP'); // fallback — named EvsInvalidCalldata()
  w.label(main, 0);

  // -- arg decode (§8.1) ------------------------------------------------------------------
  const argRefs: SlotRef[] = ir.args.map((a, i) => {
    const slot = frame.slotOfValue(i);
    if (slot === null) throw internal(`arg #${i} ("${a.name}") has no frame slot`);
    return { slot, type: a.type };
  });
  emitCalldataDecode(w, argRefs, tails, evm);

  // -- body --------------------------------------------------------------------------------
  lowerStmts(w, ir.body, ctx);

  // -- return encode (§8.2) — ends with RETURN ---------------------------------------------
  const components = ir.returns.map((r) => {
    const slot = frame.slotOfValue(r.value);
    if (slot === null) {
      throw internal(`return "${r.name}" references folded ValueId ${r.value} with no slot`);
    }
    return { name: r.name, ref: { slot, type: r.type } };
  });
  emitReturnEncode(w, components, tails, evm);

  // -- fn subroutines (only fns reached through fncall — uncalled fns dropped, §9) ---------
  emitFnSubroutines(w, ctx);

  // -- simulate trampoline entrypoint (issue #1) — a self-contained REVERT-terminated region ----
  if (trampoline !== null) emitSimulateTrampoline(w, trampoline, evm);

  // -- per-site decode-fail stubs (strict calls) + shared tails (§11/§15.0) ----------------
  for (const stub of state.dfailStubs) emitDecodeFailStub(w, stub.label, stub.site, tails);
  emitSharedTails(w, tails, evm);

  // -- data segments LAST (the assembler plants the INVALID guard) -------------------------
  for (const seg of segments) {
    w.dataLabel(seg.label, seg.name);
    w.data(seg.bytes, seg.name);
  }

  const nodes = w.nodes();
  return {
    nodes,
    frameEnd: frame.frameEnd,
    sites: collectSites(ir, state.fnQueue, opts.locations),
    labelNames: collectLabelNames(nodes),
    diagnostics: collectDiagnostics(ir, frame, state.fnQueue, opts.locations),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function selectorBytes(selector: string): Uint8Array {
  const body = selector.slice(2);
  if (!/^[0-9a-fA-F]{8}$/.test(body)) throw internal(`malformed selector ${selector}`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}

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
// sites — the SiteId table behind explainRevert / EvsDecodeError (architecture §14)
// ---------------------------------------------------------------------------

function collectSites(
  ir: ScriptIr,
  emittedFns: readonly FnId[],
  locations: boolean,
): SourceMap['sites'] {
  const sites: {
    id: SiteId;
    kind: 'panic' | 'decode' | 'call' | 'stmt';
    loc: SourceLoc | null;
    detail: string;
  }[] = [];
  const seen = new Set<SiteId>();
  const add = (s: Stmt): void => {
    if (seen.has(s.site)) return;
    seen.add(s.site);
    const [kind, detail] = classifySite(s);
    sites.push({ id: s.site, kind, loc: locations ? s.loc : null, detail });
  };
  walkStmts(ir.body, add);
  for (const f of emittedFns) {
    const fn = ir.fns[f];
    if (fn !== undefined) walkStmts(fn.body, add);
  }
  return sites;
}

function classifySite(s: Stmt): ['panic' | 'decode' | 'call' | 'stmt', string] {
  switch (s.k) {
    case 'call': {
      // explainRevert detail (issue #1): the STATICCALL (static) detail is kept verbatim; the new
      // CALL kinds prefix their verb so a simulate/call site is distinguishable in the message.
      const isStatic = s.kind === undefined || s.kind === 'static';
      const prefix = isStatic ? '' : `${s.kind} `;
      return s.mode === 'strict'
        ? ['decode', `decoding ${prefix}${s.fnAbi.name}() returndata`]
        : ['call', `try ${prefix}${s.fnAbi.name}()`];
    }
    case 'bin':
      switch (s.op) {
        case 'add':
        case 'sub':
        case 'mul':
          return ['panic', `checked ${s.op} — Panic 0x11`];
        case 'div':
        case 'mod':
          return ['panic', `checked ${s.op} — Panic 0x12/0x11`];
        default:
          return ['stmt', `bin ${s.op}`];
      }
    case 'index':
    case 'arrset':
      return ['panic', `array ${s.k === 'index' ? 'index' : 'write'} — Panic 0x32`];
    case 'arrnew':
      return ['panic', `array allocation — Panic 0x41`];
    case 'convert':
      return ['panic', 'checked conversion — Panic 0x11'];
    default:
      return ['stmt', s.k];
  }
}

// ---------------------------------------------------------------------------
// diagnostics — LOOP_ALLOCATION (§5) + LARGE_FRAME + ENV_FRAME_DEPENDENT
// ---------------------------------------------------------------------------

/** Statements that allocate memory at runtime (call-with-outputs snapshots returndata; a
 *  `tuplenew` bump-allocates its flat block). */
function stmtAllocates(s: Stmt): boolean {
  return (
    s.k === 'arrnew' ||
    s.k === 'tuplenew' ||
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
  locations: boolean,
): readonly EvsDiagnostic[] {
  const diagnostics: EvsDiagnostic[] = [];

  // fn bodies allocating transitively (the call graph is acyclic per §9; the seen-set keeps
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
          loc: locations ? s.loc : null,
        });
      }
      if (s.k === 'env') {
        const message = ENV_FRAME_MESSAGES[s.op];
        if (message !== undefined) {
          diagnostics.push({
            severity: 'warning',
            code: 'ENV_FRAME_DEPENDENT',
            message,
            loc: locations ? s.loc : null,
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
        `the static frame spans ${frame.frameEnd} bytes (${(frame.frameEnd - 0x80) / 32} slots); ` +
        `memory-expansion gas grows quadratically — consider splitting the script`,
      loc: locations ? ir.loc : null,
    });
  }
  return diagnostics;
}
