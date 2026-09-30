/**
 * `codegen/memory.ts` — the fixed low-memory map every emitter shares.
 *
 * | offset | role                                                                     |
 * | ------ | ------------------------------------------------------------------------ |
 * | `0x00` | scratch word 0 — intra-template temporary                                |
 * | `0x20` | scratch word 1 — intra-template temporary                                |
 * | `0x40` | free-memory pointer                                                      |
 * | `0x60` | zero slot — never written, so it reads as the empty memref `[len = 0]`   |
 * | `0x80` | start of the static frame (`codegen/frame.ts`)                           |
 *
 * The two scratch words are never live across a statement boundary. Each emitter aliases them
 * under a role name, and the phases that share a word never overlap:
 * - `0x00`: the running tail cursor of the return encoder / calldata templates (`TAIL_CURSOR` in
 *   `abi.ts` and `call.ts`), and the returndata snapshot base during output decode (`SNAP_SLOT`
 *   in `call.ts` — live only after the call, once the calldata cursor is dead);
 * - `0x20`: the composite-array element base during *decode* (`ELEM_BASE` in `abi.ts`), the
 *   data-literal staging base during tuple-arg *encode* (`STAGING_SLOT` in `call.ts`), and the
 *   wrapper argsSize across the simulate payload copy (`SIM_ARGSIZE_SLOT` in `call.ts`).
 */

/** Scratch word 0 (see the module header for its owners). */
export const SCRATCH_0 = 0x00;

/** Scratch word 1 (see the module header for its owners). */
export const SCRATCH_1 = 0x20;

/** Free-memory-pointer slot. */
export const FREE_PTR = 0x40;

/** The never-written zero slot: an empty memref for string/bytes/`T[]` zero values. */
export const ZERO_SLOT = 0x60;

/** Start of the static frame (just above the zero slot). */
export const FRAME_BASE = 0x80;

/** 2^64 − 1 — the overflow-free bound for every decoded offset/length. */
export const MAX_U64 = 0xffffffffffffffffn;
