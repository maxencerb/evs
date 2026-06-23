# evs — Design-Doc Amendments (consolidated deviations)

Status: ACCEPTED unless marked otherwise. This document consolidates the 61 deviation reports
filed by the 12 implementation agents (formerly `docs/design/deviations-raw.json`, now
deleted) plus 3 integration-phase amendments. Each entry: law reference → what shipped →
rationale → status. Load-bearing claims were spot-checked against the code by the integration
agent (see the final section).

Legend: **accepted** = the law is amended to match the shipped behavior. **follow-up needed**
= shipped behavior stands for now, but a named owner has remaining work.

---

## 1. repo-infrastructure (U13)

### 1.1 release.yml step name quoting

- Law: repo-layout §10 — step `- name: Pack (bun rewrites workspace:/catalog: protocols)`.
- Shipped: the same string, quoted.
- Rationale: the spec line is invalid YAML (`: ` inside a plain scalar); Actions would reject
  it. Semantics identical (verified by parsed-YAML deep-equality).
- Status: **accepted**.

### 1.2 Root `vitest.config.ts` re-roots package projects

- Law: repo-layout §8 — `projects: ['packages/*/vitest.config.ts']`.
- Shipped: the root config imports `packages/evs/vitest.config.ts` and re-roots its three
  inline projects (`root: './packages/evs'`).
- Rationale: vitest 3.2 registers a referenced config as ONE opaque project and silently
  ignores its nested `projects`, so `--project unit` matches nothing from the root (verified
  empirically). The package config remains the single source of truth (testing.md §1).
- Status: **accepted**. Verified at integration: `unit`/`types`/`integration` all register
  from the root and `bun run test` runs 1049 tests green.

### 1.3 Root devDependency `@types/node`

- Law: repo-layout §2 exact root `package.json` (no `@types/node`).
- Shipped: `@types/node ^24.0.0` added.
- Rationale: node globals (`process.env.VITEST_POOL_ID` etc.) in test/harness code; matches
  the CI node 24 pin; tsc's upward `@types` lookup reaches `packages/evs` from the root.
- Status: **accepted**.

### 1.4 oxfmt canonicalization of spec-listed JSON/YAML

- Law: repo-layout §2/§3/§9/§10 literal file contents.
- Shipped: oxfmt (with the spec-mandated `sortPackageJson: true`) re-sorted package.json keys
  and normalized YAML quoting/layout. Workflows verified semantically identical; the
  `//publishConfig` comment key preserved.
- Rationale: `fmt:check` passing is itself a spec/CI requirement; the formatter's output is
  the canonical form.
- Status: **accepted**.

### 1.5 `.gitignore` extras

- Law: repo-layout §11 entries.
- Shipped: all spec entries plus local-noise entries (`.env*`, `*.tsbuildinfo`, `.idea`,
  `.DS_Store`).
- Status: **accepted**.

### 1.6 `examples/pool-meta/index.ts` placeholder

- Law: repo-layout §1 + api.md E1/E2 — runnable example scripts.
- Shipped: a throwing placeholder (comment-only/`export {}` forms fail oxlint under
  `--deny-warnings`).
- Rationale: the examples could not exist before `@maxencerb/evs` landed.
- Status: **follow-up needed** — the U12 integration agent must replace the placeholder with
  the real E1 `poolMeta` / E2 `balances` scripts (testing.md §4.1 runs the differential suite
  over every `examples/` script, and §7 uses E1/E2 as the release gate).

---

## 2. contracts (U11)

### 2.1 Local ambient `Bun` type in `scripts/codegen.ts`

- Law: module assignment — codegen runs under `bun scripts/codegen.ts`; no package.json edits.
- Shipped: a minimal local `declare const Bun` (only `$`/`file`/`write`) instead of importing
  `bun-types`.
- Rationale: `bun-types` is not a workspace dependency and adding one was forbidden;
  type-aware oxlint hard-errors on an untyped `Bun`. Runtime behavior identical.
- Status: **accepted**.

### 2.2 forge tests instead of the generic vitest quality gate

- Law: CLAUDE.md (`bun test`) and the generic per-module vitest gate.
- Shipped: `forge build` + `forge test` (69/69) + codegen idempotency as the module gate.
- Rationale: testing.md §0 already records the repo-wide runner deviation; the contracts
  module's tests are Solidity tests by assignment.
- Status: **accepted**. Re-verified at integration: forge build/test green, codegen run twice
  → `git diff` clean.

### 2.3 Removed populated-directory `.gitkeep` files

- Law: none (scaffolding artifacts).
- Status: **accepted**.

---

## 3. core (M1)

### 3.1 `captureLoc` lazy-vs-null contradiction

- Law: module-interfaces §M1 `core/loc.ts` — "parses lazily on first property access" AND
  "returns null when unparseable".
- Shipped: returns `null` eagerly when no stack string exists; when the lazily-parsed stack
  yields no acceptable frame, getters resolve to the sentinel
  `{ file: '<unknown>', line: 0, column: 0 }`.
- Rationale: both law clauses are simultaneously unsatisfiable; a getter cannot retroactively
  turn the object into `null`.
- Status: **accepted**.

### 3.2 Frame-skip exemption for test files

- Law: §M1 — skip frames "inside @maxencerb/evs (dist or src)".
- Shipped: `*.test.ts`/`*.test-d.ts`/`*.spec.*` files are exempt from the skip.
- Rationale: M1's own pinned tests live in `src/` and assert locs; test files are consumers.
- Status: **accepted**.

### 3.3 `installStagingTraps` internal export

- Law: §M1 freezes core's export list; trap behavior is assigned to M5.
- Shipped: `@internal` helper in `core/types.ts` (NOT re-exported from `index.ts`); M5 reuses
  it.
- Rationale: the core assignment required implementing + testing the traps; an internal
  helper avoids duplication without extending the public surface.
- Status: **accepted**.

### 3.4 `Address` re-export from `core/types.ts`

- Law: §M1 conventions block says "Address is re-exported from abitype" but the literal M1
  export list omits it.
- Shipped: `export type { Address } from 'abitype'`.
- Status: **accepted** (the conventions block governs).

### 3.5 `compile.ts` ↔ `builder/script.ts` type-only cycle

- Law: §M9 allowed-imports omits `builder`.
- Shipped: `compile.ts` imports builder **types only**; builder accesses the `compile`
  function via a namespace import (for the `.compile()` sugar). oxlint `import/no-cycle` is
  clean.
- Rationale: `compile<s>` needs `EvsScript` while builder needs
  `CompileOptions`/`CompiledEvsScript`; the law's own signatures force both edges.
- Status: **accepted**.

### 3.6 `CompiledOf` uses constrained `infer`

- Law: §M9 writes bare `infer n`.
- Shipped: `infer n extends string` etc.
- Rationale: bare infer does not satisfy the generic constraints under strict tsc; minimal
  compiling form.
- Status: **accepted**.

### 3.7 Local structural `SiteId` twin in `asm/sourcemap.ts`

- Law: §M4 types `SourceMap.sites` with `SiteId`, but asm may not import `ir/`.
- Shipped: local non-exported `type SiteId = number` (structurally identical).
- Status: **accepted**.

### 3.8 Day-0 stubs that could not be literally declare-only

- Law: work-plan note — type-only stubs (`export declare`) for M2–M9.
- Shipped: `index.ts` as re-exports; `builder/args.ts` as the real `export { arg, t }`;
  `builder/expr.ts` as a commented placeholder; law-referenced-but-undefined type machinery
  (`ReturnSpecToComponents`, `ViewMutability`, `SubcallParams`/`Inputs`/`Outputs`,
  `UnwrapSingle`, `EnvKind`/`EnvTypeOf`, `FnReturn`/`EvsFn`/`RebuildExprs` per api.md §4/§6/§8)
  defined in the stubs.
- Status: **accepted** (superseded by the real modules; the type machinery definitions
  remain the canonical ones).

### 3.9 `EvsInternalError` enforces its message invariant in the constructor

- Law: §M1 shows an empty subclass body but mandates the message contain
  "bug in evs, please report".
- Shipped: constructor appends the phrase when missing.
- Status: **accepted**.

---

## 4. evm-harness (M10/U5)

### 4.1 Harness self-test runner

- Law: testing.md §1 pins the `unit` project include to `src/**/*.test.ts`, leaving
  `test/harness/evm.test.ts` unrunnable; the module agent parked a standalone
  `test/harness/vitest.harness.config.ts`.
- Shipped (integration phase, supersedes the standalone config): the `unit` project include
  in `packages/evs/vitest.config.ts` is extended to
  `['src/**/*.test.ts', 'test/harness/**/*.test.ts']`; the standalone config is deleted.
- Rationale: the harness self-tests run on the in-process `@ethereumjs/evm` (no anvil), so
  they belong to the unit tier; the `integration` project (`test/integration/**`) is
  untouched. `bun run test` now exercises them (11/11 green, 1049 total).
- Status: **accepted** (testing.md §1's "exact" config is amended accordingly).

### 4.2 `test/global-setup.ts` ownership

- Law: ownership glob said `test/harness/**`, but §M10 lists `test/global-setup.ts` as an
  M10 file.
- Shipped: implemented verbatim per testing.md §3 (prool Server + `Instance.anvil`,
  chainId 31337, hardfork 'Prague', gasLimit 100M, port 8545).
- Status: **accepted**. Verified at integration: module resolves; default export is a
  function; the `integration` project registers it.

### 4.3 Extra named exports beyond the pinned M10 surface

- Law: §M10 freezes `execRuntime`/`EvmFixture`/`poolId`/`rpcUrl`/`publicClient`/`testClient`/
  global-setup default.
- Shipped additionally: `SCRIPT_ADDRESS`, `CALLER_ADDRESS`, `DEFAULT_GAS_LIMIT`,
  `hexToBytes`, `bytesToHex` (evm.ts) and the `fixtures.ts` corpus (RUNTIME\_\*, returner/
  reverter builders, `ATTACKER_RETURNERS`).
- Rationale: unpublished test infra; `fixtures.ts` itself is mandated by testing.md §2;
  frozen signatures unchanged.
- Status: **accepted**.

---

## 5. abi (M3)

### 5.1 `headBytes` validates param types

- Law: §M3 — "32 × params.length in v0".
- Shipped: additionally validates each param through `layoutOf` (tuple/T[N] fail loudly with
  `EvsTypeError`). Signature unchanged.
- Status: **accepted**.

### 5.2 `buildScriptAbi` defensive validation

- Law: §M3 — "runtime mirror" with ordering rules only.
- Shipped: identifier/duplicate/v0-type validation throwing `EvsTypeError` with codes
  `ABI_SHAPE`/`UNSUPPORTED_V0`/`TYPE_MISMATCH`.
- Rationale: research abitype-typing §4.3 — an empty component name silently degrades viem's
  object inference to a positional array.
- Status: **accepted**.

### 5.3 Literal encoders built on viem

- Law: §M3 test obligation reads "literal encoders differential vs viem" (implying
  independence) while the preamble mandates "encodeLiteral\* via viem peer".
- Shipped: encoders wrap viem `encodeAbiParameters` after evs-side validation/coercion
  (api.md §3); differentials exercise the coercion/memref layers, complemented by
  hand-written byte goldens so the suite is not tautological. Addresses are lowercased before
  viem (api.md §3: checksum NOT enforced).
- Status: **accepted**.

---

## 6. ir (M2)

### 6.1 Positional arg→value binding (load-bearing, cross-module)

- Law: §M2 `ScriptIr.args` carries no ValueId and no "load arg" stmt kind exists.
- Shipped: script args bind positionally to `values[0 … args.length−1]` (types must match;
  ids predefined in the main scope). Documented in `ir/validate.ts`.
- Status: **accepted**. **Spot-checked at integration**: builder (`Recorder` constructor
  allocates one value per arg, in order, before anything else — `builder/expr.ts`), interp
  (`ir.args.forEach((a, i) => values.set(i, …))` — `ir/interp.ts`), and codegen
  (`frame.ts` assigns slots to ValueIds `0…nargs−1` first) all honor the convention; the
  interp-vs-bytecode differential suite passes.

### 6.2 Bitwise/shift operand domain includes `intN`

- Law: the M1/api.md Expr surface restricts bit ops to `BitsType`; architecture §6 (NORMATIVE
  op table) specifies `intN` behavior for AND/OR/XOR/NOT and SAR for `shr` on `intN`.
- Shipped: `validateIr` accepts `uintN|intN|bytesN` for
  `bitand/bitor/bitxor/bitnot/shl/shr`.
- Status: **accepted** (architecture §6 governs IR validity; the builder's typed surface
  remains narrower).

### 6.3 break/continue lexical rule

- Law: §M2 — "break/continue outside while" (only).
- Shipped: must be lexically inside at least one while **body** (per architecture §3 LoopCtl
  scoping); a break in a top-level while header is rejected.
- Status: **accepted**.

### 6.4 `convert` pair table is closed

- Law: architecture §6 names `u/intN ↔ u/intN`, `uint256|bytes32 → address`,
  `uint256 ↔ bytes32`.
- Shipped: every other pair is rejected.
- Status: **accepted**.

### 6.5 `deserializeIr` validates type strings during the shape check

- Shipped: `isEvsType`/`isWordType` checks in deserialize; `validateIr` re-checks for
  hand-built IR.
- Status: **accepted**.

### 6.6 `const` 'data' payload length tolerance

- Law: silent on whether `encodeLiteralData` zero-pads.
- Shipped: `validateIr` accepts payload length in `[len, ceil32(len)]`; arrays must be
  exactly `32×len` with canonical words.
- Status: **accepted**.

### 6.7 `walkStmts` path semantics

- Shipped: alternating statement-index / child-block-ordinal entries (if: 0=then 1=else;
  while: 0=header 1=body); documented on the export.
- Status: **accepted**.

---

## 7. asm (M4)

### 7.1 Fixture execution engine

- Law: §M4 tests run `RUNTIME_42`/`RUNTIME_WHOAMI` "on the M10 harness".
- Shipped: `src/asm/fixtures.test.ts` executes directly on `@ethereumjs/evm` v10 (the exact
  engine M10 pins) because M10 did not exist yet.
- Status: **accepted** (the harness self-tests now cover the M10 path as well).

### 7.2 `AsmWriter.op()` rejects the PUSH family (load-bearing)

- Law: §M4 `Mnemonic` admits `PUSH0…PUSH32` and `op()` takes any `Mnemonic`.
- Shipped: `op()` throws `EvsInternalError` for any PUSH-family mnemonic;
  `push()/pushBytes()/pushLabel()` are the sanctioned spellings.
- Rationale: a bare PUSHn has no immediate and would corrupt layout; a bare PUSH0 would
  dodge the paris `PUSH1 00` lowering. Signature unchanged; only invalid runtime inputs are
  rejected.
- Status: **accepted**. **Spot-checked at integration**: `assembler.ts` `op()` guards
  `op.startsWith('PUSH')` and throws via the `EvsInternalError` helper.

### 7.3 `returndatacopyAll` zero spelled as `push 0n`

- Law: §M4 window spells 'PUSH0'.
- Shipped: zero operands emitted as `{k:'push', value:0n}` so fork lowering keeps paris
  legal; `verifyShapes` accepts both spellings of a zero push in the RETURNDATACOPY window;
  the rest of the `[RETURNDATASIZE, PUSH0, (PUSH0|DUPn)]` invariant is enforced verbatim.
- Status: **accepted**.

---

## 8. interp (M6)

### 8.1 Env-constant pinning (load-bearing, cross-module)

- Law: §M6 `MockChain` has no environment surface, yet IR has `env` ops.
- Shipped: env statements return pinned constants matching the M10 in-process harness
  defaults — `address` = `0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530` (DEFAULT_SCRIPT_ADDRESS),
  `caller` = `0x1000000000000000000000000000000000000001`, `timestamp` = 0,
  `blocknumber` = 0, `chainid` = 1 (Mainnet default Common).
- Status: **accepted**. **Spot-checked at integration**: `ir/interp.ts` ENV\_\* constants
  match `test/harness/evm.ts` `SCRIPT_ADDRESS`/`CALLER_ADDRESS` and the
  `@ethereumjs/evm` default block context (timestamp/number 0, Mainnet chainid 1); the
  differential suite passes. Note: the anvil integration tier runs chainId 31337 — scripts
  using `s.chainid`/timestamps are oracle-comparable only on the in-process harness
  (testing.md §4.1 binds the oracle to `execRuntime`, so this is consistent).

### 8.2 `maxSteps` failure mode

- Law: unspecified.
- Shipped: throws `EvsCompileError(COMPILE_LIMIT)` — a host-side error, deliberately not a
  chain outcome (compiled bytecode has no step budget; any revert payload would diverge).
- Status: **accepted**.

### 8.3 No separate MockChain helper file

- Shipped: `MockChain` is an interface exported from `interp.ts`; tests build in-file mocks.
- Status: **accepted**.

---

## 9. codegen-abi (M7)

### 9.1 `codegen/tails.ts` added

- Law: §M7 lists only `codegen/abi.ts` + `codegen/call.ts`.
- Shipped: `tails.ts` hosting `createSharedTails`/`emitSharedTails`/`emitDecodeFailStub`.
- Rationale: the `SharedTails` labels M7's emitters jump to must be defined somewhere; the
  law gives M8 placement duty but no emitter for the tail bodies.
- Status: **accepted**.

### 9.2 `CallSitePlan` extended with `targetRef` (+ optional `gasRef`)

- Law: §M7 frozen `CallSitePlan` has no way for `emitStaticCall` to locate the callee
  address or gas-cap operand (they are ValueIds; M7 has no FrameLayout access).
- Shipped: required `targetRef: SlotRef | { literal: ConstData }`, optional `gasRef`.
- Status: **accepted** (frozen-shape extension, mirrors `argRefs`).

### 9.3 `@internal` cross-file helpers in `codegen/abi.ts`

- Shipped: `emitNormalizeWord`, `wordNeedsNormalize`, `emitNormalizeElemsLoop` exported for
  `call.ts`.
- Status: **accepted**.

### 9.4 Pre-cancun `@memcpy` calling convention

- Shipped: entry label checked at one absolute height (stack exactly `[dst, src, len]`,
  height 4 incl. return address); loop state in scratch 0x00; copies ceil32(len) word-wise,
  callers zero-pad after.
- Rationale: the §10 verifier requires checked labels to carry ONE absolute height.
- Status: **accepted**.

### 9.5 Zero-pad after payload copy

- Law: architecture §8.2 — zero-pad "before the copy bookkeeping".
- Shipped: explicit zero-pad AFTER the payload copy (before cursor advance).
- Rationale: the pre-cancun word loop copies whole words and would re-dirty the pad with
  snapshot-aliased malicious bytes. Byte-identical on MCOPY; strictly safer pre-cancun;
  byte-equality vs viem pinned on all three forks.
- Status: **accepted**.

### 9.6 try-mode zero blocks emitted inline

- Law: architecture §11's layout sketch implies zero blocks appended at program end.
- Shipped: `emitStaticCall` emits them inline as checked height-0 labels rejoining at a
  per-site join label.
- Rationale: 'any' regions cannot legally rejoin checked code per the verifier; §15.2's
  "falls through" and M7's "zero blocks are checked labels — they rejoin" support this.
- Status: **accepted**.

### 9.7 calldatasize guard emitted even for 0-arg scripts

- Status: **accepted** (redundant with the dispatcher's check; matches §8.1 "guard once" and
  keeps the emitter safe standalone).

### 9.8 Cosmetic divergence from the §15.2 worked listing

- Shipped: calldata built with empty stack recomputing buf from 0x40; selector stored via
  minimal-push+SHL chunked MSTOREs. All mandated invariants exact (retSize 0, sanctioned
  RETURNDATACOPY shapes, staticMinSize guard before head reads, verbatim bubbling, 2^64
  bounds, eager element normalization).
- Status: **accepted**; see 10.4 for the doc-listing follow-up.

---

## 10. codegen-program (M8)

### 10.1 fn return-address spill (baseline-0 bodies)

- Law: architecture §9 / §M8 — fn-entry labels carry stack 1; `LowerCtx.fnBaseline: 0 | 1`.
- Shipped: fn entry labels still carry stack 1, but the callee immediately spills the return
  address into a per-fn frame slot (`frame.ts#fnReturnAddressSlot`) so the body runs at
  baseline 0, reloading for the return JUMP. `fnBaseline` kept per the frozen interface
  (always 0).
- Rationale: M7's frozen emitters pin checked labels at absolute heights 0/1/4, so a
  baseline-1 body could not contain sub-calls or pre-cancun copies; nested fncalls would
  present two absolute heights to one entry annotation. No recursion ⇒ one slot per fn is
  sound.
- Status: **accepted**. Spot-checked: `fnReturnAddressSlot` exists in `codegen/frame.ts`.

### 10.2 All shared tails always emitted

- Law: architecture §11 — "tails are emitted lazily".
- Shipped: always emitted (M7's `emitSharedTails` is all-at-once); unreferenced tails cost a
  few dozen unreachable bytes.
- Status: **accepted**.

### 10.3 Dispatcher fallback is `PUSH2 @badcd JUMP`

- Law: §11 places `@badcd` inline after dispatch (fallthrough).
- Shipped: tails grouped at program end; explicit jump (4 extra bytes, identical behavior);
  golden snapshots the real shape.
- Status: **accepted**.

### 10.4 Worked-example listings drift (honesty rule)

- Law: architecture §15 listings + testing.md §6 — "the architecture doc's listings are
  generated from these goldens (a doc-sync test fails if the doc drifts)".
- Shipped: goldens are inline snapshots of REAL compiler output; they differ from the doc
  listings in: §15.2 operand scheduling (see 9.8), §15.3/§11 impossible PUSH widths
  (`PUSH1 0x100`, oversized `PUSH2`) where the assembler's minimal-width policy emits
  PUSH2/PUSH1, and the dispatcher fallback (10.3). §15.1 matches opcode-for-opcode.
- Status: **follow-up needed** — regenerate the architecture.md §11/§15 listings from the
  shipped goldens and add the testing.md §6 doc-sync test (no such test exists in the tree
  today; grep for "doc-sync" in `packages/evs/src` is empty). Owner: docs/U12 follow-up.

### 10.5 `@internal` module-internal exports

- Shipped: `frame.ts#fnReturnAddressSlot`, `lower.ts#lowerInternals`,
  `lower.ts#emitFnSubroutines` (WeakMap-keyed state; frozen signatures untouched).
- Status: **accepted**.

### 10.6 LARGE_FRAME threshold

- Law: not pinned.
- Shipped: `frameEnd > 0x8000` (32 KiB ≈ 1,020 slots), documented in `program.ts`.
- Status: **accepted**.

### 10.7 LOOP_ALLOCATION also flags while headers

- Law: §5 says "inside a while body".
- Shipped: headers flagged too (they re-execute per iteration; strictly more informative).
- Status: **accepted**.

### 10.8 §6 fine print: `bitnot` on intN / `shr` on bytesN

- Shipped: `bitnot` on `intN` emits no re-sign-extension (NOT provably preserves
  sign-extension on canonical words); `shr` on `bytesN` DOES re-mask (SHR moves bits out of
  the left-aligned lane). Both pinned by tests.
- Status: **accepted**.

---

## 11. builder (M5)

### 11.1 Both-plain-literal operands throw instead of folding

- Law: architecture §3 shows an all-literal fold example; api.md §3 mandates "≥1 operand must
  be an Expr".
- Shipped: `s.add(2n**256n−1n, 1n)` throws `EvsTypeError(TYPE_MISMATCH)` ("at least one
  operand must be an Expr — type a literal with s.lit"); certain-panic folds still fire when
  any operand is a literal-valued Expr.
- Rationale: the two law clauses are unsatisfiable together (an untyped two-literal fold has
  ambiguous operation type).
- Status: **accepted**. Spot-checked: message present in `builder/expr.ts`, pinned by
  `validation.test.ts`.

### 11.2 `s.for` continue-to-step desugar duplicates step stmts

- Law: api.md §5/§7 — "continue jumps to the step"; frozen IR `continue` targets the header.
- Shipped: step statements are recorded before every `loop.continue()` and once at the body's
  natural end. Observable semantics match exactly; cost is duplicated step stmts per continue
  site.
- Status: **accepted**.

### 11.3 `MutArray.length` records its `len` stmt eagerly at construction

- Law: "length records len stmts against the arrnew value" (per-access reading possible).
- Shipped: once, in the arrnew's scope — IR must not depend on how often a property is read.
- Status: **accepted**.

### 11.4 `evscript({locations:false})` restores capture to `true`

- Law: `core/loc.ts` frozen surface has no getter for the prior state.
- Shipped: restores the documented default (`true`) rather than the prior value; only affects
  exotic nested-recorder mixes.
- Status: **accepted**.

### 11.5 Literal `s.newArray` length ≥ 2^32 throws at recording

- Shipped: `EvsTypeError(CERTAIN_PANIC)` (extends the certain-panic rule to the statically
  certain Panic 0x41 arrnew); runtime-length expressions defer to the runtime check.
- Status: **accepted**.

---

## 12. compile-viem (M9)

### 12.1 `compile`'s structural constraint (load-bearing)

- Law: §M9 — `compile<s extends EvsScript>`.
- Shipped: `compile<s extends { readonly name: string; readonly ir: ScriptIr; readonly abi: readonly unknown[] }>`;
  `CompiledOf<s>` and the result type are exactly the law's.
- Rationale: a concrete multi-return script is NOT assignable to default-instantiated
  `EvsScript` — the `ScriptAbi` default collapses `Record<string, Expr>` components to a
  1-tuple via UnionToTuple, so the literal constraint rejects every real script.
- Status: **accepted**. **Spot-checked at integration**: `compile.ts` carries the structural
  constraint with the recorded rationale; `CompiledOf` unchanged; types project (36 type
  tests incl. `compile.test-d.ts`) green.

### 12.2 `toViem({mode:'stateOverride'}).stateOverride` is a mutable tuple

- Law: §M9 wrote `readonly [...]`.
- Shipped: mutable `[{ address; code }]` — viem's `StateOverride` is a mutable array type
  and a readonly tuple cannot spread into `readContract` (the law's own type-test
  obligation).
- Status: **accepted**.

### 12.3 `INIT_CODE_PREFIX_SHANGHAI` carries a zeroed length immediate

- Law: §M9 — "computed: 0x61 RRRR 80 600A 5F 39 5F F3 builder".
- Shipped: the constant is the wrapper template with the PUSH2 length immediate zeroed
  (`0x61000080600a5f395ff3`); `toCreationBytecode` patches RRRR (runtime-length dependent).
- Status: **accepted**.

---

## 13. Integration-phase amendments (this consolidation pass)

### 13.1 Harness self-tests wired into the unit project

See 4.1 — `packages/evs/vitest.config.ts` `unit` include is now
`['src/**/*.test.ts', 'test/harness/**/*.test.ts']`; the standalone
`test/harness/vitest.harness.config.ts` is deleted. testing.md §1's "exact" listing is
amended accordingly. `bun run test` = 30 files / 1049 tests green; the `integration` project
is unchanged and registers `./test/global-setup.ts`.

### 13.2 Repo-wide oxfmt formatting of `docs/**`

- Law: repo-layout §7 `.oxfmtrc.json` does not ignore `docs/**`, and CI runs
  `bun run fmt:check` repo-wide; the design/research markdown predated the formatter.
- Shipped: `bun run fmt` applied to the whole repo (docs markdown reformatted —
  formatting-only: emphasis/table normalization and fenced-code reformatting; no content
  changes). Note: oxfmt 0.54 markdown formatting is not idempotent on two files
  (architecture.md, proposals/A-direct.md) — two passes were required to reach the fixed
  point; the committed files are at the fixed point so `fmt:check` is stable.
- Status: **accepted** (`.oxfmtrc.json` stays exactly per the law).

### 13.3 `deviations-raw.json` deleted

The 61 raw deviation reports are consolidated into this document; the raw file is removed
from `docs/design/`.

---

## 14. Post-integration fix pass (env-frame divergence + release hardening)

### 14.1 `EvsDiagnostic.code` extended with `ENV_FRAME_DEPENDENT`

- Law: §M1 / architecture §13.3 — `code: 'LOOP_ALLOCATION' | 'LARGE_FRAME'`.
- Shipped: the union gains `'ENV_FRAME_DEPENDENT'`, emitted by `lowerProgram` once per
  `env caller`/`env address` statement (body + emitted fn bodies; dropped fns excluded).
- Rationale: `s.env('caller')`/`s.env('address')` lower to bare CALLER/ADDRESS — sound, but
  frame-dependent: the DEFAULT deployless `toViem()` mode runs the script with caller =
  viem's internal wrapper contract and address = a per-script counterfactual CREATE2 address
  (research/viem-integration.md §3.1), so caller-relative reads silently return wrong data
  unless stateOverride mode + `account` is used. Compile-time cannot know the mode the user
  will pick, so the diagnostic is a warning, not an error. timestamp/blocknumber/chainid are
  block context (mode-independent) and are NOT flagged.
- Status: **accepted** (api.md §4/§10 and both READMEs carry the user-facing warning).

### 14.2 `interpret` opts extended with `env` overrides; deployless-frame harness

- Law: §M6 — `opts?: { trace?: boolean; maxSteps?: number }`; amendment 8.1 pins the env
  constants to the state-override/unit-harness frame. §M10 freezes `execRuntime`.
- Shipped: `opts.env?: InterpEnvOverrides` (`address`/`caller` as 0x addresses,
  `timestamp`/`blocknumber`/`chainid` as bigints; malformed values → `EvsTypeError`,
  host-side). Defaults unchanged (= amendment 8.1 constants), so all existing behavior is
  identical; `MockChain` itself is untouched. `InterpEnvOverrides` is exported from
  `index.ts`. The M10 harness additionally exports `execRuntimeDeployless` +
  `DEPLOYLESS_WRAPPER_ADDRESS` (covered by amendment 4.3's extra-exports rule): it
  CREATEs the initBytecode and CALLs the created contract from the wrapper address — the
  deployless frame shape. The differential suite now pins that the deployless frame's
  caller/address diverge from the pinned constants AND that `interpret` with matching env
  overrides byte-agrees with the deployless execution, closing the oracle blind spot.
- Status: **accepted**.

### 14.3 `index.ts` type-only additions to the §M9 public surface

- Law: §M9 — "nothing else is exported".
- Shipped: `export type { AsmNode, LabelId }` (asm/assembler), `export type { EvmVersion }`
  (asm/ops), `export type { InterpEnvOverrides }` (ir/interp).
- Rationale: `CompileOptions.peephole` and `CompileOptions.evmVersion` reference `AsmNode`/
  `EvmVersion`, which were unreachable through the single entry point (the exports map blocks
  deep imports); `InterpEnvOverrides` appears in the public `interpret` signature (14.2).
  Zero runtime cost (type-only).
- Status: **accepted**.

### 14.4 `ScriptAbi` default instantiation widened (`ReturnSpecToComponents`)

- Law: §M3's literal `ScriptAbi` type (components via `UnionToTuple`).
- Shipped: the non-literal case (`string extends keyof ret`) now yields
  `readonly { name: string; type: EvsType }[]` instead of the degenerate
  `UnionToTuple<string>` 1-tuple, making default-instantiated `ScriptAbi`/`EvsScript`/
  `CompiledEvsScript` proper supertypes of every concrete script (pinned by type tests).
  Literal instantiations are unchanged. `compile`'s structural constraint (amendment 12.1)
  is retained — it is strictly looser and harmless — but its original motivation is now
  fixed at the type level.
- Status: **accepted**.

### 14.5 `explainRevert` hedges adversarial reuse of the evs selectors

- Law: architecture §13 message sketches.
- Shipped: for scripts WITH sub-calls, the `EvsDecodeError`/`EvsInvalidCalldata` branches
  append a hedge that a callee may have bubbled the selector verbatim (mirroring the Panic
  branch's bubbled-from-callee wording); an `EvsDecodeError` site id is presented as
  "recorded at file:line" ONLY when it resolves to a real 'decode'-kind site — any other id
  is reported as not-attributable instead of echoing a forged site. Scripts without
  sub-calls cannot bubble, so their messages stay unhedged.
- Status: **accepted**.

### 14.6 `LOOP_ALLOCATION` sees through `s.fn` bodies

- Law: architecture §5 — flag allocations "inside a while body" (amendment 10.7 added
  headers).
- Shipped: a `fncall` reachable from a loop whose callee transitively allocates (arrnew /
  call-with-outputs / dynamic literal; fn→fn calls followed, acyclic per §9 with a seen-set
  guard) is flagged at the fncall site.
- Status: **accepted**.

### 14.7 CI workflows hardened (law updated in place)

- repo-layout §9/§10 + the shipped workflows changed together: (a) the PR/release contract
  step now runs `forge build && forge test && bun run codegen` — the 69-test Solidity oracle
  suite was previously never exercised in CI; (b) the `fork-tests` job regenerates the
  gitignored `test/generated/` artifacts (`forge build && bun run codegen`) before building —
  it would have failed on import resolution when enabled; (c) the release workflow runs
  `bunx publint <tarball>` on the exact packed tarball between pack and publish
  (testing.md §8); (d) the npm dist-tag derives from the tag's semver prerelease component
  and hard-fails when it disagrees with the GitHub release checkbox. testing.md §8 amended
  accordingly.
- Status: **accepted**.

### 14.8 Package hygiene

- `packages/evs/package.json` `files` excludes `src/**/__snapshots__` and `src/**/.gitkeep`
  (a 31KB vitest snapshot and empty placeholders were shipping in the tarball); a LICENSE
  file (MIT) now exists at the repo root and in `packages/evs/` so `npm pack` includes it.
- Status: **accepted**.

## 15. Documentation site (apps/docs, 2026-06-12)

- **Deviation from repo-layout.md §1/§2 as originally frozen**: a third workspace family
  `apps/*` now exists, holding `apps/docs` — an Astro Starlight site (Rapide theme) deployed
  to Cloudflare Workers static assets at `evs.maxencerb.com`. Root `package.json` gains the
  `docs` catalog; oxlint ignores `apps/docs/**` (astro-managed tsconfig — `astro check`
  covers it via the workspace `typecheck` script); oxfmt ignores `apps/docs/src/content/**`
  (MDX; oxfmt markdown formatting is non-idempotent, stack-testing gotcha).
- **CI boundary**: docs build/deploy is owned by Cloudflare Workers Builds (GitHub app), NOT
  `ci.yml` — its build command runs the docs gate (library build → snippet typecheck →
  `astro build` with `starlight-links-validator`). Rationale: the deploy pipeline and the
  quality gate are the same build, and Cloudflare posts the PR check; duplicating it in
  GitHub Actions would double the cost for no extra signal.
- **Snippet contract**: every ` ```ts ` fence in docs content must typecheck standalone
  against the built package (`apps/docs/scripts/check-snippets.ts`); ` ```ts nocheck ` opts
  out. This extends the testing.md doc-sync philosophy (docs that drift from the API fail a
  build) to the website.
- repo-layout.md §13 records the layout; `apps/docs/README.md` records the Cloudflare
  dashboard settings.
- Status: **accepted**.

---

## 16. Composite types (issue #2)

Tuple/struct support (decode + encode + construction): `t.struct`/`t.tuple`, `s.tuple`, `Tuple`/
`Field` handles, tuple call outputs/args, tuple returns, and a breaking args rewrite to positional
callback params. The binding contract is `docs/design/proposals/composite-types-impl-plan.md`.
api.md §2/§3/§5/§6, architecture.md §0/§2/§2.1/§4/§5/§7.2/§8, and module-interfaces.md (M1–M3, M5,
M9) are amended in place; this section quotes each pre-change frozen signature.

### 16.1 `evscript` / `ScriptBuilder` — positional callback params, `ScriptBuilder` non-generic

- Law: api.md §1/§4 + module-interfaces §M5 —
  ```ts
  export function evscript<
    const name extends string,
    const args extends readonly ArgSpec[],
    ret extends Record<string, Expr>,
  >(
    def: { name: name; args: args },
    body: (s: ScriptBuilder<args>) => ScriptReturn<ret>,
    opts?: { locations?: boolean },
  ): EvsScript<name, args, ret>;
  export interface ScriptBuilder<args extends readonly ArgSpec[]> {
    readonly args: { readonly [a in args[number] as a['name']]: Expr<a['type']> }; /* … */
  }
  ```
- Shipped:
  ```ts
  export type ArgsInput = EvsType | readonly EvsType[];
  export type NormalizeArgs<a extends ArgsInput> = a extends readonly EvsType[] ? a : readonly [a];
  export type ArgHandle<t extends EvsType> = t extends TupleType ? Tuple<t> : Expr<t>;
  export type ArgHandles<types extends readonly EvsType[]> = {
    readonly [i in keyof types]: ArgHandle<types[i]>;
  };
  export function evscript<
    const name extends string,
    const args extends ArgsInput = readonly [],
    ret extends Record<string, Expr> = Record<string, Expr>,
  >(
    def: { name: name; args?: args },
    body: (s: ScriptBuilder, ...args: ArgHandles<NormalizeArgs<args>>) => ScriptReturn<ret>,
    opts?: { locations?: boolean },
  ): EvsScript<name, NormalizeArgs<args>, ret>;
  export interface ScriptBuilder {
    /* non-generic; no `args` param, no `s.args` member */
  }
  ```
  `args` is now a single `t.*` type or a `readonly` list of them (`args: t.uint256` ≡
  `args: [t.uint256]`), optional (a zero-arg script omits it). Args arrive as **positional callback
  params after `s`** (`(s, token, amount) => {…}`): an `Expr` per scalar/string/array arg, a
  `Tuple` handle per `t.struct`/`t.tuple` arg. `ScriptBuilder` lost its `args` type param and its
  `s.args` getter.
- Rationale: composite (struct/tuple) script args have no place in the `{ [name]: Expr }` record,
  and viem infers `args` positionally regardless of input labels; the positional list is also the
  natural home for a `Tuple` handle. `ArgHandles` is a homomorphic mapped tuple — order/labels are
  structural, so the `UnionToTuple` interning hazard (abitype §4.2) that the old ordered-`ArgSpec`
  tuple avoided is still avoided.
- Status: **accepted**.

### 16.2 `arg()` / `ArgSpec` retained for `s.fn` params (not script args)

- Law: api.md §2 / module-interfaces §M1 — `arg()`/`ArgSpec` were the script-args declarator
  (`{ name: …, args: [arg('pool', t.address)] }`) AND the `s.fn` param declarator.
- Shipped: `arg()` and `ArgSpec` stay exported and unchanged in role for `s.fn` params
  (`s.fn(name, [arg('x', t.uint256)], (x) => …)` keeps working); only the script-args surface moved
  off them. The `arg()` parameter-type bound is `StringType` (was `ArgType`/`EvsType`) — `s.fn`
  params remain string-encoded types in v0; the change is a no-op for existing call sites.
- Rationale: `s.fn` params are positional+named today and not part of the composite rewrite;
  breaking them was unnecessary. Keeping the export avoids a churn in every `s.fn` user.
- Status: **accepted**.

### 16.3 `t` namespace — `struct` / `tuple` / tuple `array` overload

- Law: api.md §2 / module-interfaces §M1 —
  ```ts
  export const t: {
    /* WordType keys + string + bytes */
    array<const e extends WordType>(elem: e): `${e}[]`;
  };
  ```
- Shipped:
  ```ts
  export const t: {
    /* WordType|DynType keys */
  } & {
    array<const e extends StringType>(elem: e): `${e}[]`;
    array<const e extends TupleType>(elem: e): TupleArrayOf<e>; // tuple → tuple[]
    struct<const spec extends Record<string, EvsType>>(spec: spec): StructTypeOf<spec>; // named
    tuple<const items extends readonly EvsType[]>(...items: items): TupleTypeOf<items>; // positional
  };
  ```
  `t.struct` builds a named tuple (runtime member order = `Object.keys` insertion order, the only
  encode-order source of truth); `t.tuple` builds a positional tuple (members `name: ''`);
  `t.array` is broadened to a string-array element AND a tuple element. `StructTypeOf`/`TupleTypeOf`/
  `TupleArrayOf`/`TypeToComponent` are exported for the overloads. The `array` element bound widened
  from `WordType` to `StringType` (nested string arrays are represented in the vocabulary).
- Rationale: a struct record compiles to a single NAMED ABI tuple, which abitype infers as an
  order-insensitive object — `UnionToTuple` over the record keys is therefore SAFE (the runtime
  `Object.keys` order is authoritative). Positional `t.tuple` uses ordered declarators and never
  touches `UnionToTuple`.
- Status: **accepted**.

### 16.4 `EvsType` / `Expr.at` — tuple objects + nested string arrays

- Law: api.md §3 / module-interfaces §M1 —
  ```ts
  export type ArrayType = `${WordType}[]`;
  export type EvsType = WordType | DynType | ArrayType;        // string-only
  at<elem extends WordType>(this: Expr<`${elem}[]`>, i: IntoExpr<'uint256'>): Expr<elem>;
  ```
- Shipped:
  ```ts
  export type ScalarType = WordType | DynType;
  export type ArrayType = `${ScalarType}[]` | `${ScalarType}[][]` | `${ScalarType}[][][]`;
  export type StringType = ScalarType | ArrayType;
  export interface TupleType { readonly type: 'tuple'|'tuple[]'|'tuple[][]';
    readonly components: readonly NamedType[]; }
  export interface NamedType { readonly name: string; readonly type: string;
    readonly components?: readonly NamedType[]; }
  export type EvsType = WordType | DynType | ArrayType | TupleType;   // string OR tuple object
  at<elem extends StringType>(this: Expr<`${elem}[]` & ArrayType>, i: IntoExpr<'uint256'>): Expr<elem>;
  ```
  `EvsType` now includes `TupleType` descriptor OBJECTS and string-array nesting. `LitOf` gained a
  `TupleType` branch (→ `TupleLitOf`, an abitype delegation). `Expr.at` broadened to `StringType`
  elements (the `& ArrayType` pins the result back into the depth-bounded vocabulary). Tuple
  descriptors are fresh objects, never `===`, so every value-type comparison in the recorder and
  `ir/validate.ts` uses the structural `typesEqual`.
- Rationale: named tuple members cannot live in a type string; a descriptor object that is
  abitype-`AbiParameter`-shaped lets abitype infer literals/returns directly and the IR/codegen
  recurse over `NamedType`/`PlainAbiParam` trees.
- Status: **accepted**.

### 16.5 `ScriptAbi` / `buildScriptAbi` — `args` reparameterized to `readonly EvsType[]`

- Law: module-interfaces §M3 —
  ```ts
  export type ScriptAbi<name extends string, args extends readonly ArgSpec[],
    ret extends Record<string, Expr>> = readonly [
    { /* function */ readonly inputs: {
        readonly [i in keyof args]: { readonly name: args[i]['name']; readonly type: args[i]['type'] };
      }; /* … */ }, …];
  export function buildScriptAbi(name: string, args: readonly ArgSpec[],
    returns: readonly { name: string; type: EvsType }[]): Abi;
  ```
- Shipped:
  ```ts
  export type ArgName<i> = i extends `${number}` ? `arg${i}` : string;
  export type ArgsToInputs<args extends readonly EvsType[]> = {
    readonly [i in keyof args]: TypeToComponent<ArgName<i>, args[i]> };
  export type ScriptAbi<name extends string, args extends readonly EvsType[],
    ret extends Record<string, Expr>> = readonly [
    { /* function */ readonly inputs: ArgsToInputs<args>; /* … */ }, …];
  export function buildScriptAbi(name: string, args: readonly EvsType[],
    returns: readonly { name: string; type: EvsType }[]): Abi;
  ```
  Inputs are auto-named `arg0`, `arg1`, … (positional labels); a tuple arg expands via
  `TypeToComponent`/`typeToAbiParam` to `{ name, type: 'tuple', components }`. `ArgsToInputs` is a
  HOMOMORPHIC mapped type over the arg-TYPE tuple — no `UnionToTuple`, `args` stays covariant (a
  concrete tuple-arg `ScriptAbi`/`EvsScript`/`CompiledEvsScript` is assignable to the
  default-instantiated one, like the `ret` relaxation in amendment 14.4). The labeled-positional
  `ReadContractParameters['args']` CI type test still passes.
- Rationale: script args are positional after the rewrite (16.1) and carry no names; the ABI input
  names are pure labels.
- Status: **accepted**.

### 16.6 `CompiledEvsScript` / `EvsScript` `args` type param

- Law: api.md §1/§10 / module-interfaces §M5/§M9 — `EvsScript<name, args extends readonly ArgSpec[],
ret>` and `CompiledEvsScript<name, args, ret>` parameterized by `readonly ArgSpec[]`.
- Shipped: both are parameterized by `args extends readonly EvsType[]`; `evscript` instantiates
  them at `NormalizeArgs<args>`. `compile`'s structural `CompiledOf<s>` constraint (amendment 12.1)
  is unchanged and still works.
- Rationale: mechanical consequence of the args reparameterization (16.5); keeps the literal ABI
  type and the compiled artifact in sync with the normalized positional arg-type list.
- Status: **accepted**.

### 16.7 `Tuple` / `Field` / `s.tuple` — the new composite builder surface

- Law: api.md §4/§5 — no tuple handle existed; tuple args/outputs were a recording-time
  `EvsTypeError` ("Output/arg types outside v0 (`tuple`, …) → recording-time `EvsTypeError`").
- Shipped (api.md §5; module-interfaces §M5):
  ```ts
  export interface Field<t extends EvsType> { readonly type: t;
    get(): t extends TupleType ? Tuple<t> : Expr<t>; set(value: IntoMember<t>): void; }
  export type Tuple<C extends TupleType> = {
    readonly [c in C['components'][number] as c['name'] extends '' ? never : c['name']]:
      Field<ComponentToType<c>>;
    } & { at(i: number): Field<ComponentToType<C['components'][number]>>; expr(): Expr<C>; };
  export type IntoTuple<t extends TupleType> = Tuple<t> | LitOf<t>;
  export type IntoMember<t extends EvsType> = t extends TupleType ? IntoTuple<t> : IntoExpr<t>;
  export type TupleInit<C extends TupleType> = /* named object | positional record, all optional */;
  // on ScriptBuilder:
  tuple<const c extends TupleType>(type: c, init?: TupleInit<c>): Tuple<c>;
  ```
  A `Tuple` handle is a flat-pointer memref (architecture §5): one frame slot holds a pointer to a
  packed `[w0…w_{n-1}]` block. `s.tuple` bump-allocs `32·n`, zero-fills, and MSTOREs provided
  members (omitted/literal-`0` → no write). Reference semantics: passing the handle copies the
  pointer, so a later `field.set()` is visible through every alias. The SAME handle type is produced
  by `s.tuple`, a decoded tuple call output, and a struct/tuple script arg.
- Rationale: composite values need named/positional field access and a single unified handle across
  construction, decode, and args.
- Status: **accepted**.

### 16.8 `SubcallInputs` / `SubcallOutputs` — tuple handles + literal structs; deferral dropped

- Law: api.md §6 —
  ```ts
  export type SubcallInputs<abi, name> = {
    readonly [i in keyof inputs]:
      | AbiParameterToPrimitiveType<inputs[i], 'inputs'>
      | Expr<inputs[i]['type'] extends EvsType ? inputs[i]['type'] : never>;
  };
  // outputs []→void; [one]→Expr<one>; [many]→readonly tuple of Exprs
  ```
  plus the §6 rule "Output/arg types outside v0 (`tuple`, `T[N]`, nested arrays) → recording-time
  `EvsTypeError`".
- Shipped: per-parameter `SubcallInputs` extends a tuple param's accepted value to
  `AbiParameterToPrimitiveType<input,'inputs'> | Tuple<input> | Expr<input>` (a `Tuple` handle, an
  `s.tuple(...)` result, OR a plain literal object — the recorder builds the tuple via `tuplenew`,
  members literal-or-`Expr`, omitted → 0). `SubcallOutputs` maps a `'tuple'` output to a `Tuple`
  handle; `UnwrapSingle` yields `Tuple<one>` for a single tuple output. The `tuple → EvsTypeError`
  deferral is dropped. `T[N]`, arrays of tuples (`tuple[]`), and nested string arrays remain a
  recording-time `EvsTypeError('UNSUPPORTED_V0', …)`.
- Rationale: tuples now decode/encode end to end (architecture §7.2/§8); the deferral no longer
  reflects the shipped capability.
- Status: **accepted**.

### 16.9 IR — `tuplenew` / `field` / `tupleset` nodes; `arrnew.elem` widened; tuple-carrying types

- Law: module-interfaces §M2 / architecture §4 — Stmt had no tuple variants;
  `arrnew { elem: WordType, … }`; `ValueInfo.type`/`args`/`returns`/fn types implicitly the
  string-only `EvsType`; `validateIr` compared types with `===`/the op table.
- Shipped: three new Stmt variants —
  ```ts
  | { k: 'tuplenew'; inits: readonly { index: number; value: ValueId }[]; out: ValueId }
  | { k: 'field'; tuple: ValueId; index: number; out: ValueId }
  | { k: 'tupleset'; tuple: ValueId; index: number; value: ValueId }
  ```
  the out/tuple ValueId's `values[id].type` carries the `TupleType` (with components). `arrnew.elem`
  is widened to `EvsType` (validate still restricts to word — composite arrays deferred).
  `ValueInfo.type`/`args`/`returns`/fn param+result types are `EvsType` (string OR tuple object);
  serialize/deserialize (`asEvsType`) handle the descriptor objects; `checkAbiParams` recurses
  through components; `validateIr` uses the structural `typesEqual` for all value-type comparisons.
- Rationale: tuples need an alloc/read/write node trio and tuple-typed values throughout the IR; the
  recursive `NamedType` shape makes the follow-up array-of-tuple cases additive.
- Status: **accepted**.

### 16.10 Deferred follow-up: `tuple[]` and nested string arrays

- Law: architecture §2/§18, api.md §2/§6 — `T[N]`/nested tuples were the single deferred bucket.
- Shipped: the `TupleType` vocabulary already represents `tuple[]`/`tuple[][]` and `ArrayType`
  represents nested string arrays (`uint256[][]`, `string[]`), but the builder/codegen restrict to
  the delivered shapes. `s.newArray` stays word-element-only; `at()` on a tuple-element array is the
  follow-up; reaching a deferred shape throws `EvsTypeError('UNSUPPORTED_V0', …)` naming it. The
  follow-up is additive (a codegen `case` per emitter + builder wiring), NOT a rewrite, because the
  emitters are already recursive over `NamedType`/`PlainAbiParam` trees.
- Status: **accepted** — PARTLY REVERSED by **16.11**: one-level arrays of composite —
  `tuple[]`, `T[][]`, `string[]`/`bytes[]` — are now DELIVERED (decode/read, construct/mutate,
  return, call-arg encode; byte-exact vs viem + real solc on paris/shanghai/cancun). `s.newArray`
  and `at()` no longer reject them. Only `tuple[][]` (two-level tuple array), fixed-size `T[N]`, and
  string arrays nested deeper than `[][]` remain `UNSUPPORTED_V0` (lock-tested).

### 16.11 Arrays of composite (`tuple[]`, `T[][]`, `string[]`)

> Closes issue #2's "arrays of tuples" + `T[][]` follow-up; PARTLY REVERSES 16.10. Delivered in
> PR #3 milestones M1–M4 — one level of array nesting over a composite/dynamic element (`tuple[]`
> static-element AND dynamic-member element, `uint256[][]`, `string[]`/`bytes[]`), byte-exact vs
> viem `encodeAbiParameters` + real solc on paris/shanghai/cancun. The binding byte-exact spec is
> `docs/design/proposals/composite-types-impl-plan.md` §12; architecture §2.1/§5/§8/§18, api.md
> §5/§6, and module-interfaces §M1–M3/§M5 are amended in place.

- Law: architecture §5 / module-interfaces §M3 `abi/layout.ts` — the `TypeLayout` array variant
  was `elem: WordLayout` ("dynamic arrays of words only in v0"); §M2 `arrnew.elem` was widened to
  `EvsType` but `validateIr` "still restricts to word — composite arrays deferred"; §M5
  `MutArray<e extends WordType>` and `s.newArray(elem: WordType, …)`; api.md §3 — "Dynamic
  literals (and literal arrays) become bytecode **data segments** materialized by CODECOPY".
- Shipped:
  - **Memory model (architecture §5).** A composite-element array (`tuple[]`, `T[][]`,
    `string[]`/`bytes[]`) is an ARRAY OF POINTERS: a memref to `[len:32][p0:32][p1:32]…` — IDENTICAL
    to the word-array block (`ptr + 32 + 32·i` addressing, len at `ptr`), except each slot `pᵢ`
    holds a memref POINTER to element `i`'s own block rather than an inline value word (`tuple[]` →
    a flat tuple block §3; `T[][]` → an inner array; `string[]`/`bytes[]` → a bytes block). This is
    exactly Solidity `Struct[]`/`T[][]`/`string[]` memory. `lowerArrnew`/`lowerIndex`/`lowerArrset`
    address arithmetic + bounds (`i<len`→Panic 0x32) + alloc cap (`2^32-1`→Panic 0x41) are
    element-type-agnostic and reused UNCHANGED; only the leaf semantics differ (the slot holds a
    pointer; `index` yields it as the element handle; an unset slot is UB exactly like Solidity).
  - **Layout (`abi/layout.ts`).** The array variant is widened `elem: WordLayout` →
    **`elem: TypeLayout`**; `layoutOf`/`layoutOfType` return an array-of-composite layout for a
    one-level `tuple[]`/`T[][]`/`string[]`/`bytes[]` element (the `badTypeError` narrows to still
    reject `T[N]`/`tuple[][]`/`[][][]+`). A `staticSize(elem)` helper = `headBytes(components)` for a
    static tuple element, `32` for a word.
  - **Validate (`ir/validate.ts`).** `checkElemType` (the arrnew/array-element gate) is widened to
    accept `word | string | bytes | one-level T[] | tuple` elements; it still rejects `T[N]`,
    `tuple[][]`, and `[][]`-deeper string arrays with `UNSUPPORTED_V0` (a `tuple[][]` IR node still
    fails validation). `index`/`arrset`/`len` were already element-agnostic.
  - **Decode codegen (`codegen/abi.ts` + `call.ts`).** New `emitDecodeArrayToMem` — an ON-STACK
    element loop (NO `emitMemCopy`: it freshly allocates each tuple/array element block and aliases
    leaf bytes into the returndata snapshot). Per-element source base lives in a fixed scratch slot
    (`ELEM_BASE = 0x20`) so the recursive element decoders' `pushBase` is stack-depth-independent.
    Dynamic-element offsets are read relative to the array DATA START `D` (the word after `len`);
    static-element arrays have no offset words (`len·staticSize` contiguous). Wired into the args
    decoder (§8.1) and the call-output decoder (§7.2).
  - **Encode codegen (`codegen/abi.ts` + `call.ts`).** New `emitEncodeArrayTail` on the shared
    monotone tail cursor (`TAIL_CURSOR = 0x00`): a static element inlines `len·staticSize`; a
    dynamic element writes `len` offset words relative to `D` then appends each element's tail. The
    dynamic-element loop keeps ALL of its state `{arrPtr, D, len, i}` in a reserved 4-word memory
    FRAME BELOW the output/call buffer (`reserveEncodeFrames` bumps `FREE_PTR` by `32·FRAMES·4`
    before `out = MLOAD(0x40)` is read, so `RETURN` never returns scratch), keeping the operand
    stack at baseline 0 so every `@memcpy` runs at EXACTLY `[dst, src, len]` (the pre-cancun
    height-4 checked-entry contract, amendment 9.4). `FRAMES` = the max concurrent array-nesting
    depth along any path of the encoded type (statically known; `tuple[]`=1; a `tuple[]` whose
    member is a `string[]`=2). Static-element loops use no memcpy, so they keep counter state on the
    stack.
  - **Builder (`builder/{script,expr}.ts`).** `s.newArray` is widened off word-only to admit
    `word | string | bytes | one-level T[] | tuple` elements (`T[N]`/`tuple[][]` still gated). The
    `MutArray<e>` generic widens from `WordType` to `EvsType`: `get`/`at` on a `tuple[]` return a
    `Tuple` element handle (the SAME unified tuple handle as a decoded tuple, §3/16.7), `set` accepts
    an `IntoMember<e>` (a `Tuple` handle / array handle / `Expr` per element type), `expr()` types as
    `Expr<tuple[]>`; `arrset` stores the element pointer. A `tuple[]`/`uint256[][]`/`string[]`/
    `bytes[]` LITERAL (a JS array) is constructible anywhere its value type is expected — but, unlike
    a word/string/bytes literal, it is BUILT AT RECORD TIME as `arrnew` + per-element
    (`tuplenew`/`arrset`), with reference semantics and a fresh `[len][p0…]` block. This changes
    `encodeLiteralData`'s contract: a composite-array literal has **NO flat data-segment literal**
    (it cannot — the elements are pointers into freshly-allocated blocks), so the recorder
    materializes it structurally rather than emitting a CODECOPY'd `[len][payload]` blob.
  - **Types.** `s.call` `tuple[]` output → `readonly Struct[]`; `uint256[][]` →
    `readonly (readonly bigint[])[]`; `string[]` → `readonly string[]`. A tuple-array `Expr`'s
    `.at(i)` returns a typed `Tuple` element. `SubcallInputs` accepts `Expr<tupleArrayType>`, an
    array handle, or a `readonly Struct[]` literal for a `tuple[]` arg.
- Rationale: the array-of-pointers layout makes the change ADDITIVE on the flat-pointer tuple model
  (§3 / architecture §5) — the existing word-array addressing is element-agnostic, so only the leaf
  decode/encode/construct semantics are new. The scratch-frame encode discipline is the load-bearing
  detail: it preserves the pre-cancun `@memcpy` `[dst,src,len]` height invariant through an
  arbitrarily nested dynamic-element loop. The recorder-builds-the-literal change is forced because a
  composite array's elements are pointers, not inline bytes — there is no flat blob to CODECOPY.
- Status: **accepted**. Still deferred (throw `UNSUPPORTED_V0`, lock-tested): `tuple[][]` (two-level
  tuple array), fixed-size `T[N]`, and string arrays nested deeper than `[][]`.

---

## Spot-check summary (integration agent)

| Claim                                                               | Where verified                                                                                                      | Result           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| ir positional arg→value binding honored by builder, interp, codegen | `builder/expr.ts` (Recorder ctor), `ir/interp.ts` (run), `codegen/frame.ts` (slot order), `ir/validate.ts` (header) | confirmed        |
| interp env constants match harness defaults                         | `ir/interp.ts` ENV\_\* vs `test/harness/evm.ts` SCRIPT/CALLER/Common defaults                                       | confirmed        |
| compile-viem structural constraint, `CompiledOf` intact             | `compile.ts`                                                                                                        | confirmed        |
| asm PUSH-family rejection in `AsmWriter.op()`                       | `asm/assembler.ts`                                                                                                  | confirmed        |
| both-plain-literal builder rule + message                           | `builder/expr.ts`, `builder/validation.test.ts`                                                                     | confirmed        |
| fn return-address spill slot exists                                 | `codegen/frame.ts#fnReturnAddressSlot`                                                                              | confirmed        |
| no doc-sync test exists yet (10.4 follow-up)                        | grep of `packages/evs/src`                                                                                          | confirmed absent |

Open follow-ups: **1.6** (real E1/E2 example scripts — U12), **10.4** (regenerate
architecture §11/§15 listings from goldens + add the testing.md §6 doc-sync test).
