/**
 * `@maxencerb/evs` — the complete public surface.
 * Nothing else is exported from the package: single entry point, no subpath exports (the exports
 * map blocks deep imports, so every type named by a public signature must be re-exported here).
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
export type { EvsDiagnostic, EvsErrorCode } from './core/errors.js';
export type {
  AbiFunctionSignature, // issue #4: `'name(type,…)'` of an ABI function
  AbiParameterSignature, // one parameter's canonical type (`'(uint256,address)[]'`)
  AbiParametersSignature,
  SignatureName, // the bare name of a signature reference (`'get(uint256)'` → `'get'`)
} from './core/signature.js';
export { namedArg, t } from './core/types.js';
export type {
  AbiParamsToComponents, // issue #5: ABI-param → t.* type derivation helpers (t.fromOutputs/…)
  AbiParamToComponent,
  AbiParamToEvsType,
  Address,
  ArgName, // a script arg's ABI name, from its declarator (+ ResolveArgName / ToArgSpec)
  ArgsToInputs, // the `inputs` of ScriptAbi
  ArgSpec,
  ArgType,
  ArrayElemOf, // the element type of `Expr.at` (one `[]`/`[N]` suffix peeled)
  ArrayType,
  BitsType,
  BytesNOfUint, // the same-width bytesN of a uintN (`asBytesN()`'s result)
  BytesNType,
  BytesSize,
  DynType,
  EvsErrorAbiEntry, // issue #15: the literal { type: 'error', … } entry a t.error value carries
  EvsErrorType, // issue #15: a t.error-declared custom error
  EvsType,
  Expr,
  FixedLengthOf, // issue #4: the outermost fixed length of an array type (`null` for `[]`)
  FromAbiOutputs, // issue #5: the return type of `t.fromOutputs(abi, name)`
  Hex,
  IntoExpr,
  IntType,
  LitOf,
  NamedType,
  NoProtoKey, // t.struct / s.return reject a literal `__proto__` key at the type level
  NumericType,
  OrderedType, // the ordering domain of lt/gt/lte/gte: numeric, address and bytesN
  PeelArraySuffix, // issue #4: one `[]`/`[N]` suffix peeled off a type string, at any depth
  ResolveArgName,
  ScalarType,
  StringType,
  StructTypeOf,
  TupleArrayOf,
  TupleAsParam,
  TupleLitOf,
  TupleType,
  TupleTypeOf,
  ToArgSpec,
  TypeToComponent,
  UintBits,
  UintOfBytesN, // the same-width uintN of a bytesN (`asUint()`'s result)
  UintType,
  WordType,
} from './core/types.js';

// ir
export { deserializeIr, serializeIr } from './ir/nodes.js';
export type { ScriptIr, SiteId } from './ir/nodes.js'; // SiteId: RevertExplanation / SourceMap site ids
export { interpret } from './ir/interp.js';
export type {
  InterpEnvOverrides,
  InterpOptions, // interpret()'s opts: trace, maxSteps, env
  InterpResult,
  InterpValues, // the decoded return record interpret(script, …) types from the script's ABI
  MockChain,
} from './ir/interp.js';
export { dce, eliminateDeadCode } from './ir/dce.js'; // issue #40: the pass compile() runs, for tools

// abi
export { EVS_ERROR_ABI } from './abi/artifact.js';
export type { ErrorsToAbi, ReturnSpecToComponents, ScriptAbi } from './abi/artifact.js';

// asm
export type { AsmNode, LabelId } from './asm/assembler.js';
export { disassemble } from './asm/disasm.js';
export type { Disassembly, DisasmLine } from './asm/disasm.js';
export type { EvmVersion, Mnemonic } from './asm/ops.js'; // Mnemonic: AsmNode's `op`
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
  CallVerb, // issue #35: the s.call verb type (WriteVerb + the `revertReturns` overload)
  CallValue, // the type of `value`: uint256 for a payable resolved overload, a named compile error otherwise
  CallVerbOf, // the s.call / s.tryCall shape both alias, over the strict/try flavour
  Cell,
  ComponentToType,
  EncodeValue, // issue #17: what s.encode / s.keccak256 accept per value (any staged handle; #24)
  EnvKind, // the s.env kind argument
  EnvTypeOf,
  ErrorsInput, // issue #15: the def's `errors` input (one t.error value or a readonly list)
  EvsFn, // the return type of s.fn (+ its FnReturn / FnResult / Rebuild* helpers)
  EvsScript,
  Field,
  FnResult,
  FnReturn,
  IntoArray, // issue #5: array-typed slot accepts an Expr/literal or a bare MutArray
  IntoMember,
  IntoTuple,
  LabelCarrier, // the default label parameter of EvsFn / ArgHandles
  LoopCtl,
  MutArray,
  MutArrayElem, // MutArray.get / .expr element helpers
  MutArrayValueOf,
  NonEmptyReturn, // issue #66: s.return rejects an empty record at the type level
  NormalizeArgs,
  NormalizeErrors, // issue #15
  PackedValue, // issue #17: what s.encodePacked accepts per value
  ReturnValue,
  RebuildExprs,
  RebuildFnResult,
  ReadVerb, // issue #1: the s.read / s.tryRead verb types (ViewMutability, STATICCALL)
  ResolvedSubcallParams, // issue #4: the verb parameter object with `args` inferred for overload resolution
  ResolveOverload, // issue #4: the overload an overloaded `functionName` resolves to for given args
  RevertReturnHandles, // issue #35: the handles of a `revertReturns` list
  RevertReturnsParams, // issue #35: the s.call / s.tryCall `revertReturns` parameter object
  ScriptBuilder,
  ScriptReturn,
  SubcallFunctionName, // issue #4: what `functionName` accepts — names + canonical signatures
  SubcallInputs, // issue #1: per-verb arg/output/struct helpers, generic over the mutability bucket
  SubcallOutputs,
  SubcallParams,
  SubcallStruct, // issue #5: the `s.read({ …, struct: true })` result type
  SubcallVerb,
  SubcallVerbOf, // the verb shape every strict/try verb type aliases (one per mutability bucket)
  ThrowArgs, // issue #15: the rest-args shape of s.throw (record / tuple / none)
  ThrowArgRecord,
  ThrowArgTuple,
  Tried, // a verb result in its strict (bare) or try (`{ success, value }`) flavour
  TryCallVerb, // issue #35: the s.tryCall verb type (TryWriteVerb + the `revertReturns` overload)
  TryReadVerb,
  TrySubcallVerb,
  TryWriteVerb,
  Tuple,
  TupleArrayElem,
  TupleArrayElemHandle, // issue #12 post-review: the `.at`/`s.forEach` tuple-array element handle
  TupleArrayTag, // a tuple-array descriptor tag (`'tuple[]'`, `'tuple[2]'`, …): the s.forEach / .at bound
  TupleInit,
  TypeOfReturn, // the type a return value contributes (ReturnSpecToComponents)
  UnwrapSingle, // the single-output unwrap of every read/call verb result
  ViewMutability, // issue #1: 'pure' | 'view'  — the s.read / s.tryRead mutability bucket
  WriteMutability, // issue #1: 'nonpayable' | 'payable' — the s.call / s.simulate bucket
  WideSubcallResult, // the s.read / s.call / s.simulate result on a widened (non-`as const`) ABI
  WriteVerb, // issue #1: the s.simulate / s.trySimulate verb types (CALL); the base of CallVerb
} from './builder/script.js';

// codegen
export { evsPeephole } from './codegen/peephole.js'; // issue #39: the built-in peephole pass behind compile({ optimize: true })

// compile + viem
export { compile } from './compile.js';
export type {
  CompiledEvsScript,
  CompiledOf, // the return type of compile()
  CompileOptions,
  RevertExplanation,
} from './compile.js';
export {
  DEPLOYLESS_MAX_DATA_BYTES, // EIP-3860 cap on viem's deployless creation data (args included)
  DEPLOYLESS_MAX_RESULT_BYTES, // EIP-170 cap on a deployless result
  deploylessDataSize,
  explainDeploylessError, // node creation errors (0xEF result, size caps) → an explanation
} from './deployless.js';
export type { DeploylessLimitExplanation } from './deployless.js';
export { decodeScriptError, DEFAULT_SCRIPT_ADDRESS, matchScriptError } from './viem.js';
export type {
  DecodedBuiltinError, // issue #15: the Panic/Error/unknown/empty decode arms
  DecodedScriptError, // issue #15: the name-discriminated union decodeScriptError yields
  ErrorArgsOf, // issue #15: one error entry's decoded args record
  HandlerResult, // the return type of matchScriptError
  ScriptErrorHandlers, // issue #15: the matchScriptError handler record (declared + `_`)
  ToViemMode, // 'deployless' | 'stateOverride' — a run-time mode for toViem()'s catch-all overload
} from './viem.js';
