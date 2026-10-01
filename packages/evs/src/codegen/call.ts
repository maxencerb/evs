/**
 * `codegen/call.ts` — the external-call site emitters: `emitStaticCall` (STATICCALL for `s.read`,
 * CALL for `s.call`) and `emitSimulateCall` (the `s.simulate` self-call).
 *
 * A barrel over `codegen/call/`:
 * - `shared.ts` — the `CallSitePlan` contract, literal helpers, and the machinery both emitters
 *   share (plan validation, decode-failure routing, gas / value / word refs, the returndata
 *   snapshot, the try epilogue);
 * - `calldata.ts` — the calldata template (compile-time const folding) and its build emission,
 *   including the recursive tuple-bearing encoder;
 * - `static-call.ts` — `emitStaticCall` (the subcall, its failure arm, the per-output decode);
 * - `simulate-call.ts` — `emitSimulateCall` (the self-call trampoline site).
 *
 * `CallSitePlan` carries the call *target* location (and optional gas cap and value) alongside the
 * args — `targetRef` (required), `gasRef` and `valueRef` (optional) mirror `argRefs`'
 * `SlotRef | { literal: ConstData }` shape — since the emitters cannot emit the call opcode
 * without them.
 *
 * Shapes:
 * - CalldataTemplate: compile-time const segments (selector + every literal arg, merged),
 *   `word` segments (runtime word slots MSTOREd at their head offsets), `dyn` segments
 *   (runtime memrefs: head offset word + tail copied via `emitMemCopy` with explicit
 *   zero-padding). All-literal calls collapse to one const segment: ≤ 96 bytes →
 *   PUSH-chunked MSTOREs; larger → data segment + CODECOPY. The buffer lives at transient
 *   scratch `MLOAD(0x40)` and is NOT bumped.
 * - `STATICCALL(gas, addr, buf, argsSize, 0, 0)` (CALL adds the `value` word, 0 by default) —
 *   retSize 0 always; returndata is fetched via the two sanctioned RETURNDATACOPY shapes only
 *   (`w.returndatacopyAll`).
 * - strict failure → verbatim bubble; decode failure → `plan.dfailLabel` (an `'any'` stub the
 *   program assembler emits — `codegen/tails.ts` `emitDecodeFailStub`).
 * - `rds ≥ headBytes(outputs)` guard BEFORE any head read; then snapshot the whole returndata
 *   at `MLOAD(0x40)`. The free pointer is bumped past it only when an output is a memref
 *   (`callSiteAllocates`) or its decode is budgeted: word-only outputs are copied out at once, so
 *   their snapshot stays transient and a loop of word reads does not grow memory.
 * - word outputs normalize-don't-revert; `string` / `bytes` / word-array outputs validate in
 *   place (2^64 guards, overflow-free bounds) and alias the snapshot, a narrow-element array
 *   being normalized into a fresh copy (never in place — another output may alias the same
 *   bytes); tuple and recursive-codec array outputs decode from the snapshot through
 *   `emitDecodeFromRegion` (`codegen/abi/decode.ts`), budgeted when they can charge.
 * - `s.simulate` decodes the carried returndata as one tuple (`emitDecodeTupleToMem` over the
 *   outputs block) and copies each word into its out slot.
 * - try mode: `plan.dfailLabel` IS the zero block, emitted inline here as a *checked* label
 *   (it rejoins the program): every failure path cleans its stack to height 0 and jumps to
 *   it; it zeroes `successOut`/word outs and points memref outs at the `0x60` zero slot, then
 *   falls through to the join.
 * - `revertReturns` (issue #35, `kind: 'call'` only): the CALL success flag is inverted — a
 *   REVERT is the value path and the SAME decode sequence (guard, snapshot, normalize/validate)
 *   runs over the revert payload with `callOutputs(stmt)` as the schema; a normal RETURN is the
 *   failure and jumps to `plan.dfailLabel` (strict: the `EvsDecodeError(site)` stub — nothing is
 *   bubbled; try: the zero block).
 */

export type { CallSitePlan } from './call/shared.js';
export { callArgEncodeFrames, callSiteAllocates } from './call/shared.js';
export { emitStaticCall } from './call/static-call.js';
export { emitSimulateCall } from './call/simulate-call.js';
