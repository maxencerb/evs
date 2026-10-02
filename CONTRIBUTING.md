# Contributing to evs

Maintainer notes for the `@maxencerb/evs` monorepo: how the repository is laid out, how to run
the toolchain and the test tiers, the design decisions worth knowing before touching the
compiler, and how releases and the docs site ship. User documentation lives at
<https://evs.maxencerb.com>; the [README](packages/evs/README.md) is the package's
presentation page (npm, GitHub) and stays user-facing.

## Repository map

| Path                                                                                  | What                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`packages/evs`](https://github.com/maxencerb/evs/tree/main/packages/evs)             | the published library: builder, IR + interpreter, codegen, assembler, viem glue                     |
| [`packages/contracts`](https://github.com/maxencerb/evs/tree/main/packages/contracts) | Foundry fixtures: mocks + the solc reference contracts for differential tests                       |
| [`examples/`](https://github.com/maxencerb/evs/tree/main/examples)                    | runnable example scripts (`node examples/<name>/index.ts` after `vp run build` + contracts codegen) |

### Library sources (`packages/evs/src`)

The pipeline order: `builder/` records the callback into the IR (`ir/`), `codegen/` lowers it to
an assembly stream, `asm/` lays it out and verifies it, `compile.ts` ties them together and
`viem.ts` is the client-side glue (`deployless.ts` holds the deployless mode's limits). `core/` (types, errors, bytes, signatures) and `abi/` (layout,
the script artifact's ABI) are shared by every stage; `differential/` holds the
interpreter-vs-bytecode test slices.

A module too large for one file is a **barrel plus a same-named folder**: `builder/expr.ts`
re-exports `builder/expr/*.ts`, and so on. Importers (and tests) keep using the barrel path; each
file in the folder opens with a header saying what it holds, and the barrel's header lists them.

| Barrel              | Folder contents                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builder/expr.ts`   | `handles`, `helpers`, and `Recorder` as a chain of layers: `core` → `composites` → `encode` → `ops` → `control` → `calls` → `recorder`                    |
| `builder/script.ts` | `evscript`, `handles` (handle types), `calls` (call-verb and overload types), `builder` (`ScriptBuilder` + facade)                                        |
| `core/types.ts`     | `vocabulary`, `expr` (the `Expr` type), `args`, `derive` (type-level ABI derivations), `namespace` (`t`), `predicates`                                    |
| `ir/nodes.ts`       | `schema` (node inventory + op vocabularies), `json` ((de)serialization), `walk` (def/use tables, traversal)                                               |
| `ir/interp.ts`      | `interpreter` (public API + executor), `values`, `arith`, `encode`, `decode`, `coerce` (the JS boundary)                                                  |
| `codegen/lower.ts`  | `context`, `statements` (dispatch, fns, calls, control flow), `values`, `arith`, `pow`, `muldiv` (FullMath `mulDiv` / `mulDivRoundingUp`), `composites`   |
| `codegen/abi.ts`    | `shared`, `encode`, `encode-bytes`, `decode` (tuples, the array-codec paths, `emitDecodeFromRegion` for top-level values), `dispatch` (calldata / return) |
| `codegen/call.ts`   | `shared`, `calldata`, `static-call`, `simulate-call`                                                                                                      |

Cross-module cycles are a lint error (`import/no-cycle`; type-only imports are exempt), so code
that recurses into itself stays in one file (the decoder's two array paths, the statement
dispatch and the control-flow templates).

## Development

pnpm workspaces monorepo driven by [Vite+](https://viteplus.dev) (`vp`): one toolchain for
formatting (oxfmt), linting + type-aware checks (oxlint / tsgolint), tests (Vitest 5), the
library build (tsdown via `vp pack`) and the task runner. Vite+ 1.0 needs Node
`^22.18 || ^24.11 || >=26` (`.node-version` pins the 24 line); upgrade with `vp upgrade` then
`vp migrate --no-interactive` from the repo root. **pnpm** is the package manager
(`packageManager: pnpm@12.x`; `vp install` delegates to it and `vp env` provisions it) and
**Node** runs every TypeScript script directly through type stripping (`node scripts/x.ts`:
erasable syntax only, explicit `.ts` import specifiers).

```sh
curl -fsSL https://vite.plus | bash   # once: the global `vp` CLI (provisions Node + pnpm)
vp install                # workspaces + pinned catalogs (= pnpm install)
vp run build              # build @maxencerb/evs (vp pack → dist/, see below)
vp run test               # unit + type tests (vitest via vp test)
vp run test:integration   # anvil integration tests (requires foundry)
vp check                  # format + lint + type-check (tsgolint) in one pass
vp run check              # vp check + tsc/astro typecheck across workspaces (= CI)
vp fmt                    # oxfmt (writes)
vp run changeset          # add a changeset when a change should ship in the next release
```

Without the global CLI, `pnpm install` then `pnpm run <script>` works the same (the scripts call
the project-local `vp` from `vite-plus`).

Contracts: `cd packages/contracts && forge build / forge test / vp run codegen`.

### Workspace configuration (`pnpm-workspace.yaml`)

- **Catalogs**: the default catalog holds the shared runtime + toolchain pins (`viem` and
  `vite-plus` exact, the `vite` → `@voidzero-dev/vite-plus-core` alias), `testing` and `docs`
  the rest. setup-vp reads the `vite-plus` entry to install CI's `vp`.
- **overrides** `vite@*` / `vitest@*`: required by Vite+ under pnpm so every package shares the
  Vite+ core and the Vitest `vp test` bundles; bump them together with `vite-plus`.
  `peerDependencyRules.allowedVersions.vite` accepts the core alias's own version (1.0.0) for
  `vite` peers such as vitest's and astro's `vitefu`.
- **allowBuilds**: pnpm ≥ 11 fails an install on any dependency build script nobody has ruled
  on (`strictDepBuilds`). esbuild and workerd are denied — their postinstall only re-checks the
  prebuilt binary their JS shim finds on its own. Rule on any new one there.
- **minimumReleaseAge** (pnpm default: one day) refuses too-fresh versions at resolution time;
  pnpm itself writes exact-version `minimumReleaseAgeExclude` entries when a pin is newer, and
  prunes them once the lockfile no longer needs them.
- No hoisting workarounds are needed: `wrangler` stays a **root** devDependency only so the
  Cloudflare deploy command (`npx wrangler`, from the repo root) finds it in the root
  `node_modules/.bin` (pnpm links a workspace's binaries into its own `node_modules` only). The
  docs app's former direct `satteri` dependency (a bun resolution workaround) is gone.

### Library build (`vp pack`)

`packages/evs` builds with `vp pack` (tsdown, the `pack` block in its `vite.config.ts`): entry
`src/index.ts`, unbundled ESM (one `dist/` module per reachable source file, `.js` / `.d.ts`
names so `exports` / `main` / `types` are unchanged) and JS source maps. The maps embed the
TypeScript sources (`sourcesContent`, pinned with `outputOptions.sourcemapExcludeSources: false`)
so stack traces and debuggers resolve to the original code, which is why `src/` is **not**
shipped (`files` is `dist` only). There are no declaration maps: go-to-definition lands on the
`.d.ts`, which keeps the JSDoc. Do not re-add `src` to `files` or turn on `dts.sourcemap` without
the other — declaration maps carry no sources and would point at missing files. No tsdown compatibility settings are set:
`deps.resolveDepSubpath` does not matter (every external is imported by its bare name) and
attw runs in CI with the `esm-only` profile, not inside the build. Differences from the former
`tsc -p tsconfig.build.json` emit: declarations are generated only for modules reachable from
the public entry (internal-only modules have no `.d.ts`, and per-module declarations drop
exports that are not part of the public graph — `exports` never allowed deep imports anyway),
`dist/index.js` (a pure re-export) has no source map, and rolldown-plugin-dts keeps the
`declare module '../../core/types/expr.js'` augmentation in `builder/script/handles.d.ts` as
written (valid because the layout is unbundled; tsdown logs a note about it). The augmentation
targets the module that declares `Expr`, not the `core/types.ts` barrel: augmenting through a
re-export does not merge into the emitted declarations. The public surface — the 143 exports of
`dist/index.d.ts` — is identical by name, kind and type. Consumers are checked by
publint, attw, the docs snippet gate and the examples; the type tests
(`*.test-d.ts`) run against `src/`.

Releases: see [Releasing](#releasing) below.

## Design notes (the parts worth knowing)

- **Pipeline.** The builder callback runs once and records a value-semantics IR (a flat value
  table, one site id per statement). `validateIr` checks it, `eliminateDeadCode` (the one
  IR-level pass, always on and also exported as `dce`) drops statements whose results nothing
  observable reads — returns, `s.throw` args, sub-calls, loops, read cells and impure `s.fn`
  calls are the roots; a revert that only guarded an unused value is dead work too (an evs
  choice: solc 0.8.30 keeps such a Panic with the optimizer off, on and via-IR), and
  `interpret()` runs the same pass unless `opts.dce === false` — then codegen lowers each
  surviving statement through fixed memory-slot templates to an assembly stream, the assembler
  lays it out (immediates only ever come from `push`/`pushBytes`/`pushLabel` nodes: a bare
  `PUSH1`–`PUSH32` op node is rejected, also when a `peephole` hook returns one, and so is a
  `push` node whose `value` is not a bigint), enforces the
  EIP-170 size check (through the `onLayout` hook `compile()` passes, before any fixup is
  patched, so a program past `PUSH2`'s 16-bit reach still gets `COMPILE_LIMIT`), resolves jumps
  (`PUSH2` fixups), and mandatory verifiers run on the output before it is handed to you: a `JUMPDEST`
  scan, a stack-height simulation (the operand stack must be empty at every statement
  boundary), and opcode/fork lints. The artifact's `ir` stays the recorded IR;
  the differential suite checks the recorded IR (`interpret(ir, …, { dce: false })`),
  `interpret(ir)` (= `dce(ir)`, cached per frozen IR) and the bytecode agree, except for the
  tripping arg sets of the `differential/dead-revert-guards` slice (the harness's
  `deadRevertGuards` indices), where the dead statement is the one that reverts and only the
  last two must agree.
  An opt-in optimizer (`compile(script, { optimize: true })`) adds two passes: a liveness-based
  frame allocator in codegen (a value takes over the slot of a dead one — args, cells and fn
  params stay dedicated, fn frames stay separate, a value crossing a loop boundary stays live
  for the whole loop) and a peephole pass between codegen and assembly (exported as
  `evsPeephole`) that folds store-then-reload slot pairs, constants and stack identities, never
  crosses a `JUMPDEST` and never touches a label or jump target. Both outputs go through the same
  verifiers. It is off by default so the default bytes stay the plain lowering. The allocator
  (`codegen/frame.ts`) walks the `if`/`while` region tree and scans with two heaps; a seeded
  test in `frame.test.ts` holds it slot for slot to a naive reference model of the same rules.
- **Adding a statement kind or an op.** The IR-side switches over `Stmt['k']`, `BinOp`, `UnOp`,
  `ModArithOp` and `EnvOp` end in a `default` that assigns the subject to `never`
  (`ir/nodes/walk.ts`, `ir/nodes/json.ts`, `ir/validate.ts`, `ir/interp/`, and `ir/dce.ts`'s
  `isObservable` and `unionAliases`), so `vp check` lists every IR site that needs a case;
  `json.ts`'s `STMT_KINDS` table is checked the same way. Still unguarded, so update them by
  hand: `ir/dce.ts`'s `isPureFn` walker, `isSeed` and `rebuildStmt` (they special-case a few
  kinds and defer the rest to `isObservable` or keep them as is, so a new kind that holds nested
  blocks or mutates memory needs a case there), the codegen switches (`codegen/program.ts`,
  `codegen/lower/`) and the op sets in `ir/nodes/schema.ts` (`BIN_OPS`, …).
- **Memory model** is Solidity's: `0x00–0x3f` scratch, `0x40` free-memory pointer, `0x60` the
  zero slot (the canonical empty value `try*` failures, unset `s.newArray` elements and omitted
  `s.tuple` members point at — a zero-filled pointer slot would alias scratch, so memref slots
  are always initialised; `emitZeroValue` in `codegen/memory.ts`), a **static frame from `0x80`**
  with one 32-byte slot per arg / cell / value, and bump allocations after it (returndata
  snapshots, dynamic values, mutable arrays, the return tuple). A `s.read`/`s.call` site whose
  outputs are all words snapshots its returndata above the free pointer without bumping it (the
  words are copied into their slots at once); `callSiteAllocates` in `codegen/call/shared.ts`
  decides this for both the emitter and the `LOOP_ALLOCATION` diagnostic, so the two cannot
  drift. Args that need encode frames (`callArgEncodeFrames`, same file) reserve them by bumping
  the free pointer, and the recursive calldata encoder (any tuple, fixed-size or
  composite-element array input) stages its data-literal args in a block it allocates the same
  way (`callArgStaging` in `codegen/call/calldata.ts`, nonzero size → a bump), so the diagnostic
  flags those sites too, whatever their outputs (the emitter reads both helpers too). Memory above the free pointer is dirty (calldata images, rolled-back and transient
  snapshots): the construction templates (`s.newArray`, `s.tuple`, typed zero values, dynamic
  literals) allocate through `emitAlloc` (`codegen/memory.ts`), which zero-fills a block only
  when one of its words would be read before it is written — a word slot left to its zero value;
  memref slots and literal images are always written, so those blocks skip the fill. Every word
  in a slot is
  canonical (`uintN` zero-extended, `intN` sign-extended, `bool` ∈ {0,1}, `bytesN` left-aligned);
  dynamic values and tuples are pointers. Every array — `T[]` and fixed-size `T[N]` alike — is a
  length-prefixed block (`[len][slot…]`, `len === N` for a `T[N]`) of inline words or element
  pointers, so one set of array ops serves both; only the ABI codec knows a `T[N]` has no length
  word on the wire. No slot reuse or fusion by default, on purpose — the
  disassembly stays legible and the stack invariant machine-checkable; `optimize: true` packs
  dead values' slots without changing the templates.
- **Array codec** (`codegen/abi/encode.ts`, `codegen/abi/decode.ts`). The encoder keeps its loop state in frames reserved below
  the output buffer, so nesting never touches the operand stack. An array loop's frame also
  caches, once per iteration, the element's pointer (when the element's encode reads it more
  than once) and a tuple element's base. Dynamic tuples nested three or more levels below their
  root (the top-level block or an array element) keep their base and source pointer in a frame
  of their own, so a member access is one load at any depth; the first two levels re-derive them
  from the parent, which costs less than reserving a frame (`encodeFramesOf` mirrors that rule
  to size the reserved region). The decoder has three lowerings,
  chosen per array level at codegen time: the **stack fast path** for the one- and two-level
  shapes (`T[]`, `T[][]`, `tuple[]`, `string[]`/`bytes[]`) keeps five loop words per level on the
  stack, the **fixed-word path** for a fixed-size word array (`uint256[N]`, `address[N]`,
  `uint8[N]`, …) copies the wire body in bulk (its decoded block is that body behind a length
  word): one `MCOPY` on cancun for a full-word element, else a fused copy-and-normalize loop
  (inline, not `@memcpy`, whose calling convention needs an empty stack beneath it) — ~3 / ~70
  gas per element against ~205 for the heap loop, and the **heap-frame path** for everything
  else (any other `T[N]`, `uint256[][][]`, `string[][]`, `tuple[][]`, …) keeps the loop words in
  a heap frame chained through scratch `0x20` (one stack word per level). Both fast paths are
  emitted speculatively (`AsmWriter.checkpoint` / `rollback`) and replaced by the heap path when
  they would overflow the 16-item template budget at that depth (a fast-path shape deep inside
  tuples or heap levels), so neither ever needs more stack than the heap path. The stack and
  heap paths save and restore `0x20`, so they nest in either order. The heap path is ~15–19%
  more gas on the two-level shapes (#52), which is why the stack fast path stays: a shape that
  decoded before #4 must never get bigger or dearer (the `#52 corpus` entries of
  `compile.bytecode.test.ts`; `uint256[][]` shrank when inner full-word arrays started aliasing
  the source). Every offset / length bound is `x >> 64 ≠ 0` (`emitAboveU64`,
  `PUSH1 64 SHR`, 3 bytes against `PUSH8 … LT`'s 10); the shift result is not a boolean, so it
  may only feed a branch, which is why it is a helper and not a peephole rule. The array paths
  bound the array body against the source end (`D + 32·len`, or `D + len·staticSize`) BEFORE
  they allocate anything, so an unbacked length word (anything up to the `2^64−1` guard) fails
  cleanly instead of bumping the free pointer or writing a heap frame at `32·len`; the heap frame
  sits at the free pointer, below its pointer block, and is written addressed off the
  not-yet-bumped free pointer to keep the prologue's stack peak low. A dynamic tuple's WHOLE head
  (`headBytes`) must fit before it is read, at every level, matching `ir/interp/decode.ts`.
  Dynamic members alias the source snapshot, except narrow word arrays (`uint8[]`, …), which are
  normalized into a fresh copy — normalizing in place would rewrite bytes another decoded value
  may alias. The interpreter decodes fresh copies instead, so `validateIr` only admits an
  `arrset` whose target is an `arrnew` result (all the builder emits: `MutArray` handles exist
  only for `s.newArray`); tuples are always decoded into their own block, so `tupleset` stays
  legal on any tuple.
  Full-word `T[]` (`uint256[]`, `int256[]`, `bytes32[]`) alias at every level, array
  elements included. A dynamic sub-tuple's base is re-derived from its parent's
  (`parentBase + MLOAD(parentBase + ho)`) at each use, which costs O(depth) per member access
  down a chain of nested structs; so a dynamic sub-tuple whose parent base is itself re-derived
  gets a two-word heap TUPLE FRAME `{base, parent}` chained through `0x20` like the heap array
  frames, and its members read the base back in O(1) (the first re-derived level keeps the plain
  derivation, cheaper than a frame for one level, and so does a sub-tuple whose base is read
  fewer than 3 times, e.g. a lone `string` member: `framesTuple`). Returndata decodes are
  **budgeted** against overlapping offsets (N offsets
  at one element would otherwise make the decode quadratic in the returndata size): every tail
  block the decoder materializes is charged its source-equivalent size (`arrayDecodeCharge` /
  `tupleDecodeCharge` in `abi/layout.ts`) after its bounds and before it is allocated, out of
  `payload + DECODE_BUDGET_SLACK` (8192 words, viem's default `recursiveReadLimit`): a
  dynamic-length `T[]` its length word plus body (`32 + len·elemBytes`, a static struct /
  static `T[N]` element at its static size; not aliased full-word arrays nor a call's own narrow
  word-array outputs) and, under `'repeated'` (inside an ABI-dynamic array's element), a dynamic
  tuple its head and a dynamic `T[N]` its `32·N` offsets. Static composites are inlined and
  charged with their holder, so a non-overlapping encoding charges at most its own size, and
  every block's memory is within a type-fixed factor of its charge (decode memory stays linear).
  That is also why the fixed-word path has no charge site of its own (a static `T[N]` never
  charges; `emitDecodeArrayToMem` takes it only when `arrayDecodeCharge` is `null`), and why a
  tuple frame (two words per framed dynamic tuple) needs none either: it is allocated between the
  sub-tuple's head bound and its charge, so a failing charge leaves at most those 64 uncharged
  bytes, which a try verb rolls back with the rest of its decode. The remaining budget lives in the word at the source end (`buf + rds`,
  unaligned; the snapshot's free-pointer bump reserves it), initialised by
  `emitInitDecodeBudget` only at sites whose output types can charge (`needsDecodeBudget`), so
  other shapes keep their bytes; running out is the ordinary decode failure. A well-formed
  encoding charges at most its own size, so only overlap can exhaust it. `ir/interp/decode.ts`
  charges the same blocks, so interp == bytecode on every payload. Script args (the caller's own
  calldata) are not budgeted. Each tuple level and each heap array level keeps one live stack word, so a deep
  enough struct/array chain cannot fit the 16-item window at all: `emitWithinStackBudget`
  (`codegen/abi/shared.ts`) turns that into a coded `UNSUPPORTED_V0` compile error at every
  decode / zero-value entry instead of the asm verifier's INTERNAL one. A try verb whose outputs
  decode through these decoders rolls the free pointer back to the returndata snapshot on a
  decode failure before its zero block (`emitTryEpilogue`). Arrays nest at most
  `MAX_ARRAY_DEPTH` (4) levels; deeper types are `UNSUPPORTED_V0` in `t.array`, type-string
  validation, `abi/layout`, `abi/artifact` and `ir/validate`. Suffix chains are peeled
  iteratively and validated before `abi/layout` recurses, so a hostile 50,000-suffix string
  reaches that gate instead of overflowing the host stack. An ABI-static type must also stay
  below `MAX_STATIC_SIZE` (2^32 bytes): codegen pushes static sizes and head sizes as
  immediates, which must be exact JS integers, so nested fixed lengths (`uint256[1e8][1e8]`)
  are `UNSUPPORTED_V0` in the `t` constructors, type-string validation, `ir/validate` (so
  `compile()` and `interpret()` agree on deserialized IR) and `abi/layout` (the funnel every
  codegen path goes through). Every static level is gated, as `abi/layout` builds it, so an
  array of an oversized static element (`uint256[1e8][1e8][]`) is too. The interpreter charges
  zero-filled array elements to `maxSteps` before allocating them, so a huge zero is
  `COMPILE_LIMIT`, not a host OOM.
- **Checked arithmetic** follows solc ≥ 0.8 `Panic(uint256)` codes (0x11 overflow and checked
  narrowing, 0x12 division by zero, 0x32 out-of-bounds, 0x41 over-allocation), verified
  differentially against solc-compiled reference contracts. `pow` has three templates, all
  exact (the interpreter's exact power + range check is the oracle): a folded base is one
  `e > maxE` check + `EXP` (solc's literal-base path, generalized), a folded exponent is a
  precomputed integer-root bound on the base + `EXP`, and the general case is solc's
  square-and-multiply loop on the magnitude (≤ 7 iterations; a signed base is split into sign
  and magnitude, the bound is `2^(N−1)` for a negative result). `addmod` / `mulmod` share
  `div` / `mod`'s zero guard and its elision for a folded nonzero constant. A folded constant
  operand also selects cheaper exact templates for unsigned `mul` (`x > ⌊max / c⌋`, the
  256-bit bound computed as `PUSH c PUSH0 NOT DIV` when that is shorter than its immediate)
  and `int256` `add` / `sub` (only the sign case the constant allows), and a folded array index
  below 2^32 becomes a constant bound and offset. Binary templates load the right operand first
  (`[a, b]`, left on top); the commutative ones and the comparisons (flipping `LT` ↔ `GT`) load
  the left one first when the previous statement just stored it (`justStored` in
  `codegen/lower/context.ts`), so the peephole's store-then-reload rewrite fuses method chains.
  `select` is branch-free (`b ^ ((a ^ b) · cond)`).
- **Wrapping arithmetic and `mulDiv`** are explicit per-operation opt-ins next to the checked
  ops, never a mode: `wrappingAdd` / `wrappingSub` / `wrappingMul` record their own `bin` ops
  (`wrapadd` / `wrapsub` / `wrapmul`: the bare opcode, plus a mask or `SIGNEXTEND` below 256
  bits — solc's `unchecked`), so a plain `add` keeps its meaning wherever it is recorded.
  `mulDiv` / `mulDivRoundingUp` are the `muldiv` / `muldivup` ops of the ternary `modarith`
  node (uint256 operands, like `addmod` / `mulmod`), lowered in `codegen/lower/muldiv.ts` to the
  FullMath sequence (a one-word `DIV` fast path when the product's high word is zero) with
  OpenZeppelin `Math.mulDiv`'s Panic codes (0x12 zero denominator, 0x11 quotient overflow);
  `EvsFullMathReference` is their solc oracle.
- **Errors at build time** (`EvsTypeError`, `EvsStagingError`) are thrown synchronously inside
  the user's `evscript` callback, so the plain JS stack trace points at the offending line (evs
  captures no source locations of its own); at run time the artifact's `explainRevert(data)`
  maps revert payloads back to the site (kind, detail and site id) that produced them.
- **Revert attribution** has two lockstep pairs. The site table (`codegen/sites.ts`) gives each
  panic site the exact `panicCodes` its template can raise, mirroring the elisions in
  `codegen/lower/` (folded divisors, free conversions, check-free `pow` literals, …); checked
  add / sub / mul ask the lowering itself (`checkedArithCanOverflow`, the predicate
  `lowerCheckedArith` picks its constant templates with), so those two cannot drift.
  `explainRevert` lists a panic's candidates from `panicCodes`, never from the `detail` text.
  `codegen/sites.test.ts` compiles one checked op per script (plus a sweep of constant add / sub /
  mul operands over every width class) and compares the claimed codes with the panic tails the
  bytecode references, so a lowering change that adds or drops a check must update
  `classifySite` too. And `explainRevert` and `decodeScriptError` share one byte-level
  classifier (`abi/revert.ts`; `abi/revert.test.ts` feeds one payload corpus to both). Payloads
  only a callee can produce (empty, `Error(string)`, foreign selectors) are attributed to the
  strict, non-`revertReturns` call sites — the only ones that bubble.
- **Built-in errors have one home each.** `EVS_ERROR_ABI` (`abi/artifact.ts`) lists the evs
  runtime errors every artifact ABI carries, and `EVS_ERROR_NAMES` reads their names off it (no
  script may take one as its name). `RESERVED_ERROR_NAMES` (`core/types/namespace.ts`, because
  `core/` cannot import `abi/`) lists the names `t.error` and `buildScriptAbi` refuse.
  `EVS_ERROR_NAMES` is typed through `ReservedErrorName`, so a runtime error that is not also
  reserved fails to compile. The built-in selectors and `BUILTIN_ERROR_SIGNATURES` (the selectors
  a declared error may not reuse) live in `abi/artifact.ts`, and codegen's revert tails import
  them from there.
- **Overload resolution** (the call verbs, `t.fromOutputs`) happens at recording: the recorded
  `call` statement carries one concrete ABI entry, so codegen never sees an overload. The rules
  exist twice and must stay in lockstep: `Recorder.resolveOverload` / `argFits`
  (`builder/expr/calls.ts`) at run time and `ResolveOverload` / `FitsArg`
  (`builder/script/calls.ts`) at the type level — arity (a lone arity match wins without
  looking at the args), then per argument: a handle (`Expr`, `MutArray`, `Tuple`) of exactly the
  parameter's type, or a literal of the right JS kind (never its value) — an array literal needs
  fitting elements and, for a fixed `T[N]`, exactly N of them; a tuple literal is a name-keyed
  record only when every member is named, else a positional array (abitype's rule, shared with
  `s.tuple` inits: `allMembersNamed` / `AllMembersNamed`; a member with no `name` key, as
  viem's `parseAbi` emits, is unnamed — the recorder reads raw overload inputs through
  `normalizeAbiParam`); several fits are an ambiguity, none
  a mismatch (both also compile errors). The verbs' `args` type a struct (and each `tuple[]`
  element) as that same complete literal, `StructLiteral` (`builder/script/handles.ts`): every
  member present, each a constant, a handle or a nested literal, as the coercion (`buildTupleNew`)
  takes it; only `s.tuple` inits (`TupleInit`) may omit members in the types (the coercion
  zero-fills an omitted member anywhere). A struct literal fits only if every key `Object.keys`
  lists (numeric ones too) names a member (positional: exact length), as the coercion rejects
  anything more; at the type level an optional extra key, an index signature or a positional
  literal of statically unknown length (optional elements, a plain `T[]`) is a maybe-fit. The one intended difference: the types compare a
  fully named struct's members by name, not position (a `t.struct`'s order is not visible to them). Any rule
  change goes to both sides plus a case in the shared matrix
  (`packages/evs/test/harness/overload-matrix.ts`), which `overload-lockstep.test-d.ts` and
  `overload-lockstep.test.ts` assert on the types and the recorder respectively. A `functionName`
  containing `(` is a canonical signature (`core/signature.ts`) and skips resolution. The strict
  and try verbs share one overload set per mutability bucket (`SubcallVerbOf<mut, tried>`, plus
  `CallVerbOf<tried>` for `revertReturns`); `Tried<tried, v>` is the only difference (the try
  flavour wraps the result as `{ success, value }`).
- **Tuple handles** (`builder/expr/handles.ts`) carry one own property, the enumerable symbol
  `HANDLE_COPY_MARK` (valued with the handle; `Expr`, `Cell` and `Field` handles carry it too):
  object spread copies it, so `copiedHandle` spots a `{ ...handle, a: x }` copy, which holds no
  member of the handle, and the recorder rejects one that leaves a member out of a tuple init or
  an `s.return` record instead of zero-filling it. Named fields are getters
  on one prototype per component list (a `WeakMap` keyed on `components`, which survives the
  descriptor rebuilds of array elements and members), whose prototype is `TupleHandle`'s.
  A field whose name is a handle member gets no getter (the member wins; `.at(i)` reads it). The
  names live twice — the runtime `TUPLE_HANDLE_MEMBERS` and the `TupleHandleMember` type that
  `Tuple<C>` filters on (`builder/script/handles.ts`) — and a type test keeps them equal, while a
  unit test fails if a new handle method or trap is missing from the list. `__proto__` is not an
  identifier at all (`IDENT_RE`, rejection text from `identProblem`), and evs-built name-keyed
  records use `Object.fromEntries`. A literal `{ __proto__: … }` key never reaches
  `Object.entries`, so `t.struct` / `s.return` also reject a record whose prototype holds what
  such a key would have carried (`nonRootPrototype`: a `TupleType` or component list for
  `t.struct`, an evs handle or `Cell` for `s.return`; a `null` prototype or a class instance loses
  nothing and is read through its own keys) and type the record with `NoProtoKey` (the only guard
  for a primitive value, which JS drops). User records keyed by member name (`s.tuple` init, `s.throw`
  args, overload `argFits`) are read with `Object.hasOwn`, never through the prototype.
- **The artifact** exposes `runtimeBytecode` and `initBytecode` separately and never a field
  named `code`: viem's deployless `code` parameter needs **init** code (a raw runtime blob fails
  silently), and `toViem()` always hands viem the right flavor for the chosen mode.
- **Deployless calls are contract creations** (`deployless.ts`). viem's
  `deploylessCallViaBytecode` wrapper (398 bytes) deploys `initBytecode`, calls it and RETURNs
  the script's result as its own deployed code, so EIP-170 (result ≤ 24,576 bytes), EIP-3541 (no
  leading `0xEF`) and EIP-3860 (wrapper + encoded `initBytecode` + encoded calldata ≤ 49,152
  bytes) apply to every deployless call and to no state-override one. evs answers with
  `DEPLOYLESS_RESULT_*` compile diagnostics for what the result shape decides,
  `deploylessDataSize` for the args side and `explainDeploylessError` for the node's error text;
  the wrapper size is a constant pinned against the installed viem by `deployless.test.ts`, and
  `test/integration/deployless-limits.test.ts` pins the three boundaries on anvil.
- **No dependencies, abitype through viem.** The library's `dependencies` are empty: `viem` is
  a required peer, and every abitype type (`Address`, `Abi`, `AbiParameter`,
  `AbiParameterToPrimitiveType`, …) is imported from `'viem'`, which re-exports them from the
  abitype it pins exactly. A direct `abitype` dependency (0.2.0 had `^1.3.0`) installs a second
  copy next to viem's under npm and bun, and an app's abitype `Register` augmentation then
  reaches only one of them. A lint rule (`no-restricted-imports` on `abitype` for
  `packages/evs/**`, root `vite.config.ts`) keeps it that way; the one abitype type viem does not
  re-export, `AbiParametersToPrimitiveTypes` (the named-tuple labels behind `LabelCarrier`), goes
  through viem's `ContractConstructorArgs` (which passes the named-tuple flag from viem 2.43.0:
  an older viem gives the same body-callback parameter types without the labels).
  `src/abitype.test.ts` pins the manifest and compiles an app-shaped `Register` augmentation in a
  program of its own, redirecting `abitype` to viem's copy for the fixture only (a `paths` entry
  would redirect evs's own imports too and hide a second copy).

## Testing

Three tiers, all run by CI (`ci.yml`):

- **unit** (`src/**/*.test.ts`, `test/harness/**/*.test.ts`) — in-process EVM harness
  (`@ethereumjs/evm`), including the anti-miscompilation core: the IR **interpreter vs the
  compiled bytecode** must agree byte-for-byte on returndata and revert payloads for every
  fixture — for the default output and its `optimize: true` twin alike (the interpreter runs
  `dce(ir)` like `compile()`; the recorded IR is checked too, see the pipeline note); ABI
  codecs vs viem's `encodeAbiParameters` / `encodeFunctionData`. One callee table (plus an
  optional balance table, `{ balances }` in the options) feeds both legs
  (`test/harness/differential.ts`): the `MockChain` answers sub-calls and `account` reads, the
  EVM fixture plants the same code and balances.
- **types** (`src/**/*.test-d.ts`) — vitest typecheck mode, `expectTypeOf` over the inferred
  ABI / result objects (this is why `viem` is exact-pinned in the catalog).
- **integration** (`test/integration`) — real `eth_call`s against a per-worker
  [anvil](https://getfoundry.sh) spawned by prool, both execution modes, including checked
  arithmetic vs the solc 0.8.30 `EvsReference` contract, `pow` / `addmod` / `mulmod` /
  signed shifts vs `EvsMathReference`, wrapping arithmetic / `mulDiv` vs
  `EvsFullMathReference`, and the address / fixed-bytes conversions and string/bytes byte
  access (`byteAt`, `slice`, `asString`) vs `EvsCastReference` (all codegen'd from
  `packages/contracts`, whose own forge tests run in CI's contracts step); an env-gated
  mainnet-fork suite (`ANVIL_FORK_URL`, an empty value counts as unset and skips it) covers
  the flagship scenario. CI's manual `fork-tests` job fails up front when the secret is missing.

Tests run on vitest through `vp test` (prool's per-worker anvil and typecheck tests need
vitest); test files import from `vite-plus/test`. The integration project's global setup
(`test/global-setup.ts`) keeps a prool `Pool` of anvils keyed on `VITEST_POOL_ID` behind a small
registry (`GET /<poolId>` → that worker's anvil URL, started on first use); each worker then
talks to its anvil directly over keep-alive connections. Not through prool's proxy `Server`: it
closes the connection after every request on both hops, and the resulting TIME_WAIT churn
(~17,000 loopback sockets per run) reset fresh connections at connect, failing whole files on an
unretried `eth_sendRawTransaction` (`connect ECONNRESET`).

## Releasing

Versioning is driven by [changesets](https://github.com/changesets/changesets); publishing by
`release.yml` with npm **OIDC trusted publishing** (no token anywhere).

1. A PR that changes the library in a user-visible way adds a changeset (`vp run changeset`).
2. On merge to `main`, `release.yml` opens / refreshes the **"chore(release): version packages"**
   PR: bumps `packages/evs/package.json` and writes the changelog (`CHANGELOG.md` is excluded
   from the formatter, since changesets writes it in its own style). No lockfile resync: pnpm
   links workspace packages without recording their version.
3. Merging that PR publishes: full gate (+ publint / attw) → `changeset publish`, which
   (changesets CLI 3) detects pnpm and runs
   `pnpm publish --access public --tag <tag> --no-git-checks` for each package whose version is
   not on npm yet (`prepublishOnly` rebuilds `dist/`), then creates the `@maxencerb/evs@X.Y.Z`
   tag and reports it through `CHANGESETS_OUTPUT`; the action pushes the tag and creates the
   GitHub release. The committed version is always the last released one. The tarball is
   `dist/` + README + LICENSE + package.json only (see
   [Library build](#library-build-vp-pack): sources live inside the `.js.map` files).

Why this works without a token or the npm CLI: since pnpm 11, `pnpm publish` is native (it no
longer shells out to `npm publish`) and implements npm trusted publishing itself — it reads
`ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` (the job's `id-token: write`), exchanges the GitHub
OIDC token for a short-lived npm token, and signs sigstore provenance automatically when the
repository and the package are both public. It rewrites `catalog:` / `workspace:` specs in the
packed manifest (the reason the bun era needed `bun pm pack` + `npm publish`). pnpm does not
read `publishConfig.provenance` (npm does; it stays `true` for any manual `npm publish`). A
provenance pnpm cannot attach is only a warning, so check the npm page after a release
(0.2.0 shipped with a SLSA provenance attestation). There is deliberately no automated
post-publish attestation check: registry metadata lags the publish and the check failed a good
release.

Prereleases: `vp exec changeset pre enter beta` / `pre exit` (pre-mode releases publish under
the pre tag). One-time setup already done: the npm trusted publisher is bound to workflow file
`release.yml` (do not rename it), and "Allow GitHub Actions to create and approve pull
requests" is enabled in the repo settings.

## Docs site

`apps/docs` is an Astro Starlight site deployed to <https://evs.maxencerb.com> by **Cloudflare
Workers Builds** (not GitHub Actions). Worker `evs`, two build triggers ("Deploy default
branch" for `main`, "Deploy non-production branches" for everything else; inspect or change them
with `cf builds triggers list|update` or in the dashboard under Workers → `evs` → Settings →
Build):

- root directory `/`, path filter `*` (every push builds)
- no build variables: the image detects Node from `.node-version` (24) and pnpm from
  `packageManager`, and runs `pnpm install --frozen-lockfile` itself before the build command
- build command (both triggers)
  `pnpm --filter @maxencerb/evs run build && pnpm --filter @maxencerb/evs-docs run check:snippets && pnpm --filter @maxencerb/evs-docs run build`
- deploy command `npx wrangler deploy -c apps/docs/wrangler.jsonc` (non-production branches:
  `npx wrangler versions upload -c apps/docs/wrangler.jsonc` for a preview URL)

The build does not need the global `vp` CLI: everything resolves from `node_modules` — `vp pack`
is the project-local binary of `vite-plus` and the docs scripts run on plain Node. `wrangler.jsonc` sets
`workers_dev: false` (the custom domain is the only production route) and `preview_urls: true`
explicitly: wrangler syncs both flags on every deploy, and with `preview_urls` absent it
follows the workers.dev flag, so each merge to `main` used to switch branch preview URLs back
off. `wrangler` is a **root** devDependency on purpose: the deploy command runs `npx wrangler`
from the repo root, and pnpm only links a workspace's binaries into that workspace's own
`node_modules`. Every ` ```ts ` fence under `apps/docs/src/content/docs/` must typecheck
standalone against the built package (`pnpm run check:snippets` in `apps/docs`);
` ```ts nocheck ` opts out. `astro build` also validates every internal link.

Deployment deliberately stays on **wrangler**, not Cloudflare's `cf` CLI (evaluated with
`cf@1.0.0-beta.6` on 2026-09-30; wrangler stays supported for 18 months after the `cf` beta
ends). `cf migrate` maps every `wrangler.jsonc` setting faithfully (name, compatibility date,
`workersDev: false`, `previewUrls: true`, `notFoundHandling: "404-page"`, the custom domain), but
its output still bundles through wrangler (a `wrangler.config.ts` importing
`wrangler/experimental-config`, so wrangler stays installed), and `cf build` / `cf deploy` run
`astro build` and then require Build Output under
`.cloudflare/output/v0/`, which a static Astro build only emits with the `@astrojs/cloudflare`
adapter. Revisit once `cf` can deploy a prebuilt static-assets directory without an adapter;
until then keep `wrangler.jsonc` and the dashboard commands above unchanged.
