# evs — Final Architecture (binding)

Status: **FINAL — binding for implementation.** Date: 2026-06-11.
Supersedes the three proposals in `docs/design/proposals/`. Companion documents:
`api.md` (user surface), `module-interfaces.md` (the law for parallel agents), `testing.md`,
`repo-layout.md`. Research citations are to `docs/research/*` as `[evm §n]`, `[viem §n]`,
`[abitype §n]`, `[prior-art §n]`, `[stack §n]`.

## 0. Provenance and decision record

- **Base: Proposal C ("types-and-debuggability-first")** — judge consensus winner (2 of 3
  first-place rankings; highest scores on typeQualityDX and debuggability, the two product axes).
- **Grafts from B**: `staticMinSize` returndata guard (closes C's verified decode-soundness hole);
  assembler data segments behind an `INVALID` guard byte with `dataLabel`s; the peephole rule
  table behind a default-identity hook; WeakMap-keyed private handle internals; `LoopCtl`
  break/continue; `t.array()` helper; LIR documented as the v1 optimizer landing zone (NOT in v0).
- **Grafts from A**: the "two intrinsically-safe RETURNDATACOPY shapes" promoted to a
  machine-checked assembler invariant; named zero-arg dispatch error (`EvsInvalidCalldata`) in the
  generated ABI; dispatcher-side **dynamic script-arg decoding** (restores the locked v0 scope);
  the documentation honesty rule ("no example shows an optimization the compiler does not
  perform"); the constraint→mechanism traceability table (§16).
- **Where judges disagreed, rulings** (rationale inline below): no optimizer passes in v0 (B's
  default-on pipeline was the largest miscompilation surface; judge 1 and 3 both flagged its DCE
  unsoundness); no `debug` compile mode forking panic shapes (judge 1 flaw on C); test runner is
  **vitest invoked via `bun run test`** for all tiers (judge 3 flagged the CLAUDE.md conflict;
  the synthesis brief mandates prool + `expectTypeOf`, which require vitest — deviation from
  CLAUDE.md's `bun test` recorded here and in `testing.md` §0); decode of dirty word values
  **normalizes instead of reverting** (judge 2 flagged C's strict mode as a real-world divergence
  from viem); a small **mutable array** (`s.newArray`) is added so the flagship
  multicall-replacement works end to end (judges 1 and 3 flagged C's scope trim against the
  locked v0 list).
- **Args decision (amended by #2)**: script args are a single `t.*` type or a `readonly` list of
  them, arriving as **positional callback params after `s`**; `arg()`/`s.args`/`ArgSpec` are no
  longer the script-args surface (they are retained for `s.fn` params). The original unanimous
  "option (c) ordered `arg()` declarator tuple" decision is superseded — the ordered-declarator
  guarantee it bought (no `UnionToTuple` hazard) is preserved by the ordered positional arg list.
  See §2.1 and amendments.md §16.

## 1. Pipeline overview

```
user callback            s.call / a.add(b) / s.if / s.while / s.fn / s.return
      │  recording: TS types + eager runtime validation + source locations
      ▼
ScriptIr        structured statement tree over a flat value table; plain JSON; frozen
      │  ir/validate (always), ir/interp (reference oracle, test-time)
      ▼
AsmNode[]       codegen/program: frame layout → dispatcher → statement templates →
      │         call/ABI emitters → shared tails → data segments
      │  peephole hook (default identity) → assemble: PUSH2 fixups → layout → patch
      │  → verification: JUMPDEST scan, stack-height simulation, shape lints, fork gating
      ▼
CompiledEvsScript  { runtimeBytecode, initBytecode, abi (literal-typed), sourceMap, ir,
                     toViem(), disassemble(), explainRevert() }
```

Four inspectable artifacts (IR JSON, asm listing, bytecode + sourceMap, disassembly), each
snapshot-testable. PC → asm node → IR stmt (`SiteId`) → user source line is a chain of ids built
from day one [prior-art lesson 6/7].

There is **no mid-level IR and no optimizer in v0**. The documented v1 optimizer seam: insert a
tree→LIR lowering between `ScriptIr` and codegen (B's `LirProgram` + `LirPass` design is the
reference), with the hard pass contract **"any op that can revert is never dead and is never
reordered across another reverting op or call"** written into the pass interface. Until then,
`lowerProgram(ir, opts)` is the single seam an optimizer later replaces.

## 2. Type vocabulary and v0 scope surface

```ts
type UintBits  = 8 | 16 | 24 | … | 248 | 256          // every multiple of 8
type BytesSize = 1 | 2 | … | 32
type WordType  = `uint${UintBits}` | `int${UintBits}` | 'address' | 'bool' | `bytes${BytesSize}`
type DynType   = 'string' | 'bytes'
type ScalarType = WordType | DynType                                          // amended by #2
type ArrayType = `${ScalarType}[]` | `${ScalarType}[][]` | `${ScalarType}[][][]`  // string-encoded
type StringType = ScalarType | ArrayType
type TupleType = { type: 'tuple'|'tuple[]'|'tuple[][]'; components: readonly NamedType[] }  // OBJECT
type NamedType = { name: string; type: string; components?: readonly NamedType[] }  // = PlainAbiParam
type EvsType   = WordType | DynType | ArrayType | TupleType  // amended by #2: string OR tuple object
type ArgType   = EvsType                                // dynamic + composite script args (§8.1, §2.1)
```

`t.struct({...})`/`t.tuple(...)` build a `TupleType`; a raw `readonly AbiParameter[]` is accepted
wherever a tuple type is expected. Tuple/struct args, outputs, returns, and `s.tuple` construction
are in scope (issue #2), as are **one-level arrays of composite/dynamic elements** — arrays of
tuples (`tuple[]`, static-element and dynamic-member element), one-level nested arrays
(`uint256[][]`), and string/bytes arrays (`string[]`/`bytes[]`): decode/read, construct/mutate,
return, and call-arg encode (issue #2 follow-up — amendments.md §16.11; layout in §5, codegen in
§8). Two-level arrays of tuples (`tuple[][]`), fixed-size arrays `T[N]`, and string arrays nested
deeper than `[][]` remain **out of v0** (recording-time `EvsTypeError('UNSUPPORTED_V0', …)`); the
`TupleType`/`ArrayType` vocabulary already represents them and the ABI emitters are recursive over
`PlainAbiParam`/`NamedType` trees, so they are an additive follow-up (one more nesting level / a
separate `T[N]` codepath), not a rewrite — §8.

### 2.1 Args declaration (decision 1 — amended by #2)

**Positional callback params over an ordered arg-spec list.** `args` is a single declarator (a bare
`t.*` type or a `namedArg(...)` — issue #9) or a `readonly` list of them, normalized to
`readonly ArgSpec[]`; each arg arrives as a positional callback param after `s`
(`(s, token, amount) => {…}`) — an `Expr` for scalars/strings/arrays, a `Tuple` handle for
`t.struct`/`t.tuple` args. The declarator is `namedArg` (#9: renamed from `arg`); it names a
top-level arg/param for BOTH script args and `s.fn` params, and the name surfaces in the type.

This **avoids** the `UnionToTuple` interning hazard [abitype §4.2] for the arg path exactly as the
old ordered-`ArgSpec`-tuple did: the arg-spec list is an ordered tuple, so declaration order,
type-level order, runtime encode order, and ABI `inputs` order are the same object; no record→tuple
conversion exists on the input path. Each input is labeled with its `namedArg` name, or the positional
`arg0`/`arg1`/… fallback for a bare arg (#9 — names are pure metadata; codegen is name-agnostic). A
`t.struct` record IS unordered at the type level — recovering an order needs `UnionToTuple`, whose
order is TS-internal-id order, NOT declaration order — but that is **SAFE** because a struct
compiles to a single NAMED ABI `tuple`, which abitype infers as an **order-insensitive object**;
the runtime member encode order is `Object.keys()` insertion order (the only source of truth).
Positional `t.tuple(...)` uses ordered declarators and never touches `UnionToTuple`. Output side
(unchanged): one output `{ name: 'result', type: 'tuple', components }` from the `s.return({...})`
record keys; viem infers an **object** from the fully-named single tuple output [abitype §4.2 row
1, §4.3 rule 4]. Empty-string return keys are rejected at recording. A CI type test pins
`ReadContractParameters<abi,n>['args']` (the labeled positional tuple) and
`ReadContractReturnType<abi,n>` for representative scripts, including the §4.2
interning-regression scenario and a struct-output object.

## 3. Builder semantics (decision 2 — VALUE semantics)

Every `s.*` op and `Expr` method **executes once, where written**, appending statements to the
current recording block. Handles are immutable value snapshots; reuse re-reads a memory slot,
never re-executes. This is the direct answer to the PyTeal post-mortem [prior-art §2].

- **Cells** (`s.let`) are the only mutable state; `Cell` is **not** an `Expr` — reads are an
  explicit `.get()` (a fresh snapshot at that program point). Rationale: A's implicit-read cells
  were flagged (aliasing vs snapshot invisible at the call site).
- **Loop conditions are thunks** recorded into a dedicated header block re-executed per
  iteration: `s.while(() => cond, (loop) => { ... })`. `s.if`'s condition is a plain value
  (evaluated once, before the branch).
- **`LoopCtl`** (`loop.break()` / `loop.continue()`) is passed to loop bodies; valid only while
  its owning loop's body scope is open (recording-time check). Restores break/continue to v0
  (locked scope; both other proposals shipped it).
- **`s.select(cond, a, b)` is eager on both sides** — both are already-computed values. Use
  `s.if` + a cell for conditional execution. Documented loudly on the "what runs when" page.
- **Scope rule (dominance-lite)**: a value recorded inside a block is usable only while that
  block (or a child) is recording. The `while` **body scope is a child of the header scope** —
  header values are visible in the body (the header dominates the body); neither escapes the
  loop. Values escape blocks only via cells declared outside. Violations →
  `EvsScopeError` at recording time, naming both locations. (Resolves A's underspecified
  header/body parentage.)
- **`s.fn` bodies cannot capture outer Exprs or Cells** — params only; touch → `EvsScopeError`.
- **Staging traps**: handles throw `EvsStagingError` from `valueOf`, `Symbol.toPrimitive`,
  `toString`, **and `toJSON`** (resolves A's false "uninterceptable" claim), citing both the
  handle's recording site and the misuse site. `nodejs.util.inspect.custom` is implemented
  **non-throwing** (`Expr<address> #4 ← s.read(token0) at pools.ts:9:18`) — printing is
  debugging, not misuse. The un-poisonable `if (expr)` truthiness gap is mitigated by a
  front-page docs warning + the recommended type-aware `typescript/strict-boolean-expressions`
  lint (oxlint + tsgolint).
- **Handle internals are WeakMap-keyed** (B §4.1): the public `Expr<t>` d.ts carries only the
  brand, `type`, and methods; runtime internals (`{ owner, valueId }`) live in a module-private
  WeakMap — unforgeable, and foreign handles are detected by lookup miss (`EvsScopeError`
  naming both scripts).
- **Recording-time constant folding of all-literal pure ops**: when every operand of a
  `bin`/`un`/`convert` is a literal, the builder folds it to a `const`. If the fold would Panic
  (e.g. `s.add(MAX_U256, 1n)`, division by literal zero, out-of-range narrowing), recording
  throws `EvsTypeError` with the call site and the documented escape hatch: _route one operand
  through a cell_ (`s.let(t.uint256, x).get()`) if a guaranteed runtime panic is genuinely
  intended. (Resolves B's constFold-hard-error flaw: the check moves to recording time, where
  branch reachability is not yet a question and the location is exact, and gets an escape hatch.)

## 4. IR design (decision 3)

The IR is C's **structured statement tree over a flat value table** — plain JSON-safe data
(bigints as 0x-hex), versioned, frozen after recording, exposed as `script.ir` AND on the
compiled artifact (`compiled.ir`) for snapshot tests and bug reports.

Node inventory (full type definitions pinned in `module-interfaces.md` §ir):

```
ScriptIr   { irVersion: 1, name, args, values[], cells[], fns[], body: Stmt[],
             returns[{name,type,value}], loc }
ValueInfo  { type: EvsType, loc, debugName? }       CellInfo { type, loc, debugName? }
FnIr       { name, params[], results[], body: Stmt[], resultValues[], loc }

Stmt = { loc, site: SiteId } & (
  | const     { out, data: {kind:'word',hex} | {kind:'data',hex} }
  | bin       { op: BinOp, a, b, out }          // checked per type; signedness from operand type
  | un        { op: 'not'|'bitnot'|'iszero', a, out }
  | env       { op: 'address'|'caller'|'timestamp'|'blocknumber'|'chainid', out }
  | convert   { a, out }                        // checked narrowing / free widening / reinterpret
  | select    { cond, a, b, out }
  | index     { arr, i, out }                   // bounds-checked → Panic 0x32
  | len       { a, out }
  | arrnew    { elem: EvsType, length: ValueId, out }   // zero-filled; Panic 0x41 on len ≥ 2^32
  |                                             //   (elem widened to EvsType by #2; validate still
  |                                             //    restricts to word — composite arrays deferred)
  | arrset    { arr, i, value }                 // bounds-checked → Panic 0x32
  | tuplenew  { inits: { index, value }[], out } // alloc 32·n, zero-fill, MSTORE provided members
  | field     { tuple, index, out }             // member read = MLOAD(tuplePtr + 32·index)
  | tupleset  { tuple, index, value }           // member write = MSTORE(tuplePtr + 32·index, v)
  |                                             //   (tuple IR nodes added by #2 — §5; out/tuple
  |                                             //    ValueId's `values[id].type` carries TupleType)
  | cellnew   { cell, init } | cellget { cell, out } | cellset { cell, value }
  | call      { target, fnAbi: PlainAbiFunction, args[], outs[], mode:'strict'|'try', successOut? }
  | fncall    { fn: FnId, args[], outs[] }
  | if        { cond, then: Stmt[], else: Stmt[] }
  | while     { header: Stmt[], cond: ValueId, body: Stmt[] }
  | break | continue
)
```

- **Why a tree, not basic blocks**: the builder can only produce structured control flow; a CFG
  buys nothing without an optimizer. Tree→CFG lowering is the self-contained v1 pass (§1).
- **Operands are always `ValueId`s**; literals are deduplicated `const` stmts per `(type, hex)`.
- **Tuple-carrying types (added by #2)**: `ValueInfo.type`/`args`/`returns`/fn param+result types
  are `EvsType` — a string OR a `TupleType` descriptor object (which carries the `components`).
  `serialize`/`deserialize` handle the descriptor objects (`asEvsType` reconstructs them); a tuple
  value occupies ONE frame slot (a pointer — §5). Because tuple descriptors are fresh objects
  (never `===`), EVERY type comparison in the recorder and `ir/validate.ts` uses the STRUCTURAL
  `typesEqual`, not `===`/`!==`. `checkAbiParams` recurses through tuple components.
- **`site: SiteId`** on every stmt links into `sourceMap.sites` and is the id embedded in
  `EvsDecodeError(uint256 site)` reverts.
- **Source locations**: every builder entry calls `captureLoc()` (raw `new Error().stack`,
  parsed lazily, frames inside `@maxencerb/evs` skipped). Disable per script with
  `{ locations: false }`.
- **`ir/validate.ts`** re-checks everything the builder enforces (operand types per op,
  def-before-use under the scope rule, cell types, call-graph acyclicity, single trailing
  return) so deserialized IR is as trustworthy as recorded IR. `compile()` always validates.
- **`ir/interp.ts`** — the reference interpreter over the IR against a `MockChain` (shader-ast's
  second-target lesson). It is the differential oracle: for every example script,
  `interpret(ir, args, chain)` and the compiled bytecode on `@ethereumjs/evm` must agree
  byte-for-byte on returndata/revert data. Judge 3's strongest graft; priced as its own work
  unit (see work plan).

## 5. Memory model (decision 4)

Solidity layout, kept verbatim [evm §6]:

| Range             | Use                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `0x00–0x3f`       | scratch — revert payload assembly, intra-template temporaries only                        |
| `0x40–0x5f`       | free-memory pointer                                                                       |
| `0x60–0x7f`       | zero slot — never written; the canonical empty memref (tryCall failure values point here) |
| `0x80 … frameEnd` | **static frame**: one 32-byte slot per arg, cell, value, fn param/result                  |
| `frameEnd …`      | bump allocations: returndata snapshots, dynamic values, mutable arrays, the return tuple  |

Prologue: `PUSH2 frameEnd PUSH1 0x40 MSTORE`.

- **Every value gets a static frame slot** (`codegen/frame.ts`); statement templates load
  operands (`PUSH slot MLOAD` / `PUSH const`), compute, `MSTORE` the result. No slot reuse, no
  liveness, no stack scheduling, **no fusion** in v0 (B's fusion chains were judged the most
  miscompilation-prone codegen; uniform slots keep the disassembly legible and the stack
  invariant checkable). `FrameLayout` is the pluggable seam for a liveness-based allocator later.
- **Hard invariant, machine-checked (§10)**: the operand stack is empty at every statement
  boundary (baseline 0 in `main`, baseline 1 inside fn bodies — the return address); every
  statement template is net-zero on the stack; simulated depth ≤ 16 inside templates.
- **Canonical word invariant**: every word in a slot is canonical — `uintN` zero-extended,
  `intN` sign-extended, `bool` ∈ {0,1}, `bytesN` left-aligned, `address` 160-bit zero-extended.
  Established at the three trust boundaries (literal coercion at recording; calldata decode;
  returndata decode — by normalization, §8) and preserved by every op (sub-word results masked /
  sign-extended where an op can denormalize: `bitnot`, `shl`, unchecked-by-construction ops).
- **Dynamic values are memrefs**: a slot holds a pointer to `[len:32][payload…]` (strings/bytes:
  raw bytes zero-padded; word arrays: one canonical word per element at `ptr + 32 + 32·i`).
- **Tuples are FLAT-POINTER memrefs (added by #2)**: a tuple value occupies ONE frame slot holding
  a pointer to a packed `[w0][w1]…[w_{n-1}]` block of `n` words (`n = components.length`, **no
  length prefix**). Each `wᵢ` is a canonical word if member `i` is static, or a memref pointer if
  member `i` is dynamic/composite (string/bytes/array/tuple — `wᵢ` holds the pointer to that
  member's memref). `field i` read = `MLOAD(tuplePtr + 32·i)`; write = `MSTORE(tuplePtr + 32·i, v)`.
  `s.tuple(type, init)` bump-allocs `32·n`, **zero-fills** the block via the
  `CALLDATACOPY(dst, CALLDATASIZE, size)` past-end idiom (memory above the free ptr is NOT zero —
  see Transient scratch), then MSTOREs each provided member. **Skip-zero-write soundness**: an
  omitted or literal-`0` member needs no MSTORE because the block is already zeroed — the
  zero-fill-then-write order is what makes that sound (the skip-the-write-of-known-zeros
  optimization is deferred; zero-fill-then-write-all-provided is correct and simple). A decoded
  tuple output is a NEW flat block: static components copy the head word into `wᵢ`; dynamic
  components decode into a memref aliasing the returndata snapshot and store its pointer into `wᵢ`
  (§7.2). Reference semantics: a tuple handle is the pointer, so a later `field.set()` is visible
  through every alias (api.md §5).
- **Composite-element arrays are ARRAYS OF POINTERS (added by #2 follow-up)**: a `tuple[]`,
  `T[][]`, or `string[]`/`bytes[]` is a memref to `[len:32][p0:32][p1:32]…[p_{len-1}:32]` —
  IDENTICAL to the word-array block above (`ptr + 32 + 32·i` addressing, `len` at `ptr`), except
  each slot `pᵢ` holds a memref POINTER to element `i`'s own block instead of an inline value word:
  `tuple[]` → a flat tuple block (the bullet above); `T[][]` → an inner array block (`[len_i][…]`);
  `string[]`/`bytes[]` → a bytes block (`[len_i][payload]`). This is exactly Solidity
  `Struct[]`/`T[][]`/`string[]` memory. The word-array address arithmetic, bounds check
  (`i < len` → Panic 0x32), allocation cap (`2^32-1` → Panic 0x41), and `CALLDATACOPY`-past-end
  zero-fill are **element-type-agnostic and reused unchanged** (`arrnew`/`index`/`arrset`); only the
  leaf semantics differ — the slot holds a pointer, `index` yields it as the element handle
  (downstream `field`/`at` dereference it), `arrset` stores a member pointer, and an unset slot is
  UB exactly like Solidity. A decoded composite array freshly allocates each element block (tuples)
  or aliases the returndata snapshot (leaf bytes) — §8. Reference semantics: the array handle is the
  pointer (api.md §5).
- **Transient scratch**: sub-call calldata is built at `MLOAD(0x40)` **without bumping** (dead
  after the call). Consequence: memory above the free pointer is **not** guaranteed zero — the
  return encoder zero-pads dynamic tails explicitly, and `arrnew` zero-fills via
  `CALLDATACOPY(dst, CALLDATASIZE, size)` (reads past calldata end are zero-padded [evm §2]).
- **Allocation**: `ptr := MLOAD(0x40); MSTORE(0x40, ptr + ceil32(size))`. Never freed. Loop
  allocations grow memory monotonically; `compile()` emits a `LOOP_ALLOCATION` diagnostic via
  the pinned `onDiagnostic` callback (§13.3) when an allocating statement — a `call` with
  outputs, `arrnew`, `tuplenew` (`s.tuple`), or a dynamic literal materialization — or a
  `fncall` whose callee transitively allocates sits inside a loop body **or header** (`while`
  or `for`; amendments 10.7, 14.6).

## 6. Checked arithmetic (full specification — resolves the cross-proposal MUL/SDIV flaws)

All arithmetic is checked (solc ≥0.8 semantics), Panic codes per [evm §5]: `0x11` overflow,
`0x12` div/mod by zero, `0x32` array OOB, `0x41` over-allocation. Operands are canonical (§5).
Yul-level specs below are normative; the asm templates derive from them and are golden-tested
against a solc reference contract (testing.md §4).

**ADD** (`r := add(a,b)`)

- `uint256`: overflow ⇔ `lt(r, b)`.
- `uintN, N<256`: true sum < 2^257 never wraps mod 2^256 for canonical operands; overflow ⇔ `gt(r, maxN)`.
- `intN, N<256`: overflow ⇔ `signextend(N/8-1, r) != r` (operands canonical ⇒ true sum representable in 256 bits).
- `int256`: overflow ⇔ `or(and(iszero(slt(b,0)), slt(r,a)), and(slt(b,0), sgt(r,a)))` (solc `checked_add_t_int256`).

**SUB** (`r := sub(a,b)`)

- `uint256` / `uintN`: underflow ⇔ `lt(a, b)` (check before SUB; result stays canonical).
- `intN, N<256`: signextend-fixpoint check on `r`.
- `int256`: overflow ⇔ `or(and(iszero(slt(b,0)), sgt(r,a)), and(slt(b,0), slt(r,a)))`.

**MUL** (`r := mul(a,b)`) — the width-dependent rule both A and B got wrong:

- `uint256`: overflow ⇔ `iszero(or(iszero(a), eq(div(r,a), b)))` (div-back; [evm §5] sequence verbatim).
- `uintN, N ≤ 128`: the true product of canonical operands is < 2^256 (no 256-bit wrap) ⇒
  range check alone is sound: overflow ⇔ `gt(r, maxN)`.
- `uintN, 128 < N < 256`: the 256-bit product **can wrap back into range** (uint192:
  `a=2^191, b=2^65+1` ⇒ `a*b ≡ 2^191 (mod 2^256)`) ⇒ **div-back check AND range check**, both.
- `int256`: overflow ⇔ `or(and(eq(a, not(0)), eq(b, shl(255,1))), and(iszero(iszero(a)), iszero(eq(sdiv(r,a), b))))`
  — the sdiv-back test plus the lone case it misses (`a == −1, b == −2^255`).
- `intN, N ≤ 128`: |product| ≤ 2^254 ⇒ no signed 256-bit wrap ⇒ signextend-fixpoint check alone.
- `intN, 128 < N < 256`: int256 check above **then** signextend-fixpoint check.

**DIV / MOD**

- All types: `iszero(b)` → Panic `0x12` (also under any future unchecked mode, matching solc).
- `uintN`: `DIV`/`MOD`; result ≤ a ⇒ canonical, no further check.
- `int256` DIV: `and(eq(a, shl(255,1)), eq(b, not(0)))` → Panic `0x11` (EVM SDIV silently wraps
  `−2^255 / −1` [evm §5] — the shipped-miscompilation A and B both omitted); then `SDIV`.
- `intN, N<256` DIV: `SDIV` then signextend-fixpoint check (catches `minN / −1` uniformly) → Panic `0x11`.
- `SMOD` (all intN): zero-check only; result magnitude < |b| ⇒ always canonical.

**Comparisons**: `LT/GT` for unsigned, `SLT/SGT` for signed — selected from the static operand
type. `lte/gte` are `ISZERO(GT/LT)`. `eq/neq` are word-types-only, **enforced by a
this-parameter constraint in the Expr type** (resolves C's comment-only restriction).

**Bitwise**: `AND/OR/XOR/NOT` with post-masking (`uintN`/`bytesN`) or re-sign-extension (`intN`)
where the op can denormalize. `shl`: mask/sign-extend to width (Solidity shifts are unchecked).
`shr`: logical `SHR` for `uintN`/`bytesN`, `SAR` for `intN` (canonical-preserving).

**Bool logic**: eager `AND`/`OR` opcodes on canonical 0/1 words; `not` is `ISZERO`. No
short-circuiting (documented; conditional execution is `s.if`).

**Conversions** (`convert`): widening (`uintN→uintM`, `intN→intM`, `M ≥ N`) is free.
**Narrowing is checked** (range/fixpoint test → Panic `0x11`) — B's silent-truncation cast is
rejected (judged the largest hold-it-wrong surface). `asAddress` checks high 96 bits are zero.
`uint256 ↔ bytes32` is a free reinterpret (both occupy the full word).

Shared panic tails are emitted once (§11); exact bytes hand-verified in §15.0.

## 7. Call codegen (decision 6)

Surface mirrors `readContract` (signatures in `api.md` §6). **Three calling verbs**, split by
mutability + call frame, all sharing the SAME params object (`{ address, abi, functionName,
args?, gas? }`) and the SAME overload structure (struct-aware default / `struct: true` /
non-literal, plus a `try*` variant returning `{ success, value }`):

| Verb                         | Opcode                                   | Mutability filter (functionName type)           | State semantics                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s.read` / `s.tryRead`       | `STATICCALL`                             | `ViewMutability` = `'pure'`\|`'view'`           | static — no state change possible. The renamed frozen read surface (a MECHANICAL RENAME of the old `s.call`/`s.tryCall` — identical codegen).                                                         |
| `s.call` / `s.tryCall`       | `CALL` (value 0)                         | `WriteMutability` = `'nonpayable'`\|`'payable'` | a real non-static frame; the write is NOT rolled back — it persists to LATER subcalls in the same top-level `eth_call` (the `eth_call` itself still never commits). Canonical case: a Uniswap quoter. |
| `s.simulate`/`s.trySimulate` | `CALL` via self-call + revert trampoline | `WriteMutability` = `'nonpayable'`\|`'payable'` | the write is rolled back and isolated from later reads in the same script, yet the return value is read back. Dry-run a true write and read what it would return.                                     |

Mutability is filtered at the `functionName` TYPE level per verb: a nonpayable function under
`s.read` is a compile error (steered to `s.call`/`s.simulate`); a `view`/`pure` function under
`s.call`/`s.simulate` is a compile error (steered to `s.read`). The runtime recorder mirrors
this with a steering `EvsTypeError(ABI_SHAPE)`. abitype generics carry viem's graceful-widening,
`[never]` guards, and the `functionName: name | AllNames` autocomplete union [abitype §2].
Overloaded names are rejected at recording (v0); `ExtractAbiFunctionForArgs` is the documented
later fix. Output/arg types outside the v0 `EvsType` set → recording-time `EvsTypeError`.

**BREAKING CHANGE (acceptable pre-1.0):** the `s.call`/`s.tryCall` → `s.read`/`s.tryRead` rename
AND the reuse of `s.call` with `CALL`-opcode semantics. Every former `s.call`/`s.tryCall` site
(view reads) is now `s.read`/`s.tryRead`.

**FRAME DEPENDENCE** (document like the `s.env('caller')` warning, §13.3): `s.call` and
`s.simulate` make a real call in which the TARGET sees `msg.sender` = the SCRIPT's address — a
per-script counterfactual CREATE2 address in the default deployless `toViem()` mode, or the
override address in `stateOverride` mode. For `msg.sender`-sensitive writes, use
`toViem({ mode: 'stateOverride' })` + the `account` call parameter. The simulate self-call to
`ADDRESS()` works in both modes.

### 7.1 Calldata build — `CalldataTemplate`

Compile-time template per call: `const` segments (selector + every literal arg, pre-encoded with
viem `encodeFunctionData`/`encodeAbiParameters` and merged), `word` segments (runtime word arg →
MSTORE at its head offset), `dyn` segments (runtime `string`/`bytes`/`T[]` arg → head offset
word + tail copied from the memref via MCOPY, with explicit zero-padding of the last word).
All-literal calls collapse to **one const segment**: ≤ 96 bytes → PUSH32-chunked MSTOREs;
larger → **data segment + CODECOPY** (B's §9 convention, §10 below). Buffer at transient
scratch `MLOAD(0x40)`, not bumped. §7.1 and §7.2 are **shared by `s.read` (STATICCALL) and
`s.call` (CALL with value 0)** — the two are identical save the opcode plus the extra `value`
operand on CALL. `s.simulate` (§7.3) reuses §7.1's calldata build for the inner target calldata.

### 7.2 The call, bubbling, decode

1. `STATICCALL(gas(), addr, buf, argsSize, 0, 0)` (`s.read`) or `CALL(gas(), addr, 0, buf,
argsSize, 0, 0)` (`s.call`, `value` 0) — `retSize 0` always; returndata is fetched uniformly
   via RETURNDATACOPY (no `min(retSize, rds)` partial-copy trap). Optional `gas` cap operand;
   default forward-all (EIP-150 63/64 applies). `s.call` is "read with the CALL opcode": the same
   arg-encode / returndata-decode / verbatim-revert-bubble / `try`-zeroing path as `s.read`, with
   no rollback machinery — a write it performs IS visible to a later `s.read` in the same script
   (same `eth_call` frame), but the `eth_call` result is still never committed on-chain.
2. **Failure (strict mode)** → bubble verbatim — works for `Error(string)`, `Panic`, custom
   errors alike [evm §5]: `RETURNDATASIZE PUSH0 PUSH0 RETURNDATACOPY RETURNDATASIZE PUSH0 REVERT`.
3. **Head-size guard BEFORE any head read** (B's `staticMinSize` graft — closes C's verified
   stale-memory hole): `rds < 32 * nOutputs` → decode-fail. Only then snapshot the **whole**
   returndata to a fresh allocation (`RETURNDATACOPY(base, 0, rds)`), bump the free pointer by
   `ceil32(rds)`.
4. **Static word outputs**: `MLOAD(base + 32·i)` + **normalize** (mask / SIGNEXTEND /
   `ISZERO ISZERO`) — normalize-don't-revert, matching viem's lenient decoding (documented
   divergence from solc's strict cleanup; resolves C's sloppy-token flaw). Store to slots.
5. **Dynamic outputs** decode **in place, aliasing the snapshot** (the ABI tail `[len][data]`
   _is_ the evs memref layout — zero copy): validate `off ≤ 2^64−1`, `off + 32 ≤ rds`,
   `len ≤ 2^64−1`, `off + 32 + len ≤ rds` (arrays: `off + 32 + 32·len ≤ rds`; the 2^64 guards
   make the bounds arithmetic overflow-free). Structural failure → decode-fail. Array elements
   are normalized **eagerly** with a small emitted loop after validation (skipped for
   `uint256`/`int256`/`bytes32`), so `index` stays a plain bounds-checked MLOAD.
   - **Tuple outputs (added by #2)**: a `'tuple'` output decodes into a freshly-allocated
     flat-pointer block (§5) — for each component, a static word copies the head word into `wᵢ`; a
     dynamic component decodes into a memref aliasing the snapshot and stores its pointer into `wᵢ`.
     The `staticMinSize`/`headOffset = 32·j` guards count **cumulative** head words for static inner
     tuples (a static tuple output occupies `headBytes(components)` head words, not 1).
   - **Composite-element array outputs (added by #2 follow-up)**: a `tuple[]`/`T[][]`/`string[]`
     output decodes into a freshly-allocated array-of-pointers block (§5) via `emitDecodeArrayToMem`
     — an ON-STACK element loop (no `emitMemCopy`): read `len`, allocate `[len][p0…]`, then for each
     element store its block pointer at `arr + 32 + 32·i` (a static-tuple element recurses into a
     fresh flat block; a dynamic element — dynamic tuple, inner array, string/bytes — decodes into a
     memref and stores its pointer). Dynamic-element offsets are read relative to the array DATA
     START `D` (the word after `len`), NOT the enclosing block base; static-element arrays have no
     offset words (`len·staticSize` contiguous). The per-element source base lives in a fixed scratch
     slot (`ELEM_BASE = 0x20`) so the recursive element decoders' base push is stack-depth-independent
     (§8).
6. **Decode-fail target**: strict mode → per-site stub
   `@dfail_<site>: JUMPDEST PUSH<k> site PUSH2 @decode_revert JUMP`; shared tail reverts
   `EvsDecodeError(uint256 site)` (declared in the generated ABI; `explainRevert`/`sourceMap.sites`
   maps the site to "decoding `symbol()` returndata recorded at pools.ts:9:18").
   Try mode → the call's `@zero_<site>` block: `successOut = 0`, word outs = 0, memref outs =
   `0x60` (zero slot ⇒ empty); a failed STATICCALL/CALL takes the same block. `tryRead`/`tryCall`
   `.success` is false on call failure **or** malformed returndata; `value` is always safe to use
   (documented divergence from Solidity try/catch).

**RETURNDATACOPY invariant (named, machine-checked)**: the compiler only ever emits the two
intrinsically safe shapes `(0, 0, rds)` and `(base, 0, rds)` — `offset = 0, size = RETURNDATASIZE`
can never exceed the buffer, so the all-gas-consuming OOB halt [evm §2] is unreachable **by
construction**, enforced by an assembler lint (§10): every `RETURNDATACOPY` must be immediately
preceded by the node window `RETURNDATASIZE, PUSH0, (PUSH0 | DUPn)`.

Warm/cold note: first STATICCALL per address costs 2600, later 100 [evm §2]; documented, no
dedup in v0.

### 7.3 Simulate trampoline (`s.simulate` / `s.trySimulate`)

`s.simulate` dry-runs a true write and reads back what it would return, while rolling the write
back and isolating it from later reads in the same script. It lowers via a reserved **second
dispatcher entrypoint** (the "trampoline") and a self-call:

1. Build the target calldata exactly like a normal call (§7.1).
2. Above that buffer, build the self-call wrapper `[trampSel(4 bytes)][target address(32)][target
calldata…]`.
3. `CALL ADDRESS()` — the script calls **itself** (the script code is present at `ADDRESS()` in
   BOTH `toViem` modes: deployless's counterfactual CREATE address and `stateOverride`'s override
   address).
4. The dispatcher routes the reserved trampoline selector to the **trampoline body**, which
   decodes `target` + `payload`, performs the real `CALL` to the write target, and then **REVERTs**
   with `[MAGIC(32)][innerSuccess(32)][target returndata…]`. That REVERT unwinds the sub-frame,
   discarding every state change the write made — **THAT is the rollback**.
5. Back in the outer frame, the self-call returns failure (the trampoline reverted). The outer
   frame recognizes the magic word, branches on `innerSuccess` (strict: bubble the target's revert
   verbatim; `try`: `success = false`, zeroed value), and decodes the carried returndata via the
   **shared in-memory tuple decoder** (§7.2 / §8).

Constants: reserved trampoline selector `0xbbde5aa3` = `toFunctionSelector(
'__evs_simulate(address,bytes)')`; `MAGIC` = `keccak256("evs.simulate.revert.v1")` =
`0xe7dc6cc8acb6dfffe16c5466c82c888cde4d25c3f822bd2740efb87faa5dda3c`. The compiler asserts the
script's own selector != the trampoline selector at compile time (collision ~2^-32 →
`EvsInternalError`). `s.read` stays STATICCALL-pure — the trampoline machinery and the CALL
opcode appear only on the `s.call` / `s.simulate` paths.

Codegen modules: `src/codegen/simulate.ts` (the trampoline emitter + constants); `src/codegen/
call.ts` gains `emitSimulateCall` and emits `CALL` for `kind: 'call'`; `src/codegen/program.ts`
adds the trampoline dispatcher branch + entrypoint when any simulate site exists. The IR `call`
statement gains an optional `kind?: 'static' | 'call' | 'simulate'` (absent ⇒ `'static'`, so
pre-issue-#1 serialized IR is byte-unchanged). Nested `s.simulate`, an explicit gas cap on the
inner CALL, and `msg.sender` on the self-call hop are open follow-ups (§18).

## 8. ABI encode/decode codegen (decision 7)

One module (`codegen/abi.ts`) owns all four directions, written recursively over
`PlainAbiParam` trees. **Added by #2**: each emitter (`emitReturnEncode`,
`emitCalldataDecode`/`emitDynCalldataArg`) gained a `case 'tuple'` that recurses head/tail over
the components — static members inline in the head, dynamic members get a head offset + a tail
(recursively encode/decode the member's memref). The cursor is kept in scratch (`0x00`) so every
`emitMemCopy` happens at stack height exactly `[dst, src, len]` (the pre-cancun `@memcpy` ABI
contract); a tuple is ABI-DYNAMIC iff any component is dynamic, and the `headSize`/`dynOff` math
counts a STATIC inner tuple as `headBytes(components)` head words (NOT 1) via a cumulative
head-offset walk — the "one head word per component" assumption is broken.

**Added by the #2 follow-up (arrays of composite)**: one-level `tuple[]`/`T[][]`/`string[]`
elements are delivered by two dedicated array emitters (§8.3); the recording-time guard now only
fences `tuple[][]`, `T[N]`, and string arrays deeper than `[][]`.

### 8.1 Dispatch-time script-arg decode (dynamic args INCLUDED — A graft)

- Guard once: `CALLDATASIZE < 4 + 32·nArgs` → `EvsInvalidCalldata()` (closes A's truncated-
  calldata hole; CALLDATALOAD zero-pads, so without this check short calldata silently decodes
  as zero args).
- **Word arg** at `4 + 32·i`: `CALLDATALOAD` + normalize (mask / SIGNEXTEND / `ISZERO ISZERO`)
  - `MSTORE slot`. Normalize-don't-revert on dirty high bits (viem always encodes canonically;
    documented divergence from solc).
- **Dynamic arg** (`string`/`bytes`/`T[]`): `off := CALLDATALOAD(4+32·i)`; checks
  `off ≤ 2^64−1`, `4 + off + 32 ≤ cds`; `len := CALLDATALOAD(4+off)`; `len ≤ 2^64−1`;
  bytes/string: `4 + off + 32 + len ≤ cds`; arrays: `4 + off + 32 + 32·len ≤ cds` (no overflow:
  both ≤ 2^64). Failure → `EvsInvalidCalldata()`. Allocate `32 + ceil32(len)` (arrays:
  `32 + 32·len`), `CALLDATACOPY` the `[len][data]` segment, store the ptr. Array elements
  normalized eagerly (skip for full-word element types). CALLDATACOPY zero-pads — the checks
  guard correctness, not halts.
- **Tuple/struct arg (added by #2)**: the ABI head/tail tuple is decoded into a freshly-allocated
  flat-pointer block (§5): static members copy the head word into `wᵢ`; dynamic members decode into
  a memref and store its pointer into `wᵢ`. The same `case 'tuple'` recursion as the call-output
  decoder (§7.2 / `codegen/call.ts`); cumulative head-offset arithmetic for static inner tuples.
- **Composite-element array arg (added by #2 follow-up)**: a `tuple[]`/`T[][]`/`string[]` arg is
  decoded into a freshly-allocated array-of-pointers block (§5) via `emitDecodeArrayToMem` (§8.3),
  the same emitter as the call-output decoder (snapshot base read from scratch).

### 8.2 Return-tuple encode (single named tuple; dynamic + composite members supported)

Outputs are `[{ name:'result', type:'tuple', components }]`. Two-pass head/tail emitted as
straight-line code from the compile-time component walk:

1. `out = MLOAD(0x40)`. If any component is dynamic, `MSTORE(out, 0x20)` (top-level offset) and
   `base = out + 0x20`; else components encode inline at `base = out` (both shapes decode
   identically in viem).
2. Heads at `base`: word components stored verbatim (slots are canonical); dynamic components
   get the running tail offset (relative to `base`). Added by #2: a **tuple component** recurses
   via `case 'tuple'` — a static inner tuple occupies `headBytes(components)` head words inline (a
   cumulative head-offset walk, NOT one word), a dynamic inner tuple takes an offset + a tail.
3. Tails in component order: `MSTORE(tail, len)`; payload via `MCOPY` (pre-Cancun: shared
   `@memcpy` word-loop subroutine); **explicit zero-pad** `MSTORE(tail + 32 + len, 0)` before
   the copy bookkeeping (memory above the free pointer is not guaranteed zero — §5). A dynamic
   tuple component's tail is the inner head/tail block (the member's flat-pointer block re-encoded);
   a **composite-element-array component** (`tuple[]`/`T[][]`/`string[]`, added by #2 follow-up) is
   always dynamic — its tail is emitted by `emitEncodeArrayTail` (§8.3).
4. `RETURN(out, total)`.

Differential anchor: emitted encoder/decoder vs viem `encodeAbiParameters` /
`decodeFunctionResult` byte-equality on a fuzzed matrix (testing.md §4).

### 8.3 Arrays of composite elements — `emitDecodeArrayToMem` / `emitEncodeArrayTail` (added by #2 follow-up)

One-level `tuple[]`/`T[][]`/`string[]`/`bytes[]` are encoded/decoded by two dedicated emitters,
reachable from the args path (§8.1), the call-output path (§7.2), and as a return/tuple component
(§8.2). The wire format (the differential bar): for an array `E[]` at data start `D` (the word
after `len`) — a **static element** `E` inlines `len·staticSize(E)` bytes contiguously, no offset
words (`staticSize` = `headBytes(E.components)` for a static tuple, `32` for a word); a **dynamic
element** `E` (dynamic tuple, inner array, string/bytes) writes `len` offset words at `[D, D+32·len)`
**each relative to `D`** (NOT the enclosing block base — an array rebases to its own data start, the
one-word base difference from a tuple member's offset), then the element tails appended from
`D+32·len`.

**`emitDecodeArrayToMem`** — an ON-STACK element loop (NO `emitMemCopy`: it freshly allocates each
tuple/array element block and aliases leaf bytes into the snapshot, so the loop counter may live on
the stack). Read `len`, bounds `len ≤ 2^64−1`; allocate `[len][p0…]` (`32 + 32·len` bytes, bump
`FREE_PTR`); `D = base + 32`; loop `i = 0..len−1`: a static element computes `D + i·staticSize`,
bounds-checks, recurses the element decoder and stores its block pointer (or the word value) at
`arr + 32 + 32·i`; a dynamic element reads `offᵢ` at `D + 32·i` (bounds `offᵢ ≤ 2^64−1`), computes
`D + offᵢ` (bounds `+32 ≤ end`), recurses the matching decoder (tuple block / nested
`emitDecodeArrayToMem` for `T[][]` / leaf string-bytes alias for `string[]`), and stores the
returned pointer. The per-element source base lives in a fixed scratch slot (`ELEM_BASE = 0x20`) so
the recursive decoders' base push is stack-depth-independent; checked loop labels sit at the
absolute height `belowFlat + loopStateSize`, mirroring `emitNormalizeElemsLoop`. Base/end are read
from scratch (`SNAP_SLOT` on the return path), so per-element free-ptr churn never disturbs them.

**`emitEncodeArrayTail`** — written at the shared monotone tail cursor (`TAIL_CURSOR = 0x00`).
`MSTORE(cursor, len)`; `D = cursor + 32`. A **static element** advances `cursor` to
`D + len·staticSize` (reserving the body), then loops, encoding each element inline (a static tuple
writes its head words from `MLOAD(elemPtrᵢ + 32·j)`; a word element `MSTORE`s) — no memcpy, so the
counter may stay on the stack. A **dynamic element** advances `cursor` to `D + 32·len` (reserving
the offset words), then loops: record `tailPos = cursor`, `MSTORE(D + 32·i, tailPos − D)` (offset
relative to `D`), and encode element `i`'s tail at `cursor` (a dynamic tuple → reserve `headBytes`
then `emitEncodeBlock`; `T[][]` → recurse `emitEncodeArrayTail`; `string[]`/`bytes[]` → the leaf
dynamic tail), each extending the shared monotone cursor exactly like a dynamic tuple member.

**Scratch-frame encode discipline (the load-bearing invariant).** `emitMemCopy` requires the
operand stack to be EXACTLY `[dst, src, len]` (the pre-cancun `@memcpy` height-4 checked-entry
contract, §9.4). A dynamic-element loop that held `[i, len, D, arrPtr]` on the stack would violate
that. So the dynamic-element encode loop keeps ALL of its state `{arrPtr, D, len, i}` (4 words) in a
reserved memory FRAME, not on the stack: at `emitReturnEncode`/call-arg-encode entry,
`reserveEncodeFrames` bumps `FREE_PTR` by `32·FRAMES·4` BEFORE `out = MLOAD(0x40)` is read — so the
output/call buffer (and `RETURN(out, …)`) always sits ABOVE the frames and never returns scratch.
`FRAMES` = the max concurrent array-nesting depth along any path of the encoded type (statically
known: `tuple[]`=1; a `tuple[]` whose member is a `string[]`=2). The loop reads/writes `i` from its
frame and recomputes `elemPtrᵢ = MLOAD(arrPtr + 32 + 32·i)`, so nothing but the live `[dst,src,len]`
is on the stack when `emitMemCopy` runs. Static-element loops use no memcpy and keep counter state
on the stack.

## 9. User-defined functions (decision 5)

`s.fn(name, params, body)` — body runs **once, immediately**, in an isolated scope (params
only; no capture). Calling the returned `EvsFn` records a `fncall` with fresh typed outputs.
**Recursion is unconstructible**: the handle does not exist inside its own body; `ir/validate`
re-asserts call-graph acyclicity for deserialized IR.

Codegen: **JUMPDEST subroutine, return address on the stack** (inlining rejected: EIP-170
pressure + duplicated source ranges). Convention: caller MSTOREs args into the callee's static
param slots → `PUSH2 @ret_k` → `PUSH2 @fn_entry JUMP` → callee body (stack baseline 1; every
statement net-zero ⇒ the return address is provably undisturbed, and §10's verifier checks it)
→ results to static result slots → `JUMP` → `@ret_k: JUMPDEST` → caller copies result slots to
per-callsite out slots (two calls never alias). No recursion ⇒ no frames; slots are global.
Uncalled fns are not emitted.

## 10. Assembler (decision 8)

Node stream (full types in `module-interfaces.md` §asm):

```
AsmNode = op | push{value: bigint}        // minimal-width PUSHn; 0 → PUSH0 (paris: PUSH1 00)
        | pushBytes{bytes}                // exact-width immediates (selectors, addresses)
        | pushLabel{label}                // ALWAYS PUSH2 + fixup — never narrowed
        | label{label, stack: number|'any', name?}   // emits JUMPDEST
        | dataLabel{label, name?}         // NO JUMPDEST; CODECOPY source
        | data{bytes}                     // data-segment blob
```

- **Fixups** [evm §3]: `pushLabel` emits `PUSH2 0x0000` + `{patchOffset, label}`; after layout,
  patch big-endian. PUSH2 always suffices (EIP-170/3860 keep offsets < 2^16).
- **Data segments** (B §9 graft, verbatim): all `data`/`dataLabel` items are placed after the
  last code item, preceded by **one `INVALID` (0xFE) guard byte**; `dataLabel`s are never
  jump-targeted (verified), referenced only by `pushLabel` for CODECOPY.
- **Verification passes** (always on; failures are `EvsInternalError` — "bug in evs, please
  report", with an IR dump hint):
  1. **JUMPDEST scan** exactly as consensus does (skip PUSH immediates); every patched jump
     target is a `JUMPDEST` opcode; every label defined; no unpatched fixup; no jump target in
     the data segment.
  2. **Stack-height simulation** with two label classes (resolves C's verifier/§14.2
     inconsistency): `checked` labels carry an exact height — the walk asserts every in-edge and
     the fallthrough agree, then continues; `'any'` labels (panic tails, `@decode_revert`,
     per-site `@dfail_*` stubs, the bubble path) reset the simulated height to a **relative**
     counter starting at 0 that may go negative (popping caller garbage is legal — the region
     terminates in REVERT/INVALID and everything below is dead by contract). An `'any'` region
     must terminate in `REVERT`/`INVALID`/`RETURN` or jump only to other `'any'` labels; falling
     through into a `checked` region is an error. Everywhere else: underflow, depth > 16 inside
     a template, and label-join mismatches are errors naming the label and originating loc.
  3. **Shape lints**: every `RETURNDATACOPY` preceded by exactly
     `RETURNDATASIZE, PUSH0, (PUSH0|DUPn)` (§7); no opcode with `since` newer than
     `opts.evmVersion` (catches a stray MCOPY in a paris build); `TSTORE`/`TLOAD`/`SSTORE`/
     `SLOAD`/`LOG*`/`CREATE*`/`SELFDESTRUCT`/`DELEGATECALL`/`CALLCODE` never appear. `CALL`
     (opcode `0xf1`) is now **ADMITTED** (removed from the FORBIDDEN set — it is reachable only
     on the `s.call` / `s.simulate` paths; `s.read` stays STATICCALL-pure); the STATICCALL-only
     opcode whitelist is relaxed only there. EIP-170 size ≤ 24,576 → `EvsCompileError` with a
     per-region breakdown (body / fns / tails / data segments — C's actionable variant).
- **Peephole hook**: `peephole?: (nodes) => AsmNode[]` in `CompileOptions`, **default identity**
  (no optimization in v0 — the honesty rule applies to docs and goldens). B's rule table ships
  as documentation for the first optional pass: store-forward
  (`MSTORE slot; PUSH slot; MLOAD` → `DUP1; MSTORE slot`), `ISZERO ISZERO` before `JUMPI` drop,
  minimal-width PUSH; rules never cross a `label`/`dataLabel`.
- **Disassembler + PC→source map are products** [prior-art lesson 7]: `disassemble()` is
  independent of the assembler (consumes raw bytecode; round-trip property-tested), annotates
  `pc  mnemonic  imm  ; note — file:line`, and `sourceMap` carries `segments` (pc→loc), `sites`
  (SiteId → kind/loc/detail), and `labels`.

### evmVersion lowering (`'paris' | 'shanghai' | 'cancun'`, default `'cancun'` [evm §1])

| Construct    | cancun                 | shanghai                       | paris                                                  |
| ------------ | ---------------------- | ------------------------------ | ------------------------------------------------------ |
| zero push    | `PUSH0`                | `PUSH0`                        | `PUSH1 00` (assembler-level)                           |
| memory copy  | `MCOPY`                | `@memcpy` word-loop subroutine | `@memcpy` (codegen-level)                              |
| init wrapper | `61RRRR80600A5F395FF3` | same                           | `61RRRR80600A3D393DF3` (`3D` = RETURNDATASIZE-as-zero) |

The assembler owns immediate selection (`push 0`); codegen owns sequence-level lowering (MCOPY),
because that changes node counts and labels. The verifier's fork gate is the backstop.

## 11. Dispatcher + runtime layout (decision 9)

```
prologue:   PUSH frameEnd PUSH1 0x40 MSTORE           ; minimal-width frameEnd immediate
dispatch:   PUSH1 0x04 CALLDATASIZE LT PUSH2 @badcd JUMPI
            PUSH0 CALLDATALOAD PUSH1 0xE0 SHR
            PUSH4 <selector> EQ PUSH2 @main JUMPI
            PUSH2 @badcd JUMP                         ; explicit fallback jump (amendment 10.3)
@main:      JUMPDEST
            <cds ≥ 4+32·n guard → @badcd> <arg decode (§8.1)>
            <body statement templates — @zero_* tryCall zeroing blocks sit inline (amendment 9.6)>
            <return encode (§8.2)> RETURN
@fn_*:      <subroutines (§9)>
@memcpy:    <shared word-loop — pre-cancun only (evmVersion < cancun); emitted unconditionally there, like all shared tails (amendment 10.2)>
@dfail_*:   <per-site stubs → @decode_revert>
@panic_overflow/@panic_divzero/@panic_bounds/@panic_alloc → @panic:  <shared Panic tail (§15.0)>
@decode_revert: <EvsDecodeError(site) tail>
@badcd:     <EvsInvalidCalldata() tail — named, zero-arg; revert(0, 4)>
INVALID     <data segments (dataLabel-addressed blobs)>
```

Single function ⇒ single selector compare. Selector = viem `toFunctionSelector` over
`name(argTypes…)` (inputs only; the tuple output does not affect it). All shared tails are
emitted unconditionally and grouped at program end — unreferenced tails cost a few dozen
unreachable bytes (amendment 10.2) — and the dispatcher reaches `@badcd` through the explicit
`PUSH2 @badcd JUMP` above (amendment 10.3). The fallback is the **named**
`EvsInvalidCalldata()` (A graft) — viem decodes it from the generated ABI instead of a bare
`revert(0,0)`.

When any `s.simulate` site exists, the dispatcher gains a **second selector compare** (a
`DUP1 + PUSH4 <trampoline selector> + EQ + PUSH2 @simulate_trampoline + JUMPI` ahead of the main
selector compare) routing to a `@simulate_trampoline` entrypoint emitted among the tails (§7.3);
the dispatcher is byte-identical to before when there is no simulate site.

The sketch above is the map; the listing below is the territory — the complete annotated
disassembly of the minimal script `echo(uint256)`
(`evscript({ name: 'echo', args: [t.uint256] }, (s, x) => s.return({ x }))`),
compiled with defaults (cancun). Like every marked listing in this document it is generated
from the real compiler and machine-checked against it (see §15 conventions).

<!-- The listings between `docsync:begin/end` markers in this file are generated compiler
output. Regenerate after an intentional codegen change with:
  DOCSYNC_UPDATE=1 bunx vitest run packages/evs/src/docsync.test.ts --project unit
then run `bun run fmt` twice. Drift fails CI via packages/evs/src/docsync.test.ts. -->

<!-- docsync:begin dispatcher-echo -->

```
0x0000  60a0        PUSH1 0xa0  ; frameEnd
0x0002  6040        PUSH1 0x40
0x0004  52          MSTORE  ; free-ptr init
0x0005  6004        PUSH1 0x04
0x0007  36          CALLDATASIZE
0x0008  10          LT
0x0009  610088      PUSH2 0x0088 → @badcd
0x000c  57          JUMPI
0x000d  5f          PUSH0
0x000e  35          CALLDATALOAD
0x000f  60e0        PUSH1 0xe0
0x0011  1c          SHR
0x0012  636279e43c  PUSH4 0x6279e43c  ; selector echo(uint256)
0x0017  14          EQ
0x0018  610020      PUSH2 0x0020 → @main
0x001b  57          JUMPI
0x001c  610088      PUSH2 0x0088 → @badcd
0x001f  56          JUMP
@main:
0x0020  5b          JUMPDEST  ; @main
0x0021  6024        PUSH1 0x24  ; calldata floor 36
0x0023  36          CALLDATASIZE
0x0024  10          LT
0x0025  610088      PUSH2 0x0088 → @badcd
0x0028  57          JUMPI
0x0029  6004        PUSH1 0x04  ; arg #0 head
0x002b  35          CALLDATALOAD
0x002c  6080        PUSH1 0x80
0x002e  52          MSTORE
0x002f  6040        PUSH1 0x40
0x0031  51          MLOAD  ; return buffer
0x0032  6020        PUSH1 0x20 → @main
0x0034  01          ADD
0x0035  5f          PUSH0
0x0036  52          MSTORE
0x0037  6080        PUSH1 0x80
0x0039  51          MLOAD
0x003a  6040        PUSH1 0x40
0x003c  51          MLOAD
0x003d  52          MSTORE  ; head x
0x003e  5f          PUSH0
0x003f  51          MLOAD
0x0040  6040        PUSH1 0x40
0x0042  51          MLOAD
0x0043  80          DUP1
0x0044  91          SWAP2
0x0045  03          SUB
0x0046  90          SWAP1
0x0047  f3          RETURN  ; return tuple
@panic_overflow:
0x0048  5b          JUMPDEST  ; @panic_overflow
0x0049  6011        PUSH1 0x11  ; panic code 0x11
0x004b  610064      PUSH2 0x0064 → @panic
0x004e  56          JUMP
@panic_divzero:
0x004f  5b          JUMPDEST  ; @panic_divzero
0x0050  6012        PUSH1 0x12  ; panic code 0x12
0x0052  610064      PUSH2 0x0064 → @panic
0x0055  56          JUMP
@panic_bounds:
0x0056  5b          JUMPDEST  ; @panic_bounds
0x0057  6032        PUSH1 0x32  ; panic code 0x32
0x0059  610064      PUSH2 0x0064 → @panic
0x005c  56          JUMP
@panic_alloc:
0x005d  5b          JUMPDEST  ; @panic_alloc
0x005e  6041        PUSH1 0x41  ; panic code 0x41
0x0060  610064      PUSH2 0x0064 → @panic
0x0063  56          JUMP
@panic:
0x0064  5b          JUMPDEST  ; @panic
0x0065  634e487b71  PUSH4 0x4e487b71  ; selector 0x4e487b71
0x006a  60e0        PUSH1 0xe0
0x006c  1b          SHL
0x006d  5f          PUSH0
0x006e  52          MSTORE
0x006f  6004        PUSH1 0x04
0x0071  52          MSTORE
0x0072  6024        PUSH1 0x24
0x0074  5f          PUSH0
0x0075  fd          REVERT  ; Panic(code)
@decode_revert:
0x0076  5b          JUMPDEST  ; @decode_revert
0x0077  6320cf27b7  PUSH4 0x20cf27b7  ; selector 0x20cf27b7
0x007c  60e0        PUSH1 0xe0
0x007e  1b          SHL
0x007f  5f          PUSH0
0x0080  52          MSTORE
0x0081  6004        PUSH1 0x04
0x0083  52          MSTORE
0x0084  6024        PUSH1 0x24
0x0086  5f          PUSH0
0x0087  fd          REVERT  ; EvsDecodeError(site)
@badcd:
0x0088  5b          JUMPDEST  ; @badcd
0x0089  63f43fed56  PUSH4 0xf43fed56  ; selector 0xf43fed56
0x008e  60e0        PUSH1 0xe0
0x0090  1b          SHL
0x0091  5f          PUSH0
0x0092  52          MSTORE
0x0093  6004        PUSH1 0x04
0x0095  5f          PUSH0
0x0096  fd          REVERT  ; EvsInvalidCalldata()
```

<!-- docsync:end -->

On-chain error set (both declared in the generated ABI, always — the literal ABI type is
independent of compile options):

```ts
{ type: 'error', name: 'EvsInvalidCalldata', inputs: [] }                       // calldata-side
{ type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] }  // returndata-side
```

`Panic(uint256)` / `Error(string)` need no ABI entries (viem decodes natively); callee reverts
are bubbled verbatim. There is **no debug compile mode** — panics always revert standard
`Panic(code)` (resolves C's forked-panic-shape flaw); `explainRevert` maps `EvsDecodeError`
sites exactly and, for `Panic`, explains the code and lists the candidate sites of that panic
kind from `sourceMap.sites`.

## 12. compile() and the artifact (exact shape in `module-interfaces.md` §compile)

```ts
interface CompileOptions {
  evmVersion?: 'paris' | 'shanghai' | 'cancun'   // default 'cancun'
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]   // default identity
  onDiagnostic?: (d: EvsDiagnostic) => void      // pinned channel; compile() never logs
  locations?: boolean                            // default true
}
compile(script, options?) → CompiledEvsScript    // free function; script.compile() is sugar
```

`CompiledEvsScript`: `abi` (literal-typed value: function + the two evs errors),
`runtimeBytecode`, `initBytecode` (the locked 10-byte wrapper `61 RRRR 80 600A 5F 39 5F F3` ++
runtime [evm §6]; paris variant swaps `5F`→`3D`), `sourceMap`, `ir`, `options`, `toViem()`,
`disassemble()`, `explainRevert(data)`.

- `toViem()` (no args) = **deployless**: `{ abi, code: initBytecode }` — maximal RPC
  portability [viem §3.2]. `code` is _only ever_ creation bytecode; there is deliberately no
  field named `code`/`bytecode` on the artifact itself (the verified silent-failure footgun
  [viem §1.3 test 2] is fenced by naming: `runtimeBytecode` / `initBytecode`).
- `toViem({ mode: 'stateOverride', address? })` = `{ abi, address, stateOverride: [{ address,
code: runtimeBytecode }] }`; default address `0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`
  [viem §5.1]. Both shapes spread into `readContract` and typecheck (compile-verified pattern
  [viem §5.2]). Peer dep floor: `viem >= 2.14.1` [viem §1.2].
- `script.abi` exists pre-compile (recording-derived); codegen failures cannot corrupt the
  typed surface.

## 13. Error strategy (decision 12) and diagnostics

### 13.1 TS-side classes (no name collision with on-chain errors)

```
EvsError (base; code: EvsErrorCode, loc, relatedLocs[])
├─ EvsStagingError    valueOf/toPrimitive/toString/toJSON on a handle
├─ EvsTypeError       op/arg type mismatch, literal range, overloads, unsupported-in-v0,
│                     certain-panic literal fold, empty return keys
├─ EvsScopeError      foreign handle, scope-closed use, capture in s.fn, LoopCtl outside loop,
│                     use-after-return
├─ EvsCompileError    EIP-170 (per-region breakdown), evmVersion gating, frame budget
└─ EvsInternalError   verifier failures — "this is a bug in evs, please report" + ir dump hint
```

### 13.2 Policy

Validate at recording wherever the information exists at recording (almost everywhere —
`s.read`/`s.call` sees its ABI fragment immediately). Every message speaks user vocabulary with `file:line:col`
from `captureLoc()`, plus `relatedLocs` when two sites are involved (PyTeal lesson). Compile
time is reserved for whole-program facts. The full recording-time checklist is pinned in
`module-interfaces.md` §builder.

### 13.3 Diagnostics channel (pinned — resolves C's wobble)

`EvsDiagnostic = { severity: 'warning'; code: 'LOOP_ALLOCATION' | 'LARGE_FRAME' |
'ENV_FRAME_DEPENDENT'; message: string; loc: SourceLoc | null }`, delivered only via
`CompileOptions.onDiagnostic`. (`ENV_FRAME_DEPENDENT` — emitted once per `s.env('caller')` /
`s.env('address')`, whose value is execution-frame-dependent — was added by amendment 14.1.) The
artifact stays pure; nothing is logged by default.

## 14. PC→source map and disassembler

`SourceMap = { version: 1, segments: [{pc, len, loc, note?}] (sorted, non-overlapping),
sites: [{id, kind: 'panic'|'decode'|'call'|'stmt', loc, detail}], labels: [{pc, name}] }`.
`lookupPc(map, pc)` for trace decoration; `sites` powers `explainRevert` and the
`EvsDecodeError(site)` round-trip. `disassemble(bytecode, sourceMap?)` works on raw bytes
(usable on foreign bytecode), annotates labels/locs/notes, and `format()` output is the golden
snapshot format. The honesty rule: every documented listing is real compiler output.

## 15. Worked codegen examples (hand-verified against [evm §2])

<!-- The listings between `docsync:begin/end` markers are generated compiler output —
regenerate with: DOCSYNC_UPDATE=1 bunx vitest run packages/evs/src/docsync.test.ts
--project unit (then `bun run fmt` twice). -->

Conventions: every marked listing is **real compiler output** —
`compile(script).disassemble().format({ locs: false })` of the named example script (or a
contiguous excerpt of it), generated and machine-verified by the doc-sync test
(`packages/evs/src/docsync.test.ts`, testing.md §6 — A's honesty rule, enforced). Stack
effects are described in prose, top of stack first; `slot[X]` is frame memory; `@x` = a
PUSH2-fixup label. One disassembler quirk to read past: a push whose **value** coincides with
some label's pc gets a speculative `→ @label` annotation (e.g. `PUSH1 0xa0 → @badcd` on a
plain frame-slot load when `@badcd` happens to sit at pc 0xa0); only `PUSH2` immediates
feeding a `JUMP`/`JUMPI` are actual targets. Label numbering (`@while_13`) is recorder-derived
and deterministic. No optimization is shown that the compiler does not perform.

### 15.0 Shared panic tail (emitted once; stack class `'any'`)

Four code-pushing entry stubs funnel into one shared `@panic` body: it builds
`Panic(uint256)` — selector `0x4e487b71` shifted into the top 4 bytes of scratch `0x00`, the
code word at `0x04` — and `revert(0, 36)`. Excerpt from the `echo(uint256)` listing (§11):

<!-- docsync:begin panic-tail -->

```
@panic_overflow:
0x0048  5b          JUMPDEST  ; @panic_overflow
0x0049  6011        PUSH1 0x11  ; panic code 0x11
0x004b  610064      PUSH2 0x0064 → @panic
0x004e  56          JUMP
@panic_divzero:
0x004f  5b          JUMPDEST  ; @panic_divzero
0x0050  6012        PUSH1 0x12  ; panic code 0x12
0x0052  610064      PUSH2 0x0064 → @panic
0x0055  56          JUMP
@panic_bounds:
0x0056  5b          JUMPDEST  ; @panic_bounds
0x0057  6032        PUSH1 0x32  ; panic code 0x32
0x0059  610064      PUSH2 0x0064 → @panic
0x005c  56          JUMP
@panic_alloc:
0x005d  5b          JUMPDEST  ; @panic_alloc
0x005e  6041        PUSH1 0x41  ; panic code 0x41
0x0060  610064      PUSH2 0x0064 → @panic
0x0063  56          JUMP
@panic:
0x0064  5b          JUMPDEST  ; @panic
0x0065  634e487b71  PUSH4 0x4e487b71  ; selector 0x4e487b71
0x006a  60e0        PUSH1 0xe0
0x006c  1b          SHL
0x006d  5f          PUSH0
0x006e  52          MSTORE
0x006f  6004        PUSH1 0x04
0x0071  52          MSTORE
0x0072  6024        PUSH1 0x24
0x0074  5f          PUSH0
0x0075  fd          REVERT  ; Panic(code)
```

<!-- docsync:end -->

`@decode_revert` is the same shape with `PUSH4 <sel(EvsDecodeError(uint256))>` and the site id
pushed by the per-site stub; `@badcd` is the 4-byte-payload variant (`revert(0, 4)`).

### 15.1 Checked ADD (uint256) — `const c = a.add(b)`; a→`0x80`, b→`0xA0`, c→`0xC0`

From the script `addu(a, b)` returning `{ c: a.add(b) }`: `a` and `b` are the two args
(slots `0x80`/`0xA0` per §8.1), `c` is the first value (slot `0xC0`). The excerpt is the one
`bin add` statement template. Stack story, top first: load `b` then `a` → `[a, b]`; `DUP2 ADD`
→ `[r, b]` with `r = a+b` wrapping; `DUP1 SWAP2 GT` → `[b>r, r]` — overflow ⇔ `r < b`; `JUMPI`
to the shared tail, else `MSTORE` to `slot[0xC0]`. (The `→ @badcd` on the first line is the
§15-conventions disassembler quirk: `0xa0` is both `b`'s slot and `@badcd`'s pc here.)

<!-- docsync:begin checked-add -->

```
0x0035  60a0        PUSH1 0xa0 → @badcd  ; checked add uint256
0x0037  51          MLOAD
0x0038  6080        PUSH1 0x80
0x003a  51          MLOAD
0x003b  81          DUP2
0x003c  01          ADD
0x003d  80          DUP1
0x003e  91          SWAP2
0x003f  11          GT
0x0040  610060      PUSH2 0x0060 → @panic_overflow
0x0043  57          JUMPI
0x0044  60c0        PUSH1 0xc0
0x0046  52          MSTORE
```

<!-- docsync:end -->

Net stack 0 (the statement-boundary invariant §10 checks). Width variants per §6: `uintN<256`
replaces the GT-check with `r > maxN`; `intN<256` uses the SIGNEXTEND fixpoint; `int256` the
solc sign-case formula.

### 15.2 STATICCALL `symbol()` → dynamic string (the decode-soundness graft applied)

From the script `sym(token0)` returning `{ symbol0: s.read({ address: token0, abi: erc20Abi,
functionName: 'symbol' }) }`: arg `token0`→`0x80`, result memref `symbol0`→`0xA0`, the call is
**site 0**. Calldata is all-literal after folding (selector only) and is built at transient
scratch with the stack empty, recomputing the buffer pointer from `0x40` instead of keeping it
on the stack (amendment 9.8). Reading the excerpt top to bottom:

- **§8.1 arg decode**: calldata-floor guard, `CALLDATALOAD`, `PUSH20`-mask to canonical
  address, store to `slot[0x80]`.
- **calldata build** (free ptr NOT bumped): selector word `MSTORE`d at `MLOAD(0x40)`.
- **staticcall(gas, token0, buf, 4, 0, 0)**: operands pushed retSize=0, retOff=0, argsSize=4,
  argsOff=buf (`DUP4`), target, `GAS` on top (resolved flaw 35: retSize first).
- **failure path**: bubble the callee revert verbatim — RETURNDATACOPY shape 1
  `(0, 0, rds)`, then `revert(0, rds)`.
- **`@call_ok_0`** (checked label, stack 1): the **HEAD-SIZE GUARD** `rds ≥ 32·nOutputs`
  fires before any decode read; then the ENTIRE returndata is snapshotted at `buf`
  (RETURNDATACOPY shape 2) and the free pointer bumps by `ceil32(rds)`.
- **dynamic head decode**: `off ≤ 2^64−1`, `off+32 ≤ rds`, then `ptr = buf+off`,
  `len ≤ 2^64−1`, `off+32+len ≤ rds` — every violation jumps to `@dfail_0`; finally
  `slot[0xA0] = ptr` (the memref aliases the snapshot) and the `POP` restores stack 0.

<!-- docsync:begin call-symbol -->

```
@main:
0x0020  5b          JUMPDEST  ; @main
0x0021  6024        PUSH1 0x24  ; calldata floor 36
0x0023  36          CALLDATASIZE
0x0024  10          LT
0x0025  610161      PUSH2 0x0161 → @badcd
0x0028  57          JUMPI
0x0029  6004        PUSH1 0x04  ; arg #0 head
0x002b  35          CALLDATALOAD
0x002c  73ffffffffffffffffffffffffffffffffffffffff  PUSH20 0xffffffffffffffffffffffffffffffffffffffff  ; mask address
0x0041  16          AND
0x0042  6080        PUSH1 0x80
0x0044  52          MSTORE
0x0045  6395d89b41  PUSH4 0x95d89b41  ; const calldata
0x004a  60e0        PUSH1 0xe0
0x004c  1b          SHL
0x004d  6040        PUSH1 0x40
0x004f  51          MLOAD
0x0050  52          MSTORE
0x0051  6040        PUSH1 0x40
0x0053  51          MLOAD
0x0054  5f          PUSH0
0x0055  5f          PUSH0
0x0056  6004        PUSH1 0x04
0x0058  83          DUP4
0x0059  6080        PUSH1 0x80
0x005b  51          MLOAD  ; target
0x005c  5a          GAS
0x005d  fa          STATICCALL  ; strict read symbol (site 0)
0x005e  610069      PUSH2 0x0069 → @call_ok_0
0x0061  57          JUMPI
0x0062  3d          RETURNDATASIZE
0x0063  5f          PUSH0
0x0064  5f          PUSH0
0x0065  3e          RETURNDATACOPY
0x0066  3d          RETURNDATASIZE
0x0067  5f          PUSH0
0x0068  fd          REVERT  ; bubble callee revert
@call_ok_0:
0x0069  5b          JUMPDEST  ; @call_ok_0
0x006a  3d          RETURNDATASIZE
0x006b  6020        PUSH1 0x20 → @main  ; staticMinSize 32
0x006d  11          GT
0x006e  61011b      PUSH2 0x011b → @dfail_0
0x0071  57          JUMPI
0x0072  3d          RETURNDATASIZE
0x0073  5f          PUSH0
0x0074  82          DUP3
0x0075  3e          RETURNDATACOPY
0x0076  3d          RETURNDATASIZE
0x0077  601f        PUSH1 0x1f
0x0079  01          ADD
0x007a  601f        PUSH1 0x1f
0x007c  19          NOT
0x007d  16          AND
0x007e  81          DUP2
0x007f  01          ADD
0x0080  6040        PUSH1 0x40
0x0082  52          MSTORE
0x0083  80          DUP1
0x0084  51          MLOAD
0x0085  67ffffffffffffffff  PUSH8 0xffffffffffffffff
0x008e  81          DUP2
0x008f  11          GT
0x0090  61011b      PUSH2 0x011b → @dfail_0
0x0093  57          JUMPI
0x0094  80          DUP1
0x0095  6020        PUSH1 0x20 → @main
0x0097  01          ADD
0x0098  3d          RETURNDATASIZE
0x0099  10          LT
0x009a  61011b      PUSH2 0x011b → @dfail_0
0x009d  57          JUMPI
0x009e  81          DUP2
0x009f  01          ADD
0x00a0  80          DUP1
0x00a1  51          MLOAD
0x00a2  67ffffffffffffffff  PUSH8 0xffffffffffffffff
0x00ab  81          DUP2
0x00ac  11          GT
0x00ad  61011b      PUSH2 0x011b → @dfail_0
0x00b0  57          JUMPI
0x00b1  81          DUP2
0x00b2  6020        PUSH1 0x20 → @main
0x00b4  01          ADD
0x00b5  01          ADD
0x00b6  3d          RETURNDATASIZE
0x00b7  83          DUP4
0x00b8  01          ADD
0x00b9  10          LT
0x00ba  61011b      PUSH2 0x011b → @dfail_0
0x00bd  57          JUMPI
0x00be  60a0        PUSH1 0xa0
0x00c0  52          MSTORE  ; out #0 string (memref aliases snapshot)
0x00c1  50          POP
```

<!-- docsync:end -->

The per-site stub lives with the tails (`'any'` stack class) and pushes the site id for the
shared `@decode_revert` tail (§15.0 shape):

<!-- docsync:begin call-symbol-dfail -->

```
@dfail_0:
0x011b  5b          JUMPDEST  ; @dfail_0
0x011c  5f          PUSH0  ; site 0
0x011d  61014f      PUSH2 0x014f → @decode_revert
0x0120  56          JUMP
```

<!-- docsync:end -->

Every head word read happens **after** `rds ≥ 32·nOutputs` is established — no stale-memory
read exists on any path (the resolved C §14.2 hole). The string body is never copied twice.
`tryRead` variant: the post-STATICCALL `JUMPI` inverts to the `@zero_0` block and `@dfail_0`
jumps there too; `@zero_0` sets `success=0`, `slot[0xA0]=0x60`, and rejoins inline at the
per-site join label (amendment 9.6).

### 15.3 While loop with `s.let` cells — sum 0..n−1

```ts
const sum = evscript({ name: 'sum', args: [t.uint256] }, (s, n) => {
  const total = s.let(t.uint256, 0n);
  const i = s.let(t.uint256, 0n);
  s.while(
    () => i.get().lt(n),
    () => {
      total.set(total.get().add(i.get()));
      i.set(i.get().add(1n));
    },
  );
  return s.return({ total: total.get() });
});
```

Frame: arg `n`→0x80; cells `total`→0xA0, `i`→0xC0; values v1(header `i.get`)→0xE0,
v2(lt)→0x100, v3(total.get)→0x120, v4(i.get)→0x140, v5(add)→0x160, v6(i.get)→0x180,
v7(add)→0x1A0, v8(the final `total.get`)→0x1C0; frameEnd 0x1E0 (the literals 0 and 1 fold —
no slots). The excerpt runs from the §8.1 arg decode through the loop; the §8.2 return encode
of v8 follows `@endwhile_13` and is elided. The header (`@while_13`, checked label, stack 0)
re-executes per iteration: v1 = i, v2 = v1 < n, exit on `ISZERO`. The body is two §15.1
checked-add statements bracketed by cell reads/writes; `PUSH1 0x01` is the folded literal.

<!-- docsync:begin while-loop -->

```
0x002a  6004        PUSH1 0x04  ; arg #0 head
0x002c  35          CALLDATALOAD
0x002d  6080        PUSH1 0x80
0x002f  52          MSTORE
0x0030  5f          PUSH0  ; cell 0 ←
0x0031  60a0        PUSH1 0xa0
0x0033  52          MSTORE
0x0034  5f          PUSH0  ; cell 1 ←
0x0035  60c0        PUSH1 0xc0
0x0037  52          MSTORE
@while_13:
0x0038  5b          JUMPDEST  ; @while_13
0x0039  60c0        PUSH1 0xc0  ; cell 1 →
0x003b  51          MLOAD
0x003c  60e0        PUSH1 0xe0 → @panic
0x003e  52          MSTORE
0x003f  6080        PUSH1 0x80  ; lt uint256
0x0041  51          MLOAD
0x0042  60e0        PUSH1 0xe0 → @panic
0x0044  51          MLOAD
0x0045  10          LT
0x0046  610100      PUSH2 0x0100
0x0049  52          MSTORE
0x004a  610100      PUSH2 0x0100  ; while cond
0x004d  51          MLOAD
0x004e  15          ISZERO
0x004f  6100a2      PUSH2 0x00a2 → @endwhile_13
0x0052  57          JUMPI
0x0053  60a0        PUSH1 0xa0  ; cell 0 →
0x0055  51          MLOAD
0x0056  610120      PUSH2 0x0120
0x0059  52          MSTORE
0x005a  60c0        PUSH1 0xc0  ; cell 1 →
0x005c  51          MLOAD
0x005d  610140      PUSH2 0x0140
0x0060  52          MSTORE
0x0061  610140      PUSH2 0x0140  ; checked add uint256
0x0064  51          MLOAD
0x0065  610120      PUSH2 0x0120
0x0068  51          MLOAD
0x0069  81          DUP2
0x006a  01          ADD
0x006b  80          DUP1
0x006c  91          SWAP2
0x006d  11          GT
0x006e  6100c4      PUSH2 0x00c4 → @panic_overflow
0x0071  57          JUMPI
0x0072  610160      PUSH2 0x0160
0x0075  52          MSTORE
0x0076  610160      PUSH2 0x0160  ; cell 0 ←
0x0079  51          MLOAD
0x007a  60a0        PUSH1 0xa0
0x007c  52          MSTORE
0x007d  60c0        PUSH1 0xc0  ; cell 1 →
0x007f  51          MLOAD
0x0080  610180      PUSH2 0x0180
0x0083  52          MSTORE
0x0084  6001        PUSH1 0x01  ; checked add uint256
0x0086  610180      PUSH2 0x0180
0x0089  51          MLOAD
0x008a  81          DUP2
0x008b  01          ADD
0x008c  80          DUP1
0x008d  91          SWAP2
0x008e  11          GT
0x008f  6100c4      PUSH2 0x00c4 → @panic_overflow
0x0092  57          JUMPI
0x0093  6101a0      PUSH2 0x01a0
0x0096  52          MSTORE
0x0097  6101a0      PUSH2 0x01a0  ; cell 1 ←
0x009a  51          MLOAD
0x009b  60c0        PUSH1 0xc0
0x009d  52          MSTORE
0x009e  610038      PUSH2 0x0038 → @while_13
0x00a1  56          JUMP
@endwhile_13:
0x00a2  5b          JUMPDEST  ; @endwhile_13
```

<!-- docsync:end -->

`loop.break()` lowers to `PUSH2 @endwhile_13 JUMP`; `loop.continue()` to `PUSH2 @while_13 JUMP`
(both legal at statement boundaries — stack is empty). The back-to-back `MSTORE/MLOAD` pairs
are the uniform-lowering tax (~60 gas/iteration; 10,000 iterations ≈ 1.4M gas — far inside
eth_call budgets [evm §4]) and the first documented peephole candidate, not v0.

## 16. Constraint → mechanism traceability (merged A §13 / B §14 / C §13 — living CI checklist)

| Constraint (source)                                                       | Mechanism (module)                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| RETURNDATACOPY OOB = exceptional halt, all gas [evm §2]                   | only `(0,0,rds)`/`(base,0,rds)` shapes; assembler shape lint (asm/verify)                                                                        |
| viem `code` executes as init code; raw runtime fails silently [viem §1.3] | `toViem()` only exposes `initBytecode` under `code`; fields named `runtimeBytecode`/`initBytecode`; deployless regression test (viem.ts, tests)  |
| JUMPDEST validity skips PUSH immediates [evm §3]                          | PUSH2-only label pushes + consensus-identical post-assembly scan (asm/verify)                                                                    |
| EIP-170 24,576 runtime / EIP-3860 init [evm §4]                           | `EvsCompileError` with per-region size breakdown (compile.ts)                                                                                    |
| eth_call gas caps: anvil 30M default, geth 50M floor [evm §4]             | harness/anvil pinned `--gas-limit 100000000`; docs state the 50M production floor                                                                |
| TSTORE/TLOAD/state-writes halt in static context [evm §1]                 | never emitted; shape lint blocklist (asm/verify). `CALL` admitted for `s.call`/`s.simulate` (`eth_call` never commits); `s.read` STATICCALL-pure |
| stack limit 1024 / DUP-SWAP reach 16 [evm §2]                             | empty-statement-boundary invariant + ≤16 template depth, machine-checked (asm/verify)                                                            |
| Panic encoding `0x4e487b71` + 36-byte payload [evm §5]                    | shared tails (§15.0), golden-tested byte-exact                                                                                                   |
| `−2^255 / −1` SDIV silent wrap [evm §5]                                   | explicit check → Panic 0x11 (§6)                                                                                                                 |
| sub-word MUL 256-bit wrap-back (N>128)                                    | div-back + range check (§6); boundary-matrix tests incl. wrap-past-2^256 cases                                                                   |
| UnionToTuple order instability [abitype §4.2]                             | ordered positional arg-type list inputs; t.struct → single named tuple → object; CI type regression (amended by #2)                              |
| empty component name degrades object→array [abitype §4.3]                 | recording-time rejection of empty return keys (builder)                                                                                          |
| viem ≥ 2.14.1 floor; type-volatile patches [viem §1.2, abitype §0]        | peerDeps floor; CI pins exact viem for type tests                                                                                                |
| anvil deployless constructor-return history [stack §3]                    | permanent pinned integration test on the `code` path                                                                                             |
| stateOverride undocumented on Alchemy/Infura [viem §4]                    | deployless is the `toViem()` default                                                                                                             |
| override `code` does not clear account state [viem §3.1]                  | vanity `DEFAULT_SCRIPT_ADDRESS`; scripts never SLOAD                                                                                             |
| warm/cold 2600/100 [evm §2]                                               | documented; no dedup in v0                                                                                                                       |
| ABIs must be inline or `as const` [prior-art §5]                          | `script.abi` is a literal-typed runtime value; any file emission is `.ts` `as const`                                                             |
| PyTeal silent-misuse / late sourcemaps [prior-art §2]                     | value semantics, throwing brands (+toJSON), locs on every node, sourceMap/disasm/explainRevert day one                                           |

## 17. Resolved flaws (every judged flaw, with its fix)

**Against A (adopted lessons / avoided defects):**

1. _Unsound sub-word checked MUL range-check claim_ → full width-dependent MUL spec with
   div-back for N>128 (§6), plus a boundary test matrix including wrap-past-2^256 cases.
2. _int256 SDIV `−2^255/−1` unhandled_ → explicit Panic 0x11 check specified (§6).
3. _No stack-height verification_ → assembler verification pass 2 with checked/'any' label
   classes (§10).
4. _Dispatcher missing `calldatasize ≥ 4+32·n`_ → explicit guard → `EvsInvalidCalldata` (§8.1).
5. _No data-segment kind (EIP-170 pressure)_ → `data`/`dataLabel` + INVALID guard (§10).
6. _"JSON.stringify not interceptable" false_ → throwing `toJSON` on handles (§3).
7. _Graceful widening dropped_ → viem-style widening adopted at every generic boundary (§7, api.md).
8. _Cell-extends-Expr implicit reads_ → explicit `Cell.get()`; Cell is not an Expr (§3).
9. _fn capture semantics unspecified_ → strict no-capture, `EvsScopeError` (§3, §9).
10. _Zero-arg unattributable decode errors_ → `EvsDecodeError(uint256 site)` + site table (§11).
11. _`s.select` missing_ → included (§3).
12. _Loop header/body region parentage unstated_ → body is a child of header (§3).
13. _vitest vs CLAUDE.md `bun test` contradiction_ → ruled: vitest via `bun run test`, deviation
    recorded with rationale (§0, testing.md §0).
14. _TempAllocator unpinned on a frozen boundary_ → no such type exists; scratch slots come from
    the pinned `FrameLayout`; every cross-module type is in module-interfaces.md.

**Against B:** 15. _deadCode drops reverting "pure" ops (live miscompile, default-on)_ → no LIR/DCE in v0; the
v1 pass contract carries "reverting ops are never dead" verbatim (§1). 16. _"range-check the full-width result" stated as the general sub-word rule_ → corrected MUL
table (§6). 17. _int256 SDIV edge unmentioned_ → specified (§6). 18. _constFold certain-panic hard error without escape hatch_ → moved to recording time with a
documented escape hatch (§3). 19. _optimizer on by default in v0_ → all passes off; peephole hook ships identity (§10). 20. _`EvsError(uint256)` numeric codes + TS name collision_ → named `EvsInvalidCalldata` /
`EvsDecodeError(site)`; no on-chain/TS name overlap (§11, §13). 21. _`s.cast` silent truncation_ → checked narrowing conversions; free widening; explicit
reinterprets only where lossless (§6). 22. _Stack fusion weakens the empty-stack invariant across agents_ → no fusion; uniform slots;
invariant machine-checked on final asm (§5, §10). 23. _Hand-rolled `Bun.spawn` anvil_ → prool + `VITEST_POOL_ID`, viem's production pattern
(testing.md §3). 24. _`s.for` hardwired to uint256_ → generic word-type ranges (api.md §7). 25. _`ScriptReturn` referenced but undefined_ → defined (api.md §9, module-interfaces §builder).

**Against C (the base — every judged flaw fixed in place):** 26. _§14.2 reads the head word with no `rds ≥ headSize` guard (stale-memory decode hole)_ →
B's staticMinSize guard emitted **before any head read**; worked example §15.2 re-verified
line by line. 27. \_Stack verifier inconsistent with multi-depth `@dfail\__`entries* → two-class label scheme
with`'any'` (relative, may-go-negative, must-terminate) semantics (§10). 28. *Script args restricted to word types (under-delivers locked scope)* → dynamic args
(`string`/`bytes`/`T[]`) decoded at dispatch with overflow-safe bounds checks (§8.1). 29. *break/continue deferred* → restored via scoped `LoopCtl` (§3). 30. *Strict returndata cleanup reverts where viem succeeds* → normalize-don't-revert on word
values; revert only on structural bounds failures (§7.2, §8.1). 31. *`debug: true`forks panic shapes/bytes (doubled test matrix, non-standard reverts)* →
removed; single standard`Panic`shape always;`explainRevert`degrades gracefully (§11). 32. *eq/neq word-only restriction as a comment* → this-parameter type constraint (§6, api.md). 33. *Largest v0 surface / stream imbalance / unpriced interpreter* → interpreter is its own
work unit; codegen split into two units; rebalanced plan (module-interfaces.md §plan). 34. *Diagnostics channel wobble* → pinned`onDiagnostic`callback; pure artifact (§13.3). 35. *§14.2 stack comment inversion (retSize/retOffset)* → corrected and hand-verified (§15.2:
retSize pushed first, retOffset above it, gas on top at STATICCALL). 36. *Bare`revert(0,0)`fallback\* → named`EvsInvalidCalldata()` (§11).

## 18. Deferred (v1 landing zones)

- **Optimizer**: tree→LIR lowering + `LirPass` pipeline (B's design as reference), behind
  `lowerProgram`; pass contract: reverting ops never dead, never reordered across
  calls/reverting ops. Cheap early wins: store-forward peephole, liveness slot reuse
  (weiroll-proven), constant-pool dedup, loop free-pointer reset (legal under the scope rule).
- **Tuples / structs**: SHIPPED by #2 (the `case 'tuple'` per emitter landed) — see §2.1, §5,
  §7.2, §8, and amendments.md §16.
- **One-level arrays of composite (`tuple[]`, `T[][]`, `string[]`/`bytes[]`)**: SHIPPED by the #2
  follow-up (the array-of-pointers layout + `emitDecodeArrayToMem`/`emitEncodeArrayTail` landed;
  `s.newArray`/`at()` admit them) — see §2.1, §5, §7.2, §8.3, and amendments.md §16.11.
- **Two-level arrays of tuples (`tuple[][]`), string arrays deeper than `[][]`, fixed arrays
  (`T[N]`)**: still deferred — one more nesting level on §8.3 / a separate `T[N]` codepath plus the
  builder wiring (`s.newArray` still gates them). The `TupleType`/`ArrayType` vocabulary already
  represents them, so it is additive; the recording-time `EvsTypeError('UNSUPPORTED_V0', …)` guard
  names the reached shape.
- **Split calls by mutability**: SHIPPED by #1 (`s.read`/`s.tryRead` STATICCALL, `s.call`/
  `s.tryCall` CALL value 0, `s.simulate`/`s.trySimulate` self-call + revert trampoline) — see
  §7, §11. Open follow-ups: **nested `s.simulate`**, an **explicit gas cap on the inner CALL**,
  **`msg.sender` on the self-call hop**, and decoding a QuoterV1-style revert payload AS the
  `s.tryCall` result (today `s.tryCall` only reports `success = false` on the revert).
- **Overload disambiguation** (`ExtractAbiFunctionForArgs`), **dynamic-length stack of args >
  word count**, **`s.rawCall({to, data})`** typed escape hatch, **recursion** (FP-relative
  slots confined to codegen), **single named-tuple input option** for many-arg scripts,
  **`s.keccak256`/env extensions**, **generator sugar** (locked out).
