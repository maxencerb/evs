/**
 * `codegen/lower/values.ts` — the word-valued statement templates: `const` (folded PUSH operands
 * or CODECOPY'd data literals), `un`, `env`, `account` and `convert`.
 */

import type { AsmWriter } from '../../asm/assembler.js';
import { padWordAligned, HEX_BYTES_RE, hexToBytes } from '../../core/bytes.js';
import { bitsOf, isBytesN, isSigned } from '../../core/types.js';
import type { Stmt } from '../../ir/nodes.js';
import { fmtType, wordNeedsNormalize, emitNormalizeWord } from '../abi.js';
import { emitAlloc } from '../memory.js';
import {
  type LowerCtx,
  wordConstValue,
  meta,
  storeOut,
  internal,
  typeOf,
  loadOperand,
  asWordType,
  numClass,
  emitFixpointCheck,
  emitMaxCheck,
  maxUint,
  maxInt,
} from './context.js';

// ---------------------------------------------------------------------------
// const — word consts fold to PUSH operands; data consts materialize via CODECOPY
// ---------------------------------------------------------------------------

export function lowerConst(w: AsmWriter, s: Extract<Stmt, { k: 'const' }>, ctx: LowerCtx): void {
  if (s.data.kind === 'word') {
    const slot = ctx.frame.slotOfValue(s.out);
    if (slot === null) return; // folded — operands PUSH it directly
    // returned consts keep a slot (the return encoder reads memory): materialize it
    w.push(wordConstValue(s.data, `const #${s.out}`), meta(`const ${fmtType(s.type)}`));
    w.push(slot);
    w.op('MSTORE');
    return;
  }
  // dynamic literal: data segment + CODECOPY into a fresh allocation.
  // The image is the memref `[len:32][payload…]`, zero-padded to a word boundary so the
  // trailing partial word lands clean (memory above the free pointer is not zero) — the CODECOPY
  // writes every byte of the block, so the allocation needs no zero-fill.
  const bytes = literalBytes(s.data.hex, `const #${s.out}`);
  const padded = padWordAligned(bytes);
  const label = ctx.dataSeg(padded);
  emitAlloc(w, padded.length, {
    zeroFill: false,
    note: `literal ${fmtType(s.type)} (${bytes.length}B)`,
  }); // [ptr]
  w.push(padded.length); // [size, ptr]
  w.pushLabel(label); // [src, size, ptr]
  w.op('DUP3'); // [ptr, src, size, ptr]
  w.op('CODECOPY'); // [ptr]
  storeOut(w, ctx, s.out); // []
}

function literalBytes(hex: string, what: string): Uint8Array {
  if (!HEX_BYTES_RE.test(hex)) throw internal(`${what}: malformed hex ${hex}`);
  return hexToBytes(hex);
}

// ---------------------------------------------------------------------------
// un / env / convert
// ---------------------------------------------------------------------------

export function lowerUn(w: AsmWriter, s: Extract<Stmt, { k: 'un' }>, ctx: LowerCtx): void {
  const type = typeOf(ctx, s.a);
  loadOperand(w, ctx, s.a, meta(`${s.op} ${fmtType(type)}`));
  if (s.op === 'not' || s.op === 'iszero') {
    w.op('ISZERO'); // canonical 0/1 bool
  } else {
    // bitnot — NOT denormalizes uintN (high bits) and bytesN (low bits); it preserves
    // sign-extension for intN, so only the unsigned lanes re-mask.
    w.op('NOT');
    const wt = asWordType(type);
    if (!isSigned(wt) && wordNeedsNormalize(wt)) {
      emitNormalizeWord(w, wt);
    }
  }
  storeOut(w, ctx, s.out);
}

export function lowerEnv(w: AsmWriter, s: Extract<Stmt, { k: 'env' }>, ctx: LowerCtx): void {
  switch (s.op) {
    case 'address':
      w.op('ADDRESS', meta('env address'));
      break;
    case 'caller':
      w.op('CALLER', meta('env caller'));
      break;
    case 'timestamp':
      w.op('TIMESTAMP', meta('env timestamp'));
      break;
    case 'blocknumber':
      w.op('NUMBER', meta('env blocknumber'));
      break;
    case 'chainid':
      w.op('CHAINID', meta('env chainid'));
      break;
    default: {
      const op = String((s as { op: unknown }).op);
      throw internal(`unknown env op '${op}' survived validateIr`);
    }
  }
  storeOut(w, ctx, s.out);
}

/**
 * account: BALANCE / EXTCODESIZE / EXTCODEHASH of the address operand (a canonical address word,
 * so the opcodes see it unchanged). The script's own balance — an operand an `s.env('address')`
 * statement defines — is SELFBALANCE: the same value for 5 gas instead of the slot load plus a
 * warm BALANCE (100).
 */
export function lowerAccount(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'account' }>,
  ctx: LowerCtx,
): void {
  if (s.op === 'balance' && ctx.selfAddresses.has(s.a)) {
    w.op('SELFBALANCE', meta('account balance (self)'));
    storeOut(w, ctx, s.out);
    return;
  }
  loadOperand(w, ctx, s.a, meta(`account ${s.op}`)); // [addr]
  switch (s.op) {
    case 'balance':
      w.op('BALANCE');
      break;
    case 'codesize':
      w.op('EXTCODESIZE');
      break;
    case 'codehash':
      w.op('EXTCODEHASH');
      break;
    default: {
      const op = String((s as { op: unknown }).op);
      throw internal(`unknown account op '${op}' survived validateIr`);
    }
  }
  storeOut(w, ctx, s.out); // []
}

/**
 * convert: free widening / free reinterpret where lossless; a same-width `bytesN` ↔ `uintN` is
 * one shift between the left-aligned and right-aligned lanes; a `bytesN` → `string` copies the
 * word into a fresh string (trailing zero bytes trimmed); otherwise the logical value is
 * range-checked against the target (Panic 0x11) — matching the reference interpreter: checked
 * narrowing, cross-signedness, and `asAddress`'s high-96-bits-zero check.
 */
export function lowerConvert(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'convert' }>,
  ctx: LowerCtx,
): void {
  const from = typeOf(ctx, s.a);
  const to = typeOf(ctx, s.out);
  loadOperand(w, ctx, s.a, meta(`convert ${fmtType(from)} → ${fmtType(to)}`)); // [v]

  if (to === 'string' && isBytesN(from)) {
    emitWordToString(w); // [ptr]
    storeOut(w, ctx, s.out);
    return;
  }
  const reinterpret =
    from === to ||
    (from === 'uint256' && to === 'bytes32') ||
    (from === 'bytes32' && to === 'uint256') ||
    (from === 'address' && to === 'uint160') ||
    (from === 'uint160' && to === 'address') ||
    (from === 'string' && to === 'bytes') ||
    (from === 'bytes' && to === 'string');
  if (reinterpret) {
    storeOut(w, ctx, s.out);
    return;
  }
  if (to === 'address') {
    // asAddress: high 96 bits must be zero
    w.op('DUP1'); // [v, v]
    w.push(160);
    w.op('SHR'); // [v >> 160, v]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [v]
    storeOut(w, ctx, s.out);
    return;
  }
  if (isBytesN(from)) {
    // asUint: the left-aligned lane down to the low bits (canonical ⇒ the rest is zero)
    w.push(256 - bitsOf(from));
    w.op('SHR');
    storeOut(w, ctx, s.out);
    return;
  }
  if (isBytesN(to)) {
    // asBytesN: the zero-extended value up into the left-aligned lane
    w.push(256 - bitsOf(to));
    w.op('SHL');
    storeOut(w, ctx, s.out);
    return;
  }

  const f = numClass(from);
  const t = numClass(to);
  if (f.signed === t.signed) {
    if (t.bits < f.bits) {
      // checked narrowing
      if (t.signed) emitFixpointCheck(w, ctx, t.bits);
      else emitMaxCheck(w, ctx, maxUint(t.bits), `max ${fmtType(to)}`);
    } // else free widening
  } else if (!f.signed && t.signed) {
    // uintN → intM: free iff N < M (the value range fits the sign bit), else checked
    if (f.bits >= t.bits) emitMaxCheck(w, ctx, maxInt(t.bits), `max ${fmtType(to)}`);
  } else if (t.bits === 256) {
    // intN → uint256: only negativity can fail (sign-extended negatives are ≥ 2^255)
    w.op('DUP1'); // [v, v]
    w.push(255);
    w.op('SHR'); // [sign, v]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [v]
  } else {
    // intN → uintM (M < 256): negatives are huge unsigned ⇒ one upper-bound check covers both
    emitMaxCheck(w, ctx, maxUint(t.bits), `max ${fmtType(to)}`);
  }
  storeOut(w, ctx, s.out);
}

/** `0x0101…01`: bit 0 of every byte. */
const LOW_BIT_OF_EACH_BYTE = (2n ** 256n - 1n) / 0xffn;
/** `0x20 1f 1e … 01`: byte `j` (from the left) holds `32 − j`. */
const KEPT_LENGTH_BY_BYTE = Array.from({ length: 32 }, (_, j) => BigInt(32 - j)).reduce(
  (acc, b) => (acc << 8n) | b,
  0n,
);

/**
 * `[v] → [ptr]`: a fresh string holding the left-aligned `bytesN` word `v` up to its last nonzero
 * byte (`.asString()`). `v` is canonical (every byte past N is zero), so the kept length is
 * `32 − j`, `j` = the word's trailing zero bytes, found branch-free in ~70 gas whatever the word:
 *
 * 1. fold each byte onto its low bit (`x |= x >> 4; x |= x >> 2; x |= x >> 1`, masked with
 *    `0x0101…01`): one flag per nonzero byte, at `256^k` for the k-th byte from the right;
 * 2. isolate the lowest flag (`f & −f`): `256^j`, or 0 for an all-zero word;
 * 3. multiply by `0x201f…01` and keep the top byte: shifting the constant left by `j` bytes
 *    leaves its byte `j` = `32 − j` on top (every byte < 256, so no carry) — and 0 stays 0.
 *
 * Every byte of `v` past the kept length is zero, so one MSTORE writes the payload together with
 * its zero padding.
 */
function emitWordToString(w: AsmWriter): void {
  w.op('DUP1'); // [x = v, v]
  for (const shift of [4, 2, 1]) {
    w.op('DUP1');
    w.push(shift);
    w.op('SHR');
    w.op('OR'); // [x |= x >> shift, v]
  }
  w.push(LOW_BIT_OF_EACH_BYTE);
  w.op('AND'); // [f, v]                one flag per nonzero byte
  w.op('DUP1');
  w.push(0);
  w.op('SUB');
  w.op('AND'); // [f & −f, v]           256^j (0 for an all-zero word)
  w.push(KEPT_LENGTH_BY_BYTE);
  w.op('MUL');
  w.push(248);
  w.op('SHR'); // [n = 32 − j, v]
  emitAlloc(w, 64, { zeroFill: false }); // [ptr, n, v]
  w.op('SWAP1');
  w.op('DUP2');
  w.op('MSTORE'); // [ptr, v]             mem[ptr] = n
  w.op('SWAP1');
  w.op('DUP2');
  w.push(32);
  w.op('ADD');
  w.op('MSTORE'); // [ptr]                mem[ptr + 32] = v (payload + zero padding)
}
