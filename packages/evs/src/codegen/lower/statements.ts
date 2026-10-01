/**
 * `codegen/lower/statements.ts` — the statement dispatch (`lowerStmts` / `lowerStmt`), the `s.fn`
 * subroutine bodies, the `call` / `fncall` templates, and the control-flow shapes (`if` /
 * `while`, which recurse into the dispatch).
 */

import type { AsmWriter } from '../../asm/assembler.js';
import type { Stmt, ValueId } from '../../ir/nodes.js';
import { type CallSitePlan, emitSimulateCall, emitStaticCall } from '../call.js';
import { fnReturnAddressSlot } from '../frame.js';
import { lowerBin, lowerModArith } from './arith.js';
import {
  lowerSelect,
  lowerIndex,
  lowerSlice,
  lowerArrnew,
  lowerArrset,
  lowerTupleNew,
  lowerEncode,
  lowerKeccak256,
  lowerThrow,
  lowerField,
  lowerTupleSet,
} from './composites.js';
import {
  type LowerCtx,
  lowerInternals,
  internal,
  loadOperand,
  meta,
  storeOut,
  requireSlot,
  typeOf,
  STMT_BASELINE,
} from './context.js';
import { lowerConst, lowerUn, lowerEnv, lowerConvert } from './values.js';

export function lowerStmts(w: AsmWriter, stmts: readonly Stmt[], ctx: LowerCtx): void {
  for (const s of stmts) lowerStmt(w, s, ctx);
}

/**
 * @internal Emits the subroutine bodies of every fn discovered through `fncall` statements
 * (JUMPDEST subroutine, entry at stack height 1, return address spilled to
 * the fn's frame slot, results copied to the fn's static result region, dynamic return
 * JUMP). Lowering a body may discover further fns; the worklist drains them all. Uncalled
 * fns are never emitted.
 */
export function emitFnSubroutines(w: AsmWriter, ctx: LowerCtx): void {
  const state = lowerInternals(ctx);
  for (let i = 0; i < state.fnQueue.length; i++) {
    const f = state.fnQueue[i];
    if (f === undefined) continue;
    const fn = ctx.ir.fns[f];
    const entry = state.fnEntries.get(f);
    if (fn === undefined || entry === undefined) {
      throw internal(`emitFnSubroutines: fns[${f}] missing from the IR or the entry map`);
    }
    const region = ctx.frame.fnRegion(f);
    const retSlot = fnReturnAddressSlot(ctx.frame, f);
    w.label(entry, 1, `fn_${fn.name}`); // [ret]
    w.push(retSlot, { note: `spill return address (${fn.name})` });
    w.op('MSTORE'); // []
    const savedLoop = ctx.loop;
    ctx.loop = null;
    lowerStmts(w, fn.body, ctx);
    ctx.loop = savedLoop;
    fn.resultValues.forEach((rv, j) => {
      const slot = region.results[j];
      if (slot === undefined) throw internal(`fns[${f}] result region is missing slot #${j}`);
      loadOperand(w, ctx, rv);
      w.push(slot, { note: `result #${j} (${fn.name})` });
      w.op('MSTORE');
    });
    w.push(retSlot);
    w.op('MLOAD');
    w.op('JUMP', { note: `return (${fn.name})` }); // dynamic return jump (checked region)
  }
}

// ---------------------------------------------------------------------------
// statement dispatch
// ---------------------------------------------------------------------------

function lowerStmt(w: AsmWriter, s: Stmt, ctx: LowerCtx): void {
  switch (s.k) {
    case 'const':
      lowerConst(w, s, ctx);
      return;
    case 'bin':
      lowerBin(w, s, ctx);
      return;
    case 'un':
      lowerUn(w, s, ctx);
      return;
    case 'modarith':
      lowerModArith(w, s, ctx);
      return;
    case 'env':
      lowerEnv(w, s, ctx);
      return;
    case 'convert':
      lowerConvert(w, s, ctx);
      return;
    case 'select':
      lowerSelect(w, s, ctx);
      return;
    case 'index':
      lowerIndex(w, s, ctx);
      return;
    case 'len':
      loadOperand(w, ctx, s.a, meta('len')); // [ptr]
      w.op('MLOAD'); // [len]
      storeOut(w, ctx, s.out);
      return;
    case 'slice':
      lowerSlice(w, s, ctx);
      return;
    case 'arrnew':
      lowerArrnew(w, s, ctx);
      return;
    case 'arrset':
      lowerArrset(w, s, ctx);
      return;
    case 'tuplenew':
      lowerTupleNew(w, s, ctx);
      return;
    case 'encode':
      lowerEncode(w, s, ctx);
      return;
    case 'keccak256':
      lowerKeccak256(w, s, ctx);
      return;
    case 'throw':
      lowerThrow(w, s, ctx);
      return;
    case 'field':
      lowerField(w, s, ctx);
      return;
    case 'tupleset':
      lowerTupleSet(w, s, ctx);
      return;
    case 'cellnew':
    case 'cellset':
      loadOperand(w, ctx, s.k === 'cellnew' ? s.init : s.value, meta(`cell ${s.cell} ←`));
      w.push(ctx.frame.slotOfCell(s.cell));
      w.op('MSTORE');
      return;
    case 'cellget':
      w.push(ctx.frame.slotOfCell(s.cell), meta(`cell ${s.cell} →`));
      w.op('MLOAD');
      storeOut(w, ctx, s.out);
      return;
    case 'call':
      lowerCall(w, s, ctx);
      return;
    case 'fncall':
      lowerFncall(w, s, ctx);
      return;
    case 'if':
      lowerIf(w, s, ctx);
      return;
    case 'while':
      lowerWhile(w, s, ctx);
      return;
    case 'break':
    case 'continue': {
      if (ctx.loop === null) throw internal(`'${s.k}' outside a loop survived validateIr`);
      w.pushLabel(s.k === 'break' ? ctx.loop.breakTo : ctx.loop.continueTo, meta(s.k));
      w.op('JUMP');
      return;
    }
    default: {
      const kind = String((s as { k: unknown }).k);
      throw internal(`unknown statement kind '${kind}' survived validateIr`);
    }
  }
}

// ---------------------------------------------------------------------------
// call / fncall
// ---------------------------------------------------------------------------

function lowerCall(w: AsmWriter, s: Extract<Stmt, { k: 'call' }>, ctx: LowerCtx): void {
  const state = lowerInternals(ctx);
  const tryMode = s.mode === 'try';
  const site = s.site;
  const dfailLabel = w.newLabel(tryMode ? `zero_${site}` : `dfail_${site}`);
  if (!tryMode) state.dfailStubs.push({ label: dfailLabel, site });

  const refOf = (v: ValueId): CallSitePlan['argRefs'][number] => {
    const data = state.consts.get(v);
    if (data !== undefined && ctx.frame.slotOfValue(v) === null) return { literal: data };
    // dynamic literals carry a slot (materialized memref) but still fold into the
    // CalldataTemplate's const segments — const-merging
    if (data !== undefined && data.kind === 'data') return { literal: data };
    return { slot: requireSlot(ctx, v, `call arg/target (site ${site})`), type: typeOf(ctx, v) };
  };

  let successRef: CallSitePlan['successRef'] = null;
  if (tryMode) {
    if (s.successOut === undefined) {
      throw internal(`try call (site ${site}) without successOut survived validateIr`);
    }
    successRef = { slot: requireSlot(ctx, s.successOut, 'successOut'), type: 'bool' };
  }

  const plan: CallSitePlan = {
    stmt: s,
    targetRef: refOf(s.target),
    ...(s.gas === undefined ? {} : { gasRef: refOf(s.gas) }),
    argRefs: s.args.map(refOf),
    outRefs: s.outs.map((o) => ({
      slot: requireSlot(ctx, o, `call out (site ${site})`),
      type: typeOf(ctx, o),
    })),
    successRef,
    dfailLabel,
    siteId: site,
  };
  // issue #1: kind 'static' (STATICCALL) / 'call' (CALL) share emitStaticCall; 'simulate' is the
  // self-call trampoline + rollback macro.
  if (s.kind === 'simulate') {
    emitSimulateCall(w, plan, ctx.tails, ctx.opts, ctx.dataSeg);
  } else {
    emitStaticCall(w, plan, ctx.tails, ctx.opts, ctx.dataSeg);
  }
}

function lowerFncall(w: AsmWriter, s: Extract<Stmt, { k: 'fncall' }>, ctx: LowerCtx): void {
  const state = lowerInternals(ctx);
  const fn = ctx.ir.fns[s.fn];
  if (fn === undefined) throw internal(`fncall to unknown FnId ${s.fn} survived validateIr`);
  let entry = state.fnEntries.get(s.fn);
  if (entry === undefined) {
    entry = w.newLabel(`fn_${fn.name}`);
    state.fnEntries.set(s.fn, entry);
    state.fnQueue.push(s.fn);
  }
  const region = ctx.frame.fnRegion(s.fn);

  // args → callee param slots
  s.args.forEach((a, i) => {
    const slot = region.params[i];
    if (slot === undefined) throw internal(`fns[${s.fn}] param region is missing slot #${i}`);
    loadOperand(w, ctx, a, i === 0 ? meta(`fncall ${fn.name}`) : undefined);
    w.push(slot);
    w.op('MSTORE');
  });

  const ret = w.newLabel(`ret_${s.site}`);
  w.pushLabel(ret, s.args.length === 0 ? meta(`fncall ${fn.name}`) : undefined); // [ret]
  w.pushLabel(entry);
  w.op('JUMP'); // → callee (entry label carries stack 1)
  w.label(ret, STMT_BASELINE);

  // result region → per-callsite out slots (two calls never alias)
  s.outs.forEach((o, j) => {
    const src = region.results[j];
    if (src === undefined) throw internal(`fns[${s.fn}] result region is missing slot #${j}`);
    w.push(src);
    w.op('MLOAD');
    storeOut(w, ctx, o);
  });
}

// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

function lowerIf(w: AsmWriter, s: Extract<Stmt, { k: 'if' }>, ctx: LowerCtx): void {
  const base = STMT_BASELINE;
  const hasElse = s.else.length > 0;
  const elseL = hasElse ? w.newLabel(`else_${s.site}`) : null;
  const endL = w.newLabel(`endif_${s.site}`);
  loadOperand(w, ctx, s.cond, meta('if')); // [cond]
  w.op('ISZERO');
  w.pushLabel(elseL ?? endL);
  w.op('JUMPI'); // []
  lowerStmts(w, s.then, ctx);
  if (elseL !== null) {
    w.pushLabel(endL);
    w.op('JUMP');
    w.label(elseL, base);
    lowerStmts(w, s.else, ctx);
  }
  w.label(endL, base);
}

function lowerWhile(w: AsmWriter, s: Extract<Stmt, { k: 'while' }>, ctx: LowerCtx): void {
  const base = STMT_BASELINE;
  const head = w.newLabel(`while_${s.site}`);
  const end = w.newLabel(`endwhile_${s.site}`);
  w.label(head, base); // re-executed every iteration
  lowerStmts(w, s.header, ctx);
  loadOperand(w, ctx, s.cond, meta('while cond')); // [cond]
  w.op('ISZERO');
  w.pushLabel(end);
  w.op('JUMPI'); // []
  const saved = ctx.loop;
  ctx.loop = { breakTo: end, continueTo: head };
  lowerStmts(w, s.body, ctx);
  ctx.loop = saved;
  w.pushLabel(head);
  w.op('JUMP');
  w.label(end, base);
}
