# Proposal C — "types-and-debuggability-first"

Design angle: start from the user's TypeScript experience and work inward. The two products of
this library are (1) the *types* the user sees in their editor — at authoring time inside the
builder callback and at consumption time through `readContract` — and (2) the *explanations* the
user gets when something goes wrong: at recording time (exact source line), at compile time
(actionable resource errors), and at execution time (revert data that maps back to a source
location). The compiler internals (IR, memory model, codegen) are deliberately boring and
uniform so that those two products are achievable; gas optimality is explicitly *not* a v0 goal
(eth_call headroom is 30–550M gas; a naive script burns a few hundred thousand).

Inheritances from research that this proposal treats as fixed facts (citations are to the
research reports in `docs/research/`):

- viem `code` = creation bytecode; raw runtime passed as `code` fails **silently** (viem-integration §1.3, test 2).
- `stateOverride` takes runtime bytecode; array-of-objects shape; deployless is the portable default (viem-integration §2–3).
- Record→tuple type derivation is order-unstable (abitype-typing §4.2) — reproduced, not theoretical.
- Single named-tuple output → object inference, all components must be non-empty-named (abitype-typing §4.3).
- PyTeal post-mortem: expression-template re-emission + host-language truthiness = silent wrongness (prior-art §2).
- shader-ast: serializable plain-data IR, string-literal type params, second JS-interpreter target (prior-art §3).
- Opcode/semantics table, Panic encodings, checked-op sequences, init wrapper bytes (evm-target §2, §5, §6).

---

## 0. The user experience we are designing backwards from

```ts
import { evscript, arg } from '@maxencerb/evs'
import { erc20Abi } from 'viem'
import { uniswapV3PoolAbi } from './abis'   // as const satisfies Abi

const poolMeta = evscript(
  { name: 'poolMeta', args: [arg('pool', 'address')] },
  (s) => {
    const token0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token0' })
    //    ^? Expr<'address'>
    const slot0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' })
    //    ^? readonly [Expr<'uint160'>, Expr<'int24'>, ...]
    const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' })
    //    ^? Expr<'string'>
    const dec = s.tryCall({ address: token0, abi: erc20Abi, functionName: 'decimals' })
    //    ^? { success: Expr<'bool'>; value: Expr<'uint8'> }
    const decimals0 = s.select(dec.success, dec.value, 18)
    return s.return({ token0, symbol0, tick: slot0[1], decimals0 })
  },
)

const compiled = poolMeta.compile()                  // CompiledEvsScript
const out = await client.readContract({
  ...compiled.toViem(),                              // { abi, code } — deployless, portable
  functionName: 'poolMeta',
  args: [pool],                                      // readonly [pool: `0x${string}`]
})
// out: { token0: `0x${string}`; symbol0: string; tick: number; decimals0: number }
```

Debuggability artifacts, all first-class on the compiled object:

```ts
compiled.disassemble().format()   // annotated mnemonics with source lines per instruction
compiled.sourceMap                // PC→loc JSON, plus a "site" table for revert decoding
compiled.explainRevert(data)      // Panic(0x11) → "checked add overflowed — recorded at pools.ts:12:30"
poolMeta.ir                       // frozen, JSON-serializable, snapshot-testable
```

Everything below exists to make this surface real.

---

## 1. Args declaration API + ABI inputs strategy — **option (c), ordered arg declarators**

### Decision

```ts
evscript({ name: 'quote', args: [arg('pool', 'address'), arg('fee', 'uint24')] }, (s) => { ... })
```

- `args` is a **readonly tuple of `ArgSpec` objects**, so declaration order, type-level order,
  runtime encode order, and the emitted ABI `inputs` order are all the *same* tuple. The
  UnionToTuple hazard (abitype-typing §4.2) never arises because we never convert a record key
  union to a tuple on the input side.
- `s.args` is derived **tuple→record**, which is order-safe (object types are unordered):
  `s.args.pool: Expr<'address'>`, `s.args.fee: Expr<'uint24'>`.
- Consumers call the script positionally like any other contract:
  `args: [pool, fee]`, typed by viem as `readonly [pool: \`0x${string}\`, fee: number]`
  (labels via abitype's lookup where the name is known; type always preserved).

### Why not (a) or (b)

- (a) single named-tuple input is order-immune but makes every consumer call site
  `args: [{ pool, fee }]` — an evs-ism that breaks "this is just a viem contract". It also
  reintroduces the record API at the authoring site, which is exactly where we'd have to
  defend against key-order divergence between type level and runtime if we ever derive
  positional anything from it. We keep it in reserve: if a script someday wants >10 args,
  a named-tuple input is an additive feature, not a redesign.
- (b) entries-tuples `[['pool','address']]` are order-safe too, but `arg()` wins on
  diagnostics (a constructor can validate the name/type eagerly with a source location),
  on discoverability (autocomplete on `arg(`), and on future extension
  (`arg('fee','uint24').optional(default)` style modifiers have a place to live).

### Exact signatures

```ts
// src/core/types.ts
export type UintBits = 8 | 16 | 24 | 32 | 40 | 48 | /* …every multiple of 8… */ | 248 | 256
export type BytesSize = 1 | 2 | 3 | /* … */ | 31 | 32
export type UintType = `uint${UintBits}`
export type IntType = `int${UintBits}`
export type BytesNType = `bytes${BytesSize}`
export type WordType = UintType | IntType | 'address' | 'bool' | BytesNType
export type DynType = 'string' | 'bytes'
export type ArrayType = `${WordType}[]` | `${WordType}[${number}]`
export type EvsType = WordType | DynType | ArrayType

/** Types decodable as top-level script args in v0 (word types only; see §7). */
export type ArgType = WordType

// src/builder/args.ts
export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name
  readonly type: type
}
export function arg<const name extends string, const type extends ArgType>(
  name: name,
  type: type,
): ArgSpec<name, type>
// runtime: validates `name` is a non-empty identifier and `type` is a known ArgType,
// throws EvsTypeError with captured loc otherwise; returns Object.freeze({ name, type }).

// tuple→record derivation (order-safe direction)
export type ArgExprs<specs extends readonly ArgSpec[]> = {
  readonly [spec in specs[number] as spec['name']]: Expr<spec['type']>
}
// ABI inputs are the specs verbatim (each ArgSpec *is* an AbiParameter)
export type ArgsToAbiInputs<specs extends readonly ArgSpec[]> = {
  readonly [i in keyof specs]: { readonly name: specs[i]['name']; readonly type: specs[i]['type'] }
}
```

Runtime checks at `evscript()` entry: duplicate arg names → `EvsTypeError` (loc = `evscript`
call site); empty `args: []` is fine (ABI inputs `[]`).

### Output side (settled, restated for completeness)

One output, `{ name: 'result', type: 'tuple', components: [...] }`, every component named from
the `s.return({...})` record keys (empty-string keys rejected at recording time — abitype
degrades the whole object to a positional array if any name is empty, abitype-typing §4.3 item
4). The type-level component order may differ from runtime insertion order (UnionToTuple
instability); this is *harmless by construction* because consumers receive an object keyed by
names, and the runtime decoder uses the runtime ABI array. A CI type-test pins
`ReadContractReturnType<abi,'name'>` for representative scripts.

---

## 2. Expr semantics — **VALUE semantics** (record-once, execute-once)

### Decision

Every `s.*` operation and every `Expr` method **executes exactly once, at the place it is
written**, appending one or more statements to the *current recording block*. The returned
`Expr<t>` is a handle to that single computed value (an SSA-ish `ValueId`). Re-using the handle
later does not recompute anything; codegen reads the value's memory slot.

This is the direct answer to the PyTeal post-mortem: expression-template semantics (trees
re-emitted per use) mean a `s.call` handle used twice performs the STATICCALL twice, and host
control flow over handles silently reorders or duplicates effects. With value semantics, the
recorded statement list *is* the program; what you read top-to-bottom is what executes.

Consequences and the API they force:

**Mutable state is explicit cells.** Handles are immutable snapshots; loops need a mutable
binding:

```ts
export interface Cell<t extends EvsType> {
  get(): Expr<t>                       // records a 'cell.get' stmt → fresh snapshot value
  set(value: IntoExpr<t>): void        // records a 'cell.set' stmt
  readonly type: t
}
// on ScriptBuilder:
let<const t extends EvsType>(type: t, init: IntoExpr<t>): Cell<t>
let<t extends EvsType>(init: Expr<t>): Cell<t>     // type inferred from an existing Expr
```

**Loop conditions are recorded into the loop header.** Since recording happens where code runs,
the condition of a `while` must be re-recorded per iteration — so it is a *callback* whose
statements land in a dedicated header block that codegen re-executes every iteration:

```ts
while(cond: () => IntoExpr<'bool'>, body: () => void): void
// recording: push header scope → invoke cond() → capture its Expr → pop;
//            push body scope → invoke body() → pop.

if(cond: IntoExpr<'bool'>, then: () => void, otherwise?: () => void): void
// note: `cond` here is a plain value — it is evaluated once, before the branch, like any value.

for<const t extends WordType>(
  range: { type: t; from: IntoExpr<t>; until: IntoExpr<t>; step?: IntoExpr<t> },
  body: (i: Expr<t>) => void,
): void
// pure sugar: const i = s.let(type, from); s.while(() => i.get().lt(until), () => { body(i.get()); i.set(i.get().add(step ?? 1)) })
// `until` and `step` are snapshot once before the loop (document this).

select<t extends EvsType>(cond: IntoExpr<'bool'>, a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
// EAGER on both sides (value semantics!): a and b are already-computed values.
// Use s.if + a Cell when one side must not execute. Documented loudly; the doc page
// "what runs when" is the AssemblyScript-lesson page (prior-art §4, §6.14).
```

**Scope rule (dominance-lite).** A value recorded inside an `if`/`while` body is only usable
while that scope is still open; using it after the block closes throws `EvsScopeError` at
recording time ("value `t12` was recorded inside the if-branch at pools.ts:14 and is not
available at pools.ts:19 — store it in a `s.let` cell declared outside the branch"). Cells
declared in an outer scope are the sanctioned way to move data out of branches/loops. This rule
is what makes the memory-slot model sound without a real dominance analysis.

**Host-language misuse explodes immediately** (decision 12 has the error classes): handles
implement `valueOf`, `Symbol.toPrimitive`, `toString`, `toJSON` as throwing `EvsStagingError`
with the *handle's* recorded loc and the *misuse* loc; `if (expr)` can't be caught at runtime
(truthiness of an object is `true`) — but every API that should have received the result of a
comparison takes `IntoExpr<'bool'>`, so the type system rejects raw JS booleans where a staged
bool is required and vice versa. Node's `util.inspect.custom` is implemented NON-throwing:
`console.log(token0)` prints `Expr<address> #4 ← s.call(token0) at pools.ts:9:18` — printing is
debugging, not misuse.

### Rich Expr surface (the ergonomics half of this angle)

Methods, not operators (operators can't be overloaded; methods carry types):

```ts
declare const exprBrand: unique symbol
export interface Expr<t extends EvsType = EvsType> {
  readonly [exprBrand]: t            // nominal brand; covariant (Expr<'uint256'> <: Expr<EvsType>)
  readonly type: t                   // runtime-readable type tag

  // arithmetic — only callable when t is numeric (this-parameter typing)
  add(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>     // checked, Panic(0x11)
  sub(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>
  mul(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>
  div(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>     // Panic(0x12) on 0
  mod(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>

  // comparisons — opcode chosen from the static type (LT vs SLT): a types-first win
  lt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>
  gt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>
  lte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>
  gte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>
  eq(rhs: IntoExpr<t>): Expr<'bool'>          // word types only in v0 (memref eq deferred)
  neq(rhs: IntoExpr<t>): Expr<'bool'>

  // bool logic (canonical 0/1 words) — eager, not short-circuiting (document!)
  and(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>
  or(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>
  not(this: Expr<'bool'>): Expr<'bool'>

  // bitwise on uintN / bytesN (result masked back to t's canonical form)
  bitAnd(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>
  bitOr(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>
  bitXor(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>
  bitNot(this: Expr<t & BitsType>): Expr<t>
  shl(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>
  shr(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>

  // conversions — explicit, checked where narrowing (Panic 0x11 style on out-of-range)
  toUint<const u extends UintType>(target: u): Expr<u>
  toInt<const i extends IntType>(target: i): Expr<i>
  asAddress(this: Expr<'uint256' | 'bytes32'>): Expr<'address'>   // checked high-bits-zero (uint256 path)

  // dynamic / array values (memrefs)
  length(this: Expr<DynType | ArrayType>): Expr<'uint256'>
  at<elem extends WordType>(this: Expr<`${elem}[]` | `${elem}[${number}]`>, i: IntoExpr<'uint256'>): Expr<elem>
  // bounds-checked, Panic(0x32)
}

export type NumericType = UintType | IntType
export type BitsType = UintType | BytesNType | 'bool'
```

Free-function mirrors on the builder (`s.add(a, b)` etc.) exist for symmetry and for the cases
where the left operand is a literal: `s.add(1n, x)`. At least one operand of every op must be an
`Expr` (otherwise compute it in JS).

### Literal coercion (`IntoExpr`)

```ts
export type LitOf<t extends EvsType> =
  t extends NumericType ? bigint | number :
  t extends 'address' ? `0x${string}` :
  t extends 'bool' ? boolean :
  t extends BytesNType ? `0x${string}` :
  t extends 'string' ? string :
  t extends 'bytes' ? `0x${string}` :
  never
export type IntoExpr<t extends EvsType> = Expr<t> | LitOf<t>
```

Coercion is **validated at recording time with the call-site loc**: `uint8` literal `300` →
`EvsTypeError: 300 does not fit uint8 (max 255) — at pools.ts:11:27`; `number` literals must be
safe integers; addresses must be 20-byte hex (checksum not enforced, mirroring viem); `bytesN`
literals must be exactly N bytes. Dynamic literals (`string`/`bytes`/host arrays via
`s.lit('uint256[]', [1n,2n])`) become constant **data segments** in the bytecode, materialized
to memory by CODECOPY on first use. Explicit constructor for when inference needs help:
`s.lit<const t extends EvsType>(type: t, value: LitOf<t>): Expr<t>`.

---

## 3. IR design — structured statement tree over a flat value table, plain JSON

### Shape

Two id spaces, both dense integers: `ValueId` (every computed value) and `CellId` (every
`s.let`). The program is a **structured tree** (not an arbitrary CFG): the builder can only
produce structured control flow, so the IR keeps `if`/`while` as nested statement lists. This
is the shader-ast lesson applied: the IR is *the* interchange format — serializable, versioned,
diffable in snapshots, interpretable in JS, and printable in error messages.

```ts
// src/ir/nodes.ts — everything here is JSON-safe plain data (bigints serialized as 0x-strings)
export type ValueId = number
export type CellId = number
export type FnId = number
export type SiteId = number          // stable id for revert-site mapping (sourceMap.sites)

export interface SourceLoc { file: string; line: number; column: number }

export interface ScriptIr {
  readonly irVersion: 1
  readonly name: string
  readonly args: readonly { name: string; type: ArgType }[]
  readonly values: readonly ValueInfo[]          // indexed by ValueId
  readonly cells: readonly CellInfo[]            // indexed by CellId
  readonly fns: readonly FnIr[]                  // indexed by FnId, topologically recorded
  readonly body: readonly Stmt[]
  readonly returns: readonly { name: string; type: EvsType; value: ValueId }[]
  readonly loc: SourceLoc | null
}

export interface ValueInfo {
  readonly type: EvsType
  readonly loc: SourceLoc | null
  readonly debugName?: string         // 'arg:pool', 'call:symbol#2', for disassembly comments
}
export interface CellInfo { readonly type: EvsType; readonly loc: SourceLoc | null; readonly debugName?: string }

export interface FnIr {
  readonly name: string
  readonly params: readonly { name: string; type: EvsType; value: ValueId }[]
  readonly results: readonly { type: EvsType }[]
  readonly body: readonly Stmt[]
  readonly resultValues: readonly ValueId[]      // values returned by the body callback
  readonly loc: SourceLoc | null
}

export type BinOp =
  | 'add' | 'sub' | 'mul' | 'div' | 'mod'                       // checked per type
  | 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'neq'                  // signedness from operand type
  | 'and' | 'or' | 'bitand' | 'bitor' | 'bitxor' | 'shl' | 'shr'
export type UnOp = 'not' | 'bitnot' | 'iszero'
export type EnvOp = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid' | 'gasleft'

export type Stmt = { readonly loc: SourceLoc | null; readonly site: SiteId } & (
  | { k: 'const'; out: ValueId; data: ConstData }                       // literal (word or data-segment ref)
  | { k: 'bin'; op: BinOp; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'un'; op: UnOp; a: ValueId; out: ValueId }
  | { k: 'env'; op: EnvOp; out: ValueId }
  | { k: 'convert'; a: ValueId; out: ValueId }                          // checked narrowing/widening
  | { k: 'select'; cond: ValueId; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'index'; arr: ValueId; i: ValueId; out: ValueId }              // bounds-checked, Panic(0x32)
  | { k: 'len'; a: ValueId; out: ValueId }
  | { k: 'cell.new'; cell: CellId; init: ValueId }
  | { k: 'cell.get'; cell: CellId; out: ValueId }
  | { k: 'cell.set'; cell: CellId; value: ValueId }
  | { k: 'call'; target: ValueId; fnAbi: PlainAbiFunction; args: readonly ValueId[];
      outs: readonly ValueId[]; mode: 'strict' | 'try'; successOut?: ValueId }
  | { k: 'fncall'; fn: FnId; args: readonly ValueId[]; outs: readonly ValueId[] }
  | { k: 'if'; cond: ValueId; then: readonly Stmt[]; else: readonly Stmt[] }
  | { k: 'while'; header: readonly Stmt[]; cond: ValueId; body: readonly Stmt[] }
)
export type ConstData =
  | { kind: 'word'; hex: `0x${string}` }                                // canonical 32-byte value
  | { kind: 'data'; hex: `0x${string}` }                                // pre-encoded memref payload [len|elems…]
export interface PlainAbiFunction {                                     // the *runtime* abi item, de-genericized
  readonly name: string; readonly selector: `0x${string}`
  readonly inputs: readonly PlainAbiParam[]; readonly outputs: readonly PlainAbiParam[]
}
export interface PlainAbiParam { readonly name: string; readonly type: string; readonly components?: readonly PlainAbiParam[] }
```

Notes:

- **Why not basic blocks?** A CFG buys nothing until there's an optimizer; the structured tree
  is smaller, trivially serializable, trivially interpretable, and codegen for structured
  constructs is a local pattern (loop header label / exit label). When the deferred optimizer
  arrives, lowering tree→CFG is a self-contained pass; the public IR stays the tree.
- **Operands are always `ValueId`s** — literals are `const` statements (deduplicated per
  script by `(type, hex)`), so "constant-fold this operand" is a codegen-side decision, not an
  IR shape.
- **`site: SiteId`** on every statement: the link into the sourceMap's site table; also the id
  embedded in `EvsDecodeError(uint256 site)` reverts and (debug mode) `EvsPanic(code, site)`.
- **Loc capture**: every builder API entry calls `captureLoc()` which stores the raw
  `new Error().stack` string and parses it lazily (first frame outside `@maxencerb/evs`).
  ~1–3µs per node at script scale; disable with `evscript(def, body, { locations: false })`.
- **Validation** (`src/ir/validate.ts`): re-checks everything the builder enforces (types of
  operands per op, def-before-use respecting the scope rule, cell types, single trailing
  return) so that *deserialized* IR is as trustworthy as recorded IR. `compile()` always
  validates first.
- **Branding of handles** (builder-side, not IR): `ExprHandle` is a class carrying
  `{ owner: RecorderInternals, id: ValueId, type }` in private fields plus the throwing
  `valueOf`/`Symbol.toPrimitive`/`toString`/`toJSON` and the friendly `inspect.custom`. The
  public `Expr<t>` interface exposes only the brand, `type`, and methods — the handle is
  useless outside its owning recorder, and a foreign-handle check (`owner !== this`) throws
  `EvsScopeError` naming **both** scripts.

---

## 4. Memory model — Solidity layout, static frame slots for all values, bump allocator for dynamics

### Layout

| Range | Use |
|---|---|
| `0x00–0x3f` | scratch (panic payload assembly, short-lived temporaries inside one lowering pattern) |
| `0x40–0x5f` | free-memory pointer |
| `0x60–0x7f` | zero slot — never written; the canonical empty `string`/`bytes`/array memref (tryCall failure values point here) |
| `0x80 … frameEnd` | **static frame**: one 32-byte slot per arg, per cell, per multi-use value, per fn param/result (see §5) |
| `frameEnd …` | bump-allocated dynamic data: sub-call returndata copies, dynamic literals, the output tuple |

Prologue (first bytes of the runtime): `PUSH2 frameEnd PUSH1 0x40 MSTORE` (frameEnd computed at
compile time; PUSH2 because frames can exceed 255 bytes).

### Locals strategy: memory slots, not stack scheduling

Every IR value (except folded constants) is assigned a **static frame slot at compile time**;
every `bin`/`un`/`call`/… statement loads operands (`PUSH slot MLOAD` or `PUSH const`),
computes, and stores the result (`PUSH slot MSTORE`). No slot reuse, no liveness, no stack
scheduling in v0.

Why: (1) the EvmScript prior-art shows stack scheduling is a search problem (A* over DUP/SWAP) —
all cost, no user-visible benefit at eth_call gas budgets; (2) uniform slot codegen makes the
disassembly *legible* — every value has an address, the disassembler annotates
`MLOAD ; t7 symbol0`, and the PC→loc map is dense and honest; (3) weiroll's liveness-based slot
reuse is the proven *later* optimization, and it slots in as a frame-allocator change without
touching lowering. Cost bound: a script with 200 values uses 6.4KB of frame → memory expansion
≈ a few hundred gas (quadratic term starts mattering ~23KB; evm-target §4).

Canonical forms in slots: `uintN` zero-extended, `intN` sign-extended, `bool` ∈ {0,1}, `bytesN`
left-aligned (high bytes), `address` zero-extended 160-bit — i.e. exactly the word you'd MSTORE
for ABI encoding. Dynamic values' slots hold a **pointer** to a Solidity-shape memory object
`[len:32][payload…]` (arrays: `[len:32][elem0:32]…`; fixed arrays `T[N]`: pointer to `N`
contiguous words, length static).

### Dynamic allocation discipline

- Allocation = `ptr := MLOAD(0x40); MSTORE(0x40, ptr + ceil32(size))`. Never freed.
- **Transient scratch above the free pointer**: sub-call calldata buffers are written at
  `MLOAD(0x40)` *without* bumping — they are dead the instant the call returns, and the
  returndata copy then allocates (and bumps) over the same region. One consequence handled in
  §7: memory above the free pointer is **not** guaranteed zero, so the ABI encoder zero-pads
  dynamic tails explicitly instead of relying on fresh-zero memory.
- **Loops + allocation**: allocations inside a loop body grow memory monotonically per
  iteration (e.g. a `s.call` per iteration). This is correct and bounded by the quadratic
  memory cost; `compile()` emits a *warning diagnostic* (not an error) when a `call` or dynamic
  literal materialization appears inside a `while` body: "allocates each iteration; N
  iterations × M bytes ≈ … memory" — debuggability over silent gas surprises. (A
  region-reset optimization — restore the free pointer at loop top when no allocation escapes —
  is deferred; noted as an IR-level legal transform since escape is decidable from the scope
  rule.)

---

## 5. User-defined functions — recorded once, compiled as JUMPDEST subroutines, no recursion

### API

```ts
// on ScriptBuilder — mirrors shader-ast defn: returns a value that is also callable
fn<const params extends readonly FnParam[], const r extends FnReturn>(
  name: string,
  params: params,
  body: (...args: FnParamExprs<params>) => r,
): EvsFn<params, r>

export interface FnParam<name extends string = string, type extends EvsType = EvsType> {
  readonly name: name; readonly type: type
}
// reuses arg(); fn params may be any EvsType (incl. memrefs — passed as pointer words)
export type FnReturn = Expr | readonly Expr[] | void
export type FnParamExprs<params extends readonly FnParam[]> = {
  [i in keyof params]: Expr<params[i]['type']>
}
export type EvsFn<params extends readonly FnParam[], r extends FnReturn> =
  (...args: { [i in keyof params]: IntoExpr<params[i]['type']> }) => RebuildExprs<r>
// RebuildExprs<Expr<'uint256'>> = Expr<'uint256'>; tuple → fresh tuple of Exprs; void → void
```

The body callback runs **once, immediately**, inside an isolated recording scope whose only
in-scope values are the param placeholders (outer values/cells are *not* capturable —
`EvsScopeError` on touch; this keeps fns pure functions of their params and makes the frame
story trivial). Calling the returned `EvsFn` records a `fncall` stmt with fresh output values.

**Recursion: impossible by construction in v0.** A fn can only call `EvsFn` handles that
already exist, and the handle doesn't exist inside its own body. (Mutual recursion is likewise
unconstructible.) `ir/validate.ts` still asserts call-graph acyclicity for deserialized IR.

### Codegen: subroutine, frame-slot calling convention

Inline expansion was rejected: subroutines keep code size linear in source size (EIP-170 is the
binding limit) and give the disassembler real function boundaries (`@fn_sumFees:` labels) — both
debuggability wins. Convention:

- Each fn gets a static frame region (param slots, result slots, local value slots) appended
  after the main frame. Safe because there is no recursion and no re-entrancy.
- Call site: store evaluated args into the callee's param slots → `PUSH2 @ret_k` →
  `PUSH2 @fn_entry JUMP` → `@ret_k: JUMPDEST` → copy callee result slots into the caller's
  output value slots.
- Callee: `@fn_entry: JUMPDEST`, body, store results to result slots, `JUMP` (consumes the
  return address that has sat untouched at the bottom of its stack region — codegen guarantees
  net-zero stack effect for every statement, so the return address is on top at the epilogue).

---

## 6. Call codegen — calldata templates, STATICCALL, copy-then-decode, bubbling, tryCall

### `s.call` / `s.tryCall` signatures (the viem-mirror surface)

```ts
type ViewMutability = 'pure' | 'view'
export interface SubcallParams<
  abi extends Abi,
  name extends ExtractAbiFunctionNames<abi, ViewMutability>,
  fn extends AbiFunction = ExtractAbiFunction<abi, name, ViewMutability>,
> {
  readonly address: IntoExpr<'address'>
  readonly abi: abi
  readonly functionName: name | ExtractAbiFunctionNames<abi, ViewMutability>   // keeps autocomplete alive
  readonly args?: SubcallInputs<fn['inputs']>
  readonly gas?: IntoExpr<'uint256'>          // optional cap; default: forward all (gas())
}
export type SubcallInputs<params extends readonly AbiParameter[]> = {
  readonly [i in keyof params]:
    | AbiParameterToPrimitiveType<params[i], 'inputs'>          // literal — folded at compile time
    | Expr<params[i]['type'] extends EvsType ? params[i]['type'] : never>
}
export type SubcallOutputs<params extends readonly AbiParameter[]> = {
  readonly [i in keyof params]: Expr<params[i]['type'] extends EvsType ? params[i]['type'] : never>
}
type UnwrapSingle<outs> = outs extends readonly [] ? void : outs extends readonly [infer one] ? one : outs

// on ScriptBuilder:
call<const abi extends Abi, name extends ExtractAbiFunctionNames<abi, ViewMutability>>(
  p: SubcallParams<abi, name>,
): UnwrapSingle<SubcallOutputs<ExtractAbiFunction<abi, name, ViewMutability>['outputs']>>

tryCall<const abi extends Abi, name extends ExtractAbiFunctionNames<abi, ViewMutability>>(
  p: SubcallParams<abi, name>,
): {
  readonly success: Expr<'bool'>
  readonly value: UnwrapSingle<SubcallOutputs<ExtractAbiFunction<abi, name, ViewMutability>['outputs']>>
}
```

Recording-time runtime checks: function exists in the runtime abi, is view/pure, is not
overloaded (v0 rejects overloaded names with a loc'd error; viem's `ExtractAbiFunctionForArgs`
pattern is the documented future fix), arg count matches, each literal arg validates against
its ABI type. Selector computed at compile time with viem's `toFunctionSelector` (viem is a
peer dependency of the *compiler*, which runs in TS — no keccak reimplementation).

Output types not representable in v0 (`tuple` outputs, nested arrays) are a **recording-time**
`EvsTypeError` ("`slot0` returns a tuple component of type `tuple` — not supported in evs v0"),
not a compile-time surprise.

### Calldata building: segment templates with compile-time constant folding

For each `call` stmt the compiler builds a `CalldataTemplate`:

```ts
// src/codegen/call.ts (internal)
interface CalldataTemplate {
  size: number                                  // static size in v0 (dyn args contribute head+tail of known-at-runtime size — see below)
  segments: readonly (
    | { kind: 'const'; offset: number; bytes: Uint8Array }     // selector + all literal args, pre-encoded & merged
    | { kind: 'word'; offset: number; value: ValueId }         // runtime word arg → MSTORE
    | { kind: 'dyn'; headOffset: number; value: ValueId }      // runtime string/bytes arg → head offset + tail copy
  )[]
}
```

- All-literal calls collapse to a single `const` segment — the entire calldata is precomputed
  bytes (selector via `toFunctionSelector`, args via viem `encodeAbiParameters`), emitted as
  PUSH32-chunked MSTOREs when ≤ 96 bytes, else as a data segment + CODECOPY.
- Mixed calls: const segments written first, then `MSTORE` per runtime word at its offset.
  Runtime `string`/`bytes` args make total size dynamic: heads are patched and tails MCOPY'd
  from the memref; size tracked in a stack temp. (v0 supports word + `bytes`/`string` runtime
  args; runtime *array* args are recording-time-rejected, literal array args fold to const.)
- Buffer location: transient scratch at `MLOAD(0x40)`, not bumped (§4).

### The call itself + revert bubbling (strict mode)

`STATICCALL(gas, addr, buf, argsSize, 0, 0)` with `retOffset/retSize = 0` — we *always* fetch
returndata via RETURNDATACOPY afterwards (uniform, and immune to the "expected size" guessing
game for dynamic outputs). On `success == 0`, bubble verbatim (works for `Error(string)`,
`Panic`, custom errors — evm-target §5):

```
RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY     ; mem[0..rds) = revert payload (safe: size==rds)
RETURNDATASIZE PUSH0 REVERT
```

### Returndata decoding (strict + try share the decoder; only the failure target differs)

1. Copy **everything**: `RETURNDATACOPY(dst, 0, RETURNDATASIZE)` — by construction never OOB
   (the only OOB-halting op in our output is used exclusively with `size = RETURNDATASIZE`,
   a compiler invariant; evm-target's "exceptional halt consuming all gas" hazard is thereby
   structurally impossible).
2. Allocate: `dst = MLOAD(0x40)`, bump by `ceil32(rds)`.
3. Static outputs: `out_i = MLOAD(dst + headOffset_i)` after checking `rds >= headSize`,
   then per-type cleanup-check (same table as §7 dispatch decode: address high bits, bool ∈
   {0,1}, uintN range, intN signextend-fixpoint, bytesN low bits) — fail → decode-fail target.
4. Dynamic outputs decode **in place, aliasing the copy** (no second copy): validate
   `off ≤ 2^64`, `off + 32 ≤ rds`, `len ≤ 2^64`, `off + 32 + len ≤ rds`; the value's memref is
   `dst + off`. The 2^64 guards prevent wraparound games in the bounds arithmetic (same guard
   solc emits). Arrays of words: additionally `off + 32 + 32·len ≤ rds`; elements are
   cleanup-checked lazily at `.at()` time, not eagerly (cost ∝ use).
5. Decode-fail target:
   - strict mode → per-site stub `@dfail_<site>: JUMPDEST PUSH2 site PUSH2 @decode_revert JUMP`;
     shared tail reverts with `EvsDecodeError(uint256 site)` (selector compile-time-computed;
     the error is included in the generated ABI so viem names it, and
     `explainRevert`/sourceMap.sites maps `site` → "decoding `symbol()` returndata recorded at
     pools.ts:9:18").
   - try mode → jump to the call's `@zero_<site>` block: `successOut = 0`, every word output
     `= 0`, every dynamic/array output's slot = `0x60` (the zero slot — a valid empty memref).
     A failed STATICCALL takes the same block. So `tryCall.success` is false on *either*
     call failure or malformed returndata — the typed contract of `value` ("zero values, safe
     to use") holds unconditionally.

Worked example (the exact emitted sequence for `symbol()` → dynamic string) is in §14.2.

---

## 7. ABI encode/decode codegen — recursive head/tail walker, v0-limited, generality-ready

One internal module owns both directions, parameterized over `PlainAbiParam` trees so that
nested tuples later are a *capability* unlock, not a rewrite:

```ts
// src/codegen/abi.ts
export interface AbiCodegen {
  /** dispatch-time: decode top-level word args from calldata into frame slots */
  emitCalldataDecode(asm: AsmBuilder, args: readonly { type: ArgType; slot: number }[]): void
  /** returndata: copy + validate + bind outputs (used by call.ts; see §6) */
  emitReturndataDecode(asm: AsmBuilder, outs: readonly { param: PlainAbiParam; slot: number }[], failTarget: LabelId): void
  /** terminal RETURN: encode the single named tuple from frame slots at the free pointer */
  emitReturnEncode(asm: AsmBuilder, components: readonly { param: PlainAbiParam; slot: number }[]): void
}
```

### Dispatch-time arg decode

`require(CALLDATASIZE >= 4 + 32·n)` else empty revert; then per arg `CALLDATALOAD(4 + 32·i)` +
cleanup check + `MSTORE slot`. Cleanup checks (solc-compatible, revert(0,0) on dirty input —
matching what every Solidity caller expects):

| type | check |
|---|---|
| `address` | `raw == raw & (2^160−1)` |
| `bool` | `raw < 2` |
| `uintN<256` | `raw ≤ 2^N−1` |
| `intN<256` | `SIGNEXTEND(N/8−1, raw) == raw` |
| `bytesN<32` | `raw & (2^(256−8N)−1) == 0` |
| `uint256`/`int256`/`bytes32` | none |

v0 restricts *script args* to word types (decision 1); the decoder interface above already
takes `PlainAbiParam`, so dynamic args later reuse `emitReturndataDecode`'s bounds-checked
walker pointed at calldata.

### Return encoding (single named tuple, dynamic members supported)

Standard two-pass head/tail per tuple level, emitted as straight-line code from the compile-time
walk of the component tree (offsets of static heads are compile-time constants; dynamic tail
offsets are tracked in one running stack/frame temp):

1. `out = MLOAD(0x40)`; `MSTORE(out, 0x20)` — top-level head: offset to the tuple (the tuple is
   dynamic iff any component is; if all components are static the wrapper offset word is
   omitted and components are encoded inline — both shapes decoded identically by viem).
2. Heads at `base = out + 0x20`: word components stored verbatim (slots are already canonical);
   dynamic components get their tail offset (relative to `base`) written when the tail is laid.
3. Tails in component order: `string`/`bytes`: `MSTORE(tail, len)`, `MCOPY(tail+32, ptr+32, len)`
   (pre-Cancun: shared `@memcpy` word-loop subroutine), then **explicit zero-pad**
   `MSTORE(tail+32+len, 0)` — required because memrefs may alias returndata copies whose
   word-padding can contain neighbors' bytes, and because transient scratch reuse (§4) breaks
   the fresh-memory-is-zero assumption. Word arrays: `MSTORE(tail, len)` + `MCOPY` of
   `32·len` (elements are canonical words already).
4. `RETURN(out, total)`.

The walker recurses on `components` — nested tuples are cut off by a v0 capability check at
recording time, not by the encoder's structure.

---

## 8. Assembler — typed nodes, label fixups, verification passes, disassembler + sourceMap as products

```ts
// src/asm/ops.ts
export type EvmVersion = 'paris' | 'shanghai' | 'cancun'
export interface OpInfo { readonly code: number; readonly pops: number; readonly pushes: number; readonly since: EvmVersion | 'frontier' }
export const OPS: Readonly<Record<Mnemonic, OpInfo>>     // exactly the evm-target §2 table
export type Mnemonic = 'STOP' | 'ADD' | /* … */ | 'PUSH0' | /* … */ | 'STATICCALL' | 'REVERT' | 'INVALID'

// src/asm/assembler.ts
export type LabelId = number
export type AsmNode =
  | { k: 'op'; op: Mnemonic; loc?: SourceLoc | null; note?: string }
  | { k: 'push'; bytes: Uint8Array; loc?: SourceLoc | null; note?: string }   // emits PUSH<len>; len 0 allowed → PUSH0 (lowered on paris)
  | { k: 'pushLabel'; label: LabelId; loc?: SourceLoc | null; note?: string } // ALWAYS PUSH2 — never narrowed (offsets < 2^16 by EIP-170/3860)
  | { k: 'label'; label: LabelId; name?: string; stackHeight?: number }       // emits JUMPDEST iff jump-targeted
  | { k: 'dataLabel'; label: LabelId; name?: string }                         // no JUMPDEST; for CODECOPY sources
  | { k: 'data'; bytes: Uint8Array; note?: string }

export interface AssembleOptions {
  evmVersion: EvmVersion                       // PUSH0 → PUSH1 00 lowering on 'paris' happens HERE
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]   // runs before layout; v0 ships identity + a store/load-fusion sample
  verify?: boolean                             // default true
}
export interface AssembleResult {
  bytecode: Uint8Array
  sourceMap: SourceMap
  labelPcs: ReadonlyMap<LabelId, number>
}
export function assemble(nodes: readonly AsmNode[], opts: AssembleOptions): AssembleResult
```

Mechanics (per evm-target §3):

- Two-pass: emit with `PUSH2 0x0000` placeholders recording `{ patchOffset, label }`; after
  layout, patch big-endian offsets. Data segments are placed after the terminal code (behind an
  unconditional terminator), so they can never be fallen into.
- **Verification passes** (assertion failures are `EvsInternalError` — they indicate compiler
  bugs, and they say so):
  1. JUMPDEST scan exactly as consensus does (skip PUSH immediates); assert every patched
     target is a JUMPDEST *opcode*, every `dataLabel` is never jump-targeted.
  2. Stack-height simulation: linear walk using `OPS[op].pops/pushes`, joining at labels via
     the optional `stackHeight` annotations codegen attaches (loop headers, fn entries);
     mismatch or underflow → error naming the label and the originating loc. Cheap, and it has
     caught every classic assembler bug class before any EVM runs.
  3. Opcode gating: any `op` with `since` newer than `opts.evmVersion` → `EvsCompileError`
     ("MCOPY requires cancun; compile with evmVersion:'cancun' or let codegen lower it") —
     codegen is responsible for not emitting MCOPY pre-cancun (it calls the shared `@memcpy`
     subroutine instead); the gate is the backstop.

```ts
// src/asm/sourcemap.ts
export interface SourceMap {
  readonly version: 1
  readonly segments: readonly { pc: number; len: number; loc: SourceLoc | null; note?: string }[]  // sorted, non-overlapping
  readonly sites: readonly { id: SiteId; kind: 'panic' | 'decode' | 'call' | 'stmt'; loc: SourceLoc | null; detail: string }[]
  readonly labels: readonly { pc: number; name: string }[]
}
export function lookupPc(map: SourceMap, pc: number): { loc: SourceLoc | null; note?: string } | undefined

// src/asm/disasm.ts — independent of the assembler (consumes raw bytecode), so it doubles as
// a cross-check: disassemble(assemble(x)) round-trips in property tests.
export interface DisasmLine {
  pc: number; raw: `0x${string}`; mnemonic: string
  pushValue?: `0x${string}`; targetLabel?: string; label?: string
  loc?: SourceLoc | null; note?: string
}
export interface Disassembly { readonly lines: readonly DisasmLine[]; format(opts?: { locs?: boolean }): string }
export function disassemble(bytecode: `0x${string}` | Uint8Array, sourceMap?: SourceMap): Disassembly
```

`format()` output style (this is a *product*, prior-art lesson 7):

```
0x004a  @main:           JUMPDEST
0x004b                   PUSH1 0x04
0x004d                   CALLDATALOAD                ; arg pool — poolMeta.ts:3:31
0x004e                   DUP1 …                      ; cleanup-check address
0x0061                   PUSH1 0x80  MSTORE          ; slot[0x80] = pool
```

---

## 9. Dispatcher + compile() artifact

### Runtime program shape

```
prologue:   PUSH2 frameEnd PUSH1 0x40 MSTORE
dispatch:   PUSH1 0x04 CALLDATASIZE LT PUSH2 @fallback JUMPI
            PUSH0 CALLDATALOAD PUSH1 0xE0 SHR
            PUSH4 <selector> EQ PUSH2 @main JUMPI
@fallback:  JUMPDEST PUSH0 PUSH0 REVERT
@main:      JUMPDEST
            <calldata arg decode (§7) into frame slots>
            <body statements>
            <return encode (§7)>  RETURN
@fn_*:      <user fn subroutines (§5)>
@memcpy:    <shared word-loop, only if evmVersion < cancun AND any copy emitted>
@panic_*:   <shared panic tails (§14.1)>
@dfail_*:   <per-site decode stubs> @decode_revert: <shared tail>
@zero_*:    <tryCall zeroing blocks>
<data segments (dynamic literals, long constant calldatas)>
```

Selector = `toFunctionSelector` of the generated function signature, where the single tuple
output does not affect the selector (selectors hash inputs only): `poolMeta(address)`.

### Compile API + artifact (exact)

```ts
// src/compile.ts
export interface CompileOptions {
  evmVersion?: EvmVersion          // default 'cancun'; 'shanghai' drops MCOPY; 'paris' also drops PUSH0
  debug?: boolean                  // default false; true → panics revert EvsPanic(uint256 code, uint256 site)
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]
  locations?: boolean              // default true (carried from recording; false strips locs from sourceMap)
}

export interface EvsScript<
  name extends string = string,
  args extends readonly ArgSpec[] = readonly ArgSpec[],
  ret extends Record<string, Expr> = Record<string, Expr>,
> {
  readonly name: name
  readonly ir: ScriptIr                            // frozen, serializable
  readonly abi: ScriptAbi<name, args, ret>         // literal-typed AND the runtime value
  compile(options?: CompileOptions): CompiledEvsScript<name, args, ret>
}

export interface CompiledEvsScript<name extends string, args extends readonly ArgSpec[], ret extends Record<string, Expr>> {
  readonly abi: ScriptAbi<name, args, ret>
  readonly runtimeBytecode: `0x${string}`          // ≤ 24,576 bytes, enforced
  readonly initBytecode: `0x${string}`             // 61 RRRR 80 600A 5F 39 5F F3 ++ runtime (paris: 5F→3D)
  readonly sourceMap: SourceMap
  readonly ir: ScriptIr
  readonly options: Readonly<Required<CompileOptions>>
  toViem(): { readonly abi: ScriptAbi<name, args, ret>; readonly code: `0x${string}` }
  toViem(opts: { mode: 'stateOverride'; address?: Address }): {
    readonly abi: ScriptAbi<name, args, ret>
    readonly address: Address
    readonly stateOverride: readonly [{ readonly address: Address; readonly code: `0x${string}` }]
  }
  disassemble(): Disassembly
  explainRevert(data: `0x${string}`): RevertExplanation
}

export interface RevertExplanation {
  kind: 'panic' | 'evs-panic' | 'evs-decode' | 'error-string' | 'custom' | 'empty'
  message: string                   // "arithmetic overflow (Panic 0x11) in checked add — recorded at pools.ts:12:30"
  panicCode?: bigint
  site?: { id: SiteId; loc: SourceLoc | null; detail: string }
  raw: `0x${string}`
}
```

- `toViem()` (no args) = **deployless**, the portable default; returns `code: initBytecode` —
  the field named `code` is *only ever* creation bytecode, and there is deliberately no
  `bytecode` field on the artifact (the §1.3 silent-failure footgun is fenced by naming:
  `runtimeBytecode` / `initBytecode` / `code`). `DEFAULT_SCRIPT_ADDRESS =
  0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530` for override mode (viem-integration §5.1).
- The generated ABI includes the function **plus error declarations** so viem decodes our
  reverts by name: `EvsDecodeError(uint256 site)` always, `EvsPanic(uint256 code, uint256 site)`
  always declared (only *emitted* in debug mode) — declaring both keeps `ScriptAbi`'s literal
  type independent of `CompileOptions`. Standard `Panic(uint256)`/`Error(string)` need no ABI
  entries (viem built-ins).
- `compile()` enforcement: EIP-170 (`runtimeBytecode ≤ 24,576` → `EvsCompileError` with a
  per-region size breakdown: body / fns / panic tails / data segments), EIP-3860 implied
  (init = runtime + 10 ≪ 49,152), and emits the loop-allocation warnings (§4) on a
  `diagnostics` channel (`compile()` returns them on the artifact? No — they are delivered via
  an optional `onDiagnostic` callback in `CompileOptions` to keep the artifact shape pure;
  default logs nothing).

---

## 10. Type-level architecture

### Phantom flow

`Expr<t>` carries the abitype string literal as a covariant phantom (unique-symbol brand,
abitype-typing §4.6). Sources of typed `Expr`s: `s.args` (from the `ArgSpec` tuple), `s.call`
outputs (from `ExtractAbiFunction<abi, name>['outputs']` mapped through `SubcallOutputs`),
`s.lit`, cell `.get()`, and op methods (which propagate `t` or produce `'bool'`). All generic
plumbing uses `const` type parameters so inline ABIs and inline arg tuples need no `as const`
(abitype-typing §4.1); standalone ABIs documented as `as const satisfies Abi`.

### Literal ABI construction (runtime + type level agree by construction)

The working prototype from abitype-typing §3 is adopted with the args side replaced by the
order-safe tuple mapping from decision 1:

```ts
// src/abi/artifact.ts
type ReturnSpecToComponents<ret extends Record<string, Expr>,
  keys extends readonly unknown[] = UnionToTuple<keyof ret>> = {
  readonly [i in keyof keys]: {
    readonly name: keys[i] & string
    readonly type: ret[keys[i] & keyof ret] extends Expr<infer t> ? t : never
  }
}
export type ScriptAbi<
  name extends string,
  args extends readonly ArgSpec[],
  ret extends Record<string, Expr>,
> = readonly [
  {
    readonly type: 'function'
    readonly name: name
    readonly stateMutability: 'view'
    readonly inputs: ArgsToAbiInputs<args>
    readonly outputs: readonly [{
      readonly name: 'result'
      readonly type: 'tuple'
      readonly components: ReturnSpecToComponents<ret>
    }]
  },
  { readonly type: 'error'; readonly name: 'EvsDecodeError'
    readonly inputs: readonly [{ readonly name: 'site'; readonly type: 'uint256' }] },
  { readonly type: 'error'; readonly name: 'EvsPanic'
    readonly inputs: readonly [
      { readonly name: 'code'; readonly type: 'uint256' },
      { readonly name: 'site'; readonly type: 'uint256' },
    ] },
]
export function buildScriptAbi(name: string, args: readonly ArgSpec[],
  returns: readonly { name: string; type: EvsType }[]): Abi   // runtime mirror; component order = Object.keys insertion order
```

`ReturnSpecToComponents` uses `UnionToTuple` — order-unstable, **accepted**: outputs are an
object after viem inference, so type-level component order is invisible to users; the runtime
decoder uses the runtime array (insertion-ordered, ECMA-262-guaranteed for string keys). This
asymmetry (inputs: order-safe tuple; outputs: order-irrelevant record) is the whole point of
decision 1 + the settled output decision.

### Coercion + permissiveness rules mirrored from viem

- `LitOf` consumes abitype's Register-resolved primitives where possible: the implementation of
  `LitOf<'address'>` is `Address` (= `ResolvedRegister['addressType']`) and numeric literal
  acceptance is `bigint | number` regardless of the Register's `intType` split — *inputs* are
  permissive, *outputs* are exact (viem's `Widen` philosophy, abitype-typing §2 pattern 4).
- Graceful widening: every generic boundary follows `abi extends Abi ? (Abi extends abi ?
  permissive : inferred) : permissive`; a non-const ABI passed to `s.call` degrades to
  `functionName: string`, `args: readonly unknown[]`, output `Expr<EvsType>` — never a hard
  error (pattern 1). `[x] extends [never]` guards after every `Extract` (pattern 2).
- `functionName: name | ExtractAbiFunctionNames<…>` union keeps IDE autocomplete before `name`
  is fixed (pattern from §2).
- TS floor: `>= 5.5` (isolatedDeclarations-era; viem requires ≥5.0.4), `strict` mode documented
  as required. CI type-tests via vitest `expectTypeOf` pin: `ScriptAbi` literal shape,
  `ReadContractParameters<abi,'poolMeta'>['args']`, `ReadContractReturnType`, and the §4.2
  regression (an arg name that collides with a string literal interned earlier in the file).

---

## 11. Module decomposition — contracts first, six parallel work streams

```
packages/evs/src/
  core/types.ts        core/errors.ts        core/loc.ts
  ir/nodes.ts          ir/validate.ts        ir/interp.ts
  abi/artifact.ts
  builder/args.ts      builder/expr.ts       builder/script.ts
  asm/ops.ts           asm/assembler.ts      asm/disasm.ts        asm/sourcemap.ts
  codegen/frame.ts     codegen/lower.ts      codegen/call.ts      codegen/abi.ts      codegen/program.ts
  compile.ts           viem.ts               index.ts
test/
  harness/evm.ts       harness/clients.ts    (+ fixtures, integration specs)
```

### Inter-module interfaces (the parallel-work contract)

Already specified above: `core/types.ts` (§1), `core/errors.ts` (§12), `ir/nodes.ts` +
`ir/validate.ts` (§3), `abi/artifact.ts` (§10), builder surface (§§1,2,6), `asm/*` (§8),
`codegen/abi.ts` (§7), `compile.ts` artifact (§9). The remaining three:

```ts
// core/loc.ts
export function captureLoc(): SourceLoc | null            // lazy stack parse; null when disabled/unparseable

// ir/interp.ts — the shader-ast-js move: a reference interpreter over the IR
export interface MockChain {
  staticcall(req: { to: `0x${string}`; data: `0x${string}` }): { success: boolean; data: `0x${string}` }
}
export interface InterpResult {
  outcome:
    | { kind: 'return'; values: Record<string, unknown> }                      // JS-native: bigint/string/boolean/Hex/arrays
    | { kind: 'revert'; data: `0x${string}`; explanation: RevertExplanation }
  trace?: readonly { stmtPath: readonly number[]; loc: SourceLoc | null; note: string }[]   // opt-in step log
}
export function interpret(ir: ScriptIr, args: readonly unknown[], chain: MockChain,
  opts?: { trace?: boolean; maxSteps?: number }): InterpResult

// codegen/program.ts — the single codegen entry point compile.ts consumes
export interface LowerResult { nodes: readonly AsmNode[]; frameEnd: number }
export function lowerProgram(ir: ScriptIr, opts: Readonly<Required<CompileOptions>>): LowerResult

// codegen/frame.ts
export interface FrameLayout {
  slotOfValue(v: ValueId): number | null      // null = folded constant
  slotOfCell(c: CellId): number
  fnRegion(f: FnId): { params: readonly number[]; results: readonly number[] }
  frameEnd: number
}
export function layoutFrames(ir: ScriptIr): FrameLayout

// test/harness/evm.ts — @ethereumjs/evm in-process runner (unit-test tier)
export interface EvmFixture { contracts?: Record<`0x${string}`, `0x${string}`>; evmVersion?: EvmVersion }
export async function execRuntime(runtime: `0x${string}`, calldata: `0x${string}`, fixture?: EvmFixture):
  Promise<{ success: boolean; data: `0x${string}`; gasUsed: bigint }>
```

### Dependency order & the six streams

```
core ─┬─→ ir ────┬─→ builder
      ├─→ abi    ├─→ interp
      └─→ asm    └─→ codegen ─→ compile/viem ─→ integration
```

| Stream | Modules | Depends on | Unit tests |
|---|---|---|---|
| **A: core + abi** | core/*, abi/artifact | — | exhaustive `EvsType` validation table; `buildScriptAbi` runtime↔type agreement via `expectTypeOf` + `satisfies Abi`; loc capture under bun/node stack formats |
| **B: IR + interp** | ir/* | core | validate accepts/rejects hand-built IRs (each Stmt kind, scope violations, type mismatches); interp golden tests over hand-built IRs with a scripted MockChain incl. revert/decode-fail paths; JSON round-trip `deserialize(serialize(ir))` deep-equals |
| **C: builder** | builder/* | core, ir (nodes only) | records expected IR snapshots for every API; every `EvsTypeError`/`EvsScopeError`/`EvsStagingError` trigger has a test asserting message + loc; type-level tests (`expectTypeOf` on `s.call` inference, `@ts-expect-error` on nonpayable fns / wrong arg types) |
| **D: asm** | asm/* | core | assemble→disassemble round-trip property tests (incl. `0x5B` inside PUSH data); label patching; stack-height verifier catches seeded bugs; paris PUSH0-lowering; hand-assembled fixtures executed on `execRuntime` (e.g. RUNTIME_42 from viem-integration App. A) |
| **E: codegen** | codegen/* | ir, asm, abi | per-pattern: lower a one-stmt IR, run on `execRuntime`, assert returndata AND disassembly snapshot AND sourceMap segments; checked-op matrix (boundary values for every width, signed cases incl. `int256 min / −1`); decode bounds fuzz (malformed returndata → EvsDecodeError, never OOB halt); pre-cancun memcpy path |
| **F: compile + viem + harness** | compile.ts, viem.ts, test/harness/*, integration | all | artifact shape; EIP-170 enforcement (synthetic huge script); `toViem()` spreads typecheck into `readContract` (tsd); **differential suite**: for each example script, `interpret(ir, …)` vs `execRuntime(compiled, …)` agree; anvil (prool, viem's `VITEST_POOL_ID` pattern, stack-testing §3) integration: both modes, mainnet-fork WETH `symbol()`, deployless-constructor-return regression (foundry #4549), revert bubbling end-to-end through viem error decoding |

Streams A–D start immediately (A is a day of work and unblocks the rest); C and E both code
against `ir/nodes.ts` as the contract; B's interpreter is E/F's oracle. `bun test` runs in tier
order; integration via vitest + prool per stack-testing.md (the repo's CLAUDE.md `bun test`
default applies to unit tiers; the anvil tier uses `bun run test:integration` → vitest,
per the stack report's "bun test ≠ vitest" pitfall).

---

## 12. Builder-time error strategy

```ts
// src/core/errors.ts
export type EvsErrorCode =
  | 'STAGING_MISUSE' | 'TYPE_MISMATCH' | 'LITERAL_RANGE' | 'SCOPE_VIOLATION'
  | 'FOREIGN_HANDLE' | 'RECORDING_CLOSED' | 'UNSUPPORTED_V0' | 'ABI_SHAPE'
  | 'COMPILE_LIMIT' | 'EVM_VERSION' | 'INTERNAL'

export class EvsError extends Error {
  readonly code: EvsErrorCode
  readonly loc: SourceLoc | null            // where the offending API call happened
  readonly relatedLocs: readonly { label: string; loc: SourceLoc | null }[]  // e.g. where the value was recorded
}
export class EvsStagingError extends EvsError {}   // valueOf/toPrimitive/template-literal on a handle
export class EvsTypeError extends EvsError {}      // op/arg type mismatch, literal range, empty return key, overloaded fn name
export class EvsScopeError extends EvsError {}     // foreign handle, use-after-scope-close, use-after-return, capture in s.fn
export class EvsCompileError extends EvsError {}   // EIP-170, evmVersion gating, unsupported-for-target
export class EvsInternalError extends EvsError {}  // verifier failures: "this is a bug in evs, please report" + IR snapshot hint
```

Principles:

1. **Fail at the line that's wrong.** Every builder API validates its inputs eagerly (types,
   ranges, ABI membership, scope) before recording; the thrown error's `loc` is the user's call
   site, and `relatedLocs` carries the definitions involved ("value recorded at …", "cell
   declared at …", "other script defined at …" for foreign handles — prior-art lesson 1/2).
2. **Errors speak user vocabulary**: "`s.call` arg 2 (`owner`) expects `address`, got
   `Expr<'uint256'>` (the result of `balanceOf` at pools.ts:11)" — never IR node ids alone.
3. **Recording lifecycle is enforced**: `s.return` closes the recorder; any later `s.*`/method →
   `EvsScopeError(RECORDING_CLOSED)`; a body callback that returns without `s.return` (or
   returns a foreign `ScriptReturn`) → `EvsTypeError` at `evscript` loc; `s.return` called
   inside `if`/`while` scope → `EvsScopeError` ("return must be unconditional in v0").
4. **v0 capability boundaries are recording-time errors** with the future spelled out
   ("nested tuple outputs are planned; flatten with multiple calls for now").
5. **Compiler invariant violations** (stack verifier, JUMPDEST verifier, frame overlap) are
   `EvsInternalError` — explicitly labeled as our bug, with `script.ir` dump instructions,
   because a types-first library must never gaslight users into debugging the compiler.

---

## 13. Research-flagged constraints and how the design answers them

| Constraint (source) | Answer in this design |
|---|---|
| `code` must be creation bytecode; raw runtime fails silently (viem-integration §1.3) | artifact exposes `runtimeBytecode`/`initBytecode`; `toViem()` only ever puts `initBytecode` under `code`; integration test asserts deployless 42-fixture works and a deliberately-raw-runtime call returns empty (regression canary) |
| RETURNDATACOPY OOB = exceptional halt, all gas (evm-target §2) | compiler invariant: RETURNDATACOPY only with `size = RETURNDATASIZE`, offset 0 (§6); all offset/len validation happens on the *copy* in memory with 2^64 + bounds guards |
| JUMPDEST validity / PUSH-immediate scanning (evm-target §3) | PUSH2-only label patching; post-assembly consensus-identical scan + target assertion (§8) |
| EIP-170 24,576 / EIP-3860 (evm-target §4) | `EvsCompileError(COMPILE_LIMIT)` with per-region size breakdown; subroutines (not inlining) keep size linear (§5) |
| eth_call gas caps: anvil 30M default, geth 50M (evm-target §4) | test harness pins `--gas-limit 100000000`; docs state 50M production floor; naive codegen ≈ thousands of gas per call — no realistic script approaches it |
| warm/cold access 2600/100 (evm-target §2) | no action; repeated calls to one address are warm automatically |
| `TSTORE` halts in static context (evm-target §1) | never emitted; no transient-storage feature in the surface |
| UnionToTuple order instability (abitype-typing §4.2) | inputs are an ordered ArgSpec tuple (decision 1); outputs are an order-irrelevant named-tuple object; CI type-test reproduces the §4.2 scenario |
| any unnamed tuple component degrades object→array (abitype-typing §4.3) | empty-string return keys rejected at recording time |
| abitype `int/uintN≤48 → number` (abitype-typing §3) | documented; `LitOf` accepts `bigint|number` for all numerics; outputs follow Register |
| single abitype copy needed for Register augmentation (abitype-typing §4.4) | evs declares `abitype` matching viem's range; consumes `Address`/`AbiParameterToPrimitiveType` rather than hardcoding |
| viem types are patch-version-volatile (abitype-typing intro) | CI pins exact viem patch for type tests |
| PyTeal: silent host-language misuse, late sourcemaps (prior-art §2) | value semantics + throwing brands + loc on every node + sourceMap/disassembler/explainRevert from day one |
| weiroll: untyped handles, "must record" footgun (prior-art §1) | recording *is* the only way to get a handle; foreign-handle/closed-recorder errors |
| anvil deployless constructor-return history (stack-testing §3) | dedicated integration test on pinned anvil for the `code` path; `stateOverride` + `anvil_setCode` as primary tested paths |
| stateOverride doesn't clear target storage (viem-integration §3.1) | `DEFAULT_SCRIPT_ADDRESS` vanity constant; scripts never SLOAD |
| Fusaka tx gas cap 2^24 doesn't bind eth_call (evm-target §1) | noted in docs as a *reason* the eth_call model matters; no design impact |
| TS 6 `tsc file.ts` TS5112 (abitype-typing) | CI scripts use project configs / `--ignoreConfig` |
| ESM-only, tsc-emitted d.ts, `bun test` vs vitest split (stack-testing §2,5) | adopted as-is; no bundler in the loop |

---

## 14. Worked codegen examples (exact emitted sequences)

Conventions: stack comments list **top first**; `slot[X]` is frame memory; binary operands are
pushed right-then-left so the **left operand is on top** (matches EVM `SUB`/`DIV`/`LT`
top-first semantics).

### 14.0 Shared panic tails (emitted once, default mode)

```
@panic_overflow: JUMPDEST  PUSH1 0x11  PUSH2 @panic  JUMP
@panic_divzero:  JUMPDEST  PUSH1 0x12  PUSH2 @panic  JUMP
@panic_bounds:   JUMPDEST  PUSH1 0x32  PUSH2 @panic  JUMP
@panic:          JUMPDEST                  ; [code]
  PUSH4 0x4e487b71  PUSH1 0xE0  SHL        ; [selWord, code]
  PUSH0  MSTORE                            ; mem[0x00..0x20) = selector word   [code]
  PUSH1 0x04  MSTORE                       ; mem[0x04..0x24) = code            []
  PUSH1 0x24  PUSH0  REVERT                ; revert Panic(code), 36 bytes
```

(Stack garbage below `code` is irrelevant — REVERT ends the frame. Debug mode replaces the
three entry stubs with per-site stubs `PUSH2 site PUSH1 code PUSH2 @evs_panic JUMP` reverting
`EvsPanic(code, site)`, 68-byte payload.)

### 14.1 Checked ADD — `const c = a.add(b)` (uint256; a→slot 0x80, b→slot 0xA0, c→slot 0xC0)

```
PUSH1 0xA0  MLOAD          ; [b]                       — right operand first
PUSH1 0x80  MLOAD          ; [a, b]
DUP2                       ; [b, a, b]
ADD                        ; [r, b]        r = a+b (wrapping)
DUP1                       ; [r, r, b]
SWAP2                      ; [b, r, r]
GT                         ; [b>r, r]      overflow ⇔ r < b
PUSH2 @panic_overflow
JUMPI                      ; [r]
PUSH1 0xC0  MSTORE         ; slot[0xC0] = r            []
```

10 instructions, net stack 0 — the per-statement invariant the assembler's height verifier
checks. For `uintN<256` the overflow check is instead `r ≤ maxN`:
`PUSH<k> maxN DUP2 GT PUSH2 @panic_overflow JUMPI` after the ADD (result stays canonical
because both inputs were canonical and the check bounds `r`). Signed `intN`: solc-style
sign-aware checks (for `intN<256`: `SIGNEXTEND(N/8−1, r) == r` fixpoint test; `int256`
add/sub/mul use the solc Yul `checked_*_t_int256` formulas; SDIV adds the
`a == −2^255 && b == −1` → Panic(0x11) case; evm-target §5).

### 14.2 STATICCALL `symbol()` decoding a dynamic string

`const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' })`
token0 → slot 0x80; symbol0 (memref ptr) → slot 0xA0; site id 7.

```
; -- build calldata (all-literal → one const segment: 4 bytes) -------------------
PUSH1 0x40  MLOAD          ; [buf]            transient scratch, free ptr NOT bumped
PUSH4 0x95d89b41  PUSH1 0xE0  SHL             ; [selWord, buf]
DUP2  MSTORE               ; [buf]            mem[buf..buf+32) = selector ++ zeros

; -- staticcall(gas(), token0, buf, 4, 0, 0) -------------------------------------
PUSH0  PUSH0               ; [retSize=0, retOff=0, buf]
PUSH1 0x04                 ; [argsSize, retOff, retSize, buf]
DUP4                       ; [argsOff=buf, …, buf]
PUSH1 0x80  MLOAD          ; [token0, argsOff, argsSize, retOff, retSize, buf]
GAS                        ; [gas, token0, …]
STATICCALL                 ; [success, buf]
PUSH2 @ok_7  JUMPI         ; [buf]

; -- failure: bubble callee revert data verbatim ---------------------------------
RETURNDATASIZE  PUSH0  PUSH0  RETURNDATACOPY  ; mem[0..rds) = payload   (size==rds ⇒ never OOB)
RETURNDATASIZE  PUSH0  REVERT

@ok_7: JUMPDEST            ; [buf]
; -- copy ALL returndata to a real allocation (dst = buf, now bumped) ------------
RETURNDATASIZE  PUSH0  DUP3  RETURNDATACOPY   ; [buf]   mem[buf..buf+rds) = returndata
RETURNDATASIZE  PUSH1 0x1F  ADD
PUSH1 0x1F  NOT  AND       ; [ceil32(rds), buf]
DUP2  ADD  PUSH1 0x40  MSTORE                 ; [buf]   freePtr = buf + ceil32(rds)

; -- decode string at output index 0: head, then bounds-checked tail -------------
DUP1  MLOAD                ; [off, buf]
PUSH8 0xffffffffffffffff  DUP2  GT            ; [off > 2^64−1, off, buf]
PUSH2 @dfail_7  JUMPI      ; [off, buf]
DUP1  PUSH1 0x20  ADD      ; [off+32, off, buf]
RETURNDATASIZE  LT         ; [rds < off+32, off, buf]
PUSH2 @dfail_7  JUMPI      ; [off, buf]
DUP2  ADD                  ; [ptr=buf+off, buf]
DUP1  MLOAD                ; [len, ptr, buf]
PUSH8 0xffffffffffffffff  DUP2  GT  PUSH2 @dfail_7  JUMPI    ; [len, ptr, buf]
DUP2  PUSH1 0x20  ADD  ADD ; [end=ptr+32+len, ptr, buf]
RETURNDATASIZE  DUP4  ADD  ; [buf+rds, end, ptr, buf]
LT                         ; [buf+rds < end, ptr, buf]
PUSH2 @dfail_7  JUMPI      ; [ptr, buf]
PUSH1 0xA0  MSTORE         ; slot[0xA0] = ptr          [buf]
POP                        ; []

; -- elsewhere in the program --------------------------------------------------
@dfail_7:       JUMPDEST  PUSH1 0x07  PUSH2 @decode_revert  JUMP
@decode_revert: JUMPDEST                   ; [site]
  PUSH4 <sel(EvsDecodeError(uint256))>  PUSH1 0xE0  SHL  PUSH0  MSTORE
  PUSH1 0x04  MSTORE  PUSH1 0x24  PUSH0  REVERT
```

The decoded string **aliases the returndata copy** — no second copy; the memref `[len|bytes]`
at `ptr` is immutable for the rest of the program. `tryCall` variant: the two failure targets
(`JUMPI` after STATICCALL inverted; `@dfail_7`) both go to `@zero_7:` which sets
`slot[success]=0`, `slot[0xA0]=0x60` (zero slot ⇒ empty string) and falls through; the success
path sets `slot[success]=1`.

### 14.3 While loop with `s.let` counter — sum 0..n−1

```ts
const total = s.let('uint256', 0n)
const i = s.let('uint256', 0n)
s.while(() => i.get().lt(s.args.n), () => {
  total.set(total.get().add(i.get()))
  i.set(i.get().add(1n))
})
```

Frame: `n`→0x80, cell `total`→0xA0, cell `i`→0xC0; values `v1`(i.get)→0xE0, `v2`(lt)→0x100,
`v3`(total.get)→0x120, `v4`(i.get)→0x140, `v5`(add)→0x160, `v6`(i.get)→0x180, `v7`(add)→0x1A0.
(Constants 0 and 1 are folded — no slots.)

```
; cell.new total = 0 ; cell.new i = 0
PUSH0  PUSH1 0xA0  MSTORE
PUSH0  PUSH1 0xC0  MSTORE

@while_1: JUMPDEST                      ; loop header — re-executes the recorded cond stmts
  PUSH1 0xC0 MLOAD  PUSH1 0xE0 MSTORE   ; v1 = i
  PUSH1 0x80 MLOAD                      ; [n]            right operand
  PUSH1 0xE0 MLOAD                      ; [v1, n]        left on top
  LT                                    ; [v1 < n]
  PUSH1 0x100 MSTORE                    ; v2 = cond
  PUSH1 0x100 MLOAD  ISZERO
  PUSH2 @endwhile_1  JUMPI

  ; body: total.set(total.get().add(i.get()))
  PUSH1 0xA0 MLOAD  PUSH1 0x120 MSTORE  ; v3 = total
  PUSH1 0xC0 MLOAD  PUSH1 0x140 MSTORE  ; v4 = i
  PUSH1 0x140 MLOAD                     ; [b=v4]
  PUSH1 0x120 MLOAD                     ; [a=v3, b]
  DUP2 ADD DUP1 SWAP2 GT                ; [b>r, r]       checked add (§14.1)
  PUSH2 @panic_overflow JUMPI           ; [r]
  PUSH1 0x160 MSTORE                    ; v5 = r
  PUSH1 0x160 MLOAD  PUSH1 0xA0 MSTORE  ; total = v5

  ; i.set(i.get().add(1))
  PUSH1 0xC0 MLOAD  PUSH1 0x180 MSTORE  ; v6 = i
  PUSH1 0x01                            ; [b=1]          folded constant
  PUSH1 0x180 MLOAD                     ; [a=v6, b]
  DUP2 ADD DUP1 SWAP2 GT
  PUSH2 @panic_overflow JUMPI           ; [r]
  PUSH1 0x1A0 MSTORE                    ; v7 = r
  PUSH1 0x1A0 MLOAD  PUSH1 0xC0 MSTORE  ; i = v7

  PUSH2 @while_1  JUMP
@endwhile_1: JUMPDEST
```

The `MSTORE slot / MLOAD slot` back-to-back pairs are exactly what the sample store/load-fusion
peephole (§8) removes — shown unfused because *this is the honest v0 output* and the uniformity
is what makes the disassembly line-mappable. ~60 gas/iteration of overhead; 10,000 iterations
≈ 1.4M gas — far inside eth_call budgets.

---

## 15. Explicitly deferred (with their landing zones)

- **Optimizer**: liveness-based slot reuse (frame.ts), store/load fusion + constant
  micro-folding (peephole), loop free-pointer reset (legal per scope rule) — all behind
  existing interfaces.
- **Nested tuple ABI generality**: `PlainAbiParam` is already a tree; the §7 walker recurses;
  the v0 cut is a recording-time capability check.
- **Overload disambiguation** in `s.call` (copy viem's `ExtractAbiFunctionForArgs`).
- **Dynamic script args** (reuse the returndata walker over calldata).
- **`s.rawCall({to, data}) → { success, data: Expr<'bytes'> }`** typed escape hatch (prior-art
  lesson 12) — trivially expressible in the current IR (`call` with a raw template), held back
  only to keep the v0 review surface small.
- **break/continue**, recursion, generator sugar, `keccak256`/precompile helpers beyond v0's
  `s.keccak256(bytes-like)`.
