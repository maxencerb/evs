/**
 * `@maxencerb/evs` — the complete public surface per docs/design/module-interfaces.md §M9.
 * Nothing else is exported from the package; single entry point, no subpath exports in v0.
 *
 * Additions to the frozen §M9 list (recorded in docs/design/amendments.md):
 * - `InterpEnvOverrides` — the `interpret` opts.env extension (frame-dependent env modeling);
 * - `AsmNode`, `LabelId`, `EvmVersion` (type-only) — referenced by the public `CompileOptions`
 *   but previously unreachable through the single entry point (the exports map blocks deep
 *   imports).
 * - issue #5 composite-ergonomics types (amendments §17): `FromAbiOutputs`, `AbiParamToEvsType`,
 *   `AbiParamsToComponents`, `AbiParamToComponent` (the `t.fromOutputs`/`t.fromAbiParameter`
 *   derivations); `AnyTuple`, `AnyMutArray`, `ReturnValue`, `IntoMember`, `IntoTuple`, `IntoArray`
 *   (the widened return/member surface); `SubcallStruct` (the `s.read({ …, struct: true })` result).
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
export { namedArg, t } from './core/types.js';
export type {
  AbiParamsToComponents, // issue #5: ABI-param → t.* type derivation helpers (t.fromOutputs/…)
  AbiParamToComponent,
  AbiParamToEvsType,
  Address,
  ArgSpec,
  ArgType,
  ArrayElemOf, // the element type of `Expr.at` (one `[]` peeled — amendment 18.1)
  ArrayType,
  BitsType,
  BytesNType,
  BytesSize,
  DynType,
  EvsType,
  Expr,
  FromAbiOutputs, // issue #5: the return type of `t.fromOutputs(abi, name)`
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
  AnyMutArray, // issue #5: the erased MutArray brand (bare-MutArray return/array-slot widening)
  AnyTuple,
  ArgHandle,
  ArgHandles,
  ArgInput, // issue #9: one top-level arg declarator (a bare type or a namedArg)
  ArgsInput,
  Cell,
  ComponentToType,
  EncodeValue, // issue #17: what s.encode accepts per value (any staged handle)
  EvsScript,
  Field,
  IntoArray, // issue #5: array-typed slot accepts an Expr/literal or a bare MutArray
  IntoMember,
  IntoTuple,
  LoopCtl,
  MutArray,
  NormalizeArgs,
  PackedValue, // issue #17: what s.encodePacked / s.keccak256 accept per value
  ReturnValue,
  ReadVerb, // issue #1: the s.read / s.tryRead verb types (ViewMutability, STATICCALL)
  ScriptBuilder,
  ScriptReturn,
  SubcallInputs, // issue #1: per-verb arg/output/struct helpers, generic over the mutability bucket
  SubcallOutputs,
  SubcallParams,
  SubcallStruct, // issue #5: the `s.read({ …, struct: true })` result type
  SubcallVerb,
  TryReadVerb,
  TrySubcallVerb,
  TryWriteVerb,
  Tuple,
  TupleInit,
  ViewMutability, // issue #1: 'pure' | 'view'  — the s.read / s.tryRead mutability bucket
  WriteMutability, // issue #1: 'nonpayable' | 'payable' — the s.call / s.simulate bucket
  WriteVerb, // issue #1: the s.call / s.tryCall / s.simulate / s.trySimulate verb types (CALL)
} from './builder/script.js';

// compile + viem
export { compile } from './compile.js';
export type { CompiledEvsScript, CompileOptions, RevertExplanation } from './compile.js';
export { DEFAULT_SCRIPT_ADDRESS } from './viem.js';
