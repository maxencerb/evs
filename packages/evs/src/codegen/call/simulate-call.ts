/**
 * `codegen/call/simulate-call.ts` — `emitSimulateCall`: the `s.simulate` / `s.trySimulate`
 * self-call into the trampoline (issue #1), decoding the whole tuple then scattering it.
 */

import { headBytes, layoutOfType } from '../../abi/layout.js';
import type { AsmWriter, LabelId } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { abiParamToType } from '../../core/types.js';
import {
  type SharedTails,
  emitCeil32,
  emitMemCopy,
  type PushBase,
  emitDecodeTupleToMem,
  needsMemorySnapshot,
  emitWithinStackBudget,
} from '../abi.js';
import { SCRATCH_1, FREE_PTR } from '../memory.js';
import {
  SIMULATE_TRAMPOLINE_SELECTOR_NUM,
  SIMULATE_PAYLOAD_OFFSET,
  SIMULATE_MAGIC,
} from '../simulate.js';
import { emitCalldataFor } from './calldata.js';
import {
  type CallSitePlan,
  internal,
  makeDecodeFail,
  TAIL_CURSOR,
  pushWordRef,
  emitSnapshotReturndata,
  pushSnap,
  pushSnapEnd,
  emitTryEpilogue,
} from './shared.js';

// ---------------------------------------------------------------------------
// emitSimulateCall — the s.simulate / s.trySimulate self-call trampoline (issue #1;
// trampoline body in codegen/simulate.ts)
// ---------------------------------------------------------------------------

/** Reserved 4-byte trampoline selector as a left-shifted 32-byte word (`sel << 224`). */
const TRAMP_SELECTOR_WORD = BigInt(SIMULATE_TRAMPOLINE_SELECTOR_NUM) << 224n;
/** Scratch slot holding the wrapper argsSize (68 + payload length) across the payload memcpy
 *  (the pre-cancun `@memcpy` only clobbers scratch 0x00, so 0x20 survives it). */
const SIM_ARGSIZE_SLOT = SCRATCH_1;
/** Byte length of the wire header `[trampSel(4)][target(32)][gas(32)]` (= the payload offset). */
const SIM_HEADER = SIMULATE_PAYLOAD_OFFSET;

/**
 * Emits an `s.simulate` / `s.trySimulate` site. Builds the target's calldata
 * exactly like a normal call, wraps it as `[trampSel(4)][target(32)][gas(32)][payload…]` in
 * transient scratch above the buffer, self-`CALL`s `ADDRESS()` so the trampoline
 * (codegen/simulate.ts) performs the real write-`CALL` and `REVERT`s with
 * `[MAGIC][innerSuccess][returndata]`, then recognizes the magic, distinguishes a reverting
 * target (strict: bubble; try: success=0), and decodes the carried returndata via the shared
 * memory tuple-decoder — so the write's state is rolled back yet its return value is read back.
 *
 * The site's optional `gas` cap rides in the header's `gas` word and bounds the INNER target
 * CALL (2^256−1 = forward all when absent); the self-call hop itself always forwards `GAS`, so
 * the trampoline's MAGIC-tagged epilogue stays funded however much the target burns.
 */
export function emitSimulateCall(
  w: AsmWriter,
  plan: CallSitePlan,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  dataSeg: (bytes: Uint8Array) => LabelId,
): void {
  const { stmt, siteId } = plan;
  const { fnAbi } = stmt;
  const outputs = fnAbi.outputs;
  const tryMode = stmt.mode === 'try';

  if (stmt.revertReturns !== undefined) {
    // validateIr restricts revertReturns to kind 'call' (the trampoline has its own revert framing)
    throw internal(`simulate ${fnAbi.name} (site ${siteId}): revertReturns survived validateIr`);
  }
  if (outputs.length !== plan.outRefs.length) {
    throw internal(
      `simulate ${fnAbi.name} (site ${siteId}): ${outputs.length} ABI output(s) but ${plan.outRefs.length} out ref(s)`,
    );
  }
  if (tryMode && plan.successRef === null) {
    throw internal(`try simulate ${fnAbi.name} (site ${siteId}): successRef is required`);
  }
  if (!tryMode && plan.successRef !== null) {
    throw internal(`strict simulate ${fnAbi.name} (site ${siteId}): successRef must be null`);
  }

  // try mode over composite outputs: a failure after the snapshot rolls the free pointer back to
  // the snapshot base on its way to the zero block (see emitTryEpilogue); the one failure before
  // the snapshot (no trampoline payload) goes straight to the zero block.
  const restore =
    tryMode && outputs.some((p) => needsMemorySnapshot(layoutOfType(abiParamToType(p))))
      ? w.newLabel(`sim_restore_${siteId}`)
      : null;
  const emitDecodeFailPre = makeDecodeFail(w, plan, tryMode, 'sim');
  const emitDecodeFail =
    restore === null ? emitDecodeFailPre : makeDecodeFail(w, plan, tryMode, 'sim', restore);

  // -- 1. build the target calldata (the payload) — identical to the call/read path -----------
  const template = emitCalldataFor(w, plan, tails, opts, dataSeg);

  // -- 2. wrap [trampSel(4)][target(32)][gas(32)][payload(L)] at W = buf + ceil32(L), above the
  // buffer --
  // L = payload length (static-regime const, else tail cursor − buf). The buffer stays at
  // MLOAD(0x40); the wrapper is transient scratch above it (dead after the self-call).
  if (template !== null && template.regime === 'static') {
    w.push(template.staticSize, { note: 'payload size L' }); // [L]
  } else {
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tailEnd]
    w.push(FREE_PTR);
    w.op('MLOAD'); // [buf, tailEnd]
    w.op('SWAP1');
    w.op('SUB'); // [L = tailEnd − buf]
  }
  // argsSize = 68 + L → SIM_ARGSIZE_SLOT (survives the payload memcpy — @memcpy only clobbers 0x00).
  // Consumes L: W and the memcpy len are recomputed from argsSize, so nothing stays on the stack.
  w.push(SIM_HEADER);
  w.op('ADD'); // [argsSize = 68+L]
  w.push(SIM_ARGSIZE_SLOT);
  w.op('MSTORE'); // []   scratch[0x20] = argsSize
  // W = buf + ceil32(L). It is NOT kept on the stack across the payload memcpy (the pre-cancun
  // `@memcpy` requires the stack to be EXACTLY [dst, src, len]); instead it is recomputed from the
  // stored argsSize as buf + ceil32(argsSize − 68) wherever needed.
  const pushWrapperBase = (): void => {
    w.push(SIM_ARGSIZE_SLOT);
    w.op('MLOAD');
    w.push(SIM_HEADER);
    w.op('SWAP1');
    w.op('SUB'); // [L = argsSize − 68]
    emitCeil32(w); // [ceil32(L)]
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.op('ADD'); // [W = buf + ceil32(L)]
  };
  pushWrapperBase(); // [W]
  // header word 0: MSTORE(W, trampSel << 224)
  w.push(TRAMP_SELECTOR_WORD, { note: 'trampoline selector' }); // [sel, W]
  w.op('DUP2');
  w.op('MSTORE'); // [W]   mem[W] = sel<<224 (zeros [W+4,W+32))
  // header word 1: MSTORE(W+4, target) (overwrites those zeros with the address)
  pushWordRef(w, plan.targetRef, `target of ${fnAbi.name}`, 'target'); // [target, W]
  w.op('DUP2');
  w.push(4);
  w.op('ADD'); // [W+4, target, W]
  w.op('MSTORE'); // [W]   mem[W+4] = target
  // header word 2: MSTORE(W+36, innerGas) — the site's cap, or 2^256−1 (= forward all under the
  // EIP-150 clamp, exactly what GAS would give) when no cap was given.
  if (plan.gasRef === undefined) {
    w.push(0);
    w.op('NOT', { note: 'inner gas: forward all' }); // [2^256−1, W]
  } else {
    pushWordRef(w, plan.gasRef, `gas of ${fnAbi.name}`, 'inner gas cap'); // [gas, W]
  }
  w.op('DUP2');
  w.push(36);
  w.op('ADD'); // [W+36, gas, W]
  w.op('MSTORE'); // [W]   mem[W+36] = inner gas
  // payload memcpy(dst = W+68, src = buf, len = L) — consumes W; leaves EXACTLY [dst, src, len]
  w.push(SIM_HEADER);
  w.op('ADD'); // [W+68]   (dst)
  w.push(FREE_PTR);
  w.op('MLOAD'); // [buf, W+68]   (src)
  w.push(SIM_ARGSIZE_SLOT);
  w.op('MLOAD');
  w.push(SIM_HEADER);
  w.op('SWAP1');
  w.op('SUB'); // [L, buf, W+68]   (len = argsSize − 68)
  w.op('SWAP2'); // [W+68, buf, L]
  emitMemCopy(w, tails, opts); // []   (W+68 > buf+L ⇒ non-overlapping, all forks)

  // -- 3. self-CALL(GAS, ADDRESS(), 0, W, argsSize, 0, 0) — W recomputed from argsSize ----------
  // The hop forwards ALL gas: the user's cap (if any) already rides in the header and bounds the
  // inner CALL inside the trampoline, so the trampoline epilogue is never starved by the target.
  w.push(0); // [retSize=0]
  w.push(0); // [retOff=0, 0]
  w.push(SIM_ARGSIZE_SLOT);
  w.op('MLOAD'); // [argsSize, 0, 0]
  pushWrapperBase(); // [argsOff=W, argsSize, 0, 0]
  w.push(0, { note: 'value 0' }); // [value=0, …]
  w.op('ADDRESS', { note: 'self (the script holds the trampoline)' }); // [self, …]
  w.op('GAS');
  w.op('CALL', {
    note: `${stmt.mode} simulate ${fnAbi.name} (site ${siteId}) — self-call trampoline`,
  }); // [success]
  w.op('POP'); // []   self-call success ignored (the trampoline always reverts; MAGIC is the proof)

  // -- 4. recognize the trampoline revert; snapshot; check magic + inner success --------------
  // rds ≥ 64 (MAGIC + innerSuccess) or it is a genuine failure (OOG / codeless self) → decode-fail
  w.push(64);
  w.op('RETURNDATASIZE');
  w.op('LT'); // [rds < 64]
  emitDecodeFailPre(0); // []

  // snapshot the whole returndata (the trampoline revert payload) at buf; SNAP_SLOT = buf
  w.push(FREE_PTR);
  w.op('MLOAD'); // [buf]
  emitSnapshotReturndata(w, true); // [buf]

  // magic check: MLOAD(buf) === MAGIC, else decode-fail
  w.op('DUP1');
  w.op('MLOAD'); // [word0, buf]
  w.push(SIMULATE_MAGIC, { note: 'simulate magic' });
  w.op('EQ');
  w.op('ISZERO'); // [word0 != MAGIC, buf]
  emitDecodeFail(1); // [buf]

  // innerSuccess = MLOAD(buf+32); 0 → the target reverted
  const decodeOk = w.newLabel(`sim_ok_${siteId}`);
  w.op('DUP1');
  w.push(32);
  w.op('ADD');
  w.op('MLOAD'); // [innerSuccess, buf]
  w.pushLabel(decodeOk);
  w.op('JUMPI'); // [buf]   innerSuccess != 0 → decode the outputs
  // innerSuccess == 0 (target reverted):
  if (tryMode) {
    w.op('POP'); // []
    w.pushLabel(restore ?? plan.dfailLabel);
    w.op('JUMP'); // → zero block (via the free-pointer restore)
  } else {
    // strict: bubble the target's revert verbatim — revert(buf+64, rds−64)
    w.op('RETURNDATASIZE');
    w.push(64);
    w.op('SWAP1');
    w.op('SUB'); // [rds−64, buf]
    w.op('SWAP1');
    w.push(64);
    w.op('ADD'); // [buf+64, rds−64]
    w.op('REVERT', { note: 'bubble the simulated write revert' });
  }
  w.label(decodeOk, 1); // [buf]

  // -- 5. decode the carried returndata [buf+64, buf+rds) as the output tuple ------------------
  if (outputs.length > 0) {
    const minSize = headBytes(outputs);
    // head-size guard on the INNER length: rds−64 ≥ headBytes(outputs)
    w.op('RETURNDATASIZE');
    w.push(64);
    w.op('SWAP1');
    w.op('SUB'); // [rds−64, buf]
    w.push(minSize, { note: `staticMinSize ${minSize}` });
    w.op('GT'); // [minSize > rds−64, buf]
    emitDecodeFail(1); // [buf]

    // decode the outputs as one tuple from [SNAP+64, SNAP+rds) into a flat block, then scatter.
    const pushBase: PushBase = () => {
      pushSnap(w);
      w.push(64);
      w.op('ADD'); // [buf+64]
    };
    const pushEnd = (): void => pushSnapEnd(w);
    emitWithinStackBudget(
      w,
      1,
      () => `the outputs of ${fnAbi.name} (site ${siteId})`,
      () => emitDecodeTupleToMem(w, outputs, pushBase, pushEnd, emitDecodeFail, 1),
    ); // [flat, buf]
    outputs.forEach((out, j) => {
      const ref = plan.outRefs[j];
      if (ref === undefined) throw internal(`simulate missing out ref #${j}`);
      w.op('DUP1'); // [flat, flat, buf]
      if (j !== 0) {
        w.push(32 * j);
        w.op('ADD');
      }
      w.op('MLOAD'); // [word_j, flat, buf]
      w.push(ref.slot);
      w.op('MSTORE', { note: `out #${j} ${out.type}` }); // [flat, buf]
    });
    w.op('POP'); // [buf]
  }
  w.op('POP'); // []

  // -- 6. try mode: success flag, zero block (checked — rejoins), join ------------------------
  if (tryMode) emitTryEpilogue(w, plan, 'sim', restore);
}
