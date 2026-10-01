/**
 * `codegen/lower/composites.ts` — the memref templates: `select`, array index / new / set (and
 * the string/bytes `byteAt` / `slice`), tuples and struct fields (flat-pointer layout), and ABI
 * encoding + hashing (`s.encode`, `s.encodePacked`, `s.keccak256`, and `s.throw` payloads).
 */

import { layoutOfType } from '../../abi/layout.js';
import type { AsmWriter } from '../../asm/assembler.js';
import { selectorBytes } from '../../core/bytes.js';
import {
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
import { FREE_PTR, emitZeroValue, emitZeroMemrefMembers } from '../memory.js';
import {
  type LowerCtx,
  STMT_BASELINE,
  loadOperand,
  meta,
  storeOut,
  typeOf,
  internal,
  emitBumpAlloc,
} from './context.js';

// ---------------------------------------------------------------------------
// select / index / arrnew / arrset
// ---------------------------------------------------------------------------

export function lowerSelect(w: AsmWriter, s: Extract<Stmt, { k: 'select' }>, ctx: LowerCtx): void {
  const base = STMT_BASELINE;
  const takeA = w.newLabel(`select_a_${s.site}`);
  const done = w.newLabel(`select_done_${s.site}`);
  loadOperand(w, ctx, s.cond, meta('select')); // [cond]
  w.pushLabel(takeA);
  w.op('JUMPI'); // []
  loadOperand(w, ctx, s.b);
  storeOut(w, ctx, s.out);
  w.pushLabel(done);
  w.op('JUMP');
  w.label(takeA, base);
  loadOperand(w, ctx, s.a);
  storeOut(w, ctx, s.out);
  w.label(done, base);
}

/** `index` — a bounds-checked element read (Panic 0x32): an array's element word / pointer, or
 *  (`.byteAt(i)` on a string/bytes) the payload byte at `i` as a left-aligned `bytes1`. */
export function lowerIndex(w: AsmWriter, s: Extract<Stmt, { k: 'index' }>, ctx: LowerCtx): void {
  const arrType = typeOf(ctx, s.arr);
  const ofBytes = arrType === 'string' || arrType === 'bytes';
  loadOperand(w, ctx, s.i, meta(ofBytes ? `byteAt ${arrType}` : 'index')); // [i]
  loadOperand(w, ctx, s.arr); // [ptr, i]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr, i]
  w.op('DUP3'); // [i, len, ptr, i]
  w.op('LT'); // [i < len, ptr, i]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // [ptr, i]               Panic 0x32 on OOB
  if (ofBytes) {
    w.op('ADD'); // [ptr + i]
    w.push(32);
    w.op('ADD');
    w.op('MLOAD'); // [word]               byte i is its most significant byte
    w.push(0);
    w.op('BYTE'); // [b]
    w.push(248);
    w.op('SHL'); // [b << 248]            the canonical (left-aligned) bytes1
    storeOut(w, ctx, s.out);
    return;
  }
  w.op('SWAP1'); // [i, ptr]
  w.push(5);
  w.op('SHL'); // [32·i, ptr]
  w.op('ADD'); // [ptr + 32·i]
  w.push(32);
  w.op('ADD'); // [addr]
  w.op('MLOAD'); // [elem]               elements are canonical (decode normalizes eagerly)
  storeOut(w, ctx, s.out);
}

/**
 * `slice` — a fresh string/bytes memref holding `a`'s bytes `[start, end)`: Panic 0x32 unless
 * `start ≤ end ≤ len(a)`, then `[n = end − start][payload…]` in a `32 + ceil32(n)` block from
 * `emitBumpAlloc`. The copy runs at exactly `[dst, src, n]` (`emitMemCopy`'s pre-cancun
 * contract), so `out` goes to its slot (after the last operand read) and is read back for the
 * zero word written at the payload's end, which pads the trailing partial word (and heals the
 * `@memcpy` whole-word over-copy).
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
  emitBumpAlloc(w, 'onStack'); // [out]
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
  w.push(FREE_PTR);
  w.op('MLOAD'); // [ptr, n]
  // freePtr += 32 + 32·n
  w.op('DUP2'); // [n, ptr, n]
  w.push(5);
  w.op('SHL'); // [32n, ptr, n]
  w.push(32);
  w.op('ADD'); // [size, ptr, n]
  w.op('DUP2'); // [ptr, size, ptr, n]
  w.op('ADD'); // [ptr+size, ptr, n]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr, n]
  // zero-fill [ptr, ptr+size) — CALLDATACOPY from past the calldata end reads zeros
  w.op('DUP2');
  w.push(5);
  w.op('SHL');
  w.push(32);
  w.op('ADD'); // [size, ptr, n]
  w.op('CALLDATASIZE'); // [cds, size, ptr, n]
  w.op('DUP3'); // [ptr, cds, size, ptr, n]
  w.op('CALLDATACOPY', { note: 'zero-fill' }); // [ptr, n]
  // length word
  w.op('DUP2'); // [n, ptr, n]
  w.op('DUP2'); // [ptr, n, ptr, n]
  w.op('MSTORE'); // [ptr, n]
  if (!isDynamicType(s.elem)) {
    // word elements: the zero-filled slots already are their zero value
    storeOut(w, ctx, s.out); // [n]
    w.op('POP'); // []
    return;
  }
  // memref elements: a zeroed slot is pointer 0x00 (scratch), not a zero value. Store each slot's
  // typed zero — 0x60 for string/bytes/T[], a FRESH zeroed block per slot for a tuple (tuples are
  // references: a shared block would leak a .set() through one element into the others).
  w.op('SWAP1'); // [n, ptr]
  w.push(5);
  w.op('SHL'); // [32n, ptr]
  w.op('DUP2'); // [ptr, 32n, ptr]
  w.push(32);
  w.op('ADD'); // [p = ptr+32, 32n, ptr]
  w.op('SWAP1'); // [32n, p, ptr]
  w.op('DUP2'); // [p, 32n, p, ptr]
  w.op('ADD'); // [end, p, ptr]
  w.op('SWAP1'); // [p, end, ptr]
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
  loadOperand(w, ctx, s.i); // [i, v]
  loadOperand(w, ctx, s.arr); // [ptr, i, v]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr, i, v]
  w.op('DUP3'); // [i, len, ptr, i, v]
  w.op('LT'); // [i < len, ptr, i, v]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // [ptr, i, v]           Panic 0x32 on OOB
  w.op('SWAP1'); // [i, ptr, v]
  w.push(5);
  w.op('SHL'); // [32·i, ptr, v]
  w.op('ADD'); // [ptr + 32·i, v]
  w.push(32);
  w.op('ADD'); // [addr, v]
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

/** `s.tuple(type, init)` → bump-alloc `32·n`, zero-fill (CALLDATACOPY past-end), store the typed
 *  zero of each omitted memref member (string/bytes/T[] → `0x60`, nested tuple → a fresh zeroed
 *  block — a zeroed slot would be pointer `0x00`, i.e. scratch), then MSTORE each provided member
 *  at `ptr + 32·i`. Only omitted/literal-0 WORD members rely on the zero-fill alone. */
export function lowerTupleNew(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'tuplenew' }>,
  ctx: LowerCtx,
): void {
  const ty = tupleTypeOf(ctx, s.out);
  const n = ty.components.length;
  const size = 32 * n;
  w.push(FREE_PTR, meta(`tuplenew ${n} words`));
  w.op('MLOAD'); // [ptr]
  // freePtr += size
  w.op('DUP1'); // [ptr, ptr]
  w.push(size);
  w.op('ADD'); // [ptr+size, ptr]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr]
  // zero-fill [ptr, ptr+size): CALLDATACOPY from past the calldata end reads zeros. At stack
  // height exactly [ptr] here; the @memcpy contract is not used (no memref copy).
  w.push(size); // [size, ptr]
  w.op('CALLDATASIZE'); // [cds, size, ptr]
  w.op('DUP3'); // [ptr, cds, size, ptr]
  w.op('CALLDATACOPY', { note: 'zero-fill' }); // [ptr]
  // omitted memref members → their typed zero (provided members are stored just below)
  emitWithinStackBudget(
    w,
    STMT_BASELINE + 1,
    () => `s.tuple() of ${stringifyType(ty)}`,
    () =>
      emitZeroMemrefMembers(
        w,
        ty.components,
        STMT_BASELINE + 1,
        new Set(s.inits.map((init) => init.index)),
      ),
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
 * at this point — and the frame reverts with `(ptr+28, len+4)`. Zero params: the shared-tail
 * selector-store shape (`sel << 224` at offset 0, revert(0, 4)) — memory is dead pre-revert.
 */
export function lowerThrow(w: AsmWriter, s: Extract<Stmt, { k: 'throw' }>, ctx: LowerCtx): void {
  const err = (ctx.ir.errors ?? [])[s.error];
  if (err === undefined) throw internal(`throw with unknown error #${s.error} survived validateIr`);
  const m = meta(`throw ${err.name}`);
  const sel = selectorBytes(err.selector, 'codegen/lower throw');
  if (s.args.length === 0) {
    w.pushBytes(sel, m); // [sel]
    w.push(0xe0);
    w.op('SHL'); // [selWord]
    w.push(0);
    w.op('MSTORE'); // []           mem[0..4) = selector
    w.push(4);
    w.push(0);
    w.op('REVERT', { note: `${err.name}()` }); // revert(0, 4)
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
  w.pushBytes(sel); // [sel, ptr, len+4]
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
