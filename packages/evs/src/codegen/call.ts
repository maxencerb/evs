/**
 * M7 `codegen/call.ts` — the STATICCALL site emitter (architecture §7, exactly).
 *
 * Contract: docs/design/module-interfaces.md §M7 (frozen) with one recorded deviation: the
 * law's `CallSitePlan` carries no location for the call *target* (and optional gas cap) even
 * though `emitStaticCall` cannot emit `STATICCALL` without them — `targetRef` (required) and
 * `gasRef` (optional) are added here, mirroring `argRefs`' `SlotRef | { literal: ConstData }`
 * shape.
 *
 * Shapes (architecture §7 / §15.2):
 * - CalldataTemplate: compile-time const segments (selector + every literal arg, merged),
 *   `word` segments (runtime word slots MSTOREd at their head offsets), `dyn` segments
 *   (runtime memrefs: head offset word + tail copied via `emitMemCopy` with explicit
 *   zero-padding). All-literal calls collapse to one const segment: ≤ 96 bytes →
 *   PUSH-chunked MSTOREs; larger → data segment + CODECOPY. The buffer lives at transient
 *   scratch `MLOAD(0x40)` and is NOT bumped.
 * - `STATICCALL(gas, addr, buf, argsSize, 0, 0)` — retSize 0 always; returndata is fetched
 *   via the two sanctioned RETURNDATACOPY shapes only (`w.returndatacopyAll`).
 * - strict failure → verbatim bubble; decode failure → `plan.dfailLabel` (an `'any'` stub the
 *   program assembler emits — `codegen/tails.ts` `emitDecodeFailStub`).
 * - `rds ≥ 32·nOutputs` guard BEFORE any head read; then snapshot the whole returndata to a
 *   fresh allocation and bump the free pointer.
 * - word outputs normalize-don't-revert; dynamic outputs validate in place (2^64 guards,
 *   overflow-free bounds) aliasing the snapshot; array elements normalize eagerly.
 * - try mode: `plan.dfailLabel` IS the zero block, emitted inline here as a *checked* label
 *   (it rejoins the program): every failure path cleans its stack to height 0 and jumps to
 *   it; it zeroes `successOut`/word outs and points memref outs at the `0x60` zero slot, then
 *   falls through to the join.
 */

import { headBytes, layoutOf, layoutOfType, type TypeLayout } from '../abi/layout.js';
import type { AsmWriter, LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { EvsInternalError } from '../core/errors.js';
import {
  abiParamToType,
  isDynamicType,
  isTupleType,
  typesEqual,
  type EvsType,
  type Hex,
  type NamedType,
} from '../core/types.js';
import type { ConstData, SiteId, Stmt } from '../ir/nodes.js';
import {
  emitDecodeArrayToMem,
  emitDecodeTupleToMem,
  emitEncodeBlock,
  emitMemCopy,
  emitNormalizeElemsLoop,
  emitNormalizeWord,
  encodeFramesOf,
  headOffsetsOf,
  reserveEncodeFrames,
  needsMemorySnapshot,
  wordNeedsNormalize,
  type PushBase,
  type PushWord,
  type SharedTails,
  type SlotRef,
} from './abi.js';

// ---------------------------------------------------------------------------
// frozen contract types (module-interfaces §M7 + recorded targetRef/gasRef deviation)
// ---------------------------------------------------------------------------

export interface CallSitePlan {
  stmt: Extract<Stmt, { k: 'call' }>;
  /** Where the callee address lives (slot or folded literal). DEVIATION: see module header. */
  targetRef: SlotRef | { literal: ConstData };
  /** Optional gas cap operand (slot or folded literal); absent → forward all via GAS. */
  gasRef?: SlotRef | { literal: ConstData };
  argRefs: readonly (SlotRef | { literal: ConstData })[];
  outRefs: readonly SlotRef[];
  successRef: SlotRef | null;
  dfailLabel: LabelId; // per-site stub target (strict) or zero-block (try)
  siteId: SiteId;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const MAX_U64 = 0xffffffffffffffffn;
const FREE_PTR = 0x40;
const TAIL_CURSOR = 0x00; // scratch — calldata-template tail cursor (transient)
const SNAP_SLOT = 0x00; // scratch — returndata snapshot base during tuple-output decode (transient,
//                         dead once the calldata cursor's job is done — the call already happened)
const ZERO_SLOT = 0x60;

/** Const segments at or under this size are PUSH-chunked; larger ones go to a data segment. */
const CONST_SEGMENT_INLINE_MAX = 96;

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/call: ${message}`);
}

/** Human-readable rendering of a value type for error messages (tuples → their JSON descriptor). */
function fmtType(t: EvsType): string {
  return typeof t === 'string' ? t : JSON.stringify(t);
}

function isLiteralRef(ref: SlotRef | { literal: ConstData }): ref is { literal: ConstData } {
  return 'literal' in ref;
}

function hexToBytes(hex: Hex, what: string): Uint8Array {
  const body = hex.slice(2);
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw internal(`${what}: malformed hex ${hex}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function literalWordValue(data: ConstData, what: string): bigint {
  if (data.kind !== 'word') throw internal(`${what}: expected a word literal, got '${data.kind}'`);
  const bytes = hexToBytes(data.hex, what);
  if (bytes.length !== 32) throw internal(`${what}: word literal must be 32 bytes`);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function literalDataBytes(data: ConstData, what: string): Uint8Array {
  if (data.kind !== 'data') throw internal(`${what}: expected a data literal, got '${data.kind}'`);
  const bytes = hexToBytes(data.hex, what);
  if (bytes.length < 32 || bytes.length % 32 !== 0) {
    throw internal(`${what}: data literal must be a padded [len][payload…] image`);
  }
  return bytes;
}

function u256Bytes(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * Pushes the 32-byte chunk's word value with the smallest encoding: minimal-width PUSH for
 * the significant prefix, plus a SHL when the chunk has trailing zero bytes (this reproduces
 * the `PUSH4 <sel> PUSH1 0xE0 SHL` selector idiom for free).
 */
function emitPushWordChunk(w: AsmWriter, chunk: Uint8Array, note?: string): void {
  let v = 0n;
  for (const b of chunk) v = (v << 8n) | BigInt(b);
  const meta = note === undefined ? {} : { note };
  if (v === 0n) {
    w.push(0, meta);
    return;
  }
  let tz = 0;
  while (tz < 31 && chunk[31 - tz] === 0) tz += 1;
  if (tz === 0) {
    w.push(v, meta);
    return;
  }
  w.push(v >> BigInt(8 * tz), meta);
  w.push(8 * tz);
  w.op('SHL');
}

// ---------------------------------------------------------------------------
// CalldataTemplate — compile-time const folding (architecture §7.1)
// ---------------------------------------------------------------------------

interface ConstRun {
  offset: number;
  bytes: Uint8Array;
}

type DynPart = { headOffset: number } & (
  | { kind: 'literal'; bytes: Uint8Array }
  | { kind: 'slot'; slot: number; isArray: boolean }
);

interface CalldataTemplate {
  /** `'static'` — every byte position is compile-time known (no runtime dynamic args). */
  regime: 'static' | 'dynamic';
  /** Merged const byte runs at compile-time-known offsets (selector, literal heads/tails). */
  constRuns: readonly ConstRun[];
  /** Runtime word args: canonical slot word → head offset. */
  runtimeWords: readonly { offset: number; slot: number }[];
  /** Dynamic args in arg order (regime 'dynamic' only — runtime tail cursor). */
  dynParts: readonly DynPart[];
  /** Total calldata size in the 'static' regime; head-region size (4 + 32·n) otherwise. */
  staticSize: number;
}

function buildTemplate(plan: CallSitePlan): CalldataTemplate {
  const { fnAbi } = plan.stmt;
  const inputs = fnAbi.inputs;
  if (inputs.length !== plan.argRefs.length) {
    throw internal(
      `call to ${fnAbi.name}: ${inputs.length} ABI input(s) but ${plan.argRefs.length} arg ref(s)`,
    );
  }
  const selector = hexToBytes(fnAbi.selector, `selector of ${fnAbi.name}`);
  if (selector.length !== 4) throw internal(`selector of ${fnAbi.name} must be 4 bytes`);

  const layouts: TypeLayout[] = inputs.map((p) => layoutOf(p.type));
  const headEnd = 4 + 32 * inputs.length;
  const hasRuntimeDyn = layouts.some((l, i) => {
    const ref = plan.argRefs[i];
    return ref !== undefined && l.kind !== 'word' && !isLiteralRef(ref);
  });

  const runtimeWords: { offset: number; slot: number }[] = [];
  const dynParts: DynPart[] = [];

  // first pass — total size in the static regime
  let staticSize = headEnd;
  if (!hasRuntimeDyn) {
    layouts.forEach((l, i) => {
      const ref = plan.argRefs[i];
      if (ref === undefined || l.kind === 'word' || !isLiteralRef(ref)) return;
      staticSize += literalDataBytes(ref.literal, `arg #${i} of ${fnAbi.name}`).length;
    });
  }

  const image = new Uint8Array(hasRuntimeDyn ? headEnd : staticSize);
  const known = new Uint8Array(image.length); // 1 = const byte
  const place = (offset: number, bytes: Uint8Array): void => {
    image.set(bytes, offset);
    known.fill(1, offset, offset + bytes.length);
  };
  place(0, selector);

  let tailPos = headEnd;
  layouts.forEach((l, i) => {
    const ref = plan.argRefs[i];
    if (ref === undefined) throw internal(`missing arg ref #${i}`);
    const headOffset = 4 + 32 * i;
    const what = `arg #${i} of ${fnAbi.name}`;
    if (l.kind === 'word') {
      if (isLiteralRef(ref)) {
        const bytes = hexToBytes(ref.literal.hex, what);
        if (ref.literal.kind !== 'word' || bytes.length !== 32) {
          throw internal(`${what}: word arg requires a 32-byte word literal`);
        }
        place(headOffset, bytes);
      } else {
        runtimeWords.push({ offset: headOffset, slot: ref.slot });
      }
      return;
    }
    // dynamic arg. A composite-element array call arg (`tuple[]`/`T[][]`/`string[]`) is routed to the
    // recursive encoder (`emitCalldataBuildTuples`) by `emitStaticCall`'s `needsRecursiveEncode`
    // dispatch and never reaches the template path — this backstop catches a routing regression that
    // would otherwise silently mis-encode a composite array as a word-array memref tail.
    if (l.kind === 'array' && l.elem.kind !== 'word') {
      throw internal(
        `${what}: composite-element array call arg reached the template encoder (should route to emitCalldataBuildTuples)`,
      );
    }
    if (isLiteralRef(ref)) {
      const bytes = literalDataBytes(ref.literal, what);
      if (hasRuntimeDyn) {
        dynParts.push({ headOffset, kind: 'literal', bytes });
      } else {
        place(headOffset, u256Bytes(BigInt(tailPos - 4)));
        place(tailPos, bytes);
        tailPos += bytes.length;
      }
    } else {
      dynParts.push({ headOffset, kind: 'slot', slot: ref.slot, isArray: l.kind === 'array' });
    }
  });

  // merge const runs
  const constRuns: ConstRun[] = [];
  let runStart = -1;
  for (let i = 0; i <= image.length; i++) {
    const isConst = i < image.length && known[i] === 1;
    if (isConst && runStart === -1) runStart = i;
    if (!isConst && runStart !== -1) {
      constRuns.push({ offset: runStart, bytes: image.slice(runStart, i) });
      runStart = -1;
    }
  }

  return {
    regime: hasRuntimeDyn ? 'dynamic' : 'static',
    constRuns,
    runtimeWords,
    dynParts,
    staticSize,
  };
}

// ---------------------------------------------------------------------------
// calldata build emission
// ---------------------------------------------------------------------------

/** Const run at a compile-time-known buffer offset: PUSH-chunked MSTOREs or CODECOPY. */
function emitConstRun(w: AsmWriter, run: ConstRun, dataSeg: (bytes: Uint8Array) => LabelId): void {
  if (run.bytes.length > CONST_SEGMENT_INLINE_MAX) {
    const label = dataSeg(run.bytes);
    w.push(run.bytes.length, { note: `const segment ${run.bytes.length}B` });
    w.pushLabel(label); // [src, size]
    w.push(FREE_PTR);
    w.op('MLOAD'); // [buf, src, size]
    if (run.offset !== 0) {
      w.push(run.offset);
      w.op('ADD');
    }
    w.op('CODECOPY'); // []
    return;
  }
  for (let k = 0; k < run.bytes.length; k += 32) {
    const chunk = new Uint8Array(32);
    chunk.set(run.bytes.slice(k, k + 32));
    emitPushWordChunk(w, chunk, k === 0 ? 'const calldata' : undefined); // [val]
    w.push(FREE_PTR);
    w.op('MLOAD'); // [buf, val]
    const offset = run.offset + k;
    if (offset !== 0) {
      w.push(offset);
      w.op('ADD');
    }
    w.op('MSTORE'); // []
  }
}

/** Const bytes at the runtime tail cursor (regime 'dynamic' literal-dyn tails). */
function emitConstBytesAtCursor(
  w: AsmWriter,
  bytes: Uint8Array,
  dataSeg: (bytes: Uint8Array) => LabelId,
): void {
  if (bytes.length > CONST_SEGMENT_INLINE_MAX) {
    const label = dataSeg(bytes);
    w.push(bytes.length, { note: `const tail ${bytes.length}B` });
    w.pushLabel(label); // [src, size]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [dst, src, size]
    w.op('CODECOPY'); // []
    return;
  }
  for (let k = 0; k < bytes.length; k += 32) {
    const chunk = new Uint8Array(32);
    chunk.set(bytes.slice(k, k + 32));
    emitPushWordChunk(w, chunk); // [val]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tail, val]
    if (k !== 0) {
      w.push(k);
      w.op('ADD');
    }
    w.op('MSTORE'); // []
  }
}

/** Builds the calldata template into transient scratch at `MLOAD(0x40)`. Net stack 0. */
function emitCalldataBuild(
  w: AsmWriter,
  template: CalldataTemplate,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  dataSeg: (bytes: Uint8Array) => LabelId,
): void {
  // const runs first (their padded chunk writes only spill into regions written later)
  for (const run of template.constRuns) emitConstRun(w, run, dataSeg);

  // runtime word heads — slots hold canonical words, which IS the ABI encoding
  for (const { offset, slot } of template.runtimeWords) {
    w.push(slot);
    w.op('MLOAD'); // [v]
    w.push(FREE_PTR);
    w.op('MLOAD'); // [buf, v]
    if (offset !== 0) {
      w.push(offset);
      w.op('ADD');
    }
    w.op('MSTORE'); // []
  }

  if (template.regime === 'static') return;

  // -- runtime tail cursor phase (scratch 0x00 holds the absolute next-tail address) ------
  w.push(template.staticSize); // head-region size = 4 + 32·n
  w.push(FREE_PTR);
  w.op('MLOAD');
  w.op('ADD'); // [tail0]
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []

  for (const part of template.dynParts) {
    // head: MSTORE(buf + headOffset, tail − buf − 4)
    w.push(4);
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.op('ADD'); // [buf+4]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tail, buf+4]
    w.op('SUB'); // [rel]
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.push(part.headOffset);
    w.op('ADD'); // [headAddr, rel]
    w.op('MSTORE'); // []

    if (part.kind === 'literal') {
      emitConstBytesAtCursor(w, part.bytes, dataSeg);
      w.push(part.bytes.length);
      w.push(TAIL_CURSOR);
      w.op('MLOAD');
      w.op('ADD'); // [tail']
      w.push(TAIL_CURSOR);
      w.op('MSTORE'); // []
      continue;
    }

    const { slot, isArray } = part;
    /** Reload the memref's payload byte count onto the stack. */
    const pushNBytes = (): void => {
      w.push(slot);
      w.op('MLOAD');
      w.op('MLOAD'); // [len]
      if (isArray) {
        w.push(5);
        w.op('SHL'); // [32·len]
      }
    };

    // length word: MSTORE(tail, len)
    w.push(slot);
    w.op('MLOAD');
    w.op('MLOAD'); // [len]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tail, len]
    w.op('MSTORE'); // []

    // payload copy at exactly [dst, src, len] (memcpy convention)
    pushNBytes(); // [n]
    w.push(slot);
    w.op('MLOAD');
    w.push(32);
    w.op('ADD'); // [src, n]
    w.push(TAIL_CURSOR);
    w.op('MLOAD');
    w.push(32);
    w.op('ADD'); // [dst, src, n]
    emitMemCopy(w, tails, opts); // []

    if (!isArray) {
      // explicit zero-pad of the trailing partial word (after the copy — the pre-cancun
      // word loop over-copies whole words)
      w.push(0); // [0]
      pushNBytes(); // [n, 0]
      w.push(TAIL_CURSOR);
      w.op('MLOAD');
      w.op('ADD'); // [tail+n, 0]
      w.push(32);
      w.op('ADD'); // [tail+32+n, 0]
      w.op('MSTORE'); // []
    }

    // tail += 32 + ceil32(n) (arrays are word-exact already)
    pushNBytes(); // [n]
    if (!isArray) {
      w.push(31);
      w.op('ADD');
      w.push(31);
      w.op('NOT');
      w.op('AND'); // [ceil32(n)]
    }
    w.push(32);
    w.op('ADD'); // [inc]
    w.push(TAIL_CURSOR);
    w.op('MLOAD');
    w.op('ADD'); // [tail']
    w.push(TAIL_CURSOR);
    w.op('MSTORE'); // []
  }
}

/**
 * Pushes a zero value of `type` onto the stack (net +1): `0` for a word, the `0x60` zero slot for
 * a string/bytes/T[] (an empty memref), or a freshly-allocated zero-filled flat block for a tuple
 * (its dynamic members point at `0x60`, nested tuples recurse). Matches the interpreter's
 * `zeroValue`. Used by the try-mode zero block.
 */
function emitZeroValue(w: AsmWriter, type: EvsType): void {
  if (!isTupleType(type)) {
    w.push(isDynamicType(type) ? ZERO_SLOT : 0);
    return;
  }
  const n = type.components.length;
  // allocate 32·n, zero-fill via CALLDATACOPY past the calldata end (memory above freePtr is dirty)
  w.push(FREE_PTR);
  w.op('MLOAD'); // [flat]
  w.op('DUP1');
  w.push(32 * n);
  w.op('ADD'); // [flat+32n, flat]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [flat]   freePtr bumped
  w.push(32 * n);
  w.op('CALLDATASIZE');
  w.op('DUP3'); // [flat, cds, 32n, flat]
  w.op('CALLDATACOPY', { note: 'zero-fill tuple' }); // [flat]
  // set non-word members: dynamic → 0x60; nested tuple → its own zero block
  type.components.forEach((c, j) => {
    const ct = abiParamToType(c);
    if (!isDynamicType(ct)) return; // word member stays 0 (zero-filled)
    emitZeroValue(w, ct); // [member, flat]
    w.op('DUP2'); // [flat, member, flat]
    if (j !== 0) {
      w.push(32 * j);
      w.op('ADD');
    }
    w.op('MSTORE'); // [flat]
  });
}

// ---------------------------------------------------------------------------
// tuple-bearing calldata build — the recursive encoder (architecture §3/§7.1/§8)
// ---------------------------------------------------------------------------

/** Scratch slot holding the data-literal staging base for the duration of a tuple-bearing build. */
const STAGING_SLOT = 0x20;

/**
 * Builds the calldata for a subcall that has at least one tuple arg, via the recursive head/tail
 * encoder (`emitEncodeBlock`). No const-folding: the whole args region is encoded as a synthetic
 * tuple whose member sources are the arg refs (word literal → PUSH; data literal → a memref staged
 * in fresh memory; slot → `MLOAD(slot)` canonical word or memref pointer). The selector occupies
 * `[buf, buf+4)`; heads start at `buf+4`. The tail cursor lives in scratch `TAIL_CURSOR` (so
 * `emitStaticCall` reads `argsSize = MLOAD(TAIL_CURSOR) − buf`), the staging base in `STAGING_SLOT`.
 * Net stack 0.
 */
function emitCalldataBuildTuples(
  w: AsmWriter,
  plan: CallSitePlan,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  dataSeg: (bytes: Uint8Array) => LabelId,
): void {
  const { fnAbi } = plan.stmt;
  const inputs = fnAbi.inputs;
  if (inputs.length !== plan.argRefs.length) {
    throw internal(
      `call to ${fnAbi.name}: ${inputs.length} ABI input(s) but ${plan.argRefs.length} arg ref(s)`,
    );
  }
  const selector = hexToBytes(fnAbi.selector, `selector of ${fnAbi.name}`);
  if (selector.length !== 4) throw internal(`selector of ${fnAbi.name} must be 4 bytes`);

  // Composite-element array CALL ARGS (`tuple[]` directly, or a tuple arg whose member is a
  // `tuple[]`/`T[][]`/`string[]`) encode through the §12.7 scratch-frame loop, which keeps its loop
  // state in a reserved in-memory frame region rather than on the stack. The return encoder reserves
  // those frames below its output buffer; here the call-arg buffer is transient (the free pointer is
  // NOT bumped for it), so we reserve the frames just below the buffer base by bumping the free
  // pointer once — AFTER the data-literal staging block, and BEFORE `MLOAD(0x40)` (the buffer base)
  // is read for the selector/heads/encode. FRAMES = the max concurrent array-nesting depth across all
  // args (`tuple[]` = 1; a `tuple[]` whose member is `T[][]` = 2; …). `pushFrameSlot` then resolves
  // each frame relative to `MLOAD(0x40)`, exactly as in the return encoder.
  const frames = inputs.reduce(
    (n, p) => Math.max(n, encodeFramesOf(layoutOfType(abiParamToType(p)))),
    0,
  );

  // -- data-literal staging layout (compile-time): each data-literal arg gets a padded image at a
  //    cumulative offset within the staging block.
  const stagingOffsets = new Map<number, number>();
  let stagingSize = 0;
  inputs.forEach((p, i) => {
    const ref = plan.argRefs[i];
    if (ref === undefined || !isLiteralRef(ref) || ref.literal.kind !== 'data') return;
    const bytes = literalDataBytes(ref.literal, `arg #${i} of ${fnAbi.name}`);
    stagingOffsets.set(i, stagingSize);
    stagingSize += bytes.length; // images are already 32-aligned (validated)
  });

  // allocate + fill the staging block (if any); base in scratch STAGING_SLOT, freePtr bumped
  if (stagingSize > 0) {
    w.push(FREE_PTR);
    w.op('MLOAD'); // [stage]
    w.op('DUP1');
    w.push(stagingSize);
    w.op('ADD'); // [stage+size, stage]
    w.push(FREE_PTR);
    w.op('MSTORE'); // [stage]   freePtr bumped past staging
    w.op('DUP1');
    w.push(STAGING_SLOT);
    w.op('MSTORE'); // [stage]   scratch[STAGING_SLOT] = stage base
    inputs.forEach((p, i) => {
      const off = stagingOffsets.get(i);
      if (off === undefined) return;
      const ref = plan.argRefs[i];
      if (ref === undefined || !isLiteralRef(ref)) return;
      const bytes = literalDataBytes(ref.literal, `arg #${i} of ${fnAbi.name}`);
      const label = dataSeg(bytes);
      // CODECOPY(stage + off, dataLabel, bytes.length)
      w.push(bytes.length, { note: `stage arg #${i} literal (${bytes.length}B)` });
      w.pushLabel(label); // [src, size, stage]
      w.op('DUP3'); // [stage, src, size, stage]
      if (off !== 0) {
        w.push(off);
        w.op('ADD');
      } // [dst, src, size, stage]
      w.op('CODECOPY'); // [stage]
    });
    w.op('POP'); // []
  }

  // -- reserve the composite-array encode loop frames just below the (transient) buffer base ----
  // (§12.7). After this bump, `MLOAD(0x40)` is the buffer base and frame f sits at
  // `[base − 32·FRAME_SLOTS·(f+1), base − 32·FRAME_SLOTS·f)`; the encode below never bumps the free
  // pointer again (tails are written at TAIL_CURSOR), so the buffer base stays fixed throughout.
  reserveEncodeFrames(w, frames, `reserve ${frames} call-arg array-encode frame(s)`);

  // -- selector at buf[0..4): MSTORE(buf, selector << 224) (heads at buf+4 overwrite [4,36)) ----
  let selWord = 0n;
  for (const b of selector) selWord = (selWord << 8n) | BigInt(b);
  selWord <<= 224n;
  w.push(selWord, { note: `selector ${fnAbi.name}` });
  w.push(FREE_PTR);
  w.op('MLOAD');
  w.op('MSTORE'); // []

  // -- tail cursor := buf + 4 + headBytes(inputs) ---------------------------------------------
  // PlainAbiParam is structurally a NamedType (name/type/optional components).
  const argParams: readonly NamedType[] = inputs;
  const headSize = headBytes(inputs);
  w.push(FREE_PTR);
  w.op('MLOAD');
  w.push(4 + headSize);
  w.op('ADD'); // [tail0]
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []

  // -- encode the args block: base = buf + 4 -------------------------------------------------
  const pushSrc: PushWord = (i) => {
    const ref = plan.argRefs[i];
    if (ref === undefined) throw internal(`missing arg ref #${i}`);
    if (isLiteralRef(ref)) {
      if (ref.literal.kind === 'word') {
        w.push(literalWordValue(ref.literal, `arg #${i} of ${fnAbi.name}`)); // [word]
        return;
      }
      // data literal: push the staged memref pointer
      const off = stagingOffsets.get(i);
      if (off === undefined) throw internal(`arg #${i} data literal has no staging offset`);
      w.push(STAGING_SLOT);
      w.op('MLOAD');
      if (off !== 0) {
        w.push(off);
        w.op('ADD');
      } // [ptr]
      return;
    }
    w.push(ref.slot);
    w.op('MLOAD'); // [canonical word | memref pointer]
  };
  const pushBase: PushBase = () => {
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.push(4);
    w.op('ADD'); // [buf+4]
  };
  emitEncodeBlock(w, argParams, pushSrc, pushBase, tails, opts);
}

// ---------------------------------------------------------------------------
// emitStaticCall — architecture §7 / §15.2
// ---------------------------------------------------------------------------

export function emitStaticCall(
  w: AsmWriter,
  plan: CallSitePlan,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  dataSeg: (bytes: Uint8Array) => LabelId, // request a data segment, get its dataLabel
): void {
  const { stmt, siteId } = plan;
  const { fnAbi } = stmt;
  const outputs = fnAbi.outputs;
  const tryMode = stmt.mode === 'try';

  if (outputs.length !== plan.outRefs.length) {
    throw internal(
      `call to ${fnAbi.name} (site ${siteId}): ${outputs.length} ABI output(s) but ${plan.outRefs.length} out ref(s)`,
    );
  }
  outputs.forEach((out, j) => {
    const ref = plan.outRefs[j];
    if (ref !== undefined && !typesEqual(ref.type, abiParamToType(out))) {
      throw internal(
        `call to ${fnAbi.name} (site ${siteId}): output #${j} is ${out.type} but its slot is typed ${fmtType(ref.type)}`,
      );
    }
  });
  if (tryMode && plan.successRef === null) {
    throw internal(`try call to ${fnAbi.name} (site ${siteId}): successRef is required`);
  }
  if (!tryMode && plan.successRef !== null) {
    throw internal(`strict call to ${fnAbi.name} (site ${siteId}): successRef must be null`);
  }

  /**
   * try-mode failure router. Stack on entry: `[bad, …live]`; on exit (continue path):
   * `[…live]`. Strict mode jumps straight to the `'any'` dfail stub; try mode inverts the
   * branch, cleans the stack to height 0, and jumps to the (checked, height-0) zero block.
   */
  const emitDecodeFail = (liveDepth: number): void => {
    if (!tryMode) {
      w.pushLabel(plan.dfailLabel);
      w.op('JUMPI');
      return;
    }
    const cont = w.newLabel(`call_${siteId}_cont`);
    w.op('ISZERO');
    w.pushLabel(cont);
    w.op('JUMPI'); // […live]
    for (let k = 0; k < liveDepth; k++) w.op('POP');
    w.pushLabel(plan.dfailLabel);
    w.op('JUMP');
    w.label(cont, liveDepth);
  };

  // -- 1. calldata template into transient scratch (free pointer NOT bumped) -------------
  // tuple args AND composite-element array args (`tuple[]`/`T[][]`/`string[]`, here or inside a
  // tuple member) force the recursive encoder (no const-folding); argsSize then comes from the
  // tail cursor like the dynamic regime. Word/word-array/string/bytes args stay on the template path.
  const needsRecursiveEncode = fnAbi.inputs.some(
    (p) => p.type.startsWith('tuple') || encodeFramesOf(layoutOfType(abiParamToType(p))) > 0,
  );
  const template = needsRecursiveEncode ? null : buildTemplate(plan);
  if (template === null) {
    emitCalldataBuildTuples(w, plan, tails, opts, dataSeg);
  } else {
    emitCalldataBuild(w, template, tails, opts, dataSeg);
  }

  // -- 2. staticcall(gas, addr, buf, argsSize, 0, 0) --------------------------------------
  w.push(FREE_PTR);
  w.op('MLOAD'); // [buf]
  w.push(0); // [retSize, buf]
  w.push(0); // [retOff, retSize, buf]
  if (template !== null && template.regime === 'static') {
    w.push(template.staticSize); // [argsSize, …]
  } else {
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tailEnd, retOff, retSize, buf]
    w.op('DUP4'); // [buf, tailEnd, …]
    w.op('SWAP1'); // [tailEnd, buf, …]
    w.op('SUB'); // [argsSize, retOff, retSize, buf]
  }
  w.op('DUP4'); // [argsOff = buf, argsSize, retOff, retSize, buf]
  if (isLiteralRef(plan.targetRef)) {
    w.push(literalWordValue(plan.targetRef.literal, `target of ${fnAbi.name}`), {
      note: 'target',
    });
  } else {
    w.push(plan.targetRef.slot);
    w.op('MLOAD', { note: 'target' });
  }
  if (plan.gasRef === undefined) {
    w.op('GAS');
  } else if (isLiteralRef(plan.gasRef)) {
    w.push(literalWordValue(plan.gasRef.literal, `gas of ${fnAbi.name}`), { note: 'gas cap' });
  } else {
    w.push(plan.gasRef.slot);
    w.op('MLOAD', { note: 'gas cap' });
  }
  w.op('STATICCALL', {
    loc: stmt.loc,
    note: `${stmt.mode} call ${fnAbi.name} (site ${siteId})`,
  }); // [success, buf]

  const ok = w.newLabel(`call_ok_${siteId}`);
  w.pushLabel(ok);
  w.op('JUMPI'); // [buf]
  if (tryMode) {
    w.op('POP');
    w.pushLabel(plan.dfailLabel);
    w.op('JUMP'); // → zero block
  } else {
    // bubble the callee revert verbatim (RETURNDATACOPY shape 1)
    w.returndatacopyAll('zero'); // [buf]
    w.op('RETURNDATASIZE');
    w.push(0);
    w.op('REVERT', { note: 'bubble callee revert' }); // revert(0, rds)
  }
  w.label(ok, 1); // [buf]

  // -- 3. decode (guard BEFORE any head read; snapshot; normalize/validate) ---------------
  if (outputs.length > 0) {
    const headOffsets = headOffsetsOf(outputs); // cumulative (static tuple outputs inline)
    const minSize = headBytes(outputs);
    // tuple outputs AND composite-element array outputs (`tuple[]`/`T[][]`/`string[]`) decode from
    // the memory snapshot (SNAP_SLOT) via the recursive decoders — they need the scratch-resident
    // base/end (the decoders churn the free ptr, so a stack-resident base would drift).
    const hasTupleOut = outputs.some((p) => needsMemorySnapshot(layoutOfType(abiParamToType(p))));

    // staticMinSize guard: rds ≥ headBytes(outputs)
    w.op('RETURNDATASIZE');
    w.push(minSize, { note: `staticMinSize ${minSize}` });
    w.op('GT'); // [minSize > rds, buf]
    emitDecodeFail(1); // [buf]

    // snapshot ENTIRE returndata at buf (shape 2); freePtr = buf + ceil32(rds)
    w.returndatacopyAll({ dupDepth: 1 }); // [buf]
    w.op('RETURNDATASIZE');
    w.push(31);
    w.op('ADD');
    w.push(31);
    w.op('NOT');
    w.op('AND'); // [ceil32(rds), buf]
    w.op('DUP2');
    w.op('ADD'); // [buf + ceil32(rds), buf]
    w.push(FREE_PTR);
    w.op('MSTORE'); // [buf]

    // tuple outputs decode through scratch-resident buf (the decoder rebases the free ptr below
    // it, so a stack-resident buf would drift); SNAP_SLOT also yields the `end = buf + rds` bound.
    if (hasTupleOut) {
      w.op('DUP1');
      w.push(SNAP_SLOT);
      w.op('MSTORE'); // [buf]   scratch[SNAP_SLOT] = snapshot base
    }

    outputs.forEach((out, j) => {
      const ref = plan.outRefs[j];
      if (ref === undefined) throw internal(`missing out ref #${j}`);
      const type = abiParamToType(out);
      const layout = layoutOfType(type);
      const headOffset = headOffsets[j] ?? 32 * j;

      if (layout.kind === 'word') {
        w.op('DUP1');
        if (headOffset !== 0) {
          w.push(headOffset);
          w.op('ADD');
        }
        w.op('MLOAD'); // [raw, buf]
        emitNormalizeWord(w, layout.abi); // normalize-don't-revert
        w.push(ref.slot);
        w.op('MSTORE', { note: `out #${j} ${out.type}` }); // [buf]
        return;
      }

      if (layout.kind === 'tuple') {
        // decode the tuple from the snapshot into a flat-pointer block; alias dynamic members.
        // base/end are read from scratch so the decoder's free-ptr churn never disturbs them.
        const pushSnap = (): void => {
          w.push(SNAP_SLOT);
          w.op('MLOAD'); // [buf]
        };
        const pushEnd = (): void => {
          pushSnap();
          w.op('RETURNDATASIZE');
          w.op('ADD'); // [buf + rds]
        };
        const fail: typeof emitDecodeFail = emitDecodeFail;
        let pushBase: PushBase;
        if (layout.dynamic) {
          // offset word at buf+headOffset (relative to buf); bounds, then base = buf+off
          pushSnap();
          if (headOffset !== 0) {
            w.push(headOffset);
            w.op('ADD');
          }
          w.op('MLOAD'); // [off, buf]
          w.op('DUP1');
          w.push(MAX_U64);
          w.op('LT'); // [off > max, off, buf]
          emitDecodeFail(2); // [off, buf]
          pushSnap();
          w.op('ADD'); // [base, buf]
          w.op('DUP1');
          w.push(32);
          w.op('ADD'); // [base+32, base, buf]
          pushEnd();
          w.op('LT'); // [end < base+32, base, buf]
          emitDecodeFail(3); // [base, buf]
          w.op('POP'); // [buf]   (base is re-derived inside the thunk)
          pushBase = () => {
            pushSnap(); // [buf]
            w.op('DUP1');
            if (headOffset !== 0) {
              w.push(headOffset);
              w.op('ADD');
            }
            w.op('MLOAD'); // [off, buf]
            w.op('ADD'); // [base]
          };
        } else {
          pushBase = () => {
            pushSnap();
            if (headOffset !== 0) {
              w.push(headOffset);
              w.op('ADD');
            }
          };
        }
        if (!isTupleType(type)) throw internal(`out #${j} layout is tuple but type is not`);
        emitDecodeTupleToMem(w, type.components, pushBase, pushEnd, fail, 1); // [flat, buf]
        w.push(ref.slot);
        w.op('MSTORE', { note: `out #${j} tuple (flat block)` }); // [buf]
        return;
      }

      if (layout.kind === 'array' && layout.elem.kind !== 'word') {
        // composite-element array output (`tuple[]`/`T[][]`/`string[]`): decode from the snapshot
        // into a fresh `[len][p0…]` pointer block (its elements alias/recurse). base/end come from
        // SNAP_SLOT (the array decoder churns the free ptr, so a stack-resident base would drift),
        // exactly like the tuple-output path above. The head word at buf+headOffset is an offset
        // relative to buf; bounds it, then base = buf+off.
        const pushSnap = (): void => {
          w.push(SNAP_SLOT);
          w.op('MLOAD'); // [buf]
        };
        const pushEnd = (): void => {
          pushSnap();
          w.op('RETURNDATASIZE');
          w.op('ADD'); // [buf + rds]
        };
        // off bounds: off ≤ 2^64−1, off + 32 ≤ rds
        pushSnap();
        if (headOffset !== 0) {
          w.push(headOffset);
          w.op('ADD');
        }
        w.op('MLOAD'); // [off, buf]
        w.op('DUP1');
        w.push(MAX_U64);
        w.op('LT'); // [off > max, off, buf]
        emitDecodeFail(2); // [off, buf]
        w.op('DUP1');
        w.push(32);
        w.op('ADD'); // [off+32, off, buf]
        w.op('RETURNDATASIZE');
        w.op('LT'); // [rds < off+32, off, buf]
        emitDecodeFail(2); // [off, buf]
        w.op('POP'); // [buf]   (base re-derived inside the thunk)
        const pushArrBase: PushBase = () => {
          pushSnap(); // [buf]
          w.op('DUP1');
          if (headOffset !== 0) {
            w.push(headOffset);
            w.op('ADD');
          }
          w.op('MLOAD'); // [off, buf]
          w.op('ADD'); // [base]
        };
        emitDecodeArrayToMem(w, layout.elem, pushArrBase, pushEnd, emitDecodeFail, 1); // [arr, buf]
        w.push(ref.slot);
        w.op('MSTORE', { note: `out #${j} ${out.type} (pointer block)` }); // [buf]
        return;
      }

      const isArray = layout.kind === 'array';
      // off := snapshot[headOffset]; off ≤ 2^64−1; off + 32 ≤ rds
      w.op('DUP1');
      if (headOffset !== 0) {
        w.push(headOffset);
        w.op('ADD');
      }
      w.op('MLOAD'); // [off, buf]
      w.push(MAX_U64);
      w.op('DUP2');
      w.op('GT'); // [off > max, off, buf]
      emitDecodeFail(2); // [off, buf]
      w.op('DUP1');
      w.push(32);
      w.op('ADD'); // [off+32, off, buf]
      w.op('RETURNDATASIZE');
      w.op('LT'); // [rds < off+32, off, buf]
      emitDecodeFail(2); // [off, buf]

      // ptr := buf + off; len checks: len ≤ 2^64−1, off + 32 + nbytes ≤ rds
      w.op('DUP2');
      w.op('ADD'); // [ptr, buf]
      w.op('DUP1');
      w.op('MLOAD'); // [len, ptr, buf]
      w.push(MAX_U64);
      w.op('DUP2');
      w.op('GT'); // [len > max, len, ptr, buf]
      emitDecodeFail(3); // [len, ptr, buf]
      if (isArray) {
        w.push(5);
        w.op('SHL'); // [nbytes = 32·len, ptr, buf]
      }
      w.op('DUP2');
      w.push(32);
      w.op('ADD');
      w.op('ADD'); // [end = ptr + 32 + nbytes, ptr, buf]
      w.op('RETURNDATASIZE');
      w.op('DUP4');
      w.op('ADD'); // [buf+rds, end, ptr, buf]
      w.op('LT'); // [buf+rds < end, ptr, buf]
      emitDecodeFail(2); // [ptr, buf]

      if (layout.kind === 'array') {
        // word-element array (composite-element arrays were handled above): eager element
        // normalization over the aliased snapshot region.
        if (layout.elem.kind !== 'word') {
          throw internal('composite-element array reached the word-array decode path');
        }
        const elemAbi = layout.elem.abi;
        if (wordNeedsNormalize(elemAbi)) {
          // eager element normalization over the aliased snapshot
          w.op('DUP1');
          w.op('MLOAD');
          w.push(5);
          w.op('SHL'); // [nbytes, ptr, buf]
          w.op('DUP2');
          w.op('ADD');
          w.push(32);
          w.op('ADD'); // [end, ptr, buf]
          w.op('DUP2');
          w.push(32);
          w.op('ADD'); // [cur, end, ptr, buf]
          emitNormalizeElemsLoop(w, elemAbi, 2);
          w.op('POP');
          w.op('POP'); // [ptr, buf]
        }
      }

      w.push(ref.slot);
      w.op('MSTORE', { note: `out #${j} ${out.type} (memref aliases snapshot)` }); // [buf]
    });
  }
  w.op('POP'); // []

  // -- 4. try mode: success flag, zero block (checked — rejoins), join --------------------
  if (tryMode) {
    if (plan.successRef !== null) {
      w.push(1);
      w.push(plan.successRef.slot);
      w.op('MSTORE', { note: `success = 1 (site ${siteId})` });
    }
    const join = w.newLabel(`call_join_${siteId}`);
    w.pushLabel(join);
    w.op('JUMP');

    w.label(plan.dfailLabel, 0, `zero_${siteId}`);
    if (plan.successRef !== null) {
      w.push(0);
      w.push(plan.successRef.slot);
      w.op('MSTORE', { note: `success = 0 (site ${siteId})` });
    }
    for (const ref of plan.outRefs) {
      // word outs = 0; string/bytes/array outs = 0x60 (empty memref); tuple outs = a fresh
      // zero-filled flat block (its dynamic members point at 0x60, nested tuples recurse).
      emitZeroValue(w, ref.type); // [zero, …]
      w.push(ref.slot);
      w.op('MSTORE');
    }
    w.label(join, 0); // fallthrough from the zero block rejoins here
  }
}
