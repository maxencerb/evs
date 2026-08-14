# evs — Module Interfaces (THE LAW for parallel implementation)

Status: FINAL — these contracts are **frozen**. An implementing agent may add private helpers
inside its module but may not change, rename, or extend any exported signature below without a
design-doc amendment. Two agents implementing neighboring modules must never need to talk: if
you think you need to, the contract is the answer.

Conventions for every module:

- ESM, `module: NodeNext` — relative imports carry explicit `.js` extensions.
- All exported types must survive `tsc -p tsconfig.build.json` declaration emit without
  widening.
- `Hex` = `` `0x${string}` `` (alias exported from `core/types.ts`); `Address` is re-exported
  from `abitype`.
- Every module ships its unit tests as `src/<module>/*.test.ts` (vitest, `unit` project) and
  type tests as `*.test-d.ts` where noted.
- Dependency DAG (enforced by `import/no-cycle` in oxlint):

```
core ──┬──→ ir ───────┬──→ builder ──→ index
       ├──→ abi ──────┤        ↑
       └──→ asm ──────┴──→ codegen ──→ compile ──→ viem? (viem ← compile types only)
                  ir ─────→ interp                 compile ──→ index
```

Precise allowed-imports per module are listed in each section. `viem` (the npm package) is a
peer dependency usable at **compile/recording time only** (selectors, ABI encoding of
literals); never in emitted-bytecode logic paths that must run without it… (it always runs in
TS — the point is: no other crypto/keccak dependency is permitted).

---

## M1. `core/` — types, errors, locations

Files: `src/core/types.ts`, `src/core/errors.ts`, `src/core/loc.ts`.
Imports allowed: `abitype` (types only). Nothing else.

### `core/types.ts`

```ts
export type Hex = `0x${string}`
export type UintBits = 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64 | 72 | 80 | 88 | 96 | 104 | 112
  | 120 | 128 | 136 | 144 | 152 | 160 | 168 | 176 | 184 | 192 | 200 | 208 | 216 | 224 | 232
  | 240 | 248 | 256
export type BytesSize = 1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31|32
export type UintType = `uint${UintBits}`
export type IntType = `int${UintBits}`
export type BytesNType = `bytes${BytesSize}`
export type WordType = UintType | IntType | 'address' | 'bool' | BytesNType
export type DynType = 'string' | 'bytes'
// amended by #2 — scalars vs string-encoded arrays vs tuple OBJECTS:
export type ScalarType = WordType | DynType
export type ArrayType = `${ScalarType}[]` | `${ScalarType}[][]` | `${ScalarType}[][][]`
export type StringType = ScalarType | ArrayType                          // every string-encoded type
export interface TupleType { readonly type: 'tuple' | 'tuple[]' | 'tuple[][]'
  readonly components: readonly NamedType[] }
export interface NamedType { readonly name: string; readonly type: string  // = PlainAbiParam shape
  readonly components?: readonly NamedType[] }
export type EvsType = WordType | DynType | ArrayType | TupleType          // string OR tuple object
export type ArgType = EvsType
export type NumericType = UintType | IntType
export type BitsType = UintType | BytesNType

export declare const exprBrand: unique symbol
export interface Expr<t extends EvsType = EvsType> { /* exactly api.md §3 — string-array `at` is
  `at(this: Expr<t & ArrayType>, …): Expr<ArrayElemOf<t>>` (amendment 18.1 — forward `infer` on the
  receiver's own `t`, type-equivalent to the prior `at<elem extends StringType>(this:
  Expr<`${elem}[]` & ArrayType>): Expr<elem>`, reformulated for `tsc` perf) plus a tuple-array
  overload `at<C extends TupleType>(this: Expr<C & {type:'tuple[]'}>, …): Tuple<elem>` (amended by
  #2 + the #2 follow-up: a tuple-array element handle) */ }
export type LitOf<t extends EvsType> = /* exactly api.md §3 — TupleType → TupleLitOf (amended #2) */
export type TupleLitOf<t extends TupleType> = AbiParameterToPrimitiveType<TupleAsParam<t>, 'inputs'>
export type TupleAsParam<t extends TupleType> = { readonly name: ''; readonly type: t['type']
  readonly components: t['components'] } & AbiParameter
export type IntoExpr<t extends EvsType> = Expr<t> | LitOf<t>

// ArgSpec is RETAINED; the declarator is `namedArg` (renamed from `arg` by #9). It names a
// TOP-LEVEL arg/param for BOTH `evscript` args and `s.fn` params, and the name now surfaces in the
// type (#9). The `arg` export is removed.
export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name
  readonly type: type
}
export function namedArg<const name extends string, const type extends EvsType>(  // #9: arg→namedArg
  name: name, type: type): ArgSpec<name, type>          // amended by #25: the full EvsType vocabulary
  // (words/dynamics/arrays AND t.struct/t.tuple — was StringType per #2; `s.fn` composite params
  // stay a v0 deferral, rejected at record time with UNSUPPORTED_V0)
// the `t` namespace gains `struct`/`tuple` and a tuple `array` overload (amended by #2); plus
// `fromOutputs`/`fromAbiParameter` ABI→type derivations (amended by #5 ask #4):
export const t: { /* every WordType|DynType key */ } & {
  array<const e extends StringType>(elem: e): `${e}[]`
  array<const e extends TupleType>(elem: e): TupleArrayOf<e>
  struct<const spec extends Record<string, EvsType>>(spec: spec): StructTypeOf<spec>
  tuple<const items extends readonly EvsType[]>(...items: items): TupleTypeOf<items>
  // derive an EvsType from an ABI function's outputs (single → its type; many → a named struct in
  // ABI order) / a single ABI parameter — sidesteps `UnionToTuple` key-order instability (#5 #4):
  fromOutputs<const abi extends Abi | readonly unknown[], const name extends string>(
    abi: abi, name: name): FromAbiOutputs<abi, name>
  fromAbiParameter<const p extends AbiParameter>(param: p): AbiParamToEvsType<p>
}
// the type-level namespace helpers (exported for the overloads + builder/abi):
export type TypeToComponent<name extends string, ty extends EvsType> = /* see core/types.ts */
export type StructTypeOf<spec extends Record<string, EvsType>>                // named-components tuple
export type TupleTypeOf<items extends readonly EvsType[]>                     // positional tuple
export type TupleArrayOf<e extends TupleType>  // one `[]` deeper. Amended by #12: the `type`
  // tag is computed by CONDITIONAL (concrete 'tuple' → the LITERAL 'tuple[]'), not by
  // template-and-intersect, which left the tag as the constraint-widened 'tuple[]'|'tuple[][]'
  // union and made tuple[] and tuple[][] values indistinguishable to the element dispatch.

// runtime type predicates / metadata (single source of truth for all modules; amended by #2 —
// the value-type guards accept `string | TupleType`, and tuple-aware helpers are added):
export function isEvsType(s: string): s is StringType      // string-only validity
export function isEvsValueType(v: unknown): v is EvsType    // string OR tuple, recursive validation
export function isWordType(s: string | TupleType): s is WordType    // false for tuples
export function isStringType(s: string): s is StringType
export function isTupleType(v: unknown): v is TupleType
export function isNumeric(s: EvsType): s is NumericType
export function isSigned(s: EvsType): boolean              // intN → true
export function bitsOf(s: WordType): number                // address→160, bool→8(canonical 0/1), bytesN→8N, u/intN→N
export function isDynamicType(s: EvsType): boolean         // string|bytes|T[]|tuple → true
export function isArrayValueType(s: EvsType): s is ArrayType | TupleType    // T[] or tuple array
export function elemTypeOf(s: ArrayType | TupleType): EvsType               // one `[]` peeled
export function typesEqual(a: EvsType, b: EvsType): boolean // STRUCTURAL — tuple descriptors are
  // fresh objects (never ===); ALL value-type comparisons in recorder/validate use this, not ===
export function isPackedEncodable(s: EvsType): boolean     // added by #17: abi.encodePacked's
  // accepted set — word | string | bytes | word-element array; false for tuples/nested/string[]
export function abiParamToType(p: { type: string; components?: readonly NamedType[] }): EvsType
export function typeToAbiParam(name: string, ty: EvsType): NamedType        // inverse
```

Invariants: `namedArg()` validates name (`/^[A-Za-z_]\w*$/`) and type (string types via
`assertEvsType`; tuple descriptors via `isEvsValueType` — #25), throws
`EvsTypeError` with `captureLoc()`, returns frozen object. `t.struct`/`t.tuple`/`t.array` validate
and freeze their result; `t` is frozen.

### `core/errors.ts`

```ts
export interface SourceLoc {
  file: string;
  line: number;
  column: number;
}
export type EvsErrorCode =
  | 'STAGING_MISUSE'
  | 'TYPE_MISMATCH'
  | 'LITERAL_RANGE'
  | 'CERTAIN_PANIC'
  | 'SCOPE_VIOLATION'
  | 'FOREIGN_HANDLE'
  | 'RECORDING_CLOSED'
  | 'UNSUPPORTED_V0'
  | 'ABI_SHAPE'
  | 'COMPILE_LIMIT'
  | 'EVM_VERSION'
  | 'INTERNAL';

export class EvsError extends Error {
  readonly code: EvsErrorCode;
  readonly loc: SourceLoc | null;
  readonly relatedLocs: readonly { label: string; loc: SourceLoc | null }[];
  constructor(
    code: EvsErrorCode,
    message: string,
    opts?: {
      loc?: SourceLoc | null;
      relatedLocs?: readonly { label: string; loc: SourceLoc | null }[];
    },
  );
}
export class EvsStagingError extends EvsError {}
export class EvsTypeError extends EvsError {}
export class EvsScopeError extends EvsError {}
export class EvsCompileError extends EvsError {}
export class EvsInternalError extends EvsError {} // message MUST contain "bug in evs, please report"

export interface EvsDiagnostic {
  severity: 'warning';
  code: 'LOOP_ALLOCATION' | 'LARGE_FRAME' | 'ENV_FRAME_DEPENDENT'; // ENV_FRAME_DEPENDENT amended §14.1
  message: string;
  loc: SourceLoc | null;
}
```

### `core/loc.ts`

```ts
export function captureLoc(): SourceLoc | null;
// Eagerly stores `new Error().stack`; parses lazily on first property access (implementation
// returns a lazily-resolving object; the SourceLoc fields are getters). Skips frames whose
// filename is inside @maxencerb/evs (dist or src). Returns null when unparseable.
export function setLocCapture(enabled: boolean): void; // used by evscript({locations:false}); scoped per recorder via builder
```

**Unit tests (M1)**: `isEvsType`/`bitsOf` exhaustive table over every v0 type string; rejection
of `uint7`, `bytes33`; the still-deferred string-array depths (`uint256[][]` as a script arg) and
raw `'tuple'` strings; `t.struct`/`t.tuple`/`t.array`, the guards, and `typesEqual`
structural-equality matrix (amended by #2); `namedArg()` validation matrix with loc assertions; error
class construction; loc capture under bun- and node-format stack traces.
**Type tests**: `ArgSpec` inference via `namedArg('pool', t.address)` is exactly
`ArgSpec<'pool','address'>`, and via `namedArg('marketParams', MarketParams)` exactly
`ArgSpec<'marketParams', typeof MarketParams>` (#25); `IntoExpr<'uint8'>` accepts `5`, `5n`,
`Expr<'uint8'>`, rejects `'0x'`/`Expr<'uint16'>`; `LitOf` of a `t.struct` is the named object
(amended by #2).

---

## M2. `ir/` — nodes + validation

Files: `src/ir/nodes.ts`, `src/ir/validate.ts`.
Imports allowed: `core/*`.

### `ir/nodes.ts`

```ts
export type ValueId = number;
export type CellId = number;
export type FnId = number;
export type SiteId = number;

export interface ScriptIr {
  readonly irVersion: 1;
  readonly name: string;
  readonly args: readonly { name: string; type: ArgType }[];
  readonly values: readonly ValueInfo[]; // indexed by ValueId
  readonly cells: readonly CellInfo[]; // indexed by CellId
  readonly fns: readonly FnIr[]; // indexed by FnId, topologically recorded
  readonly body: readonly Stmt[];
  readonly returns: readonly { name: string; type: EvsType; value: ValueId }[];
  readonly loc: SourceLoc | null;
}
export interface ValueInfo {
  readonly type: EvsType;
  readonly loc: SourceLoc | null;
  readonly debugName?: string;
}
export interface CellInfo {
  readonly type: EvsType;
  readonly loc: SourceLoc | null;
  readonly debugName?: string;
}
export interface FnIr {
  readonly name: string;
  readonly params: readonly { name: string; type: EvsType; value: ValueId }[];
  readonly results: readonly { type: EvsType }[];
  readonly body: readonly Stmt[];
  readonly resultValues: readonly ValueId[];
  readonly loc: SourceLoc | null;
}

export type BinOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'lt'
  | 'gt'
  | 'lte'
  | 'gte'
  | 'eq'
  | 'neq'
  | 'and'
  | 'or'
  | 'bitand'
  | 'bitor'
  | 'bitxor'
  | 'shl'
  | 'shr';
export type UnOp = 'not' | 'bitnot' | 'iszero';
export type EnvOp = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid';

export type ConstData =
  | { kind: 'word'; hex: Hex } // canonical 32-byte value
  | { kind: 'data'; hex: Hex }; // pre-encoded memref payload [len:32][payload…]

export interface PlainAbiParam {
  readonly name: string;
  readonly type: string;
  readonly components?: readonly PlainAbiParam[];
}
export interface PlainAbiFunction {
  readonly name: string;
  readonly selector: Hex;
  readonly inputs: readonly PlainAbiParam[];
  readonly outputs: readonly PlainAbiParam[];
}

export type Stmt = { readonly loc: SourceLoc | null; readonly site: SiteId } & (
  | { k: 'const'; out: ValueId; data: ConstData; type: EvsType }
  | { k: 'bin'; op: BinOp; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'un'; op: UnOp; a: ValueId; out: ValueId }
  | { k: 'env'; op: EnvOp; out: ValueId }
  | { k: 'convert'; a: ValueId; out: ValueId } // semantics from values[a].type → values[out].type
  | { k: 'select'; cond: ValueId; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'index'; arr: ValueId; i: ValueId; out: ValueId }
  | { k: 'len'; a: ValueId; out: ValueId }
  | { k: 'arrnew'; elem: EvsType; length: ValueId; out: ValueId } // amended by #2: elem widened to
  //   EvsType (validate still restricts to word — composite arrays deferred)
  | { k: 'arrset'; arr: ValueId; i: ValueId; value: ValueId }
  // composite (tuple/struct) nodes — added by #2. The out/tuple ValueId's `values[id].type`
  // carries the TupleType (with components); these nodes hold only the member index.
  | { k: 'tuplenew'; inits: readonly { index: number; value: ValueId }[]; out: ValueId }
  | { k: 'field'; tuple: ValueId; index: number; out: ValueId }
  | { k: 'tupleset'; tuple: ValueId; index: number; value: ValueId }
  // ABI encoding + hashing — added by #17. `encode` materializes the standard ('abi') or
  // packed encoding of its args into a fresh `bytes` memref; `keccak256` hashes a
  // bytes/string memref into a bytes32 word (KECCAK256(ptr+32, MLOAD(ptr))).
  | { k: 'encode'; mode: 'abi' | 'packed'; args: readonly ValueId[]; out: ValueId }
  | { k: 'keccak256'; a: ValueId; out: ValueId }
  | { k: 'cellnew'; cell: CellId; init: ValueId }
  | { k: 'cellget'; cell: CellId; out: ValueId }
  | { k: 'cellset'; cell: CellId; value: ValueId }
  | {
      k: 'call';
      target: ValueId;
      fnAbi: PlainAbiFunction;
      args: readonly ValueId[];
      outs: readonly ValueId[];
      mode: 'strict' | 'try';
      successOut?: ValueId;
      gas?: ValueId;
      kind?: 'static' | 'call' | 'simulate'; // amended by #1: opcode/frame (absent => 'static',
      //   STATICCALL; 'call' => CALL value-0; 'simulate' => CALL via the self-call trampoline).
      //   Absent leaves pre-issue-#1 serialized IR byte-unchanged; validate accepts the field.
    }
  | { k: 'fncall'; fn: FnId; args: readonly ValueId[]; outs: readonly ValueId[] }
  | { k: 'if'; cond: ValueId; then: readonly Stmt[]; else: readonly Stmt[] }
  | { k: 'while'; header: readonly Stmt[]; cond: ValueId; body: readonly Stmt[] }
  | { k: 'break' }
  | { k: 'continue' }
);

export function serializeIr(ir: ScriptIr): string; // stable JSON
export function deserializeIr(json: string): ScriptIr; // shape+version check, throws EvsTypeError
export function walkStmts(
  stmts: readonly Stmt[],
  visit: (s: Stmt, path: readonly number[]) => void,
): void;
```

### `ir/validate.ts`

```ts
export function validateIr(ir: ScriptIr): void;
// Throws EvsInternalError (for compiler-produced IR) on: operand type mismatch per op table,
// def-before-use under the scope rule (header dominates body; if/else branches isolated),
// unknown ids, cell type mismatches, break/continue outside while, call-graph cycles,
// empty/duplicate return names, fnAbi outputs/args outside v0 EvsType, successOut present iff
// mode==='try'. deserialize→validate is the trust boundary for external IR.
// Amended by #2: tuplenew/field/tupleset validated (out/tuple type is a TupleType; index in
// range; field out type = abiParamToType(components[index])); ALL value-type comparisons use the
// STRUCTURAL `typesEqual` (tuple descriptors are fresh objects, never ===); checkAbiParams
// recurses through tuple components; arrnew.elem still restricted to word (composite arrays deferred).
// Amended by #1: the `call` Stmt's optional `kind` ('static'|'call'|'simulate', absent => 'static')
// is accepted (the call-output decode/successOut rules are kind-independent).
// Amended by #17: `encode` validated (args nonempty; packed mode restricted to
// isPackedEncodable types; out is 'bytes') and `keccak256` (a is bytes|string; out 'bytes32').
```

**Unit tests (M2)**: accept/reject hand-built IRs per Stmt kind; every validation rule has a
seeded-failure test; JSON round-trip `deserializeIr(serializeIr(ir))` deep-equals for a corpus
covering every node kind.

---

## M3. `abi/` — layouts + literal ABI artifact

Files: `src/abi/layout.ts`, `src/abi/artifact.ts`.
Imports allowed: `core/*`, `ir/nodes.js` (PlainAbiParam types), `abitype` (types), `viem`
(runtime: `toFunctionSelector`, `encodeAbiParameters`, `encodeFunctionData`).

### `abi/layout.ts`

```ts
export type WordLayout = {
  kind: 'word';
  abi: WordType;
  bits: number;
  signed: boolean;
  leftAligned: boolean;
};
export type TypeLayout =
  | WordLayout
  | { kind: 'bytes'; abi: 'bytes' | 'string' }
  // amended by the #2 follow-up: `elem` widened WordLayout → TypeLayout — a one-level array of
  // composite/dynamic elements (tuple[], T[][], string[]/bytes[]) is an array of pointers:
  | { kind: 'array'; abi: string; elem: TypeLayout }
  // amended by #2: a tuple layout (a flat-pointer block of component layouts):
  | { kind: 'tuple'; abi: string; components: TypeLayout[]; dynamic: boolean };
export function layoutOf(abiType: string): TypeLayout; // narrowed to reject T[N]/tuple[][]/[][][]+
// amended by #2: layoutOfType handles TupleType OBJECTS (and nested string arrays), delegating to
// layoutOf for type strings; a tuple is `dynamic` iff any component layout isDynamic. The #2
// follow-up admits a one-level tuple[]/T[][]/string[] element here.
export function layoutOfType(t: EvsType): TypeLayout;
export function isDynamic(l: TypeLayout): boolean; // tuple → its `dynamic` flag; array → always true
export function headBytes(params: readonly PlainAbiParam[]): number; // walks the PlainAbiParam tree
// (a STATIC inner tuple counts headBytes(components), NOT 32; amended by #2). staticSize(elem) =
// headBytes(components) for a static tuple element, 32 for a word (the #2 follow-up).
```

### `abi/artifact.ts`

```ts
export const EVS_ERROR_ABI = [
  { type: 'error', name: 'EvsInvalidCalldata', inputs: [] },
  { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
] as const;

// amended by #9: `args` carries names again — `readonly ArgSpec[]` (was `readonly EvsType[]` per #2).
// Each input is labeled with its `namedArg` name, or the positional `arg{i}` fallback for a bare arg
// (the `''` sentinel resolves via `ResolveArgName`); inputs expand via TypeToComponent (a tuple arg →
// `{ name, type: 'tuple', components }`). ArgsToInputs stays HOMOMORPHIC over the arg-SPEC tuple (no
// UnionToTuple — order/labels structural; `args` stays a covariant type param). viem derives its
// `args` tuple labels from these input names.
export type ArgName<i> = i extends `${number}` ? `arg${i}` : string;
export type ResolveArgName<name extends string, i> = name extends '' ? ArgName<i> : name;
export type ArgsToInputs<args extends readonly ArgSpec[]> = {
  readonly [i in keyof args]: TypeToComponent<ResolveArgName<args[i]['name'], i>, args[i]['type']>;
};
export type ScriptAbi<
  name extends string,
  args extends readonly ArgSpec[], // amended by #9 (was readonly EvsType[] per #2)
  ret extends Record<string, ReturnValue>, // amended: a return value is an Expr OR a Tuple handle
> = readonly [
  {
    readonly type: 'function';
    readonly name: name;
    readonly stateMutability: 'view';
    readonly inputs: ArgsToInputs<args>;
    readonly outputs: readonly [
      {
        readonly name: 'result';
        readonly type: 'tuple';
        readonly components: ReturnSpecToComponents<ret>; // UnionToTuple-based; order-unstable but
      },
    ]; // SAFE (object inference) — abitype §4.2
  },
  (typeof EVS_ERROR_ABI)[0],
  (typeof EVS_ERROR_ABI)[1],
];

export function buildScriptAbi(
  name: string,
  args: readonly { name: string; type: EvsType }[], // amended by #9: NORMALIZED arg list (carries names)
  returns: readonly { name: string; type: EvsType }[],
): Abi;
// runtime mirror; inputs labeled by their resolved name (user `namedArg` name or the `arg{i}`
// fallback the recorder assigns to a bare arg — #9); names are identifier-checked + deduped;
// a tuple arg → typeToAbiParam; components order = returns insertion order

export function selectorOf(name: string, argTypes: readonly string[]): Hex; // viem toFunctionSelector
export function toPlainAbiFunction(item: AbiFunction): PlainAbiFunction; // + selector; validates v0 types
export function encodeLiteralWord(type: WordType, value: unknown): Hex; // canonical 32-byte word
export function encodeLiteralData(type: DynType | ArrayType, value: unknown): Hex; // [len][payload] memref bytes
// amended by the #2 follow-up: only flat memrefs (string/bytes, word arrays) get a data-segment
// blob. A composite-element array (tuple[]/T[][]/string[]/bytes[]) literal has NO flat blob — the
// recorder builds it structurally (arrnew + per-element tuplenew/arrset), so encodeLiteralData is
// NOT called for those types.
```

Invariants: `buildScriptAbi` output and the `ScriptAbi` type agree (type test with
`expectTypeOf` + `satisfies Abi`); `EvsDecodeError` selector is computed once via `selectorOf`.

**Unit tests (M3)**: `layoutOf` golden table over every v0 type + rejections; selectors vs
known constants (`symbol()` → `0x95d89b41`, `EvsDecodeError(uint256)`); literal encoders
differential vs viem `encodeAbiParameters`; `ScriptAbi` runtime↔type agreement.
**Type tests**: `ReadContractReturnType<ScriptAbi<…>, name>` is the expected object;
`ReadContractParameters<…>['args']` is the labeled positional tuple in declaration order; the
abitype §4.2 interning-regression scenario (a return key colliding with an earlier-interned
literal) still yields a correct object type.

---

## M4. `asm/` — assembler, verifier, disassembler, source map

Files: `src/asm/ops.ts`, `src/asm/assembler.ts`, `src/asm/verify.ts`, `src/asm/sourcemap.ts`,
`src/asm/disasm.ts`.
Imports allowed: `core/*`. (NOT ir, NOT abi.)

### `asm/ops.ts`

```ts
export type EvmVersion = 'paris' | 'shanghai' | 'cancun'
export type Mnemonic = 'STOP'|'ADD'|'MUL'|'SUB'|'DIV'|'SDIV'|'MOD'|'SMOD'|'ADDMOD'|'MULMOD'
  |'EXP'|'SIGNEXTEND'|'LT'|'GT'|'SLT'|'SGT'|'EQ'|'ISZERO'|'AND'|'OR'|'XOR'|'NOT'|'BYTE'
  |'SHL'|'SHR'|'SAR'|'KECCAK256'|'ADDRESS'|'CALLER'|'CALLVALUE'|'CALLDATALOAD'|'CALLDATASIZE'
  |'CALLDATACOPY'|'CODECOPY'|'RETURNDATASIZE'|'RETURNDATACOPY'|'TIMESTAMP'|'NUMBER'|'CHAINID'
  |'POP'|'MLOAD'|'MSTORE'|'MSTORE8'|'JUMP'|'JUMPI'|'PC'|'MSIZE'|'GAS'|'JUMPDEST'|'MCOPY'
  |'PUSH0'|`PUSH${1|2|/*…*/|32}`|`DUP${1|/*…*/|16}`|`SWAP${1|/*…*/|16}`
  |'STATICCALL'|'RETURN'|'REVERT'|'INVALID'
export interface OpInfo { readonly code: number; readonly pops: number; readonly pushes: number
  readonly since: EvmVersion | 'frontier' }
export const OPS: Readonly<Record<Mnemonic, OpInfo>>       // exactly evm-target §2
export const FORBIDDEN: ReadonlySet<number>                 // SSTORE, SLOAD?, LOG*, CREATE*, CALL,
// CALLCODE, DELEGATECALL, SELFDESTRUCT, TSTORE, TLOAD — bytes that must never appear as opcodes
// (SLOAD is allowed nowhere in v0 either; scripts never read own storage)
```

### `asm/assembler.ts`

```ts
export type LabelId = number
export type AsmNode =
  | { k: 'op';        op: Mnemonic; loc?: SourceLoc | null; note?: string }
  | { k: 'push';      value: bigint; loc?: SourceLoc | null; note?: string }   // minimal-width; 0→PUSH0 (paris: PUSH1 00)
  | { k: 'pushBytes'; bytes: Uint8Array; loc?: SourceLoc | null; note?: string } // exact-width PUSH<len>
  | { k: 'pushLabel'; label: LabelId; loc?: SourceLoc | null; note?: string }  // ALWAYS PUSH2 + fixup
  | { k: 'label';     label: LabelId; stack: number | 'any'; name?: string }   // emits JUMPDEST
  | { k: 'dataLabel'; label: LabelId; name?: string }                          // no JUMPDEST
  | { k: 'data';      bytes: Uint8Array; note?: string }

export class AsmWriter {
  newLabel(name?: string): LabelId
  op(op: Mnemonic, meta?: { loc?: SourceLoc | null; note?: string }): void
  push(value: bigint | number, meta?: …): void
  pushBytes(bytes: Uint8Array, meta?: …): void
  pushLabel(label: LabelId, meta?: …): void
  label(label: LabelId, stack: number | 'any', name?: string): void
  dataLabel(label: LabelId, name?: string): void
  data(bytes: Uint8Array, note?: string): void
  // the ONLY sanctioned RETURNDATACOPY emitters (shape invariant):
  returndatacopyAll(dst: 'zero' | { dupDepth: number }): void
  //  'zero'            → RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY      (bubble path)
  //  { dupDepth: n }   → RETURNDATASIZE PUSH0 DUP<n+2> RETURNDATACOPY   (snapshot path)
  nodes(): readonly AsmNode[]
}

export interface AssembleOptions {
  evmVersion: EvmVersion
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]      // default identity; runs before layout
  verify?: boolean                                          // default true
}
export interface AssembleResult {
  bytecode: Uint8Array
  sourceMap: SourceMap                                      // segments + labels only; sites merged by compile.ts
  labelPcs: ReadonlyMap<LabelId, number>
}
export function assemble(nodes: readonly AsmNode[], opts: AssembleOptions): AssembleResult
```

Invariants (assemble): `data`/`dataLabel` nodes are emitted after all code, preceded by exactly
one `INVALID` guard byte (assemble inserts it; codegen must still place them last in the node
stream — assertion otherwise); `pushLabel` is always 3 bytes (`PUSH2` + 2); patching is
big-endian; `push 0` lowers to `PUSH0` (shanghai+) or `PUSH1 00` (paris).

### `asm/verify.ts`

```ts
export function verifyJumpdests(
  bytecode: Uint8Array,
  jumpTargets: ReadonlySet<number>,
  dataStart: number,
): void; // consensus-identical PUSH-skipping scan
export function verifyStack(
  nodes: readonly AsmNode[],
  labelPcs: ReadonlyMap<LabelId, number>,
): void;
// Two label classes: `stack: n` (checked — all in-edges and fallthrough must agree; underflow
// and template depth > 16 are errors) and `stack: 'any'` (relative counter from 0, may go
// negative; region must terminate in REVERT/RETURN/INVALID or jump only to 'any' labels;
// falling through into a checked label is an error). main baseline 0; fn-entry labels carry 1.
export function verifyShapes(nodes: readonly AsmNode[], opts: { evmVersion: EvmVersion }): void;
// (a) every RETURNDATACOPY immediately preceded by [RETURNDATASIZE, PUSH0, (PUSH0|DUPn)];
// (b) no op with since > evmVersion; (c) no FORBIDDEN opcode.
```

All three run inside `assemble` when `verify: true`; failures throw `EvsInternalError`.

### `asm/sourcemap.ts`

```ts
export interface SourceMap {
  readonly version: 1;
  readonly segments: readonly { pc: number; len: number; loc: SourceLoc | null; note?: string }[];
  readonly sites: readonly {
    id: SiteId;
    kind: 'panic' | 'decode' | 'call' | 'stmt';
    loc: SourceLoc | null;
    detail: string;
  }[];
  readonly labels: readonly { pc: number; name: string }[];
}
export function lookupPc(
  map: SourceMap,
  pc: number,
): { loc: SourceLoc | null; note?: string } | undefined;
export function siteById(map: SourceMap, id: SiteId): SourceMap['sites'][number] | undefined;
```

### `asm/disasm.ts`

```ts
export interface DisasmLine {
  pc: number;
  raw: Hex;
  mnemonic: string;
  pushValue?: Hex;
  targetLabel?: string;
  label?: string;
  loc?: SourceLoc | null;
  note?: string;
}
export interface Disassembly {
  readonly lines: readonly DisasmLine[];
  format(opts?: { locs?: boolean }): string;
}
export function disassemble(bytecode: Hex | Uint8Array, sourceMap?: SourceMap): Disassembly;
// independent of the assembler (raw-bytes consumer); assemble→disassemble round-trips in
// property tests
```

**Unit tests (M4)**: OPS table spot-checked against evm-target §2 (codes, pops/pushes, since);
fixup-patching goldens; `verifyJumpdests` catches a `0x5B` planted inside PUSH data;
`verifyStack` catches seeded off-by-one templates and accepts the 'any'-tail corpus;
`verifyShapes` catches a hand-mangled RETURNDATACOPY and a MCOPY-on-paris; minimal-width PUSH
and paris PUSH0 lowering; data-segment placement + INVALID guard; disassemble round-trip
property test; the research fixtures (`RUNTIME_42`, `RUNTIME_WHOAMI` from viem-integration
App. A) hand-assembled here and executed on the M10 harness.

---

## M5. `builder/` — recording

Files: `src/builder/args.ts` (re-exports arg/t wiring), `src/builder/expr.ts`,
`src/builder/script.ts`.
Imports allowed: `core/*`, `ir/nodes.js`, `abi/*` (toPlainAbiFunction, encodeLiteral\*,
buildScriptAbi), `compile.js` (the `compile` function — for the `.compile()` sugar only),
`abitype` (types), `viem` (types only).

```ts
// builder/script.ts — amended by #2: `evscript` takes `args?: ArgsInput` and spreads positional
// arg handles after `s`; `ScriptBuilder` is non-generic (no `args` param, no `s.args`) and gains
// `s.tuple`; `Tuple`/`Field`/`s.tuple` are the new composite surface.
// amended by #9: `ArgsInput` admits `namedArg` declarators; `NormalizeArgs` → `readonly ArgSpec[]`;
// `ArgHandles` is labeled by the surfaced arg names (via a `LabelCarrier` type param — see §20.4).
export type ArgInput = EvsType | ArgSpec; // a bare type OR a namedArg
export type ArgsInput = ArgInput | readonly ArgInput[];
export type ToArgSpec<d> = d extends ArgSpec ? d : d extends EvsType ? ArgSpec<'', d> : never;
export type NormalizeArgs<a extends ArgsInput> = a extends readonly ArgInput[]
  ? { readonly [i in keyof a]: ToArgSpec<a[i]> }
  : readonly [ToArgSpec<a>]; // → readonly ArgSpec[]
// amended by #12 (bug fix): a `tuple[]`/`tuple[][]` arg is an Expr, matching the runtime
// `valueHandle` (only a PLAIN `tuple` arg is a Tuple handle) — the pre-#12 type wrongly
// mapped every TupleType to `Tuple<t>`. Amended by the #12 post-review pass: ArgHandle is THE
// single type-level mirror of the `valueHandle` dispatch (fn results, `Field.get`, and
// `TupleArrayElemHandle` all derive from it), and a NON-literal (constraint-widened) tuple tag
// yields the honest union `Tuple<t> | Expr<t>` (no single runtime answer exists for it).
export type ArgHandle<t extends EvsType> = t extends TupleType
  ? t['type'] extends 'tuple' ? Tuple<t>
  : 'tuple' extends t['type'] ? Tuple<t> | Expr<t> : Expr<t>
  : Expr<t>;
// LabelCarrier is module-private: a label-carrying tuple via abitype's public
// AbiParametersToPrimitiveTypes<…,'inputs',true>; ArgHandles maps over it (a type PARAMETER) to
// surface the names as the callback param labels while drawing element handles from `specs`.
export type ArgHandles<specs extends readonly ArgSpec[], L extends readonly unknown[] = /*LabelCarrier*/ readonly unknown[]> = {
  readonly [i in keyof L]: i extends keyof specs ? ArgHandle<Extract<specs[i]['type'], EvsType>> : never;
};
export function evscript<
  const name extends string,
  const args extends ArgsInput = readonly [],
  ret extends Record<string, ReturnValue> = Record<string, ReturnValue>, // amended: Expr | Tuple
>(
  def: { name: name; args?: args },
  body: (s: ScriptBuilder, ...args: ArgHandles<NormalizeArgs<args>>) => ScriptReturn<ret>,
  opts?: { locations?: boolean },
): EvsScript<name, NormalizeArgs<args>, ret>;

export interface EvsScript<name, args extends readonly ArgSpec[], ret> {
  /* exactly api.md §1 — `args` param is `readonly ArgSpec[]` (amended by #9, was readonly EvsType[]/#2) */
}
export interface ScriptBuilder {
  /* exactly api.md §4 — non-generic; no `args`/`s.args`; gained `s.tuple` (amended by #2). The call
     surface is SPLIT BY MUTABILITY (amended by #1 — see §19): three verb pairs, all sharing one
     `SubcallParams<abi, name, mut>` (now generic over the mutability bucket) and the same three
     struct-aware overloads (`struct: true` → one named Tuple; `struct?: false` → the positional
     default; non-literal boolean → the union) + a `try*` variant returning `{ success, value }`:
       - read / tryRead   — ViewMutability  = 'pure' | 'view'        → STATICCALL (BREAKING RENAME of
                            the frozen s.call/s.tryCall — IDENTICAL codegen/decode/bubble/try-zeroing)
       - call / tryCall   — WriteMutability = 'nonpayable' | 'payable' → CALL (value 0); same decode/
                            bubble path as read, no rollback (writes persist to LATER subcalls within
                            the same uncommitted eth_call)
       - simulate / trySimulate — WriteMutability                    → CALL via the self-call revert
                            trampoline (the write is rolled back + isolated, the return value is read
                            back). Mutability is filtered at the `functionName` TYPE level per verb
                            (a wrong bucket is a compile error steered to the right verb; the recorder
                            mirrors it with EvsTypeError(ABI_SHAPE)).
     Amended by #12 (loops): `s.for`'s `range.type` is OPTIONAL, defaulting the counter to
     uint256 (a type-less overload + the original generic overload), and the surface gains
     `s.forEach(array, (elem, i, loop) => …)` — the counter loop over an array value with
     `until` = the array's length (snapshot once) and `elem` = the bounds-checked `array.at(i)`
     (a Tuple handle for a `tuple[]` element, an Expr otherwise; two overloads mirroring the
     `.at` tuple-array augmentation). Records existing IR only (`len`/`while`/`index` — no new
     Stmt kinds); the element load is recorded only when the body declares `elem` (#12
     post-review — v0 has no DCE); see api.md §4/§7. */
}
export interface Cell<t extends EvsType> {
  /* api.md §5 */
}
export interface MutArray<e extends EvsType> {
  /* api.md §5 — amended by the #2 follow-up: `e` widened WordType → EvsType (composite-element
     arrays of pointers); `get`/`at` on a tuple[] return a Tuple element handle, `set` takes
     IntoMember<e>, `expr()` types as the array type. `s.newArray` admits word|string|bytes|
     one-level T[]|tuple; T[N]/tuple[][]/deeper still UNSUPPORTED_V0. amended by #5 ask #5: gains a
     phantom `readonly [mutArrayBrand]: MutArrayValueOf<e>` so a bare handle is a `ReturnValue` /
     array-slot value (`s.return({ arr })`, no `.expr()`). */
}
export interface LoopCtl {
  break(): void;
  continue(): void;
}
// tuple / struct handles — added by #2 (api.md §5). Field.get amended by the #12 post-review
// pass: a `tuple[]` member's `.get()` is an Expr (the ArgHandle/`valueHandle` dispatch) — the
// pre-fix `t extends TupleType ? Tuple<t> : Expr<t>` wrongly handed a `tuple[]` member out as a
// named-field Tuple (a field access compiled, then died in a raw TypeError at record time).
export interface Field<t extends EvsType> {
  readonly type: t;
  get(): ArgHandle<t>;
  set(value: IntoMember<t>): void;
}
export declare const tupleBrand: unique symbol; // phantom (amended): marks a Tuple in a return bound
export type Tuple<C extends TupleType> = {
  readonly [c in C['components'][number] as c['name'] extends '' ? never : c['name']]:
    Field</* ComponentToType<c> */>;
} & { at(i: number): Field</* element type */>; expr(): Expr<C> } & {
  readonly [tupleBrand]: TupleType; // erased (order-insensitive) so Tuple↔Tuple assignability holds
};
// added by the #12 post-review pass (amendments §25): the tuple-ARRAY element handle named by the
// public `Expr.at` augmentation and `s.forEach` tuple overload — the one-`[]`-peeled element
// descriptor run through the ArgHandle dispatch (`tuple[]` → Tuple element; `tuple[][]` →
// Expr<tuple[]> row; a non-array `tuple` → never). Exported (it appears in public signatures).
export type TupleArrayElemHandle<C extends TupleType> = /* ArgHandle<one-[]-peeled C> */;
// amended by #5 ask #3: a composite INPUT slot also accepts ANY Tuple handle (the erased brand
// makes a call-decoded `Tuple<C_abi>` assignable into a `t.struct`-typed slot whose `C` is
// `UnionToTuple`-ordered; runtime `typesEqual` is the order-sensitive guard). Array slots also take
// a bare `MutArray` (`IntoArray`, #5 ask #5).
export type IntoTuple<t extends TupleType> = Tuple<t> | AnyTuple | LitOf<t>;
export type IntoArray<t extends EvsType> = IntoExpr<t> | AnyMutArray;
export type IntoMember<t extends EvsType> = t extends TupleType
  ? t['type'] extends 'tuple' ? IntoTuple<t> : IntoArray<t>
  : t extends ArrayType ? IntoArray<t> : IntoExpr<t>;
export type TupleInit<C extends TupleType> = /* named object | positional record, all members optional */;
// (s.tuple is a method on ScriptBuilder: `tuple<const c extends TupleType>(type: c, init?:
//  TupleInit<c>): Tuple<c>`.)
// amended by #2: a return value is an Expr OR a Tuple handle returned directly. amended by #5 ask
// #5: a bare `MutArray` handle is ALSO a return value (`AnyMutArray`, an erased brand symmetric
// with `tupleBrand`; `MutArray<e>` gains `readonly [mutArrayBrand]: MutArrayValueOf<e>`).
// `TypeOfReturn` recovers an Expr's `t`, or a Tuple/MutArray's value type `c` from its `expr()`.
export declare const mutArrayBrand: unique symbol; // phantom; marks a MutArray in a return/array bound
export type AnyTuple = { readonly [tupleBrand]: TupleType };
export type AnyMutArray = { readonly [mutArrayBrand]: EvsType };
export type ReturnValue = Expr | AnyTuple | AnyMutArray;
export type TypeOfReturn<v> = v extends Expr<infer t>
  ? t
  : v extends { expr(): Expr<infer c extends EvsType> }
    ? c
    : never;
export declare const returnBrand: unique symbol;
export interface ScriptReturn<ret extends Record<string, ReturnValue>> {
  readonly [returnBrand]: ret;
}
// ABI encoding + hashing (added by #17, keccak256 amended by #24 — api.md §4.1):
// `ScriptBuilder` gains
//   encode(...values: [EncodeValue, ...EncodeValue[]]): Expr<'bytes'>        // abi.encode
//   encodePacked(...values: [PackedValue, ...PackedValue[]]): Expr<'bytes'>  // abi.encodePacked
//   keccak256(...values: [EncodeValue, ...EncodeValue[]]): Expr<'bytes32'>   // standard-encode-then-hash (#24)
// with EncodeValue = Expr | AnyTuple | AnyMutArray and PackedValue = Expr | AnyMutArray (both
// exported — index.ts §M9). Handles only (literals via s.lit); ≥1 value; packed mode enforces
// core's isPackedEncodable at record time. s.keccak256 hashes a single bytes/string value
// directly (no encode stmt); otherwise records encode(abi) then keccak256 (#24 — the packed
// hash is the explicit composition s.keccak256(s.encodePacked(…))).
export type EncodeValue = Expr | AnyTuple | AnyMutArray;
export type PackedValue = Expr | AnyMutArray;
// call-surface mutability buckets (added by #1 — see §19): `SubcallParams` is generic over `mut`,
// each verb pair fixes it. `read`/`tryRead` use ViewMutability; `call`/`tryCall` + `simulate`/
// `trySimulate` use WriteMutability. Both are exported (index.ts §M9):
export type ViewMutability = 'pure' | 'view';
export type WriteMutability = 'nonpayable' | 'payable';
```

Implementation invariants (binding):

1. **Handle internals in a module-private WeakMap** keyed by the handle object:
   `{ owner: Recorder; id: ValueId }`. Lookup miss or owner mismatch →
   `EvsScopeError(FOREIGN_HANDLE)` naming both scripts (by `name` + loc).
2. **Staging traps**: `valueOf`, `Symbol.toPrimitive`, `toString`, `toJSON` throw
   `EvsStagingError`; `Symbol.for('nodejs.util.inspect.custom')` returns
   `` `Expr<${type}> #${id} ← ${debugName} at ${loc}` `` (never throws).
3. **Scope stack**: main → (if-then | if-else | while-header → while-body | fn-body). A value
   is usable iff its defining scope is on the current stack. `while` body scope is pushed as a
   **child of the header scope**. `s.fn` bodies push an isolated stack (params only).
4. **MutArray**: `set/get/length/expr` record `arrset`/`index`/`len` stmts against the arrnew
   value; `expr()` returns a plain `Expr` handle aliasing the same ValueId. Amended by the #2
   follow-up: `s.newArray` admits composite elements (`word|string|bytes|one-level T[]|tuple`);
   `get`/`at` on a `tuple[]` return a `Tuple` element handle (same `TUPLE_INTERNALS` as a decoded
   tuple), `arrset` stores the element pointer. A composite-array LITERAL (a JS array for
   `tuple[]`/`uint256[][]`/`string[]`/`bytes[]`) is BUILT at record time as `arrnew` + per-element
   (`tuplenew`/`arrset`) — a fresh `[len][p0…]` block with reference semantics, NOT an
   `encodeLiteralData` data-segment blob (composite arrays have no flat literal — the elements are
   pointers).
5. **Recording-time validation checklist** (each throws with loc + relatedLocs):
   duplicate/empty/invalid arg names · literal out of range / wrong hex length / unsafe number ·
   operand type mismatch (message suggests `toUint`/`toInt`) · all-literal certain-panic fold
   (`CERTAIN_PANIC`, escape hatch in message) · `abi` lacks `functionName` / not view-pure ·
   overloaded name · args arity/type mismatch · v0-unsupported ABI type (names the parameter) ·
   foreign handle / closed scope / use-after-seal · `s.return` missing, duplicated, or inside a
   block · empty-string return keys · `LoopCtl` outside its loop · `s.fn` outer capture ·
   `s.fn` calling itself (unconstructible, but a defensive check with a clear message exists).
6. **Constant folding**: all-literal `bin`/`un`/`convert`/`select(cond literal)` fold to
   `const` stmts; certain-panic folds throw (rule 5).
7. After `s.return`, the recorder seals; `script.ir` is deep-frozen.
8. **Args + tuples (added by #2)**: the Recorder ctor still takes
   `args: readonly { name; type: EvsType }[]` (auto-named `arg0`, `arg1`, …) and exposes
   `argHandles(): readonly (Expr | Tuple)[]` — a positional handle list (a tuple-typed arg → a
   `Tuple` handle), which `evscript` spreads into the body after `s` (the old `argRecord()`/`s.args`
   getter is removed). `Tuple` handles install staging traps like `Expr`; `Field` handles are
   module-private (WeakMap). The Recorder records `tuplenew` (s.tuple / literal-object coercion),
   `field` (Field.get), `tupleset` (Field.set), and tuple decode for tuple call outputs.
   `coerceToId` gains a tuple branch: a `Tuple` handle of this recorder reuses its ValueId
   (reference); a plain object builds a `tuplenew` (members coerced per component, omitted → 0).

**Unit tests (M5)**: IR snapshot (`serializeIr`) per builder API; every checklist item has a
test asserting error class, message substring, and loc; staging traps (`x+1`, template
literal, `JSON.stringify`); cross-script and cross-scope handles; loop scoping (header value
visible in body, body value invisible after); fold tests incl. certain-panic; `s.tuple`/field
get-set/tuple-output decode (amended by #2).
**Type tests** (`builder.test-d.ts`): args-as-positional-callback-params inference; `t.struct`
field-handle typing (`slot0.tick.get(): Expr<'int24'>`); a tuple call output → a `Tuple` handle;
`s.read` single-output unwrap / tuple / void (amended by #1 — was `s.call`); the mutability filter
(`@ts-expect-error` a nonpayable functionName under `s.read`, a view functionName under `s.call`/
`s.simulate`); `@ts-expect-error` on wrong literal types, `eq` on memref; graceful widening with a
non-const ABI; `ScriptReturn` inference through `evscript` (amended by #2 — `s.args` record test is
gone).

---

## M6. `ir/interp.ts` — reference interpreter (test oracle)

Imports allowed: `core/*`, `ir/*`, `abi/*`, `viem` (encode/decode for ABI byte-accuracy).

```ts
export interface MockChain {
  staticcall(req: { to: Hex; data: Hex }): { success: boolean; data: Hex };
  // amended by #1: an OPTIONAL non-static frame (s.call / s.simulate targets). Defaults to
  // `staticcall` when absent. `req.kind` ('call' | 'simulate') is INFORMATIONAL ONLY — the stateless
  // oracle decodes call/simulate returndata IDENTICALLY to a read (returndata is a pure function of
  // to+data+state; the simulate rollback is invisible here — no persisted state to model), so a
  // stateless mock MUST return the same data for either kind. `kind` exists for routing assertions
  // and user-built stateful mocks; the rollback/write-persistence semantics are pinned in the anvil
  // integration tier, not here.
  call?(req: { to: Hex; data: Hex; kind: 'call' | 'simulate' }): { success: boolean; data: Hex };
}
export interface InterpResult {
  outcome:
    | { kind: 'return'; data: Hex; values: Record<string, unknown> } // data = ABI-encoded returndata
    | { kind: 'revert'; data: Hex }; // byte-exact revert payload
  trace?: readonly { stmtPath: readonly number[]; loc: SourceLoc | null; note: string }[];
}
export function interpret(
  ir: ScriptIr,
  args: readonly unknown[],
  chain: MockChain,
  opts?: { trace?: boolean; maxSteps?: number; env?: InterpEnvOverrides }, // env amended §14.2
): InterpResult;
```

Binding invariant: **bit-for-bit agreement with the compiled bytecode** on both returndata and
revert payloads (incl. Panic codes, EvsDecodeError site ids, bubbled callee reverts, tryCall
zeroing, normalization rules of §7/§8 of architecture.md). The interpreter implements the same
checked-arithmetic spec table (architecture §6) — its source of truth is that table, not the
codegen. On divergence in differential tests, `evm-target.md` + architecture §6 adjudicate.

**Unit tests (M6)**: golden runs over hand-built IRs covering every stmt kind; revert paths
(panic codes per width incl. `int256 min / −1`, MUL wrap-back for uint192); decode-fail site
ids; tryCall zeroing; call-kind routing (`kind:'call'`/`'simulate'` → the mutable `call` oracle,
with `staticcall` fallback when `call` is absent; strict-bubble + try-zero on the mutable path);
maxSteps guard.

---

## M7. `codegen/abi.ts` + `codegen/call.ts` — ABI + call emitters

Imports allowed: `core/*`, `ir/nodes.js`, `abi/*`, `asm/*`.

```ts
// codegen/abi.ts
export interface SharedTails {
  panicOverflow: LabelId;
  panicDivZero: LabelId;
  panicBounds: LabelId;
  panicAlloc: LabelId;
  invalidCalldata: LabelId;
  decodeRevert: LabelId;
  memcpy: LabelId | null; // null on cancun (MCOPY inline)
}
export interface SlotRef {
  slot: number;
  type: EvsType;
} // absolute memory offset

export function emitCalldataDecode(
  w: AsmWriter,
  args: readonly SlotRef[],
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
): void;
// architecture §8.1: size guard, word normalize, dynamic bounds checks → invalidCalldata,
// CALLDATACOPY into memrefs, eager element normalization.

export function emitReturnEncode(
  w: AsmWriter,
  components: readonly { name: string; ref: SlotRef }[],
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
): void;
// architecture §8.2; ends with RETURN.

export function emitMemCopy(
  w: AsmWriter,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
): void;
// emits MCOPY (cancun) or call to tails.memcpy; stack contract: [dst, src, len] → []

// added by #17 (architecture §8.4): materialize abi.encode / abi.encodePacked of the items
// into a fresh [len][payload] bytes memref; net stack +1 (the pointer). `pushSrc` thunks must
// be stack-depth-independent. The abi variant reuses emitEncodeBlock (heads at ptr+32, tails
// at the scratch cursor, composite-array frames reserved below the block); the packed variant
// is a linear segment walk (SHL-left-aligned word stores, raw-payload/array-body copies, one
// trailing zero-pad word).
export interface EncodeSrcItem {
  param: NamedType;
  pushSrc: () => void;
}
export interface EncodeMeta {
  loc?: SourceLoc | null;
  note?: string;
}
export function emitAbiEncodeToBytes(
  w: AsmWriter,
  items: readonly EncodeSrcItem[],
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  meta?: EncodeMeta,
): void;
export function emitPackedEncodeToBytes(
  w: AsmWriter,
  items: readonly { layout: TypeLayout; pushSrc: () => void }[],
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  meta?: EncodeMeta,
): void;

// codegen/call.ts
export interface CallSitePlan {
  stmt: Extract<Stmt, { k: 'call' }>;
  argRefs: readonly (SlotRef | { literal: ConstData })[];
  outRefs: readonly SlotRef[];
  successRef: SlotRef | null;
  dfailLabel: LabelId; // per-site stub target (strict) or zero-block (try)
  siteId: SiteId;
}
export function emitStaticCall(
  w: AsmWriter,
  plan: CallSitePlan,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  dataSeg: (bytes: Uint8Array) => LabelId, // request a data segment, get its dataLabel
): void;
// architecture §7 exactly: CalldataTemplate (const-merged literals; >96-byte const → dataSeg +
// CODECOPY), STATICCALL retSize 0, bubble (strict), staticMinSize guard BEFORE head reads,
// snapshot via w.returndatacopyAll, word normalize, dynamic in-place validate, try zeroing.
```

Invariants: all RETURNDATACOPYs go through `w.returndatacopyAll`; every emitted sequence is
net-zero on the stack (statement boundary invariant); labels created here are annotated with
exact heights except `@dfail_*`/zero blocks (`'any'` for stubs feeding decodeRevert; zero
blocks are checked labels — they rejoin the program).

**Unit tests (M7)**: per-pattern — build a tiny node stream around each emitter, assemble, run
on the M10 harness: calldata decode matrix (word/dirty-word normalize/each dynamic kind/
truncated and attacker-shaped calldata → `EvsInvalidCalldata`); return encode differential vs
viem `encodeAbiParameters` (static / dynamic / mixed, fuzzed values, byte equality); call
pattern vs mock callee bytecode (success, revert-bubble byte-exact, short returndata, huge
offset/len, off-by-one → `EvsDecodeError(site)`, tryCall defaults); pre-cancun memcpy path.

---

## M8. `codegen/frame.ts` + `codegen/lower.ts` + `codegen/program.ts` — frame, statements, program

Imports allowed: `core/*`, `ir/*` (nodes+validate), `abi/*`, `asm/*`, `codegen/abi.js`,
`codegen/call.js`.

```ts
// codegen/frame.ts
export interface FrameLayout {
  slotOfValue(v: ValueId): number | null; // null = folded const (operand becomes push)
  slotOfCell(c: CellId): number;
  fnRegion(f: FnId): { params: readonly number[]; results: readonly number[] };
  frameEnd: number; // 0x80 + 32 × slotCount, ceil to 32
}
export function layoutFrames(ir: ScriptIr): FrameLayout;

// codegen/lower.ts
export interface LowerCtx {
  ir: ScriptIr;
  frame: FrameLayout;
  tails: SharedTails;
  opts: { evmVersion: EvmVersion };
  loop: { breakTo: LabelId; continueTo: LabelId } | null;
  fnBaseline: 0 | 1; // stack baseline (1 inside fn bodies)
  dataSeg: (bytes: Uint8Array) => LabelId;
  siteOf(stmt: Stmt): SiteId;
}
export function lowerStmts(w: AsmWriter, stmts: readonly Stmt[], ctx: LowerCtx): void;
// every statement template implements architecture §6 (checked-op table — NORMATIVE),
// §5 (canonical word invariant), §3 (control-flow shapes), §9 (fncall convention).

// codegen/program.ts — the single entry point compile.ts consumes (the optimizer seam)
export interface LowerResult {
  nodes: readonly AsmNode[];
  frameEnd: number;
  sites: SourceMap['sites'];
  labelNames: ReadonlyMap<LabelId, string>;
  diagnostics: readonly EvsDiagnostic[]; // LOOP_ALLOCATION etc. — compile.ts forwards
}
export function lowerProgram(
  ir: ScriptIr,
  opts: { evmVersion: EvmVersion; locations: boolean },
): LowerResult;
// validates IR, lays frames, emits: prologue, dispatcher (incl. EvsInvalidCalldata tail),
// arg decode, body, return encode, fn subroutines (uncalled fns dropped), memcpy (if needed),
// panic tails, dfail stubs + decodeRevert tail, tryCall zero blocks, data segments LAST.
```

**Unit tests (M8)**: for each stmt kind, lower a one-stmt IR → assemble → run on M10 harness →
assert returndata AND disassembly golden AND sourceMap segments; checked-op boundary matrix —
for every width class: `{0, 1, max−1, max, min}` operands ×
{add,sub,mul,div,mod} including **uint192 mul wrap-past-2^256** (`2^191 × (2^65+1)`) and
**int256 `−2^255 / −1`** and `intN minN / −1` → exact Panic payloads; loops with break/continue;
fncall ×2 no-aliasing; select; arrnew zero-fill on dirtied scratch; env ops; dispatcher
goldens; frame layout determinism.

---

## M9. `compile.ts` + `viem.ts` + `index.ts`

Imports allowed: `core/*`, `ir/*`, `abi/*`, `asm/*`, `codegen/program.js`, `viem` (types +
`StateOverride` type), `abitype` (types).

```ts
// compile.ts
export interface CompileOptions {
  /* exactly api.md §10 */
}
export interface CompiledEvsScript<name, args extends readonly ArgSpec[], ret> {
  /* exactly api.md §10 — `args` param is `readonly ArgSpec[]` (amended by #9, was readonly EvsType[]/#2) */
}
export interface RevertExplanation {
  kind: 'panic' | 'evs-decode' | 'evs-invalid-calldata' | 'error-string' | 'custom' | 'empty';
  message: string;
  panicCode?: bigint;
  site?: { id: SiteId; loc: SourceLoc | null; detail: string };
  candidateSites?: readonly { id: SiteId; loc: SourceLoc | null; detail: string }[]; // Panic only
  raw: Hex;
}
export function compile<s extends EvsScript>(script: s, options?: CompileOptions): CompiledOf<s>;
export type CompiledOf<s> =
  s extends EvsScript<infer n, infer a, infer r> ? CompiledEvsScript<n, a, r> : never;
// pipeline: validateIr → lowerProgram → peephole (user hook) → assemble(verify) →
// EIP-170 check (per-region breakdown via labelNames) → merge sites into sourceMap →
// build artifact. Diagnostics forwarded to onDiagnostic; nothing logged.

// viem.ts
export const INIT_CODE_PREFIX_SHANGHAI: Hex; // computed: 0x61 RRRR 80 600A 5F 39 5F F3 builder
export function toCreationBytecode(runtime: Hex, evmVersion: EvmVersion): Hex;
export const DEFAULT_SCRIPT_ADDRESS: Address; // 0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530
export function toViemDeployless<const abi extends Abi>(s: {
  abi: abi;
  initBytecode: Hex;
}): { abi: abi; code: Hex };
export function toViemStateOverride<const abi extends Abi>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts?: { address?: Address },
): { abi: abi; address: Address; stateOverride: StateOverride };

// index.ts — the complete public surface (nothing else is exported from the package; single
// entry point, no subpath exports in v0):
// evscript, compile, namedArg (#9: renamed from arg), t, interpret, disassemble, lookupPc, serializeIr, deserializeIr,
// EVS_ERROR_ABI, DEFAULT_SCRIPT_ADDRESS, EvsError + subclasses, and all public types
// (Expr, IntoExpr, EvsType…, ArgSpec, ScriptBuilder, Cell, MutArray, LoopCtl, ScriptReturn,
// EvsScript, CompiledEvsScript, CompileOptions, EvsDiagnostic, ScriptAbi, SourceMap,
// Disassembly, RevertExplanation, MockChain, InterpResult).
// Added by #2 (composite types) — type-only additions to the public surface:
//   TupleType, NamedType, ScalarType, StringType, Tuple, Field, ArgsInput, NormalizeArgs,
//   ArgHandle, ArgHandles, ComponentToType, TupleInit, and the `t`-namespace helper types
//   StructTypeOf / TupleTypeOf / TupleArrayOf / TypeToComponent / TupleLitOf / TupleAsParam.
//   `ArgSpec` remains exported; the declarator is `namedArg` (#9: renamed from `arg`; `ArgInput`
//   is also exported). `ScriptBuilder` is non-generic.
// Added by #1 (calls split by mutability — see §19) — type-only additions to the public surface:
//   ViewMutability, WriteMutability, and the per-verb param/output/struct types
//   (SubcallParams now generic over the mutability bucket). `ScriptBuilder` gains the read/tryRead,
//   call/tryCall, simulate/trySimulate verb pairs (the frozen s.call/s.tryCall are RENAMED to
//   s.read/s.tryRead — BREAKING).
// Added by #17 (keccak256 + ABI encoding ops) — type-only additions to the public surface:
//   EncodeValue, PackedValue. `ScriptBuilder` gains encode/encodePacked/keccak256 (§M5).
// Added by the #12 post-review pass (amendments §25) — type-only addition to the public surface:
//   TupleArrayElemHandle (named by the public `Expr.at` / `s.forEach` signatures).
```

**Unit tests (M9)**: artifact shape; EIP-170 rejection on a synthetic huge script with region
breakdown asserted; init wrapper bytes golden for cancun and paris; `explainRevert` over each
revert kind (incl. candidateSites for Panic); end-to-end `evscript → compile → harness` smoke;
**differential suite**: for every `examples/` script, `interpret(ir, …)` vs harness execution
of the compiled runtime byte-agree on returndata/revert.
**Type tests**: `toViem()` shapes spread into `ReadContractParameters` (both modes); generated
ABI flows through `readContract` inference for the flagship.

---

## M10. `test/harness/` — execution harnesses (shared test infra, not published)

Files: `packages/evs/test/harness/evm.ts`, `packages/evs/test/harness/anvil.ts`,
`packages/evs/test/global-setup.ts`.

```ts
// evm.ts — @ethereumjs/evm in-process (unit tier)
export interface EvmFixture {
  contracts?: Record<Address, Hex>;
  gasLimit?: bigint;
} // default 30M
export async function execRuntime(
  runtime: Hex,
  calldata: Hex,
  fixture?: EvmFixture,
): Promise<{ success: boolean; data: Hex; gasUsed: bigint }>;
// plants runtime at a fixed SCRIPT address + fixture mocks, evm.runCall. Exact @ethereumjs/evm
// v10 API names resolved at implementation against the pinned version; THIS signature is frozen.

// anvil.ts — prool client helpers (integration tier)
export const poolId: number; // Number(process.env.VITEST_POOL_ID ?? 1)
export const rpcUrl: string; // http://127.0.0.1:8545/<poolId>
export const publicClient: PublicClient;
export const testClient: TestClient; // mode 'anvil' (setCode etc.)

// global-setup.ts — vitest globalSetup: prool Server with Instance.anvil
// ({ chainId: 31337, hardfork: 'Prague', gasLimit: 100_000_000 }), port 8545; returns teardown.
```

**Tests of the harness itself**: runs `RUNTIME_42` fixture; mock STATICCALL target; gas limit
respected.

---

## Work plan (1:1 with the units above; 5–6 agents)

| Unit               | Path                                                | Depends on                        | Agent-day estimate |
| ------------------ | --------------------------------------------------- | --------------------------------- | ------------------ |
| U1 core            | `packages/evs/src/core/`                            | —                                 | 1                  |
| U2 ir              | `packages/evs/src/ir/` (nodes, validate)            | U1                                | 1.5                |
| U3 abi             | `packages/evs/src/abi/`                             | U1 (types of U2 via frozen stubs) | 1.5                |
| U4 asm             | `packages/evs/src/asm/`                             | U1                                | 3                  |
| U5 evm-harness     | `packages/evs/test/harness/`                        | U1                                | 1                  |
| U6 builder         | `packages/evs/src/builder/`                         | U1–U3 (+ M9 type stub)            | 3.5                |
| U7 interp          | `packages/evs/src/ir/interp.ts`                     | U1–U3                             | 2.5                |
| U8 codegen-abi     | `packages/evs/src/codegen/{abi,call}.ts`            | U2–U4, U5                         | 3.5                |
| U9 codegen-program | `packages/evs/src/codegen/{frame,lower,program}.ts` | U2–U4, U8                         | 3.5                |
| U10 compile+viem   | `packages/evs/src/{compile,viem,index}.ts`          | U8, U9                            | 2                  |
| U11 contracts      | `packages/contracts/`                               | —                                 | 1                  |
| U12 integration    | `packages/evs/test/integration/` + examples         | U5, U6, U7, U10, U11              | 2.5                |
| U13 repo-infra     | root configs + `.github/workflows/`                 | —                                 | 0.5                |

Day-0 commit: U1 plus **type-only stubs** (`export declare`) for every exported signature in
M2–M9 so all agents code against real imports. Suggested 6-agent split: A=(U1,U13,U3),
B=(U2,U7), C=(U4,U5), D=(U6), E=(U8), F=(U9 then U10), with U11/U12 picked up by C and B as
they free up. The critical path is U1 → U4 → U8 → U9 → U10 → U12.
