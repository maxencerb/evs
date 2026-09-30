/**
 * `codegen/call/static-call.ts` — `emitStaticCall`: the STATICCALL (`s.read`) / CALL with value 0
 * (`s.call`) site, with in-place per-output decode of the returndata snapshot.
 */

import { headBytes, layoutOfType, isDynamic } from '../../abi/layout.js';
import type { AsmWriter, LabelId } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { typesEqual, abiParamToType, isTupleType } from '../../core/types.js';
import { callOutputs } from '../../ir/nodes.js';
import {
  type SharedTails,
  fmtType,
  headOffsets,
  needsMemorySnapshot,
  emitNormalizeWord,
  type PushBase,
  emitDecodeTupleToMem,
  isRecursiveArray,
  emitDecodeArrayToMem,
  wordNeedsNormalize,
  emitNormalizeElemsLoop,
} from '../abi.js';
import { FREE_PTR, MAX_U64 } from '../memory.js';
import { emitCalldataFor } from './calldata.js';
import {
  type CallSitePlan,
  internal,
  makeDecodeFail,
  TAIL_CURSOR,
  pushWordRef,
  pushGasRef,
  emitSnapshotReturndata,
  pushSnapEnd,
  pushSnap,
  pushSnapOffsetBase,
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
  const revertMode = stmt.revertReturns !== undefined;

  if (revertMode && stmt.kind !== 'call') {
    throw internal(
      `call to ${fnAbi.name} (site ${siteId}): revertReturns on kind '${stmt.kind ?? 'static'}' survived validateIr`,
    );
  }
  if (outputs.length !== plan.outRefs.length) {
    throw internal(
      `call to ${fnAbi.name} (site ${siteId}): ${outputs.length} output(s) in the decode schema but ${plan.outRefs.length} out ref(s)`,
    );
  }
  outputs.forEach((out, j) => {
    const ref = plan.outRefs[j];
    if (ref !== undefined && !typesEqual(ref.type, abiParamToType(out))) {
      throw internal(
        `call to ${fnAbi.name} (site ${siteId}): output #${j} is ${out.type} but its slot is typed ${fmtType(ref.type)}`,
      );
    }
  });
  if (tryMode && plan.successRef === null) {
    throw internal(`try call to ${fnAbi.name} (site ${siteId}): successRef is required`);
  }
  if (!tryMode && plan.successRef !== null) {
    throw internal(`strict call to ${fnAbi.name} (site ${siteId}): successRef must be null`);
  }

  const emitDecodeFail = makeDecodeFail(w, plan, tryMode, 'call');

  // -- 1. calldata template into transient scratch (free pointer NOT bumped) -------------
  const template = emitCalldataFor(w, plan, tails, opts, dataSeg);

  // -- 2. the subcall (issue #1): STATICCALL for `kind: 'static'` (s.read), CALL with value 0 for
  // `kind: 'call'` (s.call — a non-static frame for non-view targets). `kind: 'simulate'` never
  // reaches here (lowerCall routes it to emitSimulateCall). Operand order:
  //   STATICCALL(gas, addr, buf, argsSize, 0, 0)
  //   CALL      (gas, addr, value=0, buf, argsSize, 0, 0)
  // — identical save the extra `value` word, so only one push + the opcode differ; the decode,
  // bubble, and try-zeroing below are byte-shared.
  const useCall = stmt.kind === 'call';
  w.push(FREE_PTR);
  w.op('MLOAD'); // [buf]
  w.push(0); // [retSize, buf]
  w.push(0); // [retOff, retSize, buf]
  if (template !== null && template.regime === 'static') {
    w.push(template.staticSize); // [argsSize, …]
  } else {
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tailEnd, retOff, retSize, buf]
    w.op('DUP4'); // [buf, tailEnd, …]
    w.op('SWAP1'); // [tailEnd, buf, …]
    w.op('SUB'); // [argsSize, retOff, retSize, buf]
  }
  w.op('DUP4'); // [argsOff = buf, argsSize, retOff, retSize, buf]
  if (useCall) w.push(0, { note: 'value 0' }); // [value, argsOff, …] — CALL only
  pushWordRef(w, plan.targetRef, `target of ${fnAbi.name}`, 'target');
  pushGasRef(w, plan.gasRef, `gas of ${fnAbi.name}`);
  w.op(useCall ? 'CALL' : 'STATICCALL', {
    note: `${stmt.mode} ${useCall ? 'call' : 'read'} ${fnAbi.name}${revertMode ? ' [revertReturns]' : ''} (site ${siteId})`,
  }); // [success, buf]

  const ok = w.newLabel(`call_ok_${siteId}`);
  // revertReturns (issue #35): the branch is INVERTED — a REVERT is the value path (its payload is
  // decoded below exactly like returndata), a normal RETURN is the failure.
  if (revertMode) w.op('ISZERO', { note: 'revertReturns: a revert is the value path' });
  w.pushLabel(ok);
  w.op('JUMPI'); // [buf]
  if (revertMode) {
    // a normal return under revertReturns: nothing to bubble (no revert payload) — strict lands on
    // the site's `EvsDecodeError(site)` stub (an 'any'-height label), try on the zero block
    // (height 0); POP first so both entries are clean.
    w.op('POP');
    w.pushLabel(plan.dfailLabel);
    w.op('JUMP', { note: 'revertReturns: normal return is the failure' });
  } else if (tryMode) {
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

  // -- 3. decode (guard BEFORE any head read; snapshot; normalize/validate). Under revertReturns
  //       the returndata IS the revert payload — the sequence is byte-identical. ----------------
  if (outputs.length > 0) {
    const outOffsets = headOffsets(outputs); // cumulative (static tuple outputs inline)
    const minSize = headBytes(outputs);
    // tuple outputs AND composite-element array outputs (`tuple[]`/`T[][]`/`string[]`) decode from
    // the memory snapshot (SNAP_SLOT) via the recursive decoders — they need the scratch-resident
    // base/end (the decoders churn the free ptr, so a stack-resident base would drift).
    const hasTupleOut = outputs.some((p) => needsMemorySnapshot(layoutOfType(abiParamToType(p))));

    // staticMinSize guard: rds ≥ headBytes(outputs)
    w.op('RETURNDATASIZE');
    w.push(minSize, { note: `staticMinSize ${minSize}` });
    w.op('GT'); // [minSize > rds, buf]
    emitDecodeFail(1); // [buf]

    // snapshot ENTIRE returndata at buf; tuple/composite outputs additionally need the base in
    // SNAP_SLOT (they decode through scratch — see emitSnapshotReturndata).
    emitSnapshotReturndata(w, hasTupleOut); // [buf]
    const pushEnd = (): void => pushSnapEnd(w);

    outputs.forEach((out, j) => {
      const ref = plan.outRefs[j];
      if (ref === undefined) throw internal(`missing out ref #${j}`);
      const type = abiParamToType(out);
      const layout = layoutOfType(type);
      const headOffset = outOffsets[j] ?? 32 * j;

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

      if (layout.kind === 'tuple') {
        // decode the tuple from the snapshot into a flat-pointer block; alias dynamic members.
        // base/end are read from scratch so the decoder's free-ptr churn never disturbs them.
        let pushBase: PushBase;
        if (layout.dynamic) {
          // offset word at buf+headOffset (relative to buf); bounds, then base = buf+off
          pushSnap(w);
          if (headOffset !== 0) {
            w.push(headOffset);
            w.op('ADD');
          }
          w.op('MLOAD'); // [off, buf]
          w.op('DUP1');
          w.push(MAX_U64);
          w.op('LT'); // [off > max, off, buf]
          emitDecodeFail(2); // [off, buf]
          pushSnap(w);
          w.op('ADD'); // [base, buf]
          w.op('DUP1');
          w.push(32);
          w.op('ADD'); // [base+32, base, buf]
          pushSnapEnd(w);
          w.op('LT'); // [end < base+32, base, buf]
          emitDecodeFail(2); // [base, buf]
          w.op('POP'); // [buf]   (base is re-derived inside the thunk)
          pushBase = () => pushSnapOffsetBase(w, headOffset);
        } else {
          pushBase = () => {
            pushSnap(w);
            if (headOffset !== 0) {
              w.push(headOffset);
              w.op('ADD');
            }
          };
        }
        if (!isTupleType(type)) throw internal(`out #${j} layout is tuple but type is not`);
        emitDecodeTupleToMem(w, type.components, pushBase, pushEnd, emitDecodeFail, 1); // [flat, buf]
        w.push(ref.slot);
        w.op('MSTORE', { note: `out #${j} tuple (flat block)` }); // [buf]
        return;
      }

      if (layout.kind === 'array' && isRecursiveArray(layout)) {
        // recursive-codec array output (`tuple[]`/`T[][]`/`string[]`, any `T[N]`): decode from the
        // snapshot into a fresh `[len][p0…]` pointer block (its elements alias/recurse). base/end
        // come from SNAP_SLOT (the array decoder churns the free ptr, so a stack-resident base would
        // drift), exactly like the tuple-output path above. A STATIC fixed-size array inlines at
        // buf+headOffset; otherwise the head word there is an offset relative to buf — bound it,
        // then base = buf+off.
        let pushArrBase: PushBase;
        if (isDynamic(layout)) {
          // off bounds: off ≤ 2^64−1, off + 32 ≤ rds
          pushSnap(w);
          if (headOffset !== 0) {
            w.push(headOffset);
            w.op('ADD');
          }
          w.op('MLOAD'); // [off, buf]
          w.op('DUP1');
          w.push(MAX_U64);
          w.op('LT'); // [off > max, off, buf]
          emitDecodeFail(2); // [off, buf]
          w.op('DUP1');
          w.push(32);
          w.op('ADD'); // [off+32, off, buf]
          w.op('RETURNDATASIZE');
          w.op('LT'); // [rds < off+32, off, buf]
          emitDecodeFail(2); // [off, buf]
          w.op('POP'); // [buf]   (base re-derived inside the thunk)
          pushArrBase = () => pushSnapOffsetBase(w, headOffset);
        } else {
          pushArrBase = () => {
            pushSnap(w);
            if (headOffset !== 0) {
              w.push(headOffset);
              w.op('ADD');
            } // [base = buf+headOffset]
          };
        }
        emitDecodeArrayToMem(w, layout, pushArrBase, pushEnd, emitDecodeFail, 1); // [arr, buf]
        w.push(ref.slot);
        w.op('MSTORE', { note: `out #${j} ${out.type} (pointer block)` }); // [buf]
        return;
      }

      const isArray = layout.kind === 'array';
      // off := snapshot[headOffset]; off ≤ 2^64−1; off + 32 ≤ rds
      w.op('DUP1');
      if (headOffset !== 0) {
        w.push(headOffset);
        w.op('ADD');
      }
      w.op('MLOAD'); // [off, buf]
      w.push(MAX_U64);
      w.op('DUP2');
      w.op('GT'); // [off > max, off, buf]
      emitDecodeFail(2); // [off, buf]
      w.op('DUP1');
      w.push(32);
      w.op('ADD'); // [off+32, off, buf]
      w.op('RETURNDATASIZE');
      w.op('LT'); // [rds < off+32, off, buf]
      emitDecodeFail(2); // [off, buf]

      // ptr := buf + off; len checks: len ≤ 2^64−1, off + 32 + nbytes ≤ rds
      w.op('DUP2');
      w.op('ADD'); // [ptr, buf]
      w.op('DUP1');
      w.op('MLOAD'); // [len, ptr, buf]
      w.push(MAX_U64);
      w.op('DUP2');
      w.op('GT'); // [len > max, len, ptr, buf]
      emitDecodeFail(3); // [len, ptr, buf]
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
      emitDecodeFail(2); // [ptr, buf]

      if (layout.kind === 'array') {
        // dynamic word-element array (every other array was handled above): eager element
        // normalization over the aliased snapshot region.
        if (layout.elem.kind !== 'word' || isRecursiveArray(layout)) {
          throw internal('recursive-codec array reached the word-array decode path');
        }
        const elemAbi = layout.elem.abi;
        if (wordNeedsNormalize(elemAbi)) {
          // eager element normalization over the aliased snapshot
          w.op('DUP1');
          w.op('MLOAD');
          w.push(5);
          w.op('SHL'); // [nbytes, ptr, buf]
          w.op('DUP2');
          w.op('ADD');
          w.push(32);
          w.op('ADD'); // [end, ptr, buf]
          w.op('DUP2');
          w.push(32);
          w.op('ADD'); // [cur, end, ptr, buf]
          emitNormalizeElemsLoop(w, elemAbi, 2);
          w.op('POP');
          w.op('POP'); // [ptr, buf]
        }
      }

      w.push(ref.slot);
      w.op('MSTORE', { note: `out #${j} ${out.type} (memref aliases snapshot)` }); // [buf]
    });
  }
  w.op('POP'); // []

  // -- 4. try mode: success flag, zero block (checked — rejoins), join --------------------
  if (tryMode) emitTryEpilogue(w, plan, 'call');
}
