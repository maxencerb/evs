/**
 * M9 `compile.ts` — pipeline orchestration (architecture §1/§12):
 *
 *   validateIr → lowerProgram → peephole (user hook) → assemble(verify: jumpdests, stack,
 *   shapes) → EIP-170 check (per-region breakdown via labelNames) → merge sites into the
 *   sourceMap → build the artifact.
 *
 * Diagnostics from lowering are forwarded to `options.onDiagnostic`; nothing is ever logged.
 * `explainRevert` decodes the on-chain error set (architecture §11/§13): `Panic(uint256)`
 * (with candidate sites from `sourceMap.sites`), `EvsDecodeError(uint256 site)` (exact site),
 * `EvsInvalidCalldata()`, `Error(string)`, custom selectors, and the empty revert.
 */

import type { Address } from 'abitype';

import { canonicalTypeSignature, selectorOf, type ScriptAbi } from './abi/artifact.js';
import { assemble, type AsmNode, type LabelId } from './asm/assembler.js';
import { disassemble, type Disassembly } from './asm/disasm.js';
import type { EvmVersion } from './asm/ops.js';
import { siteById, type SourceMap } from './asm/sourcemap.js';
import type { EvsScript, ReturnValue } from './builder/script.js';
import { lowerProgram } from './codegen/program.js';
import {
  EvsCompileError,
  EvsTypeError,
  type EvsDiagnostic,
  type SourceLoc,
} from './core/errors.js';
import type { ArgSpec, Hex } from './core/types.js';
import { walkStmts, type ScriptIr, type SiteId } from './ir/nodes.js';
import { validateIr } from './ir/validate.js';
import { DEFAULT_SCRIPT_ADDRESS, toCreationBytecode, toViemDeployless } from './viem.js';

// ---------------------------------------------------------------------------
// frozen contract (module-interfaces §M9 + api.md §10)
// ---------------------------------------------------------------------------

export interface CompileOptions {
  evmVersion?: EvmVersion; // default 'cancun'
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]; // default identity (no optimizer in v0)
  onDiagnostic?: (d: EvsDiagnostic) => void; // warnings (e.g. LOOP_ALLOCATION); never logged
  locations?: boolean; // default true
}

export interface CompiledEvsScript<
  name extends string = string,
  args extends readonly ArgSpec[] = readonly ArgSpec[],
  ret extends Record<string, ReturnValue> = Record<string, ReturnValue>,
> {
  readonly abi: ScriptAbi<name, args, ret>; // literal-typed: [function, EvsInvalidCalldata, EvsDecodeError]
  readonly runtimeBytecode: Hex; // ≤ 24,576 bytes (EIP-170), enforced
  readonly initBytecode: Hex; // 61RRRR80600A5F395FF3 ++ runtime (paris: 5F→3D)
  readonly sourceMap: SourceMap;
  readonly ir: ScriptIr;
  readonly options: Readonly<Required<CompileOptions>>;
  toViem(): { abi: ScriptAbi<name, args, ret>; code: Hex }; // deployless (default)
  toViem(o: { mode: 'deployless' }): { abi: ScriptAbi<name, args, ret>; code: Hex };
  // NOTE: the stateOverride tuple is mutable (not `readonly`) because viem's `StateOverride`
  // is a mutable `Array` type — a readonly tuple would not spread into `readContract`.
  toViem(o: { mode: 'stateOverride'; address?: Address }): {
    abi: ScriptAbi<name, args, ret>;
    address: Address;
    stateOverride: [{ address: Address; code: Hex }];
  };
  disassemble(): Disassembly; // .format() → annotated listing with source lines
  explainRevert(data: Hex): RevertExplanation;
}

export interface RevertExplanation {
  kind: 'panic' | 'evs-decode' | 'evs-invalid-calldata' | 'error-string' | 'custom' | 'empty';
  message: string;
  panicCode?: bigint;
  site?: { id: SiteId; loc: SourceLoc | null; detail: string };
  candidateSites?: readonly { id: SiteId; loc: SourceLoc | null; detail: string }[]; // Panic only
  raw: Hex;
}

export type CompiledOf<s> =
  s extends EvsScript<
    infer n extends string,
    infer a extends readonly ArgSpec[],
    infer r extends Record<string, ReturnValue>
  >
    ? CompiledEvsScript<n, a, r>
    : never;

// DEVIATION (recorded): the law writes `compile<s extends EvsScript>`, but a concrete
// multi-return script is NOT assignable to the default-instantiated `EvsScript` — the
// `ScriptAbi` default collapses `Record<string, Expr>` components to a 1-tuple via
// UnionToTuple, so `EvsScript<'x', […], { a; b }>` fails the constraint and every real
// script would be rejected. The constraint below is the minimal structural relaxation;
// `CompiledOf<s>` (and therefore the result type) is exactly the law's.
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
const EVM_VERSIONS: ReadonlySet<string> = new Set(['paris', 'shanghai', 'cancun']);

function identityPeephole(nodes: readonly AsmNode[]): AsmNode[] {
  return [...nodes];
}

function ignoreDiagnostic(_d: EvsDiagnostic): void {
  // default sink — diagnostics are delivered only through a user-provided callback
}

function resolveOptions(options: CompileOptions | undefined): Readonly<Required<CompileOptions>> {
  const evmVersion = options?.evmVersion ?? 'cancun';
  if (!EVM_VERSIONS.has(evmVersion)) {
    throw new EvsCompileError(
      'EVM_VERSION',
      `compile: unknown evmVersion ${JSON.stringify(evmVersion)} — expected 'paris', 'shanghai' or 'cancun'`,
    );
  }
  return Object.freeze({
    evmVersion,
    peephole: options?.peephole ?? identityPeephole,
    onDiagnostic: options?.onDiagnostic ?? ignoreDiagnostic,
    locations: options?.locations ?? true,
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
  validateIr(ir);

  const lowered = lowerProgram(ir, {
    evmVersion: resolved.evmVersion,
    locations: resolved.locations,
  });
  for (const diagnostic of lowered.diagnostics) resolved.onDiagnostic(diagnostic);

  const assembled = assemble(lowered.nodes, {
    evmVersion: resolved.evmVersion,
    peephole: resolved.peephole,
    verify: true,
  });

  if (assembled.bytecode.length > EIP170_LIMIT) {
    throw new EvsCompileError(
      'COMPILE_LIMIT',
      eip170Message(assembled.bytecode.length, assembled.labelPcs, lowered.labelNames),
      { loc: ir.loc },
    );
  }

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

  function toViem(): { abi: typeof abi; code: Hex };
  function toViem(o: { mode: 'deployless' }): { abi: typeof abi; code: Hex };
  function toViem(o: { mode: 'stateOverride'; address?: Address }): {
    abi: typeof abi;
    address: Address;
    stateOverride: [{ address: Address; code: Hex }];
  };
  function toViem(o?: {
    mode?: 'deployless' | 'stateOverride';
    address?: Address;
  }):
    | { abi: typeof abi; code: Hex }
    | { abi: typeof abi; address: Address; stateOverride: [{ address: Address; code: Hex }] } {
    if (o?.mode === 'stateOverride') {
      const address = o.address ?? DEFAULT_SCRIPT_ADDRESS;
      return { abi, address, stateOverride: [{ address, code: runtimeBytecode }] };
    }
    return toViemDeployless({ abi, initBytecode });
  }

  const artifact: CompiledEvsScript = {
    abi,
    runtimeBytecode,
    initBytecode,
    sourceMap,
    ir,
    options: resolved,
    toViem,
    disassemble: (): Disassembly => disassemble(runtimeBytecode, sourceMap),
    explainRevert: (data: Hex): RevertExplanation => explainRevert(data, ir, sourceMap),
  };
  return Object.freeze(artifact);
}

// ---------------------------------------------------------------------------
// EIP-170 per-region breakdown (architecture §10 — "C's actionable variant")
// ---------------------------------------------------------------------------

/** Shared-tail label names emitted by codegen/tails.ts (architecture §11/§15.0). */
const TAIL_LABEL_NAMES: ReadonlySet<string> = new Set([
  'panic_overflow',
  'panic_divzero',
  'panic_bounds',
  'panic_alloc',
  'panic',
  'badcd',
  'decode_revert',
  'memcpy',
  'memcpy_loop',
  'memcpy_done',
]);

function eip170Message(
  total: number,
  labelPcs: ReadonlyMap<LabelId, number>,
  labelNames: ReadonlyMap<LabelId, string>,
): string {
  const minPcWhere = (match: (name: string) => boolean): number | undefined => {
    let min: number | undefined;
    for (const [id, pc] of labelPcs) {
      const name = labelNames.get(id);
      if (name !== undefined && match(name) && (min === undefined || pc < min)) min = pc;
    }
    return min;
  };

  // program order: prologue+dispatcher · @main(arg decode + body + return encode) ·
  // @fn_* subroutines · @dfail_* stubs + shared tails · INVALID guard + data segments
  const mainPc = minPcWhere((n) => n === 'main') ?? 0;
  const fnPc = minPcWhere((n) => n.startsWith('fn_'));
  const tailPc = minPcWhere((n) => n.startsWith('dfail_') || TAIL_LABEL_NAMES.has(n));
  const firstDataPc = minPcWhere((n) => n.startsWith('data_'));
  const dataPc = firstDataPc === undefined ? undefined : firstDataPc - 1; // INVALID guard byte

  const dataStart = dataPc ?? total;
  const tailEnd = dataStart;
  const fnEnd = tailPc ?? tailEnd;
  const bodyEnd = fnPc ?? fnEnd;

  const dispatcher = mainPc;
  const body = Math.max(bodyEnd - mainPc, 0);
  const fns = fnPc === undefined ? 0 : Math.max(fnEnd - fnPc, 0);
  const tails = tailPc === undefined ? 0 : Math.max(tailEnd - tailPc, 0);
  const data = Math.max(total - dataStart, 0);

  return (
    `runtime bytecode is ${total} bytes — exceeds the EIP-170 limit of ${EIP170_LIMIT} by ` +
    `${total - EIP170_LIMIT} bytes (dispatcher ${dispatcher}, body ${body}, fns ${fns}, ` +
    `tails ${tails}, data segments ${data}); split the script or move large literals off-chain`
  );
}

// ---------------------------------------------------------------------------
// explainRevert (architecture §11/§13; api.md §11 E7)
// ---------------------------------------------------------------------------

// selectors computed once via the sanctioned helper (M3 invariant)
const PANIC_SELECTOR = selectorOf('Panic', ['uint256']); // 0x4e487b71
const ERROR_STRING_SELECTOR = selectorOf('Error', ['string']); // 0x08c379a0
const DECODE_ERROR_SELECTOR = selectorOf('EvsDecodeError', ['uint256']);
const INVALID_CALLDATA_SELECTOR = selectorOf('EvsInvalidCalldata', []);

const PANIC_MEANINGS: Readonly<Record<string, string>> = {
  '0x00': 'generic compiler panic',
  '0x01': 'assertion failure (assert)',
  '0x11': 'arithmetic overflow or underflow',
  '0x12': 'division or modulo by zero',
  '0x21': 'invalid enum conversion',
  '0x22': 'corrupted storage byte array',
  '0x31': 'pop on an empty array',
  '0x32': 'array index out of bounds',
  '0x41': 'allocation too large (out of memory)',
  '0x51': 'call to a zero-initialized internal function',
};

type SiteRef = { id: SiteId; loc: SourceLoc | null; detail: string };

function toSiteRef(site: SourceMap['sites'][number]): SiteRef {
  return { id: site.id, loc: site.loc, detail: site.detail };
}

function formatLoc(loc: SourceLoc | null): string {
  return loc === null ? '<unknown location>' : `${loc.file}:${loc.line}:${loc.column}`;
}

/**
 * Whether the script performs any sub-calls. The evs error selectors (`EvsDecodeError`,
 * `EvsInvalidCalldata`) are public constants — an adversarial callee can revert with them
 * verbatim and the script bubbles the payload byte-exactly, so for scripts WITH sub-calls
 * an attribution to a script site is a strong hint, never proof. Scripts without sub-calls
 * cannot bubble anything, so there the attribution is authoritative.
 */
function scriptHasSubcalls(ir: ScriptIr): boolean {
  let found = false;
  const look = (s: { k: string }): void => {
    if (s.k === 'call') found = true;
  };
  walkStmts(ir.body, look);
  for (const fn of ir.fns) walkStmts(fn.body, look);
  return found;
}

const CALLEE_FORGERY_HEDGE =
  ' — note: the script performs sub-calls and a callee may have reverted with this evs ' +
  'selector verbatim (bubbled byte-exactly), in which case the failure originated off-script';

function explainRevert(data: Hex, ir: ScriptIr, map: SourceMap): RevertExplanation {
  const bytes = hexToBytes(data, 'explainRevert');
  const raw = bytesToHex(bytes);

  if (bytes.length === 0) {
    return {
      kind: 'empty',
      message:
        'empty revert payload (no returndata) — a callee `revert()`/`require(false)` bubbled ' +
        'verbatim, or the call frame failed without a reason',
      raw,
    };
  }
  if (bytes.length < 4) {
    return {
      kind: 'custom',
      message: `malformed revert payload (${bytes.length} bytes — shorter than a 4-byte selector)`,
      raw,
    };
  }

  const selector = bytesToHex(bytes.subarray(0, 4));

  if (selector === PANIC_SELECTOR && bytes.length === 36) {
    const code = readWord(bytes, 4);
    const codeHex = `0x${code.toString(16).padStart(2, '0')}`;
    const meaning = PANIC_MEANINGS[codeHex] ?? 'unknown panic code';
    const candidateSites = map.sites
      .filter((s) => s.kind === 'panic' && s.detail.includes(codeHex))
      .map(toSiteRef);
    const where =
      candidateSites.length > 0
        ? ` — ${candidateSites.length} candidate site(s) in this script: ${candidateSites
            .map((s) => `${s.detail} at ${formatLoc(s.loc)}`)
            .join('; ')}`
        : ' — no candidate site of this panic kind exists in this script, so the payload was bubbled verbatim from a callee';
    return {
      kind: 'panic',
      message: `Panic(${codeHex}): ${meaning}${where}`,
      panicCode: code,
      candidateSites,
      raw,
    };
  }

  if (selector === DECODE_ERROR_SELECTOR && bytes.length === 36) {
    const id = readWord(bytes, 4);
    const idNum = id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : -1;
    const site = idNum >= 0 ? siteById(map, idNum) : undefined;
    const hedge = scriptHasSubcalls(ir) ? CALLEE_FORGERY_HEDGE : '';
    // only a 'decode'-kind site is a plausible script origin: the compiler emits
    // EvsDecodeError(site) exclusively from strict-call decode-fail stubs. Any other site id
    // (or an unknown one) cannot have been produced by this script's own code.
    if (site !== undefined && site.kind === 'decode') {
      const ref = toSiteRef(site);
      return {
        kind: 'evs-decode',
        message: `${ref.detail} failed (EvsDecodeError site ${ref.id}) — recorded at ${formatLoc(ref.loc)}${hedge}`,
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

  if (selector === INVALID_CALLDATA_SELECTOR && bytes.length === 4) {
    const signature = `${ir.name}(${ir.args.map((a) => canonicalTypeSignature(a.type)).join(',')})`;
    const hedge = scriptHasSubcalls(ir) ? CALLEE_FORGERY_HEDGE : '';
    return {
      kind: 'evs-invalid-calldata',
      message:
        `calldata does not match ${signature} — the script reverted EvsInvalidCalldata() ` +
        `(wrong selector, truncated calldata, or malformed dynamic arguments)${hedge}`,
      raw,
    };
  }

  if (selector === ERROR_STRING_SELECTOR) {
    const reason = tryDecodeErrorString(bytes);
    if (reason !== null) {
      return {
        kind: 'error-string',
        message: `callee revert bubbled verbatim: Error(${JSON.stringify(reason)})`,
        raw,
      };
    }
  }

  return {
    kind: 'custom',
    message:
      `custom error ${selector} bubbled verbatim from a callee (${bytes.length} byte payload) ` +
      `— decode it against the callee's ABI`,
    raw,
  };
}

/** Permissive `Error(string)` payload decode; returns null on any structural mismatch. */
function tryDecodeErrorString(bytes: Uint8Array): string | null {
  // [selector:4][offset:32][len:32][utf8 payload, zero-padded]
  if (bytes.length < 4 + 64) return null;
  const offset = readWord(bytes, 4);
  if (offset > BigInt(bytes.length)) return null;
  const lenAt = 4 + Number(offset);
  if (lenAt + 32 > bytes.length) return null;
  const len = readWord(bytes, lenAt);
  if (len > BigInt(bytes.length)) return null;
  const start = lenAt + 32;
  const end = start + Number(len);
  if (end > bytes.length) return null;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, end));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// hex helpers (compile.ts must not depend on viem at runtime)
// ---------------------------------------------------------------------------

const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

function hexToBytes(hex: Hex, where: string): Uint8Array {
  if (typeof hex !== 'string' || !HEX_BYTES_RE.test(hex)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: expected 0x-prefixed even-length hex data, got ${JSON.stringify(hex)}`,
    );
  }
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `0x${s}`;
}

function readWord(bytes: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 0; i < 32; i++) {
    v = (v << 8n) | BigInt(bytes[at + i] ?? 0);
  }
  return v;
}
