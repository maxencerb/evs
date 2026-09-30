/**
 * `codegen/lower/pow.ts` — checked exponentiation (issue #10): the folded-base, folded-exponent
 * and square-and-multiply templates.
 */

import type { AsmWriter } from '../../asm/assembler.js';
import type { EvsType } from '../../core/types.js';
import type { Stmt, SiteId } from '../../ir/nodes.js';
import { fmtType } from '../abi.js';
import {
  type LowerCtx,
  numClass,
  meta,
  foldedConst,
  maxUint,
  loadOperand,
  storeOut,
  maxInt,
  STMT_BASELINE,
  type NodeMeta,
  emitMaxCheck,
  MIN_I256,
} from './context.js';

// ---------------------------------------------------------------------------
// pow — checked exponentiation (issue #10)
// ---------------------------------------------------------------------------

/**
 * `a ** e` with solc ≥0.8 checked semantics: the exact power, Panic 0x11 when it leaves the
 * base type's range, `0 ** 0 == 1`. Three templates, all exact (the interpreter's
 * `checkedPow` is the oracle):
 *
 * - **folded base `c`** (solc's literal-base path, generalized to every constant and width):
 *   `c ∈ {0, 1, −1}` never overflow (`ISZERO(e)`, `1`, `EXP(c, e)`); otherwise the powers of
 *   `c` in range are exactly the exponents `0…E` (E precomputed here), so the template is one
 *   `e > E` check and one `EXP` — for `2 ** e` on uint256 that is solc's own `gt(e, 255)`.
 * - **folded exponent `E`**: `a ** E` is in range iff `|a|` is at most the integer E-th root
 *   of the bound (precomputed per sign), so again one range check and one `EXP`.
 * - **runtime base and exponent**: solc's square-and-multiply loop (`checked_exp_helper`) on
 *   the magnitude, against the bound `L` (the type max; for a negative result `2^(N−1)`), with
 *   a branch-free `EXP` fast path for `|a| < 2` or `e == 0` and an early Panic for `e > 255`
 *   (`|a| ≥ 2` there, so the power is ≥ 2^256). At most 7 loop iterations; each checks
 *   `b > L / b` before squaring, which is exact because the final result is ≥ every squared
 *   base, and the multiply into the running power needs no check (it stays ≤ b²). A signed
 *   base is split into sign and magnitude up front (`SAR` mask) and the sign re-applied at
 *   the end, so solc's separate first-iteration handling of a negative base is not needed.
 */
export function lowerPow(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const { bits, signed } = numClass(type);
  const m = meta(`checked pow ${fmtType(type)}`);
  const cBase = foldedConst(ctx, s.a);
  if (cBase !== undefined) {
    lowerPowConstBase(w, s, ctx, signed ? toSignedWord(cBase) : cBase, bits, signed, m);
    return;
  }
  const cExp = foldedConst(ctx, s.b);
  if (cExp !== undefined) {
    lowerPowConstExp(w, s, ctx, cExp, bits, signed, m);
    return;
  }
  if (!signed) {
    w.push(maxUint(bits), m); // [L = max]
    loadOperand(w, ctx, s.a); // [a, L]
    loadOperand(w, ctx, s.b); // [e, a, L]
    emitPowCore(w, ctx, s.site, 0); // [P]
    storeOut(w, ctx, s.out);
    return;
  }
  // signed: sign mask, result sign `rn = neg(a) ∧ odd(e)`, magnitude, bound maxInt + rn
  loadOperand(w, ctx, s.b, m); // [e]
  loadOperand(w, ctx, s.a); // [a, e]
  w.push(255);
  w.op('SAR'); // [mask, e]        all ones iff a < 0
  w.op('DUP2'); // [e, mask, e]
  w.op('DUP2'); // [mask, e, mask, e]
  w.op('AND');
  w.push(1);
  w.op('AND'); // [rn, mask, e]
  w.op('SWAP2'); // [e, mask, rn]
  loadOperand(w, ctx, s.a); // [a, e, mask, rn]
  w.op('DUP3'); // [mask, a, e, mask, rn]
  w.op('XOR'); // [a ^ mask, e, mask, rn]
  w.op('DUP3'); // [mask, a ^ mask, e, mask, rn]
  w.op('SWAP1'); // [a ^ mask, mask, e, mask, rn]
  w.op('SUB'); // [|a|, e, mask, rn]  (−2^255 → 2^255 as an unsigned word)
  w.op('SWAP2'); // [mask, e, |a|, rn]
  w.op('POP'); // [e, |a|, rn]
  w.op('DUP3'); // [rn, e, |a|, rn]
  w.push(maxInt(bits), { note: `max ${fmtType(type)}` });
  w.op('ADD'); // [L, e, |a|, rn]
  w.op('SWAP2'); // [|a|, e, L, rn]
  w.op('SWAP1'); // [e, |a|, L, rn]
  emitPowCore(w, ctx, s.site, 1); // [P, rn]
  // re-apply the sign: (P ^ −rn) + rn
  w.op('DUP2'); // [rn, P, rn]
  w.push(0);
  w.op('SUB'); // [−rn, P, rn]
  w.op('XOR'); // [P ^ −rn, rn]
  w.op('ADD'); // [r]
  storeOut(w, ctx, s.out);
}

/**
 * `[e, x, L, …(below)] → [x ** e, …]` or Panic 0x11 when `x ** e > L` (all unsigned; `below`
 * words sit under the three operands — labels are annotated at `STMT_BASELINE + below + k`).
 */
function emitPowCore(w: AsmWriter, ctx: LowerCtx, site: SiteId, below: number): void {
  const base = STMT_BASELINE + below;
  const fast = w.newLabel(`pow_fast_${site}`);
  const head = w.newLabel(`pow_loop_${site}`);
  const tail = w.newLabel(`pow_tail_${site}`);
  const done = w.newLabel(`pow_done_${site}`);
  // x < 2 or e == 0 ⇒ x ** e ∈ {0, 1}: a plain EXP, never out of range
  w.push(2); // [2, e, x, L]
  w.op('DUP3'); // [x, 2, e, x, L]
  w.op('LT'); // [x < 2, e, x, L]
  w.op('DUP2'); // [e, x < 2, e, x, L]
  w.op('ISZERO'); // [e == 0, x < 2, e, x, L]
  w.op('OR');
  w.pushLabel(fast);
  w.op('JUMPI'); // [e, x, L]
  // x ≥ 2 ⇒ x ** e ≥ 2^256 once e > 255
  w.op('DUP1'); // [e, e, x, L]
  w.push(255); // [255, e, e, x, L]
  w.op('LT'); // [255 < e, e, x, L]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [e, x, L]
  w.push(1); // [1, e, x, L]
  w.op('SWAP2'); // [x, e, 1, L]
  w.op('SWAP1'); // [e, b = x, p = 1, L]
  w.label(head, base + 4); // [e, b, p, L]
  w.push(1);
  w.op('DUP2'); // [e, 1, e, b, p, L]
  w.op('GT'); // [e > 1, e, b, p, L]
  w.op('ISZERO');
  w.pushLabel(tail);
  w.op('JUMPI'); // [e, b, p, L]
  // b² > L ⇔ b > L / b — the result is ≥ b² from here on
  w.op('DUP2'); // [b, e, b, p, L]
  w.op('DUP5'); // [L, b, e, b, p, L]
  w.op('DIV'); // [L / b, e, b, p, L]
  w.op('DUP3'); // [b, L / b, e, b, p, L]
  w.op('GT'); // [b > L / b, e, b, p, L]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [e, b, p, L]
  // p ← p · (1 + (b − 1)·(e & 1)) — branch-free "if odd, multiply"; p < b ⇒ p·b < b² ≤ L
  w.push(1);
  w.op('DUP2');
  w.op('AND'); // [e & 1, e, b, p, L]
  w.push(1);
  w.op('DUP4'); // [b, 1, e & 1, e, b, p, L]
  w.op('SUB'); // [b − 1, e & 1, e, b, p, L]
  w.op('MUL');
  w.push(1);
  w.op('ADD'); // [f, e, b, p, L]
  w.op('DUP4'); // [p, f, e, b, p, L]
  w.op('MUL'); // [p·f, e, b, p, L]
  w.op('SWAP3'); // [p, e, b, p·f, L]
  w.op('POP'); // [e, b, p', L]
  w.op('SWAP1'); // [b, e, p', L]
  w.op('DUP1');
  w.op('MUL'); // [b², e, p', L]
  w.op('SWAP1'); // [e, b², p', L]
  w.push(1);
  w.op('SHR'); // [e >> 1, b², p', L]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(tail, base + 4); // [e == 1, b, p, L]
  w.op('POP'); // [b, p, L]
  w.op('DUP1'); // [b, b, p, L]
  w.op('DUP4'); // [L, b, b, p, L]
  w.op('DIV'); // [L / b, b, p, L]
  w.op('DUP3'); // [p, L / b, b, p, L]
  w.op('GT'); // [p > L / b, b, p, L]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [b, p, L]
  w.op('MUL'); // [p·b, L]
  w.pushLabel(done);
  w.op('JUMP');
  w.label(fast, base + 3); // [e, x, L]
  w.op('SWAP1'); // [x, e, L]
  w.op('EXP'); // [x ** e, L]
  w.label(done, base + 2); // [P, L]
  w.op('SWAP1');
  w.op('POP'); // [P]
}

/** `c ** e` for a folded base `c` (logical value): at most one bound check and one EXP. */
function lowerPowConstBase(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  c: bigint,
  bits: number,
  signed: boolean,
  m: NodeMeta,
): void {
  if (c === 1n) {
    w.push(1, m); // 1 ** e == 1
    storeOut(w, ctx, s.out);
    return;
  }
  loadOperand(w, ctx, s.b, m); // [e]
  if (c === 0n) {
    w.op('ISZERO'); // 0 ** 0 == 1, 0 ** e == 0
    storeOut(w, ctx, s.out);
    return;
  }
  if (c !== -1n) {
    // the in-range exponents of c are exactly 0…maxE (|c| ≥ 2: |c|^e grows strictly)
    const [min, max] = signed ? [-(1n << BigInt(bits - 1)), maxInt(bits)] : [0n, maxUint(bits)];
    let maxE = 0n;
    for (let p = c; p >= min && p <= max; p *= c) maxE += 1n;
    w.op('DUP1'); // [e, e]
    w.push(maxE, { note: `max exponent of ${c}` }); // [maxE, e, e]
    w.op('LT'); // [maxE < e, e]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [e]
  } // −1 ** e == ±1: never out of range
  w.push(c < 0n ? c + (1n << 256n) : c); // [c, e]
  w.op('EXP'); // [c ** e] — mod 2^256 two's complement == the canonical in-range word
  storeOut(w, ctx, s.out);
}

/** `a ** E` for a folded exponent `E`: a bound check on the base, then one EXP. */
function lowerPowConstExp(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  e: bigint,
  bits: number,
  signed: boolean,
  m: NodeMeta,
): void {
  if (e === 0n) {
    w.push(1, m); // a ** 0 == 1 (0 ** 0 included)
    storeOut(w, ctx, s.out);
    return;
  }
  loadOperand(w, ctx, s.a, m); // [a]
  if (e === 1n) {
    storeOut(w, ctx, s.out); // a ** 1 == a
    return;
  }
  if (!signed) {
    // a ** E ≤ max ⇔ a ≤ ⌊max^(1/E)⌋
    emitMaxCheck(w, ctx, integerRoot(maxUint(bits), e), `max base for ** ${e}`);
  } else {
    // positive results (a ≥ 0, or E even) are bounded by maxInt, negative ones by 2^(N−1)
    const hi = integerRoot(maxInt(bits), e);
    const lo = e % 2n === 0n ? hi : integerRoot(1n << BigInt(bits - 1), e);
    w.op('DUP1'); // [a, a]
    w.push(hi, { note: `max base for ** ${e}` }); // [hi, a, a]
    w.op('SLT'); // [hi < a, a]
    w.op('DUP2'); // [a, hi < a, a]
    w.push((1n << 256n) - lo, { note: `min base for ** ${e}` }); // [−lo, a, hi < a, a]
    w.op('SGT'); // [−lo > a, hi < a, a]
    w.op('OR');
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [a]
  }
  w.push(e); // [E, a]
  w.op('SWAP1'); // [a, E]
  w.op('EXP'); // [a ** E]
  storeOut(w, ctx, s.out);
}

/**
 * ⌊n^(1/k)⌋ for n ≥ 0, k ≥ 1 (binary search; n < 2^256). For k ≥ 256 the root is 0 or 1
 * (2^k > n), answered directly: probing `2n ** k` would build a k-bit host bigint, which V8
 * refuses past ~2^30 bits (a folded exponent may be any word up to 2^256 − 1).
 */
function integerRoot(n: bigint, k: bigint): bigint {
  if (k >= 256n) return n >= 1n ? 1n : 0n;
  let lo = 0n;
  let hi = 1n << (256n / k + 1n);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid ** k <= n) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** A sign-extended 256-bit word → its logical (signed) value. */
function toSignedWord(word: bigint): bigint {
  return word >= MIN_I256 ? word - (1n << 256n) : word;
}
