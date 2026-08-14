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
 * - `TupleArrayElemHandle` (issue #12 post-review, amendments §25) — the tuple-array element
 *   handle named by the public `Expr.at` / `s.forEach` signatures.
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
  EvsErrorAbiEntry, // issue #15: the literal { type: 'error', … } entry a t.error value carries
  EvsErrorType, // issue #15: a t.error-declared custom error
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
  EncodeValue, // issue #17: what s.encode / s.keccak256 accept per value (any staged handle; #24)
  ErrorsInput, // issue #15: the def's `errors` input (one t.error value or a readonly list)
  EvsScript,
  Field,
  IntoArray, // issue #5: array-typed slot accepts an Expr/literal or a bare MutArray
  IntoMember,
  IntoTuple,
  LoopCtl,
  MutArray,
  NormalizeArgs,
  NormalizeErrors, // issue #15
  PackedValue, // issue #17: what s.encodePacked accepts per value
  ReturnValue,
  ReadVerb, // issue #1: the s.read / s.tryRead verb types (ViewMutability, STATICCALL)
  ScriptBuilder,
  ScriptReturn,
  SubcallInputs, // issue #1: per-verb arg/output/struct helpers, generic over the mutability bucket
  SubcallOutputs,
  SubcallParams,
  SubcallStruct, // issue #5: the `s.read({ …, struct: true })` result type
  SubcallVerb,
  ThrowArgs, // issue #15: the rest-args shape of s.throw (record / tuple / none)
  TryReadVerb,
  TrySubcallVerb,
  TryWriteVerb,
  Tuple,
  TupleArrayElemHandle, // issue #12 post-review: the `.at`/`s.forEach` tuple-array element handle
  TupleInit,
  ViewMutability, // issue #1: 'pure' | 'view'  — the s.read / s.tryRead mutability bucket
  WriteMutability, // issue #1: 'nonpayable' | 'payable' — the s.call / s.simulate bucket
  WriteVerb, // issue #1: the s.call / s.tryCall / s.simulate / s.trySimulate verb types (CALL)
} from './builder/script.js';

// compile + viem
export { compile } from './compile.js';
export type { CompiledEvsScript, CompileOptions, RevertExplanation } from './compile.js';
export { decodeScriptError, DEFAULT_SCRIPT_ADDRESS, matchScriptError } from './viem.js';
export type {
  DecodedBuiltinError, // issue #15: the Panic/Error/unknown/empty decode arms
  DecodedScriptError, // issue #15: the name-discriminated union decodeScriptError yields
  ErrorArgsOf, // issue #15: one error entry's decoded args record
  ScriptErrorHandlers, // issue #15: the matchScriptError handler record (declared + `_`)
} from './viem.js';
