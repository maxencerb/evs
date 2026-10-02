/**
 * `codegen/program.ts` — `lowerProgram`, the single entry point `compile.ts` consumes
 * (the optimizer seam; `opts.optimize` picks the liveness-based frame allocator, #41).
 *
 * Program layout:
 *
 *   receive     cds == 0 → STOP (accept ETH and bare calls); else → @dispatch
 *   prologue    PUSH frameEnd PUSH1 0x40 MSTORE
 *   dispatch    cds < 4 → @badcd; selector mismatch → @badcd; else → @main
 *   @main       arg decode · body statement templates · return encode RETURN
 *   @fn_*       subroutines — uncalled fns dropped
 *   @dfail_*    per-strict-site decode-fail stubs → @decode_revert
 *   tails       @muldiv (2+ mulDiv sites) / @panic_* / @panic / @decode_revert / @badcd
 *               (+ @memcpy pre-cancun) — only the referenced ones, so they must stay the
 *               last code region
 *   INVALID     data segments (dataLabel-addressed blobs, content-deduplicated) — LAST
 *
 * tryCall zero blocks are emitted inline at their call sites (they rejoin the program —
 * codegen/call.ts). Diagnostics (`LOOP_ALLOCATION`, `LARGE_FRAME`, `ENV_FRAME_DEPENDENT`)
 * are returned for compile.ts to forward via `onDiagnostic`; nothing is logged.
 */

import { canonicalTypeSignature, selectorOf } from '../abi/artifact.js';
import { AsmWriter, type AsmNode, type LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import type { SourceMap } from '../asm/sourcemap.js';
import { bytesToHex, selectorBytes } from '../core/bytes.js';
import { EvsInternalError, type EvsDiagnostic } from '../core/errors.js';
import { isBytesN } from '../core/types.js';
import {
  walkStmts,
  type ConstData,
  type FnId,
  type ScriptIr,
  type Stmt,
  type ValueId,
} from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { emitCalldataDecode, emitReturnEncode, type SlotRef } from './abi.js';
import { callArgEncodeFrames, callArgStaging, callSiteAllocates } from './call.js';
import { layoutFrames, type FrameLayout } from './frame.js';
import { createLowerCtx, emitFnSubroutines, lowerStmts, selfAddressValues } from './lower.js';
import { FRAME_BASE, FREE_PTR } from './memory.js';
import {
  emitSimulateTrampoline,
  SIMULATE_TRAMPOLINE_LABEL,
  SIMULATE_TRAMPOLINE_SELECTOR,
  SIMULATE_TRAMPOLINE_SELECTOR_NUM,
} from './simulate.js';
import { collectSites } from './sites.js';
import { createSharedTails, emitDecodeFailStub, emitSharedTails } from './tails.js';

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

export interface LowerResult {
  nodes: readonly AsmNode[];
  frameEnd: number;
  sites: SourceMap['sites'];
  regions: ProgramRegions;
  diagnostics: readonly EvsDiagnostic[]; // LOOP_ALLOCATION etc. — compile.ts forwards
}

/**
 * The label that opens each region of the program layout (see the module doc), `null` when the
 * region is empty. `compile()` reads their pcs to break an EIP-170 overflow down per region: the
 * dispatcher is everything before `main`, and the data region starts one byte before `data`
 * (the INVALID guard the assembler plants).
 */
export interface ProgramRegions {
  readonly main: LabelId;
  /** The first emitted fn subroutine. */
  readonly fns: LabelId | null;
  /** The simulate trampoline entrypoint (only with an `s.simulate` site). */
  readonly trampoline: LabelId | null;
  /** The first decode-fail stub, else the first shared tail placed. */
  readonly tails: LabelId | null;
  /** The first data segment. */
  readonly data: LabelId | null;
}

/**
 * Frames larger than this trip the `LARGE_FRAME` warning (the threshold is a judgment call:
 * 32 KiB ≈ 1,020 slots is far beyond any reasonable read script and the point where
 * quadratic memory-expansion gas starts to register).
 */
const LARGE_FRAME_BYTES = 0x8000;

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/program: ${message}`);
}

export function lowerProgram(
  ir: ScriptIr,
  opts: { evmVersion: EvmVersion; optimize?: boolean },
): LowerResult {
  validateIr(ir);
  // `optimize` (compile's single optimizer switch) selects the liveness-based frame allocator
  // (issue #41); the default keeps one slot per value so the default bytes never move.
  const frame = layoutFrames(ir, { optimize: opts.optimize ?? false });
  const w = new AsmWriter();
  const evm = { evmVersion: opts.evmVersion };
  const tails = createSharedTails(w, evm);

  // -- data segment manager (content-deduplicated; emitted last) ------------------------
  const segments: { label: LabelId; name: string; bytes: Uint8Array }[] = [];
  const segmentByContent = new Map<string, LabelId>();
  const dataSeg = (bytes: Uint8Array): LabelId => {
    const key = bytesToHex(bytes);
    const hit = segmentByContent.get(key);
    if (hit !== undefined) return hit;
    const name = `data_${segments.length}`;
    const label = w.newLabel(name);
    segmentByContent.set(key, label);
    segments.push({ label, name, bytes: bytes.slice() });
    return label;
  };

  const ctx = createLowerCtx({ ir, frame, tails, opts: evm, dataSeg });

  // -- receive: empty calldata succeeds with no output, whatever the value ------------------
  // A script has no function a bare call could mean, but a target paying ETH back to its caller
  // (WETH.withdraw's `msg.sender.transfer`, a DEX swap to native ETH) makes exactly that call into
  // the script, and in sender mode the script replaces the sender's empty code — so rejecting it
  // breaks calls that succeed from the plain account. This region runs before the prologue and
  // costs 15 gas on the empty path, well under the 2,300 stipend of `transfer`/`send`; 1–3 bytes
  // of calldata still fall through to the size floor below and revert EvsInvalidCalldata().
  const dispatch = w.newLabel('dispatch');
  w.op('CALLDATASIZE');
  w.pushLabel(dispatch);
  w.op('JUMPI');
  w.op('STOP', { note: 'empty calldata: receive' });
  w.label(dispatch, 0);

  // -- prologue: free-pointer init --------------------------------
  w.push(frame.frameEnd, { note: 'frameEnd' });
  w.push(FREE_PTR);
  w.op('MSTORE', { note: 'free-ptr init' });

  // -- simulate trampoline (issue #1): if any `s.simulate` site exists anywhere in the IR, the
  // bytecode carries a second internal entrypoint reached by a reserved selector. Detect it across
  // the body and ALL recorded fns (a simulate inside an uncalled, dropped fn just leaves the
  // trampoline unreachable — a few dozen bytes; unlike the shared tails, which are emitted only
  // when referenced, the trampoline is not reference-tracked).
  let hasSimulate = false;
  const markSimulate = (s: Stmt): void => {
    if (s.k === 'call' && s.kind === 'simulate') hasSimulate = true;
  };
  walkStmts(ir.body, markSimulate);
  for (const fn of ir.fns) if (fn !== undefined) walkStmts(fn.body, markSimulate);
  const trampoline = hasSimulate ? w.newLabel(SIMULATE_TRAMPOLINE_LABEL) : null;

  // -- dispatcher: size floor, selector match, fallback EvsInvalidCalldata --------
  // tuple args expand to their canonical `(t1,t2,…)` signature so the dispatcher selector is
  // byte-identical to viem's over the tuple-expanded ScriptAbi inputs.
  const argTypes = ir.args.map((a) => canonicalTypeSignature(a.type));
  const selector = selectorOf(ir.name, argTypes);
  if (
    trampoline !== null &&
    Number.parseInt(selector.slice(2), 16) === SIMULATE_TRAMPOLINE_SELECTOR_NUM
  ) {
    throw internal(
      `script selector ${selector} collides with the reserved simulate trampoline selector ${SIMULATE_TRAMPOLINE_SELECTOR} — rename the script`,
    );
  }
  const main = w.newLabel('main');
  w.push(4);
  w.op('CALLDATASIZE');
  w.op('LT'); // [cds < 4]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI');
  w.push(0);
  w.op('CALLDATALOAD');
  w.push(0xe0);
  w.op('SHR'); // [selector]
  // simulate trampoline route (issue #1) — DUP1 keeps the selector for the main compare below.
  // When there is no simulate site the dispatcher is byte-identical to the pre-issue-#1 shape.
  if (trampoline !== null) {
    w.op('DUP1');
    w.pushBytes(selectorBytes(SIMULATE_TRAMPOLINE_SELECTOR, 'codegen/program'), {
      note: 'simulate trampoline selector',
    });
    w.op('EQ');
    w.pushLabel(trampoline);
    w.op('JUMPI'); // [selector]
  }
  w.pushBytes(selectorBytes(selector, 'codegen/program'), {
    note: `selector ${ir.name}(${argTypes.join(',')})`,
  });
  w.op('EQ');
  w.pushLabel(main);
  w.op('JUMPI');
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMP'); // fallback — named EvsInvalidCalldata()
  w.label(main, 0);

  // -- arg decode ------------------------------------------------------------------
  const argRefs: SlotRef[] = ir.args.map((a, i) => {
    const slot = frame.slotOfValue(i);
    if (slot === null) throw internal(`arg #${i} ("${a.name}") has no frame slot`);
    return { slot, type: a.type };
  });
  emitCalldataDecode(w, argRefs, tails, evm);

  // -- body --------------------------------------------------------------------------------
  lowerStmts(w, ir.body, ctx);

  // -- return encode — ends with RETURN ---------------------------------------------
  const components = ir.returns.map((r) => {
    const slot = frame.slotOfValue(r.value);
    if (slot === null) {
      throw internal(`return "${r.name}" references folded ValueId ${r.value} with no slot`);
    }
    return { name: r.name, ref: { slot, type: r.type } };
  });
  emitReturnEncode(w, components, tails, evm);

  // -- fn subroutines (only fns reached through fncall — uncalled fns dropped) ---------
  emitFnSubroutines(w, ctx);

  // -- simulate trampoline entrypoint (issue #1) — a self-contained REVERT-terminated region ----
  if (trampoline !== null) emitSimulateTrampoline(w, trampoline);

  // -- per-site decode-fail stubs (strict calls) + shared tails ----------------
  // Shared tails are emitted only when referenced, so they must come after every region that
  // can `pushLabel` one (body, fn subroutines, trampoline, dfail stubs — all above).
  for (const stub of ctx.dfailStubs) emitDecodeFailStub(w, stub.label, stub.site, tails);
  const firstTail = emitSharedTails(w, tails, ctx.mulDivShare);

  // -- data segments LAST (the assembler plants the INVALID guard) -------------------------
  for (const seg of segments) {
    w.dataLabel(seg.label, seg.name);
    w.data(seg.bytes, seg.name);
  }

  // fn subroutines are emitted in fnQueue order, so the first queued fn opens their region
  const firstFn = ctx.fnQueue[0];
  const regions: ProgramRegions = {
    main,
    fns: firstFn === undefined ? null : (ctx.fnEntries.get(firstFn) ?? null),
    trampoline,
    tails: ctx.dfailStubs[0]?.label ?? firstTail,
    data: segments[0]?.label ?? null,
  };
  const sites = collectSites(ctx, ctx.fnQueue);
  return {
    nodes: w.nodes(),
    frameEnd: frame.frameEnd,
    sites,
    regions,
    diagnostics: [
      ...collectDiagnostics(ir, frame, ctx.fnQueue, ctx.consts),
      ...valueCallDiagnostics(ir, sites, ctx.fnQueue),
    ],
  };
}

// ---------------------------------------------------------------------------
// diagnostics — LOOP_ALLOCATION + LARGE_FRAME + ENV_FRAME_DEPENDENT
// ---------------------------------------------------------------------------

/** The builder verb that records a `call` statement (`s.read`, `s.tryCall`, `s.simulate`, …). */
function callVerb(s: Extract<Stmt, { k: 'call' }>): string {
  const base = s.kind === 'call' ? 'call' : s.kind === 'simulate' ? 'simulate' : 'read';
  return s.mode === 'try' ? `s.try${base[0]?.toUpperCase() ?? ''}${base.slice(1)}` : `s.${base}`;
}

/**
 * What an allocating statement is, in builder vocabulary, for the `LOOP_ALLOCATION` message —
 * or `null` when the statement allocates nothing. Exhaustive over the statement kinds on
 * purpose: a new kind must decide here whether it allocates.
 *
 * `arrnew` / `tuplenew` / `encode` each have several builder origins (`s.newArray` or an array
 * literal; `s.tuple`, a struct literal or a `struct: true` read; `s.encode`, the encode behind
 * `s.keccak256` or memref `.eq()`), and the builder records that origin as the out value's
 * `debugName`; IR built or deserialized without names falls back to the op's generic builder
 * name. `fnAllocates` answers for a `fncall`'s callee (transitively); `consts` is the lowering's
 * const table, which decides which call args are data literals.
 */
function describeAllocation(
  s: Stmt,
  ir: ScriptIr,
  fnAllocates: (f: FnId) => boolean,
  consts: ReadonlyMap<ValueId, ConstData>,
): string | null {
  const origin = (out: ValueId, fallback: string): string => ir.values[out]?.debugName ?? fallback;
  switch (s.k) {
    case 'arrnew':
      return `${origin(s.out, `s.newArray(${canonicalTypeSignature(s.elem)})`)} (array allocation)`;
    case 'tuplenew':
      return `${origin(s.out, 's.tuple(…)')} (flat-block allocation)`;
    case 'encode':
      return `${origin(s.out, s.mode === 'abi' ? 's.encode(…)' : 's.encodePacked(…)')} (fresh bytes memref)`;
    case 'const':
      return s.data.kind === 'data'
        ? `a ${canonicalTypeSignature(s.type)} literal (materialized in memory)`
        : null;
    case 'call': {
      // word-only s.read/s.call outputs read a transient snapshot (see callSiteAllocates), but
      // the recursive calldata encoder bumps the free pointer for its data-literal staging block
      // (callArgStaging) and for the encode frames its args need (callArgEncodeFrames)
      const site = `${callVerb(s)}(${s.fnAbi.name})`;
      if (callSiteAllocates(s)) return `${site} (returndata snapshot)`;
      const staged = callArgStaging(s, (i) => {
        const arg = s.args[i];
        return arg === undefined ? undefined : consts.get(arg);
      });
      const parts = [
        ...(staged.size > 0 ? ['staged call-arg literals'] : []),
        ...(callArgEncodeFrames(s) > 0 ? ['call-arg encode frames'] : []),
      ];
      return parts.length > 0 ? `${site} (${parts.join(', ')})` : null;
    }
    case 'slice':
      return '.slice(…) (fresh copy)';
    case 'convert':
      // `.asString()` on a bytesN copies the word into a fresh string; every other convert is
      // a word op or a free reinterpret of the same memory
      return copiesWordToString(s, ir) ? '.asString() on a bytesN (fresh string)' : null;
    case 'fncall':
      return fnAllocates(s.fn)
        ? `the call to fn "${ir.fns[s.fn]?.name ?? s.fn}" (its body allocates)`
        : null;
    case 'bin':
    case 'un':
    case 'modarith':
    case 'env':
    case 'account':
    case 'select':
    case 'index':
    case 'len':
    case 'arrset':
    case 'field':
    case 'tupleset':
    case 'keccak256': // hashes an existing memref in place
    case 'throw': // terminates — its encoding never accumulates
    case 'cellnew':
    case 'cellget':
    case 'cellset':
    case 'if': // child blocks are visited on their own
    case 'while':
    case 'break':
    case 'continue':
      return null;
    default: {
      // compile-time exhaustiveness: a new Stmt kind fails tsc here until it is classified
      const unreachable: never = s;
      throw internal(`unknown statement kind '${String((unreachable as { k?: unknown }).k)}'`);
    }
  }
}

/** A `convert` that copies a bytesN word into a fresh string (`.asString()` on a bytesN). */
function copiesWordToString(s: Extract<Stmt, { k: 'convert' }>, ir: ScriptIr): boolean {
  const from = ir.values[s.a]?.type;
  return ir.values[s.out]?.type === 'string' && from !== undefined && isBytesN(from);
}

/**
 * `s.env('caller')` / `s.env('address')` lower to bare CALLER/ADDRESS — sound, but the value
 * is execution-frame-dependent and the two `toViem()` modes run the script in different
 * frames: in the DEFAULT deployless mode `caller` is viem's internal wrapper contract and
 * `address` is a per-script counterfactual CREATE2 address (neither controllable), while in
 * stateOverride mode `caller` is the `account` call parameter and `address` is the chosen
 * override address. timestamp/blocknumber/chainid are block context — identical across modes —
 * so the warning is scoped to caller+address (blocknumber is NUMBER, which on Arbitrum is an
 * approximate L1 block: chain semantics, documented rather than warned about).
 */
const ENV_FRAME_MESSAGES: Partial<Record<string, string>> = {
  caller:
    `s.env('caller') is execution-frame-dependent: in the default deployless toViem() mode ` +
    `msg.sender is viem's internal wrapper contract — NOT the eth_call \`account\`; ` +
    `caller-relative reads require toViem({ mode: 'stateOverride' }) plus the \`account\` ` +
    `call parameter`,
  address:
    `s.env('address') is execution-frame-dependent: in the default deployless toViem() mode ` +
    `address(this) is a per-script counterfactual CREATE2 address; use ` +
    `toViem({ mode: 'stateOverride' }) for a stable, controllable script address`,
};

/**
 * `s.balance(s.env('address'))` (lowered to SELFBALANCE) reads the script's own balance, which
 * is a property of the frame too: the deployless script runs at a fresh counterfactual address,
 * the stateOverride one at an address the caller controls. Code size and code hash of the
 * script's own address are not flagged: both modes run the same runtime there.
 */
const SELF_BALANCE_MESSAGE =
  `s.balance(s.env('address')) reads the script's own balance, which is execution-frame-` +
  `dependent: in the default deployless toViem() mode the script runs at a fresh ` +
  `counterfactual CREATE2 address (normally 0 wei); in toViem({ mode: 'stateOverride' }) it is ` +
  `the override address's balance, which a \`balance\` field in that state override sets`;

/**
 * A `value` on `s.call` / `s.simulate` (or a `try*` form) is paid from the script's own balance,
 * so it depends on the frame like {@link SELF_BALANCE_MESSAGE}: the deployless script cannot be
 * funded, so the CALL always fails there before the target runs.
 */
function valueCallMessage(s: Extract<Stmt, { k: 'call' }>): string {
  const outcome = s.mode === 'try' ? 'reports success = false' : 'reverts';
  return (
    `${callVerb(s)}(${s.fnAbi.name}) sends a \`value\`, paid from the script's own balance, ` +
    `which is execution-frame-dependent: in the default deployless toViem() mode the script ` +
    `runs at a fresh counterfactual CREATE2 address that holds no ETH, so this CALL fails ` +
    `before the target runs and the site ${outcome}; use toViem({ mode: 'stateOverride' }) ` +
    `with a \`balance\` in the script's state-override entry (or sender mode, where the ` +
    `sender pays)`
  );
}

/** `ENV_FRAME_DEPENDENT` for every emitted call site the site table marks `sendsValue`. */
function valueCallDiagnostics(
  ir: ScriptIr,
  sites: SourceMap['sites'],
  emittedFns: readonly FnId[],
): EvsDiagnostic[] {
  const paying = new Set(sites.filter((site) => site.sendsValue === true).map((site) => site.id));
  const diagnostics: EvsDiagnostic[] = [];
  const look = (s: Stmt): void => {
    if (s.k !== 'call' || !paying.has(s.site)) return;
    diagnostics.push({
      severity: 'warning',
      code: 'ENV_FRAME_DEPENDENT',
      message: valueCallMessage(s),
      site: s.site,
    });
  };
  walkStmts(ir.body, look);
  for (const f of emittedFns) {
    const fn = ir.fns[f];
    if (fn !== undefined) walkStmts(fn.body, look);
  }
  return diagnostics;
}

function collectDiagnostics(
  ir: ScriptIr,
  frame: FrameLayout,
  emittedFns: readonly FnId[],
  consts: ReadonlyMap<ValueId, ConstData>,
): readonly EvsDiagnostic[] {
  const diagnostics: EvsDiagnostic[] = [];

  // the script's own address values — the same set the SELFBALANCE lowering reads
  const selfAddresses = selfAddressValues(ir);

  // fn bodies allocating transitively (the call graph is acyclic; the seen-set keeps
  // the walk finite even on malformed input).
  const fnAllocMemo = new Map<FnId, boolean>();
  const fnAllocates = (f: FnId, seen: ReadonlySet<FnId>): boolean => {
    const memo = fnAllocMemo.get(f);
    if (memo !== undefined) return memo;
    if (seen.has(f)) return false;
    const fn = ir.fns[f];
    let result = false;
    if (fn !== undefined) {
      const nested = new Set(seen).add(f);
      walkStmts(fn.body, (s) => {
        if (describeAllocation(s, ir, (g) => fnAllocates(g, nested), consts) !== null) {
          result = true;
        }
      });
    }
    fnAllocMemo.set(f, result);
    return result;
  };

  const visit = (stmts: readonly Stmt[], inLoop: boolean): void => {
    for (const s of stmts) {
      const what = inLoop
        ? describeAllocation(s, ir, (f) => fnAllocates(f, new Set()), consts)
        : null;
      if (what !== null) {
        diagnostics.push({
          severity: 'warning',
          code: 'LOOP_ALLOCATION',
          message:
            `${what} allocates memory on every loop iteration; evs never resets the free ` +
            `pointer, so memory grows monotonically for the lifetime of the call and each ` +
            `iteration pays more memory-expansion gas than the last. Hoist it out of the loop ` +
            `when it does not depend on the iteration; for a short, bounded loop the cost is ` +
            `small — filter this warning on its code and site (site ids are positional: re-check ` +
            `the filter after editing the script)`,
          site: s.site,
        });
      }
      if (s.k === 'env') {
        const message = ENV_FRAME_MESSAGES[s.op];
        if (message !== undefined) {
          diagnostics.push({
            severity: 'warning',
            code: 'ENV_FRAME_DEPENDENT',
            message,
            site: s.site,
          });
        }
      }
      if (s.k === 'account' && s.op === 'balance' && selfAddresses.has(s.a)) {
        diagnostics.push({
          severity: 'warning',
          code: 'ENV_FRAME_DEPENDENT',
          message: SELF_BALANCE_MESSAGE,
          site: s.site,
        });
      }
      if (s.k === 'if') {
        visit(s.then, inLoop);
        visit(s.else, inLoop);
      } else if (s.k === 'while') {
        visit(s.header, true);
        visit(s.body, true);
      }
    }
  };
  visit(ir.body, false);
  for (const f of emittedFns) {
    const fn = ir.fns[f];
    if (fn !== undefined) visit(fn.body, false);
  }
  if (frame.frameEnd > LARGE_FRAME_BYTES) {
    diagnostics.push({
      severity: 'warning',
      code: 'LARGE_FRAME',
      message:
        `the static frame spans ${frame.frameEnd} bytes (${(frame.frameEnd - FRAME_BASE) / 32} slots); ` +
        `memory-expansion gas grows quadratically — consider splitting the script`,
    });
  }
  return diagnostics;
}
