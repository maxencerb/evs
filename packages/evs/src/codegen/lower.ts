/**
 * `codegen/lower.ts` — the statement templates (the checked-op table, the canonical word
 * invariant, the control-flow shapes, the fncall convention).
 *
 * A barrel over `codegen/lower/`:
 * - `context.ts` — the `LowerCtx` contract (`createLowerCtx`, `withLoop`) and the operand /
 *   slot / range-check helpers every template uses;
 * - `statements.ts` — the statement dispatch, the fn subroutines, `call` / `fncall` and the
 *   control flow (`if` / `while` recurse into the dispatch);
 * - `values.ts` — `const`, `un`, `env` and `convert`;
 * - `arith.ts` — `bin` (checked and wrapping arithmetic, comparisons, logic, bits, shifts) and
 *   `addmod` / `mulmod`;
 * - `pow.ts` — checked exponentiation (issue #10);
 * - `muldiv.ts` — `mulDiv` / `mulDivRoundingUp` (the FullMath 512-bit sequence, inline for a
 *   single site, else the shared `@muldiv` subroutine);
 * - `composites.ts` — select / index / arrays, string/bytes `byteAt` / `slice`, tuples, and
 *   `s.encode` / `s.keccak256` / `s.throw` payloads;
 * - `guards.ts` — the dominating guard facts (`LowerCtx.guards`): the counter-loop step
 *   overflow checks and guarded index bounds checks the IR's own `lt` guards prove redundant,
 *   which `arith.ts` / `composites.ts` (and the site table) then elide.
 *
 * Invariants (machine-checked by `asm/verify.ts` on every assemble):
 * - every statement template is net-zero on the operand stack: each statement starts and ends
 *   at its block's baseline (0 in the main body and an fn body). Under `optimize` the
 *   store–reload fusion pass (`codegen/fuse.ts`, run by `lowerProgram` after lowering) lets one
 *   single-use value cross the boundary between two adjacent statements on the stack, never
 *   across a label. Every label carries an annotated height (statement-level labels sit at the
 *   statement baseline; fn entries, loops inside templates and tails like `@muldiv` carry their
 *   own), and the verifier checks each one;
 * - simulated depth stays ≤ 16 inside templates;
 * - panic exits jump to the shared `'any'` tails (`SharedTails`), never revert inline.
 *
 * Operand convention: binary templates load the RIGHT operand
 * first, then the left — the left operand sits on top, so `SUB`/`DIV`/`LT`/… compute
 * `op(a, b)` directly. Templates that accept either order (add, mul, eq/neq, the bool and
 * bitwise ops, and the comparisons, which flip LT ↔ GT) load the left operand first when the
 * previous statement just stored it, so the optimizer can fuse that store and reload (`storeOut`
 * and `loadOperand` register their nodes for the fusion pass when `optimize` is on). Folded
 * word constants (`FrameLayout.slotOfValue === null`) load as PUSH immediates; everything else
 * as `PUSH slot MLOAD`.
 *
 * fncall convention: the caller MSTOREs args into
 * the callee's static param slots, pushes `@ret_k`, and jumps to the entry JUMPDEST
 * (annotated at stack height 1 — the return address). The callee then immediately SPILLS the
 * return address into its dedicated frame slot (`FrameLayout.fnRegion(f).returnAddress`) so
 * the body runs at stack baseline 0, and reloads it for the return JUMP. Rationale (rather
 * than keeping the return address on the stack during the body): the emitters (`emitStaticCall`,
 * `emitMemCopy`) pin checked labels at absolute height 0/1/4, so a baseline-1 body could not
 * contain calls; and nested fncalls would present two different absolute heights to a single
 * callee entry annotation, which the `asm/verify.ts` verifier cannot express. No recursion ⇒
 * one spill slot per fn is sound.
 */

export {
  createLowerCtx,
  foldedConst,
  MIN_I256,
  MINUS_ONE_WORD,
  numClass,
  selfAddressValues,
  typeOf,
  walkEmittedStmts,
} from './lower/context.js';
export type { FusionLog, LowerCtx } from './lower/context.js';
export { guardFacts } from './lower/guards.js';
export type { GuardFacts } from './lower/guards.js';
export { checkedArithCanOverflow } from './lower/arith.js';
export { lowerStmts, emitFnSubroutines } from './lower/statements.js';
