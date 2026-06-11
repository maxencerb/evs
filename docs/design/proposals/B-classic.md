# Proposal B — evs as a small classic compiler

Status: proposal (Angle B). Date: 2026-06-11.
Pipeline: **typed builder AST → linear IR (basic blocks, virtual values) → asm items → bytecode**.
All factual claims about EVM/viem/abitype behavior reference the verified research in
`docs/research/` (evm-target.md, viem-integration.md, abitype-typing.md, prior-art.md,
stack-testing.md). Locked decisions (callback builder, v0 scope, plain-TS compiler, legacy
bytecode w/ Cancun floor down to paris, ESM-only, viem peer) are taken as given.

---

## 0. Pipeline overview

```
user callback                s.call / s.add / s.if / s.while / s.fn / s.return
      │  (recording, type-checked by TS + validated at runtime, source locs captured)
      ▼
ScriptAst        structured, typed, serializable plain data (statements + value table)
      │  lower()           — syntax-directed, single pass, no analyses
      ▼
LirProgram       basic blocks, virtual values (SSA-lite: every result fresh, no phis;
      │            mutable state only via LocalId slots)
      │  verify → constFold → deadCode → verify
      ▼
AsmItem[]        per-block instruction selection; memory-slot value strategy + stack fusion;
      │            dispatcher prologue, call/ABI patterns, shared panic/error tails
      │  peephole → assemble (PUSH2 fixups, layout, JUMPDEST audit)
      ▼
Compiled         { runtimeBytecode, initBytecode, abi (as const), toViem(), disassemble(), sourceMap }
```

Four inspectable artifacts (AST JSON, LIR text, asm listing, bytecode+sourceMap), each
snapshot-testable and diffable. PC → asm item → LIR instr → AST node → user source line is a
chain of ids, built from day one (prior-art lesson 6/7).

---

## 1. Where the extra LIR layer pays for itself (the Angle B argument)

A direct AST→asm emitter would be ~25% less code today and strictly worse tomorrow:

1. **Constant folding & literal-calldata pre-encoding** are trivial on a linear IR with
   immediate operands (`{kind:'imm'}`): fold pure ops whose operands are all imm, then
   `call.static` with all-imm args collapses its argument list into one precomputed
   `{kind:'data'}` calldata blob (encoded at compile time with viem's `encodeFunctionData`).
   On a tree you'd be rewriting nodes that handles still point at.
2. **Dead code** is a use-count sweep on LIR (drop pure instrs with zero-use results). Calls
   are never dropped — value semantics promise "executes once where written" (§3).
3. **evmVersion lowering** (PUSH0→`PUSH1 0`, MCOPY→word loop) is confined to two codegen
   helpers (`emitZero`, `emitMemCopy`) and one assembler validation pass against the opcode
   table's `sinceFork`. The builder and lowering never know the target fork exists.
4. **A verifier between every pair of passes.** `verifyLir` checks: every operand defined
   before use, block terminators well-formed, types of operands match opcode signatures,
   every `local.set` targets a declared local. With 5–6 agents implementing modules in
   parallel, the verifier converts cross-module integration bugs into precise single-module
   bug reports. This alone justifies the layer.
5. **The optimizer has a home.** v0 ships only constFold + deadCode + asm peephole, but the
   pass interface (`LirPass = (p: LirProgram, ctx) => LirProgram`) is where slot coalescing
   (liveness), jump threading, block merging, and a real stack scheduler land later —
   without touching builder, lowering, or assembler.

Each layer stays thin for v0: lowering is one syntax-directed pass (~350 LOC), LIR is a
types file plus two ~60-LOC passes, codegen is local per-instruction patterns (~900 LOC).
No dominator trees, no SSA construction, no phis (locals are memory slots, §4/§5).

---

## 2. Decision 1 — args declaration API + ABI inputs strategy

**Choice: (c) ordered arg declarators** — a readonly tuple of `arg(name, type)` specs.

```ts
import { evscript, arg, t } from '@maxencerb/evs'

const script = evscript(
  { name: 'poolMeta', args: [arg('pool', t.address), arg('fee', t.uint24)] },
  (s) => { /* s.args.pool: Expr<'address'>, s.args.fee: Expr<'uint24'> */ },
)
```

### Exact signatures

```ts
// src/core/types.ts
declare const argBrand: unique symbol
export interface ArgSpec<name extends string = string, type extends EvsAbiType = EvsAbiType> {
  readonly [argBrand]: true
  readonly name: name
  readonly type: type
}
export type AnyArgSpec = ArgSpec<string, EvsAbiType>

export function arg<const name extends string, const type extends EvsAbiType>(
  name: name,
  type: type,
): ArgSpec<name, type>

// `t` is a frozen literal namespace; raw strings also accepted everywhere a type is expected.
export const t: {
  readonly address: 'address'; readonly bool: 'bool'
  readonly uint8: 'uint8' /* … every uintN/intN/bytesN … */ readonly uint256: 'uint256'
  readonly string: 'string'; readonly bytes: 'bytes'
  array<const e extends WordType>(elem: e): `${e}[]`
  arrayN<const e extends WordType, const n extends number>(elem: e, n: n): `${e}[${n}]`
}

// tuple → record is the SAFE direction (no UnionToTuple anywhere on the input path)
export type ArgsExprs<params extends readonly AnyArgSpec[]> = {
  readonly [p in params[number] as p['name']]: Expr<p['type']>
}
// mapped tuple preserves order: type-level inputs order ≡ runtime order ≡ declaration order
export type ParamsToInputs<params extends readonly AnyArgSpec[]> = {
  readonly [i in keyof params]: {
    readonly name: params[i]['name']; readonly type: params[i]['type']
  }
}
```

### Why (c) over (a)/(b)

- **The hazard is killed by construction.** abitype-typing.md §4.2 demonstrates that
  `Record → tuple` via `UnionToTuple` follows TS interning order (reproduced:
  `{token0, symbol0, tick}` emitted as `[tick, token0, symbol0]` because `'tick'` was
  interned earlier in the file). With a readonly tuple of `ArgSpec`s there is no
  record→tuple conversion on the input path at all: `ParamsToInputs` is a mapped tuple
  (order-preserving, compile-verified pattern in the research), and `ArgsExprs` maps
  tuple→record, which is order-insensitive by nature.
- **Over (a) single named-tuple input:** (a) is order-safe but changes the call-site shape to
  `args: [{ pool, fee }]` — one object inside a one-tuple. That is not how anyone calls
  `readContract` today; the flagship demo reads worse; and single-arg scripts pay the
  wrapper too. (c) yields `args: [pool: '0x…', fee: number]` — a labeled positional tuple,
  exactly viem-native.
- **Over (b) entries-tuple:** `[['pool','address']]` is type-equivalent to (c) but worse DX:
  no autocomplete surface for the type position until you type quotes, and no room to grow
  (per-arg options like docs/defaults later become a third tuple slot — positional soup).
  `arg()` is a named, documented function; `t.` autocompletes every type.
- Runtime validation (recording time): duplicate names, empty names, and names not matching
  `/^[A-Za-z_]\w*$/` throw `EvsBuildError` with the declaration's source location. A
  type-level duplicate guard is optional polish, not load-bearing (runtime check is).

**Output side (settled):** one output `{ name: 'result', type: 'tuple', components }` built
from the `s.return({...})` record. Runtime component order = `Object.keys()` insertion order
(ECMA-262 guaranteed for string keys); type-level component order may differ (UnionToTuple)
but is harmless because viem decodes a fully-named single tuple output to an **object**
(abitype-typing.md §4.2 table, §4.3 rule 4). The compiler rejects empty-string keys (would
silently degrade the object to a positional array — §4.3 rule 4 exact check quoted there).

CI ships type tests (`expect-type`) asserting `ReadContractParameters<abi,'poolMeta'>['args']`
and `ReadContractReturnType<…>` for representative scripts, per the research recommendation.

---

## 3. Decision 2 — Expr semantics: VALUE semantics

**Choice: value semantics.** Every `s.*` operation executes once, at the program point where
it is recorded, appended to the current statement list. The returned `Expr<T>` is a handle to
that one computed value; using it five times reads the same value, never re-executes.
Mutable state exists only through explicit cells:

```ts
const i = s.let(t.uint256, 0n)   // Cell<'uint256'>
i.set(s.add(i.get(), 1n))        // i.get() reads the cell *at this program point*
```

### Why not expression templates (PyTeal-style trees)

The PyTeal post-mortem (prior-art.md §2) is decisive. Re-emitting trees per use means:
(1) an `Expr` holding a `staticcall` silently re-executes the call (double gas, and
divergent results are *possible* within one eth_call only via msize/gas — but duplicated
reverts and gas are real); (2) sharing requires the user to learn an extra `cache`/`Seq`
vocabulary; (3) host-language interaction bugs ("errors … go unnoticed until TEAL
generation, or worse go completely unnoticed" — Puya principles, quoted in research)
multiply because the tree's evaluation point is invisible at the call site. Value semantics
makes the recorded program order the execution order — the one mental model JS developers
already have.

### What value semantics forces on control flow (and the chosen design)

A loop condition must re-evaluate every iteration, so it cannot be a value — it must be a
**thunk recorded into the loop header region**:

```ts
// src/builder.ts (surface; full ScriptBuilder in §12)
if(cond: Operand<'bool'>, then: () => void, otherwise?: () => void): void
while(cond: () => Operand<'bool'>, body: (loop: LoopCtl) => void): void
for(opts: { start: Operand<'uint256'>; end: Operand<'uint256'>; step?: Operand<'uint256'> },
    body: (i: Expr<'uint256'>, loop: LoopCtl) => void): void   // sugar over while + internal cell
select<type extends EvsAbiType>(cond: Operand<'bool'>, a: Operand<type>, b: Operand<type>): Expr<type>

export interface LoopCtl { break(): void; continue(): void }   // valid only while its loop is open
export interface Cell<type extends EvsAbiType> {
  readonly type: type
  get(): Expr<type>                 // records a localGet — a *copy* of the cell at this point
  set(value: Operand<type>): void   // records a localSet
}
let<const type extends EvsAbiType>(type: type, init: Operand<type>): Cell<type>
```

Recording mechanics: `s.while(condThunk, bodyThunk)` pushes a `while` statement, redirects
the recorder's "current statement list" to the statement's `condBody`, invokes `condThunk`
(its ops land in the header region; its returned operand is coerced and noted as the
condition value), then redirects to `body` and invokes `bodyThunk`, then pops. `s.if`'s
condition is a plain operand (evaluated once, before the branch) — only loops need thunks.

Semantic fine print (documented, enforced):

- `cell.get()` materializes a copy: a `get` captured before a `set` keeps the old value.
- `s.select` operands are *already-computed values* — both sides are evaluated eagerly at
  their recording points. For lazy/conditional evaluation use `s.if` + a cell. (This is the
  honest consequence of value semantics; hiding it would recreate PyTeal's confusion.)
- An unused `s.call(...)` result still executes the call (it was recorded). DCE never
  removes calls.
- Host-language misuse: handles poison `valueOf`/`Symbol.toPrimitive`/`toString` (throw
  `EvsStagingError` with the offending source line), so `x + 1`, `` `${x}` ``, `x == 5`
  explode immediately. JS cannot poison truthiness — `if (x)` / `x && y` on a handle is
  undetectable at runtime; we document it loudly and recommend the type-aware
  `typescript/strict-boolean-expressions` lint (available through oxlint+tsgolint) which
  flags non-boolean conditions at dev time.

---

## 4. Decision 3 — IR design

Two IRs, both serializable plain data (`prior-art` lesson 9), every node carrying a `loc`.

### 4.1 ScriptAst (builder output): structured statements + value table

```ts
// src/ast.ts
export type ValueId = number
export type LocalId = number
export type FnId = number
export type NodeId = number

export interface SourceLocation { file: string; line: number; column: number }

export type BinKind =
  | 'add' | 'sub' | 'mul' | 'div' | 'mod'                  // numeric, checked flag applies
  | 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'neq'             // → bool; signedness from operand type
  | 'band' | 'bor' | 'bxor' | 'shl' | 'shr'                // bitwise (shr = SAR for intN)
  | 'and' | 'or'                                           // bool ∧/∨ (non-short-circuit)

export type AstOp =
  | { op: 'const'; type: EvsAbiType; value: bigint | Uint8Array | readonly bigint[] }
  | { op: 'arg'; index: number }
  | { op: 'env'; kind: 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid' }
  | { op: 'bin'; kind: BinKind; checked: boolean; a: ValueId; b: ValueId }
  | { op: 'un'; kind: 'not' | 'bitnot'; a: ValueId }
  | { op: 'cast'; to: EvsAbiType; a: ValueId }             // solidity explicit-cast semantics
  | { op: 'select'; cond: ValueId; a: ValueId; b: ValueId }
  | { op: 'index'; arr: ValueId; i: ValueId }              // bounds-checked → Panic 0x32
  | { op: 'len'; a: ValueId }
  | { op: 'arrayLit'; elem: WordType; items: readonly ValueId[] }
  | { op: 'localGet'; local: LocalId }
  | { op: 'staticcall'; target: ValueId; fnAbi: AbiFunction; args: readonly ValueId[]; try: boolean }
  | { op: 'fnCall'; fn: FnId; args: readonly ValueId[] }

export type Stmt =
  | { kind: 'bind'; id: NodeId; loc: SourceLocation; op: AstOp; results: readonly ValueId[] }
  | { kind: 'localDecl'; id: NodeId; loc: SourceLocation; local: LocalId; type: EvsAbiType; init: ValueId }
  | { kind: 'localSet'; id: NodeId; loc: SourceLocation; local: LocalId; value: ValueId }
  | { kind: 'assert'; id: NodeId; loc: SourceLocation; cond: ValueId; panicCode: number }
  | { kind: 'if'; id: NodeId; loc: SourceLocation; cond: ValueId; then: Stmt[]; else: Stmt[] }
  | { kind: 'while'; id: NodeId; loc: SourceLocation; condBody: Stmt[]; cond: ValueId; body: Stmt[] }
  | { kind: 'break' | 'continue'; id: NodeId; loc: SourceLocation }
  | { kind: 'return'; id: NodeId; loc: SourceLocation
      record: readonly { name: string; value: ValueId }[] }

export interface FnAst {
  id: FnId; name: string
  params: readonly { name: string; type: EvsAbiType; value: ValueId }[]
  body: Stmt[]
  results: readonly EvsAbiType[]
}

export interface ScriptAst {
  version: 1
  name: string
  args: readonly { name: string; type: EvsAbiType }[]
  fns: readonly FnAst[]
  body: readonly Stmt[]
  values: ReadonlyMap<ValueId, { type: EvsAbiType; loc: SourceLocation; scope: FnId | 'main' }>
}

export function serializeAst(ast: ScriptAst): string          // stable JSON (values as array)
export function walkStmts(stmts: readonly Stmt[], visit: (s: Stmt) => void): void
```

Notes:
- **Multi-result is first-class** (`results: ValueId[]`): a staticcall to `slot0()` binds
  three values; `try` calls bind `[ok, ...outputs]`.
- All literals are normalized into `const` bind nodes at recording (one place to range-check,
  enables literal dedup later). `staticcall.fnAbi` keeps the exact (already-validated) ABI
  fragment; selector and layouts are derived at compile time, keeping the AST viem-free.
- **Source locations**: every builder call does `captureLoc()` — `new Error().stack` is
  captured eagerly (cheap: V8 lazily materializes), parsed lazily on first access; frames
  inside `@maxencerb/evs` are skipped by filename. Disable with
  `evscript(def, body, { locations: false })` for hot programmatic generation.
- **Expr handle branding**: the public `Expr<t>` interface carries only
  `readonly [exprBrand]: t` (unique symbol — nominal, per abitype-typing §4.6) plus the
  poisoned `valueOf/toString/[Symbol.toPrimitive]` typed `(): never`. The runtime object's
  internals (`{ scriptId, scope, valueId, type }`) live in a module-private `WeakMap`
  keyed by the handle — unforgeable, invisible in `.d.ts`, and cross-script use is detected
  by lookup (miss or scriptId mismatch ⇒ `EvsScopeError` naming both scripts).
  Handles also implement `Symbol.for('nodejs.util.inspect.custom')` → `Expr<uint256 #12 @file:line>`
  so debugging stays pleasant.

### 4.2 LIR: basic blocks + virtual values, no phis

```ts
// src/lir.ts
export type VId = number
export type BlockId = number

export type LirOperand =
  | { kind: 'v'; v: VId }
  | { kind: 'imm'; value: bigint }
  | { kind: 'data'; bytes: Uint8Array }       // pre-encoded constant blobs (calldata, array lits)

export type LirInstr =
  | { op: 'iconst'; results: [VId]; value: bigint; meta: Meta }
  | { op: 'bin'; kind: 'add'|'sub'|'mul'|'divu'|'divs'|'modu'|'mods'
                |'ltu'|'gtu'|'lts'|'gts'|'eq'|'band'|'bor'|'bxor'|'shl'|'shr'|'sar'
      checked: boolean; bits: number               // bits: result width for overflow checks
      a: LirOperand; b: LirOperand; results: [VId]; meta: Meta }
  | { op: 'un'; kind: 'iszero'|'bnot'; a: LirOperand; results: [VId]; meta: Meta }
  | { op: 'clean'; layout: WordLayout; a: LirOperand; results: [VId]; meta: Meta }
  | { op: 'select'; cond: LirOperand; a: LirOperand; b: LirOperand; results: [VId]; meta: Meta }
  | { op: 'env'; kind: 'address'|'caller'|'timestamp'|'blocknumber'|'chainid'; results: [VId]; meta: Meta }
  | { op: 'local.get'; local: LocalId; results: [VId]; meta: Meta }
  | { op: 'local.set'; local: LocalId; value: LirOperand; results: []; meta: Meta }
  | { op: 'arr.new'; elem: WordLayout; length: number | null; items: readonly LirOperand[]
      results: [VId]; meta: Meta }                 // → memref
  | { op: 'arr.get'; arr: LirOperand; index: LirOperand; elem: WordLayout; results: [VId]; meta: Meta }
  | { op: 'arr.len'; arr: LirOperand; results: [VId]; meta: Meta }
  | { op: 'call.static'
      target: LirOperand; selector: Hex
      argLayouts: readonly TypeLayout[]; retLayouts: readonly TypeLayout[]
      args: readonly LirOperand[]                  // collapses to one {kind:'data'} when all-imm
      try: boolean
      results: readonly VId[]                      // try: [ok, ...outs] else [...outs]
      meta: Meta }
  | { op: 'fn.call'; fn: FnId; args: readonly LirOperand[]; results: readonly VId[]; meta: Meta }

export interface Meta { loc?: SourceLocation; astId?: NodeId }

export type LirTerm =
  | { kind: 'jump'; to: BlockId }
  | { kind: 'brif'; cond: LirOperand; then: BlockId; else: BlockId }
  | { kind: 'ret'; values: readonly LirOperand[] }                  // user-fn return
  | { kind: 'scriptReturn'; values: readonly LirOperand[] }         // encode tuple + RETURN
  | { kind: 'panic'; code: number }                                 // Panic(uint256)
  | { kind: 'fail'; code: number }                                  // EvsError(uint256)

export interface LirBlock { id: BlockId; instrs: LirInstr[]; term: LirTerm }
export interface LirFn {
  id: FnId | 'main'
  params: readonly { v: VId; type: EvsAbiType }[]
  locals: readonly { l: LocalId; type: EvsAbiType }[]
  blocks: LirBlock[]                                // blocks[0] is entry
  results: readonly EvsAbiType[]
}
export interface LirProgram { main: LirFn; fns: readonly LirFn[]; valueTypes: ReadonlyMap<VId, EvsAbiType> }

export type LirPass = (p: LirProgram) => LirProgram
export const constFold: LirPass        // pure ops, all-imm → imm; certain-panic → EvsCompileError
export const deadCode: LirPass         // zero-use pure results removed; calls/local.set kept
export function verifyLir(p: LirProgram): void   // throws EvsCompileError on malformed IR
export function printLir(p: LirProgram): string  // stable text form, snapshot-friendly
```

**Why no phis:** every Expr is single-assignment by construction; the only mutable state is
cells, which lower to `LocalId`s (memory slots, §5). Values defined before a loop and used
inside it are loop-invariant — read from their slot. This is the classic "virtual registers
+ memory locals" mid-IR; SSA/phi machinery would be pure cost in v0 and can be introduced
later as a pass without changing producers.

**constFold detail:** folding a checked op that would always panic (e.g. `s.add(uintMax, 1n)`
with both literal) is reported as `EvsCompileError` ("this expression always reverts with
Panic(0x11)") rather than folded into a panic — it is certainly a bug.
`call.static` argument prefolding: when every arg operand is `imm`/`data`, the pass replaces
`args` with a single `data` operand containing `encodeFunctionData({abi:[fnAbi], functionName, args})`
computed with viem (peer dep used at compile time only).

---

## 5. Decision 4 — memory model

Solidity-compatible map (evm-target.md §6), extended with a static frame:

| Range | Use |
|---|---|
| `0x00–0x3f` | scratch — revert-tail payload building, short-lived codegen temporaries |
| `0x40–0x5f` | free-memory pointer |
| `0x60–0x7f` | zero slot, never written — doubles as the canonical **empty memref** (`mload(0x60)=0` ⇒ length 0), used for `tryCall` failure defaults |
| `0x80 … 0x80+F` | **static frame**: one 32-byte slot per (a) script arg, (b) local (cell), (c) spilled virtual value, (d) user-fn param/result slot — assigned at codegen, F known statically |
| `0x80+F …` | bump allocations (call buffers, returndata staging, arrays, return tuple) |

Prologue: `PUSH2 frameEnd PUSH1 0x40 MSTORE` (frameEnd = 0x80+F rounded to 32).

**Locals & virtual values — the slot strategy.** Every LIR value is classified at codegen:

- **fused**: produced and consumed exactly once by the *next* instruction in the same block
  → lives transiently on the operand stack, zero memory traffic;
- **slotted**: everything else (multi-use, crosses an instruction gap, crosses a block edge)
  → a frame slot; producers `MSTORE slot`, consumers `MLOAD slot`.

Locals are always slotted. This eliminates stack scheduling (EvmScript's A* search — a
deliberately skipped problem, prior-art lesson 15) and yields a hard invariant: **the operand
stack is empty at every instruction boundary except inside a fusion chain**, with a codegen
assert that simulated depth ≤ 16 (so DUP/SWAP always reach; deeper expressions force a
spill). Stack-overflow (1024) is structurally impossible. The classification is a pluggable
interface (`assignSlots(fn: LirFn): SlotPlan`) so a real allocator (liveness-based slot
reuse, weiroll-style) can replace it without touching instruction selection.

**Dynamic values** (`string`, `bytes`, `T[]`, `T[N]`) are **memrefs**: a single word holding
a pointer to `[len][data…]` (fixed arrays: `[len=N][N words]`, length materialized for
uniform `arr.len`/bounds codegen). A memref flows through slots/stack like any word.

**Loops × allocation:** the bump pointer only grows (memory is never freed). Allocations
inside a loop body grow memory each iteration; quadratic gas only matters past ~724 words
(~23KB, evm-target §4) so typical scripts don't care, but `compile()` emits a warning
diagnostic when an allocating op (`arr.new`, dynamic-output `call.static`) sits inside a
loop, and the docs show the cell-hoisting pattern. A `s.scope()` arena-reset combinator is
deferred (would break memref escape — needs escape analysis).

**Function frames:** no recursion in v0 (§6) ⇒ every function's params/locals/spills get
globally unique static slots in the same frame — no frame pointer, no dynamic allocation.

---

## 6. Decision 5 — user-defined functions (`s.fn`)

```ts
// surface
const sumRange = s.fn(
  { name: 'sumRange', params: [arg('from', t.uint256), arg('to', t.uint256)] },
  ({ from, to }) => {
    const acc = s.let(t.uint256, 0n)
    s.for({ start: from, end: to }, (i) => acc.set(s.add(acc.get(), i)))
    return acc.get()                                  // return type inferred: Expr<'uint256'>
  },
)
const x = sumRange(1n, s.args.n)                      // callable — records a fnCall here

// exact signature (src/builder.ts)
fn<const params extends readonly AnyArgSpec[], const r extends FnReturn>(
  def: { name?: string; params: params },
  body: (args: ArgsExprs<params>) => r,
): EvsFn<params, r>

export type FnReturn = Expr<EvsAbiType> | readonly Expr<EvsAbiType>[] | void
export type EvsFn<params extends readonly AnyArgSpec[], r extends FnReturn> =
  ((...args: OperandsOf<params>) => RebindResults<r>) & { readonly fnId: FnId }
type OperandsOf<params extends readonly AnyArgSpec[]> =
  { [i in keyof params]: Operand<params[i]['type']> }
type RebindResults<r> =      // fresh Exprs at each call site, same types as the definition's
  r extends void ? void
  : r extends Expr<infer t> ? Expr<t>
  : { readonly [k in keyof r]: r[k] extends Expr<infer t> ? Expr<t> : never }
```

Recording: the body runs **once at definition**, inside a pushed fn scope (the same `s` is
used; the recorder maintains a scope stack). Each *call* records a one-statement `fnCall`
bind. Recursion (direct or mutual) is rejected: recording a call to a fn whose body is
currently open throws `EvsBuildError`, and `compile()` re-checks the call graph for cycles.

**Scope rule (strict in v0):** an `Expr` or `Cell` created in one scope may not be used in
another — args must be passed explicitly. Enforced per-handle (scope id check on every use;
`EvsScopeError` names both scopes and both source locations). Rationale: with static frames,
outer capture *would* be sound for dominating definitions, but "reads the slot's current
content" semantics for non-dominating ones is a silent footgun; the strict rule is teachable
and droppable later without breaking code that obeyed it.

**Inline vs subroutine: JUMPDEST subroutine, return address on stack.** Calling convention
(memory-frame, zero stack choreography):

1. caller stores each argument into the callee's static param slots (`MSTORE`),
2. `PUSH2 retLabel; PUSH2 fnEntry; JUMP`,
3. callee body runs (its stack starts `[retAddr]` and the invariant keeps it at the bottom),
4. callee stores results into its static result slots, `JUMP` to retAddr,
5. caller `MLOAD`s result slots into the call's result value slots (or fuses).

Cost per call ≈ (nArgs + nResults) × ~9 gas + 2 jumps — negligible for read scripts; code is
emitted once regardless of call count. Inlining ("fn called exactly once") is a later
optimizer pass, not v0. A fn used zero times is simply not emitted (dead fns dropped at
lowering — shader-ast's call-graph topo-order lesson).

---

## 7. Decision 6 — call codegen (`s.call` / `s.tryCall`)

### Surface (mirrors readContract; abitype generics per research §1/§3)

```ts
type ViewMut = 'pure' | 'view'
export interface CallParams<
  abi extends Abi, name extends ExtractAbiFunctionNames<abi, ViewMut>,
  fn extends ExtractAbiFunction<abi, name, ViewMut> = ExtractAbiFunction<abi, name, ViewMut>,
> {
  address: Operand<'address'>
  abi: abi                                       // graceful widening for non-const abi, viem-style
  functionName: name | ExtractAbiFunctionNames<abi, ViewMut>   // keeps IDE autocomplete alive
  args?: { readonly [k in keyof fn['inputs']]: CallInput<fn['inputs'][k]> }
}
type CallInput<p extends AbiParameter> =
  | AbiParameterToPrimitiveType<p, 'inputs'>
  | Expr<p['type'] extends EvsAbiType ? p['type'] : never>

call<const abi extends Abi, name extends ExtractAbiFunctionNames<abi, ViewMut>>(
  p: CallParams<abi, name>,
): UnwrapSingle<OutputsToExprs<ExtractAbiFunction<abi, name, ViewMut>['outputs']>>

tryCall<const abi extends Abi, name extends ExtractAbiFunctionNames<abi, ViewMut>>(
  p: CallParams<abi, name>,
): { ok: Expr<'bool'>
     value: UnwrapSingle<OutputsToExprs<ExtractAbiFunction<abi, name, ViewMut>['outputs']>> }
```

Overloaded ABI names are rejected at recording in v0 (`EvsBuildError`, suggests pruning the
ABI); the `ExtractAbiFunctionForArgs` disambiguation pattern is documented as the later fix.

### Codegen pattern (expanded by codegen from one `call.static` LIR instr)

1. **Calldata build** at `buf = mload(0x40)`:
   - all-args-literal (after constFold): the entire calldata is a compile-time constant —
     ≤ 96 bytes → PUSH32-chunked `MSTORE`s; larger → data segment + `CODECOPY` (assembler
     `bytes` items with a label, §9);
   - mixed: `PUSH4 sel; PUSH1 0xE0; SHL; MSTORE(buf)`, then per-arg via the shared ABI
     encoder (§8) at `buf+4`: static args inline at their head offset, dynamic args get a
     head offset word and tail appended (head offsets relative to `buf+4`).
2. **`STATICCALL(GAS, target, buf, argLen, 0, 0)`** — retSize 0; outputs are read via
   RETURNDATASIZE/RETURNDATACOPY (uniform for static and dynamic outputs; avoids the
   "min(retSize, rds)" partial-copy trap).
3. **non-try failure → bubble verbatim** (works for Error/Panic/custom errors alike):
   `RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY RETURNDATASIZE PUSH0 REVERT`
   (`(0,0,rds)` can never violate RETURNDATACOPY's OOB-halt rule).
4. **Output decode** (§8): minimal-size check (`rds < staticMinSize` → `fail(0x03)`), copy
   whole returndata to a fresh allocation once, then bounds-checked in-memory decoding —
   static words MLOADed + `clean`ed; dynamic members validated (offset ≤ 2⁶⁴-1, len ≤ 2⁶⁴-1,
   `base+32+len ≤ end`) and **decoded in place** (the ABI tail `[len][data]` *is* the evs
   memref layout — zero copy), malformed → `fail(0x04)`.
5. **tryCall**: `ok = success AND decode-ok`. Failure path skips decode and binds defaults:
   words → 0, memrefs → `0x60` (the zero slot ⇒ empty). Decode-validation failures branch to
   the same "ok=0, defaults" join instead of `fail`. No bubble.

Worked example with exact bytes/stack: §15.B.

---

## 8. Decision 7 — ABI encode/decode codegen

One shared component (`src/abi.ts` descriptors + `src/codegen.ts` emitters) serves all four
sites: dispatcher arg decode (calldata), call arg encode (memory), call output decode
(returndata), script return encode (memory). Written recursively over `TypeLayout` so nested
tuples later = deleting a builder-side guard, not new codegen.

```ts
// src/abi.ts
export type WordLayout = { kind: 'word'; abi: WordType; bits: number; signed: boolean; leftAligned: boolean }
export type TypeLayout =
  | WordLayout
  | { kind: 'bytes'; abi: 'bytes' | 'string' }
  | { kind: 'array'; abi: string; elem: TypeLayout; length: number | null }   // null = dynamic
  | { kind: 'tuple'; abi: 'tuple'; components: readonly (TypeLayout & { name: string })[] }
export function layoutOf(abiType: string): TypeLayout        // throws EvsBuildError on unsupported
export function isDynamic(l: TypeLayout): boolean
export function headBytes(l: TypeLayout): number             // static arrays: N*elemHead, inline
```

**Canonical word form** (everything on stack/slots is a full word): uintN zero-extended,
intN sign-extended, bytesN left-aligned, bool ∈ {0,1}, address zero-extended 160-bit.
`clean` ops are inserted at trust boundaries only: after decode (calldata/returndata) and
after `cast`; checked arithmetic on sub-word types range-checks the full-width result
against the type's bounds (solc 0.8 approach) → Panic 0x11.

**Decode (dispatch).** `calldatasize < 4 + Σ headBytes` → `fail(0x02)`. Word args:
`CALLDATALOAD(4+32i)` + `clean` (normalize, don't revert on dirty high bits — viem always
encodes clean; deviation from solc documented). Dynamic args: head offset validated
(`≤ 2⁶⁴-1`, in-bounds vs CALLDATASIZE), tail copied to memory via CALLDATACOPY into evs
layout. Note CALLDATALOAD/COPY zero-pad (no OOB halt), so checks guard correctness, not halts.

**Decode (returndata).** As §7 step 4 — single full copy, then pointer-arithmetic
validation in memory. RETURNDATACOPY is only ever issued as `(dest, 0, RETURNDATASIZE)`,
which is unconditionally safe; all offset math happens on already-copied memory.

**Encode (return tuple).** Outputs are `[ { name:'result', type:'tuple', components } ]`, so
returndata = ABI encoding of that one tuple: static tuple → fields inline; dynamic tuple →
`[0x20][tuple encoding]`. Emitter walks components with a running tail pointer:

```
out = mload(0x40)
if dynamic(tuple): mstore(out, 0x20); base = out+0x20 else base = out
tail = base + headBytes(components)
for each component c at head offset h:
  static c:  mstore(base+h, cleaned value)            // static array: MCOPY/loop from memref data
  dynamic c: mstore(base+h, tail-base)
             copy [len][data] from memref to tail (MCOPY on cancun; MLOAD/MSTORE word loop below)
             tail += 32 + ceil32(len)                  // arrays: 32 + 32*len
RETURN(out, tail-out)
```

Same emitter (modulo destination = call buffer and the 4-byte selector shift) encodes
sub-call arguments. Differential tests pit the emitted decoder/encoder against viem's
`decodeFunctionResult`/`encodeAbiParameters` on fuzzed values (§12).

---

## 9. Decision 8 — assembler

```ts
// src/asm.ts
export type EvmVersion = 'paris' | 'shanghai' | 'cancun'
export interface OpInfo { code: number; pops: number; pushes: number; since: EvmVersion | 'frontier' }
export const OPCODES: Readonly<Record<Mnemonic, OpInfo>>     // table from evm-target.md §2

export type LabelId = number
export type AsmItem =
  | { kind: 'op'; op: Mnemonic; meta?: Meta }
  | { kind: 'push'; value: bigint; meta?: Meta }             // emitted as minimal-width PUSHn / PUSH0
  | { kind: 'pushLabel'; label: LabelId; meta?: Meta }       // always PUSH2 + fixup
  | { kind: 'label'; label: LabelId; jumpdest: boolean }     // jumpdest:false for data labels
  | { kind: 'bytes'; data: Uint8Array; meta?: Meta }         // data segment blobs

export interface SourceMapEntry { pc: number; len: number; loc?: SourceLocation; astId?: NodeId }
export interface SourceMap { entries: readonly SourceMapEntry[]; lookup(pc: number): SourceMapEntry | undefined }
export interface AssembleResult { bytecode: Uint8Array; sourceMap: SourceMap; labelPcs: ReadonlyMap<LabelId, number> }

export function assemble(items: readonly AsmItem[], opts: { evmVersion: EvmVersion }): AssembleResult
export function disassemble(code: Uint8Array | Hex, sourceMap?: SourceMap): readonly DisasmLine[]
export interface DisasmLine { pc: number; op: string; imm?: Hex; jumpdest: boolean; loc?: SourceLocation }
export type PeepholeRule = { name: string; match: number; apply(win: readonly AsmItem[]): AsmItem[] | null }
export function peephole(items: readonly AsmItem[], rules?: readonly PeepholeRule[]): AsmItem[]
```

- **Labels/fixups** (evm-target §3): every `pushLabel` emits `PUSH2 0x0000` + fixup record;
  after one layout pass offsets are final (PUSH2 is fixed-width and always sufficient under
  EIP-170's 24,576-byte cap — never narrowed post-layout). Patch big-endian.
- **Post-assembly audit** (day-one, per research): re-scan the final bytes with the
  PUSH-immediate-skipping JUMPDEST validity algorithm and assert every patched target is a
  real `JUMPDEST` opcode (not push data). Also assert no opcode above `opts.evmVersion`
  (`OPCODES[op].since` check — catches a stray MCOPY in a paris build).
- **Data segment**: `bytes` items are placed after the last code item, preceded by one
  `INVALID` (0xFE) guard byte; data labels have `jumpdest:false` and are referenced by
  `pushLabel` for CODECOPY sources. Bytes after the guard are unreachable (never executed,
  legal in legacy bytecode).
- **Peephole v0 rules** (pre-layout, window-based): `PUSH 0` → `PUSH0` (shanghai+) or
  `PUSH1 00`; `ISZERO ISZERO` before `JUMPI` → drop both; `DUP1 POP` → drop;
  `MSTORE slot; PUSH slot; MLOAD` → `DUP1; MSTORE slot` (store-forward, keeps the store for
  later uses); minimal-width PUSH selection. Rules never run across a `label` boundary.
- **Disassembler + PC map ship in v0** (prior-art lesson 7): `compiled.disassemble({source:true})`
  prints `pc  opcode  imm  ; file:line (ast #id)`. The sourceMap also powers the error
  decorator in docs/examples: given a revert at pc P from a trace, `sourceMap.lookup(P)`
  names the recording site.

---

## 10. Decision 9 — dispatcher + artifact

**Dispatcher** (single function; exact asm in §15.D): prologue sets the free pointer; if
`CALLDATASIZE < 4` → `fail(0x01)`; load selector `CALLDATALOAD(0) SHR 224`; `EQ` against the
script's selector (computed at compile time with viem's `toFunctionSelector` on
`name(argTypes…)`) → jump to body; fallthrough → `fail(0x01)` (EvsError code 1, "unknown
selector"). Revert tails are emitted once, lazily (only the codes actually referenced):

- `Panic(uint256)` tail — selector `0x4e487b71` (verified constant), 36-byte payload, codes
  0x01 (assert), 0x11 (overflow), 0x12 (div by zero), 0x32 (array OOB) — solc-compatible,
  decoded by viem out of the box.
- `EvsError(uint256)` tail — same shape, selector computed at compile time
  (`toFunctionSelector('EvsError(uint256)')`); codes: 1 unknown selector, 2 malformed script
  calldata, 3 returndata too short, 4 malformed returndata encoding. The error is **declared
  in the generated ABI** so viem decodes it into a typed `ContractFunctionRevertedError`.

```ts
// src/abi.ts (runtime constant + its literal type baked into ScriptAbi)
export const EVS_ERROR_ABI = [{
  type: 'error', name: 'EvsError',
  inputs: [{ name: 'code', type: 'uint256' }],
}] as const
```

**Artifact** (`src/compile.ts` + `src/viem.ts`):

```ts
export interface CompileOptions {
  evmVersion?: EvmVersion          // default 'cancun'; 'shanghai' drops MCOPY; 'paris' also drops PUSH0
  optimize?: boolean               // default true: constFold + deadCode + peephole
  locations?: boolean              // default true: thread source map through
}

export function compile<s extends AnyScript>(script: s, options?: CompileOptions): CompiledOf<s>

export interface Compiled<abi extends Abi> {
  readonly name: string
  readonly abi: abi                              // literal-typed: [fn, ...EVS_ERROR_ABI]
  readonly runtimeBytecode: Hex                  // NEVER exposed under a key named `code`
  readonly initBytecode: Hex                     // 0x61{len,2B BE}80600A5F395FF3 ++ runtime
                                                 // paris: 0x61{len}80600A3D393DF3 ++ runtime
  readonly sourceMap: SourceMap
  toViem(): { abi: abi; code: Hex }                              // deployless (default)
  toViem(o: { mode: 'deployless' }): { abi: abi; code: Hex }
  toViem(o: { mode: 'stateOverride'; address?: Address }):
    { abi: abi; address: Address; stateOverride: StateOverride }
  disassemble(opts?: { source?: boolean }): string
}
export const DEFAULT_SCRIPT_ADDRESS = '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530' as const
```

Per viem-integration.md: deployless is the default (`toViem()` spreads into `readContract`
as `{abi, code}` — `code` gets **init** bytecode, guarding the verified silent-failure
footgun of passing runtime bytes); `stateOverride` mode returns
`{abi, address, stateOverride:[{address, code: runtimeBytecode}]}`. Both shapes were
compile-verified against `ReadContractParameters` in the research. Peer dep:
`viem >= 2.14.1`. `compile()` enforces EIP-170 (runtime ≤ 24,576 bytes) with an
`EvsCompileError` that reports per-fn size contributions.

---

## 11. Decision 10 — type-level architecture

Direct adoption of the compile-verified prototype in abitype-typing.md §3, with the args
side swapped to the ArgSpec tuple (§2).

```ts
// Expr phantom flow
declare const exprBrand: unique symbol
export interface Expr<type extends EvsAbiType = EvsAbiType> {
  readonly [exprBrand]: type
  readonly type: type
  valueOf(): never; toString(): never; [Symbol.toPrimitive](hint: string): never
}

// literal coercion where an Expr is expected (per-parameter union — research §4.6)
export type Literal<type extends EvsAbiType> =
  type extends 'bool' ? boolean
  : type extends 'address' ? Address
  : type extends 'string' ? string
  : type extends 'bytes' | `bytes${number}` ? Hex
  : type extends `uint${number}` | `int${number}` ? bigint | number
  : type extends `${infer e extends WordType}[${string}]` ? readonly Literal<e>[]
  : never
export type Operand<type extends EvsAbiType> = Expr<type> | Literal<type>
```

Runtime coercion rules (validated at recording, `EvsTypeError` on violation): `number` must
be a safe integer; bigint/number range-checked against the target width; hex literals
length-checked (`bytesN` exactly N bytes, address 20); bool only for `'bool'`. No implicit
numeric widening between distinct Expr types — `s.cast` is explicit (solidity
explicit-conversion semantics: truncate / extend, no runtime check; documented).

Generated ABI type (output record → single named tuple, per §2):

```ts
export type ScriptAbi<
  name extends string, params extends readonly AnyArgSpec[], ret extends Record<string, Expr>,
> = readonly [
  {
    readonly type: 'function'; readonly name: name; readonly stateMutability: 'view'
    readonly inputs: ParamsToInputs<params>
    readonly outputs: readonly [{
      readonly name: 'result'; readonly type: 'tuple'
      readonly components: RetToComponents<ret>      // UnionToTuple-based; order-unstable but
    }]                                               // SAFE: decoded as an object (research §4.2)
  },
  (typeof EVS_ERROR_ABI)[0],
]

export function evscript<
  const name extends string,
  const params extends readonly AnyArgSpec[],
  ret extends Record<string, Expr>,
>(
  def: { name: name; args: params },
  body: (s: ScriptBuilder<params>) => ScriptReturn<ret>,
  opts?: { locations?: boolean },
): Script<name, params, ret>

export interface Script<name extends string, params extends readonly AnyArgSpec[], ret extends Record<string, Expr>> {
  readonly name: name
  readonly abi: ScriptAbi<name, params, ret>        // available pre-compile
  readonly ast: ScriptAst
  compile(options?: CompileOptions): Compiled<ScriptAbi<name, params, ret>>
}
```

viem-permissiveness patterns mirrored (research §2 "patterns worth mirroring"):
graceful widening (`abi extends Abi ? (Abi extends abi ? permissive : strict) : permissive`)
in `s.call`; `[x] extends [never]` guards after every Extract; the
`functionName: name | AllNames` union for autocomplete; `const` type params so inline ABIs
need no `as const` (standalone ABIs documented as `as const satisfies Abi`). evs consumes
`AbiParameterToPrimitiveType`/`Address` from abitype (declared as a direct dependency
aligned with viem's `^1.x` range) so user `Register` config flows through. Single-output
unwrapping in `s.call` matches `ContractFunctionReturnType` exactly (`[] → void`,
`[one] → one`, else labeled tuple). TS floor: ≥ 5.0.4 strict (viem's floor); CI type tests
guard `TS2589` blowups and arg/return inference on representative scripts.

---

## 12. Decision 11 — module decomposition & parallel implementation plan

`packages/evs/src` (ESM, NodeNext, `.js` import specifiers; tsc emits js+d.ts+maps):

```
src/
  core/types.ts      L0  EvsAbiType/WordType, Expr brand, Operand/Literal, ArgSpec, t, arg()
  core/errors.ts     L0  error classes, SourceLocation, captureLoc()
  abi.ts             L1  TypeLayout, layoutOf, headBytes/isDynamic, ScriptAbi type, EVS_ERROR_ABI,
                         buildScriptAbi(ast): Abi (runtime)
  asm.ts             L1  OPCODES, AsmItem, assemble, disassemble, peephole, SourceMap
  ast.ts             L1  Stmt/AstOp/ScriptAst, serializeAst, walkStmts
  lir.ts             L2  LIR types, printLir, verifyLir, constFold, deadCode
  builder.ts         L2  evscript, ScriptBuilder impl, Cell/LoopCtl, recording + validation
  lower.ts           L3  lowerScript(ast: ScriptAst): LirProgram
  codegen.ts         L4  emitProgram(p: LirProgram, o: CodegenOptions): AsmItem[]
                         (slot plan, instruction selection, dispatcher, call/ABI emitters, tails)
  compile.ts         L5  compile(): passes pipeline + assemble + artifact, EIP-170 check
  viem.ts            L5  initBytecode wrapper, toViem shapes, DEFAULT_SCRIPT_ADDRESS
  index.ts           L6  public exports: evscript, arg, t, compile, types
test/harness/evm.ts      @ethereumjs/evm runner (below)
```

Dependency DAG (strict, enforced by `import/no-cycle`):
`core → {abi, asm, ast} → lir → {builder, lower} → codegen → {compile, viem} → index`.

**Inter-module contracts are exactly the signatures in §§2–11** — frozen in a day-0 commit
as type-only stubs (`export declare …` + TODO bodies) so agents code against real imports.

| Agent | Modules | Key unit tests |
|---|---|---|
| A1 | core/types, core/errors, abi | `layoutOf` golden table (every v0 type); headBytes/isDynamic; `buildScriptAbi` vs `ScriptAbi` type equality (expect-type); error class loc capture |
| A2 | asm + test/harness/evm | assemble→disassemble round-trip; fixup patching goldens; JUMPDEST audit catches a push-data 0x5B; peephole rule table; paris build rejects MCOPY; harness runs `RUNTIME_42` fixture from viem-integration Appendix A |
| A3 | ast, builder | recording snapshot (serializeAst) per builder op; staging-misuse throws (`x+1`, template literal); cross-script & cross-scope handle errors; literal range/format rejections; duplicate arg names; s.return-position rules |
| A4 | lir, lower | golden `printLir` snapshots for if/while/for/break/fn; verifyLir catches seeded malformed IR; constFold (incl. all-literal calldata collapse, certain-panic error); deadCode keeps calls/local.set |
| A5 | codegen | per-pattern bytecode goldens (checked ops, select, index, clean) **executed on the evm harness**; encoder/decoder differential-fuzz vs viem `encodeAbiParameters`/`decodeFunctionResult`; call pattern vs mock callee bytecode (success, revert-bubble, short/malformed returndata, tryCall defaults); stack-depth simulator assert |
| A6 | compile, viem, integration | end-to-end flagship script on anvil (both `toViem` modes — keep the deployless-path regression test per stack-testing.md anvil history); EIP-170 error; evmVersion matrix (cancun/shanghai/paris) on the harness with fork-pinned anvil; npm packaging checks (publint/attw) |

Schedule: A1+A2 have no internal deps (start immediately); A3+A4 start against stubs same
day; A5 needs A2's harness early (it lands day 1–2); A6 integrates continuously. The LIR
verifier + golden snapshots are the inter-agent contract tests.

**Test harness** (CLAUDE.md: `bun test`; unit tests in-process via `@ethereumjs/evm` v10,
integration via anvil spawned with `Bun.spawn` — stack-testing.md's vitest/prool setup is
noted but Bun's runner is this repo's convention):

```ts
// test/harness/evm.ts
import { test, expect } from 'bun:test'   // consumer side
export interface RunResult { success: boolean; returnData: Hex; gasUsed: bigint }
export async function runScript(opts: {
  runtime: Hex
  calldata: Hex
  mocks?: Record<Address, Hex>     // runtime bytecode planted at addresses (stubbed callees)
  gasLimit?: bigint                // default 30_000_000n (anvil parity)
}): Promise<RunResult>
// impl: new EVM(); for each mock: stateManager.putCode(addr, bytes)
//       evm.runCall({ to: SCRIPT, data, gasLimit }) with putCode(SCRIPT, runtime)

// example codegen test
test('checked add overflows → Panic(0x11)', async () => {
  const r = await runScript({ runtime, calldata: encodeArgs(MAX_U256, 1n) })
  expect(r.success).toBe(false)
  expect(r.returnData).toBe('0x4e487b71' + '11'.padStart(64, '0'))
})
```

---

## 13. Decision 12 — builder-time error strategy

Fail at the recording line, in user vocabulary, with source locations (PyTeal lesson).

```ts
// src/core/errors.ts
export class EvsError extends Error {            // TS-side base (distinct from on-chain EvsError(uint256))
  readonly loc?: SourceLocation
  readonly related?: readonly { message: string; loc?: SourceLocation }[]
}
export class EvsBuildError   extends EvsError {} // recording-time: structure/usage violations
export class EvsTypeError    extends EvsBuildError {} // operand type mismatch, literal range/format
export class EvsScopeError   extends EvsBuildError {} // handle used across scripts/fn scopes/after seal
export class EvsStagingError extends EvsError {} // host-language misuse (poisoned valueOf/toString)
export class EvsCompileError extends EvsError {} // compile(): recursion cycle, EIP-170, always-panic fold,
                                                 // unsupported type for evmVersion, verifier failures
export class EvsAssembleError extends EvsCompileError {} // fixup/JUMPDEST/fork-floor violations
export function captureLoc(skipFrames?: number): SourceLocation | undefined
```

Recording-time validation checklist (each throws with `loc`, plus `related` locs where two
sites are involved): arg-name duplicates/empty/invalid; literal out of range / wrong hex
length / non-integer number; operand type mismatch (incl. "no implicit widening — use
s.cast"); `abi` lacks `functionName` or it isn't view/pure; overloaded name; args
arity/type mismatch; handle from another script (names both) / another fn scope / used
after the script sealed; `s.return` not called, called twice, or called inside `if`/loop;
empty-string return keys; `LoopCtl.break` outside its loop; recursion at `fn` call
recording; unsupported AbiType (nested tuple in v0 — message says "deferred, wrap in a
separate call or flatten"). Compile-time additions: call-graph cycle re-check, frame/size
budgets, EIP-170, verifier failures (compiler-bug flavored message asking for a repro).

Error messages embed the decorated frame, e.g.
`EvsTypeError: s.add expects matching numeric types, got uint256 and int24 — at pools.ts:12:19 (use s.cast(x, t.uint256))`.

---

## 14. Decision 13 — research-flagged constraints (compliance checklist)

| Constraint (source) | Where handled |
|---|---|
| RETURNDATACOPY OOB = exceptional halt, all gas (evm-target §2) | only ever `(dest, 0, RETURNDATASIZE)`; all offset/len validation on copied memory (§7/§8) |
| JUMPDEST validity skips PUSH immediates; PUSH2 always sufficient under EIP-170 (evm-target §3) | assembler fixed-width PUSH2 fixups + post-assembly JUMPDEST audit (§9) |
| EIP-170 24,576-byte runtime cap; EIP-3860 init cap non-binding (evm-target §4) | `compile()` hard error with size breakdown (§10) |
| viem `code` = CREATION bytecode; runtime passed raw fails **silently** (viem-integration §1.3, test 2) | `toViem()` only ever exposes `initBytecode` under `code`; fields named `runtimeBytecode`/`initBytecode` (§10) |
| Init wrapper `61RRRR80600A5F395FF3`; paris variant with `3D` (evm-target §6) | `src/viem.ts`, selected by `evmVersion` |
| stateOverride undocumented on Alchemy/Infura → deployless default (viem-integration §4) | `toViem()` default mode (§10) |
| anvil deployless constructor-return history (stack-testing §3) | permanent integration test on the `code` path against pinned anvil |
| TSTORE/TLOAD halt in static context; scripts must stay STATICCALL-clean | never emitted; only STATICCALL is generated |
| eth_call gas caps: anvil 30M default, geth 50M floor (evm-target §4) | harness default 30M; docs note per-call ~2.6k cold + decode overhead budgeting |
| Stack limit 1024 / DUP-SWAP reach 16 | empty-stack invariant + simulated-depth ≤ 16 assert with forced spill (§5) |
| Panic encoding `0x4e487b71` + 36-byte payload; bubble pattern (evm-target §5) | shared tails (§10), bubble sequence verbatim (§7) |
| UnionToTuple order instability (abitype-typing §4.2) | inputs from ordered ArgSpec tuple; outputs single named tuple → object (§2) |
| Single-output unwrap / empty-name component degradation (abitype-typing §4.3) | builder rejects empty keys; `UnwrapSingle` mirrors viem (§7/§11) |
| abitype label lookup is finite/cosmetic (abitype-typing §1) | documented; types never depend on labels |
| viem ≥ 2.14.1 floor (viem-integration §1.2) | peerDependencies `"viem": ">=2.14.1"` |
| ABIs must be inline or `as const`; emitted ABI artifact must be TS, not JSON (prior-art §5) | `script.abi` is a literal-typed value; any codegen-to-file emits `.ts` with `as const` |
| EIP-2929 cold/warm (2600/100) on first call per address (evm-target §2) | documented in gas notes; no codegen impact |

---

## 15. Worked codegen examples

Conventions: frame at `0x80+`; comments show stack top-first; `@x` = PUSH2-fixup label;
`@sel(sig)` = 4-byte selector computed at compile time via `toFunctionSelector`.

### 15.A Checked ADD — `const c = s.add(a, b)`

`a` = arg in slot `0x80`, `b` = arg in slot `0xa0`, `c` multi-use → slot `0xc0`.
(overflow iff `r < b`; sequence from evm-target §5, verified there)

```
PUSH1 0xa0  MLOAD        ; [b]
PUSH1 0x80  MLOAD        ; [a, b]
DUP2                     ; [b, a, b]
ADD                      ; [r, b]          r = a+b (wrapping)
DUP1                     ; [r, r, b]
SWAP2                    ; [b, r, r]
GT                       ; [b>r, r]        overflow flag
PUSH2 @panic_0x11
JUMPI                    ; [r]
PUSH1 0xc0  MSTORE       ; []              c → slot
```

If `c` is single-use and consumed by the immediately-following instruction (fusion class,
§5), the final `MSTORE`/re-`MLOAD` pair disappears and `r` stays on the stack. Shared tail
(emitted once, stack garbage ignored — it reverts):

```
panic_0x11: JUMPDEST
  PUSH1 0x11
panic_common: JUMPDEST                      ; [code, …junk]
  PUSH4 0x4e487b71  PUSH1 0xE0  SHL         ; [selWord, code, …]
  PUSH0  MSTORE                             ; mem[0..32) = selector<<224
  PUSH1 0x04  MSTORE                        ; mem[4..36) = code
  PUSH1 0x24  PUSH0  REVERT                 ; revert(0, 36)
```

### 15.B STATICCALL to `symbol()` decoding a dynamic string

`const sym = s.call({ address: token, abi: erc20Abi, functionName: 'symbol' })`
`token` in slot `0x80`; result memref `sym` → slot `0xa0`. Calldata is all-literal after
folding (just the selector) → push-chunk path. Decode is **in place**: after copying the
whole returndata to fresh memory, the ABI tail `[len][data]` already *is* the evs string
layout, so the memref is a pointer into the copied buffer (zero extra copies).

```
; ---- build calldata at free ptr
PUSH1 0x40  MLOAD               ; [buf]
PUSH4 @sel(symbol())            ; 0x95d89b41
PUSH1 0xE0  SHL                 ; [selWord, buf]
DUP2  MSTORE                    ; [buf]            mem[buf..buf+32) = selector<<224
; ---- staticcall(gas, token, buf, 4, 0, 0)
PUSH0  PUSH0                    ; [0, 0, buf]      retSize, retOffset
PUSH1 0x04                      ; [4, 0, 0, buf]
DUP4                            ; [buf, 4, 0, 0, buf]
PUSH1 0x80  MLOAD               ; [token, buf, 4, 0, 0, buf]
GAS                             ; [gas, token, buf, 4, 0, 0, buf]
STATICCALL                      ; [ok, buf]
; ---- bubble callee revert verbatim
PUSH2 @ok1  JUMPI               ; [buf]
RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY
RETURNDATASIZE PUSH0 REVERT
ok1: JUMPDEST                   ; [buf]
; ---- copy whole returndata, then bounds-checked in-memory decode
RETURNDATASIZE                  ; [rds, buf]
DUP1  PUSH1 0x40  GT            ; [0x40>rds, rds, buf]    minimal: head(32)+len(32)
PUSH2 @err3  JUMPI              ; [rds, buf]              EvsError(3): too short
DUP1  PUSH0  DUP4               ; [buf, 0, rds, rds, buf]
RETURNDATACOPY                  ; [rds, buf]              mem[buf..buf+rds) = returndata
DUP2  ADD                       ; [end, buf]              end = buf+rds
DUP2  MLOAD                     ; [head, end, buf]        head = mload(buf)
DUP1  PUSH8 0xffffffffffffffff
LT                              ; [head>2^64-1, head, end, buf]
PUSH2 @err4  JUMPI              ; [head, end, buf]        EvsError(4): malformed
DUP3  ADD                       ; [base, end, buf]        base = buf+head (no overflow: head≤2^64)
DUP1  PUSH1 0x20  ADD           ; [base+32, base, end, buf]
DUP3  LT                        ; [end<base+32, base, end, buf]   len word must be readable
PUSH2 @err4  JUMPI              ; [base, end, buf]
DUP1  MLOAD                     ; [len, base, end, buf]
DUP1  PUSH8 0xffffffffffffffff
LT                              ; [len>2^64-1, len, base, end, buf]
PUSH2 @err4  JUMPI              ; [len, base, end, buf]
DUP2  ADD  PUSH1 0x20  ADD      ; [base+32+len, base, end, buf]
DUP3  LT                        ; [end<base+32+len, base, end, buf] data must fit
PUSH2 @err4  JUMPI              ; [base, end, buf]
; ---- bind memref + bump free pointer past the copied buffer
PUSH1 0xa0  MSTORE              ; [end, buf]              sym(slot 0xa0) = base
PUSH1 0x1f  ADD                 ; [end+31, buf]
PUSH1 0x1f  NOT  AND            ; [ceil32(end), buf]
PUSH1 0x40  MSTORE              ; [buf]                   mstore(0x40, ceil32(end))
POP                             ; []
```

`@err3`/`@err4` enter the shared `EvsError(uint256)` tail (same shape as `panic_common`
with `@sel(EvsError(uint256))`). For `tryCall`, the two `@errN` branches and the
`JUMPI @ok1` failure path instead jump to a join that binds `ok=0`, `sym=0x60` (zero slot ⇒
empty string) and skips decoding.

### 15.C While loop with an `s.let` counter

```ts
const total = s.let(t.uint256, 0n)
const i = s.let(t.uint256, 0n)
s.while(() => s.lt(i.get(), s.args.n), () => {
  total.set(s.add(total.get(), i.get()))
  i.set(s.add(i.get(), 1n))
})
return s.return({ total: total.get() })
```

Slots: `n` (arg) `0x80`, `total` `0xa0`, `i` `0xc0`. LIR blocks: entry → header ⇄ body → exit.

```
; entry: local inits
PUSH0  PUSH1 0xa0  MSTORE       ; total = 0
PUSH0  PUSH1 0xc0  MSTORE       ; i = 0
header: JUMPDEST
PUSH1 0x80  MLOAD               ; [n]
PUSH1 0xc0  MLOAD               ; [i, n]
LT                              ; [i<n]
ISZERO  PUSH2 @exit  JUMPI      ; exit when !(i<n); fallthrough = body (1 jump/iter)
; body: total = checked_add(total, i)
PUSH1 0xc0  MLOAD               ; [i]
PUSH1 0xa0  MLOAD               ; [total, i]
DUP2  ADD  DUP1  SWAP2  GT      ; [i>r, r]
PUSH2 @panic_0x11  JUMPI        ; [r]
PUSH1 0xa0  MSTORE              ; []        total = r
; i = checked_add(i, 1)
PUSH1 0x01                      ; [1]
PUSH1 0xc0  MLOAD               ; [i, 1]
DUP2  ADD  DUP1  SWAP2  GT      ; [1>r, r]  overflow iff r==0 ⇔ i was 2^256-1
PUSH2 @panic_0x11  JUMPI        ; [r]
PUSH1 0xc0  MSTORE              ; []        i = r
PUSH2 @header  JUMP
exit: JUMPDEST
; scriptReturn { total }: static 1-word tuple → inline
PUSH1 0x40  MLOAD               ; [out]
PUSH1 0xa0  MLOAD               ; [total, out]
DUP2  MSTORE                    ; [out]
PUSH1 0x20  SWAP1               ; [out, 0x20]
RETURN
```

Note the loop-condition thunk's ops (`i.get()`, `lt`) landed in `header` — re-executed each
iteration exactly because of the thunk design forced by value semantics (§3).

### 15.D Dispatcher prologue (flagship `poolMeta(address pool)`)

```
PUSH2 frameEnd  PUSH1 0x40  MSTORE        ; free ptr = 0x80 + frame size
PUSH1 0x04  CALLDATASIZE  LT              ; [cds<4]
PUSH2 @err1  JUMPI                        ; EvsError(1)
PUSH0  CALLDATALOAD  PUSH1 0xE0  SHR      ; [selector]
PUSH4 @sel(poolMeta(address))  EQ
PUSH2 @main  JUMPI
err1: JUMPDEST  PUSH1 0x01  PUSH2 @evserr_common  JUMP
main: JUMPDEST
PUSH1 0x04  CALLDATALOAD                  ; [argWord]
PUSH20 0xffffffffffffffffffffffffffffffffffffffff  AND   ; clean(address)
PUSH1 0x80  MSTORE                        ; pool → slot 0x80
; … body …
```

---

## 16. Risks & explicitly deferred work

- **Bytecode size** of the slot strategy: every slotted value costs ~9 bytes (load) / ~5
  (store) per touch vs pure stack code. Flagship-scale scripts land in the low hundreds of
  bytes — EIP-170 headroom is ~50×. Mitigation path exists (slot coalescing + scheduler as
  LIR passes), with the bound checked by an asserted size test on the flagship.
- **`if (expr)` host truthiness** is undetectable at runtime (JS limitation). Mitigations:
  docs front-page warning + recommended type-aware lint (§3). Residual risk accepted.
- **Deferred** (architecture slots noted): nested-tuple ABI generality (recursive
  TypeLayout already in place — remove builder guard, extend encoder tests); optimizer
  passes (LirPass pipeline); fn inlining; `s.scope` arena resets (needs escape analysis);
  overloaded-ABI disambiguation (`ExtractAbiFunctionForArgs` pattern documented); generator
  sugar (out of v0 by decision); a JS IR interpreter as a second backend / differential
  oracle (shader-ast lesson — cheap once LIR is stable, not committed for v0).
- **Single tail `s.return`** (no early returns) is a v0 ergonomic restriction; lifting it
  is a lowering-only change (extra exit block), no IR redesign.
