/**
 * `codegen/codecs.ts` — @internal shared codec subroutines (issue #95): a tuple or composite-array
 * codec that several sites of one program repeat is emitted once, as a checked subroutine placed
 * before the shared tails, and each planned use calls it instead of inlining it.
 *
 * - {@link planCodecs} decides, per compile, which uses share a body: a census of the codec uses
 *   the lowering will emit (keyed by `codegen/codec-keys.ts`), then a byte cost model measured on
 *   the real emitters.
 * - {@link CodecShare} is the `CodecHook` (`abi/shared.ts`) the ABI emitters call at each use: it
 *   emits the call of a planned use, leaves every other use to its inline emitter, and emits the
 *   bodies once the program's sites are all written.
 *
 * Two kinds of bodies, each the unchanged inline emitter run at the inline heights:
 *
 * - an ENCODER (`emitSharedEncodeBody`, `abi/encode.ts`) serves one top-level composite member of
 *   an encode block (call args, the return record, `s.encode` / `s.keccak256` / memref `.eq()`,
 *   `s.throw`): entry `[ret, base, src]` or `[ret, src]`, return label checked at 0;
 * - a DECODER ({@link emitDecoderBody}) serves one recursive-codec output of an `s.read` /
 *   `s.call` / `try*` / `revertReturns` site, or a simulate site's whole outputs tuple: entry
 *   `[ret, buf]`, return `[block, buf]`, or `[0, buf]` when the decode fails, through a funnel of
 *   POP rungs; the call site then routes the 0 through its OWN failure path (its
 *   `EvsDecodeError(site)` stub, or its try restore and zero block), so revert data and try
 *   semantics are those of the inline site.
 *
 * A program whose plan is empty (nothing pays) builds no `CodecShare`, reserves no register and
 * allocates no label, so it is byte-identical to the inline lowering. Bodies never call bodies:
 * they are emitted with the hook off, which also keeps one register bank enough.
 * CONTRIBUTING.md's "Shared codecs" design note has the conventions and the cost model's numbers.
 */

import { isDynamic, layoutOfType, type TypeLayout } from '../abi/layout.js';
import { AsmWriter, codeSize, type LabelId } from '../asm/assembler.js';
import { encodedPushWidth, type EvmVersion } from '../asm/ops.js';
import { MAX_TEMPLATE_DEPTH } from '../asm/verify.js';
import { EvsCompileError, EvsInternalError } from '../core/errors.js';
import { abiParamToType, typeToAbiParam, type NamedType } from '../core/types.js';
import { callOutputs, type ScriptIr } from '../ir/nodes.js';
import {
  emitEncodeBlock,
  emitSharedEncodeBody,
  headOffsets,
  layoutToNamed,
  needsDecodeBudget,
  subTupleBaseReads,
  blockBaseReads,
  tupleComponents,
  usesRecursiveCodec,
  type CodecHook,
  type CodecRegisters,
  type DecodeFail,
  type SharedTails,
} from './abi.js';
import { usesRecursiveEncoder } from './call/calldata.js';
import { makeDecodeFail } from './call/shared.js';
import { emitDecodeSimulateOutputs, simOutputsUnit } from './call/simulate-call.js';
import { emitDecodeReturnOutput, retOutputUnit } from './call/static-call.js';
import {
  codecKey,
  encodeMemberKind,
  isTailMemberKind,
  RETURNS_SITE,
  type CodecUnit,
  type EncodeMemberKind,
} from './codec-keys.js';
import { walkEmittedStmts } from './lower.js';
import { FRAME_BASE, FREE_PTR } from './memory.js';
import { evsPeephole } from './peephole.js';
import { createSharedTails } from './tails.js';

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/codecs: ${message}`);
}

// ---------------------------------------------------------------------------
// drift: a planner / emitter disagreement
// ---------------------------------------------------------------------------

/**
 * @internal The census and the emitters disagree on a planned codec: how many calls a statement
 * makes, or whether a decoder body can fail. Never wrong code: emission never shares an unplanned
 * use, and the mismatch is caught before the program is returned. `compile()` catches exactly
 * this class and lowers again with sharing off, so a lowering path the census does not know only
 * costs the saving. Under {@link setCodecPlanStrict} (the test setup) it is an `INTERNAL` error.
 */
export class CodecPlanDrift extends Error {
  constructor(message: string) {
    super(`codegen/codecs: ${message}`);
    this.name = 'CodecPlanDrift';
  }
}

let strictPlan = false;

/** @internal Test setup only: report a {@link CodecPlanDrift} as an `INTERNAL` error instead of
 *  falling back to the inline lowering, so every test exercises the census against the emitters. */
export function setCodecPlanStrict(on: boolean): void {
  strictPlan = on;
}

let planTransform: ((plan: CodecPlan) => CodecPlan) | null = null;

/** @internal Tests only: rewrites every plan {@link planCodecs} returns (a drift fixture);
 *  `null` restores the planner's own plans. */
export function setCodecPlanTransform(transform: ((plan: CodecPlan) => CodecPlan) | null): void {
  planTransform = transform;
}

function driftError(message: string): Error {
  return strictPlan ? internal(`plan drift: ${message}`) : new CodecPlanDrift(message);
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

/** One shared key: its body, and the uses that call it. */
export interface PlannedKey {
  readonly key: string;
  readonly unit: CodecUnit;
  /** Planned calls per statement site id (`RETURNS_SITE` for the return encode). */
  readonly groups: ReadonlyMap<number, number>;
  /** A decoder body can fail: its call sites then check the returned pointer for 0. */
  readonly canFail: boolean;
}

export interface CodecPlan {
  readonly keys: ReadonlyMap<string, PlannedKey>;
  /** Codec register words reserved after the static frame: `RET`, then `BASE`, then `SRC`. */
  readonly words: number;
}

export const EMPTY_CODEC_PLAN: CodecPlan = { keys: new Map(), words: 0 };

/** The codec registers of a program whose static frame ends at `frameEnd`. */
export function codecRegisters(frameEnd: number): CodecRegisters {
  return { ret: frameEnd, base: frameEnd + 32, src: frameEnd + 64 };
}

/**
 * The register words `unit` needs: `RET` always; `BASE` and `SRC` for a tuple encoder (its spilled
 * base and source pointer); `BASE` for a decoder of a dynamic output (its cached block base).
 */
function registerWords(unit: CodecUnit): number {
  if (unit.dir === 'enc') return unit.kind === 'ST' || unit.kind === 'DT' ? 3 : 1;
  return unit.region === 'ret' && isDynamic(unit.layout) ? 2 : 1;
}

/**
 * The smallest byte saving a key must reach to be shared: below it the estimate is within the
 * noise of what the peephole and the frame layout move around a site.
 */
const SHARE_MIN_SAVING = 16;

/**
 * The smallest saving per use for a key whose calls cost gas (see {@link isCheap}): without it a
 * small struct used at many sites could save 2 bytes per site for ~50 gas per call.
 */
const SHARE_MIN_PER_USE = 8;

/**
 * Whether a shared call of `unit` is expected to cost no more gas than its inline twin. A call
 * costs ~60 gas (two jumps, the return-address spill and reload, the operand spills, and a
 * decoder site's 0 check); two bodies repay it by reading a base from a register (6 gas) where
 * the inline code re-derives it through a head word at every read:
 *
 * - a dynamic tuple encoder (its base is the tail cursor): ~15 gas per base read, so from
 *   {@link CHEAP_ENCODE_READS} reads (`subTupleBaseReads`);
 * - the decoder of a dynamic tuple output (its block base, cached in the `BASE` register): ~8 gas
 *   per read at head offset 0, so from {@link CHEAP_DECODE_READS} reads (`blockBaseReads`); an
 *   output at a nonzero head offset re-adds it at every inline read (`PUSH ho ADD`, ~14 gas per
 *   read), so from {@link CHEAP_DECODE_READS_AT_OFFSET}.
 *
 * Measured on the in-process EVM (`(uint64 ×k, string)`: −15 gas per encoder call and −8 per
 * decoder call for each extra word, −14 behind a leading `uint256` output). Every other unit
 * costs a few dozen gas per call: it never shares inside a loop, and only when it saves
 * {@link SHARE_MIN_PER_USE} bytes per use.
 */
function isCheap(unit: CodecUnit): boolean {
  const l = unit.layout;
  if (l.kind !== 'tuple' || !l.dynamic) return false;
  if (unit.dir === 'enc') return subTupleBaseReads(l, 1) >= CHEAP_ENCODE_READS;
  if (unit.region !== 'ret') return false;
  const reads = unit.headOffset === 0 ? CHEAP_DECODE_READS : CHEAP_DECODE_READS_AT_OFFSET;
  return blockBaseReads(l) >= reads;
}

/** The base reads that repay a dynamic tuple encoder call (see {@link isCheap}). */
const CHEAP_ENCODE_READS = 5;
/** The block-base reads that repay a dynamic tuple decoder call at head offset 0 (see
 *  {@link isCheap}). */
const CHEAP_DECODE_READS = 9;
/** The block-base reads that repay a dynamic tuple decoder call at a nonzero head offset. */
const CHEAP_DECODE_READS_AT_OFFSET = 5;

/**
 * Decides which codec uses of `ir` share a body. Per key (one body), over the uses the census
 * finds, grouped by statement (all uses in one statement share its decision):
 *
 * - a use in a loop (or in a fn a loop calls) keeps its inline code unless the key is cheap;
 * - the remaining `n` uses share when `n ≥ 2` and the bytes saved, `Σ (inline − call) − body`,
 *   reach {@link SHARE_MIN_SAVING} (and {@link SHARE_MIN_PER_USE} per use for a key that is not
 *   cheap); under `optimize` the saving measured after the peephole must also stay positive.
 *
 * Sizes are measured on the real emitters (dry runs in a scratch writer). An encoder use reads
 * its operands at the cheapest cost a site can have: the real inline code reads them at least as
 * often as the call does, so the real saving is at least the measured one. The registers are
 * measured at `measureFrameEnd()`, the default allocator's frame end (the larger one), so both
 * allocators take the same decisions. The prologue's frame-end push, which grows by the register
 * words, is charged from the program's own `frameEnd`: one byte to every key whose words would
 * widen it (conservative: the push grows once). A key whose dry run fails to compile (a type too
 * deep for the stack) stays inline, and its site reports the error as it always did.
 */
export function planCodecs(
  ir: ScriptIr,
  opts: {
    readonly evmVersion: EvmVersion;
    readonly optimize: boolean;
    /** The program's static frame end (what its prologue pushes without registers). */
    readonly frameEnd: number;
    /** The default allocator's frame end (≥ `frameEnd`), when `optimize` packs the frame. */
    readonly measureFrameEnd?: () => number;
  },
): CodecPlan {
  const regs = codecRegisters(opts.measureFrameEnd?.() ?? opts.frameEnd);
  const pushWidth = (n: number): number => encodedPushWidth(BigInt(n), opts.evmVersion);
  const keys = new Map<string, PlannedKey>();
  let words = 0;
  for (const [key, use] of census(ir)) {
    // the prologue pushes `frameEnd + 32·words`: a wider push than the inline program's costs 1
    const widen =
      pushWidth(opts.frameEnd + 32 * registerWords(use.unit)) > pushWidth(opts.frameEnd) ? 1 : 0;
    const cheap = isCheap(use.unit);
    const groups = [...use.groups].filter(([, g]) => cheap || !g.hot);
    const n = groups.reduce((sum, [, g]) => sum + g.count, 0);
    if (n < 2) continue;
    let sizes: UnitSizes;
    try {
      sizes = measureUnit(key, use.unit, regs, opts);
    } catch (error) {
      if (error instanceof EvsCompileError) continue;
      throw error;
    }
    const saving = (at: 'pre' | 'post'): number =>
      groups.reduce(
        (sum, [, g]) => sum + g.count * (sizes.inline[g.mode][at] - sizes.call[g.mode][at]),
        0,
      ) -
      sizes.body[at] -
      widen;
    const pre = saving('pre');
    if (pre < SHARE_MIN_SAVING || (!cheap && pre < SHARE_MIN_PER_USE * n)) continue;
    if (opts.optimize && saving('post') <= 0) continue;
    keys.set(key, {
      key,
      unit: use.unit,
      groups: new Map(groups.map(([site, g]) => [site, g.count])),
      canFail: sizes.canFail,
    });
    words = Math.max(words, registerWords(use.unit));
  }
  const plan = keys.size === 0 ? EMPTY_CODEC_PLAN : { keys, words };
  return planTransform === null ? plan : planTransform(plan);
}

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------

/** How a use's site handles a decode failure (an encoder use is always `'strict'`). */
type UseMode = 'strict' | 'try';

interface CensusGroup {
  count: number;
  readonly mode: UseMode;
  readonly hot: boolean;
}

interface CensusKey {
  readonly unit: CodecUnit;
  readonly groups: Map<number, CensusGroup>;
}

/**
 * Every codec use the lowering emits, by key then by statement site:
 *
 * - the top-level composite members of every encode block — a recursive-encoder call's args
 *   (`usesRecursiveEncoder`, the predicate the calldata builder dispatches on), an `s.encode`
 *   (`'abi'`) or `s.throw` payload, the return record;
 * - every recursive-codec output of an `s.read` / `s.call` site (or its `try*` / `revertReturns`
 *   form), and every simulate site's outputs list.
 *
 * It walks exactly the statements `lowerProgram` lowers (`walkEmittedStmts`), and builds keys
 * with the emitters' own predicates; the drift check holds it to them. A statement the walk visits
 * twice (a site id two statements share, which the IR never records) would make the counts
 * ambiguous, so the census is then empty.
 */
function census(ir: ScriptIr): Map<string, CensusKey> {
  const keys = new Map<string, CensusKey>();
  const add = (key: string, unit: CodecUnit, site: number, mode: UseMode, hot: boolean): void => {
    let entry = keys.get(key);
    if (entry === undefined) {
      entry = { unit, groups: new Map() };
      keys.set(key, entry);
    }
    const group = entry.groups.get(site);
    if (group === undefined) entry.groups.set(site, { count: 1, mode, hot });
    else group.count += 1;
  };
  const use = (unit: CodecUnit, site: number, mode: UseMode, hot: boolean): void =>
    add(codecKey(unit), unit, site, mode, hot);
  const encodeBlock = (params: readonly NamedType[], site: number, hot: boolean): void => {
    for (const p of params) {
      const layout = layoutOfType(abiParamToType(p));
      const kind = encodeMemberKind(layout);
      if (kind !== null) use({ dir: 'enc', kind, layout }, site, 'strict', hot);
    }
  };
  const valueParam = (v: number): NamedType => {
    const info = ir.values[v];
    if (info === undefined) throw internal(`census: unknown ValueId ${v}`);
    return typeToAbiParam('', info.type);
  };
  const sites = new Set<number>();
  let ambiguous = false;
  walkEmittedStmts(ir, (s, hot) => {
    if (sites.has(s.site)) ambiguous = true;
    sites.add(s.site);
    if ((s.k === 'encode' && s.mode === 'abi') || s.k === 'throw') {
      encodeBlock(s.args.map(valueParam), s.site, hot);
      return;
    }
    if (s.k !== 'call') return;
    if (usesRecursiveEncoder(s)) encodeBlock(s.fnAbi.inputs, s.site, hot);
    if (s.kind === 'simulate') {
      const outputs = s.fnAbi.outputs;
      if (outputs.length === 0) return;
      use(
        simOutputsUnit(outputs, needsDecodeBudget(outputs) ? 'once' : 'off'),
        s.site,
        s.mode,
        hot,
      );
      return;
    }
    const outputs = callOutputs(s);
    const budget = needsDecodeBudget(outputs) ? 'once' : 'off';
    const offsets = headOffsets(outputs);
    outputs.forEach((p, j) => {
      const layout = layoutOfType(abiParamToType(p));
      if (!usesRecursiveCodec(layout)) return;
      use(retOutputUnit(layout, offsets[j] ?? 0, budget), s.site, s.mode, hot);
    });
  });
  encodeBlock(
    ir.returns.map((r) => typeToAbiParam(r.name, r.type)),
    RETURNS_SITE,
    false,
  );
  return ambiguous ? new Map() : keys;
}

// ---------------------------------------------------------------------------
// measurement (dry runs of the real emitters)
// ---------------------------------------------------------------------------

/** A fragment's size before and after the peephole (`post` = `pre` without `optimize`). */
interface Sizes {
  readonly pre: number;
  readonly post: number;
}

interface UnitSizes {
  /** One use, inlined, by the site's failure mode. */
  readonly inline: Readonly<Record<UseMode, Sizes>>;
  /** One use, calling the body (and checking its result), by the site's failure mode. */
  readonly call: Readonly<Record<UseMode, Sizes>>;
  /** The body. */
  readonly body: Sizes;
  /** Whether the body can fail (a decoder whose funnel has a rung). */
  readonly canFail: boolean;
}

type MeasureOpts = { readonly evmVersion: EvmVersion; readonly optimize: boolean };

/**
 * The size of what `emit` writes into a fresh scratch writer (with its own shared tails, the
 * codec hook `codecs`), entered at stack height `entryHeight`: a checked label opens the fragment
 * so the peephole's height walk sees a well-formed stream; its JUMPDEST is not counted.
 */
function fragmentSize(
  opts: MeasureOpts,
  entryHeight: number,
  emit: (w: AsmWriter, tails: SharedTails) => void,
  codecs: CodecHook | null = null,
): Sizes {
  const w = new AsmWriter();
  const tails = createSharedTails(w, { evmVersion: opts.evmVersion, codecs });
  w.label(w.newLabel(), entryHeight);
  emit(w, tails);
  const nodes = w.nodes();
  const pre = codeSize(nodes, opts.evmVersion) - 1;
  const post = opts.optimize ? codeSize(evsPeephole(nodes), opts.evmVersion) - 1 : pre;
  return { pre, post };
}

/** A hook planning exactly the use of `key` at site 0: measures the call sequence. */
function probe(key: string, unit: CodecUnit, canFail: boolean, regs: CodecRegisters): CodecShare {
  const groups = new Map([[0, 1]]);
  return new CodecShare({ keys: new Map([[key, { key, unit, groups, canFail }]]), words: 3 }, regs);
}

/** A site's decode-failure router for `mode`, as `emitStaticCall` builds it (its labels are
 *  fresh scratch labels: only the sizes matter). */
function siteFail(w: AsmWriter, mode: UseMode): DecodeFail {
  const stub = { dfailLabel: w.newLabel(), siteId: 0 };
  return makeDecodeFail(w, stub, mode === 'try', 'call', w.newLabel());
}

/** Measures one use of `unit` inline, one call of it, and its body. */
function measureUnit(
  key: string,
  unit: CodecUnit,
  regs: CodecRegisters,
  opts: MeasureOpts,
): UnitSizes {
  const evm = { evmVersion: opts.evmVersion };
  if (unit.dir === 'enc') {
    // the use is the lone member of an encode block, read at the cheapest cost a site can have
    const member: NamedType[] = [layoutToNamed(unit.layout)];
    const encodeUse = (w: AsmWriter, tails: SharedTails): void => {
      emitEncodeBlock(
        w,
        member,
        () => {
          w.push(FRAME_BASE);
          w.op('MLOAD');
        },
        () => {
          w.push(FREE_PTR);
          w.op('MLOAD');
        },
        tails,
        evm,
      );
    };
    const inline = fragmentSize(opts, 0, encodeUse);
    const call = fragmentSize(opts, 0, encodeUse, probe(key, unit, false, regs));
    return {
      inline: { strict: inline, try: inline },
      call: { strict: call, try: call },
      body: fragmentSize(opts, 0, (w, tails) =>
        emitSharedEncodeBody(w, w.newLabel(), 'enc', unit.kind, unit.layout, regs, tails, evm),
      ),
      canFail: false,
    };
  }
  let canFail = false;
  const body = fragmentSize(opts, 0, (w) => {
    canFail = emitDecoderBody(w, w.newLabel(), 'dec', unit, regs, evm);
  });
  const share = probe(key, unit, canFail, regs);
  const measure = (mode: UseMode): { inline: Sizes; call: Sizes } => ({
    inline: fragmentSize(opts, 1, (w) => emitDecodeUnitInline(w, unit, siteFail(w, mode), evm)),
    call: fragmentSize(opts, 1, (w) => share.decode(w, key, siteFail(w, mode), 'decode')),
  });
  const strict = measure('strict');
  const tried = measure('try');
  return {
    inline: { strict: strict.inline, try: tried.inline },
    call: { strict: strict.call, try: tried.call },
    body,
    canFail,
  };
}

/** The inline code of a decoder unit at its site, `[buf] → [block, buf]`. */
function emitDecodeUnitInline(
  w: AsmWriter,
  unit: Extract<CodecUnit, { dir: 'dec' }>,
  fail: DecodeFail,
  opts: { evmVersion: EvmVersion },
  name = 'measured unit',
  cacheBlockBase?: number,
): void {
  const decodeOpts = { budget: unit.budget, evmVersion: opts.evmVersion };
  const what = (): string => `shared decoder ${name}`;
  if (unit.region === 'sim') {
    emitDecodeSimulateOutputs(w, tupleComponents(unit.layout), fail, decodeOpts, what);
    return;
  }
  const type = abiParamToType(layoutToNamed(unit.layout));
  emitDecodeReturnOutput(w, type, unit.headOffset, fail, decodeOpts, what, cacheBlockBase);
}

// ---------------------------------------------------------------------------
// decoder bodies
// ---------------------------------------------------------------------------

/**
 * The body of a shared decoder for `unit`, at `entry` (checked, height 2): `[ret, buf]` →
 * `[block, buf]` at the call site's return label (checked at 2), or `[0, buf]` when the decode
 * fails. Returns whether it can fail. The block pointer is never 0 (`emitDecodeFromRegion`), so
 * the site tells the two apart.
 *
 * The return address is spilled to `regs.ret`, so the decode runs at the inline unit's own
 * entry height (1): the same template budget, the same stack / heap path choices, the same
 * `UNSUPPORTED_V0` boundary. A dynamic output's block base is cached in `regs.base`
 * (`DecodeRegion.cacheBlockBase`), one load at each read instead of a re-derivation; its smaller
 * stack peak may let the body keep a stack fast path its inline twin rolled back to the heap path
 * (values and revert data are the same on both paths).
 *
 * Failure funnel: a failure at absolute height `h` (the `DecodeFail` contract: the height left
 * once its flag is consumed) jumps to rung `h`, which POPs down to the next rung below it; the
 * last rung leaves `[buf]`, pushes 0 and returns. The rung labels are allocated up front, before
 * any speculative fragment (`emitIfWithinBudget` rolls label ids back, so a label allocated
 * inside one could be handed out again), and only the rungs a kept fragment references are
 * placed (`isReferenced` forgets the references of a rolled-back fragment). Kept code never
 * fails above height 14 (`[label, flag, …h]` must fit the 16-item budget), so the rungs cover it.
 */
function emitDecoderBody(
  w: AsmWriter,
  entry: LabelId,
  name: string,
  unit: Extract<CodecUnit, { dir: 'dec' }>,
  regs: CodecRegisters,
  opts: { evmVersion: EvmVersion },
): boolean {
  const rungs = Array.from({ length: MAX_TEMPLATE_DEPTH }, () => w.newLabel()); // rung h at h−1
  const failK: DecodeFail = (h) => {
    // a failure above the template budget only occurs in a speculative fragment that will be
    // rolled back (or that fails the whole decode with UNSUPPORTED_V0): its PUSH2 alone already
    // overflows. It names a fresh label that is never placed and never cached.
    w.pushLabel(rungs[h - 1] ?? w.newLabel());
    w.op('JUMPI'); // the funnel rung for height h
  };
  w.label(entry, 2, name); // [ret, buf]
  w.push(regs.ret);
  w.op('MSTORE', { note: `${name}: spill return address` }); // [buf]
  const cache = unit.region === 'ret' && isDynamic(unit.layout) ? regs.base : undefined;
  emitDecodeUnitInline(w, unit, failK, opts, name, cache); // [block, buf]
  emitCodecReturn(w, regs, name);
  const placed = rungs.flatMap((rung, i) => (w.isReferenced(rung) ? [{ rung, h: i + 1 }] : []));
  placed.reverse(); // highest first: each rung falls through to the next one down
  placed.forEach(({ rung, h }, i) => {
    w.label(rung, h, `${name}_fail_${h}`);
    const next = placed[i + 1]?.h ?? 1;
    for (let k = next; k < h; k++) w.op('POP');
  });
  if (placed.length === 0) return false;
  w.push(0, { note: `${name}: decode failed` }); // [0, buf]
  emitCodecReturn(w, regs, name);
  return true;
}

/** `PUSH ret MLOAD JUMP`: a body's return through the spilled address (a dynamic jump, legal in
 *  a checked region — the `@memcpy` / `@muldiv` / fn-return edge). */
function emitCodecReturn(w: AsmWriter, regs: CodecRegisters, name: string): void {
  w.push(regs.ret);
  w.op('MLOAD');
  w.op('JUMP', { note: `${name}: return` });
}

// ---------------------------------------------------------------------------
// the hook
// ---------------------------------------------------------------------------

/**
 * The `CodecHook` of a non-empty plan. A use is shared exactly when its key is planned for the
 * current statement; the body's entry label is allocated at the first call, and
 * {@link CodecShare.emitBodies} emits the bodies of the keys that were called.
 */
export class CodecShare implements CodecHook {
  readonly #plan: CodecPlan;
  readonly #regs: CodecRegisters;
  #site = 0;
  #emittingBodies = false;
  /** The keys called so far, in first-call order, with their body's entry label and name. */
  readonly #bodies = new Map<string, { readonly entry: LabelId; readonly name: string }>();
  /** Calls emitted per key and statement site. */
  readonly #emitted = new Map<string, Map<number, number>>();
  #calls = 0;

  constructor(plan: CodecPlan, regs: CodecRegisters) {
    this.#plan = plan;
    this.#regs = regs;
  }

  enterSite(site: number): void {
    this.#site = site;
  }

  encodeMember(
    w: AsmWriter,
    kind: EncodeMemberKind,
    layout: TypeLayout,
    name: string,
    pushSrc: () => void,
    pushBase: (() => void) | null,
  ): boolean {
    const use = this.#use(w, codecKey({ dir: 'enc', kind, layout }));
    if (use === null) return false;
    if ((pushBase === null) !== isTailMemberKind(kind)) {
      throw internal(`a ${kind} member call needs ${pushBase === null ? 'its base' : 'no base'}`);
    }
    pushSrc(); // [src]
    pushBase?.(); // [base, src] (a static member)
    this.#call(w, use.body, 0, `encode ${name || 'member'} (shared ${use.body.name})`); // []
    return true;
  }

  decode(w: AsmWriter, key: string, fail: DecodeFail, note: string): boolean {
    const use = this.#use(w, key);
    if (use === null) return false;
    this.#call(w, use.body, 2, `${note} (shared ${use.body.name})`); // [block | 0, buf]
    if (use.planned.canFail) {
      w.op('DUP1');
      w.op('ISZERO'); // [block == 0, block, buf]
      fail(2); // [block, buf]   a failed decode takes the site's own failure path
    }
    return true;
  }

  /** The body of `key` when the current statement's use of it is planned shared (the use is then
   *  counted), else `null`. */
  #use(
    w: AsmWriter,
    key: string,
  ): {
    readonly planned: PlannedKey;
    readonly body: { readonly entry: LabelId; readonly name: string };
  } | null {
    if (this.#emittingBodies) throw internal(`a codec body asked to call ${key}`);
    const planned = this.#plan.keys.get(key);
    if (planned === undefined || !planned.groups.has(this.#site)) return null;
    let body = this.#bodies.get(key);
    if (body === undefined) {
      const name = `${planned.unit.dir}_${this.#bodies.size}`;
      body = { entry: w.newLabel(name), name };
      this.#bodies.set(key, body);
    }
    const counts = this.#emitted.get(key) ?? new Map<number, number>();
    counts.set(this.#site, (counts.get(this.#site) ?? 0) + 1);
    this.#emitted.set(key, counts);
    return { planned, body };
  }

  /** `PUSH2 @ret PUSH2 @entry JUMP @ret:` — the body returns to `@ret`, checked at `retHeight`. */
  #call(
    w: AsmWriter,
    body: { readonly entry: LabelId; readonly name: string },
    retHeight: number,
    note: string,
  ): void {
    const ret = w.newLabel(`${body.name}_ret_${this.#calls}`);
    this.#calls += 1;
    w.pushLabel(ret);
    w.pushLabel(body.entry, { note });
    w.op('JUMP');
    w.label(ret, retHeight);
  }

  /**
   * Emits the body of every key a site called, in first-call order, with the hook off (bodies
   * never call bodies), and returns the first entry (`null` when no body was called). Call it
   * after every region that holds a site, and before the shared tails (a body references
   * `@memcpy` before cancun). A decoder body that can fail where its plan said it cannot (its
   * sites would then not check for 0), or the reverse, is a drift. A body that touches a register
   * past the plan's reserved words (it would overwrite the heap) is an internal error.
   */
  emitBodies(w: AsmWriter, tails: SharedTails, opts: { evmVersion: EvmVersion }): LabelId | null {
    this.#emittingBodies = true;
    const bodyTails: SharedTails = { ...tails, codecs: null };
    // the registers, recording the highest word a body asks for
    let used = 0;
    const regs = this.#regs;
    const tracked: CodecRegisters = {
      get ret() {
        used = Math.max(used, 1);
        return regs.ret;
      },
      get base() {
        used = Math.max(used, 2);
        return regs.base;
      },
      get src() {
        used = Math.max(used, 3);
        return regs.src;
      },
    };
    let first: LabelId | null = null;
    for (const [key, body] of this.#bodies) {
      const planned = this.#plan.keys.get(key);
      if (planned === undefined) throw internal(`body ${body.name} has no planned key`);
      first ??= body.entry;
      const { unit } = planned;
      used = 0;
      if (unit.dir === 'enc') {
        const { kind, layout } = unit;
        emitSharedEncodeBody(w, body.entry, body.name, kind, layout, tracked, bodyTails, opts);
      } else {
        const canFail = emitDecoderBody(w, body.entry, body.name, unit, tracked, opts);
        if (canFail !== planned.canFail) {
          throw driftError(`${key}: the body ${canFail ? 'can' : 'cannot'} fail, against its plan`);
        }
      }
      if (used > this.#plan.words) {
        throw internal(
          `body ${body.name} uses ${used} register word(s), the plan reserves ${this.#plan.words}`,
        );
      }
    }
    return first;
  }

  /** Throws when a statement made a different number of calls than the plan counted for it. */
  checkDrift(): void {
    for (const [key, planned] of this.#plan.keys) {
      const emitted = this.#emitted.get(key);
      for (const [site, count] of planned.groups) {
        const made = emitted?.get(site) ?? 0;
        if (made !== count) {
          throw driftError(
            `${key}: site ${site} was planned for ${count} shared call(s) but made ${made}`,
          );
        }
      }
    }
  }
}
