/**
 * `compile.ts` — pipeline orchestration:
 *
 *   validateIr → eliminateDeadCode (ir/dce.ts, always on) → lowerProgram (re-validates)
 *   [optimize: liveness frame allocator, store–reload fusion] → [optimize: built-in
 *   evsPeephole] → peephole (user
 *   hook) → assemble(EIP-170 check from its layout hook, before fixups — per-region breakdown
 *   from the region labels lowering reports; then verify: jumpdests, stack, shapes) → merge
 *   sites into the sourceMap → build the artifact.
 *
 * `optimize` (default false) is the single switch for the three built-in optimizer passes: the
 * liveness-based frame allocator behind `codegen/frame.ts` (slot reuse across dead values,
 * issue #41), store–reload fusion (`codegen/fuse.ts`, issue #96: a value whose slot is read
 * once, by the next statement, stays on the stack; it runs inside `lowerProgram`, where the use
 * counts live) and the asm-level peephole pass (`codegen/peephole.ts`, issue #39) — dead-code
 * elimination is not an optimizer pass and always runs. The peephole pass runs at the same hook
 * position as the user `peephole` hook and BEFORE it, so a user hook always sees the optimized
 * stream, and the verifiers always see the final one. With `optimize: false` the pipeline is
 * byte-identical to the unoptimized lowering.
 *
 * Diagnostics from lowering, then the deployless result checks (`deployless.ts`), are forwarded
 * to `options.onDiagnostic`; nothing is ever logged.
 *
 * Two members of the artifact live in compiler-free modules, which a precompiled script reuses
 * without this file: `toViem()` (`viem.ts`) and `explainRevert` (`explain.ts`).
 * `toPrecompiled()` narrows the artifact to that shippable form (`precompiled.ts`).
 */

import type { ScriptAbi } from './abi/artifact.js';
import { assemble, type AsmNode, type LabelId } from './asm/assembler.js';
import { disassemble, type Disassembly } from './asm/disasm.js';
import type { EvmVersion } from './asm/ops.js';
import type { SourceMap } from './asm/sourcemap.js';
import type { EvsScript, ReturnValue } from './builder/script.js';
import { CodecPlanDrift } from './codegen/codecs.js';
import { evsPeephole } from './codegen/peephole.js';
import { lowerProgram, type LowerResult, type ProgramRegions } from './codegen/program.js';
import { bytesToHex } from './core/bytes.js';
import { EvsCompileError, EvsTypeError, type EvsDiagnostic } from './core/errors.js';
import type { ArgSpec, EvsErrorType, Hex } from './core/types.js';
import { deploylessResultDiagnostics } from './deployless.js';
import { explainRevert, type RevertExplanation } from './explain.js';
import { eliminateDeadCode } from './ir/dce.js';
import type { ScriptIr } from './ir/nodes.js';
import { validateIr } from './ir/validate.js';
import { createPrecompiledScript, type PrecompiledScript } from './precompiled.js';
import { assertEvmVersion, createToViem, toCreationBytecode, type ToViem } from './viem.js';

export type { RevertExplanation } from './explain.js';

// ---------------------------------------------------------------------------
// public contract
// ---------------------------------------------------------------------------

export interface CompileOptions {
  evmVersion?: EvmVersion; // default 'cancun'
  optimize?: boolean; // default false — enables the three built-in optimizer passes (the liveness-based frame allocator, store–reload fusion of single-use temporaries, and the asm peephole pass `evsPeephole`); output is still fully verified
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
  readonly toViem: ToViem<ScriptAbi<name, args, ret, errs>>; // deployless by default; see ToViem
  disassemble(): Disassembly; // .format() → listing with labels, jump targets and notes
  explainRevert(data: Hex): RevertExplanation;
  /** The precompiled script: the ABI, the bytecode and `toViem()`, without the compiler. What a
   *  build step serializes (`toJSON()` and `debug()`) and a client hydrates back. */
  toPrecompiled(): PrecompiledScript<ScriptAbi<name, args, ret, errs>>;
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
  const lowered = lowerWithCodecFallback(eliminateDeadCode(ir), {
    evmVersion: resolved.evmVersion,
    optimize: resolved.optimize,
  });
  for (const diagnostic of lowered.diagnostics) resolved.onDiagnostic(diagnostic);
  for (const diagnostic of deploylessResultDiagnostics(ir)) {
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
  const { evmVersion } = resolved;
  const { sites } = sourceMap;

  const artifact: CompiledEvsScript = {
    abi,
    runtimeBytecode,
    initBytecode,
    sourceMap,
    ir,
    options: resolved,
    toViem: createToViem({ abi, runtimeBytecode, initBytecode }),
    // the assembler's bytes, not `runtimeBytecode`: no hex round trip (disassemble never writes)
    disassemble: (): Disassembly => disassemble(assembled.bytecode, sourceMap),
    explainRevert: (data: Hex): RevertExplanation =>
      explainRevert(data, { ir, sites, abi, runtimeBytecode, evmVersion }),
    // the debug data and the explain code are already in memory here; a hydrated script loads
    // both on demand
    toPrecompiled: () =>
      createPrecompiledScript(
        { version: 1, abi, runtimeBytecode, evmVersion },
        {
          debug: () => Promise.resolve({ version: 1, ir, sites }),
          explain: () => Promise.resolve(explainRevert),
        },
      ),
  };
  return Object.freeze(artifact);
}

/**
 * `lowerProgram`, falling back to the inline lowering when the codec-sharing census and the
 * emitters disagree (`CodecPlanDrift`, `codegen/codecs.ts`): such a drift only ever costs the
 * saving, never a failed compile. Every other error propagates.
 */
function lowerWithCodecFallback(
  ir: ScriptIr,
  opts: { evmVersion: EvmVersion; optimize: boolean },
): LowerResult {
  try {
    return lowerProgram(ir, opts);
  } catch (error) {
    if (!(error instanceof CodecPlanDrift)) throw error;
    return lowerProgram(ir, { ...opts, shareCodecs: false });
  }
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
  // @fn_* subroutines · @simulate_trampoline (only with s.simulate) · @enc_<k> / @dec_<k> shared
  // codec bodies (only when some codec is shared) · @dfail_* stubs + shared tails · INVALID
  // guard + data segments
  const mainPc = pcOf(regions.main) ?? 0;
  const fnPc = pcOf(regions.fns);
  const trampolinePc = pcOf(regions.trampoline);
  const codecPc = pcOf(regions.codecs);
  const tailPc = pcOf(regions.tails);
  const firstDataPc = pcOf(regions.data);
  const dataPc = firstDataPc === undefined ? undefined : firstDataPc - 1; // INVALID guard byte

  const dataStart = dataPc ?? total;
  const tailEnd = dataStart;
  const codecEnd = tailPc ?? tailEnd;
  const trampolineEnd = codecPc ?? codecEnd;
  const fnEnd = trampolinePc ?? trampolineEnd;
  const bodyEnd = fnPc ?? fnEnd;

  const dispatcher = mainPc;
  const body = Math.max(bodyEnd - mainPc, 0);
  const fns = fnPc === undefined ? 0 : Math.max(fnEnd - fnPc, 0);
  const trampoline =
    trampolinePc === undefined ? '' : `trampoline ${Math.max(trampolineEnd - trampolinePc, 0)}, `;
  const codecs = codecPc === undefined ? '' : `codecs ${Math.max(codecEnd - codecPc, 0)}, `;
  const tails = tailPc === undefined ? 0 : Math.max(tailEnd - tailPc, 0);
  const data = Math.max(total - dataStart, 0);

  return (
    `runtime bytecode is ${total} bytes — exceeds the EIP-170 limit of ${EIP170_LIMIT} by ` +
    `${total - EIP170_LIMIT} bytes (dispatcher ${dispatcher}, body ${body}, fns ${fns}, ` +
    `${trampoline}${codecs}tails ${tails}, data segments ${data}); split the script or move large ` +
    `literals off-chain`
  );
}
