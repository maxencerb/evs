/**
 * `compile.ts` — pipeline orchestration:
 *
 *   validateIr → eliminateDeadCode (ir/dce.ts, always on) → lowerProgram (re-validates)
 *   [optimize: liveness frame allocator] → [optimize: built-in evsPeephole] → peephole (user
 *   hook) → assemble(EIP-170 check from its layout hook, before fixups — per-region breakdown
 *   from the region labels lowering reports; then verify: jumpdests, stack, shapes) → merge
 *   sites into the sourceMap → build the artifact.
 *
 * `optimize` (default false) is the single switch for the built-in optimizer passes: the
 * liveness-based frame allocator behind `codegen/frame.ts` (slot reuse across dead values,
 * issue #41) and the asm-level peephole pass (`codegen/peephole.ts`, issue #39) — dead-code
 * elimination is not an optimizer pass and always runs. The peephole pass runs at the same hook
 * position as the user `peephole` hook and BEFORE it, so a user hook always sees the optimized
 * stream, and the verifiers always see the final one. With `optimize: false` the pipeline is
 * byte-identical to the unoptimized lowering.
 *
 * Diagnostics from lowering, then the deployless result checks (`deployless.ts`), are forwarded
 * to `options.onDiagnostic`; nothing is ever logged.
 * `explainRevert` presents the shared revert classifier (`abi/revert.ts`, also behind
 * `decodeScriptError`) against this artifact: `Panic(uint256)` with the sites whose
 * `panicCodes` include the code, `EvsDecodeError(uint256 site)` (exact site),
 * `EvsInvalidCalldata()`, declared errors, and — for payloads only a callee can produce
 * (`Error(string)`, foreign selectors, the empty revert) — the strict call sites that bubble them.
 */

import type { Address } from 'viem';

import { canonicalTypeSignature, describePanic, type ScriptAbi } from './abi/artifact.js';
import { classifyRevert, errorTableOf } from './abi/revert.js';
import { assemble, type AsmNode, type LabelId } from './asm/assembler.js';
import { disassemble, type Disassembly } from './asm/disasm.js';
import type { EvmVersion } from './asm/ops.js';
import { siteById, type SourceMap } from './asm/sourcemap.js';
import type { EvsScript, ReturnValue } from './builder/script.js';
import { evsPeephole } from './codegen/peephole.js';
import { lowerProgram, type ProgramRegions } from './codegen/program.js';
import { bytesToHex, hexToBytes, isHexString } from './core/bytes.js';
import { EvsCompileError, EvsTypeError, type EvsDiagnostic } from './core/errors.js';
import type { ArgSpec, EvsErrorType, Hex } from './core/types.js';
import { deploylessResultDiagnostics } from './deployless.js';
import { eliminateDeadCode } from './ir/dce.js';
import { walkStmts, type ScriptIr, type SiteId, type Stmt } from './ir/nodes.js';
import { validateIr } from './ir/validate.js';
import {
  assertEvmVersion,
  toCreationBytecode,
  toViemDeployless,
  toViemStateOverride,
  type ToViemMode,
  type ToViemOptions,
} from './viem.js';

// ---------------------------------------------------------------------------
// public contract
// ---------------------------------------------------------------------------

export interface CompileOptions {
  evmVersion?: EvmVersion; // default 'cancun'
  optimize?: boolean; // default false — enables the built-in optimizer passes (the liveness-based frame allocator + the asm peephole pass `evsPeephole`); output is still fully verified
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]; // default identity — a user hook over the node stream; with `optimize` it runs AFTER the built-in passes
  onDiagnostic?: (d: EvsDiagnostic) => void; // warnings (e.g. LOOP_ALLOCATION, DEPLOYLESS_RESULT_PREFIX); never logged
}

export interface CompiledEvsScript<
  name extends string = string,
  args extends readonly ArgSpec[] = readonly ArgSpec[],
  ret extends Record<string, ReturnValue> = Record<string, ReturnValue>,
  // declared custom errors (issue #15) — trailing, wide-defaulted like EvsScript's
  errs extends readonly EvsErrorType[] = readonly EvsErrorType[],
> {
  readonly abi: ScriptAbi<name, args, ret, errs>; // literal-typed: [function, EvsInvalidCalldata, EvsDecodeError, ...declared]
  readonly runtimeBytecode: Hex; // ≤ 24,576 bytes (EIP-170), enforced
  readonly initBytecode: Hex; // 61RRRR80600A5F395FF3 ++ runtime (paris: 5F→3D)
  readonly sourceMap: SourceMap;
  readonly ir: ScriptIr; // the recorded IR (same object as script.ir); bytecode is lowered from eliminateDeadCode(ir)
  readonly options: Readonly<Required<CompileOptions>>;
  // deployless (default): a contract-creation eth_call, so the result must fit 24,576 bytes and
  // not start with 0xEF, and viem's creation data (args included) must fit 49,152 bytes — see
  // deploylessDataSize / explainDeploylessError; stateOverride mode has none of these limits.
  toViem(): { abi: ScriptAbi<name, args, ret, errs>; code: Hex };
  toViem(o: { mode: 'deployless' }): { abi: ScriptAbi<name, args, ret, errs>; code: Hex };
  // NOTE: the stateOverride tuple is mutable (not `readonly`) because viem's `StateOverride`
  // is a mutable `Array` type — a readonly tuple would not spread into `readContract`.
  toViem(o: { mode: 'stateOverride'; address?: Address }): {
    abi: ScriptAbi<name, args, ret, errs>;
    address: Address;
    stateOverride: [{ address: Address; code: Hex }];
  };
  // sender mode (issue #36): the runtime is installed AT `sender` and `account` is set to it, so
  // every sub-call target sees `msg.sender = sender` (the script self-calls through that address).
  // `address` may restate `sender` (same knob); a different value throws.
  toViem(o: { mode: 'stateOverride'; sender: Address; address?: Address }): {
    abi: ScriptAbi<name, args, ret, errs>;
    address: Address;
    stateOverride: [{ address: Address; code: Hex }];
    account: Address;
  };
  // catch-all for a mode chosen at run time (`mode: ToViemMode`): the union of the shapes above.
  // `address` / `sender` apply only when the mode turns out to be 'stateOverride' (deployless
  // ignores them). The mode may also be optional or `| undefined` (a config field that defaults
  // to deployless, as at run time). The intersection is `never` unless `m` minus `undefined` is
  // the whole union, which keeps a literal mode on its own overload: e.g.
  // `{ mode: 'deployless', address }` stays a type error. The `never` default covers a missing
  // `mode` key (no inference candidate), so `{}` / `{ address }` stay type errors too.
  toViem<m extends ToViemMode | undefined = never>(
    o: {
      mode?: m;
      address?: Address | undefined;
      sender?: Address | undefined;
    } & ([ToViemMode] extends [Exclude<m, undefined>] ? unknown : never),
  ):
    | { abi: ScriptAbi<name, args, ret, errs>; code: Hex }
    | {
        abi: ScriptAbi<name, args, ret, errs>;
        address: Address;
        stateOverride: [{ address: Address; code: Hex }];
      }
    | {
        abi: ScriptAbi<name, args, ret, errs>;
        address: Address;
        stateOverride: [{ address: Address; code: Hex }];
        account: Address;
      };
  disassemble(): Disassembly; // .format() → listing with labels, jump targets and notes
  explainRevert(data: Hex): RevertExplanation;
}

export interface RevertExplanation {
  kind:
    | 'panic'
    | 'evs-decode'
    | 'evs-invalid-calldata'
    | 'error-string'
    | 'script-error' // a DECLARED custom error thrown by s.throw (issue #15)
    | 'custom'
    | 'empty';
  message: string;
  panicCode?: bigint;
  errorName?: string; // script-error only: the declared error's name
  errorArgs?: Readonly<Record<string, unknown>>; // script-error only: name-keyed decoded args
  site?: { id: SiteId; detail: string };
  // 'panic': the sites whose template can raise that code. 'error-string' / 'custom' / 'empty'
  // (and a 'script-error' whose args do not decode): the strict call sites that bubble a callee
  // revert verbatim (the only places such a payload can enter the script). Absent otherwise.
  candidateSites?: readonly { id: SiteId; detail: string }[];
  raw: Hex;
}

export type CompiledOf<s> =
  s extends EvsScript<
    infer n extends string,
    infer a extends readonly ArgSpec[],
    infer r extends Record<string, ReturnValue>,
    infer e extends readonly EvsErrorType[]
  >
    ? CompiledEvsScript<n, a, r, e>
    : never;

// The natural constraint `s extends EvsScript` does not work: a concrete multi-return script is
// NOT assignable to the default-instantiated `EvsScript` — the `ScriptAbi` default collapses
// `Record<string, Expr>` components to a 1-tuple via UnionToTuple, so
// `EvsScript<'x', […], { a; b }>` fails the constraint and every real script would be rejected.
// The constraint below is the minimal structural relaxation; `CompiledOf<s>` still gives the
// precise result type.
export function compile<
  s extends { readonly name: string; readonly ir: ScriptIr; readonly abi: readonly unknown[] },
>(script: s, options?: CompileOptions): CompiledOf<s> {
  // CompiledOf<s> is deferred on the type parameter; compileScript builds the matching
  // artifact for the concrete script (runtime shape checked inside).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return compileScript(script as unknown as EvsScript, options) as unknown as CompiledOf<s>;
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

const EIP170_LIMIT = 24_576;

function identityPeephole(nodes: readonly AsmNode[]): AsmNode[] {
  return [...nodes];
}

function ignoreDiagnostic(_d: EvsDiagnostic): void {
  // default sink — diagnostics are delivered only through a user-provided callback
}

function resolveOptions(options: CompileOptions | undefined): Readonly<Required<CompileOptions>> {
  const evmVersion = options?.evmVersion ?? 'cancun';
  assertEvmVersion(evmVersion, 'compile: ');
  return Object.freeze({
    evmVersion,
    optimize: options?.optimize ?? false,
    peephole: options?.peephole ?? identityPeephole,
    onDiagnostic: options?.onDiagnostic ?? ignoreDiagnostic,
  });
}

function compileScript(script: EvsScript, options?: CompileOptions): CompiledEvsScript {
  if (
    typeof script !== 'object' ||
    script === null ||
    typeof (script as { ir?: unknown }).ir !== 'object'
  ) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      'compile: expected an EvsScript (the value returned by evscript())',
    );
  }
  const resolved = resolveOptions(options);
  const ir = script.ir;

  // validateIr → dead-code elimination (ir/dce.ts, always on: it only drops pure work whose
  // result nothing observable reads) → lowerProgram, which re-validates the DCE output as a
  // self-check of the pass. The artifact keeps exposing the recorded `script.ir` unchanged.
  validateIr(ir);
  const lowered = lowerProgram(eliminateDeadCode(ir), {
    evmVersion: resolved.evmVersion,
    optimize: resolved.optimize,
  });
  for (const diagnostic of lowered.diagnostics) resolved.onDiagnostic(diagnostic);
  for (const diagnostic of deploylessResultDiagnostics(ir.returns)) {
    resolved.onDiagnostic(diagnostic);
  }

  // built-in passes first (opt-in), then the user hook; `options.peephole` stays the user's own
  const userPeephole = resolved.peephole;
  const peephole = resolved.optimize
    ? (nodes: readonly AsmNode[]): AsmNode[] => userPeephole(evsPeephole(nodes))
    : userPeephole;
  // EIP-170 is enforced from the layout hook — before label fixups are patched — so a program
  // past PUSH2's 16-bit reach (host-unrolled loops get there) still reports COMPILE_LIMIT.
  const assembled = assemble(lowered.nodes, {
    evmVersion: resolved.evmVersion,
    peephole,
    verify: true,
    onLayout: (totalLen, labelPcs) => {
      if (totalLen > EIP170_LIMIT) {
        throw new EvsCompileError(
          'COMPILE_LIMIT',
          eip170Message(totalLen, labelPcs, lowered.regions),
        );
      }
    },
  });

  // merge the SiteId table from lowering into the assembler's segments+labels map
  const sourceMap: SourceMap = {
    version: 1,
    segments: assembled.sourceMap.segments,
    sites: lowered.sites,
    labels: assembled.sourceMap.labels,
  };

  const runtimeBytecode = bytesToHex(assembled.bytecode);
  const initBytecode = toCreationBytecode(runtimeBytecode, resolved.evmVersion);
  const abi = script.abi;

  // one implementation behind every `toViem` overload: the mode picks the shape, and
  // toViemStateOverride owns the address default and the `address` / `sender` checks
  const toViem = (o?: ToViemOptions) =>
    o?.mode === 'stateOverride'
      ? toViemStateOverride({ abi, runtimeBytecode }, o)
      : toViemDeployless({ abi, initBytecode });

  const artifact: CompiledEvsScript = {
    abi,
    runtimeBytecode,
    initBytecode,
    sourceMap,
    ir,
    options: resolved,
    // the overloads narrow the implementation's union return per input shape
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    toViem: toViem as CompiledEvsScript['toViem'],
    // the assembler's bytes, not `runtimeBytecode`: no hex round trip (disassemble never writes)
    disassemble: (): Disassembly => disassemble(assembled.bytecode, sourceMap),
    explainRevert: (data: Hex): RevertExplanation =>
      explainRevert(data, {
        ir,
        map: sourceMap,
        abi,
        runtimeBytecode,
        evmVersion: resolved.evmVersion,
      }),
  };
  return Object.freeze(artifact);
}

// ---------------------------------------------------------------------------
// EIP-170 per-region breakdown
// ---------------------------------------------------------------------------

function eip170Message(
  total: number,
  labelPcs: ReadonlyMap<LabelId, number>,
  regions: ProgramRegions,
): string {
  // a region whose opening label was not placed (or that is empty) has no start pc
  const pcOf = (label: LabelId | null): number | undefined =>
    label === null ? undefined : labelPcs.get(label);

  // program order: receive+prologue+dispatcher (pc 0 up to @main, reported as "dispatcher") ·
  // @main(arg decode + body + return encode) ·
  // @fn_* subroutines · @simulate_trampoline (only with s.simulate) · @dfail_* stubs + shared
  // tails · INVALID guard + data segments
  const mainPc = pcOf(regions.main) ?? 0;
  const fnPc = pcOf(regions.fns);
  const trampolinePc = pcOf(regions.trampoline);
  const tailPc = pcOf(regions.tails);
  const firstDataPc = pcOf(regions.data);
  const dataPc = firstDataPc === undefined ? undefined : firstDataPc - 1; // INVALID guard byte

  const dataStart = dataPc ?? total;
  const tailEnd = dataStart;
  const trampolineEnd = tailPc ?? tailEnd;
  const fnEnd = trampolinePc ?? trampolineEnd;
  const bodyEnd = fnPc ?? fnEnd;

  const dispatcher = mainPc;
  const body = Math.max(bodyEnd - mainPc, 0);
  const fns = fnPc === undefined ? 0 : Math.max(fnEnd - fnPc, 0);
  const trampoline =
    trampolinePc === undefined ? '' : `trampoline ${Math.max(trampolineEnd - trampolinePc, 0)}, `;
  const tails = tailPc === undefined ? 0 : Math.max(tailEnd - tailPc, 0);
  const data = Math.max(total - dataStart, 0);

  return (
    `runtime bytecode is ${total} bytes — exceeds the EIP-170 limit of ${EIP170_LIMIT} by ` +
    `${total - EIP170_LIMIT} bytes (dispatcher ${dispatcher}, body ${body}, fns ${fns}, ` +
    `${trampoline}tails ${tails}, data segments ${data}); split the script or move large ` +
    `literals off-chain`
  );
}

// ---------------------------------------------------------------------------
// explainRevert
// ---------------------------------------------------------------------------

type SiteRef = { id: SiteId; detail: string };

function toSiteRef(site: SourceMap['sites'][number]): SiteRef {
  return { id: site.id, detail: site.detail };
}

/** Everything `explainRevert` reads from the artifact. */
interface ExplainContext {
  readonly ir: ScriptIr; // the recorded IR
  readonly map: SourceMap; // its sites are the EMITTED ones (after DCE, uncalled fns dropped)
  readonly abi: readonly unknown[];
  readonly runtimeBytecode: Hex;
  readonly evmVersion: EvmVersion;
}

/**
 * The emitted call sites that forward a callee's revert payload verbatim: strict `s.read` /
 * `s.call` / `s.simulate` sites. `try*` sites swallow the revert, and a `revertReturns` site
 * decodes it as its value (a normal return is its failure, reported as `EvsDecodeError`), so
 * neither can bubble anything.
 */
function bubblingSites(ctx: ExplainContext): SiteRef[] {
  const ids = new Set<SiteId>();
  const look = (s: Stmt): void => {
    if (s.k === 'call' && s.mode === 'strict' && s.revertReturns === undefined) ids.add(s.site);
  };
  walkStmts(ctx.ir.body, look);
  for (const fn of ctx.ir.fns) walkStmts(fn.body, look);
  return ctx.map.sites.filter((s) => ids.has(s.id)).map(toSiteRef);
}

function listSites(sites: readonly SiteRef[]): string {
  return sites.map((s) => `${s.detail} (site ${s.id})`).join('; ');
}

/** "bubbled verbatim from a callee through …" naming the strict call sites (non-empty). */
function throughCallSites(sites: readonly SiteRef[]): string {
  const where =
    sites.length === 1 ? 'the strict call site' : `one of the ${sites.length} strict call sites`;
  return `bubbled verbatim from a callee through ${where}: ${listSites(sites)}`;
}

const NOT_FROM_THIS_ARTIFACT =
  'this script has no strict call site that bubbles a callee revert, so the payload did not ' +
  'come from this artifact';

/** The " — <where it came from>" clause for a payload only a callee can have produced. */
function bubbledFrom(sites: readonly SiteRef[]): string {
  return ` — ${sites.length > 0 ? throughCallSites(sites) : NOT_FROM_THIS_ARTIFACT}`;
}

const CALLEE_FORGERY_HEDGE =
  ' — note: the script has strict call sites that bubble callee reverts, and a callee may have ' +
  'reverted with this selector verbatim (bubbled byte-exactly), in which case the failure ' +
  'originated off-script';

/**
 * The evs error selectors (`EvsDecodeError`, `EvsInvalidCalldata`) and declared script errors
 * are public — a callee can revert with them verbatim, and a strict call site bubbles the payload
 * byte-exactly, so for a script WITH a bubbling site an attribution to the script is a strong
 * hint, never proof. Without one (no sub-calls, or only `try*` / `revertReturns` sites) nothing
 * can be bubbled, so there the attribution is authoritative and carries no hedge.
 */
function forgeryHedge(ctx: ExplainContext): string {
  return bubblingSites(ctx).length > 0 ? CALLEE_FORGERY_HEDGE : '';
}

function explainRevert(data: Hex, ctx: ExplainContext): RevertExplanation {
  const raw = bytesToHex(decodeHex(data, 'explainRevert'));
  const byteLength = (raw.length - 2) / 2;
  const c = classifyRevert(raw, errorTableOf(ctx.abi));
  switch (c.kind) {
    case 'empty':
      return explainEmpty(raw, ctx);
    case 'short': {
      const candidateSites = bubblingSites(ctx);
      return {
        kind: 'custom',
        message:
          `malformed revert payload (${byteLength} bytes — shorter than a 4-byte selector)` +
          bubbledFrom(candidateSites),
        candidateSites,
        raw,
      };
    }
    case 'panic':
      return explainPanic(raw, c.code, ctx);
    case 'error-string': {
      const candidateSites = bubblingSites(ctx);
      return {
        kind: 'error-string',
        message: `callee revert Error(${JSON.stringify(c.reason)})${bubbledFrom(candidateSites)}`,
        candidateSites,
        raw,
      };
    }
    case 'abi-error':
      if (c.args !== null && c.entry.name === 'EvsDecodeError') {
        return explainDecodeError(raw, c.args['site'], ctx);
      }
      if (c.args !== null && c.entry.name === 'EvsInvalidCalldata') {
        return explainInvalidCalldata(raw, ctx);
      }
      if (c.entry.name !== 'EvsDecodeError' && c.entry.name !== 'EvsInvalidCalldata') {
        return explainScriptError(raw, c.entry.name, c.selector, c.args, ctx);
      }
      // an evs built-in selector whose payload does not decode: not something evs emits
      return explainCustom(raw, c.selector, byteLength, ctx);
    default: // 'unknown'
      return explainCustom(raw, c.selector, byteLength, ctx);
  }
}

function explainCustom(
  raw: Hex,
  selector: Hex,
  byteLength: number,
  ctx: ExplainContext,
): RevertExplanation {
  const candidateSites = bubblingSites(ctx);
  return {
    kind: 'custom',
    message:
      `custom error ${selector} (${byteLength} byte payload) — decode it against the callee's ABI` +
      bubbledFrom(candidateSites),
    candidateSites,
    raw,
  };
}

function explainPanic(raw: Hex, code: bigint, ctx: ExplainContext): RevertExplanation {
  const { codeHex, meaning } = describePanic(code);
  // `panicCodes` is exact per site (codegen/sites.ts): only sites whose template can raise
  // THIS code are candidates; `detail` is display text and never matched on
  const candidateSites = ctx.map.sites
    .filter((s) => s.panicCodes?.some((p) => BigInt(p) === code) === true)
    .map(toSiteRef);
  const bubbling = bubblingSites(ctx);
  let where: string;
  if (candidateSites.length > 0) {
    where = ` — ${candidateSites.length} candidate site(s) in this script: ${listSites(candidateSites)}`;
    if (bubbling.length > 0) where += `; or ${throughCallSites(bubbling)}`;
  } else {
    where =
      ` — no site in this script can raise Panic(${codeHex}), so ` +
      (bubbling.length > 0 ? `it was ${throughCallSites(bubbling)}` : NOT_FROM_THIS_ARTIFACT);
  }
  return {
    kind: 'panic',
    message: `Panic(${codeHex}): ${meaning}${where}`,
    panicCode: code,
    candidateSites,
    raw,
  };
}

function explainDecodeError(raw: Hex, siteArg: unknown, ctx: ExplainContext): RevertExplanation {
  const id = typeof siteArg === 'bigint' ? siteArg : -1n;
  const hedge = forgeryHedge(ctx);
  if (raw.length !== 2 + 36 * 2) {
    return {
      kind: 'evs-decode',
      message:
        `returndata decode failed (EvsDecodeError site ${id}) — but the payload is ` +
        `${(raw.length - 2) / 2} bytes, not the 36 this compiler emits, so this script's own ` +
        `code cannot have produced it${hedge}`,
      raw,
    };
  }
  const idNum = id >= 0n && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : -1;
  const site = idNum >= 0 ? siteById(ctx.map, idNum) : undefined;
  // only a 'decode'-kind site is a plausible script origin: the compiler emits
  // EvsDecodeError(site) exclusively from strict-call decode-fail stubs. Any other site id
  // (or an unknown one) cannot have been produced by this script's own code.
  if (site !== undefined && site.kind === 'decode') {
    const ref = toSiteRef(site);
    return {
      kind: 'evs-decode',
      message: `${ref.detail} failed (EvsDecodeError site ${ref.id})${hedge}`,
      site: ref,
      raw,
    };
  }
  if (site !== undefined) {
    return {
      kind: 'evs-decode',
      message:
        `returndata decode failed (EvsDecodeError site ${id}) — but site ${id} is not a ` +
        `returndata-decode site in this script, so this script's own code cannot have ` +
        `produced the payload${hedge}`,
      raw,
    };
  }
  return {
    kind: 'evs-decode',
    message: `returndata decode failed (EvsDecodeError site ${id}) — the site id is unknown to this artifact's source map${hedge}`,
    raw,
  };
}

function explainInvalidCalldata(raw: Hex, ctx: ExplainContext): RevertExplanation {
  const { ir } = ctx;
  const signature = `${ir.name}(${ir.args.map((a) => canonicalTypeSignature(a.type)).join(',')})`;
  const hedge = forgeryHedge(ctx);
  return {
    kind: 'evs-invalid-calldata',
    message:
      `calldata does not match ${signature} — the script reverted EvsInvalidCalldata() ` +
      `(wrong selector, truncated calldata, or malformed dynamic arguments)${hedge}`,
    raw,
  };
}

/** A DECLARED custom error (issue #15). The callee-forgery hedge applies exactly as for the evs
 *  selectors: the selector is public. */
function explainScriptError(
  raw: Hex,
  name: string,
  selector: Hex,
  args: Readonly<Record<string, unknown>> | null,
  ctx: ExplainContext,
): RevertExplanation {
  if (args === null) {
    // s.throw always encodes its args well-formed: a malformed payload can only be a callee's
    const candidateSites = bubblingSites(ctx);
    return {
      kind: 'script-error',
      message:
        `declared error ${name} (selector ${selector}) with a MALFORMED argument ` +
        `payload (${(raw.length - 10) / 2} bytes) — the payload does not decode against its ` +
        `declared inputs, so this script's s.throw cannot have produced it` +
        bubbledFrom(candidateSites),
      errorName: name,
      candidateSites,
      raw,
    };
  }
  const hedge = forgeryHedge(ctx);
  const shown = Object.entries(args)
    .map(([k, v]) => `${k}: ${fmtErrorArg(v)}`)
    .join(', ');
  return {
    kind: 'script-error',
    message: `script error ${name}(${shown}) — thrown by s.throw${hedge}`,
    errorName: name,
    errorArgs: args,
    raw,
  };
}

/**
 * The empty payload has two origins: a callee's bare `revert()` / `require(false)` bubbled by a
 * strict call site, or a frame that failed without data — out of gas, or an opcode the node does
 * not support at the requested block (a fork-gated opcode run at a historical block or on a
 * chain that has not activated that fork).
 */
function explainEmpty(raw: Hex, ctx: ExplainContext): RevertExplanation {
  const candidateSites = bubblingSites(ctx);
  const callee =
    candidateSites.length > 0
      ? `a bare revert() / require(false) ${throughCallSites(candidateSites)}; or `
      : '';
  const opcodes = forkOpcodesOf(ctx);
  const frame =
    opcodes.length === 0
      ? 'the call frame failed without a reason (out of gas)'
      : `the call frame failed without a reason: out of gas, or an opcode the node rejects at ` +
        `this block — the runtime uses ${opcodes.map((o) => `${o.mnemonic} (${o.since})`).join(' and ')}` +
        ` (evmVersion '${ctx.evmVersion}'); for a block or chain before that fork, recompile ` +
        `with an older evmVersion ('paris' runs everywhere)`;
  return {
    kind: 'empty',
    message: `empty revert payload (no returndata) — ${callee}${frame}`,
    candidateSites,
    raw,
  };
}

/** The post-merge, fork-gated opcodes the runtime's CODE region uses (the data segments after
 *  the INVALID guard are never executed, so bytes there do not count). */
function forkOpcodesOf(ctx: ExplainContext): { mnemonic: string; since: EvmVersion }[] {
  const dataLabels = ctx.map.labels.filter((l) => l.name.startsWith('data_')).map((l) => l.pc);
  const codeEnd = dataLabels.length > 0 ? Math.min(...dataLabels) : Number.POSITIVE_INFINITY;
  const used = new Set<string>();
  for (const line of disassemble(ctx.runtimeBytecode).lines) {
    if (line.pc < codeEnd) used.add(line.mnemonic);
  }
  return FORK_GATED_OPCODES.filter((o) => used.has(o.mnemonic));
}

/** Newest fork first (the one most likely to be missing at a historical block). */
const FORK_GATED_OPCODES: readonly { mnemonic: string; since: EvmVersion }[] = [
  { mnemonic: 'MCOPY', since: 'cancun' },
  { mnemonic: 'PUSH0', since: 'shanghai' },
];

/** Message rendering of one decoded error arg — bigints (top-level or nested in a decoded
 *  struct/array arg) stringify as `123n`. */
function fmtErrorArg(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x));
}

// ---------------------------------------------------------------------------
// hex helpers (compile.ts must not depend on viem at runtime)
// ---------------------------------------------------------------------------

function decodeHex(hex: Hex, where: string): Uint8Array {
  if (!isHexString(hex)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: expected 0x-prefixed even-length hex data, got ${JSON.stringify(hex)}`,
    );
  }
  return hexToBytes(hex);
}
