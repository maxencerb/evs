/**
 * `codegen/tails.ts` — shared tail emission: the panic tails, the `EvsInvalidCalldata()` /
 * `EvsDecodeError(site)` revert tails, the per-site decode-fail stubs, the pre-cancun
 * `@memcpy` word-loop subroutine and the `@muldiv` FullMath subroutine.
 *
 * NOTE: the `SharedTails` labels `codegen/abi.ts` + `codegen/call.ts` jump to must be *defined*
 * somewhere; this module is the single place that emits the tail bodies (used directly by the
 * unit tests, and by `lowerProgram`, which places panic tails / dfail stubs /
 * `@decode_revert` / `@memcpy` / `@muldiv` after the program body).
 *
 * Only referenced tails are emitted (`emitSharedTails` checks `AsmWriter.isReferenced`), so a
 * script that cannot divide carries no `@panic_divzero`, one without strict calls no
 * `@decode_revert`, etc.
 *
 * Tail shapes (byte-for-byte intent):
 *
 *   @panic_<kind>:   JUMPDEST PUSH1 <code> PUSH2 @panic JUMP                ('any')
 *   @panic:          JUMPDEST PUSH4 0x4e487b71 PUSH1 0xE0 SHL PUSH0 MSTORE  ('any')
 *                    PUSH1 0x04 MSTORE PUSH1 0x24 PUSH0 REVERT              ; Panic(code)
 *   @decode_revert:  same shape with sel(EvsDecodeError(uint256)); the site id is pushed by
 *                    the per-site stub: @dfail_<site>: JUMPDEST PUSH<k> site PUSH2 @decode_revert JUMP
 *   @badcd:          4-byte-payload variant — revert(0, 4) of sel(EvsInvalidCalldata())
 *   @memcpy:         checked subroutine (entry height 4: [ret, dst, src, len]); copies
 *                    ceil32(len) bytes word-wise, returns via dynamic JUMP.
 *   @muldiv:         checked subroutine (entry height 4: [a, b, d, ret], or 5: [a, b, d, up,
 *                    ret] when the program mixes roundings); the FullMath `mulDiv` /
 *                    `mulDivRoundingUp` body every site calls (`lower/muldiv.ts`), returns [q]
 *                    via dynamic JUMP.
 *
 * The shared codec bodies follow the same checked-subroutine convention but are emitted by
 * `CodecShare.emitBodies` (`codegen/codecs.ts`), just before the dfail stubs and these tails
 * (a body references `@memcpy` before cancun), and only for the codecs a site calls:
 *
 *   @enc_<k>:        a top-level composite member's encoder; entry [ret, base, src] (3, a static
 *                    member) or [ret, src] (2, a dynamic one). The return address is spilled to
 *                    RET; a tuple member's base / src are spilled to BASE / SRC (a dynamic
 *                    tuple's BASE is its tail cursor), while an array member's operands stay on
 *                    the stack for the array encoder. Returns via dynamic JUMP to the site's
 *                    label, checked at 0.
 *   @dec_<k>:        a call output's decoder; entry [ret, buf] (2), returns [block, buf] — or
 *                    [0, buf] through the @dec_<k>_fail_<h> funnel (POP rungs, allocated up
 *                    front, placed only when referenced) — to the site's label, checked at 2.
 *
 * The three selector reverts are one emitter, {@link emitSelectorRevert}, which a zero-arg
 * `s.throw` (`codegen/lower/composites.ts`) reuses inline.
 */

import {
  EVS_DECODE_ERROR_SELECTOR,
  EVS_INVALID_CALLDATA_SELECTOR,
  PANIC_SELECTOR,
} from '../abi/artifact.js';
import type { AsmWriter, LabelId } from '../asm/assembler.js';
import { forkAtLeast, OPS, type EvmVersion } from '../asm/ops.js';
import { selectorBytes } from '../core/bytes.js';
import { EvsInternalError } from '../core/errors.js';
import type { Hex } from '../core/types.js';
import type { SiteId } from '../ir/nodes.js';
import type { CodecHook, SharedTails } from './abi.js';
import type { MulDivRounding } from './lower/context.js';
import { emitMulDivSubroutine } from './lower/muldiv.js';

// ---------------------------------------------------------------------------
// selector reverts
// ---------------------------------------------------------------------------

/**
 * `revert(selector ‖ word?)` with the selector word stored at `mem[0..32)`:
 *
 *   PUSH4 <sel> PUSH1 0xE0 SHL PUSH0 MSTORE [PUSH1 0x04 MSTORE] PUSH1 <size> PUSH0 REVERT
 *
 * With `withTopWord`, the word on top of the stack becomes the single `uint256` argument
 * (`mem[4..36)`, a 36-byte payload: `Panic(code)`, `EvsDecodeError(site)`); without it the
 * payload is the bare 4-byte selector (`EvsInvalidCalldata()`, a zero-arg `s.throw`). Memory is
 * dead before a revert, so the scratch words are free to clobber. `headNote` annotates the
 * selector push (default `selector <sel>`), `note` the REVERT.
 */
export function emitSelectorRevert(
  w: AsmWriter,
  selector: Hex,
  opts: { readonly withTopWord: boolean; readonly note: string; readonly headNote?: string },
): void {
  w.pushBytes(selectorBytes(selector, 'codegen/tails'), {
    note: opts.headNote ?? `selector ${selector}`,
  });
  w.push(0xe0);
  w.op('SHL'); // [selWord, …]
  w.push(0);
  w.op('MSTORE'); // […]   mem[0..4) = selector
  if (opts.withTopWord) {
    w.push(4);
    w.op('MSTORE'); // mem[4..36) = the top word
  }
  w.push(opts.withTopWord ? 0x24 : 4);
  w.push(0);
  w.op('REVERT', { note: opts.note }); // revert(0, 36) / revert(0, 4)
}

// ---------------------------------------------------------------------------
// label allocation + emission
// ---------------------------------------------------------------------------

/** Every label name the shared tails allocate (they show up in disassembly and the source map). */
const TAIL_LABEL = {
  panicOverflow: 'panic_overflow',
  panicDivZero: 'panic_divzero',
  panicBounds: 'panic_bounds',
  panicAlloc: 'panic_alloc',
  panic: 'panic',
  invalidCalldata: 'badcd',
  decodeRevert: 'decode_revert',
  memcpy: 'memcpy',
  memcpyLoop: 'memcpy_loop',
  memcpyDone: 'memcpy_done',
  mulDiv: 'muldiv',
} as const;

/**
 * Allocates every `SharedTails` label on `w` (bodies are emitted only for the referenced ones —
 * see `emitSharedTails`). `memcpy` is `null` on cancun (MCOPY inlines).
 * Call once per program, before any emitter references the tails; emit the bodies with
 * `emitSharedTails` after the last code region (and before any data segments). `opts.codecs` is
 * the codec-sharing hook (`codegen/codecs.ts`), `null` (the default) to inline every codec.
 */
export function createSharedTails(
  w: AsmWriter,
  opts: { evmVersion: EvmVersion; codecs?: CodecHook | null },
): SharedTails {
  return {
    codecs: opts.codecs ?? null,
    panicOverflow: w.newLabel(TAIL_LABEL.panicOverflow),
    panicDivZero: w.newLabel(TAIL_LABEL.panicDivZero),
    panicBounds: w.newLabel(TAIL_LABEL.panicBounds),
    panicAlloc: w.newLabel(TAIL_LABEL.panicAlloc),
    invalidCalldata: w.newLabel(TAIL_LABEL.invalidCalldata),
    decodeRevert: w.newLabel(TAIL_LABEL.decodeRevert),
    memcpy: forkAtLeast(opts.evmVersion, OPS.MCOPY.since) ? null : w.newLabel(TAIL_LABEL.memcpy),
    mulDiv: w.newLabel(TAIL_LABEL.mulDiv),
  };
}

/**
 * Per-site decode-fail stub (strict-mode `s.call` sites):
 *
 *   @dfail_<site>: JUMPDEST PUSH<k> <site> PUSH2 @decode_revert JUMP   ('any')
 *
 * `emitStaticCall` only *references* `plan.dfailLabel` in strict mode; the program assembler
 * (`lowerProgram`, or a test harness) must place one stub per strict call site.
 */
export function emitDecodeFailStub(
  w: AsmWriter,
  dfailLabel: LabelId,
  siteId: SiteId,
  tails: SharedTails,
): void {
  w.label(dfailLabel, 'any', `dfail_${siteId}`);
  w.push(siteId, { note: `site ${siteId}` });
  w.pushLabel(tails.decodeRevert);
  w.op('JUMP');
}

/**
 * Emits the shared tail bodies that something references: the `@muldiv` subroutine (in the
 * program's `mulDivRounding`, `LowerCtx.mulDivShare`), each panic stub (and the `@panic` core,
 * only when at least one stub is emitted), `@decode_revert` (`EvsDecodeError(uint256 site)` —
 * site pushed by the per-site stub), `@badcd` (`EvsInvalidCalldata()`), and the `@memcpy`
 * subroutine when `tails.memcpy` is non-null. A tail no `pushLabel` has named is dead code and
 * is left out (its allocated label stays unplaced, which the assembler accepts).
 *
 * Must be emitted after all code that can reference or fall through into a tail — i.e. last
 * among the code regions (before data segments only), since reference tracking only sees
 * `pushLabel`s already written. Tails reference only the `@panic` core (from the stubs), the
 * subroutines' own labels and `@muldiv`'s `@panic_overflow` — which is why `@muldiv` goes
 * first. Every tail is unreachable by fallthrough: panic/revert tails are `'any'` regions
 * ending in REVERT; `@muldiv` / `@memcpy` are checked subroutines entered only by their call
 * sites (`lowerMulDiv`, `emitMemCopy`) and leaving by their return JUMP.
 *
 * Returns the label of the first tail it placed (`null` when nothing is referenced), so the
 * caller can report where the tails region starts.
 */
export function emitSharedTails(
  w: AsmWriter,
  tails: SharedTails,
  mulDivRounding: MulDivRounding | null = null,
): LabelId | null {
  let first: LabelId | null = null;
  const open = (label: LabelId): void => {
    first ??= label;
  };

  // -- @muldiv FullMath subroutine (first: it references @panic_overflow) -----------
  if (w.isReferenced(tails.mulDiv)) {
    if (mulDivRounding === null) {
      throw new EvsInternalError(
        'INTERNAL',
        'codegen/tails: emitSharedTails: @muldiv is referenced but no rounding was given — pass LowerCtx.mulDivShare',
      );
    }
    open(tails.mulDiv);
    emitMulDivSubroutine(w, tails.mulDiv, tails, mulDivRounding);
  }

  // -- panic stubs + core ------------------------------------------------------
  const stubs: readonly [LabelId, number][] = [
    [tails.panicOverflow, 0x11],
    [tails.panicDivZero, 0x12],
    [tails.panicBounds, 0x32],
    [tails.panicAlloc, 0x41],
  ];
  const liveStubs = stubs.filter(([label]) => w.isReferenced(label));
  if (liveStubs.length > 0) {
    const panic = w.newLabel(TAIL_LABEL.panic);
    for (const [label, code] of liveStubs) {
      open(label);
      w.label(label, 'any');
      w.push(code, { note: `panic code 0x${code.toString(16)}` });
      w.pushLabel(panic);
      w.op('JUMP');
    }
    w.label(panic, 'any'); // [code, …dead]
    emitSelectorRevert(w, PANIC_SELECTOR, { withTopWord: true, note: 'Panic(code)' });
  }

  // -- @decode_revert: EvsDecodeError(uint256 site) -------------------------------
  if (w.isReferenced(tails.decodeRevert)) {
    open(tails.decodeRevert);
    w.label(tails.decodeRevert, 'any'); // [site, …dead]
    emitSelectorRevert(w, EVS_DECODE_ERROR_SELECTOR, {
      withTopWord: true,
      note: 'EvsDecodeError(site)',
    });
  }

  // -- @badcd: EvsInvalidCalldata() ------------------------------------------------
  if (w.isReferenced(tails.invalidCalldata)) {
    open(tails.invalidCalldata);
    w.label(tails.invalidCalldata, 'any');
    emitSelectorRevert(w, EVS_INVALID_CALLDATA_SELECTOR, {
      withTopWord: false,
      note: 'EvsInvalidCalldata()',
    });
  }

  // -- @memcpy word-loop subroutine (pre-cancun only) ------------------------------
  if (tails.memcpy !== null && w.isReferenced(tails.memcpy)) {
    open(tails.memcpy);
    emitMemcpySubroutine(w, tails.memcpy);
  }
  return first;
}

/**
 * The shared `@memcpy` subroutine. Entry (checked, absolute height 4): `[ret, dst, src, len]`
 * — `emitMemCopy` pushes the return label over the caller's `[dst, src, len]`, which the
 * convention requires to be the *entire* stack. Copies `ceil32(len)` bytes in 32-byte words
 * (over-copy of the trailing partial word is the caller's contract — they zero-pad after),
 * front to back, then returns via dynamic JUMP with everything consumed.
 *
 * One byte offset `i` drives both addresses (`src + i`, `dst + i`) and steps by 32 while
 * `i < len`, so `len` itself is the bound (no rounding): a two-instruction setup, then 67 gas
 * per word.
 */
function emitMemcpySubroutine(w: AsmWriter, entry: LabelId): void {
  const loop = w.newLabel(TAIL_LABEL.memcpyLoop);
  const done = w.newLabel(TAIL_LABEL.memcpyDone);
  w.label(entry, 4); // [ret, dst, src, len]
  w.op('SWAP3'); // [len, dst, src, ret]
  w.push(0); // [i = 0, len, dst, src, ret]
  w.label(loop, 5);
  w.op('DUP2');
  w.op('DUP2');
  w.op('LT'); // [i < len, i, len, dst, src, ret]
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [i, len, dst, src, ret]
  w.op('DUP4');
  w.op('DUP2');
  w.op('ADD');
  w.op('MLOAD'); // [word = mem[src+i], i, len, dst, src, ret]
  w.op('DUP4');
  w.op('DUP3');
  w.op('ADD');
  w.op('MSTORE'); // [i, len, dst, src, ret]      mem[dst+i] = word
  w.push(32);
  w.op('ADD'); // [i+32, len, dst, src, ret]
  w.pushLabel(loop);
  w.op('JUMP');
  w.label(done, 5); // [i, len, dst, src, ret]
  w.op('POP');
  w.op('POP');
  w.op('POP');
  w.op('POP'); // [ret]
  w.op('JUMP', { note: 'memcpy return' }); // dynamic return jump (checked region)
}
