/**
 * `ir/nodes/origin.ts` — where a `ScriptIr` object came from.
 *
 * `validateIr` reports an invalid IR in one of two ways. An IR this copy of evs produced (the
 * recorder's output, or what `eliminateDeadCode` derives from one) is valid by construction, so a
 * failure there is a bug in evs: `EvsInternalError`. Every other IR object (a `deserializeIr`
 * result, a hand-written object, the IR of another evs install) is the caller's input, and a
 * failure there is the caller's to fix: a coded user error.
 *
 * The registry holds object identities, so an entry must never change after it is registered:
 * only deep-frozen IR is registered ({@link markEvsIr}'s callers guarantee it).
 */

import type { ScriptIr } from './schema.js';

const EVS_MADE = new WeakSet<ScriptIr>();

/**
 * Registers `ir` as produced by this copy of evs. `ir` must be deep-frozen and valid by
 * construction: the recorder's sealed output, or a pass's output over a registered IR.
 */
export function markEvsIr(ir: ScriptIr): void {
  EVS_MADE.add(ir);
}

/** Whether this copy of evs produced `ir` ({@link markEvsIr}); `false` for IR from anywhere else. */
export function isEvsIr(ir: ScriptIr): boolean {
  return EVS_MADE.has(ir);
}
