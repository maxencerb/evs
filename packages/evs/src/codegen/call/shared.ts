/**
 * `codegen/call/shared.ts` — the `CallSitePlan` contract, the literal-operand helpers, and the
 * machinery `emitStaticCall` and `emitSimulateCall` share: decode-failure routing, word / gas
 * refs, the returndata snapshot and the try epilogue.
 */

import type { LabelId, AsmWriter } from '../../asm/assembler.js';
import { HEX_BYTES_RE, hexToBytes, bytesToBigInt } from '../../core/bytes.js';
import { EvsInternalError } from '../../core/errors.js';
import { stringifyType, type Hex } from '../../core/types.js';
import type { Stmt, ConstData, SiteId } from '../../ir/nodes.js';
import { type SlotRef, emitCeil32, emitWithinStackBudget } from '../abi.js';
import { SCRATCH_0, FREE_PTR, emitZeroValue } from '../memory.js';

// ---------------------------------------------------------------------------
// contract types
// ---------------------------------------------------------------------------

export interface CallSitePlan {
  stmt: Extract<Stmt, { k: 'call' }>;
  /** Where the callee address lives (slot or folded literal); see the module header. */
  targetRef: SlotRef | { literal: ConstData };
  /** Optional gas cap operand (slot or folded literal); absent → forward all via GAS. */
  gasRef?: SlotRef | { literal: ConstData };
  argRefs: readonly (SlotRef | { literal: ConstData })[];
  outRefs: readonly SlotRef[];
  successRef: SlotRef | null;
  dfailLabel: LabelId; // per-site stub target (strict) or zero-block (try)
  siteId: SiteId;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const TAIL_CURSOR = SCRATCH_0; // scratch — calldata-template tail cursor (transient)
const SNAP_SLOT = SCRATCH_0; // scratch — returndata snapshot base during tuple-output decode (transient,
//                         dead once the calldata cursor's job is done — the call already happened)

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

// ---------------------------------------------------------------------------
// machinery shared by emitStaticCall and emitSimulateCall. The two emitters
// legitimately diverge only in the middle — per-output in-place decode vs whole-tuple
// decode-then-scatter — everything else routes through these helpers.
// ---------------------------------------------------------------------------

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
): (liveDepth: number) => void {
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

/** Pushes the gas operand: the site's gas cap when one was given, else `GAS`. */
export function pushGasRef(w: AsmWriter, gasRef: CallSitePlan['gasRef'], what: string): void {
  if (gasRef === undefined) {
    w.op('GAS');
  } else {
    pushWordRef(w, gasRef, what, 'gas cap');
  }
}

/**
 * `[buf] → [buf]`: snapshot the ENTIRE returndata at buf (RETURNDATACOPY shape 2) and bump
 * the free pointer to `buf + ceil32(rds)`. With `storeSnapSlot`, also store the base in
 * scratch `SNAP_SLOT` — the recursive memory decoders churn the free ptr, so they read
 * base/end from scratch (a stack-resident base would drift).
 */
export function emitSnapshotReturndata(w: AsmWriter, storeSnapSlot: boolean): void {
  w.returndatacopyAll({ dupDepth: 1 }); // [buf]
  w.op('RETURNDATASIZE');
  emitCeil32(w); // [ceil32(rds), buf]
  w.op('DUP2');
  w.op('ADD'); // [buf + ceil32(rds), buf]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [buf]
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

/** `[] → [buf + MLOAD(buf + headOffset)]`: the base of a dynamic output whose head word at
 *  `headOffset` holds a buf-relative offset (bounds-checked by the caller beforehand). */
export function pushSnapOffsetBase(w: AsmWriter, headOffset: number): void {
  pushSnap(w); // [buf]
  w.op('DUP1');
  if (headOffset !== 0) {
    w.push(headOffset);
    w.op('ADD');
  }
  w.op('MLOAD'); // [off, buf]
  w.op('ADD'); // [base]
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
