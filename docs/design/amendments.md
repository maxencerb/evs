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
