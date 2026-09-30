/**
 * `codegen/lower/arith.ts` — the `bin` templates (checked arithmetic with solc ≥0.8 semantics,
 * comparisons, logic, bits, shifts) and `addmod` / `mulmod`.
 */

import type { AsmWriter } from '../../asm/assembler.js';
import { isSigned, type EvsType } from '../../core/types.js';
import type { Stmt } from '../../ir/nodes.js';
import { fmtType, wordNeedsNormalize, emitNormalizeWord } from '../abi.js';
import {
  type LowerCtx,
  typeOf,
  loadOperand,
  meta,
  storeOut,
  internal,
  numClass,
  emitMaxCheck,
  maxUint,
  emitFixpointCheck,
  MIN_I256,
  foldedConst,
  MINUS_ONE_WORD,
  asWordType,
} from './context.js';
import { lowerPow } from './pow.js';

// ---------------------------------------------------------------------------
// bin — checked arithmetic (solc ≥0.8 semantics), comparisons, logic, bits
// ---------------------------------------------------------------------------

export function lowerBin(w: AsmWriter, s: Extract<Stmt, { k: 'bin' }>, ctx: LowerCtx): void {
  const type = typeOf(ctx, s.a);
  switch (s.op) {
    case 'add':
    case 'sub':
    case 'mul':
      lowerCheckedArith(w, s, ctx, type);
      return;
    case 'div':
    case 'mod':
      lowerDivMod(w, s, ctx, type);
      return;
    case 'pow':
      lowerPow(w, s, ctx, type);
      return;
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const signed = isSigned(type);
      loadOperand(w, ctx, s.b, meta(`${s.op} ${fmtType(type)}`));
      loadOperand(w, ctx, s.a); // [a, b]
      if (s.op === 'lt' || s.op === 'gte') w.op(signed ? 'SLT' : 'LT');
      else w.op(signed ? 'SGT' : 'GT');
      if (s.op === 'lte' || s.op === 'gte') w.op('ISZERO');
      storeOut(w, ctx, s.out);
      return;
    }
    case 'eq':
    case 'neq':
      loadOperand(w, ctx, s.b, meta(`${s.op} ${fmtType(type)}`));
      loadOperand(w, ctx, s.a);
      w.op('EQ');
      if (s.op === 'neq') w.op('ISZERO');
      storeOut(w, ctx, s.out);
      return;
    case 'and':
    case 'or':
      // eager bool logic on canonical 0/1 words
      loadOperand(w, ctx, s.b, meta(`bool ${s.op}`));
      loadOperand(w, ctx, s.a);
      w.op(s.op === 'and' ? 'AND' : 'OR');
      storeOut(w, ctx, s.out);
      return;
    case 'bitand':
    case 'bitor':
    case 'bitxor':
      // canonical-preserving on canonical operands (no post-masking needed)
      loadOperand(w, ctx, s.b, meta(`${s.op} ${fmtType(type)}`));
      loadOperand(w, ctx, s.a);
      w.op(s.op === 'bitand' ? 'AND' : s.op === 'bitor' ? 'OR' : 'XOR');
      storeOut(w, ctx, s.out);
      return;
    case 'shl':
    case 'shr':
      lowerShift(w, s, ctx, type);
      return;
    default: {
      const op = String((s as { op: unknown }).op);
      throw internal(`unknown bin op '${op}' survived validateIr`);
    }
  }
}

/** add / sub / mul — the width-dependent checked templates. */
function lowerCheckedArith(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const { bits, signed } = numClass(type);
  const m = meta(`checked ${s.op} ${fmtType(type)}`);
  loadOperand(w, ctx, s.b, m); // [b]
  loadOperand(w, ctx, s.a); // [a, b]

  if (s.op === 'add' && !signed) {
    if (bits === 256) {
      // uint256: overflow ⇔ r < b
      w.op('DUP2'); // [b, a, b]
      w.op('ADD'); // [r, b]
      w.op('DUP1'); // [r, r, b]
      w.op('SWAP2'); // [b, r, r]
      w.op('GT'); // [b > r, r]
      w.pushLabel(ctx.tails.panicOverflow);
      w.op('JUMPI'); // [r]
      storeOut(w, ctx, s.out); // []
      return;
    }
    // canonical operands ⇒ true sum < 2^257 never wraps: range check alone
    w.op('ADD'); // [r]
    emitMaxCheck(w, ctx, maxUint(bits), `max ${fmtType(type)}`);
    storeOut(w, ctx, s.out);
    return;
  }

  if (s.op === 'sub' && !signed) {
    // underflow ⇔ a < b, checked BEFORE the SUB (result stays canonical)
    w.op('DUP2'); // [b, a, b]
    w.op('DUP2'); // [a, b, a, b]
    w.op('LT'); // [a < b, a, b]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [a, b]
    w.op('SUB'); // [r]
    storeOut(w, ctx, s.out);
    return;
  }

  if (s.op === 'mul' && !signed) {
    if (bits <= 128) {
      // true product < 2^256 for canonical operands ⇒ range check alone is sound
      w.op('MUL'); // [r]
      emitMaxCheck(w, ctx, maxUint(bits), `max ${fmtType(type)}`);
      storeOut(w, ctx, s.out);
      return;
    }
    // 256-bit product can wrap (N > 128) ⇒ div-back; sub-word widths ALSO range-check
    w.op('DUP2'); // [b, a, b]
    w.op('DUP2'); // [a, b, a, b]
    w.op('MUL'); // [r, a, b]
    emitUnsignedDivBack(w, ctx); // [r, a, b] (or Panic 0x11)
    if (bits < 256) emitMaxCheck(w, ctx, maxUint(bits), `max ${fmtType(type)}`);
    storeOut(w, ctx, s.out); // [a, b]
    w.op('POP');
    w.op('POP');
    return;
  }

  // ---- signed templates -------------------------------------------------------------
  if ((s.op === 'add' || s.op === 'sub') && bits < 256) {
    // canonical operands ⇒ true result representable in 256 bits: fixpoint check alone
    w.op(s.op === 'sub' ? 'SUB' : 'ADD'); // [r]
    emitFixpointCheck(w, ctx, bits);
    storeOut(w, ctx, s.out);
    return;
  }

  if (s.op === 'add' || s.op === 'sub') {
    // int256: solc sign-case formula
    w.op('DUP2'); // [b, a, b]
    w.op('DUP2'); // [a, b, a, b]
    w.op(s.op === 'add' ? 'ADD' : 'SUB'); // [r, a, b]
    emitSignedAddSubCheck(w, ctx, s.op); // [r, a, b] (or Panic 0x11)
    storeOut(w, ctx, s.out); // [a, b]
    w.op('POP');
    w.op('POP');
    return;
  }

  // signed mul
  if (bits <= 128) {
    // |product| ≤ 2^254 ⇒ no signed 256-bit wrap ⇒ fixpoint check alone
    w.op('MUL'); // [r]
    emitFixpointCheck(w, ctx, bits);
    storeOut(w, ctx, s.out);
    return;
  }
  w.op('DUP2'); // [b, a, b]
  w.op('DUP2'); // [a, b, a, b]
  w.op('MUL'); // [r, a, b]
  emitSignedMulCheck(w, ctx); // [r, a, b] (or Panic 0x11)
  if (bits < 256) emitFixpointCheck(w, ctx, bits); // 128 < N < 256: int256 check THEN fixpoint
  storeOut(w, ctx, s.out); // [a, b]
  w.op('POP');
  w.op('POP');
}

/** `[r, a, b] → [r, a, b]` or Panic 0x11: `iszero(or(iszero(a), eq(div(r, a), b)))`. */
function emitUnsignedDivBack(w: AsmWriter, ctx: LowerCtx): void {
  w.op('DUP1'); // [r, r, a, b]
  w.op('DUP3'); // [a, r, r, a, b]
  w.op('SWAP1'); // [r, a, r, a, b]
  w.op('DIV'); // [r/a, r, a, b]    (div-by-zero yields 0 — guarded by iszero(a) below)
  w.op('DUP4'); // [b, r/a, r, a, b]
  w.op('EQ'); // [r/a == b, r, a, b]
  w.op('DUP3'); // [a, eq, r, a, b]
  w.op('ISZERO'); // [a == 0, eq, r, a, b]
  w.op('OR'); // [ok, r, a, b]
  w.op('ISZERO'); // [overflow, r, a, b]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, a, b]
}

/**
 * `[r, a, b] → [r, a, b]` or Panic 0x11 — int256 add/sub sign-case formulas:
 *   add: or(and(iszero(slt(b,0)), slt(r,a)), and(slt(b,0), sgt(r,a)))
 *   sub: or(and(iszero(slt(b,0)), sgt(r,a)), and(slt(b,0), slt(r,a)))
 */
function emitSignedAddSubCheck(w: AsmWriter, ctx: LowerCtx, op: 'add' | 'sub'): void {
  w.push(0); // [0, r, a, b]
  w.op('DUP4'); // [b, 0, r, a, b]
  w.op('SLT'); // [s = b<0, r, a, b]
  w.op('DUP1'); // [s, s, r, a, b]
  w.op('ISZERO'); // [!s, s, r, a, b]
  w.op('DUP4'); // [a, !s, s, r, a, b]
  w.op('DUP4'); // [r, a, !s, s, r, a, b]
  w.op(op === 'add' ? 'SLT' : 'SGT'); // [c1, !s, s, r, a, b]
  w.op('AND'); // [p1, s, r, a, b]
  w.op('SWAP1'); // [s, p1, r, a, b]
  w.op('DUP4'); // [a, s, p1, r, a, b]
  w.op('DUP4'); // [r, a, s, p1, r, a, b]
  w.op(op === 'add' ? 'SGT' : 'SLT'); // [c2, s, p1, r, a, b]
  w.op('AND'); // [p2, p1, r, a, b]
  w.op('OR'); // [overflow, r, a, b]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, a, b]
}

/**
 * `[r, a, b] → [r, a, b]` or Panic 0x11 — int256 mul: the sdiv-back test plus the lone
 * case it misses (`a == −1, b == −2^255`):
 *   or(and(eq(a, not(0)), eq(b, shl(255, 1))), and(iszero(iszero(a)), iszero(eq(sdiv(r, a), b))))
 */
function emitSignedMulCheck(w: AsmWriter, ctx: LowerCtx): void {
  w.op('DUP1'); // [r, r, a, b]
  w.op('DUP3'); // [a, r, r, a, b]
  w.op('SWAP1'); // [r, a, r, a, b]
  w.op('SDIV'); // [r sdiv a, r, a, b]
  w.op('DUP4'); // [b, q, r, a, b]
  w.op('EQ'); // [q == b, r, a, b]
  w.op('ISZERO'); // [neq, r, a, b]
  w.op('DUP3'); // [a, neq, r, a, b]
  w.op('ISZERO');
  w.op('ISZERO'); // [a != 0, neq, r, a, b]
  w.op('AND'); // [p2, r, a, b]
  w.op('DUP3'); // [a, p2, r, a, b]
  w.push(0);
  w.op('NOT'); // [not(0), a, p2, r, a, b]
  w.op('EQ'); // [a == −1, p2, r, a, b]
  w.op('DUP5'); // [b, a == −1, p2, r, a, b]
  w.push(MIN_I256, { note: 'min int256' }); // [min, b, …]
  w.op('EQ'); // [b == min, a == −1, p2, r, a, b]
  w.op('AND'); // [p1, p2, r, a, b]
  w.op('OR'); // [overflow, r, a, b]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, a, b]
}

/**
 * div / mod — zero check first (Panic 0x12), then the width templates. A folded nonzero
 * divisor drops the zero check, and a folded divisor other than −1 (all-ones word; signed
 * consts are sign-extended) drops signed div's minN / −1 overflow check: with |b| ≥ 2 or
 * b == 1 the quotient's magnitude never exceeds the dividend's, so neither panic can fire.
 */
function lowerDivMod(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const { bits, signed } = numClass(type);
  const divisor = foldedConst(ctx, s.b);
  loadOperand(w, ctx, s.b, meta(`checked ${s.op} ${fmtType(type)}`)); // [b]
  if (divisor === undefined || divisor === 0n) {
    w.op('DUP1');
    w.op('ISZERO'); // [b == 0, b]
    w.pushLabel(ctx.tails.panicDivZero);
    w.op('JUMPI'); // [b]
  }
  loadOperand(w, ctx, s.a); // [a, b]
  if (!signed) {
    w.op(s.op === 'div' ? 'DIV' : 'MOD'); // [r] — result ≤ a ⇒ canonical
    storeOut(w, ctx, s.out);
    return;
  }
  if (s.op === 'mod') {
    w.op('SMOD'); // [r] — |r| < |b| ⇒ always canonical
    storeOut(w, ctx, s.out);
    return;
  }
  if (divisor !== undefined && divisor !== MINUS_ONE_WORD) {
    w.op('SDIV'); // [r] — b ∉ {0, −1} ⇒ |r| ≤ |a| ⇒ in range, canonical
    storeOut(w, ctx, s.out);
    return;
  }
  if (bits === 256) {
    // EVM SDIV silently wraps −2^255 / −1 — explicit Panic 0x11
    w.op('DUP1'); // [a, a, b]
    w.push(MIN_I256, { note: 'min int256' });
    w.op('EQ'); // [a == min, a, b]
    w.op('DUP3'); // [b, a == min, a, b]
    w.push(0);
    w.op('NOT'); // [not(0), b, …]
    w.op('EQ'); // [b == −1, a == min, a, b]
    w.op('AND'); // [overflow, a, b]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [a, b]
    w.op('SDIV'); // [r]
    storeOut(w, ctx, s.out);
    return;
  }
  w.op('SDIV'); // [r]
  emitFixpointCheck(w, ctx, bits); // catches minN / −1 uniformly
  storeOut(w, ctx, s.out);
}

// ---------------------------------------------------------------------------
// addmod / mulmod (issue #10)
// ---------------------------------------------------------------------------

/**
 * `(a + b) % n` / `(a · b) % n` at full precision (ADDMOD / MULMOD never wrap the intermediate),
 * Panic 0x12 on a zero modulus like solc ≥0.8 — the check is dropped for a folded nonzero
 * modulus, exactly like `lowerDivMod`'s constant-divisor elision. The result is < n ≤ 2^256 − 1,
 * canonical by construction.
 */
export function lowerModArith(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'modarith' }>,
  ctx: LowerCtx,
): void {
  const modulus = foldedConst(ctx, s.n);
  loadOperand(w, ctx, s.n, meta(`${s.op} uint256`)); // [n]
  if (modulus === undefined || modulus === 0n) {
    w.op('DUP1');
    w.op('ISZERO'); // [n == 0, n]
    w.pushLabel(ctx.tails.panicDivZero);
    w.op('JUMPI'); // [n]
  }
  loadOperand(w, ctx, s.b); // [b, n]
  loadOperand(w, ctx, s.a); // [a, b, n]
  w.op(s.op === 'addmod' ? 'ADDMOD' : 'MULMOD'); // [r]
  storeOut(w, ctx, s.out);
}

/** shl / shr — Solidity shifts are unchecked; results re-canonicalized to the width. */
function lowerShift(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const wt = asWordType(type);
  const signed = isSigned(type);
  loadOperand(w, ctx, s.a, meta(`${s.op} ${fmtType(type)}`)); // [value]
  loadOperand(w, ctx, s.b); // [shift, value]
  if (s.op === 'shl') {
    w.op('SHL'); // [value << shift]
    // mask (uintN/bytesN) / sign-extend (intN) back to the width
    if (wordNeedsNormalize(wt)) emitNormalizeWord(w, wt);
  } else if (signed) {
    w.op('SAR'); // canonical-preserving on sign-extended operands
  } else {
    w.op('SHR');
    // left-aligned bytesN: SHR moves bits out of the lane — re-mask. uintN stays canonical.
    if (wt.startsWith('bytes') && wordNeedsNormalize(wt)) {
      emitNormalizeWord(w, wt);
    }
  }
  storeOut(w, ctx, s.out);
}
