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
export type ArrayType = `${WordType}[]`
export type EvsType = WordType | DynType | ArrayType
export type ArgType = EvsType
export type NumericType = UintType | IntType
export type BitsType = UintType | BytesNType

export declare const exprBrand: unique symbol
export interface Expr<t extends EvsType = EvsType> { /* exactly api.md §3 */ }
export type LitOf<t extends EvsType> = /* exactly api.md §3 */
export type IntoExpr<t extends EvsType> = Expr<t> | LitOf<t>

export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name
  readonly type: type
}
export function arg<const name extends string, const type extends ArgType>(
  name: name, type: type): ArgSpec<name, type>
export const t: { /* exactly api.md §2 — every WordType key + string + bytes + array() */ }

// runtime type predicates / metadata (single source of truth for all modules)
export function isEvsType(s: string): s is EvsType
export function isWordType(s: string): s is WordType
export function isNumeric(s: EvsType): s is NumericType
export function isSigned(s: EvsType): boolean              // intN → true
export function bitsOf(s: WordType): number                // address→160, bool→8(canonical 0/1), bytesN→8N, u/intN→N
export function isDynamicType(s: EvsType): boolean         // string|bytes|T[]
export function elemTypeOf(s: ArrayType): WordType
```

Invariants: `arg()` validates name (`/^[A-Za-z_]\w*$/`) and type (via `isEvsType`), throws
`EvsTypeError` with `captureLoc()`, returns frozen object. `t` is frozen.

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
  code: 'LOOP_ALLOCATION' | 'LARGE_FRAME';
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
of `uint7`, `bytes33`, `uint256[][]`, `tuple`; `arg()` validation matrix with loc assertions;
error class construction; loc capture under bun- and node-format stack traces.
**Type tests**: `ArgSpec` inference via `arg('pool', t.address)` is exactly
`ArgSpec<'pool','address'>`; `IntoExpr<'uint8'>` accepts `5`, `5n`, `Expr<'uint8'>`, rejects
`'0x'`/`Expr<'uint16'>`.

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
  | { k: 'arrnew'; elem: WordType; length: ValueId; out: ValueId }
  | { k: 'arrset'; arr: ValueId; i: ValueId; value: ValueId }
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
  | { kind: 'array'; abi: string; elem: WordLayout }; // dynamic arrays of words only in v0
export function layoutOf(abiType: string): TypeLayout; // throws EvsTypeError(UNSUPPORTED_V0) on tuple/T[N]/nested
export function isDynamic(l: TypeLayout): boolean;
export function headBytes(params: readonly PlainAbiParam[]): number; // 32 × params.length in v0
```

### `abi/artifact.ts`

```ts
export const EVS_ERROR_ABI = [
  { type: 'error', name: 'EvsInvalidCalldata', inputs: [] },
  { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
] as const;

export type ScriptAbi<
  name extends string,
  args extends readonly ArgSpec[],
  ret extends Record<string, Expr>,
> = readonly [
  {
    readonly type: 'function';
    readonly name: name;
    readonly stateMutability: 'view';
    readonly inputs: {
      readonly [i in keyof args]: {
        readonly name: args[i]['name'];
        readonly type: args[i]['type'];
      };
    };
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
  args: readonly ArgSpec[],
  returns: readonly { name: string; type: EvsType }[],
): Abi;
// runtime mirror; inputs order = args tuple order; components order = returns insertion order

export function selectorOf(name: string, argTypes: readonly string[]): Hex; // viem toFunctionSelector
export function toPlainAbiFunction(item: AbiFunction): PlainAbiFunction; // + selector; validates v0 types
export function encodeLiteralWord(type: WordType, value: unknown): Hex; // canonical 32-byte word
export function encodeLiteralData(type: DynType | ArrayType, value: unknown): Hex; // [len][payload] memref bytes
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
// builder/script.ts
export function evscript<
  const name extends string,
  const args extends readonly ArgSpec[],
  ret extends Record<string, Expr>,
>(
  def: { name: name; args: args },
  body: (s: ScriptBuilder<args>) => ScriptReturn<ret>,
  opts?: { locations?: boolean },
): EvsScript<name, args, ret>;

export interface EvsScript<name, args, ret> {
  /* exactly api.md §1 */
}
export interface ScriptBuilder<args extends readonly ArgSpec[]> {
  /* exactly api.md §4 */
}
export interface Cell<t extends EvsType> {
  /* api.md §5 */
}
export interface MutArray<e extends WordType> {
  /* api.md §5 */
}
export interface LoopCtl {
  break(): void;
  continue(): void;
}
export declare const returnBrand: unique symbol;
export interface ScriptReturn<ret extends Record<string, Expr>> {
  readonly [returnBrand]: ret;
}
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
   value; `expr()` returns a plain `Expr` handle aliasing the same ValueId.
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

**Unit tests (M5)**: IR snapshot (`serializeIr`) per builder API; every checklist item has a
test asserting error class, message substring, and loc; staging traps (`x+1`, template
literal, `JSON.stringify`); cross-script and cross-scope handles; loop scoping (header value
visible in body, body value invisible after); fold tests incl. certain-panic.
**Type tests** (`builder.test-d.ts`): `s.args` record; `s.call` single-output unwrap / tuple /
void; `@ts-expect-error` on nonpayable functionName, wrong literal types, `eq` on memref;
graceful widening with a non-const ABI; `ScriptReturn` inference through `evscript`.

---

## M6. `ir/interp.ts` — reference interpreter (test oracle)

Imports allowed: `core/*`, `ir/*`, `abi/*`, `viem` (encode/decode for ABI byte-accuracy).

```ts
export interface MockChain {
  staticcall(req: { to: Hex; data: Hex }): { success: boolean; data: Hex };
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
  opts?: { trace?: boolean; maxSteps?: number },
): InterpResult;
```

Binding invariant: **bit-for-bit agreement with the compiled bytecode** on both returndata and
revert payloads (incl. Panic codes, EvsDecodeError site ids, bubbled callee reverts, tryCall
zeroing, normalization rules of §7/§8 of architecture.md). The interpreter implements the same
checked-arithmetic spec table (architecture §6) — its source of truth is that table, not the
codegen. On divergence in differential tests, `evm-target.md` + architecture §6 adjudicate.

**Unit tests (M6)**: golden runs over hand-built IRs covering every stmt kind; revert paths
(panic codes per width incl. `int256 min / −1`, MUL wrap-back for uint192); decode-fail site
ids; tryCall zeroing; maxSteps guard.

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
export interface CompiledEvsScript<name, args, ret> {
  /* exactly api.md §10 */
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
// evscript, compile, arg, t, interpret, disassemble, lookupPc, serializeIr, deserializeIr,
// EVS_ERROR_ABI, DEFAULT_SCRIPT_ADDRESS, EvsError + subclasses, and all public types
// (Expr, IntoExpr, EvsType…, ArgSpec, ScriptBuilder, Cell, MutArray, LoopCtl, ScriptReturn,
// EvsScript, CompiledEvsScript, CompileOptions, EvsDiagnostic, ScriptAbi, SourceMap,
// Disassembly, RevertExplanation, MockChain, InterpResult).
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
