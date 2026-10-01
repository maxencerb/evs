/**
 * `codegen/lower/arith.ts` — the `bin` templates (checked arithmetic with solc ≥0.8 semantics,
 * wrapping arithmetic, comparisons, logic, bits, shifts) and `addmod` / `mulmod` (`mulDiv` lives
 * in `muldiv.ts`).
 */

import type { AsmWriter } from '../../asm/assembler.js';
import { isSigned, type EvsType } from '../../core/types.js';
import type { Stmt, ValueId } from '../../ir/nodes.js';
import { fmtType, wordNeedsNormalize, emitNormalizeWord } from '../abi.js';
import {
  type LowerCtx,
  type NodeMeta,
  typeOf,
  loadOperand,
  justStored,
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
import { lowerMulDiv } from './muldiv.js';
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
    case 'wrapadd':
    case 'wrapsub':
    case 'wrapmul': {
      // solc `unchecked`: the bare opcode wraps modulo 2^256; a narrower width keeps its low N
      // bits (mask / SIGNEXTEND), which is the true result modulo 2^N for canonical operands
      const wt = asWordType(type);
      loadOperand(w, ctx, s.b, meta(`wrapping ${s.op.slice(4)} ${fmtType(type)}`));
      loadOperand(w, ctx, s.a); // [a, b]
      w.op(s.op === 'wrapadd' ? 'ADD' : s.op === 'wrapsub' ? 'SUB' : 'MUL'); // [r mod 2^256]
      if (wordNeedsNormalize(wt)) emitNormalizeWord(w, wt);
      storeOut(w, ctx, s.out);
      return;
    }
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const signed = isSigned(type);
      // [a, b] → LT computes a < b; swapped [b, a] → GT computes b > a, the same predicate
      const swapped = loadBinOperands(w, ctx, s, meta(`${s.op} ${fmtType(type)}`), true);
      const less = (s.op === 'lt' || s.op === 'gte') !== swapped;
      if (less) w.op(signed ? 'SLT' : 'LT');
      else w.op(signed ? 'SGT' : 'GT');
      if (s.op === 'lte' || s.op === 'gte') w.op('ISZERO');
      storeOut(w, ctx, s.out);
      return;
    }
    case 'eq':
    case 'neq':
      loadBinOperands(w, ctx, s, meta(`${s.op} ${fmtType(type)}`), true);
      w.op('EQ');
      if (s.op === 'neq') w.op('ISZERO');
      storeOut(w, ctx, s.out);
      return;
    case 'and':
    case 'or':
      // eager bool logic on canonical 0/1 words
      loadBinOperands(w, ctx, s, meta(`bool ${s.op}`), true);
      w.op(s.op === 'and' ? 'AND' : 'OR');
      storeOut(w, ctx, s.out);
      return;
    case 'bitand':
    case 'bitor':
    case 'bitxor':
      // canonical-preserving on canonical operands (no post-masking needed)
      loadBinOperands(w, ctx, s, meta(`${s.op} ${fmtType(type)}`), true);
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

/**
 * Loads a binary statement's operands. Templates load the right operand first, so the left one
 * ends on top (`[a, b]`) and `SUB` / `DIV` / `LT` compute `op(a, b)` directly. When the
 * template accepts both orders (`swappable`) and `a` was stored by the statement just before
 * ({@link justStored}), `a` goes first instead (`[b, a]`): its load then directly follows its
 * store, which the optimizer's store-then-reload rewrite fuses into a `DUP1`. Method chains
 * (`x.add(y).mul(z)`) feed the previous result in as the LEFT operand, so without the swap
 * that pair is never adjacent. Returns whether the operands sit swapped.
 */
function loadBinOperands(
  w: AsmWriter,
  ctx: LowerCtx,
  s: { a: ValueId; b: ValueId },
  m: NodeMeta,
  swappable: boolean,
): boolean {
  const swapped = swappable && justStored(w, ctx, s.a);
  loadOperand(w, ctx, swapped ? s.a : s.b, m);
  loadOperand(w, ctx, swapped ? s.b : s.a);
  return swapped;
}

/**
 * The constant template {@link lowerCheckedArith} picks for a checked add / sub / mul with a
 * folded operand (the right one, or the left one of the commutative add / mul), or `undefined`
 * when it takes the general width-dependent template, which always checks.
 */
interface ConstArithTemplate {
  readonly template: 'unsigned-mul' | 'int256-add-sub';
  readonly constant: bigint; // the folded operand's word
  readonly other: ValueId; // the runtime operand
  readonly overflowCheck: boolean; // false: x · 0, x · 1 and x ± 0 cannot overflow
}

function constArithTemplate(
  ctx: LowerCtx,
  s: Extract<Stmt, { k: 'bin' }>,
  type: EvsType,
): ConstArithTemplate | undefined {
  const { bits, signed } = numClass(type);
  const right = foldedConst(ctx, s.b);
  const left = s.op === 'sub' || right !== undefined ? undefined : foldedConst(ctx, s.a);
  const constant = right ?? left;
  if (constant === undefined) return undefined;
  const other = right !== undefined ? s.a : s.b;
  if (s.op === 'mul' && !signed) {
    return { template: 'unsigned-mul', constant, other, overflowCheck: constant > 1n };
  }
  if ((s.op === 'add' || s.op === 'sub') && signed && bits === 256) {
    return { template: 'int256-add-sub', constant, other, overflowCheck: constant !== 0n };
  }
  return undefined;
}

/**
 * Whether a checked add / sub / mul can raise Panic 0x11: the same decision
 * {@link lowerCheckedArith} makes when it picks its template, so the site table
 * (`codegen/sites.ts`) claims the code exactly when the emitted code checks.
 */
export function checkedArithCanOverflow(
  ctx: LowerCtx,
  s: Extract<Stmt, { k: 'bin' }>,
  type: EvsType,
): boolean {
  return constArithTemplate(ctx, s, type)?.overflowCheck ?? true;
}

/**
 * add / sub / mul — the width-dependent checked templates. A folded constant operand selects a
 * cheaper exact template (unsigned mul, int256 add / sub; see {@link constArithTemplate});
 * otherwise the operands are loaded as `[a, b]`, or `[b, a]` for add / mul (see
 * {@link loadBinOperands}). Every add / mul template below is symmetric in its two operands, so
 * the swap never changes a result or a panic.
 */
function lowerCheckedArith(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const { bits, signed } = numClass(type);
  const m = meta(`checked ${s.op} ${fmtType(type)}`);

  const constant = constArithTemplate(ctx, s, type);
  if (constant?.template === 'unsigned-mul') {
    lowerUnsignedMulByConst(w, ctx, s.out, constant, bits, m);
    return;
  }
  if (constant?.template === 'int256-add-sub') {
    lowerInt256AddSubConst(w, ctx, s.op === 'sub' ? 'sub' : 'add', s.out, constant, m);
    return;
  }

  loadBinOperands(w, ctx, s, m, s.op !== 'sub'); // [a, b] (add / mul: maybe [b, a])

  if (s.op === 'add' && !signed) {
    if (bits === 256) {
      // uint256: overflow ⇔ r < b (⇔ r < a: the swapped order checks that one)
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

/**
 * Unsigned `x · c` for a folded constant `c`: the product exceeds `max(bits)` exactly when
 * `x > ⌊max / c⌋`, so one comparison replaces the div-back (or the post-MUL range check). A `c`
 * of 0 or 1 cannot overflow and needs no check (`overflowCheck` is false).
 */
function lowerUnsignedMulByConst(
  w: AsmWriter,
  ctx: LowerCtx,
  out: ValueId,
  { constant: c, other: x, overflowCheck }: ConstArithTemplate,
  bits: number,
  m: NodeMeta,
): void {
  loadOperand(w, ctx, x, m); // [x]
  if (overflowCheck) {
    w.op('DUP1'); // [x, x]
    pushMulBound(w, maxUint(bits), c, bits); // [⌊max/c⌋, x, x]
    w.op('LT'); // [⌊max/c⌋ < x, x]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [x]
  }
  w.push(c); // [c, x]
  w.op('MUL'); // [r] — ≤ max(bits) ⇒ canonical
  storeOut(w, ctx, out);
}

/**
 * Pushes `⌊max / c⌋`. For 256 bits the bound of a small `c` needs a wide immediate (a 32-byte
 * PUSH for `c` < 256), so it is computed as `PUSH c PUSH0 NOT DIV` whenever that is shorter. The
 * peephole leaves it alone: folding `PUSH0 NOT` would grow the code, which its size guard refuses.
 */
function pushMulBound(w: AsmWriter, max: bigint, c: bigint, bits: number): void {
  const bound = max / c;
  if (bits === 256 && immediateBytes(bound) > immediateBytes(c) + 3) {
    w.push(c, { note: 'max uint256 / c' }); // [c]
    w.push(0);
    w.op('NOT'); // [max, c]
    w.op('DIV'); // [⌊max/c⌋]
    return;
  }
  w.push(bound, { note: `max uint${bits} / c` });
}

/** Immediate bytes of a `PUSHn` (`PUSH0` has none). */
function immediateBytes(v: bigint): number {
  return v === 0n ? 0 : Math.ceil(v.toString(16).length / 2);
}

/**
 * int256 `x + k` / `x − k` for a folded constant `k` (a sign-extended word). Its sign is known,
 * so only one of the two sign cases of {@link emitSignedAddSubCheck} can occur: moving `x` up by
 * a positive magnitude overflows exactly when the result lands below `x`, moving it down exactly
 * when it lands above. A negative `k` is applied as its magnitude with the opposite opcode
 * (`x + (−1)` is `x − 1`, a 1-byte immediate instead of a 32-byte one): the result word is the
 * same modulo 2^256. `k` = 0 cannot overflow (`overflowCheck` is false).
 */
function lowerInt256AddSubConst(
  w: AsmWriter,
  ctx: LowerCtx,
  op: 'add' | 'sub',
  out: ValueId,
  { constant: k, other: x, overflowCheck }: ConstArithTemplate,
  m: NodeMeta,
): void {
  loadOperand(w, ctx, x, m); // [x]
  if (!overflowCheck) {
    storeOut(w, ctx, out); // x ± 0 = x
    return;
  }
  const negative = k >= MIN_I256;
  const up = (op === 'add') !== negative; // the result moves x towards +∞
  const magnitude = negative ? (1n << 256n) - k : k; // |k| (2^255 for min int256: same word)
  w.push(magnitude); // [|k|, x]
  w.op('DUP2'); // [x, |k|, x]
  w.op(up ? 'ADD' : 'SUB'); // [r, x]
  w.op('DUP1'); // [r, r, x]
  w.op('SWAP2'); // [x, r, r]
  w.op(up ? 'SGT' : 'SLT'); // [up ? r < x : r > x, r]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r]
  storeOut(w, ctx, out);
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
  if (s.op === 'muldiv' || s.op === 'muldivup') {
    lowerMulDiv(w, s, ctx);
    return;
  }
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
