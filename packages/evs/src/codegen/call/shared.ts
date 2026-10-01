/**
 * `codegen/call/shared.ts` — the `CallSitePlan` contract, the literal-operand helpers, and the
 * machinery `emitStaticCall` and `emitSimulateCall` share: decode-failure routing, word / gas
 * refs, the returndata snapshot and the try epilogue.
 */

import { layoutOfType } from '../../abi/layout.js';
import type { LabelId, AsmWriter } from '../../asm/assembler.js';
import { HEX_BYTES_RE, hexToBytes, bytesToBigInt } from '../../core/bytes.js';
import { EvsInternalError } from '../../core/errors.js';
import {
  abiParamToType,
  stringifyType,
  typesEqual,
  type Hex,
  type NamedType,
} from '../../core/types.js';
import { callOutputs, type Stmt, type ConstData, type SiteId } from '../../ir/nodes.js';
import {
  type DecodeFail,
  type SlotRef,
  emitCeil32,
  emitWithinStackBudget,
  encodeFramesOf,
  fmtType,
} from '../abi.js';
import { SNAP_SLOT, FREE_PTR, emitZeroValue } from '../memory.js';

// ---------------------------------------------------------------------------
// contract types
// ---------------------------------------------------------------------------

export interface CallSitePlan {
  stmt: Extract<Stmt, { k: 'call' }>;
  /** Where the callee address lives (slot or folded literal); see the module header. */
  targetRef: SlotRef | { literal: ConstData };
  /** Optional gas cap operand (slot or folded literal); absent → forward all via GAS. */
  gasRef?: SlotRef | { literal: ConstData };
  /** Optional wei operand of a CALL (`s.call` / `s.simulate`); absent → value 0. */
  valueRef?: SlotRef | { literal: ConstData };
  argRefs: readonly (SlotRef | { literal: ConstData })[];
  outRefs: readonly SlotRef[];
  successRef: SlotRef | null;
  dfailLabel: LabelId; // per-site stub target (strict) or zero-block (try)
  siteId: SiteId;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Const segments at or under this size are PUSH-chunked; larger ones go to a data segment. */
export const CONST_SEGMENT_INLINE_MAX = 96;

export function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/call: ${message}`);
}

export function isLiteralRef(ref: SlotRef | { literal: ConstData }): ref is { literal: ConstData } {
  return 'literal' in ref;
}

export function literalBytes(hex: Hex, what: string): Uint8Array {
  if (!HEX_BYTES_RE.test(hex)) throw internal(`${what}: malformed hex ${hex}`);
  return hexToBytes(hex);
}

export function literalWordValue(data: ConstData, what: string): bigint {
  if (data.kind !== 'word') throw internal(`${what}: expected a word literal, got '${data.kind}'`);
  const bytes = literalBytes(data.hex, what);
  if (bytes.length !== 32) throw internal(`${what}: word literal must be 32 bytes`);
  return bytesToBigInt(bytes);
}

export function literalDataBytes(data: ConstData, what: string): Uint8Array {
  if (data.kind !== 'data') throw internal(`${what}: expected a data literal, got '${data.kind}'`);
  const bytes = literalBytes(data.hex, what);
  if (bytes.length < 32 || bytes.length % 32 !== 0) {
    throw internal(`${what}: data literal must be a padded [len][payload…] image`);
  }
  return bytes;
}

/**
 * Pushes the 32-byte chunk's word value with the smallest encoding: minimal-width PUSH for
 * the significant prefix, plus a SHL when the chunk has trailing zero bytes (this reproduces
 * the `PUSH4 <sel> PUSH1 0xE0 SHL` selector idiom for free).
 */
export function emitPushWordChunk(w: AsmWriter, chunk: Uint8Array, note?: string): void {
  const v = bytesToBigInt(chunk, 0, chunk.length);
  const meta = note === undefined ? {} : { note };
  if (v === 0n) {
    w.push(0, meta);
    return;
  }
  let tz = 0;
  while (tz < 31 && chunk[31 - tz] === 0) tz += 1;
  if (tz === 0) {
    w.push(v, meta);
    return;
  }
  w.push(v >> BigInt(8 * tz), meta);
  w.push(8 * tz);
  w.op('SHL');
}

/**
 * Pushes a 4-byte function selector as the left-aligned word `selector << 224` through
 * {@link emitPushWordChunk}: `PUSH4 <sel> PUSH1 0xE0 SHL` (8 bytes) instead of a 33-byte
 * `PUSH32`, the same idiom the template calldata path gets for free.
 */
export function emitSelectorWord(w: AsmWriter, selector: Uint8Array, note: string): void {
  if (selector.length !== 4) throw internal(`${note}: a selector must be 4 bytes`);
  const chunk = new Uint8Array(32);
  chunk.set(selector);
  emitPushWordChunk(w, chunk, note);
}

// ---------------------------------------------------------------------------
// machinery shared by emitStaticCall and emitSimulateCall. The two emitters
// legitimately diverge only in the middle — per-output in-place decode vs whole-tuple
// decode-then-scatter — everything else routes through these helpers.
// ---------------------------------------------------------------------------

/**
 * Checks a call site's plan against its decode schema `outputs` (the emitters' shared
 * invariants, all guaranteed by lowering): one out ref per output, each typed as its output, and
 * a success ref exactly in try mode. `what` names the site in the INTERNAL error
 * (`call to f`, `simulate f`).
 */
export function assertSitePlan(
  plan: CallSitePlan,
  outputs: readonly NamedType[],
  what: string,
): void {
  const { siteId } = plan;
  if (outputs.length !== plan.outRefs.length) {
    throw internal(
      `${what} (site ${siteId}): ${outputs.length} output(s) in the decode schema but ${plan.outRefs.length} out ref(s)`,
    );
  }
  outputs.forEach((out, j) => {
    const ref = plan.outRefs[j];
    if (ref !== undefined && !typesEqual(ref.type, abiParamToType(out))) {
      throw internal(
        `${what} (site ${siteId}): output #${j} is ${out.type} but its slot is typed ${fmtType(ref.type)}`,
      );
    }
  });
  const tryMode = plan.stmt.mode === 'try';
  if (tryMode && plan.successRef === null) {
    throw internal(`try ${what} (site ${siteId}): successRef is required`);
  }
  if (!tryMode && plan.successRef !== null) {
    throw internal(`strict ${what} (site ${siteId}): successRef must be null`);
  }
}

/**
 * try-mode failure router. Stack on entry: `[bad, …live]`; on exit (continue path):
 * `[…live]`. Strict mode jumps straight to the `'any'` dfail stub; try mode inverts the
 * branch, cleans the stack to height 0, and jumps to `tryTarget` — the (checked, height-0) zero
 * block by default, or its free-pointer-restoring entry (see {@link emitTryEpilogue}).
 * `labelPrefix` keeps the emitters' historical label names (`call_*` / `sim_*`).
 */
export function makeDecodeFail(
  w: AsmWriter,
  plan: CallSitePlan,
  tryMode: boolean,
  labelPrefix: string,
  tryTarget: LabelId = plan.dfailLabel,
): DecodeFail {
  return (liveDepth: number): void => {
    if (!tryMode) {
      w.pushLabel(plan.dfailLabel);
      w.op('JUMPI');
      return;
    }
    const cont = w.newLabel(`${labelPrefix}_${plan.siteId}_cont`);
    w.op('ISZERO');
    w.pushLabel(cont);
    w.op('JUMPI'); // […live]
    for (let k = 0; k < liveDepth; k++) w.op('POP');
    w.pushLabel(tryTarget);
    w.op('JUMP');
    w.label(cont, liveDepth);
  };
}

/** Pushes a word operand: a literal ref as an immediate PUSH, else `MLOAD` of its slot. */
export function pushWordRef(
  w: AsmWriter,
  ref: SlotRef | { literal: ConstData },
  what: string,
  note: string,
): void {
  if (isLiteralRef(ref)) {
    w.push(literalWordValue(ref.literal, what), { note });
  } else {
    w.push(ref.slot);
    w.op('MLOAD', { note });
  }
}

/** Pushes the CALL value operand: the site's `value` when one was given, else 0. */
export function pushValueRef(w: AsmWriter, valueRef: CallSitePlan['valueRef'], what: string): void {
  if (valueRef === undefined) {
    w.push(0, { note: 'value 0' });
  } else {
    pushWordRef(w, valueRef, what, 'value');
  }
}

/** Pushes the gas operand: the site's gas cap when one was given, else `GAS`. */
export function pushGasRef(w: AsmWriter, gasRef: CallSitePlan['gasRef'], what: string): void {
  if (gasRef === undefined) {
    w.op('GAS');
  } else {
    pushWordRef(w, gasRef, what, 'gas cap');
  }
}

/**
 * Whether a call site's returndata snapshot outlives the site — i.e. whether the site allocates
 * memory (the `LOOP_ALLOCATION` diagnostic asks the same question, so both read it here).
 * `s.read`/`s.call` sites whose every output is a word copy each word into its frame slot
 * straight off the snapshot, so the snapshot is transient — read above the free pointer without
 * bumping it, like the calldata template; a memref output (`string`/`bytes`/array/tuple) aliases
 * or decodes from the snapshot, which must then stay allocated. An `s.simulate` site always
 * snapshots the trampoline's revert payload into a fresh allocation, outputs or not.
 */
export function callSiteAllocates(stmt: Extract<Stmt, { k: 'call' }>): boolean {
  if (stmt.kind === 'simulate') return true;
  return callOutputs(stmt).some((p) => layoutOfType(abiParamToType(p)).kind !== 'word');
}

/**
 * How many encode frames a call site's ARGS need (`encodeFramesOf`, max over the inputs): args
 * holding fixed-size arrays, arrays of structs / strings / arrays, or dynamic structs nested three
 * or more levels deep. The calldata builder reserves that many frames by bumping the free pointer
 * once (`reserveEncodeFrames`), so a site with any allocates even when its outputs are words — the
 * `LOOP_ALLOCATION` diagnostic reads it here too. 0 → no bump.
 */
export function callArgEncodeFrames(stmt: Extract<Stmt, { k: 'call' }>): number {
  return stmt.fnAbi.inputs.reduce(
    (n, p) => Math.max(n, encodeFramesOf(layoutOfType(abiParamToType(p)))),
    0,
  );
}

/**
 * `[buf] → [buf]`: snapshot the ENTIRE returndata at buf (RETURNDATACOPY shape 2) and, with
 * `opts.bump` (the default), bump the free pointer to `buf + ceil32(rds)`; without it the
 * snapshot is transient scratch the caller must consume before anything allocates (see
 * {@link callSiteAllocates}). With `storeSnapSlot`, also store the base in scratch `SNAP_SLOT` —
 * the recursive memory decoders churn the free ptr, so they read base/end from scratch (a
 * stack-resident base would drift). With `opts.reserveBudgetWord`, the free pointer moves one
 * word further, past the decode-work budget word at `buf + rds` (`emitInitDecodeBudget` in
 * `codegen/abi/decode.ts`); it implies `bump`.
 */
export function emitSnapshotReturndata(
  w: AsmWriter,
  storeSnapSlot: boolean,
  opts: { readonly bump?: boolean; readonly reserveBudgetWord?: boolean } = {},
): void {
  const reserveBudgetWord = opts.reserveBudgetWord === true;
  if (opts.bump === false && reserveBudgetWord) {
    throw internal('a decode-budget word needs a bumped (persistent) snapshot');
  }
  w.returndatacopyAll({ dupDepth: 1 }); // [buf]
  if (opts.bump !== false) {
    w.op('RETURNDATASIZE');
    emitCeil32(w); // [ceil32(rds), buf]
    if (reserveBudgetWord) {
      w.push(32);
      w.op('ADD'); // [ceil32(rds) + 32, buf]
    }
    w.op('DUP2');
    w.op('ADD'); // [buf + ceil32(rds) (+32), buf]
    w.push(FREE_PTR);
    w.op('MSTORE'); // [buf]
  }
  if (storeSnapSlot) {
    w.op('DUP1');
    w.push(SNAP_SLOT);
    w.op('MSTORE'); // [buf]   scratch[SNAP_SLOT] = snapshot base
  }
}

/** `[] → [buf]`: the returndata snapshot base, read back from scratch `SNAP_SLOT`. */
export function pushSnap(w: AsmWriter): void {
  w.push(SNAP_SLOT);
  w.op('MLOAD'); // [buf]
}

/** `[] → [buf + rds]`: the end of the returndata snapshot. */
export function pushSnapEnd(w: AsmWriter): void {
  pushSnap(w);
  w.op('RETURNDATASIZE');
  w.op('ADD'); // [buf + rds]
}

/**
 * try-mode epilogue: success flag := 1, jump to join; the site's dfail label opens the
 * (checked, height-0) zero block — success := 0 and a zero value per output (word outs = 0,
 * string/bytes/array outs = 0x60, tuple outs = a fresh zero-filled flat block) — which falls
 * through to the join. `labelPrefix` keeps the emitters' historical label names.
 *
 * `restoreLabel` (sites whose outputs decode through the recursive memory decoders) opens an
 * entry just above the zero block that first rolls the free pointer back to the returndata
 * snapshot base in scratch `SNAP_SLOT`: a decode that fails part-way leaves its partial
 * allocations (pointer blocks, flat blocks, heap frames) and the snapshot behind, and nothing
 * references them once the zero block overwrites every output. Only failures AFTER the snapshot
 * may route there (before it, `SNAP_SLOT` holds a stale scratch value).
 */
export function emitTryEpilogue(
  w: AsmWriter,
  plan: CallSitePlan,
  labelPrefix: string,
  restoreLabel: LabelId | null = null,
): void {
  const { siteId } = plan;
  if (plan.successRef !== null) {
    w.push(1);
    w.push(plan.successRef.slot);
    w.op('MSTORE', { note: `success = 1 (site ${siteId})` });
  }
  const join = w.newLabel(`${labelPrefix}_join_${siteId}`);
  w.pushLabel(join);
  w.op('JUMP');

  if (restoreLabel !== null) {
    w.label(restoreLabel, 0, `restore_${siteId}`);
    pushSnap(w);
    w.push(FREE_PTR);
    w.op('MSTORE', { note: `free ptr := snapshot base (site ${siteId})` }); // falls into the zero block
  }
  w.label(plan.dfailLabel, 0, `zero_${siteId}`);
  if (plan.successRef !== null) {
    w.push(0);
    w.push(plan.successRef.slot);
    w.op('MSTORE', { note: `success = 0 (site ${siteId})` });
  }
  plan.outRefs.forEach((ref, j) => {
    emitWithinStackBudget(
      w,
      0,
      () => `the try zero value of output #${j} (${stringifyType(ref.type)}) at site ${siteId}`,
      () => emitZeroValue(w, ref.type, 0), // [zero]   (the zero block is checked at height 0)
    );
    w.push(ref.slot);
    w.op('MSTORE');
  });
  w.label(join, 0); // fallthrough from the zero block rejoins here
}
