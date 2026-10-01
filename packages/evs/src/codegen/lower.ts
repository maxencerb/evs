/**
 * `codegen/lower.ts` — the statement templates (the checked-op table, the canonical word
 * invariant, the control-flow shapes, the fncall convention).
 *
 * A barrel over `codegen/lower/`:
 * - `context.ts` — the `LowerCtx` contract, the internals channel shared with `program.ts`, and
 *   the operand / slot / range-check helpers every template uses;
 * - `statements.ts` — the statement dispatch, the fn subroutines, `call` / `fncall` and the
 *   control flow (`if` / `while` recurse into the dispatch);
 * - `values.ts` — `const`, `un`, `env` and `convert`;
 * - `arith.ts` — `bin` (checked and wrapping arithmetic, comparisons, logic, bits, shifts) and
 *   `addmod` / `mulmod`;
 * - `pow.ts` — checked exponentiation (issue #10);
 * - `muldiv.ts` — `mulDiv` / `mulDivRoundingUp` (the FullMath 512-bit sequence);
 * - `composites.ts` — select / index / arrays, string/bytes `byteAt` / `slice`, tuples, and
 *   `s.encode` / `s.keccak256` / `s.throw` payloads.
 *
 * Invariants (machine-checked by `asm/verify.ts` on every assemble):
 * - every statement template is net-zero on the operand stack; the stack is empty at every
 *   statement boundary;
 * - simulated depth stays ≤ 16 inside templates;
 * - panic exits jump to the shared `'any'` tails (`SharedTails`), never revert inline.
 *
 * Operand convention: binary templates load the RIGHT operand
 * first, then the left — the left operand sits on top, so `SUB`/`DIV`/`LT`/… compute
 * `op(a, b)` directly. Templates that accept either order (add, mul, eq/neq, the bool and
 * bitwise ops, and the comparisons, which flip LT ↔ GT) load the left operand first when the
 * previous statement just stored it, so the optimizer can fuse that store and reload. Folded
 * word constants (`FrameLayout.slotOfValue === null`) load as PUSH immediates; everything else
 * as `PUSH slot MLOAD`.
 *
 * fncall convention: the caller MSTOREs args into
 * the callee's static param slots, pushes `@ret_k`, and jumps to the entry JUMPDEST
 * (annotated at stack height 1 — the return address). The callee then immediately SPILLS the
 * return address into its dedicated frame slot (`frame.ts` `fnReturnAddressSlot`) so the body
 * runs at stack baseline 0, and reloads it for the return JUMP. Rationale (rather than keeping
 * the return address on the stack during the body): the emitters (`emitStaticCall`,
 * `emitMemCopy`) pin checked labels at absolute height 0/1/4, so a baseline-1 body could not
 * contain calls; and nested fncalls would present two different absolute heights to a single
 * callee entry annotation, which the `asm/verify.ts` verifier cannot express. No recursion ⇒
 * one spill slot per fn is sound.
 */

export {
  foldedConst,
  lowerInternals,
  MIN_I256,
  MINUS_ONE_WORD,
  numClass,
  selfAddressValues,
  typeOf,
} from './lower/context.js';
export type { LowerCtx, LowerInternals } from './lower/context.js';
export { lowerStmts, emitFnSubroutines } from './lower/statements.js';
