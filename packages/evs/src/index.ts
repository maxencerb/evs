/**
 * `@maxencerb/evs` — the complete public surface per docs/design/module-interfaces.md §M9.
 * Nothing else is exported from the package; single entry point, no subpath exports in v0.
 *
 * Additions to the frozen §M9 list (recorded in docs/design/amendments.md):
 * - `InterpEnvOverrides` — the `interpret` opts.env extension (frame-dependent env modeling);
 * - `AsmNode`, `LabelId`, `EvmVersion` (type-only) — referenced by the public `CompileOptions`
 *   but previously unreachable through the single entry point (the exports map blocks deep
 *   imports).
 */

// core
export {
  EvsCompileError,
  EvsError,
  EvsInternalError,
  EvsScopeError,
  EvsStagingError,
  EvsTypeError,
} from './core/errors.js';
export type { EvsDiagnostic, EvsErrorCode, SourceLoc } from './core/errors.js';
export { arg, t } from './core/types.js';
export type {
  Address,
  ArgSpec,
  ArgType,
  ArrayType,
  BitsType,
  BytesNType,
  BytesSize,
  DynType,
  EvsType,
  Expr,
  Hex,
  IntoExpr,
  IntType,
  LitOf,
  NamedType,
  NumericType,
  ScalarType,
  StringType,
  StructTypeOf,
  TupleArrayOf,
  TupleAsParam,
  TupleLitOf,
  TupleType,
  TupleTypeOf,
  TypeToComponent,
  UintBits,
  UintType,
  WordType,
} from './core/types.js';

// ir
export { deserializeIr, serializeIr } from './ir/nodes.js';
export type { ScriptIr } from './ir/nodes.js';
export { interpret } from './ir/interp.js';
export type { InterpEnvOverrides, InterpResult, MockChain } from './ir/interp.js';

// abi
export { EVS_ERROR_ABI } from './abi/artifact.js';
export type { ScriptAbi } from './abi/artifact.js';

// asm
export type { AsmNode, LabelId } from './asm/assembler.js';
export { disassemble } from './asm/disasm.js';
export type { Disassembly } from './asm/disasm.js';
export type { EvmVersion } from './asm/ops.js';
export { lookupPc } from './asm/sourcemap.js';
export type { SourceMap } from './asm/sourcemap.js';

// builder
export { evscript } from './builder/script.js';
export type {
  ArgHandle,
  ArgHandles,
  ArgsInput,
  Cell,
  ComponentToType,
  EvsScript,
  Field,
  LoopCtl,
  MutArray,
  NormalizeArgs,
  ScriptBuilder,
  ScriptReturn,
  Tuple,
  TupleInit,
} from './builder/script.js';

// compile + viem
export { compile } from './compile.js';
export type { CompiledEvsScript, CompileOptions, RevertExplanation } from './compile.js';
export { DEFAULT_SCRIPT_ADDRESS } from './viem.js';
