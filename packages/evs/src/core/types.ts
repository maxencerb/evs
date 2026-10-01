/**
 * `core/types.ts` — the type vocabulary, `Expr` brand, `namedArg()`/`t`, and runtime type
 * predicates/metadata (single source of truth for all modules).
 *
 * A barrel over `core/types/`:
 * - `vocabulary.ts` — the type-string vocabulary (`EvsType` and its parts, array-suffix parsing);
 * - `expr.ts` — `Expr`, the branded staged-value handle, and its literal types;
 * - `args.ts` — `namedArg()`, args-input normalization and the `t.error` declaration types;
 * - `derive.ts` — type-level derivations (`StructTypeOf`, `AbiParamToEvsType`,
 *   `FromAbiOutputs`, …);
 * - `namespace.ts` — the `t` namespace and its runtime constructors;
 * - `predicates.ts` — runtime type predicates / metadata and the internal helpers.
 */

// `Address` is re-exported from `abitype`; type-only — abitype is the only import core may take.
export type { Address } from 'abitype';
export type {
  Hex,
  UintBits,
  BytesSize,
  UintType,
  IntType,
  BytesNType,
  WordType,
  DynType,
  ScalarType,
  StringType,
  ArrayType,
  TupleType,
  NamedType,
  EvsType,
  PeelArraySuffix,
  ArrayElemOf,
  FixedLengthOf,
  OuterArraySize,
  ArgType,
  NumericType,
  BitsType,
} from './types/vocabulary.js';
export type { exprBrand, Expr, LitOf, TupleLitOf, TupleAsParam, IntoExpr } from './types/expr.js';
export {
  IDENT_RE,
  PROTO_RESERVED,
  identProblem,
  hasPlainPrototype,
  namedArg,
  isArgSpecValue,
  normalizeArgsInput,
} from './types/args.js';
export type {
  ArgSpec,
  ArgInput,
  ArgsInput,
  ToArgSpec,
  NormalizeArgs,
  ArgName,
  ResolveArgName,
  ArgsToInputs,
  EvsErrorAbiEntry,
  EvsErrorType,
  NoProtoKey,
} from './types/args.js';
export type {
  TypeToComponent,
  StructTypeOf,
  TupleTypeOf,
  TupleArrayOf,
  AbiParamToComponent,
  AbiParamsToComponents,
  AbiParamToEvsType,
  FromAbiOutputs,
  UnionToTuple,
} from './types/derive.js';
export { t } from './types/namespace.js';
export {
  MAX_ARRAY_DEPTH,
  MAX_STATIC_SIZE,
  peelArraySuffix,
  arrayDepthOf,
  assertArrayDepth,
  isEvsType,
  isTupleTag,
  isTupleType,
  isEvsValueType,
  isWordType,
  isBitsOperand,
  arrayTypeOf,
  stringifyType,
  isNumeric,
  isSigned,
  bitsOf,
  isDynamicType,
  isPackedEncodable,
  isArrayValueType,
  isLengthType,
  fixedLengthOf,
  elemTypeOf,
  typesEqual,
  abiParamToType,
  typeToAbiParam,
  tupleArrayTag,
  explainBadTypeString,
  quoteTypeString,
  staticSizeOf,
  staticSizeMessage,
  installStagingTraps,
} from './types/predicates.js';
