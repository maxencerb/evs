/**
 * `builder/script.ts` — the public builder surface: `evscript`, `EvsScript`,
 * `ScriptBuilder`, `Cell`, `MutArray`, `LoopCtl`, `ScriptReturn`.
 *
 * The recording engine (scope stack, handle internals, folding, validation checklist) lives
 * in `builder/expr.ts`; this module owns the public types and wires the typed facade onto it.
 *
 * A barrel over `builder/script/`:
 * - `evscript.ts` — the entry point: `evscript`, `EvsScript`, the error / arg-handle input types;
 * - `handles.ts` — cells, mutable arrays, loop control, tuple / struct handles (and the
 *   tuple-array `Expr` augmentation), return values and env;
 * - `calls.ts` — the call-verb types: overload resolution, inputs / outputs, the six verbs;
 * - `builder.ts` — `s.fn` types, `ScriptBuilder` and the facade over the `Recorder` engine.
 */

// `ArgInput` / `ArgsInput` / `ToArgSpec` / `NormalizeArgs` moved to core/types.ts (issue #15
// — `t.error` params take the same shorthand and core takes no builder import); re-exported
// verbatim so the builder's public surface is unchanged.
export type { ArgInput, ArgsInput, NormalizeArgs, ToArgSpec } from '../core/types.js';
export { evscript } from './script/evscript.js';
export type {
  EvsScript,
  ErrorsInput,
  NormalizeErrors,
  ThrowArgRecord,
  ThrowArgTuple,
  ThrowArgs,
  ArgHandle,
  ArgHandles,
  LabelCarrier,
} from './script/evscript.js';
export type {
  Cell,
  MutArrayValueOf,
  MutArrayElem,
  MutArray,
  LoopCtl,
  ComponentToType,
  IntoTuple,
  IntoArray,
  IntoMember,
  Field,
  Tuple,
  TupleArrayElem,
  TupleArrayElemHandle,
  TupleArrayTag,
  tupleBrand,
  AnyTuple,
  mutArrayBrand,
  AnyMutArray,
  EncodeValue,
  PackedValue,
  ReturnValue,
  TypeOfReturn,
  TupleInit,
  NonEmptyReturn,
  returnBrand,
  ScriptReturn,
  EnvKind,
  EnvTypeOf,
} from './script/handles.js';
export type {
  ViewMutability,
  WriteMutability,
  SubcallFunctionName,
  ResolveOverload,
  SubcallInputs,
  SubcallOutputs,
  UnwrapSingle,
  SubcallStruct,
  SubcallParams,
  ResolvedSubcallParams,
  SubcallVerb,
  TrySubcallVerb,
  ReadVerb,
  TryReadVerb,
  WriteVerb,
  TryWriteVerb,
  RevertReturnsParams,
  RevertReturnHandles,
  CallVerb,
  TryCallVerb,
} from './script/calls.js';
export type {
  FnReturn,
  FnResult,
  RebuildFnResult,
  RebuildExprs,
  EvsFn,
  ScriptBuilder,
} from './script/builder.js';
