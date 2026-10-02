/**
 * `codegen/lower/muldiv.ts` — `mulDiv` / `mulDivRoundingUp`: `a·b / d` over a 512-bit
 * intermediate (the FullMath sequence). A program with one site inlines it; with two or more,
 * every site calls the shared `@muldiv` subroutine, emitted once among the shared tails and
 * specialized to the rounding the program's sites use.
 */

import type { AsmWriter, LabelId } from '../../asm/assembler.js';
import type { Stmt } from '../../ir/nodes.js';
import type { SharedTails } from '../abi.js';
import {
  type LowerCtx,
  type MulDivRounding,
  foldedConst,
  loadOperand,
  meta,
  storeOut,
  STMT_BASELINE,
} from './context.js';

/** Newton steps after the 4-bit seed: each doubles the correct low bits (8, 16, …, 256). */
const NEWTON_STEPS = 6;

/**
 * `⌊a·b / d⌋` (`muldiv`) or `⌈a·b / d⌉` (`muldivup`) at full precision, with OpenZeppelin
 * `Math.mulDiv`'s Panic codes: 0x12 when `d == 0` (dropped for a folded nonzero denominator,
 * like `div`'s guard), 0x11 when the quotient does not fit uint256. The interpreter's exact
 * bigint quotient is the oracle.
 *
 * The zero guard always stays at the site (so it is elided per site); the FullMath body is
 * either inlined or called (`LowerCtx.mulDivShare`):
 *
 * - one site in the program — inlined, as the body is needed once anyway: the call sequence
 *   would only add ~12 bytes and ~30 gas;
 * - two or more — each site pushes its return label under the operands and calls `@muldiv`
 *   ({@link emitMulDivSubroutine}): ~8 bytes per site instead of ~110, ~36 gas per call. The
 *   subroutine is specialized to the program's rounding, so a program whose sites all round
 *   the same way carries only that mode's code and pushes no flag; one that mixes them also
 *   pushes the rounding flag and tests it in the subroutine (~10 bytes, ~61 gas per call). The
 *   `p1 == 0` fast path runs inside the subroutine as well: keeping it at the site repeats the
 *   512-bit product per site (the measurement is in CONTRIBUTING.md's `mulDiv` design note).
 */
export function lowerMulDiv(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'modarith' }>,
  ctx: LowerCtx,
): void {
  const up = s.op === 'muldivup';
  const shared = ctx.mulDivShare;
  const ret = shared === null ? null : w.newLabel(`muldiv_ret_${s.site}`);
  if (ret !== null) {
    w.pushLabel(ret, meta(`${s.op} uint256`)); // [ret]
    if (shared === 'mixed') w.push(up ? 1 : 0, meta(up ? 'round up' : 'round down')); // [up, ret]
  }
  const denominator = foldedConst(ctx, s.n);
  loadOperand(w, ctx, s.n, ret === null ? meta(`${s.op} uint256`) : undefined); // [d, …]
  if (denominator === undefined || denominator === 0n) {
    w.op('DUP1');
    w.op('ISZERO'); // [d == 0, d, …]
    w.pushLabel(ctx.tails.panicDivZero);
    w.op('JUMPI'); // [d, …]
  }
  loadOperand(w, ctx, s.b); // [b, d, …]
  loadOperand(w, ctx, s.a); // [a, b, d, …]

  if (ret !== null) {
    w.pushLabel(ctx.tails.mulDiv);
    w.op('JUMP', { note: 'call @muldiv' }); // [a, b, d, (up,) ret]
    w.label(ret, STMT_BASELINE + 1); // [q]
    storeOut(w, ctx, s.out);
    return;
  }
  emitQuotient(w, ctx.tails.panicOverflow, { below: STMT_BASELINE, suffix: `_${s.site}` });
  if (up) emitRoundUp(w, ctx.tails.panicOverflow); // [q, a, b, d]
  storeOut(w, ctx, s.out); // [a, b, d]
  w.op('POP');
  w.op('POP');
  w.op('POP');
}

/**
 * The shared `@muldiv` subroutine (programs whose `LowerCtx.mulDivShare` is set), in that
 * rounding. Entry (checked, absolute height): `[a, b, d, ret]` (4) for a `floor` or `up`
 * program, `[a, b, d, up, ret]` (5) for a `mixed` one — `lowerMulDiv` pushes the return label
 * (then the rounding flag, 1 for `mulDivRoundingUp`, when mixed) onto the empty
 * statement-boundary stack, then the operands, with `d` already checked nonzero. Returns `[q]`
 * via dynamic JUMP; its only panic is 0x11. A `floor` program carries no round-up code.
 */
export function emitMulDivSubroutine(
  w: AsmWriter,
  entry: LabelId,
  tails: SharedTails,
  rounding: MulDivRounding,
): void {
  const flag = rounding === 'mixed' ? 1 : 0; // the rounding flag's word under the operands
  w.label(entry, 4 + flag); // [a, b, d, (up,) ret]
  emitQuotient(w, tails.panicOverflow, { below: 1 + flag, suffix: '' }); // [q, a, b, d, (up,) ret]
  if (rounding === 'mixed') {
    const exit = w.newLabel('muldiv_exit');
    w.op('DUP5');
    w.op('ISZERO');
    w.pushLabel(exit);
    w.op('JUMPI'); // [q, a, b, d, up, ret]   rounding down: q is the result
    emitRoundUp(w, tails.panicOverflow);
    w.label(exit, 6); // [q, a, b, d, up, ret]
    w.op('SWAP4'); // [up, a, b, d, q, ret]
    w.op('POP');
  } else {
    if (rounding === 'up') emitRoundUp(w, tails.panicOverflow);
    w.op('SWAP3'); // [d, a, b, q, ret]
  }
  w.op('POP');
  w.op('POP');
  w.op('POP'); // [q, ret]
  w.op('SWAP1');
  w.op('JUMP', { note: 'muldiv return' }); // [q]   dynamic return jump (checked region)
}

/**
 * `[a, b, d, …] → [q, a, b, d, …]` with `q = ⌊a·b / d⌋` for a nonzero `d`, jumping to
 * `panicOverflow` when it does not fit uint256. `below` is the height under `a, b, d` (its
 * labels are checked against it), `suffix` tells the labels of different copies apart.
 *
 * The product is split into `p1·2^256 + p0` (`p0 = MUL`, `p1` from `MULMOD(a, b, not(0))`
 * minus `p0` with a borrow). When `p1 == 0` the quotient is a single `DIV` (the common case).
 * Otherwise `d > p1` is required (else the quotient is ≥ 2^256), the remainder
 * `MULMOD(a, b, d)` is subtracted so the division becomes exact, the largest power of two
 * dividing `d` is divided out of `d` and of `[p1, p0]` (folding `p1`'s bits into `p0`), and the
 * quotient is `p0` times the inverse of the now odd `d` modulo 2^256 (Newton–Raphson from the
 * seed `3d ^ 2`, correct on 4 bits). The stack comments leave out the `below` words.
 */
function emitQuotient(
  w: AsmWriter,
  panicOverflow: LabelId,
  { below, suffix }: { readonly below: number; readonly suffix: string },
): void {
  const full = w.newLabel(`muldiv_full${suffix}`);
  const done = w.newLabel(`muldiv_done${suffix}`);
  // the 512-bit product [p1, p0]
  w.op('DUP2');
  w.op('DUP2');
  w.op('MUL'); // [p0, a, b, d]
  w.push(0);
  w.op('NOT'); // [~0, p0, a, b, d]
  w.op('DUP4');
  w.op('DUP4');
  w.op('MULMOD'); // [mm = a·b mod (2^256 − 1), p0, a, b, d]
  w.op('DUP2');
  w.op('DUP2');
  w.op('LT'); // [mm < p0, mm, p0, a, b, d]
  w.op('DUP3');
  w.op('DUP3');
  w.op('SUB'); // [mm − p0, borrow, mm, p0, a, b, d]
  w.op('SUB'); // [p1, mm, p0, a, b, d]
  w.op('SWAP1');
  w.op('POP'); // [p1, p0, a, b, d]
  w.op('DUP1');
  w.pushLabel(full);
  w.op('JUMPI'); // [p1, p0, a, b, d]

  // p1 == 0: the product fits one word
  w.op('POP'); // [p0, a, b, d]
  w.op('DUP4');
  w.op('SWAP1');
  w.op('DIV'); // [p0 / d, a, b, d]
  w.pushLabel(done);
  w.op('JUMP');

  w.label(full, below + 5); // [p1, p0, a, b, d, …]
  // d ≤ p1 ⇔ the quotient is ≥ 2^256
  w.op('DUP1');
  w.op('DUP6');
  w.op('GT');
  w.op('ISZERO'); // [d ≤ p1, p1, p0, a, b, d]
  w.pushLabel(panicOverflow);
  w.op('JUMPI'); // [p1, p0, a, b, d]
  // [p1, p0] −= a·b mod d: the division is now exact
  w.op('DUP5');
  w.op('DUP5');
  w.op('DUP5');
  w.op('MULMOD'); // [rem, p1, p0, a, b, d]
  w.op('DUP3');
  w.op('DUP2');
  w.op('GT'); // [rem > p0, rem, p1, p0, a, b, d]
  w.op('DUP3');
  w.op('SUB'); // [p1 − borrow, rem, p1, p0, a, b, d]
  w.op('SWAP2');
  w.op('POP'); // [rem, p1', p0, a, b, d]
  w.op('DUP3');
  w.op('SUB'); // [p0 − rem, p1', p0, a, b, d]
  w.op('SWAP2');
  w.op('POP'); // [p1', p0', a, b, d]
  // twos = d & −d, the largest power of two dividing d; divide it out of d and p0
  w.op('DUP5');
  w.op('DUP1');
  w.push(0);
  w.op('SUB');
  w.op('AND'); // [twos, p1, p0, a, b, d]
  w.op('DUP1');
  w.op('DUP7');
  w.op('DIV'); // [d' = d / twos (odd), twos, p1, p0, a, b, d]
  w.op('DUP2');
  w.op('DUP5');
  w.op('DIV'); // [p0 / twos, d', twos, p1, p0, a, b, d]
  w.op('SWAP4');
  w.op('POP'); // [d', twos, p1, p0 / twos, a, b, d]
  // p0 |= p1 · (2^256 / twos): the bits of p1 shifted down into the quotient word (2^256 / 1
  // wraps to 0, and p1 · 0 contributes nothing — the exact result when twos == 1)
  w.op('SWAP1'); // [twos, d', p1, p0, a, b, d]
  w.op('DUP1');
  w.push(0);
  w.op('SUB');
  w.op('DIV');
  w.push(1);
  w.op('ADD'); // [2^256 / twos, d', p1, p0, a, b, d]
  w.op('DUP3');
  w.op('MUL');
  w.op('DUP4');
  w.op('OR'); // [p0'', d', p1, p0, a, b, d]
  w.op('SWAP3');
  w.op('POP'); // [d', p1, p0'', a, b, d]
  w.op('SWAP1');
  w.op('POP'); // [d', p0'', a, b, d]
  // inv = d'^−1 mod 2^256: seed (3·d') ^ 2, then inv ← inv · (2 − d'·inv)
  w.op('DUP1');
  w.push(3);
  w.op('MUL');
  w.push(2);
  w.op('XOR'); // [inv, d', p0'', a, b, d]
  for (let i = 0; i < NEWTON_STEPS; i++) {
    w.op('DUP1');
    w.op('DUP3');
    w.op('MUL'); // [d'·inv, inv, d', …]
    w.push(2);
    w.op('SUB'); // [2 − d'·inv, inv, d', …]
    w.op('MUL'); // [inv', d', …]
  }
  w.op('SWAP1');
  w.op('POP'); // [inv, p0'', a, b, d]
  w.op('MUL'); // [q, a, b, d]

  w.label(done, below + 4); // [q, a, b, d, …]
}

/**
 * `[q, a, b, d, …] → [q', a, b, d, …]`: rounds the floor up, `q' = q + (a·b mod d != 0)`,
 * jumping to `panicOverflow` when that wraps (the floor can be `2^256 − 1` only on the full
 * path).
 */
function emitRoundUp(w: AsmWriter, panicOverflow: LabelId): void {
  w.op('DUP4');
  w.op('DUP4');
  w.op('DUP4');
  w.op('MULMOD'); // [a·b mod d, q, a, b, d]
  w.op('ISZERO');
  w.op('ISZERO');
  w.op('DUP2');
  w.op('ADD'); // [q', q, a, b, d]
  w.op('SWAP1');
  w.op('DUP2');
  w.op('LT'); // [q' < q, q', a, b, d]
  w.pushLabel(panicOverflow);
  w.op('JUMPI'); // [q', a, b, d]
}
