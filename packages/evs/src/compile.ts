// STUB — replaced by module agent
// Signatures copied faithfully from docs/design/module-interfaces.md §M9 + api.md §10 (frozen).
import type { Address } from 'abitype';

import type { ScriptAbi } from './abi/artifact.js';
import type { AsmNode } from './asm/assembler.js';
import type { Disassembly } from './asm/disasm.js';
import type { EvmVersion } from './asm/ops.js';
import type { SourceMap } from './asm/sourcemap.js';
import type { EvsScript } from './builder/script.js';
import type { EvsDiagnostic, SourceLoc } from './core/errors.js';
import type { ArgSpec, Expr, Hex } from './core/types.js';
import type { ScriptIr, SiteId } from './ir/nodes.js';

export interface CompileOptions {
  evmVersion?: EvmVersion; // default 'cancun'
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]; // default identity (no optimizer in v0)
  onDiagnostic?: (d: EvsDiagnostic) => void; // warnings (e.g. LOOP_ALLOCATION); never logged
  locations?: boolean; // default true
}

export interface CompiledEvsScript<
  name extends string = string,
  args extends readonly ArgSpec[] = readonly ArgSpec[],
  ret extends Record<string, Expr> = Record<string, Expr>,
> {
  readonly abi: ScriptAbi<name, args, ret>; // literal-typed: [function, EvsInvalidCalldata, EvsDecodeError]
  readonly runtimeBytecode: Hex; // ≤ 24,576 bytes (EIP-170), enforced
  readonly initBytecode: Hex; // 61RRRR80600A5F395FF3 ++ runtime (paris: 5F→3D)
  readonly sourceMap: SourceMap;
  readonly ir: ScriptIr;
  readonly options: Readonly<Required<CompileOptions>>;
  toViem(): { abi: ScriptAbi<name, args, ret>; code: Hex }; // deployless (default)
  toViem(o: { mode: 'deployless' }): { abi: ScriptAbi<name, args, ret>; code: Hex };
  toViem(o: { mode: 'stateOverride'; address?: Address }): {
    abi: ScriptAbi<name, args, ret>;
    address: Address;
    stateOverride: readonly [{ address: Address; code: Hex }];
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

export declare function compile<s extends EvsScript>(
  script: s,
  options?: CompileOptions,
): CompiledOf<s>;

export type CompiledOf<s> =
  s extends EvsScript<
    infer n extends string,
    infer a extends readonly ArgSpec[],
    infer r extends Record<string, Expr>
  >
    ? CompiledEvsScript<n, a, r>
    : never;
// pipeline: validateIr → lowerProgram → peephole (user hook) → assemble(verify) →
// EIP-170 check (per-region breakdown via labelNames) → merge sites into sourceMap →
// build artifact. Diagnostics forwarded to onDiagnostic; nothing logged.
