/**
 * M7 `codegen/tails.ts` — shared tail emission: the panic tails (architecture §15.0), the
 * `EvsInvalidCalldata()` / `EvsDecodeError(site)` revert tails (§11), the per-site decode-fail
 * stubs, and the pre-cancun `@memcpy` word-loop subroutine (§10).
 *
 * NOTE: module-interfaces.md §M7 lists only `codegen/abi.ts` + `codegen/call.ts`, but the
 * `SharedTails` labels those emitters jump to must be *defined* somewhere; this module is the
 * single place that emits the tail bodies (used directly by the M7 unit tests, and available
 * to M8's `lowerProgram`, which the law tasks with placing panic tails / dfail stubs /
 * `@decode_revert` / `@memcpy` after the program body).
 *
 * Tail shapes (architecture §15.0, byte-for-byte intent):
 *
 *   @panic_<kind>:   JUMPDEST PUSH1 <code> PUSH2 @panic JUMP                ('any')
 *   @panic:          JUMPDEST PUSH4 0x4e487b71 PUSH1 0xE0 SHL PUSH0 MSTORE  ('any')
 *                    PUSH1 0x04 MSTORE PUSH1 0x24 PUSH0 REVERT              ; Panic(code)
 *   @decode_revert:  same shape with sel(EvsDecodeError(uint256)); the site id is pushed by
 *                    the per-site stub: @dfail_<site>: JUMPDEST PUSH<k> site PUSH2 @decode_revert JUMP
 *   @badcd:          4-byte-payload variant — revert(0, 4) of sel(EvsInvalidCalldata())
 *   @memcpy:         checked subroutine (entry height 4: [ret, dst, src, len]); copies
 *                    ceil32(len) bytes word-wise, returns via dynamic JUMP.
 */

import { selectorOf } from '../abi/artifact.js';
import type { AsmWriter, LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { selectorBytes } from '../core/bytes.js';
import type { Hex } from '../core/types.js';
import type { SiteId } from '../ir/nodes.js';
import type { SharedTails } from './abi.js';

// ---------------------------------------------------------------------------
// selectors (computed once — architecture §11)
// ---------------------------------------------------------------------------

/** `bytes4(keccak256("Panic(uint256)"))` — solc's panic selector (evm-target §5). */
const PANIC_SELECTOR: Hex = '0x4e487b71';
const DECODE_ERROR_SELECTOR: Hex = selectorOf('EvsDecodeError', ['uint256']);
const INVALID_CALLDATA_SELECTOR: Hex = selectorOf('EvsInvalidCalldata', []);

/** `PUSH4 <sel> PUSH1 0xE0 SHL PUSH0 MSTORE` — selector word into mem[0..32). Net stack 0. */
function emitSelectorStore(w: AsmWriter, selector: Hex): void {
  w.pushBytes(selectorBytes(selector, 'codegen/tails'), { note: `selector ${selector}` });
  w.push(0xe0);
  w.op('SHL'); // [selWord, …]
  w.push(0);
  w.op('MSTORE'); // […]
}

// ---------------------------------------------------------------------------
// label allocation + emission
// ---------------------------------------------------------------------------

/**
 * Allocates every `SharedTails` label on `w`. `memcpy` is `null` on cancun (MCOPY inlines).
 * Call once per program, before any emitter references the tails; emit the bodies with
 * `emitSharedTails` after the last code region (and before any data segments).
 */
export function createSharedTails(w: AsmWriter, opts: { evmVersion: EvmVersion }): SharedTails {
  return {
    panicOverflow: w.newLabel('panic_overflow'),
    panicDivZero: w.newLabel('panic_divzero'),
    panicBounds: w.newLabel('panic_bounds'),
    panicAlloc: w.newLabel('panic_alloc'),
    invalidCalldata: w.newLabel('badcd'),
    decodeRevert: w.newLabel('decode_revert'),
    memcpy: opts.evmVersion === 'cancun' ? null : w.newLabel('memcpy'),
  };
}

/**
 * Per-site decode-fail stub (strict-mode `s.call` sites — architecture §7.2 step 6):
 *
 *   @dfail_<site>: JUMPDEST PUSH<k> <site> PUSH2 @decode_revert JUMP   ('any')
 *
 * `emitStaticCall` only *references* `plan.dfailLabel` in strict mode; the program assembler
 * (M8 `lowerProgram`, or a test harness) must place one stub per strict call site.
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
 * Emits every shared tail body: the four panic stubs + `@panic` core, `@badcd`
 * (`EvsInvalidCalldata()`), `@decode_revert` (`EvsDecodeError(uint256 site)` — site pushed by
 * the per-site stub), and the `@memcpy` subroutine when `tails.memcpy` is non-null.
 *
 * Must be emitted after all code that can fall through (every tail is unreachable by
 * fallthrough: panic/revert tails are `'any'` regions ending in REVERT; `@memcpy` is a
 * checked subroutine entered only by `emitMemCopy` calls).
 */
export function emitSharedTails(
  w: AsmWriter,
  tails: SharedTails,
  _opts: { evmVersion: EvmVersion },
): void {
  // -- panic stubs + core (§15.0) ------------------------------------------------------
  const panic = w.newLabel('panic');
  const stubs: readonly [LabelId, number][] = [
    [tails.panicOverflow, 0x11],
    [tails.panicDivZero, 0x12],
    [tails.panicBounds, 0x32],
    [tails.panicAlloc, 0x41],
  ];
  for (const [label, code] of stubs) {
    w.label(label, 'any');
    w.push(code, { note: `panic code 0x${code.toString(16)}` });
    w.pushLabel(panic);
    w.op('JUMP');
  }
  w.label(panic, 'any'); // [code, …dead]
  emitSelectorStore(w, PANIC_SELECTOR); // [code, …]
  w.push(4);
  w.op('MSTORE'); // mem[4..36) = code
  w.push(0x24);
  w.push(0);
  w.op('REVERT', { note: 'Panic(code)' }); // revert(0, 36)

  // -- @decode_revert: EvsDecodeError(uint256 site) (§11) -------------------------------
  w.label(tails.decodeRevert, 'any'); // [site, …dead]
  emitSelectorStore(w, DECODE_ERROR_SELECTOR);
  w.push(4);
  w.op('MSTORE'); // mem[4..36) = site
  w.push(0x24);
  w.push(0);
  w.op('REVERT', { note: 'EvsDecodeError(site)' }); // revert(0, 36)

  // -- @badcd: EvsInvalidCalldata() (§11) ------------------------------------------------
  w.label(tails.invalidCalldata, 'any');
  emitSelectorStore(w, INVALID_CALLDATA_SELECTOR);
  w.push(4);
  w.push(0);
  w.op('REVERT', { note: 'EvsInvalidCalldata()' }); // revert(0, 4)

  // -- @memcpy word-loop subroutine (pre-cancun only — §10) ------------------------------
  if (tails.memcpy !== null) emitMemcpySubroutine(w, tails.memcpy);
}

/**
 * The shared `@memcpy` subroutine. Entry (checked, absolute height 4): `[ret, dst, src, len]`
 * — `emitMemCopy` pushes the return label over the caller's `[dst, src, len]`, which the
 * convention requires to be the *entire* stack. Copies `ceil32(len)` bytes in 32-byte words
 * (over-copy of the trailing partial word is the caller's contract — they zero-pad after),
 * then returns via dynamic JUMP with everything consumed.
 */
function emitMemcpySubroutine(w: AsmWriter, entry: LabelId): void {
  const loop = w.newLabel('memcpy_loop');
  const done = w.newLabel('memcpy_done');
  w.label(entry, 4); // [ret, dst, src, len]
  w.op('SWAP3'); // [len, dst, src, ret]
  w.push(31);
  w.op('ADD');
  w.push(5);
  w.op('SHR'); // [n = ceil32(len)/32, dst, src, ret]
  w.label(loop, 4);
  w.op('DUP1');
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [n, dst, src, ret]
  w.op('DUP3');
  w.op('MLOAD'); // [word, n, dst, src, ret]
  w.op('DUP3');
  w.op('MSTORE'); // [n, dst, src, ret]      mem[dst] = word
  w.op('SWAP1');
  w.push(32);
  w.op('ADD');
  w.op('SWAP1'); // dst += 32
  w.op('SWAP2');
  w.push(32);
  w.op('ADD');
  w.op('SWAP2'); // src += 32
  w.push(1);
  w.op('SWAP1');
  w.op('SUB'); // [n−1, dst, src, ret]
  w.pushLabel(loop);
  w.op('JUMP');
  w.label(done, 4); // [0, dst, src, ret]
  w.op('POP');
  w.op('POP');
  w.op('POP'); // [ret]
  w.op('JUMP', { note: 'memcpy return' }); // dynamic return jump (checked region)
}
