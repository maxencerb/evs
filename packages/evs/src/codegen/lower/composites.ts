/**
 * `codegen/lower/composites.ts` — the memref templates: `select`, array index / new / set (and
 * the string/bytes `byteAt` / `slice`), tuples and struct fields (flat-pointer layout), and ABI
 * encoding + hashing (`s.encode`, `s.encodePacked`, `s.keccak256`, and `s.throw` payloads).
 */

import { layoutOfType } from '../../abi/layout.js';
import type { AsmWriter } from '../../asm/assembler.js';
import { selectorBytes } from '../../core/bytes.js';
import {
  abiParamToType,
  isDynamicType,
  type TupleType,
  isTupleType,
  typeToAbiParam,
  stringifyType,
} from '../../core/types.js';
import type { Stmt, ValueId } from '../../ir/nodes.js';
import {
  fmtType,
  emitAbiEncodeToBytes,
  emitPackedEncodeToBytes,
  emitWithinStackBudget,
  emitMemCopy,
  emitCeil32,
} from '../abi.js';
import { emitAlloc, emitZeroValue, emitZeroMemrefMembers } from '../memory.js';
import { emitSelectorRevert } from '../tails.js';
import {
  type LowerCtx,
  type NodeMeta,
  STMT_BASELINE,
  foldedConst,
  loadOperand,
  meta,
  storeOut,
  typeOf,
  internal,
} from './context.js';

// ---------------------------------------------------------------------------
// select / index / arrnew / arrset
// ---------------------------------------------------------------------------

/**
 * `cond ? a : b`, branch-free: `b ^ ((a ^ b) · cond)`. `cond` is a canonical bool (0 or 1), so
 * the product is `a ^ b` or 0 and the outer XOR yields `a` or `b`. Word or memref pointer alike,
 * both operands are already computed (select is eager), so no jump is needed.
 */
export function lowerSelect(w: AsmWriter, s: Extract<Stmt, { k: 'select' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.b, meta('select')); // [b]
  w.op('DUP1'); // [b, b]
  loadOperand(w, ctx, s.a); // [a, b, b]
  w.op('XOR'); // [a ^ b, b]
  loadOperand(w, ctx, s.cond); // [cond, a ^ b, b]
  w.op('MUL'); // [cond ? a ^ b : 0, b]
  w.op('XOR'); // [cond ? a : b]
  storeOut(w, ctx, s.out);
}

/**
 * Folded indices below this bound take the constant arm of {@link emitCheckedElemAddr}: it is
 * the allocation cap (`s.newArray` panics on a length ≥ 2^32), and it keeps `k + 1` and
 * `32·(k + 1)` far from wrapping.
 */
const CONST_INDEX_LIMIT = 1n << 32n;

/**
 * `[…] → [addr, …]`: the address of element `i` of array `arr`, after the bounds check (Panic
 * 0x32 unless `i < len`). `m` annotates the first node. A folded index below the 2^32
 * allocation cap compiles to a constant bound and a constant offset; any other index (a huge
 * constant included, whose `k + 1` / `32·(k + 1)` could wrap) takes the runtime sequence.
 */
function emitCheckedElemAddr(
  w: AsmWriter,
  ctx: LowerCtx,
  arr: ValueId,
  i: ValueId,
  m?: NodeMeta,
): void {
  const k = foldedConst(ctx, i);
  if (k !== undefined && k < CONST_INDEX_LIMIT) {
    loadOperand(w, ctx, arr, m); // [ptr]
    w.op('DUP1');
    w.op('MLOAD'); // [len, ptr]
    w.push(k + 1n); // [k+1, len, ptr]
    w.op('GT'); // [k+1 > len, ptr]   ⇔ len ≤ k
    w.pushLabel(ctx.tails.panicBounds);
    w.op('JUMPI'); // [ptr]                Panic 0x32 on OOB
    w.push(32n * (k + 1n)); // [32·(k+1), ptr]
    w.op('ADD'); // [addr]
    return;
  }
  loadOperand(w, ctx, i, m); // [i]
  loadOperand(w, ctx, arr); // [ptr, i]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr, i]
  w.op('DUP3'); // [i, len, ptr, i]
  w.op('LT'); // [i < len, ptr, i]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // [ptr, i]               Panic 0x32 on OOB
  w.op('SWAP1'); // [i, ptr]
  w.push(5);
  w.op('SHL'); // [32·i, ptr]
  w.op('ADD'); // [ptr + 32·i]
  w.push(32);
  w.op('ADD'); // [addr]
}

/** `index` — a bounds-checked element read (Panic 0x32): an array's element word / pointer, or
 *  (`.byteAt(i)` on a string/bytes, {@link lowerByteAt}) the payload byte at `i`. */
export function lowerIndex(w: AsmWriter, s: Extract<Stmt, { k: 'index' }>, ctx: LowerCtx): void {
  const arrType = typeOf(ctx, s.arr);
  if (arrType === 'string' || arrType === 'bytes') {
    lowerByteAt(w, s, ctx, arrType);
    return;
  }
  emitCheckedElemAddr(w, ctx, s.arr, s.i, meta('index')); // [addr]
  w.op('MLOAD'); // [elem]               elements are canonical (decode normalizes eagerly)
  storeOut(w, ctx, s.out);
}

/** `.byteAt(i)` on a string/bytes: the payload byte at `i` (Panic 0x32 unless `i < len`) as a
 *  left-aligned `bytes1`. */
function lowerByteAt(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'index' }>,
  ctx: LowerCtx,
  arrType: 'string' | 'bytes',
): void {
  loadOperand(w, ctx, s.i, meta(`byteAt ${arrType}`)); // [i]
  loadOperand(w, ctx, s.arr); // [ptr, i]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr, i]
  w.op('DUP3'); // [i, len, ptr, i]
  w.op('LT'); // [i < len, ptr, i]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // [ptr, i]               Panic 0x32 on OOB
  w.op('ADD'); // [ptr + i]
  w.push(32);
  w.op('ADD');
  w.op('MLOAD'); // [word]               byte i is its most significant byte
  w.push(0);
  w.op('BYTE'); // [b]
  w.push(248);
  w.op('SHL'); // [b << 248]            the canonical (left-aligned) bytes1
  storeOut(w, ctx, s.out);
}

/**
 * `slice` — a fresh string/bytes memref holding `a`'s bytes `[start, end)`: Panic 0x32 unless
 * `start ≤ end ≤ len(a)`, then `[n = end − start][payload…]` in a `32 + ceil32(n)` block from
 * `emitAlloc` (no zero-fill: every word is written). The copy runs at exactly `[dst, src, n]`
 * (`emitMemCopy`'s pre-cancun contract), so `out` goes to its slot (after the last operand read)
 * and is read back for the zero word written at the payload's end, which pads the trailing
 * partial word (and heals the `@memcpy` whole-word over-copy).
 */
export function lowerSlice(w: AsmWriter, s: Extract<Stmt, { k: 'slice' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.end, meta(`slice ${fmtType(typeOf(ctx, s.a))}`)); // [end]
  loadOperand(w, ctx, s.a); // [ptr, end]
  w.op('MLOAD'); // [len, end]
  w.op('LT'); // [len < end]
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // []                    Panic 0x32 when end > len
  loadOperand(w, ctx, s.end); // [end]
  loadOperand(w, ctx, s.start); // [start, end]
  w.op('GT'); // [start > end]
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // []                    Panic 0x32 when start > end
  loadOperand(w, ctx, s.start); // [start]
  loadOperand(w, ctx, s.end); // [end, start]
  w.op('SUB'); // [n]
  emitCeil32(w);
  w.push(32);
  w.op('ADD'); // [32 + ceil32(n)]
  emitAlloc(w, 'onStack', { zeroFill: false }); // [out]
  loadOperand(w, ctx, s.start); // [start, out]
  loadOperand(w, ctx, s.end); // [end, start, out]
  w.op('SUB'); // [n, out]
  w.op('DUP2');
  w.op('MSTORE'); // [out]                 mem[out] = n
  loadOperand(w, ctx, s.start); // [start, out]
  loadOperand(w, ctx, s.a); // [ptr, start, out]
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [src, out]             ptr + 32 + start
  w.op('DUP2');
  w.op('MLOAD'); // [n, src, out]
  w.op('SWAP2'); // [out, src, n]
  w.op('DUP1');
  storeOut(w, ctx, s.out); // [out, src, n]   after the last operand read (slots may be reused)
  w.push(32);
  w.op('ADD'); // [dst, src, n]          out + 32
  emitMemCopy(w, ctx.tails, ctx.opts); // []
  w.push(0); // [0]
  loadOperand(w, ctx, s.out); // [out, 0]
  w.op('DUP1');
  w.op('MLOAD');
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [end, 0]               the payload's end
  w.op('MSTORE'); // []                    zero pad
}

export function lowerArrnew(w: AsmWriter, s: Extract<Stmt, { k: 'arrnew' }>, ctx: LowerCtx): void {
  const suffix = s.fixed === undefined ? '[]' : `[${s.fixed}]`;
  loadOperand(w, ctx, s.length, meta(`arrnew ${fmtType(s.elem)}${suffix}`)); // [n]
  w.op('DUP1');
  w.push(0xffffffffn, { note: 'alloc cap 2^32−1' }); // [cap, n, n]
  w.op('LT'); // [cap < n, n]
  w.pushLabel(ctx.tails.panicAlloc);
  w.op('JUMPI'); // [n]                   Panic 0x41 on len ≥ 2^32
  w.op('DUP1');
  w.push(5);
  w.op('SHL');
  w.push(32);
  w.op('ADD'); // [size = 32 + 32·n, n]
  if (!isDynamicType(s.elem)) {
    // word elements: the zero-filled slots already are their zero value
    emitAlloc(w, 'onStack', { zeroFill: true }); // [ptr, n]
    w.op('SWAP1'); // [n, ptr]
    w.op('DUP2'); // [ptr, n, ptr]
    w.op('MSTORE'); // [ptr]                 length word
    storeOut(w, ctx, s.out); // []
    return;
  }
  // memref elements: a zeroed slot is pointer 0x00 (scratch), not a zero value. Store each slot's
  // typed zero — 0x60 for string/bytes/T[], a FRESH zeroed block per slot for a tuple (tuples are
  // references: a shared block would leak a .set() through one element into the others). The loop
  // writes every slot, so the block needs no zero-fill.
  w.op('DUP1'); // [size, size, n]
  emitAlloc(w, 'onStack', { zeroFill: false }); // [ptr, size, n]
  w.op('SWAP2'); // [n, size, ptr]
  w.op('DUP3'); // [ptr, n, size, ptr]
  w.op('MSTORE'); // [size, ptr]           length word
  w.op('DUP2'); // [ptr, size, ptr]
  w.op('ADD'); // [end, ptr]
  w.op('DUP2'); // [ptr, end, ptr]
  w.push(32);
  w.op('ADD'); // [p = ptr+32, end, ptr]
  const head = w.newLabel('arrnew_zero');
  const done = w.newLabel('arrnew_zero_done');
  w.label(head, STMT_BASELINE + 3); // [p, end, ptr]
  w.op('DUP2'); // [end, p, end, ptr]
  w.op('DUP2'); // [p, end, p, end, ptr]
  w.op('LT'); // [p < end, p, end, ptr]
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [p, end, ptr]
  emitWithinStackBudget(
    w,
    STMT_BASELINE + 3,
    () => `s.newArray() element type ${stringifyType(s.elem)}`,
    () => emitZeroValue(w, s.elem, STMT_BASELINE + 3),
  ); // [zero, p, end, ptr]
  w.op('DUP2'); // [p, zero, p, end, ptr]
  w.op('MSTORE', { note: 'zero element' }); // [p, end, ptr]
  w.push(32);
  w.op('ADD'); // [p+32, end, ptr]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, STMT_BASELINE + 3); // [p, end, ptr]
  w.op('POP');
  w.op('POP'); // [ptr]
  storeOut(w, ctx, s.out); // []
}

export function lowerArrset(w: AsmWriter, s: Extract<Stmt, { k: 'arrset' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.value, meta('arrset')); // [v]
  emitCheckedElemAddr(w, ctx, s.arr, s.i); // [addr, v]
  w.op('MSTORE'); // []                  value is canonical (operand types validated)
}

// ---------------------------------------------------------------------------
// tuples / structs — FLAT-POINTER layout: a tuple is a memref to a
// packed `[w0][w1]…[w_{n-1}]` block of `n` words (NO length prefix). A static member's word is
// canonical; a dynamic/composite member's word is a memref pointer.
// ---------------------------------------------------------------------------

/** The tuple type of a plain-tuple value (its flat block has one word per component). A tuple
 *  ARRAY is a `[len][elements…]` block instead, so it is rejected here, as in `validateIr`. */
function tupleTypeOf(ctx: LowerCtx, v: ValueId): TupleType {
  const ty = typeOf(ctx, v);
  if (!isTupleType(ty) || ty.type !== 'tuple') {
    throw internal(`tuple op over a non-tuple value (ValueId ${v}: ${stringifyType(ty)})`);
  }
  return ty;
}

/** `s.tuple(type, init)` → bump-alloc `32·n`, store the typed zero of each omitted memref member
 *  (string/bytes/T[] → `0x60`, nested tuple → a fresh zeroed block — a zeroed slot would be
 *  pointer `0x00`, i.e. scratch), then MSTORE each provided member at `ptr + 32·i`. Omitted (or
 *  literal-0) WORD members rely on the zero-fill alone, so the block is zero-filled only when
 *  there is one. */
export function lowerTupleNew(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'tuplenew' }>,
  ctx: LowerCtx,
): void {
  const ty = tupleTypeOf(ctx, s.out);
  const n = ty.components.length;
  const provided = new Set(s.inits.map((init) => init.index));
  const zeroFill = ty.components.some(
    (c, j) => !provided.has(j) && !isDynamicType(abiParamToType(c)),
  );
  emitAlloc(w, 32 * n, { zeroFill, note: `tuplenew ${n} words` }); // [ptr]
  // omitted memref members → their typed zero (provided members are stored just below)
  emitWithinStackBudget(
    w,
    STMT_BASELINE + 1,
    () => `s.tuple() of ${stringifyType(ty)}`,
    () => emitZeroMemrefMembers(w, ty.components, STMT_BASELINE + 1, provided),
  ); // [ptr]
  // MSTORE each provided member at ptr + 32·index
  for (const init of s.inits) {
    loadOperand(w, ctx, init.value, meta(`member [${init.index}] ←`)); // [v, ptr]
    w.op('DUP2'); // [ptr, v, ptr]
    if (init.index > 0) {
      w.push(32 * init.index);
      w.op('ADD'); // [ptr+32·i, v, ptr]
    }
    w.op('MSTORE'); // [ptr]
  }
  storeOut(w, ctx, s.out); // []
}

/** `field i` read = `MLOAD(tuplePtr + 32·i)` → the canonical word or the member pointer. */
export function lowerField(w: AsmWriter, s: Extract<Stmt, { k: 'field' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.tuple, meta(`field [${s.index}]`)); // [ptr]
  if (s.index > 0) {
    w.push(32 * s.index);
    w.op('ADD'); // [ptr+32·i]
  }
  w.op('MLOAD'); // [word]
  storeOut(w, ctx, s.out);
}

/** `field i` write = `MSTORE(tuplePtr + 32·i, value)`. */
export function lowerTupleSet(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'tupleset' }>,
  ctx: LowerCtx,
): void {
  loadOperand(w, ctx, s.value, meta(`tupleset [${s.index}] ←`)); // [v]
  loadOperand(w, ctx, s.tuple); // [ptr, v]
  if (s.index > 0) {
    w.push(32 * s.index);
    w.op('ADD'); // [ptr+32·i, v]
  }
  w.op('MSTORE'); // []
}

// ---------------------------------------------------------------------------
// ABI encoding + hashing — `s.encode` / `s.encodePacked` / `s.keccak256` (issue #17)
// ---------------------------------------------------------------------------

/** `encode` — materialize the standard/packed ABI encoding of the args into a fresh `bytes`
 *  memref (codegen/abi.ts emitters) and store its pointer to the out slot. */
export function lowerEncode(w: AsmWriter, s: Extract<Stmt, { k: 'encode' }>, ctx: LowerCtx): void {
  const m = meta(`encode ${s.mode}`);
  if (s.mode === 'abi') {
    const items = s.args.map((a) => ({
      param: typeToAbiParam('', typeOf(ctx, a)),
      pushSrc: (): void => {
        loadOperand(w, ctx, a);
      },
    }));
    emitAbiEncodeToBytes(w, items, ctx.tails, ctx.opts, m); // [ptr]
  } else {
    const items = s.args.map((a) => ({
      layout: layoutOfType(typeOf(ctx, a)),
      pushSrc: (): void => {
        loadOperand(w, ctx, a);
      },
    }));
    emitPackedEncodeToBytes(w, items, ctx.tails, ctx.opts, m); // [ptr]
  }
  storeOut(w, ctx, s.out); // []
}

/**
 * `throw` — custom-error revert (issue #15): `REVERT` with `selector ‖ abi.encode(args)`,
 * byte-identical to solc's custom-error revert data. Emitted INLINE at the throw site (the
 * shared-tail pattern only fits fixed payloads; the verifier treats `REVERT` as a terminator,
 * so the template need not be net-zero — the `call.ts` bubble-revert precedent).
 *
 * With params: the standard-encode emitter materializes `abi.encode(args)` as a fresh
 * `[len | payload…]` memref at `ptr`; the selector word is then MSTOREd AT `ptr`, landing its
 * 4 bytes in `[ptr+28, ptr+32)` — clobbering the low bytes of the length word, which is dead
 * at this point — and the frame reverts with `(ptr+28, len+4)`. Zero params: the shared tails'
 * {@link emitSelectorRevert} (`sel << 224` at offset 0, revert(0, 4)) — memory is dead
 * pre-revert.
 */
export function lowerThrow(w: AsmWriter, s: Extract<Stmt, { k: 'throw' }>, ctx: LowerCtx): void {
  const err = (ctx.ir.errors ?? [])[s.error];
  if (err === undefined) throw internal(`throw with unknown error #${s.error} survived validateIr`);
  const m = meta(`throw ${err.name}`);
  if (s.args.length === 0) {
    emitSelectorRevert(w, err.selector, {
      withTopWord: false,
      headNote: `throw ${err.name}`,
      note: `${err.name}()`,
    }); // revert(0, 4)
    return;
  }
  const items = s.args.map((a) => ({
    param: typeToAbiParam('', typeOf(ctx, a)),
    pushSrc: (): void => {
      loadOperand(w, ctx, a);
    },
  }));
  emitAbiEncodeToBytes(w, items, ctx.tails, ctx.opts, m); // [ptr]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr]
  w.push(4);
  w.op('ADD'); // [len+4, ptr]
  w.op('SWAP1'); // [ptr, len+4]
  w.pushBytes(selectorBytes(err.selector, 'codegen/lower throw')); // [sel, ptr, len+4]
  w.op('DUP2'); // [ptr, sel, ptr, len+4]
  w.op('MSTORE'); // [ptr, len+4]   mem[ptr+28..ptr+32) = selector
  w.push(28);
  w.op('ADD'); // [ptr+28, len+4]
  w.op('REVERT', { note: `${err.name}(…) — selector ‖ abi.encode(args)` }); // revert(ptr+28, len+4)
}

/** `keccak256` — hash a `bytes`/`string` memref's payload: `KECCAK256(ptr + 32, MLOAD(ptr))`. */
export function lowerKeccak256(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'keccak256' }>,
  ctx: LowerCtx,
): void {
  loadOperand(w, ctx, s.a, meta('keccak256')); // [ptr]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr]
  w.op('SWAP1');
  w.push(32);
  w.op('ADD'); // [ptr+32, len]     KECCAK256 pops [offset, size]
  w.op('KECCAK256'); // [hash]
  storeOut(w, ctx, s.out); // []
}
