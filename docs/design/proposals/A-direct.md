# Proposal A — Direct codegen, correctness-first minimalism

Status: proposal for review (Angle A). Author: design subagent, 2026-06-11.
Inputs: all seven research reports under `docs/research/` (facts cited inline as `[viem]`, `[abitype]`,
`[evm]`, `[prior-art]`, `[stack]`, `[oxc]`, `[npm]`).

## 0. Stance

The simplest architecture that is **fully correct** and shippable for the locked v0 scope:

- **One lowering.** The recorded builder program *is* the IR (a flat, typed, three-address-style
  statement list with nested regions for control flow). A single pass (`lower`) walks it and emits an
  assembly item stream; a two-pass assembler patches labels and produces bytes. No CFG, no SSA pass,
  no register allocator, no optimizer.
- **Memory-slot locals, zero stack scheduling.** Every value lives in a statically assigned 32-byte
  memory slot. Every statement's codegen is a self-contained template: load operands (MLOAD/PUSH),
  compute, MSTORE result. Max stack depth stays under ~8 by construction; the stack-choreography
  search problem that EvmScript solves with A* [prior-art §5] simply does not exist here.
- **Two intrinsically-safe RETURNDATACOPY shapes only** (see §13). All dynamic-returndata decoding
  works on a *memory snapshot* of the full returndata, so the all-gas-consuming OOB halt [evm §2]
  is unreachable by construction, not by per-site cleverness.
- **Pay gas, not complexity.** Uniform lowering costs ~6–15 extra gas per statement versus
  stack-scheduled code. eth_call headroom is 30–550M gas [evm §4]; a 200-statement script wastes
  under 5k gas. This is the right trade for a v0 whose product is *types + correctness*.

Every simplification below states its deferred-but-documented path to the v1 features
(nested tuples, optimizer).

### The user-visible shape (running example)

```ts
import { evscript, arg, t } from '@maxencerb/evs'

const poolMeta = evscript(
  { name: 'poolMeta', args: [arg('pool', t.address), arg('user', t.address)] },
  (s) => {
    const token0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token0' })
    //    ^? Expr<'address'>
    const [, tick] = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' })
    //       ^? Expr<'int24'>
    const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' })
    //    ^? Expr<'string'>
    const bal = s.call({ address: token0, abi: erc20Abi, functionName: 'balanceOf', args: [s.args.user] })
    return s.return({ token0, symbol0, tick, bal })
  },
)

const compiled = poolMeta.compile()                       // { evmVersion: 'cancun' } default
const out = await client.readContract({
  ...compiled.toViem(),                                   // deployless: { abi, code: initBytecode }
  functionName: 'poolMeta',
  args: [pool, user],                                     // readonly [pool: `0x${string}`, user: `0x${string}`]
})
// out: { token0: `0x${string}`; symbol0: string; tick: number; bal: bigint }
```

---

## 1. Decision 1 — Args declaration API + ABI inputs strategy

**Choice: (c) ordered arg declarators** — `args: [arg('pool', t.address), arg('fee', t.uint24)]`.

```ts
// types.ts
export interface ArgSpec<name extends string = string, type extends ValueType = ValueType> {
  readonly kind: 'evs-arg'
  readonly name: name
  readonly type: type
}

// builder.ts (runtime: returns the frozen object; throws EvsTypeError on empty name / bad type string)
export function arg<const name extends string, const type extends ValueType>(
  name: name,
  type: type,
): ArgSpec<name, type>

// autocomplete sugar; plain strings are equally accepted because of `const type` params
export const t: { readonly [k in ValueType]: k }
```

The args parameter of `evscript` is a **readonly tuple of `ArgSpec`s**, so the *type-level order and
the runtime order are the same object* — the entire `UnionToTuple` interning hazard [abitype §4.2]
is structurally impossible on the input side. The two derived artifacts:

```ts
// tuple -> record (SAFE direction: object types are order-insensitive)
export type ArgExprs<specs extends readonly ArgSpec[]> = {
  readonly [s in specs[number] as s['name']]: Expr<s['type']>
}
// s.args.pool: Expr<'address'>, s.args.fee: Expr<'uint24'>

// tuple -> ABI inputs (order-preserving mapped tuple, never UnionToTuple)
export type ArgSpecsToAbiInputs<specs extends readonly ArgSpec[]> = {
  readonly [i in keyof specs]: { readonly name: specs[i]['name']; readonly type: specs[i]['type'] }
}
```

Runtime ABI inputs are produced by `specs.map(({name, type}) => ({name, type}))` — same array, same
order. viem then types `args` as a labeled positional tuple `readonly [pool: \`0x${string}\`, fee: number]`
(labels come from abitype's finite name lookup and are cosmetic; types are always preserved [abitype §1]).

Why not the alternatives:

- **(a) single named-tuple input** is order-immune but changes the call-site UX to
  `args: [{ pool, fee }]` — unidiomatic versus every other viem contract a user touches. We keep it
  as a documented *future option flag*, not the default.
- **(b) entries tuples** `[['pool','address']]` are order-safe too, but give no room for per-arg
  options later (docs, default values) and read worse. `arg()` costs one tiny function.
- **(d) record + UnionToTuple** is the demonstrated silent-reordering bug [abitype §4.2]. Rejected.

Recording-time validation (decision 12): duplicate names, empty names, unsupported type strings →
`EvsTypeError` with the `evscript` call site. Output side is settled per the brief: one named tuple
output (`result`), components from the `s.return` record keys (insertion order at runtime; type-level
component order may differ, which is harmless because viem produces an *object* result type
[abitype §4.2 table, row 1]). The compiler rejects empty-string return keys so the all-named-components
object inference rule [abitype §4.3.4] always holds.

---

## 2. Decision 2 — Expr semantics: VALUE semantics

**Choice: value semantics.** Every `s.*` op executes exactly once, at the point it is recorded, in the
current region. The returned `Expr<t>` is a handle to a *computed value* (a memory slot), never a
re-emittable expression template. Reusing a handle re-reads the slot (one MLOAD); it never re-executes
the producing op. This is the direct answer to the PyTeal post-mortem [prior-art §2]: expression
templates make "where does this run and how many times" invisible; value semantics make recording
order the *only* sequencing rule, the same rule weiroll docs shout about [prior-art lesson 1].

Mutable state is explicit cells:

```ts
let<const type extends ValueType>(type: type, init: ExprIn<type>): Cell<type>

export interface Cell<type extends ValueType = ValueType> extends Expr<type> {
  set(value: ExprIn<type>): void          // recorded statement
}
```

A `Cell` *is an* `Expr`, so it reads naturally in expressions; each use MLOADs the slot at that point,
giving ordinary mutable-variable semantics. For dynamic types (`string`/`bytes`/`T[]`) the slot holds
a memory pointer, so `cell.set(otherString)` is pointer assignment (reference semantics — documented).

**Loop-condition design this forces:** a condition must re-evaluate every iteration, so it cannot be a
pre-computed `Expr`. The condition is a thunk recorded into a dedicated *header region*:

```ts
if(cond: ExprIn<'bool'>, then: () => void, orElse?: () => void): void   // cond evaluated once, before the branch
while(cond: () => ExprIn<'bool'>, body: () => void): void              // cond thunk recorded into the loop header
for(opts: { init?: () => void; cond: () => ExprIn<'bool'>; step?: () => void }, body: () => void): void
break(): void                                                          // valid only inside a loop body (region-checked)
continue(): void                                                       // for-loops: jumps to the step block
```

While recording `s.while`, the builder pushes a header region, invokes the cond thunk (its ops — which
may include calls — land in the header), then pushes a body region and invokes the body. Codegen
re-executes the header block each iteration. `s.if`'s condition is a plain value — evaluated once where
written — which is exactly what value semantics promises.

**Scope rule (the guardrail that replaces PyTeal's silent wrongness):** every value records its defining
region. Using an `Expr` whose defining region is not an *ancestor* of the current recording region
throws `EvsScopeError` at recording time with both source locations. This statically rejects:
value defined in `then` used after the `if`; value defined in a loop body used after the loop
(zero-iteration staleness); value used across scripts; value used after `s.return` (builder is frozen).
Branches communicate through cells declared outside.

Host-language misuse explodes immediately: handles implement `valueOf`, `Symbol.toPrimitive` and
`toString` as throwing `EvsStagingError` (so `if (x)`, `x + 1n`, `` `${x}` `` fail loudly at the wrong
line — prior-art lesson 2), and the TS brand rejects them in host positions.

Deliberately out of v0: `s.select` ternary (sugar for `let`+`if`, easy later), early `s.return`
(single tail return only; early exit via cells + `if`), generator sugar (locked out).

---

## 3. Decision 3 — IR design

The IR is **the recorded program**: a flat table of typed values plus a tree of *regions* containing
linear statement lists. There are no expression trees — value semantics means every op is a statement
producing a `ValueId` (three-address style over memory slots). Plain data, JSON-serializable, versioned.

```ts
// ir.ts — the single contract between builder and codegen
export type ValueId = number & { readonly __evsValueId: unique symbol }
export type RegionId = number & { readonly __evsRegionId: unique symbol }
export type FnId = number & { readonly __evsFnId: unique symbol }

export interface NodeLoc { readonly stack: string }       // raw new Error().stack; parsed lazily on demand
export interface ParsedLoc { file: string; line: number; column: number; frame: string }
export function parseLoc(loc: NodeLoc): ParsedLoc | null  // errors.ts helper

export type LiteralValue =
  | { kind: 'word'; type: WordType; value: bigint }                    // canonical: masked/sign-extended at recording
  | { kind: 'bytes'; type: 'string' | 'bytes'; value: Uint8Array }
  | { kind: 'array'; type: `${WordType}[]`; values: readonly bigint[] }

export type ValueRef = { kind: 'value'; id: ValueId } | { kind: 'literal'; literal: LiteralValue }

export interface ValueInfo {
  readonly id: ValueId
  readonly type: ValueType
  readonly mutable: boolean          // true for cells
  readonly region: RegionId          // defining region (scope checks)
  readonly loc: NodeLoc
  readonly debugName?: string        // 'arg:pool', 'call:symbol#2.out0', ...
}

export type BinOp =
  | 'add' | 'sub' | 'mul' | 'div' | 'mod'                              // arithmetic (checked flag applies)
  | 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'neq'                         // comparisons (signedness from operand type)
  | 'and' | 'or'                                                       // bool logic
  | 'bitAnd' | 'bitOr' | 'bitXor' | 'shl' | 'shr'                      // bitwise (shr arithmetic for intN)
export type UnOp = 'not' | 'bitNot'                                    // not: bool; bitNot: masked to width

export type Stmt =
  | { kind: 'binop'; op: BinOp; checked: boolean; a: ValueRef; b: ValueRef; out: ValueId; loc: NodeLoc }
  | { kind: 'unop'; op: UnOp; a: ValueRef; out: ValueId; loc: NodeLoc }
  | { kind: 'cast'; a: ValueRef; out: ValueId; loc: NodeLoc }          // widening / reinterpret only (see §11)
  | { kind: 'set'; cell: ValueId; value: ValueRef; loc: NodeLoc }
  | { kind: 'index'; arr: ValueRef; i: ValueRef; out: ValueId; loc: NodeLoc }   // bounds-checked, Panic 0x32
  | { kind: 'length'; src: ValueRef; out: ValueId; loc: NodeLoc }
  | { kind: 'staticcall'
      addr: ValueRef
      fn: AbiFunction                                                  // the single resolved runtime ABI item
      selector: Hex                                                    // precomputed via viem toFunctionSelector
      args: readonly ValueRef[]
      outs: readonly ValueId[]                                         // one per output param
      try: { ok: ValueId } | null                                      // tryCall variant
      loc: NodeLoc }
  | { kind: 'if'; cond: ValueRef; then: RegionId; else: RegionId | null; loc: NodeLoc }
  | { kind: 'while'; header: RegionId; cond: ValueRef; body: RegionId; step: RegionId | null; loc: NodeLoc }
  | { kind: 'break'; loc: NodeLoc }
  | { kind: 'continue'; loc: NodeLoc }
  | { kind: 'callfn'; fn: FnId; args: readonly ValueRef[]; outs: readonly ValueId[]; loc: NodeLoc }
  | { kind: 'return'; fields: readonly { name: string; value: ValueRef }[]; loc: NodeLoc }

export interface Region { readonly id: RegionId; readonly parent: RegionId | null; readonly stmts: Stmt[] }

export interface FnDef {
  readonly id: FnId
  readonly name: string
  readonly params: readonly { name: string; type: ValueType }[]
  readonly paramIds: readonly ValueId[]
  readonly results: readonly ValueType[]
  readonly resultIds: readonly ValueId[]                               // fn-owned result slots
  readonly body: RegionId
}

export interface ScriptProgram {
  readonly version: 1
  readonly name: string
  readonly args: readonly { name: string; type: ValueType }[]
  readonly argIds: readonly ValueId[]
  readonly returns: readonly { name: string; type: ValueType }[]
  readonly values: readonly ValueInfo[]                                // index == id
  readonly regions: readonly Region[]                                  // index == id
  readonly fns: readonly FnDef[]
  readonly body: RegionId
}

export function serializeProgram(p: ScriptProgram): string             // JSON (bigints as 0x-hex, bytes as hex)
export function deserializeProgram(json: string): ScriptProgram        // validates version + shape
```

Design points:

- **Tree-of-regions over linear statements**, not basic blocks: control flow is structured by
  construction (no arbitrary jumps exist in the source language), so basic blocks buy nothing in v0.
  A future optimizer can lower this IR to a CFG without touching the builder — the seam is
  `lower(program)` (§9).
- **Typed how:** runtime `ValueType` string on every value (the same abitype vocabulary as the
  type-level `Expr<t>` phantom), mirroring shader-ast's `Term<"float">` proof that string-literal
  types scale [prior-art §3].
- **Source locations:** `new Error().stack` captured raw on every statement and value at recording
  time (cheap at script scale), parsed lazily only when an error/sourcemap needs it
  [prior-art lesson 6].
- **Expr handle branding:** the handle is a class instance carrying `{ program, id }` privately;
  type-level it is only `interface Expr<t> { readonly [exprBrand]: t }` with a `unique symbol`
  (nominal, covariant — `Expr<'uint256'>` assignable to `Expr<ValueType>` as desired [abitype §4.6]).
  Runtime: `valueOf`/`Symbol.toPrimitive`/`toString` throw `EvsStagingError` including the handle's
  own recorded location.

---

## 4. Decision 4 — Memory model

Solidity conventions, kept verbatim [evm §6]:

| Range | Use |
|---|---|
| `0x00–0x3f` | scratch (revert payload building, never live across a statement) |
| `0x40–0x5f` | free memory pointer |
| `0x60–0x7f` | zero slot — never written; empty `string`/`bytes`/`T[]` values point here (len reads as 0) |
| `0x80 … frameEnd` | **the locals frame**: slot `i` of value `id` at `0x80 + 32*id` |
| `frameEnd …` | bump allocations (call returndata snapshots, dynamic values, return buffer) |

- **Locals = static memory slots, one per `ValueId`** (script args, every op result, cells, fn params,
  fn results, compiler temps). `frameEnd = 0x80 + 32 * values.length`, computed after recording; the
  entry prologue emits `mstore(0x40, frameEnd)`. No spilling, no liveness, no reuse in v0 — slot reuse
  via last-use liveness is the documented weiroll-style optimization seam [prior-art lesson 15].
- **Why not stack scheduling:** correctness risk for zero functional gain in an eth_call context.
  Memory expansion for the frame is linear and trivial (a 500-value script touches 16KB ≈ 1.6k gas).
- **Dynamic values are `(ptr)` memory refs** in Solidity layout: `mem[ptr] = len`,
  `mem[ptr+32 …] = data` (strings/bytes: raw bytes zero-padded; arrays: one canonical word per
  element). The Expr's slot holds `ptr`. Length reads are `MLOAD ptr`; element reads are
  bounds-checked `MLOAD ptr + 32 + 32*i` (Panic `0x32` on OOB).
- **Allocation** is the standard `ptr := mload(0x40); mstore(0x40, ptr + pad32(size))`. Memory is
  never freed.
- **Loops × allocation:** allocations inside a loop body bump the free pointer every iteration
  (exactly like Solidity). Documented consequence: a loop performing M calls with dynamic outputs
  uses O(M) memory; quadratic memexp only bites past ~23KB and 1MB ≈ 2.1M gas [evm §4] — fine for
  read scripts, and `compile()` emits no static error for it (a doc note + the disassembler make it
  visible). Scratch *calldata* buffers for sub-calls are built at `mload(0x40)` **without bumping**
  (dead after the STATICCALL, legal because nothing allocates in between) — so a call with static
  outputs allocates nothing at all.
- **Function frames:** none. No recursion (§5) ⇒ every fn's params/locals/results get globally unique
  static slots in the same frame. The "frame" concept needed for recursion later is confined to
  `lower` (slots would become FP-relative); the IR does not change.

---

## 5. Decision 5 — User-defined functions (`s.fn`)

**Choice: JUMPDEST subroutine with return address on the stack; body recorded exactly once;
recursion rejected at recording time.**

```ts
type FnReturn = Expr | readonly Expr[] | Readonly<Record<string, Expr>> | void

fn<const params extends readonly ArgSpec[], const r extends FnReturn>(
  name: string,
  params: params,
  body: (...args: ParamExprs<params>) => r,
): EvsFn<params, r>

type ParamExprs<params extends readonly ArgSpec[]> = {
  [i in keyof params]: Expr<params[i]['type']>
}
type ParamInputs<params extends readonly ArgSpec[]> = {
  [i in keyof params]: ExprIn<params[i]['type']>
}
export interface EvsFn<params extends readonly ArgSpec[], r extends FnReturn> {
  (...args: ParamInputs<params>): r                       // call records a 'callfn' stmt, returns FRESH handles
}
```

(`r` as the call result type is sound because the shapes only contain `Expr<t>` phantoms; the runtime
returns fresh handles of identical types.)

- **Recorded once:** `s.fn` immediately runs `body` with param handles inside a fresh fn region.
  This is why subroutines beat inlining here: inlining would re-invoke the *user's JS callback* per
  call site — a recipe for closure-capture surprises and duplicated source locations, the exact class
  of staging bug PyTeal warns about. It also avoids EIP-170 blow-up.
- **Calling convention** (uniform with the memory model): the caller MSTOREs argument values into the
  callee's param slots, pushes a fresh return label, `PUSH2 fnEntry JUMP`. The callee body runs
  (its values live in their own static slots); the fn epilogue writes results into the fn's result
  slots and executes `JUMP` to the return address left on the stack. Back at the call site, the
  caller **copies result slots into per-callsite out slots** (MLOAD/MSTORE each) so two calls to the
  same fn don't alias. Stack discipline: the return address is the only thing on the stack across
  the body — every statement template is stack-neutral, so it is provably undisturbed.
- **Returns:** the fn body's returned handle shape fixes `results`. v0 keeps fn returns
  *unconditional* (the body region must not contain `return`-like early exits; the value flows out of
  the recorded body's tail expression). Conditional results use cells, same as the script body.
- **Recursion stance: rejected.** Static slots alias under reentry, so: (a) direct recursion —
  calling `f` while `f`'s body is being recorded — throws `EvsRecursionError` (the builder keeps a
  "currently recording fn" stack); (b) mutual recursion is impossible by construction because an
  `EvsFn` handle only exists after its body finished recording (define-before-use). The error message
  names the fn and both call sites.
- Fn bodies are emitted after the main body, each behind a `JUMPDEST` entry label. Uncalled fns are
  still emitted in v0 (dead-code elimination is an optimizer-seam item; the recorded program knows
  call counts, so this is a 10-line future filter in `lower`).

---

## 6. Decision 6 — Call codegen (`s.call` / `s.tryCall`)

### Builder signature (mirrors `readContract`'s generic shape [abitype §1, §2])

```ts
type ViewName<abi extends Abi> = ExtractAbiFunctionNames<abi, 'pure' | 'view'>

interface CallParams<abi extends Abi, name extends ViewName<abi>> {
  address: ExprIn<'address'>
  abi: abi
  functionName: name | ViewName<abi>                       // union keeps autocomplete alive
  args?: CallArgsIn<ExtractAbiFunction<abi, name, 'pure' | 'view'>['inputs']>
}
type CallArgsIn<params extends readonly AbiParameter[]> = {
  readonly [k in keyof params]: CallArgIn<params[k]>       // per-parameter union, preserves tuple-ness
}
type CallArgIn<p extends AbiParameter> =
  | AbiParameterToPrimitiveType<p, 'inputs'>
  | (p['type'] extends ValueType ? Expr<p['type']> : never)

call<const abi extends Abi, name extends ViewName<abi>>(
  p: CallParams<abi, name>,
): UnwrapSingle<CallOutputs<ExtractAbiFunction<abi, name, 'pure' | 'view'>['outputs']>>

tryCall<const abi extends Abi, name extends ViewName<abi>>(
  p: CallParams<abi, name>,
): { ok: Expr<'bool'>; value: UnwrapSingle<CallOutputs<...>> }
```

`CallOutputs` maps each output param to `Expr<type>`; `UnwrapSingle` mirrors viem (0 outputs → `void`,
1 → unwrapped, n → readonly tuple). Overloaded function names are rejected at recording time in v0
(`EvsTypeError`, "disambiguate via a narrowed ABI"); the `ExtractAbiFunctionForArgs` pattern is the
documented later fix [abitype §2.3]. Recording-time validation walks the resolved ABI item and rejects
any param/output type outside the v0 `ValueType` set (nested tuples, fixed arrays, nested arrays)
with the user's source location.

### Emitted sequence (statement template for `staticcall`)

1. **Calldata build.** Head size `H = 4 + 32 * inputs.length` is static. The buffer lives at
   `mload(0x40)` un-bumped (§4). Selector first: `PUSH4 sel, PUSH1 0xE0, SHL, MSTORE buf`. Then per
   arg, in order:
   - *Literal arg (any type):* constant-folded at compile time. The whole head word (and for dynamic
     literals, the tail bytes) are precomputed in TS using viem's `encodeAbiParameters`, and emitted
     as `PUSH32 word / MSTORE` pairs. **If every arg is a literal, the entire calldata (selector
     included) is one precomputed byte string** written word-by-word — zero runtime encoding.
   - *Static Expr arg:* `MLOAD slot, MSTORE buf+off` (values are canonical by the §8 invariant — no
     masking needed here).
   - *Dynamic Expr arg (`string`/`bytes`/`T[]`):* head word = running tail offset (tracked in a
     compiler temp slot because lengths are runtime values); tail = copy `[len][data]` from the
     value's memory ref via `MCOPY` (Cancun) or an emitted word-copy loop (pre-Cancun lowering).
     For `string`/`bytes`, a zero word is MSTOREd at `tailDst + 32 + len` *before* the data copy so
     padding is canonically zero even when the source buffer's padding bytes are dirty.
2. **The call.** `argsSize` is `H` (all-static) or a computed temp. Static-only outputs:
   `retOffset = fresh allocation of 32*n, retSize = 32*n`. Any dynamic output: `retOffset = 0,
   retSize = 0` (we snapshot instead, step 4). Then
   `GAS … STATICCALL` (forward-all; EIP-150 63/64 applies automatically).
3. **Failure path.** `JUMPI @ok` on success; fallthrough `PUSH2 @bubble JUMP` to the shared
   revert-bubbling tail (`RETURNDATACOPY(0,0,rds); REVERT(0,rds)` — verbatim from [evm §5], safe by
   construction). For `tryCall`, the failure path instead zeroes the out slots (dynamic outs are
   pointed at the zero slot `0x60` ⇒ empty), sets `ok = 0`, and jumps past decoding.
4. **Decode.**
   - *Static outputs:* check `RETURNDATASIZE >= 32*n` else `@shortReturndata` (custom error, §7);
     the returned words are already in the ret buffer; per output: `MLOAD buf+32*i`, normalize to
     canonical form (§8), `MSTORE outSlot`.
   - *Any dynamic output:* snapshot **the whole returndata** to a fresh allocation
     (`RETURNDATACOPY(base, 0, RETURNDATASIZE)` — intrinsically safe), bump the free pointer by
     `pad32(rds)`, then run the §7 decoder against the snapshot with pure-memory bounds checks.
     Decoded dynamic values are *pointers into the snapshot* (`[len][data]` is already contiguous in
     ABI encoding) — no second copy. Word outputs in the same returndata are MLOADed from the
     snapshot, normalized, stored.
   - `tryCall`: a failed bounds check sets `ok = 0` + zero/empty outs instead of reverting
     (documented divergence from Solidity try/catch, where decode failure of a *successful* call
     bubbles — one failure path is simpler and more useful for a read DSL).
5. Worked example with exact instructions: §12 E2.

Warm/cold note: first STATICCALL per address costs 2600, later ones 100 [evm §2]; nothing to do in v0
(no call dedup), just documented.

---

## 7. Decision 7 — ABI encode/decode codegen

One module (`codegen/abi-codegen.ts`) owns all four directions, written as **recursive functions over
`AbiParameter` trees** even though v0 only implements the non-nested cases — that recursion skeleton
is the "generality-ready for nested tuples" requirement made concrete: adding tuples later is a new
`case 'tuple':` in each emitter plus removal of the recording-time rejection; no other module changes.

```ts
// codegen/abi-codegen.ts — all functions append AsmItems via the shared AsmBuilder (§8)
export interface SharedTails {                              // labels of the once-emitted tails
  panic11: LabelId; panic12: LabelId; panic32: LabelId
  bubbleRevert: LabelId; shortReturndata: LabelId; invalidCalldata: LabelId
}
export interface SlotRef { slot: number; type: ValueType }  // slot = absolute memory offset

/** Dispatcher side: calldata args -> locals frame. Emits bounds checks for dynamic args. */
export function emitDecodeCalldataArgs(a: AsmBuilder, args: readonly SlotRef[], tails: SharedTails): void

/** Tail of main: encode the single named tuple output at a fresh allocation, then RETURN. */
export function emitEncodeReturnTuple(a: AsmBuilder, components: readonly SlotRef[], tails: SharedTails,
  opts: { evmVersion: EvmVersion }): void

/** Sub-call request: selector + args at mload(0x40); leaves argsSize on stack (or static const). */
export function emitCallArgsEncode(a: AsmBuilder, fn: AbiFunction, selector: Hex,
  args: readonly (SlotRef | { literal: LiteralValue })[], tempSlots: TempAllocator, tails: SharedTails,
  opts: { evmVersion: EvmVersion }): { staticArgsSize: number | null }

/** Sub-call response: returndata (buffer or snapshot) -> out slots, with normalization. */
export function emitReturndataDecode(a: AsmBuilder, outputs: readonly AbiParameter[],
  outs: readonly SlotRef[], mode: { kind: 'revert' } | { kind: 'try'; okSlot: number },
  tempSlots: TempAllocator, tails: SharedTails): void
```

**Calldata arg decoding at dispatch** (per declared script arg, in order):

- Static word at `4 + 32*i`: `CALLDATALOAD`, normalize (mask for `uintN`/`address`,
  `SIGNEXTEND` for `intN`, `ISZERO ISZERO` for `bool`, left-mask for `bytesN`), `MSTORE slot`.
  We *normalize rather than revert* on dirty high bits — a deliberate, documented divergence from
  solc (viem always encodes canonically, so this path is theoretical; normalization is smaller and
  preserves the §8 canonical-word invariant either way).
- Dynamic arg: load head offset, check `off <= calldatasize - H` and
  `len <= calldatasize - off - 36` (`@invalidCalldata` on failure — `EvsInvalidCalldata()` custom
  error), allocate `pad32(32 + len)` (arrays: `32 + 32*len`, with the division-form overflow-safe
  length check `len > (cds - off - 36) / 32`), `CALLDATACOPY` the `[len][data]` segment, store `ptr`.
  Array elements are normalized **eagerly** with a small emitted loop right after the copy (skipped
  entirely for `uint256`/`int256`/`bytes32` element types where it's a no-op), so the invariant
  "every word in a decoded buffer is canonical" holds and `s.index` is a plain bounds-checked MLOAD.

**Return-tuple encoding** (the one place top-level head/tail matters): the function's outputs list is
`[tuple result]`.

- All components static ⇒ the tuple is static ⇒ encoding is the inline word sequence (no offset
  word). Emit: allocate `32*n`, MSTORE each component word in record-insertion order, `RETURN(ptr, 32*n)`.
- Any component dynamic ⇒ the tuple is dynamic ⇒ encoding is `0x20` (top-level offset) ++ tuple body,
  where the body is heads (static words inline, dynamic = offset-from-body-start) ++ tails
  (`[len][data]` padded; data via MCOPY/loop; explicit zero-word padding write as in §6.1).
  Component count is static, so the emitter is straight-line code with the tail cursor in one temp
  slot — no loops except per-array byte copies.

Correctness anchor: a **differential unit test** encodes the same values with viem's
`encodeAbiParameters([tupleParam], [obj])` and asserts byte equality with what the compiled script
RETURNs on @ethereumjs/evm, for a matrix of static/dynamic/mixed return shapes. Same differential
test in reverse for calldata decoding (`encodeFunctionData` → script must see the right values).

**evs custom errors live in the generated ABI**, so viem decodes them with names:

```ts
{ type: 'error', name: 'EvsShortReturndata', inputs: [] },   // sub-call returndata failed bounds checks
{ type: 'error', name: 'EvsInvalidCalldata', inputs: [] },   // script's own calldata failed bounds checks
```

`Panic(uint256)` and `Error(string)` need no ABI entries (viem decodes them natively); the script
*bubbles* callee reverts verbatim and *constructs* only `Panic` (checked math) and the two evs errors.

---

## 8. Decision 8 — Assembler

```ts
// codegen/asm.ts — pure data, no logic; frozen first so all codegen agents can start
export type EvmVersion = 'paris' | 'shanghai' | 'cancun'
export type LabelId = number & { readonly __evsLabel: unique symbol }
export type OpName = 'STOP' | 'ADD' | /* … full table from evm-target §2 … */ | 'INVALID'

export type AsmItem =
  | { kind: 'op'; op: OpName; loc?: NodeLoc; note?: string }
  | { kind: 'push'; value: bigint; loc?: NodeLoc; note?: string }       // auto-width PUSHn; 0 -> PUSH0 on shanghai+
  | { kind: 'pushBytes'; bytes: Uint8Array; loc?: NodeLoc }             // exact-width immediates (selectors, addresses)
  | { kind: 'pushLabel'; label: LabelId; loc?: NodeLoc }                // ALWAYS PUSH2 + fixup (fixed width)
  | { kind: 'label'; label: LabelId; note?: string }                    // emits JUMPDEST

export interface AsmBuilder {
  label(note?: string): LabelId
  emit(...items: AsmItem[]): void
  // convenience emitters used by lower/abi-codegen (all expand to the items above):
  push(v: bigint | number): void
  mload(slot: number): void                                            // PUSH slot; MLOAD
  mstore(slot: number): void                                           // PUSH slot; MSTORE  (value already on stack)
  jump(l: LabelId): void; jumpi(l: LabelId): void
  items(): readonly AsmItem[]
}
export function createAsmBuilder(): AsmBuilder
```

```ts
// codegen/assembler.ts
export interface AssembleResult { bytecode: Uint8Array; sourceMap: PcSourceMap }
export type PcSourceMap = readonly { pc: number; len: number; loc: NodeLoc | null; note: string | null }[]

export function assemble(items: readonly AsmItem[], opts: { evmVersion: EvmVersion }): AssembleResult
export function disassemble(bytecode: Uint8Array | Hex, sourceMap?: PcSourceMap): string
export function lookupPc(map: PcSourceMap, pc: number): { loc: ParsedLoc | null; note: string | null }
export const OPCODES: Readonly<Record<OpName, number>>                  // table per evm-target §2
export type Peephole = (items: readonly AsmItem[]) => readonly AsmItem[]
export function assembleWithPasses(items: readonly AsmItem[], passes: readonly Peephole[],
  opts: { evmVersion: EvmVersion }): AssembleResult
```

- **Two-pass label patching exactly as researched** [evm §3]: `pushLabel` always emits
  `PUSH2 0x0000` + a `{ patchOffset, label }` fixup; after emission, offsets are final (PUSH2 fixed
  width); patch big-endian. PUSH2 always suffices because EIP-170/EIP-3860 keep all offsets < 2^16.
- **Final validation scan** (always on): linear opcode walk skipping PUSH immediates; assert every
  patched target lands on a `JUMPDEST` *opcode*, every label is defined, no fixup unpatched, runtime
  size ≤ 24,576 (EIP-170) → `EvsAssembleError` (internal invariant) or `EvsCompileError` (size, with
  actionable message).
- **evmVersion handling split:** the assembler owns *instruction selection of immediates*
  (`push(0)` → `PUSH0` on shanghai+, `PUSH1 00` on paris); `lower` owns *sequence-level* lowering
  (`MCOPY` → emitted word-copy loop pre-Cancun) because that changes item counts and labels.
- **Peephole hooks: present, empty.** `assembleWithPasses` takes pure `AsmItem[] -> AsmItem[]`
  passes; v0 ships none (candidates documented: `MSTORE slot; PUSH slot; MLOAD` → `DUP1; MSTORE slot`;
  constant-pool dedup via CODECOPY). Passes run *before* fixup so they may not reorder across labels —
  the contract is documented on the type.
- **Disassembler + PC→source map ship day one** [prior-art lesson 7]: `disassemble` prints
  `0x002a JUMPDEST        ; while-header  pools.ts:12:9`, the sourceMap is part of the artifact, and
  execution-failure helpers can decorate "reverted at pc=0x84 → checked add at pools.ts:14:21".

---

## 9. Decision 9 — Dispatcher + artifact

### Runtime layout

```
entry:        PUSH2 frameEnd PUSH1 0x40 MSTORE          ; init free ptr past locals frame
              PUSH1 0x04 CALLDATASIZE LT                ; calldatasize < 4 ?
              PUSH2 @fallback JUMPI
              PUSH0 CALLDATALOAD PUSH1 0xE0 SHR         ; [selector]
              PUSH4 <sel(poolMeta(address,address))> EQ
              PUSH2 @main JUMPI
@fallback:    JUMPDEST PUSH0 PUSH0 REVERT               ; unknown selector / short calldata
@main:        JUMPDEST
              <emitDecodeCalldataArgs>                  ; args -> slots (§7)
              <body statements>                         ; §12 examples
              <emitEncodeReturnTuple + RETURN>
@bubble:      JUMPDEST                                  ; shared tails, emitted once, only if referenced
              RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY
              RETURNDATASIZE PUSH0 REVERT
@panic11:     JUMPDEST PUSH1 0x11 PUSH2 @panicCommon JUMP
@panic12:     JUMPDEST PUSH1 0x12 PUSH2 @panicCommon JUMP
@panic32:     JUMPDEST PUSH1 0x32
@panicCommon: JUMPDEST                                  ; [code] -> revert Panic(code), evm-target §5
              PUSH4 0x4e487b71 PUSH1 0xE0 SHL PUSH0 MSTORE
              PUSH1 0x04 MSTORE PUSH1 0x24 PUSH0 REVERT
@short:       JUMPDEST                                  ; revert EvsShortReturndata()
              PUSH4 <selErr> PUSH1 0xE0 SHL PUSH0 MSTORE PUSH1 0x04 PUSH0 REVERT
@badcd:       JUMPDEST                                  ; revert EvsInvalidCalldata()  (same shape)
<fn bodies>   JUMPDEST …                                ; §5
```

Single function ⇒ single selector compare; fallback is `revert(0,0)`. The selector is computed at
recording time with viem's `toFunctionSelector` on the generated function item (viem is already a
peer dependency — no own keccak).

### `compile()` output shape

```ts
// compile.ts
export interface CompileOptions { evmVersion?: EvmVersion }              // default 'cancun' [evm §1]

export interface CompiledScript<
  name extends string,
  args extends readonly ArgSpec[],
  ret extends Readonly<Record<string, Expr>>,
> {
  readonly name: name
  readonly abi: ScriptAbi<name, args, ret>                               // as-const-typed VALUE (function + evs errors)
  readonly runtimeBytecode: Hex                                          // explicit names — never a bare `code`/
  readonly initBytecode: Hex                                             // `bytecode` field (viem silent-failure footgun)
  readonly sourceMap: PcSourceMap
  readonly program: ScriptProgram                                        // serializable IR (debugging, snapshots)
  disassemble(): string
  toViem(): DeploylessTarget<ScriptAbi<name, args, ret>>                 // default: max RPC compatibility [viem §3.2]
  toViem(opts: { mode: 'deployless' }): DeploylessTarget<ScriptAbi<name, args, ret>>
  toViem(opts: { mode: 'stateOverride'; address?: Address }): StateOverrideTarget<ScriptAbi<name, args, ret>>
}
export interface DeploylessTarget<abi extends Abi> { readonly abi: abi; readonly code: Hex }
export interface StateOverrideTarget<abi extends Abi> {
  readonly abi: abi
  readonly address: Address
  readonly stateOverride: StateOverride                                  // [{ address, code: runtimeBytecode }]
}
```

- `initBytecode` = the **locked 10-byte wrapper** `61 RRRR 80 600A 5F 39 5F F3` ++ runtime
  (`RRRR` = runtime length BE) [evm §6]; for `evmVersion: 'paris'`, the two `5F`s become `3D`
  (RETURNDATASIZE-as-zero). `toViem()` (deployless) returns `{ abi, code: initBytecode }` — runtime
  bytecode is *never* exposed under a `code` key, because viem executes `code` as init code and
  passing runtime fails silently with empty data [viem §1.3, test 2].
- State-override default address: `0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530` [viem §5.1], overridable.
- Both `toViem` shapes spread directly into `readContract` and typecheck (verified pattern,
  [viem §5.2]); peer dep floor `viem >= 2.14.1` [viem §1.2].
- `evscript()` returns `{ program, abi, compile }`; the ABI exists pre-compile (it is recording-derived),
  so codegen failures cannot corrupt the typed surface.

---

## 10. Decision 10 — Type-level architecture

Built directly on the compile-verified prototype in [abitype §3], adapted from record-args to
tuple-spec args (§1).

```ts
// types.ts (pure types; no runtime)
export type IntBits = 8 | 16 | 24 | /* …multiples of 8… */ | 248 | 256
export type BytesWidth = 1 | 2 | /* … */ | 32
export type WordType = 'address' | 'bool' | `uint${IntBits}` | `int${IntBits}` | `bytes${BytesWidth}`
export type DynType = 'string' | 'bytes' | `${WordType}[]`
export type ValueType = WordType | DynType                               // strict subset of abitype AbiType

declare const exprBrand: unique symbol
export interface Expr<type extends ValueType = ValueType> { readonly [exprBrand]: type }

// literal coercion where an Expr is expected — viem-permissive, Register-respecting
export type ExprIn<type extends ValueType> =
  | Expr<type>
  | AbiParameterToPrimitiveType<{ type: type }, 'inputs'>                // flows the user's abitype Register through
  | (type extends `uint${number}` | `int${number}` ? bigint | number : never)  // accept both numerics everywhere
```

Coercion rules (validated at recording with source location; `EvsTypeError` on violation):
`bigint | number` for any `intN/uintN` (must be a safe integer if `number`; range-checked against N;
negatives two's-complemented for `intN`); `boolean` for `bool`; `0x`-string for
`address`/`bytesN`/`bytes` (length-checked; addresses accepted case-insensitively — no checksum
enforcement, matching viem's permissiveness); `string | 0x-string` for `string`
(UTF-8 encoded); JS arrays of the element literal type for `T[]`. All literals are canonicalized at
recording (`LiteralValue.word` stores the masked/sign-extended 256-bit value), which is one half of the
**canonical-word invariant**: *every word stored in a slot or decoded buffer is canonical*
(the other half is decode-time normalization §7 and width-masking after unchecked sub-256 ops and
`bitNot`). Checked ops can therefore use simple range checks; comparisons map to LT/GT vs SLT/SGT by
the operand type's signedness.

Literal ABI type (output side reuses the working record→components prototype; input side is the
order-safe mapped tuple from §1):

```ts
export type ScriptAbi<
  name extends string,
  specs extends readonly ArgSpec[],
  ret extends Readonly<Record<string, Expr>>,
> = readonly [
  {
    readonly type: 'function'
    readonly name: name
    readonly stateMutability: 'view'
    readonly inputs: ArgSpecsToAbiInputs<specs>
    readonly outputs: readonly [{
      readonly name: 'result'
      readonly type: 'tuple'
      readonly components: RetComponents<ret>              // UnionToTuple-based — order-unstable but SAFE:
    }]                                                     // result is an OBJECT type [abitype §4.2 row 1]
  },
  { readonly type: 'error'; readonly name: 'EvsShortReturndata'; readonly inputs: readonly [] },
  { readonly type: 'error'; readonly name: 'EvsInvalidCalldata'; readonly inputs: readonly [] },
]
```

Honest caveat, documented: the *type-level* order of `components` may differ from the runtime array's
insertion order (TS interning). This is harmless — viem's decode uses the runtime ABI value, and the
inferred result is an order-insensitive object — but `script.abi[0].outputs[0].components[i]` is not a
reliable typed index. A CI type-test (vitest `expectTypeOf`) asserts
`ReadContractReturnType<abi, name>` and `ReadContractParameters<abi, name>['args']` for representative
scripts, per the [abitype §4.2] recommendation.

viem-permissiveness patterns mirrored: `const` type params on `evscript`/`arg`/`s.call` (inline ABIs
need no `as const`; standalone ABIs documented as `as const satisfies Abi` [abitype §4.1]);
`functionName: name | AllNames` for live autocomplete; mutability filtered at the *name* level so
nonpayable functions are compile errors in `s.call`; per-parameter `Expr | primitive` unions
[abitype §4.6]. We do **not** adopt viem's full graceful-widening for non-const ABIs in v0: a widened
ABI fails the `ExtractAbiFunctionNames` constraint with a clear error rather than silently degrading —
acceptable for a builder whose whole point is inference, and revisitable.

`s.cast` is widening-only (`uintN→uintM`, `intN→intM` for `M ≥ N` — free, canonical preserved) plus
two explicit reinterprets `s.toUint(addr): Expr<'uint160'>` / `s.toAddress(x: ExprIn<'uint160'>)` and
`bytes32 ↔ uint256`. Truncating casts are out of v0 (no silent value loss).

Register passthrough: evs consumes `AbiParameterToPrimitiveType`/`Address` from abitype rather than
hardcoding `0x${string}`/`bigint`, so a consumer's `declare module 'abitype'` Register flows through
evs exactly as through viem [abitype §4.4]. abitype is a direct dependency aligned with viem's range.

---

## 11. Decision 12 — Builder-time error strategy

(Numbered out of order because the remaining big sections reference it.)

```ts
// errors.ts
export type EvsErrorCode =
  | 'staging-misuse' | 'type' | 'scope' | 'recursion' | 'unsupported-abi'
  | 'compile' | 'assemble-internal'

export class EvsError extends Error {
  readonly code: EvsErrorCode
  readonly loc: NodeLoc | null            // where the offending builder call happened
  readonly relatedLoc: NodeLoc | null     // e.g. where the misused handle was created
  readonly hint: string | null
}
export class EvsStagingError extends EvsError {}   // valueOf/toPrimitive/template-string on a handle
export class EvsTypeError    extends EvsError {}   // literal coercion, arg validation, overloads, unsupported ABI types
export class EvsScopeError   extends EvsError {}   // cross-script handle, region violation, use-after-return
export class EvsRecursionError extends EvsError {} // s.fn reentry
export class EvsCompileError extends EvsError {}   // lowering/size-limit failures (EIP-170 etc.)
export class EvsAssembleError extends EvsError {}  // internal invariants (undefined label, bad JUMPDEST) — "please report"

export function captureLoc(): NodeLoc               // new Error().stack, raw; parse lazily
```

Policy:

- **Validate at recording, not at compile, wherever the information exists at recording** — which is
  almost everywhere, because `s.call` sees its ABI fragment immediately. Recording-time checks:
  literal ranges/shapes, duplicate/empty arg names, unsupported ABI types in call fragments,
  overloaded names, handle ownership (every handle carries its program; foreign handles name *both*
  scripts), region scoping, `break`/`continue` outside loops, fn recursion, use-after-`s.return`
  (builder freezes), missing/double `s.return`.
- Compile-time is reserved for whole-program facts: EIP-170 size, frameEnd bounds, evmVersion gaps.
- Every error message is phrased in user vocabulary with `file:line:col` from `captureLoc()` (PyTeal
  lesson: diagnostics far from the call site killed it [prior-art §2]).
- Misuse traps on handles: `valueOf`, `Symbol.toPrimitive`, `toString` throw `EvsStagingError` citing
  the handle's creation site. (Known residual gap, documented: `await expr` and `JSON.stringify(expr)`
  do not throw — they are not interceptable without `then`-getter hacks that break structural checks.)

---

## 12. Worked codegen examples

Uniform-lowering output, shown exactly as `disassemble()` would (minus PCs). Slot addresses are
`0x80 + 32*id`. The honesty rule for this proposal: **no example uses an optimization the compiler
does not perform.**

### E1 — checked ADD (uint256): `const r = s.add(a, b)`

`a` = id 0 → slot `0x80`, `b` = id 1 → slot `0xA0`, `r` = id 2 → slot `0xC0`.
Overflow iff `r < b` [evm §5].

```
PUSH1 0xA0  MLOAD        ; [b]
PUSH1 0x80  MLOAD        ; [a, b]
ADD                      ; [r]                 r = a + b (mod 2^256)
DUP1                     ; [r, r]
PUSH1 0xA0  MLOAD        ; [b, r, r]
GT                       ; [b > r, r]          b > r  <=>  overflow
PUSH2 @panic11  JUMPI    ; [r]                 -> Panic(0x11)
PUSH1 0xC0  MSTORE       ; []                  slot[r] = r
```

15 bytes, ~33 gas. `uintN` (N < 256) variant: same ADD, then range check `r > maxN`:
`DUP1, PUSH maxN, LT` leaves `maxN < r` → `JUMPI @panic11` (operands are canonical ≤ maxN, so the
256-bit sum cannot wrap). `intN` variant: ADD then
`DUP1, PUSH (N/8-1), SIGNEXTEND, EQ, ISZERO, JUMPI @panic11`. `int256` uses the solc sign-case
formula (`a ≥ 0 ? b > max−a : b < min−a`), emitted from the same template family. DIV/MOD always
check the zero divisor (Panic 0x12) even under `{ checked: false }`, matching solc.

### E2 — STATICCALL `symbol()` decoding a dynamic string

`token` = id 0 → slot `0x80`; out string ptr = id 1 → slot `0xA0`; compiler temps:
`T0` (snapshot base) = id 2 → `0xC0`, `T1` (off) = id 3 → `0xE0`, `T2` (ptr) = id 4 → `0x100`,
`T3` (len) = id 5 → `0x120`. Selector `0x95d89b41`. Calldata is fully literal-folded (selector only).

```
; -- build calldata at mload(0x40), NOT bumped (dead after the call)
PUSH4 0x95d89b41  PUSH1 0xE0  SHL      ; [selWord]
PUSH1 0x40  MLOAD                      ; [buf, selWord]
MSTORE                                 ; mem[buf..buf+32) = selector word    []

; -- staticcall(gas(), token, buf, 4, 0, 0)   (retSize 0: dynamic output -> snapshot decode)
PUSH0  PUSH0                           ; [retOff=0, retSize=0]
PUSH1 0x04                             ; [4, 0, 0]                argsSize
PUSH1 0x40  MLOAD                      ; [buf, 4, 0, 0]           argsOffset
PUSH1 0x80  MLOAD                      ; [token, buf, 4, 0, 0]
GAS                                    ; [gas, token, buf, 4, 0, 0]
STATICCALL                             ; [success]
PUSH2 @ok  JUMPI                       ; []
PUSH2 @bubble  JUMP                    ; bubble callee revert verbatim (shared tail)
@ok: JUMPDEST

; -- guard: need at least the head word
RETURNDATASIZE  PUSH1 0x20  GT         ; [0x20 > rds]
PUSH2 @short  JUMPI

; -- snapshot ENTIRE returndata at a fresh allocation (the only RETURNDATACOPY shapes evs emits
;    are (0,0,rds) and (base,0,rds): both intrinsically in-bounds -> OOB halt unreachable)
PUSH1 0x40  MLOAD  PUSH1 0xC0  MSTORE  ; T0 = base
RETURNDATASIZE  PUSH0                  ; [0, rds]
PUSH1 0xC0  MLOAD                      ; [base, 0, rds]
RETURNDATACOPY                         ; mem[base..base+rds) = returndata    []
RETURNDATASIZE  PUSH1 0x1F  ADD        ; [rds+31]
PUSH1 0x1F  NOT  AND                   ; [pad32(rds)]
PUSH1 0xC0  MLOAD  ADD                 ; [base + pad32(rds)]
PUSH1 0x40  MSTORE                     ; bump free ptr past the snapshot

; -- T1 = offset word
PUSH1 0xC0  MLOAD  MLOAD               ; [off]            mload(base)
PUSH1 0xE0  MSTORE
; -- bounds: off > rds - 0x20  -> short   (rds >= 0x20 already ensured; no underflow)
PUSH1 0x20  RETURNDATASIZE  SUB        ; [rds-0x20]
PUSH1 0xE0  MLOAD                      ; [off, rds-0x20]
GT  PUSH2 @short  JUMPI

; -- T2 = base + off   (points at [len][data] inside the snapshot — ABI layout == our memory layout)
PUSH1 0xE0  MLOAD  PUSH1 0xC0  MLOAD  ADD
PUSH1 0x100  MSTORE
; -- T3 = len
PUSH1 0x100  MLOAD  MLOAD
PUSH1 0x120  MSTORE
; -- bounds: len > rds - off - 0x20  -> short   (off + 0x20 <= rds ensured; no underflow)
PUSH1 0x20  PUSH1 0xE0  MLOAD  RETURNDATASIZE  SUB  SUB   ; [rds - off - 0x20]
PUSH1 0x120  MLOAD                                        ; [len, rds-off-0x20]
GT  PUSH2 @short  JUMPI

; -- result: the string value IS the snapshot segment; store its ptr
PUSH1 0x100  MLOAD  PUSH1 0xA0  MSTORE ; slot[symbol] = T2
```

No copy of the string body, no per-site RETURNDATACOPY bounds reasoning, and `@short` reverts with
`EvsShortReturndata()` which viem decodes by name from the generated ABI.

### E3 — while loop with an `s.let` counter

```ts
const i = s.let(t.uint256, 0n)
const sum = s.let(t.uint256, 0n)
s.while(() => s.lt(i, 5n), () => {
  sum.set(s.add(sum, i))
  i.set(s.add(i, 1n))
})
```

Slots: `i` id 0 → `0x80`, `sum` id 1 → `0xA0`, cond id 2 → `0xC0`, add₁ id 3 → `0xE0`,
add₂ id 4 → `0x100`.

```
PUSH0  PUSH1 0x80  MSTORE              ; i = 0
PUSH0  PUSH1 0xA0  MSTORE              ; sum = 0
@head: JUMPDEST
; header region: t2 = lt(i, 5)
PUSH1 0x05                             ; [5]
PUSH1 0x80  MLOAD                      ; [i, 5]
LT  PUSH1 0xC0  MSTORE                 ; t2 = i < 5
PUSH1 0xC0  MLOAD  ISZERO              ; [!t2]
PUSH2 @exit  JUMPI
; body: t3 = checkedAdd(sum, i)
PUSH1 0x80  MLOAD                      ; [i]               (b)
PUSH1 0xA0  MLOAD                      ; [sum, i]          (a)
ADD  DUP1                              ; [r, r]
PUSH1 0x80  MLOAD                      ; [i, r, r]
GT  PUSH2 @panic11  JUMPI              ; [r]
PUSH1 0xE0  MSTORE                     ; t3 = r
; sum.set(t3)
PUSH1 0xE0  MLOAD  PUSH1 0xA0  MSTORE
; t4 = checkedAdd(i, 1)    (literal folded as PUSH)
PUSH1 0x01  PUSH1 0x80  MLOAD          ; [i, 1]
ADD  DUP1                              ; [r, r]
PUSH1 0x01                             ; [1, r, r]
GT  PUSH2 @panic11  JUMPI              ; [r]
PUSH2 0x0100  MSTORE                   ; t4 = r
; i.set(t4)
PUSH2 0x0100  MLOAD  PUSH1 0x80  MSTORE
PUSH2 @head  JUMP
@exit: JUMPDEST
```

`break` lowers to `PUSH2 @exit JUMP`; `continue` to `PUSH2 @head JUMP` (for-loops: to the step
label, which sits between body end and the back-jump). The cond value going through slot `0xC0` and
back is the uniform-lowering tax (~12 gas/iteration) — the documented peephole candidate, not v0.

### E4 — return-tuple encode for `{ sum: uint256 }` (all-static tuple ⇒ inline, no offset word)

```
PUSH1 0x40  MLOAD                      ; [ret]             fresh allocation (free ptr; nothing allocates after)
PUSH1 0xA0  MLOAD                      ; [sum, ret]
DUP2  MSTORE                           ; mem[ret] = sum    [ret]
PUSH1 0x20  SWAP1                      ; [ret, 0x20]
RETURN                                 ; return(ret, 32)
```

---

## 13. Decision 13 — Research-flagged constraints (and where each is handled)

| Constraint | Source | Where handled |
|---|---|---|
| RETURNDATACOPY OOB = exceptional halt consuming **all** gas | [evm §2] | §6/§12-E2: only `(0,0,rds)` / `(base,0,rds)` shapes are ever emitted; all other reads are bounds-checked memory reads on a snapshot |
| viem `code` executes as **init** code; runtime fails *silently* | [viem §1.3] | §9: `toViem()` only ever exposes `initBytecode` under `code`; fields named `runtimeBytecode`/`initBytecode`; integration test asserts deployless path returns data |
| JUMPDEST validity excludes PUSH-immediate bytes | [evm §3] | §8: PUSH2-only label pushes + mandatory post-assembly validation scan |
| EIP-170 24,576-byte runtime / EIP-3860 49,152 init | [evm §4] | §8 assembler check → `EvsCompileError` with size + biggest-contributor hint |
| eth_call gas caps (anvil 30M default; geth 50M floor) | [evm §4] | test harness runs anvil with `--gas-limit 100000000`; docs state 50M production floor; loop+alloc gas note §4 |
| `TSTORE`/`TLOAD` halt in static context | [evm §1] | never emitted (not in the op table the lowerer uses); scripts contain no state writes at all |
| anvil history: constructor-return over eth_call once broken | [stack §3] | one pinned integration test exercises viem's `code` path; primary tested paths are `anvil_setCode`+plain call and `stateOverride` |
| stateOverride not documented on Alchemy/Infura eth_call | [viem §4] | deployless is the `toViem()` default; stateOverride opt-in |
| state-override `code` does not clear existing storage/balance | [viem §3.1] | default override address is the no-state vanity constant; documented |
| Warm/cold account access (2600/100) | [evm §2] | doc note only; no dedup in v0 |
| abitype label lookup is finite; unknown names lose only the cosmetic label | [abitype §1] | doc note; types always preserved |
| `int/uint ≤ 48 bits → number` (Register-configurable) | [abitype §3, §4.4] | evs types via `AbiParameterToPrimitiveType`; Register flows through |
| TS ≥ 5.0.4 strict; viem types pinned per-patch in CI | [abitype §0] | peer deps `viem >= 2.14.1`, `typescript >= 5.5` optional; CI type-test matrix pins exact viem |
| ESM-only, NodeNext, explicit `.js` import extensions, tsc emitter | [stack §5] | package layout per stack report; `bun build` never used for d.ts |
| stack limit 1024 / call depth | [evm §2] | uniform templates keep depth < ~8; only fn return addresses persist (no recursion ⇒ ≤ depth of textual fn nesting) |

---

## 14. Decision 11 — Module decomposition, interfaces, parallelization, tests

```
packages/evs/src/
  types.ts                 M0  pure type-level (ValueType, Expr, ExprIn, ArgSpec, ScriptAbi, call generics)
  errors.ts                M0  error classes + captureLoc/parseLoc
  ir.ts                    M0  ScriptProgram + nodes + (de)serialization        (§3 signatures)
  codegen/asm.ts           M0  AsmItem, AsmBuilder, LabelId, OPCODES names      (§8 signatures)
  builder.ts               M1  evscript(), arg(), t, ScriptBuilder impl, recording + validation
  abi.ts                   M1  runtime ABI value construction + selectors (uses viem utils)
  codegen/assembler.ts     M2  assemble/disassemble/validate/sourcemap          (§8)
  codegen/abi-codegen.ts   M3  the four ABI emitters + shared tails             (§7)
  codegen/lower.ts         M4  ScriptProgram -> AsmItem[] (dispatcher, statements, fns, tails)
  compile.ts               M5  orchestration, CompiledScript, init wrapper, size checks
  viem.ts                  M5  toViem shapes, INIT_CODE prefixes, DEFAULT_SCRIPT_ADDRESS
  index.ts                 M5  public surface
packages/evs/test/harness/evm.ts        in-process @ethereumjs/evm runner (owned with M2)
```

```ts
// codegen/lower.ts — the single seam a future optimizer replaces
export interface LowerOptions { evmVersion: EvmVersion }
export function lower(program: ScriptProgram, opts: LowerOptions): readonly AsmItem[]

// compile.ts
export function compileProgram<...>(program: ScriptProgram, abi: ..., opts?: CompileOptions): CompiledScript<...>
```

**Dependency order & agent assignment (6 agents):**

| Agent | Owns | Depends on | Can start |
|---|---|---|---|
| A | M0 (`types.ts`, `errors.ts`, `ir.ts`, `codegen/asm.ts` — *interfaces only first*) | — | day 0; freezes contracts for everyone |
| B | M1 builder + abi | M0 | after M0 types land |
| C | M2 assembler + disassembler + **test harness** | M0 (`asm.ts`) | after M0 |
| D | M3 abi-codegen | M0 + C's `AsmBuilder` (interface in M0, impl stubbed) | after M0 |
| E | M4 lower | M0 + D's emitter signatures | after M0 (codes against fixtures: hand-written `ScriptProgram` JSON) |
| F | M5 compile/viem/index + integration tests | all | wiring starts immediately against stubs |

The trick making this parallel: **all five inter-module interfaces (`ScriptProgram`, `AsmItem`/
`AsmBuilder`, the abi-codegen emitter signatures, `lower`, `CompiledScript`) live in M0-owned files
and are frozen first.** Builder tests need no codegen (they snapshot IR JSON); codegen tests need no
builder (they consume hand-written `ScriptProgram` fixtures).

**The in-process EVM harness** (unit-level execution; anvil only for integration):

```ts
// test/harness/evm.ts  — @ethereumjs/evm v10 [stack §3, prior-art lesson 8]
export interface RunResult { success: boolean; returnData: Hex; gasUsed: bigint }
export async function runRuntime(opts: {
  runtime: Hex                                   // planted at a fixed script address
  calldata: Hex
  contracts?: Record<Address, Hex>               // mock STATICCALL targets (runtime code per address)
  gasLimit?: bigint                              // default 30_000_000
}): Promise<RunResult>
// impl sketch: createEVM() + state manager putCode for script & mocks, evm.runCall({ to: SCRIPT, data }).
// Exact v10 API names (createEVM / stateManager.putCode vs putContractCode) verified at implementation
// time against the pinned version — the harness contract above is what other agents code against.
```

**Per-module unit tests:**

- *builder (B):* IR JSON snapshots for each op; every recording-time error (staging traps, scope
  violations, recursion, overloads, literal ranges) asserted with location substrings; type-level
  tests (`*.test-d.ts`, vitest `expectTypeOf`) for `s.args`, `s.call` outputs, `ScriptAbi`,
  `ReadContractReturnType`/`Parameters` round-trips.
- *assembler (C):* opcode-table round-trip vs `disassemble`; label patching goldens; JUMPDEST
  validation scan catches a deliberately corrupted stream; PUSH0/paris lowering; EIP-170 rejection;
  tiny hand-written programs (the research fixtures `RUNTIME_42`, `RUNTIME_WHOAMI` [viem App. A])
  executed on the harness.
- *abi-codegen (D):* **differential vs viem** — for a matrix of arg/return shapes
  (words × string/bytes × arrays × mixed), run the emitted decode/encode on the harness and compare
  byte-exactly with `encodeFunctionData`/`encodeAbiParameters`/`decodeFunctionResult`; bounds-check
  paths fed truncated returndata via a mock contract that returns attacker-shaped payloads
  (huge offsets, huge lengths, off-by-one) and must revert `EvsShortReturndata`, never halt.
- *lower (E):* golden `disassemble()` snapshots for the §12 examples from hand-written
  `ScriptProgram` fixtures; semantic execution on the harness (checked-math panics produce exact
  `0x4e487b71…11/12/32` payloads; loops; fn calls ×2 don't alias; tryCall ok/fail paths).
- *compile/viem (F):* end-to-end `evscript → compile → harness`; then anvil integration (prool,
  one instance per vitest worker via `VITEST_POOL_ID` [stack §3]) covering: `anvil_setCode` + plain
  read, `stateOverride` read, deployless `code` read (the pinned anvil regression), revert bubbling
  from a real reverting contract, fork-mode test against pinned-block mainnet WETH `symbol()`
  reproducing [viem §3] test 4/5. Test runner: vitest (unit + integration projects per the stack
  report); `bun run test`, never `bun test` [stack §2].

---

## 15. Deferred paths (architecture room, priced)

- **Nested tuples (ABI generality):** confined to (1) deleting the recording-time rejection in
  `builder.ts`, (2) adding the `tuple` case to the four recursive emitters in `abi-codegen.ts`
  (head/tail recursion is already the code shape), (3) extending `ValueType`/`Expr` with a
  `TupleRef` memory form (a pointer slot, like dynamic values, with per-component accessors).
  No changes to IR shape (a tuple value is one ValueId), assembler, or artifact.
- **Optimizer:** the seam is `lower(program)` → `AsmItem[]` plus `Peephole` passes. A real optimizer
  replaces `lower` with `lower' = codegenCFG ∘ optimize ∘ toCFG`, keeping `ScriptProgram` (already
  three-address, single-assignment except cells) and `AsmItem` stable. Cheap early wins that need no
  CFG: result-on-stack forwarding peephole, literal/constant-pool dedup via CODECOPY, dead-fn
  elimination, slot reuse by last-use liveness (weiroll-proven [prior-art §1]).
- **Recursion / frames:** slots become FP-relative inside `lower` only.
- **Multi-function scripts, `s.rawCall` escape hatch (`Expr<'bytes'>`), `s.select`, env opcodes
  (`block.timestamp` etc.), EXP/keccak ops:** each is one IR node + one lowering template; listed so
  reviewers see they were excluded deliberately, not forgotten.

## 16. Summary of the 13 decisions

1. **Args:** ordered `arg()` declarator tuple; positional ABI inputs; order-safe by construction.
2. **Expr semantics:** value semantics; cells via `s.let`; loop conditions as thunks recorded into a
   header region; recording-time scope checks.
3. **IR:** the recorded program — flat typed value table + region tree of statements; serializable
   JSON; `new Error().stack` on every node; symbol-branded throwing handles.
4. **Memory:** Solidity map kept; locals = static slot per ValueId at `0x80+32*id`; dynamics as
   Solidity-layout `(ptr)` refs; bump allocator; loops grow memory monotonically (documented).
5. **Functions:** JUMPDEST subroutines, return address on stack, record-once, results copied to
   per-callsite slots; recursion rejected at recording.
6. **Calls:** literal args constant-folded via viem encoders; calldata at un-bumped free ptr;
   forward-all STATICCALL; verbatim revert bubbling; snapshot-based dynamic decode; `tryCall` =
   `{ ok, value }` with zero/empty values and decode-failure folded into `ok=false`.
7. **ABI codegen:** recursive head/tail emitters (tuple-ready skeleton); normalize-on-decode
   canonical-word invariant; single-tuple return encoding incl. dynamic members; evs custom errors in
   the generated ABI; differential tests vs viem.
8. **Assembler:** AsmItem stream, PUSH2-only label fixups, mandatory JUMPDEST/size validation scan,
   peephole hook (empty in v0), disassembler + PC→source map from day one.
9. **Dispatcher/artifact:** 4-byte selector match, `revert(0,0)` fallback; artifact =
   `{ runtimeBytecode, initBytecode(61RRRR80600A5F395FF3), as-const abi, toViem(deployless default /
   stateOverride), disassemble, sourceMap, program }`.
10. **Types:** `Expr<ValueType>` phantom strings; `ExprIn` literal coercion with recording validation;
    `ScriptAbi` literal type (tuple-mapped inputs, record components outputs); Register passthrough;
    viem generic patterns mirrored.
11. **Modules:** 8 files, contracts frozen in M0, 6 agents in parallel; ethereumjs harness for unit
    execution, prool/anvil for integration, differential tests vs viem as the encoder oracle.
12. **Errors:** seven-class `EvsError` hierarchy, recording-time-first validation, every message
    carries `file:line:col` of the user's builder call.
13. **Constraints:** all research-flagged hazards mapped to a specific mechanism (§13 table) — most
    importantly RETURNDATACOPY safety by construction and the init-vs-runtime `code` footgun fenced
    off inside `toViem()`.
