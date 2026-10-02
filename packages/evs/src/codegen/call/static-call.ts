/**
 * `codegen/call/static-call.ts` — `emitStaticCall`: the STATICCALL (`s.read`) / CALL (`s.call`,
 * value 0 unless the site sends one) site, with in-place per-output decode of the returndata
 * snapshot.
 */

import { headBytes, layoutOfType, type TypeLayout } from '../../abi/layout.js';
import type { AsmWriter, LabelId } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { abiParamToType, type EvsType, type NamedType } from '../../core/types.js';
import { callOutputs } from '../../ir/nodes.js';
import {
  type SharedTails,
  headOffsets,
  headOffsetAt,
  usesRecursiveCodec,
  emitNormalizeWord,
  isRecursiveArray,
  wordNeedsNormalize,
  emitCopyNormalizeWordArray,
  needsDecodeBudget,
  emitInitDecodeBudget,
  effectiveDecodeBudget,
  type CodecHook,
  type DecodeFail,
  type DecodeOptions,
  type DecodeRegion,
  emitDecodeFromRegion,
  emitAboveU64,
} from '../abi.js';
import { codecKey, type CodecUnit } from '../codec-keys.js';
import { FREE_PTR, TAIL_CURSOR } from '../memory.js';
import { emitCalldataFor } from './calldata.js';
import {
  type CallSitePlan,
  internal,
  assertSitePlan,
  makeDecodeFail,
  pushWordRef,
  pushGasRef,
  pushValueRef,
  emitSnapshotReturndata,
  callSiteAllocates,
  pushSnapEnd,
  pushSnap,
  emitTryEpilogue,
} from './shared.js';

// ---------------------------------------------------------------------------
// emitStaticCall
// ---------------------------------------------------------------------------

export function emitStaticCall(
  w: AsmWriter,
  plan: CallSitePlan,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  dataSeg: (bytes: Uint8Array) => LabelId, // request a data segment, get its dataLabel
): void {
  const { stmt, siteId } = plan;
  const { fnAbi } = stmt;
  // the decode schema: `revertReturns` (decoded from the REVERT payload) or the ABI outputs
  const outputs = callOutputs(stmt);
  const tryMode = stmt.mode === 'try';

  if (stmt.revertReturns !== undefined && stmt.kind !== 'call') {
    throw internal(
      `call to ${fnAbi.name} (site ${siteId}): revertReturns on kind '${stmt.kind ?? 'static'}' survived validateIr`,
    );
  }
  assertSitePlan(plan, outputs, `call to ${fnAbi.name}`);

  // tuple outputs AND recursive-codec array outputs (`tuple[]`/`T[][]`/`string[]`, any `T[N]`)
  // decode from the memory snapshot (SNAP_SLOT) via the recursive decoders — they need the
  // scratch-resident base/end (the decoders churn the free ptr, so a stack-resident base would
  // drift).
  const hasTupleOut = outputs.some((p) => usesRecursiveCodec(layoutOfType(abiParamToType(p))));
  // outputs whose decode can exhaust the decode-work budget (arrays nested in arrays, several
  // charged arrays — always memory-snapshot shapes) get a budget word right after the snapshot
  const budgeted = needsDecodeBudget(outputs);
  if (budgeted && !hasTupleOut) {
    throw internal(`call to ${fnAbi.name} (site ${siteId}): a budgeted decode without a snapshot`);
  }
  // try mode over such outputs: a decode failure after the snapshot rolls the free pointer back
  // to the snapshot base on its way to the zero block (see emitTryEpilogue). Failures before the
  // snapshot (the head-size guard) go straight to the zero block.
  const restore = tryMode && hasTupleOut ? w.newLabel(`call_restore_${siteId}`) : null;
  const failPre = makeDecodeFail(w, plan, tryMode, 'call');
  const fail = restore === null ? failPre : makeDecodeFail(w, plan, tryMode, 'call', restore);

  // -- 1. calldata template into transient scratch (free pointer NOT bumped) -------------
  const template = emitCalldataFor(w, plan, tails, opts, dataSeg);
  // -- 2. the subcall and its failure arm ------------------------------------------------------
  emitSubcall(
    w,
    plan,
    template !== null && template.regime === 'static' ? template.staticSize : null,
  ); // [success, buf]
  emitCallOutcome(w, plan); // [buf]

  // -- 3. decode (guard BEFORE any head read; snapshot; normalize/validate). Under revertReturns
  //       the returndata IS the revert payload — the sequence is byte-identical. ----------------
  if (outputs.length > 0) {
    emitDecodeOutputs(w, plan, outputs, {
      hasTupleOut,
      budgeted,
      failPre,
      fail,
      evmVersion: opts.evmVersion,
      codecs: tails.codecs,
    }); // [buf]
  }
  w.op('POP'); // []

  // -- 4. try mode: success flag, zero block (checked — rejoins), join --------------------
  if (tryMode) emitTryEpilogue(w, plan, 'call', restore);
}

/**
 * The subcall itself, `[] → [success, buf]` (issue #1): STATICCALL for `kind: 'static'`
 * (`s.read`), CALL for `kind: 'call'` (`s.call` — a non-static frame for non-view targets).
 * `kind: 'simulate'` never reaches here (lowerCall routes it to emitSimulateCall). Operand order:
 *
 *   STATICCALL(gas, addr, buf, argsSize, 0, 0)
 *   CALL      (gas, addr, value, buf, argsSize, 0, 0)   (value: the site's `value`, else 0)
 *
 * — identical save the extra `value` word, so only one push and the opcode differ. `staticSize`
 * is the calldata size when the template knew it at compile time; otherwise the tail cursor
 * holds the payload end (`argsSize = tailEnd − buf`).
 */
function emitSubcall(w: AsmWriter, plan: CallSitePlan, staticSize: number | null): void {
  const { stmt, siteId } = plan;
  const { fnAbi } = stmt;
  const useCall = stmt.kind === 'call';
  w.push(FREE_PTR);
  w.op('MLOAD'); // [buf]
  w.push(0); // [retSize, buf]
  w.push(0); // [retOff, retSize, buf]
  if (staticSize !== null) {
    w.push(staticSize); // [argsSize, …]
  } else {
    w.op('DUP3'); // [buf, retOff, retSize, buf]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tailEnd, buf, retOff, retSize, buf]
    w.op('SUB'); // [argsSize, retOff, retSize, buf]
  }
  w.op('DUP4'); // [argsOff = buf, argsSize, retOff, retSize, buf]
  if (useCall) pushValueRef(w, plan.valueRef, `value of ${fnAbi.name}`); // [value, argsOff, …]
  pushWordRef(w, plan.targetRef, `target of ${fnAbi.name}`, 'target');
  pushGasRef(w, plan.gasRef, `gas of ${fnAbi.name}`);
  const revertMode = stmt.revertReturns !== undefined;
  w.op(useCall ? 'CALL' : 'STATICCALL', {
    note: `${stmt.mode} ${useCall ? 'call' : 'read'} ${fnAbi.name}${revertMode ? ' [revertReturns]' : ''} (site ${siteId})`,
  }); // [success, buf]
}

/**
 * Branches on the subcall's success flag, `[success, buf] → [buf]` on the value path. A failure
 * bubbles the callee revert verbatim (strict) or jumps to the zero block (try). Under
 * `revertReturns` (issue #35) the branch is INVERTED: a REVERT is the value path (its payload is
 * decoded exactly like returndata), and a normal RETURN is the failure — nothing to bubble, so
 * strict lands on the site's `EvsDecodeError(site)` stub and try on the zero block.
 */
function emitCallOutcome(w: AsmWriter, plan: CallSitePlan): void {
  const { stmt, siteId } = plan;
  const revertMode = stmt.revertReturns !== undefined;
  const ok = w.newLabel(`call_ok_${siteId}`);
  if (revertMode) w.op('ISZERO', { note: 'revertReturns: a revert is the value path' });
  w.pushLabel(ok);
  w.op('JUMPI'); // [buf]
  if (revertMode) {
    // the dfail label is an 'any'-height stub (strict) or the height-0 zero block (try): POP
    // first so both entries are clean
    w.op('POP');
    w.pushLabel(plan.dfailLabel);
    w.op('JUMP', { note: 'revertReturns: normal return is the failure' });
  } else if (stmt.mode === 'try') {
    w.op('POP');
    w.pushLabel(plan.dfailLabel);
    w.op('JUMP'); // → zero block
  } else {
    // bubble the callee revert verbatim (RETURNDATACOPY shape 1)
    w.returndatacopyAll('zero'); // [buf]
    w.op('RETURNDATASIZE');
    w.push(0);
    w.op('REVERT', { note: 'bubble callee revert' }); // revert(0, rds)
  }
  w.label(ok, 1); // [buf]
}

/**
 * Decodes a call's outputs from its returndata, `[buf] → [buf]`, each into its out slot: the
 * head-size guard (`rds ≥ headBytes(outputs)`, before any head read), the snapshot at `buf`,
 * then per output a normalized word, a recursive-codec value through
 * {@link emitDecodeFromRegion}, or a leaf `string` / `bytes` / word array
 * ({@link emitLeafDynOutput}). `failPre` routes the guard's failure (before the snapshot), `fail`
 * every later one.
 */
function emitDecodeOutputs(
  w: AsmWriter,
  plan: CallSitePlan,
  outputs: readonly NamedType[],
  ctx: {
    readonly hasTupleOut: boolean;
    readonly budgeted: boolean;
    readonly failPre: DecodeFail;
    readonly fail: DecodeFail;
    readonly evmVersion: EvmVersion;
    readonly codecs: CodecHook | null;
  },
): void {
  const { stmt, siteId } = plan;
  const { fnAbi } = stmt;
  const { hasTupleOut, budgeted, fail } = ctx;
  const budget: 'off' | 'once' = budgeted ? 'once' : 'off';
  const outOffsets = headOffsets(outputs); // cumulative (static tuple outputs inline)
  const minSize = headBytes(outputs);

  // staticMinSize guard: rds ≥ headBytes(outputs)
  w.op('RETURNDATASIZE');
  w.push(minSize, { note: `staticMinSize ${minSize}` });
  w.op('GT'); // [minSize > rds, buf]
  ctx.failPre(1); // [buf]

  // snapshot ENTIRE returndata at buf; tuple/composite outputs additionally need the base in
  // SNAP_SLOT (they decode through scratch — see emitSnapshotReturndata). Word-only outputs
  // are copied into their slots right below, so their snapshot stays transient: the free
  // pointer is not bumped and a loop of such reads does not grow memory. A budgeted decode
  // keeps its budget word past the snapshot, so it always bumps.
  emitSnapshotReturndata(w, hasTupleOut, {
    bump: budgeted || callSiteAllocates(stmt),
    reserveBudgetWord: budgeted,
  }); // [buf]
  if (budgeted) emitInitDecodeBudget(w, () => pushSnapEnd(w), 0); // [buf]

  outputs.forEach((out, j) => {
    const ref = plan.outRefs[j];
    if (ref === undefined) throw internal(`missing out ref #${j}`);
    const type = abiParamToType(out);
    const layout = layoutOfType(type);
    const headOffset = headOffsetAt(outOffsets, j);

    if (layout.kind === 'word') {
      w.op('DUP1');
      if (headOffset !== 0) {
        w.push(headOffset);
        w.op('ADD');
      }
      w.op('MLOAD'); // [raw, buf]
      emitNormalizeWord(w, layout.abi); // normalize-don't-revert
      w.push(ref.slot);
      w.op('MSTORE', { note: `out #${j} ${out.type}` }); // [buf]
      return;
    }

    if (usesRecursiveCodec(layout)) {
      // decode from the snapshot into a fresh flat / `[len][p0…]` pointer block (dynamic members
      // alias the snapshot); base/end are read from scratch so the decoder's free-ptr churn never
      // disturbs them. The program may share this decoder (`codegen/codecs.ts`): the call then
      // routes a failure through this site's own `fail`. A per-site setting added to this
      // decode must also join its unit (`retOutputUnit`).
      const key = codecKey(retOutputUnit(layout, headOffset, budget));
      const what = `output #${j} (${out.type}) of ${fnAbi.name} (site ${siteId})`;
      if (ctx.codecs?.decode(w, key, fail, `decode ${what}`) !== true) {
        emitDecodeReturnOutput(
          w,
          type,
          headOffset,
          fail,
          { budget, evmVersion: ctx.evmVersion },
          () => what,
        );
      } // [block, buf]
      w.push(ref.slot);
      w.op('MSTORE', {
        note: `out #${j} ${layout.kind === 'tuple' ? 'tuple (flat block)' : `${out.type} (pointer block)`}`,
      }); // [buf]
      return;
    }

    const copied = emitLeafDynOutput(w, layout, headOffset, fail); // [ptr, buf]
    w.push(ref.slot);
    w.op('MSTORE', {
      note: `out #${j} ${out.type} (${copied ? 'normalized copy' : 'memref aliases snapshot'})`,
    }); // [buf]
  });
}

/**
 * @internal The codec unit of one recursive-codec output of `layout` at `headOffset` in a call's
 * returndata, at a site decoding under `siteBudget`: what keys its shared decoder, for this
 * emitter and for the planner's census (`codegen/codecs.ts`) alike.
 */
export function retOutputUnit(
  layout: TypeLayout,
  headOffset: number,
  siteBudget: 'off' | 'once',
): Extract<CodecUnit, { region: 'ret' }> {
  const budget = effectiveDecodeBudget(layout, siteBudget) === 'off' ? 'off' : 'once';
  return { dir: 'dec', region: 'ret', layout, headOffset, budget };
}

/**
 * @internal Shared with `codegen/codecs.ts` (a shared decoder body is this unit). Decodes one
 * recursive-codec output of `type` at `headOffset` in a call's returndata snapshot (the
 * `[buf, buf+rds)` region, `buf` live beneath), `[buf] → [block, buf]`, through
 * `emitDecodeFromRegion`; `cacheBlockBase` is the register a shared body caches a dynamic
 * output's block base in.
 */
export function emitDecodeReturnOutput(
  w: AsmWriter,
  type: EvsType,
  headOffset: number,
  fail: DecodeFail,
  opts: DecodeOptions,
  what: () => string,
  cacheBlockBase?: number,
): void {
  const region: DecodeRegion = {
    pushBase: () => pushSnap(w),
    pushEnd: () => pushSnapEnd(w),
    fail,
    live: 1,
    arrayOffsetBound: 'returndata',
    ...(cacheBlockBase === undefined ? {} : { cacheBlockBase }),
  };
  emitDecodeFromRegion(w, type, headOffset, region, opts, what);
}

/**
 * The leaf-dynamic fast path for a `string` / `bytes` / dynamic word-array output, `[buf] →
 * [ptr, buf]`: reads its offset straight off the snapshot on the stack (`off ≤ 2^64−1`,
 * `off + 32 ≤ rds`, `len ≤ 2^64−1`, `ptr + 32 + nbytes ≤ buf + rds`) and aliases the snapshot —
 * or, for narrow elements, a normalized copy (returns true then).
 */
function emitLeafDynOutput(
  w: AsmWriter,
  layout: TypeLayout,
  headOffset: number,
  fail: DecodeFail,
): boolean {
  const isArray = layout.kind === 'array';
  // off := snapshot[headOffset]; off ≤ 2^64−1; off + 32 ≤ rds
  w.op('DUP1');
  if (headOffset !== 0) {
    w.push(headOffset);
    w.op('ADD');
  }
  w.op('MLOAD'); // [off, buf]
  w.op('DUP1');
  emitAboveU64(w); // [off >> 64, off, buf]
  fail(2); // [off, buf]
  w.op('DUP1');
  w.push(32);
  w.op('ADD'); // [off+32, off, buf]
  w.op('RETURNDATASIZE');
  w.op('LT'); // [rds < off+32, off, buf]
  fail(2); // [off, buf]

  // ptr := buf + off; len checks: len ≤ 2^64−1, off + 32 + nbytes ≤ rds
  w.op('DUP2');
  w.op('ADD'); // [ptr, buf]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr, buf]
  w.op('DUP1');
  emitAboveU64(w); // [len >> 64, len, ptr, buf]
  fail(3); // [len, ptr, buf]
  if (isArray) {
    w.push(5);
    w.op('SHL'); // [nbytes = 32·len, ptr, buf]
  }
  w.op('DUP2');
  w.push(32);
  w.op('ADD');
  w.op('ADD'); // [end = ptr + 32 + nbytes, ptr, buf]
  w.op('RETURNDATASIZE');
  w.op('DUP4');
  w.op('ADD'); // [buf+rds, end, ptr, buf]
  w.op('LT'); // [buf+rds < end, ptr, buf]
  fail(2); // [ptr, buf]

  if (layout.kind !== 'array') return false;
  // dynamic word-element array (every other array is a recursive-codec value): full-word elements
  // alias the snapshot; narrow ones are normalized into a copy.
  if (layout.elem.kind !== 'word' || isRecursiveArray(layout)) {
    throw internal('recursive-codec array reached the word-array decode path');
  }
  const elemAbi = layout.elem.abi;
  if (!wordNeedsNormalize(elemAbi)) return false;
  // narrow elements: normalize into a fresh copy, never in place — another output may alias the
  // same snapshot bytes (overlapping offsets in non-canonical returndata)
  emitCopyNormalizeWordArray(w, elemAbi, 1); // [copy, buf]
  return true;
}
