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
- **Args decision (unanimous)**: option (c) ordered `arg()` declarator tuple. See §2.1.

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
type ArrayType = `${WordType}[]`
type EvsType   = WordType | DynType | ArrayType
type ArgType   = EvsType                                // dynamic script args ARE in v0 (§8.1)
```

Fixed-size arrays `T[N]` and nested tuples are **out of v0** (recording-time `EvsTypeError`
with the deferral spelled out; the ABI emitters are recursive over `PlainAbiParam` trees so
adding them later is a capability unlock, not a rewrite — §8).

### 2.1 Args declaration (decision 1 — final)

**Option (c): ordered `arg()` declarators.** `args` is a readonly tuple of `ArgSpec`s, so
declaration order, type-level order, runtime encode order, and ABI `inputs` order are the same
object. The `UnionToTuple` interning hazard [abitype §4.2] is structurally impossible: no
record→tuple conversion exists on the input path. `s.args` is derived tuple→record (the safe
direction). Output side (settled): one output `{ name: 'result', type: 'tuple', components }`
from the `s.return({...})` record keys; type-level component order may differ from runtime
insertion order, harmlessly, because viem infers an **object** from a fully-named single tuple
output [abitype §4.2 row 1, §4.3 rule 4]. Empty-string return keys are rejected at recording.
A CI type test pins `ReadContractParameters<abi,n>['args']` and `ReadContractReturnType<abi,n>`
for representative scripts, including the §4.2 interning-regression scenario.

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
  **non-throwing** (`Expr<address> #4 ← s.call(token0) at pools.ts:9:18`) — printing is
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
  | arrnew    { elem: WordType, length: ValueId, out }   // zero-filled; Panic 0x41 on len ≥ 2^32
  | arrset    { arr, i, value }                 // bounds-checked → Panic 0x32
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
  raw bytes zero-padded; arrays: one canonical word per element).
- **Transient scratch**: sub-call calldata is built at `MLOAD(0x40)` **without bumping** (dead
  after the call). Consequence: memory above the free pointer is **not** guaranteed zero — the
  return encoder zero-pads dynamic tails explicitly, and `arrnew` zero-fills via
  `CALLDATACOPY(dst, CALLDATASIZE, size)` (reads past calldata end are zero-padded [evm §2]).
- **Allocation**: `ptr := MLOAD(0x40); MSTORE(0x40, ptr + ceil32(size))`. Never freed. Loop
  allocations grow memory monotonically; `compile()` emits a `LOOP_ALLOCATION` diagnostic via
  the pinned `onDiagnostic` callback (§13.3) when a `call` with outputs, `arrnew`, or a dynamic
  literal materialization sits inside a `while` body.

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

Surface mirrors `readContract` (signatures in `api.md` §6): `s.call`/`s.tryCall` with
`{ address, abi, functionName, args?, gas? }`; abitype generics with viem's graceful-widening,
`[never]` guards, and the `functionName: name | AllNames` autocomplete union [abitype §2].
Overloaded names are rejected at recording (v0); `ExtractAbiFunctionForArgs` is the documented
later fix. Output/arg types outside the v0 `EvsType` set → recording-time `EvsTypeError`.

### 7.1 Calldata build — `CalldataTemplate`

Compile-time template per call: `const` segments (selector + every literal arg, pre-encoded with
viem `encodeFunctionData`/`encodeAbiParameters` and merged), `word` segments (runtime word arg →
MSTORE at its head offset), `dyn` segments (runtime `string`/`bytes`/`T[]` arg → head offset
word + tail copied from the memref via MCOPY, with explicit zero-padding of the last word).
All-literal calls collapse to **one const segment**: ≤ 96 bytes → PUSH32-chunked MSTOREs;
larger → **data segment + CODECOPY** (B's §9 convention, §10 below). Buffer at transient
scratch `MLOAD(0x40)`, not bumped.

### 7.2 The call, bubbling, decode

1. `STATICCALL(gas(), addr, buf, argsSize, 0, 0)` — `retSize 0` always; returndata is fetched
   uniformly via RETURNDATACOPY (no `min(retSize, rds)` partial-copy trap). Optional `gas` cap
   operand; default forward-all (EIP-150 63/64 applies).
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
6. **Decode-fail target**: strict mode → per-site stub
   `@dfail_<site>: JUMPDEST PUSH<k> site PUSH2 @decode_revert JUMP`; shared tail reverts
   `EvsDecodeError(uint256 site)` (declared in the generated ABI; `explainRevert`/`sourceMap.sites`
   maps the site to "decoding `symbol()` returndata recorded at pools.ts:9:18").
   Try mode → the call's `@zero_<site>` block: `successOut = 0`, word outs = 0, memref outs =
   `0x60` (zero slot ⇒ empty); a failed STATICCALL takes the same block. `tryCall.success` is
   false on call failure **or** malformed returndata; `value` is always safe to use (documented
   divergence from Solidity try/catch).

**RETURNDATACOPY invariant (named, machine-checked)**: the compiler only ever emits the two
intrinsically safe shapes `(0, 0, rds)` and `(base, 0, rds)` — `offset = 0, size = RETURNDATASIZE`
can never exceed the buffer, so the all-gas-consuming OOB halt [evm §2] is unreachable **by
construction**, enforced by an assembler lint (§10): every `RETURNDATACOPY` must be immediately
preceded by the node window `RETURNDATASIZE, PUSH0, (PUSH0 | DUPn)`.

Warm/cold note: first STATICCALL per address costs 2600, later 100 [evm §2]; documented, no
dedup in v0.

## 8. ABI encode/decode codegen (decision 7)

One module (`codegen/abi.ts`) owns all four directions, written recursively over
`PlainAbiParam` trees so nested tuples later are a new `case 'tuple':` per emitter plus removal
of the recording-time guard — no other module changes.

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

### 8.2 Return-tuple encode (single named tuple; dynamic members supported)

Outputs are `[{ name:'result', type:'tuple', components }]`. Two-pass head/tail emitted as
straight-line code from the compile-time component walk:

1. `out = MLOAD(0x40)`. If any component is dynamic, `MSTORE(out, 0x20)` (top-level offset) and
   `base = out + 0x20`; else components encode inline at `base = out` (both shapes decode
   identically in viem).
2. Heads at `base`: word components stored verbatim (slots are canonical); dynamic components
   get the running tail offset (relative to `base`).
3. Tails in component order: `MSTORE(tail, len)`; payload via `MCOPY` (pre-Cancun: shared
   `@memcpy` word-loop subroutine); **explicit zero-pad** `MSTORE(tail + 32 + len, 0)` before
   the copy bookkeeping (memory above the free pointer is not guaranteed zero — §5).
4. `RETURN(out, total)`.

Differential anchor: emitted encoder/decoder vs viem `encodeAbiParameters` /
`decodeFunctionResult` byte-equality on a fuzzed matrix (testing.md §4).

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
     `LOG*`/`CREATE*`/`SELFDESTRUCT`/`CALL`/`DELEGATECALL`/`CALLCODE` never appear (STATICCALL-
     clean by construction); EIP-170 size ≤ 24,576 → `EvsCompileError` with a per-region
     breakdown (body / fns / tails / data segments — C's actionable variant).
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
prologue:   PUSH2 frameEnd PUSH1 0x40 MSTORE
dispatch:   PUSH1 0x04 CALLDATASIZE LT PUSH2 @badcd JUMPI
            PUSH0 CALLDATALOAD PUSH1 0xE0 SHR
            PUSH4 <selector> EQ PUSH2 @main JUMPI
@badcd:     JUMPDEST                                  ; EvsInvalidCalldata() — named, zero-arg
            PUSH4 <sel(EvsInvalidCalldata())> PUSH1 0xE0 SHL PUSH0 MSTORE
            PUSH1 0x04 PUSH0 REVERT
@main:      JUMPDEST
            <cds ≥ 4+32·n guard → @badcd> <arg decode (§8.1)>
            <body statement templates>
            <return encode (§8.2)> RETURN
@fn_*:      <subroutines (§9)>
@memcpy:    <shared word-loop — only if evmVersion < cancun AND any copy emitted>
@panic_overflow/@panic_divzero/@panic_bounds/@panic_alloc → @panic:  <shared Panic tail (§15.0)>
@dfail_*:   <per-site stubs> → @decode_revert: <EvsDecodeError(site) tail>
@zero_*:    <tryCall zeroing blocks>
INVALID     <data segments (dataLabel-addressed blobs)>
```

Single function ⇒ single selector compare. Selector = viem `toFunctionSelector` over
`name(argTypes…)` (inputs only; the tuple output does not affect it). Tails are emitted lazily
(only the codes actually referenced). The fallback is the **named** `EvsInvalidCalldata()` (A
graft) — viem decodes it from the generated ABI instead of a bare `revert(0,0)`.

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

Validate at recording wherever the information exists at recording (almost everywhere — `s.call`
sees its ABI fragment immediately). Every message speaks user vocabulary with `file:line:col`
from `captureLoc()`, plus `relatedLocs` when two sites are involved (PyTeal lesson). Compile
time is reserved for whole-program facts. The full recording-time checklist is pinned in
`module-interfaces.md` §builder.

### 13.3 Diagnostics channel (pinned — resolves C's wobble)

`EvsDiagnostic = { severity: 'warning'; code: 'LOOP_ALLOCATION' | 'LARGE_FRAME'; message: string;
loc: SourceLoc | null }`, delivered only via `CompileOptions.onDiagnostic`. The artifact stays
pure; nothing is logged by default.

## 14. PC→source map and disassembler

`SourceMap = { version: 1, segments: [{pc, len, loc, note?}] (sorted, non-overlapping),
sites: [{id, kind: 'panic'|'decode'|'call'|'stmt', loc, detail}], labels: [{pc, name}] }`.
`lookupPc(map, pc)` for trace decoration; `sites` powers `explainRevert` and the
`EvsDecodeError(site)` round-trip. `disassemble(bytecode, sourceMap?)` works on raw bytes
(usable on foreign bytecode), annotates labels/locs/notes, and `format()` output is the golden
snapshot format. The honesty rule: every documented listing is real compiler output.

## 15. Worked codegen examples (hand-verified against [evm §2])

Conventions: stack comments list **top first**; `slot[X]` is frame memory; `@x` = PUSH2-fixup
label. These are the v0 compiler's actual output shape — no optimization shown that the
compiler does not perform.

### 15.0 Shared panic tail (emitted once; stack class `'any'`)

```
@panic_overflow: JUMPDEST  PUSH1 0x11  PUSH2 @panic  JUMP
@panic_divzero:  JUMPDEST  PUSH1 0x12  PUSH2 @panic  JUMP
@panic_bounds:   JUMPDEST  PUSH1 0x32  PUSH2 @panic  JUMP
@panic_alloc:    JUMPDEST  PUSH1 0x41  PUSH2 @panic  JUMP
@panic:          JUMPDEST                 ; [code, …dead]
  PUSH4 0x4e487b71  PUSH1 0xE0  SHL       ; [selWord, code]
  PUSH0  MSTORE                           ; MSTORE pops offset=0, value=selWord    [code]
  PUSH1 0x04  MSTORE                      ; mem[4..36) = code                      []
  PUSH1 0x24  PUSH0  REVERT               ; revert(offset=0, size=36) — Panic(code)
```

`@decode_revert` is the same shape with `PUSH4 <sel(EvsDecodeError(uint256))>` and the site id
pushed by the per-site stub; `@badcd` is the 4-byte-payload variant (`revert(0, 4)`).

### 15.1 Checked ADD (uint256) — `const c = a.add(b)`; a→`0x80`, b→`0xA0`, c→`0xC0`

```
PUSH1 0xA0  MLOAD          ; [b]
PUSH1 0x80  MLOAD          ; [a, b]
DUP2                       ; [b, a, b]
ADD                        ; [r, b]            r = a+b (wrapping)
DUP1                       ; [r, r, b]
SWAP2                      ; [b, r, r]
GT                         ; [b>r, r]          overflow ⇔ r < b
PUSH2 @panic_overflow
JUMPI                      ; [r]
PUSH1 0xC0  MSTORE         ; []                slot[0xC0] = r
```

Net stack 0 (the statement-boundary invariant §10 checks). Width variants per §6: `uintN<256`
replaces the GT-check with `r > maxN`; `intN<256` uses the SIGNEXTEND fixpoint; `int256` the
solc sign-case formula.

### 15.2 STATICCALL `symbol()` → dynamic string (the decode-soundness graft applied)

`token0`→`0x80`; result memref `symbol0`→`0xA0`; site id 7. Calldata is all-literal after
folding (selector only).

```
; -- build calldata at transient scratch (free ptr NOT bumped) --------------------
PUSH1 0x40  MLOAD               ; [buf]
PUSH4 0x95d89b41  PUSH1 0xE0  SHL                 ; [selWord, buf]
DUP2  MSTORE                    ; [buf]            mem[buf..buf+32) = selector word

; -- staticcall(gas(), token0, buf, 4, 0, 0) --------------------------------------
PUSH0                           ; [retSize=0, buf]
PUSH0                           ; [retOff=0, retSize, buf]
PUSH1 0x04                      ; [argsSize=4, retOff, retSize, buf]
DUP4                            ; [argsOff=buf, 4, 0, 0, buf]
PUSH1 0x80  MLOAD               ; [token0, argsOff, argsSize, retOff, retSize, buf]
GAS                             ; [gas, token0, …, buf]
STATICCALL                      ; [success, buf]
PUSH2 @ok_7  JUMPI              ; [buf]

; -- failure: bubble callee revert verbatim (RETURNDATACOPY shape 1) ---------------
RETURNDATASIZE  PUSH0  PUSH0    ; [dest=0, off=0, size=rds, buf]
RETURNDATACOPY                  ; [buf]
RETURNDATASIZE  PUSH0  REVERT   ; revert(0, rds)

@ok_7: JUMPDEST                 ; [buf]  (label stack=1)
; -- HEAD-SIZE GUARD before any decode read: rds ≥ 32·nOutputs = 0x20 --------------
RETURNDATASIZE  PUSH1 0x20  GT  ; [0x20 > rds, buf]
PUSH2 @dfail_7  JUMPI           ; [buf]

; -- snapshot ENTIRE returndata at buf (RETURNDATACOPY shape 2), bump free ptr -----
RETURNDATASIZE  PUSH0  DUP3     ; [dest=buf, off=0, size=rds, buf]
RETURNDATACOPY                  ; [buf]
RETURNDATASIZE  PUSH1 0x1F  ADD
PUSH1 0x1F  NOT  AND            ; [ceil32(rds), buf]
DUP2  ADD  PUSH1 0x40  MSTORE   ; [buf]            freePtr = buf + ceil32(rds)

; -- decode dynamic head: off ≤ 2^64−1, off+32 ≤ rds --------------------------------
DUP1  MLOAD                     ; [off, buf]        safe: rds ≥ 32 established above
PUSH8 0xffffffffffffffff  DUP2  GT                  ; [off > 2^64−1, off, buf]
PUSH2 @dfail_7  JUMPI           ; [off, buf]
DUP1  PUSH1 0x20  ADD           ; [off+32, off, buf]
RETURNDATASIZE  LT              ; [rds < off+32, off, buf]
PUSH2 @dfail_7  JUMPI           ; [off, buf]
; -- ptr = buf+off; len checks: len ≤ 2^64−1, off+32+len ≤ rds ----------------------
DUP2  ADD                       ; [ptr, buf]
DUP1  MLOAD                     ; [len, ptr, buf]
PUSH8 0xffffffffffffffff  DUP2  GT  PUSH2 @dfail_7  JUMPI    ; [len, ptr, buf]
DUP2  PUSH1 0x20  ADD  ADD      ; [end = ptr+32+len, ptr, buf]
RETURNDATASIZE  DUP4  ADD       ; [buf+rds, end, ptr, buf]
LT                              ; [buf+rds < end, ptr, buf]
PUSH2 @dfail_7  JUMPI           ; [ptr, buf]
PUSH1 0xA0  MSTORE              ; [buf]             slot[0xA0] = ptr (memref aliases snapshot)
POP                             ; []

; -- elsewhere ---------------------------------------------------------------------
@dfail_7:       JUMPDEST  PUSH1 0x07  PUSH2 @decode_revert  JUMP        ; ('any')
@decode_revert: JUMPDEST  <EvsDecodeError(site) tail — §15.0 shape>
```

Every head word read happens **after** `rds ≥ 32·nOutputs` is established — no stale-memory
read exists on any path (the resolved C §14.2 hole). The string body is never copied twice.
`tryCall` variant: the post-STATICCALL `JUMPI` inverts to the `@zero_7` block and `@dfail_7`
jumps there too; `@zero_7` sets `success=0`, `slot[0xA0]=0x60`, falls through.

### 15.3 While loop with `s.let` cells — sum 0..n−1 with break support

```ts
const total = s.let(t.uint256, 0n);
const i = s.let(t.uint256, 0n);
s.while(
  () => i.get().lt(s.args.n),
  (loop) => {
    total.set(total.get().add(i.get()));
    i.set(i.get().add(1n));
  },
);
```

Frame: `n`→0x80, `total`→0xA0, `i`→0xC0; values v1(i.get)→0xE0, v2(lt)→0x100,
v3(total.get)→0x120, v4(i.get)→0x140, v5(add)→0x160, v6(i.get)→0x180, v7(add)→0x1A0
(literals 0 and 1 fold — no slots).

```
PUSH0  PUSH1 0xA0  MSTORE               ; cell total = 0
PUSH0  PUSH1 0xC0  MSTORE               ; cell i = 0
@while_1: JUMPDEST                      ; header (label stack=0) — re-executed per iteration
  PUSH1 0xC0 MLOAD  PUSH1 0xE0 MSTORE   ; v1 = i
  PUSH1 0x80 MLOAD                      ; [n]          right operand first
  PUSH1 0xE0 MLOAD                      ; [v1, n]      left on top
  LT                                    ; [v1 < n]
  PUSH1 0x100 MSTORE                    ; v2 = cond
  PUSH1 0x100 MLOAD  ISZERO
  PUSH2 @endwhile_1  JUMPI
  ; body: total.set(total.get().add(i.get()))
  PUSH1 0xA0 MLOAD  PUSH1 0x120 MSTORE  ; v3 = total
  PUSH1 0xC0 MLOAD  PUSH1 0x140 MSTORE  ; v4 = i
  PUSH1 0x140 MLOAD                     ; [b = v4]
  PUSH1 0x120 MLOAD                     ; [a = v3, b]
  DUP2 ADD DUP1 SWAP2 GT                ; [b>r, r]     checked add (§15.1 core)
  PUSH2 @panic_overflow JUMPI           ; [r]
  PUSH1 0x160 MSTORE                    ; v5 = r
  PUSH1 0x160 MLOAD  PUSH1 0xA0 MSTORE  ; total = v5
  ; i.set(i.get().add(1))
  PUSH1 0xC0 MLOAD  PUSH1 0x180 MSTORE  ; v6 = i
  PUSH1 0x01                            ; [b = 1]      folded literal
  PUSH1 0x180 MLOAD                     ; [a = v6, b]
  DUP2 ADD DUP1 SWAP2 GT
  PUSH2 @panic_overflow JUMPI           ; [r]
  PUSH1 0x1A0 MSTORE                    ; v7 = r
  PUSH1 0x1A0 MLOAD  PUSH1 0xC0 MSTORE  ; i = v7
  PUSH2 @while_1  JUMP
@endwhile_1: JUMPDEST                   ; (label stack=0)
```

`loop.break()` lowers to `PUSH2 @endwhile_1 JUMP`; `loop.continue()` to `PUSH2 @while_1 JUMP`
(both legal at statement boundaries — stack is empty). The back-to-back `MSTORE/MLOAD` pairs
are the uniform-lowering tax (~60 gas/iteration; 10,000 iterations ≈ 1.4M gas — far inside
eth_call budgets [evm §4]) and the first documented peephole candidate, not v0.

## 16. Constraint → mechanism traceability (merged A §13 / B §14 / C §13 — living CI checklist)

| Constraint (source)                                                       | Mechanism (module)                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| RETURNDATACOPY OOB = exceptional halt, all gas [evm §2]                   | only `(0,0,rds)`/`(base,0,rds)` shapes; assembler shape lint (asm/verify)                                                                       |
| viem `code` executes as init code; raw runtime fails silently [viem §1.3] | `toViem()` only exposes `initBytecode` under `code`; fields named `runtimeBytecode`/`initBytecode`; deployless regression test (viem.ts, tests) |
| JUMPDEST validity skips PUSH immediates [evm §3]                          | PUSH2-only label pushes + consensus-identical post-assembly scan (asm/verify)                                                                   |
| EIP-170 24,576 runtime / EIP-3860 init [evm §4]                           | `EvsCompileError` with per-region size breakdown (compile.ts)                                                                                   |
| eth_call gas caps: anvil 30M default, geth 50M floor [evm §4]             | harness/anvil pinned `--gas-limit 100000000`; docs state the 50M production floor                                                               |
| TSTORE/TLOAD/state-writes halt in static context [evm §1]                 | never emitted; shape lint blocklist (asm/verify)                                                                                                |
| stack limit 1024 / DUP-SWAP reach 16 [evm §2]                             | empty-statement-boundary invariant + ≤16 template depth, machine-checked (asm/verify)                                                           |
| Panic encoding `0x4e487b71` + 36-byte payload [evm §5]                    | shared tails (§15.0), golden-tested byte-exact                                                                                                  |
| `−2^255 / −1` SDIV silent wrap [evm §5]                                   | explicit check → Panic 0x11 (§6)                                                                                                                |
| sub-word MUL 256-bit wrap-back (N>128)                                    | div-back + range check (§6); boundary-matrix tests incl. wrap-past-2^256 cases                                                                  |
| UnionToTuple order instability [abitype §4.2]                             | ordered ArgSpec tuple inputs; single named-tuple output → object; CI type regression                                                            |
| empty component name degrades object→array [abitype §4.3]                 | recording-time rejection of empty return keys (builder)                                                                                         |
| viem ≥ 2.14.1 floor; type-volatile patches [viem §1.2, abitype §0]        | peerDeps floor; CI pins exact viem for type tests                                                                                               |
| anvil deployless constructor-return history [stack §3]                    | permanent pinned integration test on the `code` path                                                                                            |
| stateOverride undocumented on Alchemy/Infura [viem §4]                    | deployless is the `toViem()` default                                                                                                            |
| override `code` does not clear account state [viem §3.1]                  | vanity `DEFAULT_SCRIPT_ADDRESS`; scripts never SLOAD                                                                                            |
| warm/cold 2600/100 [evm §2]                                               | documented; no dedup in v0                                                                                                                      |
| ABIs must be inline or `as const` [prior-art §5]                          | `script.abi` is a literal-typed runtime value; any file emission is `.ts` `as const`                                                            |
| PyTeal silent-misuse / late sourcemaps [prior-art §2]                     | value semantics, throwing brands (+toJSON), locs on every node, sourceMap/disasm/explainRevert day one                                          |

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
- **Nested tuples / fixed arrays**: delete the recording-time guards; add `case 'tuple'` /
  fixed-array cases to the recursive emitters; `PlainAbiParam` is already a tree.
- **Overload disambiguation** (`ExtractAbiFunctionForArgs`), **dynamic-length stack of args >
  word count**, **`s.rawCall({to, data})`** typed escape hatch, **recursion** (FP-relative
  slots confined to codegen), **single named-tuple input option** for many-arg scripts,
  **`s.keccak256`/env extensions**, **generator sugar** (locked out).
