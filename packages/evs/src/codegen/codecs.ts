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
 * A program whose plan is empty (nothing pays) builds no `CodecShare`, reserves no register and
 * allocates no label, so it is byte-identical to the inline lowering. Bodies never call bodies:
 * they are emitted with the hook off, which also keeps one register bank enough.
 *
 * Encoder bodies (`emitSharedEncodeBody`, `abi/encode.ts`) serve one top-level composite member
 * of an encode block (call args, the return record, `s.encode` / `s.keccak256` / memref `.eq()`,
 * `s.throw`). CONTRIBUTING.md's "Shared codecs" design note has the conventions and the cost
 * model's numbers.
 */

import { layoutOfType, type TypeLayout } from '../abi/layout.js';
import { AsmWriter, codeSize, type LabelId } from '../asm/assembler.js';
import { encodedPushWidth, type EvmVersion } from '../asm/ops.js';
import { EvsCompileError, EvsInternalError } from '../core/errors.js';
import { abiParamToType, typeToAbiParam, type NamedType } from '../core/types.js';
import type { ScriptIr } from '../ir/nodes.js';
import {
  emitEncodeBlock,
  emitSharedEncodeBody,
  layoutToNamed,
  type CodecHook,
  type CodecRegisters,
  type SharedTails,
} from './abi.js';
import { usesRecursiveEncoder } from './call/calldata.js';
import {
  encKey,
  encodeMemberKind,
  isTailMemberKind,
  RETURNS_SITE,
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
 * @internal The census and the emitters disagree on a planned codec (how many calls a statement
 * makes). Never wrong code: emission never shares an unplanned use, and the mismatch is caught
 * before the program is returned. `compile()` catches exactly this class and lowers again with
 * sharing off, so a lowering path the census does not know only costs the saving. Under
 * {@link setCodecPlanStrict} (the test setup) it is an `INTERNAL` error instead.
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

/** What one shared body does. */
export type CodecUnit = {
  readonly dir: 'enc';
  readonly kind: EncodeMemberKind;
  readonly layout: TypeLayout;
};

/** One shared key: its body, and the uses that call it. */
export interface PlannedKey {
  readonly key: string;
  readonly unit: CodecUnit;
  /** Planned calls per statement site id (`RETURNS_SITE` for the return encode). */
  readonly groups: ReadonlyMap<number, number>;
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

/** The register words `keys` need: `RET` for any body, `BASE` and `SRC` for a tuple encoder. */
function registerWords(keys: ReadonlyMap<string, PlannedKey>): number {
  let words = 0;
  for (const { unit } of keys.values()) {
    words = Math.max(words, unit.kind === 'ST' || unit.kind === 'DT' ? 3 : 1);
  }
  return words;
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
 * Whether a shared call of `unit` is expected to cost no more gas than its inline twin. A dynamic
 * tuple encoder reads its base from the tail cursor once, where the inline code re-derives it
 * through the parent's head word at every member access, which repays the call. Every other unit
 * pays a few dozen gas per call (two jumps, the spills and the register reads): it never shares
 * inside a loop, and only when it saves {@link SHARE_MIN_PER_USE} bytes per use.
 */
function isCheap(unit: CodecUnit): boolean {
  return unit.kind === 'DT';
}

/**
 * Decides which codec uses of `ir` share a body. Per key (one body), over the uses the census
 * finds, grouped by statement (all uses in one statement share its decision):
 *
 * - a use in a loop (or in a fn a loop calls) keeps its inline code unless the key is cheap;
 * - the remaining `n` uses share when `n ≥ 2` and the bytes saved, `Σ (inline − call) − body`,
 *   reach {@link SHARE_MIN_SAVING} (and {@link SHARE_MIN_PER_USE} per use for a key that is not
 *   cheap); under `optimize` the saving measured after the peephole must also stay positive.
 *
 * Sizes are measured on the real emitters (dry runs in a scratch writer), with the cheapest
 * operand reads at the site: the real inline code reads them at least as often as the call does,
 * so the real saving is at least the measured one. The registers are measured at `frameEnd`, the
 * default allocator's frame end (the larger one), so both allocators take the same decisions.
 * A key whose dry run fails to compile (a type too deep for the stack) stays inline, and its site
 * reports the error as it always did.
 */
export function planCodecs(
  ir: ScriptIr,
  opts: { readonly evmVersion: EvmVersion; readonly frameEnd: number; readonly optimize: boolean },
): CodecPlan {
  const found = census(ir);
  const regs = codecRegisters(opts.frameEnd);
  // a wider register push than the frame end's (charged to every key: conservative)
  const widen =
    encodedPushWidth(BigInt(regs.src), opts.evmVersion) >
    encodedPushWidth(BigInt(opts.frameEnd), opts.evmVersion)
      ? 1
      : 0;
  const keys = new Map<string, PlannedKey>();
  for (const [key, use] of found) {
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
      groups.reduce((sum, [, g]) => sum + g.count * (sizes.inline[at] - sizes.call[at]), 0) -
      sizes.body[at] -
      widen;
    const pre = saving('pre');
    if (pre < SHARE_MIN_SAVING || (!cheap && pre < SHARE_MIN_PER_USE * n)) continue;
    if (opts.optimize && saving('post') <= 0) continue;
    keys.set(key, {
      key,
      unit: use.unit,
      groups: new Map(groups.map(([site, g]) => [site, g.count])),
    });
  }
  const plan = keys.size === 0 ? EMPTY_CODEC_PLAN : { keys, words: registerWords(keys) };
  return planTransform === null ? plan : planTransform(plan);
}

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------

interface CensusGroup {
  count: number;
  readonly hot: boolean;
}

interface CensusKey {
  readonly unit: CodecUnit;
  readonly groups: Map<number, CensusGroup>;
}

/**
 * Every codec use the lowering emits, by key then by statement site: the top-level composite
 * members of every encode block — a recursive-encoder call's args (`usesRecursiveEncoder`, the
 * predicate the calldata builder dispatches on), an `s.encode` (`'abi'`) or `s.throw` payload,
 * the return record. It walks exactly the statements `lowerProgram` lowers
 * (`walkEmittedStmts`); a statement the walk visits twice (a site id two statements share,
 * which the IR never records) would make the counts ambiguous, so the census is then empty.
 */
function census(ir: ScriptIr): Map<string, CensusKey> {
  const keys = new Map<string, CensusKey>();
  const add = (key: string, unit: CodecUnit, site: number, hot: boolean): void => {
    let entry = keys.get(key);
    if (entry === undefined) {
      entry = { unit, groups: new Map() };
      keys.set(key, entry);
    }
    const group = entry.groups.get(site);
    if (group === undefined) entry.groups.set(site, { count: 1, hot });
    else group.count += 1;
  };
  const encodeBlock = (params: readonly NamedType[], site: number, hot: boolean): void => {
    for (const p of params) {
      const layout = layoutOfType(abiParamToType(p));
      const kind = encodeMemberKind(layout);
      if (kind !== null) add(encKey(kind, layout), { dir: 'enc', kind, layout }, site, hot);
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
    if (s.k === 'call') {
      if (usesRecursiveEncoder(s)) encodeBlock(s.fnAbi.inputs, s.site, hot);
    } else if ((s.k === 'encode' && s.mode === 'abi') || s.k === 'throw') {
      encodeBlock(s.args.map(valueParam), s.site, hot);
    }
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
  /** One use, inlined. */
  readonly inline: Sizes;
  /** One use, calling the body. */
  readonly call: Sizes;
  /** The body. */
  readonly body: Sizes;
}

/**
 * The size of what `emit` writes into a fresh scratch writer (with its own shared tails, the
 * codec hook `codecs`), entered at stack height `entryHeight`: a checked label opens the fragment
 * so the peephole's height walk sees a well-formed stream; its JUMPDEST is not counted.
 */
function fragmentSize(
  opts: { readonly evmVersion: EvmVersion; readonly optimize: boolean },
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

/** Measures one use of `unit` inline, one call of it, and its body. */
function measureUnit(
  key: string,
  unit: CodecUnit,
  regs: CodecRegisters,
  opts: { readonly evmVersion: EvmVersion; readonly optimize: boolean },
): UnitSizes {
  const evm = { evmVersion: opts.evmVersion };
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
  // the call: the same block with a hook planning this one use
  const probe = new CodecShare(
    { keys: new Map([[key, { key, unit, groups: new Map([[0, 1]]) }]]), words: 3 },
    regs,
  );
  return {
    inline: fragmentSize(opts, 0, encodeUse),
    call: fragmentSize(opts, 0, encodeUse, probe),
    body: fragmentSize(opts, 0, (w, tails) =>
      emitSharedEncodeBody(w, w.newLabel(), 'enc', unit.kind, unit.layout, regs, tails, evm),
    ),
  };
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
    const body = this.#use(w, encKey(kind, layout));
    if (body === null) return false;
    if ((pushBase === null) !== isTailMemberKind(kind)) {
      throw internal(`a ${kind} member call needs ${pushBase === null ? 'its base' : 'no base'}`);
    }
    pushSrc(); // [src]
    pushBase?.(); // [base, src] (a static member)
    this.#call(w, body, 0, `encode ${name || 'member'} (shared ${body.name})`); // []
    return true;
  }

  decode(): boolean {
    return false;
  }

  /** The body of `key` when the current statement's use of it is planned shared (the use is then
   *  counted), else `null`. */
  #use(w: AsmWriter, key: string): { readonly entry: LabelId; readonly name: string } | null {
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
    return body;
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
   * `@memcpy` before cancun).
   */
  emitBodies(w: AsmWriter, tails: SharedTails, opts: { evmVersion: EvmVersion }): LabelId | null {
    this.#emittingBodies = true;
    const bodyTails: SharedTails = { ...tails, codecs: null };
    let first: LabelId | null = null;
    for (const [key, body] of this.#bodies) {
      const planned = this.#plan.keys.get(key);
      if (planned === undefined) throw internal(`body ${body.name} has no planned key`);
      first ??= body.entry;
      const { unit } = planned;
      emitSharedEncodeBody(
        w,
        body.entry,
        body.name,
        unit.kind,
        unit.layout,
        this.#regs,
        bodyTails,
        opts,
      );
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
