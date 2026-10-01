/**
 * `codegen/call/calldata.ts` — call-site calldata: the `CalldataTemplate` (compile-time const
 * folding of the selector and literal args), its build emission, and the recursive encoder for
 * tuple-bearing calldata.
 */

import { type TypeLayout, layoutOf, layoutOfType, headBytes } from '../../abi/layout.js';
import type { AsmWriter, LabelId } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { u256ToBytes } from '../../core/bytes.js';
import { abiParamToType, type NamedType } from '../../core/types.js';
import type { ConstData, Stmt } from '../../ir/nodes.js';
import {
  usesRecursiveCodec,
  type SharedTails,
  emitLeafDynTail,
  reserveEncodeFrames,
  type PushWord,
  type PushBase,
  emitEncodeBlock,
} from '../abi.js';
import { FREE_PTR, SCRATCH_1, TAIL_CURSOR } from '../memory.js';
import {
  type CallSitePlan,
  internal,
  literalBytes,
  isLiteralRef,
  literalDataBytes,
  CONST_SEGMENT_INLINE_MAX,
  emitPushWordChunk,
  emitSelectorWord,
  callArgEncodeFrames,
  literalWordValue,
} from './shared.js';

// ---------------------------------------------------------------------------
// CalldataTemplate — compile-time const folding
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

/** Checks the call's ABI against its plan (one arg ref per input, a 4-byte selector) and returns
 *  the selector bytes — shared by the template and the recursive-encoder builds. */
function validateCallAbi(plan: CallSitePlan): Uint8Array {
  const { fnAbi } = plan.stmt;
  if (fnAbi.inputs.length !== plan.argRefs.length) {
    throw internal(
      `call to ${fnAbi.name}: ${fnAbi.inputs.length} ABI input(s) but ${plan.argRefs.length} arg ref(s)`,
    );
  }
  const selector = literalBytes(fnAbi.selector, `selector of ${fnAbi.name}`);
  if (selector.length !== 4) throw internal(`selector of ${fnAbi.name} must be 4 bytes`);
  return selector;
}

function buildTemplate(plan: CallSitePlan): CalldataTemplate {
  const { fnAbi } = plan.stmt;
  const inputs = fnAbi.inputs;
  const selector = validateCallAbi(plan);

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
        const bytes = literalBytes(ref.literal.hex, what);
        if (ref.literal.kind !== 'word' || bytes.length !== 32) {
          throw internal(`${what}: word arg requires a 32-byte word literal`);
        }
        place(headOffset, bytes);
      } else {
        runtimeWords.push({ offset: headOffset, slot: ref.slot });
      }
      return;
    }
    // dynamic arg. A recursive-codec arg (a tuple, `tuple[]`/`T[][]`/`string[]`, any `T[N]`) is
    // routed to the recursive encoder (`emitCalldataBuildTuples`) by `emitCalldataFor`'s
    // `usesRecursiveCodec` dispatch and never reaches the template path — this backstop catches a
    // routing regression that would otherwise silently mis-encode it as a word-array memref tail.
    if (usesRecursiveCodec(l)) {
      throw internal(
        `${what}: recursive-codec call arg reached the template encoder (should route to emitCalldataBuildTuples)`,
      );
    }
    if (isLiteralRef(ref)) {
      const bytes = literalDataBytes(ref.literal, what);
      if (hasRuntimeDyn) {
        dynParts.push({ headOffset, kind: 'literal', bytes });
      } else {
        place(headOffset, u256ToBytes(BigInt(tailPos - 4)));
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

/**
 * Writes compile-time `bytes` at `MLOAD(ptrSlot) + offset`: one CODECOPY from a data segment past
 * {@link CONST_SEGMENT_INLINE_MAX} bytes, else PUSH-chunked MSTOREs (a trailing partial chunk is
 * zero-padded, so it may spill into bytes the caller writes later). `notes.segment` annotates the
 * CODECOPY size push, `notes.firstChunk` the first chunk push. Net stack 0.
 */
function emitConstBytes(
  w: AsmWriter,
  bytes: Uint8Array,
  ptrSlot: number,
  offset: number,
  dataSeg: (bytes: Uint8Array) => LabelId,
  notes: { readonly segment: string; readonly firstChunk?: string },
): void {
  const pushDst = (at: number): void => {
    w.push(ptrSlot);
    w.op('MLOAD'); // [ptr]
    if (at !== 0) {
      w.push(at);
      w.op('ADD');
    } // [ptr + at]
  };
  if (bytes.length > CONST_SEGMENT_INLINE_MAX) {
    const label = dataSeg(bytes);
    w.push(bytes.length, { note: notes.segment });
    w.pushLabel(label); // [src, size]
    pushDst(offset); // [dst, src, size]
    w.op('CODECOPY'); // []
    return;
  }
  for (let k = 0; k < bytes.length; k += 32) {
    const chunk = new Uint8Array(32);
    chunk.set(bytes.slice(k, k + 32));
    emitPushWordChunk(w, chunk, k === 0 ? notes.firstChunk : undefined); // [val]
    pushDst(offset + k); // [dst, val]
    w.op('MSTORE'); // []
  }
}

/** Const run at a compile-time-known buffer offset (`MLOAD(0x40) + run.offset`). */
function emitConstRun(w: AsmWriter, run: ConstRun, dataSeg: (bytes: Uint8Array) => LabelId): void {
  emitConstBytes(w, run.bytes, FREE_PTR, run.offset, dataSeg, {
    segment: `const segment ${run.bytes.length}B`,
    firstChunk: 'const calldata',
  });
}

/** Const bytes at the runtime tail cursor (regime 'dynamic' literal-dyn tails). */
function emitConstBytesAtCursor(
  w: AsmWriter,
  bytes: Uint8Array,
  dataSeg: (bytes: Uint8Array) => LabelId,
): void {
  emitConstBytes(w, bytes, TAIL_CURSOR, 0, dataSeg, { segment: `const tail ${bytes.length}B` });
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

    // memref member: [len][payload…] tail at the cursor, cursor += 32 + ceil32(n)
    const { slot, isArray } = part;
    emitLeafDynTail(
      w,
      () => {
        w.push(slot);
        w.op('MLOAD');
      },
      isArray,
      tails,
      opts,
    );
  }
}

// ---------------------------------------------------------------------------
// tuple-bearing calldata build — the recursive encoder
// ---------------------------------------------------------------------------

/** Scratch slot holding the data-literal staging base for the duration of a tuple-bearing build. */
const STAGING_SLOT = SCRATCH_1;

/**
 * Whether a call site's calldata goes through the recursive encoder ({@link
 * emitCalldataBuildTuples}): some input is a tuple, `tuple[]`/`T[][]`/`string[]` or any `T[N]`
 * ({@link usesRecursiveCodec}). Otherwise the calldata template builds it.
 */
function usesRecursiveEncoder(stmt: Extract<Stmt, { k: 'call' }>): boolean {
  return stmt.fnAbi.inputs.some((p) => usesRecursiveCodec(layoutOfType(abiParamToType(p))));
}

/** The data-literal staging block of a recursive-encoder build: arg index → byte offset. */
export interface CallArgStaging {
  readonly offsets: ReadonlyMap<number, number>;
  /** Total bytes; 0 → no staging block, no free-pointer bump. */
  readonly size: number;
}

/**
 * The data-literal staging block a call site's calldata build allocates. The recursive encoder
 * cannot fold literals into const segments, so it copies each data-literal arg's padded
 * `[len][payload…]` image into a block it allocates by bumping the free pointer (on every
 * execution of the site), and encodes from there. The template path writes literal tails into the
 * transient buffer instead and stages nothing (`size` 0), as does a site with no data-literal arg.
 * `dataLiteralOf(i)` is arg #i's data literal, if it is one. The emitter and the
 * `LOOP_ALLOCATION` diagnostic both read the block's size here, so the two cannot drift.
 */
export function callArgStaging(
  stmt: Extract<Stmt, { k: 'call' }>,
  dataLiteralOf: (i: number) => ConstData | undefined,
): CallArgStaging {
  const offsets = new Map<number, number>();
  let size = 0;
  if (!usesRecursiveEncoder(stmt)) return { offsets, size };
  stmt.fnAbi.inputs.forEach((_p, i) => {
    const data = dataLiteralOf(i);
    if (data === undefined || data.kind !== 'data') return;
    const bytes = literalDataBytes(data, `arg #${i} of ${stmt.fnAbi.name}`);
    offsets.set(i, size);
    size += bytes.length; // images are already 32-aligned (validated)
  });
  return { offsets, size };
}

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
  const selector = validateCallAbi(plan);

  // CALL ARGS that need encode frames (composite-element / fixed-size array loops, and dynamic
  // tuple levels nested deeper than the frameless ones) keep that state in a reserved in-memory
  // frame region rather than on the stack. The return encoder reserves those frames below its
  // output buffer; here the call-arg buffer is transient (the free pointer is NOT bumped for it), so
  // we reserve the frames just below the buffer base by bumping the free pointer once — AFTER the
  // data-literal staging block, and BEFORE `MLOAD(0x40)` (the buffer base) is read for the
  // selector/heads/encode. FRAMES = the max number of concurrently live encode levels across the
  // args (`encodeFramesOf`: one per array loop, plus one per dynamic tuple level from the third
  // down below a root — the arg itself or an array element; 0 when no arg needs one, and then no
  // bump at all). `pushFrameSlot` then resolves each frame relative to `MLOAD(0x40)`, exactly as in
  // the return encoder.
  const frames = callArgEncodeFrames(plan.stmt);

  // -- data-literal staging layout (compile-time): each data-literal arg gets a padded image at a
  //    cumulative offset within the staging block.
  const { offsets: stagingOffsets, size: stagingSize } = callArgStaging(plan.stmt, (i) => {
    const ref = plan.argRefs[i];
    return ref !== undefined && isLiteralRef(ref) ? ref.literal : undefined;
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

  // -- reserve the encode frames just below the (transient) buffer base -------------------------
  // After this bump, `MLOAD(0x40)` is the buffer base and frame f sits at
  // `[base − 32·FRAME_SLOTS·(f+1), base − 32·FRAME_SLOTS·f)`; the encode below never bumps the free
  // pointer again (tails are written at TAIL_CURSOR), so the buffer base stays fixed throughout.
  reserveEncodeFrames(w, frames, `reserve ${frames} call-arg encode frame(s)`);

  // -- selector at buf[0..4): MSTORE(buf, selector << 224) (heads at buf+4 overwrite [4,36)) ----
  emitSelectorWord(w, selector, `selector ${fnAbi.name}`);
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

/**
 * Builds the call payload at `MLOAD(0x40)`. An arg that goes through the recursive codec (a tuple,
 * `tuple[]`/`T[][]`/`string[]`, any `T[N]` — {@link usesRecursiveCodec}) forces the recursive
 * encoder (no const-folding); word/word-array/string/bytes args stay on the template path.
 * Returns the template (`null` when the recursive encoder ran) so the caller derives argsSize
 * from its regime — the tail cursor holds the payload end in the non-static regimes.
 */
export function emitCalldataFor(
  w: AsmWriter,
  plan: CallSitePlan,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  dataSeg: (bytes: Uint8Array) => LabelId,
): CalldataTemplate | null {
  const template = usesRecursiveEncoder(plan.stmt) ? null : buildTemplate(plan);
  if (template === null) {
    emitCalldataBuildTuples(w, plan, tails, opts, dataSeg);
  } else {
    emitCalldataBuild(w, template, tails, opts, dataSeg);
  }
  return template;
}
