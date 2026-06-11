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
 * codegen/call.ts). Diagnostics (`LOOP_ALLOCATION`, `LARGE_FRAME`) are returned for
 * compile.ts to forward via `onDiagnostic`; nothing is logged.
 */

import { selectorOf } from '../abi/artifact.js';
import { AsmWriter, type AsmNode, type LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import type { SourceMap } from '../asm/sourcemap.js';
import { EvsInternalError, type EvsDiagnostic, type SourceLoc } from '../core/errors.js';
import { walkStmts, type FnId, type ScriptIr, type SiteId, type Stmt } from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { emitCalldataDecode, emitReturnEncode, type SlotRef } from './abi.js';
import { layoutFrames, type FrameLayout } from './frame.js';
import { emitFnSubroutines, lowerInternals, lowerStmts, type LowerCtx } from './lower.js';
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

  // -- dispatcher (§11): size floor, selector match, fallback EvsInvalidCalldata --------
  const argTypes = ir.args.map((a) => a.type);
  const selector = selectorOf(ir.name, argTypes);
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
    case 'call':
      return s.mode === 'strict'
        ? ['decode', `decoding ${s.fnAbi.name}() returndata`]
        : ['call', `tryCall ${s.fnAbi.name}()`];
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
// diagnostics — LOOP_ALLOCATION (§5) + LARGE_FRAME
// ---------------------------------------------------------------------------

function collectDiagnostics(
  ir: ScriptIr,
  frame: FrameLayout,
  emittedFns: readonly FnId[],
  locations: boolean,
): readonly EvsDiagnostic[] {
  const diagnostics: EvsDiagnostic[] = [];
  const visit = (stmts: readonly Stmt[], inLoop: boolean): void => {
    for (const s of stmts) {
      const allocates =
        s.k === 'arrnew' ||
        (s.k === 'call' && s.outs.length > 0) ||
        (s.k === 'const' && s.data.kind === 'data');
      if (inLoop && allocates) {
        const what =
          s.k === 'arrnew'
            ? `s.newArray(${s.elem}, …)`
            : s.k === 'call'
              ? `the call to ${s.fnAbi.name}() (returndata snapshot)`
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
