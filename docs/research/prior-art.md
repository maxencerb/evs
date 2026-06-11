# Prior Art Survey: Staged/Embedded DSLs That Compile a Host-Language Builder to Another VM's Code

Research date: 2026-06-11. All statuses ("maintained", versions) are as of this date.
Audience: evs compiler/library implementers without web access. Sources cited inline.

evs recap for context: `evscript({name, args}, (s) => { const x = s.call({address, abi, functionName, args}); ...; return s.return({...}) })` records a typed IR; an embedded plain-TS compiler emits EVM **runtime bytecode**; execution is via `eth_call` with a state override (set `code` at an address) or viem-style deployless calls; output includes a literal `as const` ABI so `viem.readContract` infers everything.

---

## 1. weiroll + weiroll.js — the closest "call-chaining planner" prior art

Repos: https://github.com/weiroll/weiroll (the on-chain VM, Solidity) and https://github.com/weiroll/weiroll.js (the off-chain planner, TypeScript).

### Architecture

Weiroll splits the problem opposite to evs: a **generic interpreter contract deployed on-chain** (the weiroll VM) executes a list of encoded "commands"; the off-chain `Planner` only produces `(commands: bytes32[], state: bytes[])` — it never emits bytecode. evs instead compiles a specialized program per script and needs **no deployed interpreter**.

### Planner API (from README, https://github.com/weiroll/weiroll.js/blob/main/README.md)

```js
const ethersContract = new ethers.Contract(address, abi);
// delegatecall library:
const lib = weiroll.Contract.createLibrary(ethersContract);
// regular call / staticcall target:
const c = weiroll.Contract.createContract(ethersContract, CommandFlags.STATICCALL);

const planner = new weiroll.Planner();
const ret = planner.add(c.func(a, b));          // returns a ReturnValue handle
planner.add(other.use(ret));                     // handles feed later calls
const { commands, state } = planner.plan();
```

Call modifiers on the `FunctionCall` object: `.withValue(c)` (CALL_WITH_VALUE), `.staticcall()`, `.rawValue()` (return raw bytes instead of decoding — their escape hatch for multi-value returns). Nested VM instances (flash-loan callbacks) use `planner.addSubplan(...)` with a `SubplanValue`; subplans are "limited to one planner and one state argument; must return `bytes[]` or nothing". There is also `planner.replaceState()`.

Key documented footgun (README): "Remember to wrap each call to a contract in `planner.add`. Attempting to pass the result of one contract function directly to another will not work — each one needs to be added to the planner!" — i.e. sequencing only happens by recording. evs has the same recording semantics via `s.call`; make this explicit in docs and runtime checks.

### Internal representation (from src/planner.ts)

- Value types implementing a `Value` interface: `LiteralValue` (ABI-encoded via ethers `defaultAbiCoder.encode`), `ReturnValue` (points at the originating `Command`), `StateValue` (placeholder typed `bytes[]`), `SubplanValue`.
- `plan()` is a three-phase mini register allocator: (1) `preplan()` computes last-use ("visibility") of every literal and return value; (2) literals are deduplicated and pre-placed into initial state slots with expirations; (3) commands are emitted in order, return values get slots, **freed slots are reused**.
- Command encoding, one 32-byte word per command (spec in https://github.com/weiroll/weiroll README):
  - bytes 0–3: 4-byte function selector
  - byte 4: flags — bits 0–1 calltype (`0x00` DELEGATECALL, `0x01` CALL, `0x02` STATICCALL, `0x03` CALL with value), bit 6 `ext` (extended command: next 32-byte word is the input list), bit 7 `tup` (raw/tuple return, store undecoded)
  - bytes 5–10: up to 6 one-byte input specifiers; byte 11: one output specifier; bytes 12–31: 20-byte target address
  - each specifier byte: bit 7 = `0x80` variable-length flag (dynamic types: string/bytes/array/tuple, detected via ethers `isDynamicType()`), low bits = state index; `0xFE` = USE_STATE (pass/receive whole `bytes[]` state), `0xFF` = END_OF_ARGS / no return
- Limits: ≤127 addressable state elements (7-bit index, 0xFE/0xFF reserved), 6 args per basic command (unlimited via extended commands), exactly one decodable return value per command.

### Typing limits

`Contract` builds `ContractFunction` methods **dynamically from the ethers `Interface`** — there are no TS generics anywhere; `planner.add(...)` returns an untyped `ReturnValue`. Argument count/type are validated at call time against `ParamType` (runtime only). So weiroll.js gives zero compile-time type help; evs's abitype-driven typing is a direct response to this gap.

### Maintenance & production lessons

- npm `@weiroll/weiroll.js` is stuck at **v0.3.0** (published 2021-07), depending on `ethers ^5.3.1` (https://registry.npmjs.org/@weiroll/weiroll.js/latest). Effectively unmaintained upstream.
- The maintained lineage is Enso's fork https://github.com/EnsoBuild/enso-weiroll, audited by ChainSecurity (https://www.chainsecurity.com/security-audit/enso-weiroll-smart-contracts). Enso ("Shortcuts", reportedly >$15B routed volume) and Royco use weiroll in production.
- Enso's production deployment **disabled DELEGATECALL entirely and runs CALL only** (https://blog.biconomy.io/from-scripts-to-programs-how-smart-batching-evolves-on-chain-execution/) — the generic on-chain interpreter was too big a trust surface. Weiroll "has no built-in validation layer; all safety must come from the called contracts" and has no built-in branching or looping (same source).

Lessons for evs: (a) liveness-based slot/memory reuse and literal deduplication are cheap and proven; (b) a generic on-chain interpreter creates an audit/trust problem that per-script compiled bytecode avoids; (c) untyped `ReturnValue` handles are the #1 DX complaint to fix; (d) the "you must record every call" rule needs loud enforcement.

---

## 2. PyTeal (Algorand) — the cautionary tale for expression builders

Docs: https://pyteal.readthedocs.io/en/stable/control_structures.html, repo: https://github.com/algorand/pyteal.

### The model

Everything is an `Expr` with a `TealType` (`uint64`, `bytes`, `none`, `anytype`). Programs are built as expression trees in Python, then `compileTeal()` (or the newer `Compilation(...).compile(...)`) emits TEAL assembly.

Control flow constructs (exact syntax):

```python
Seq(expr1, expr2, expr3)                 # all but last must be TealType.none; use Pop() to discard values
If(test).Then(a).ElseIf(t2).Then(b).Else(c)   # test: TealType.uint64; all branches same type
Cond([t1, body1], [t2, body2])           # first true wins; panics with `err` if none match
While(cond).Do(body)                     # body: TealType.none; AVM version 4+
For(init, cond, step).Do(body)           # init/step: none, cond: uint64; v4+
Break() / Continue()                     # only inside loops
Assert(cond)
Approve() / Reject()                     # immediate program exit, even inside subroutines
Return() / Return(Int(1))                # subroutine return vs program exit

@Subroutine(TealType.uint64)             # declared return type
def myFunc(arg1, arg2: ScratchVar): ...  # args are Expr (by value) or ScratchVar (by reference)
```

Subroutine constraints: ScratchVar params need annotations; **recursion is disallowed with ScratchVar params**; PyTeal must track caller-owned vs callee-owned scratch slots and save/restore around calls (design discussion: https://github.com/algorand/pyteal/issues/71). Features are gated on AVM "program version" (loops/subroutines v4+) — a precedent for evs's EVM-version gating (see lesson 10).

### Pain points (the important part)

The Algorand Foundation built a replacement compiler (Puya / "Algorand Python", https://github.com/algorandfoundation/puya) and its principles doc states the indictment of the expression-builder approach verbatim:

> "Many classes of errors resulting from the interaction between the procedural elements of the Python language and the PyTEAL expression-building framework go unnoticed until the point of TEAL generation, or worse go completely unnoticed, and even when PyTEAL can/does provide an error it can be difficult to understand."

and that the generative/metaprogramming paradigm "presents an additional hurdle for developers", with "suboptimal" tooling support (https://algorandfoundation.github.io/puya/principles.html). Concrete classes of bug:

- Host `if x:` / `and` / `or` on an `Expr` silently evaluates Python truthiness of the node object instead of staging a branch — the program compiles and is wrong.
- Mixing Python ints/strings with `Expr` (`Int(1) + 1`) errors only at tree-build or TEAL-generation time, far from the call site.
- Opaque diagnostics, e.g. https://github.com/algorand/pyteal/issues/232 "DynamicScratchVar: user-defined DynamicScratchVars in @Subroutines produce opaque errors".

### What they fixed late: source maps

PyTeal **0.24.0** added source mapping (https://developer.algorand.org/articles/pyteal-sourcemapping/, https://pyteal.readthedocs.io/en/stable/sourcemap.html): `Compilation(...).compile(with_sourcemap=True, annotate_teal=True, pcs_in_sourcemap=True, annotate_teal_headers=..., annotate_teal_concise=...)` produces TEAL annotated with the PyTeal file/line that generated each line, and PC→source mapping, so "assert failed pc=70" maps back to a Python line. This was requested as far back as issue #116 (2021): https://github.com/algorand/pyteal/issues/116. Build this in from day one in evs.

Takeaway: the expression-builder paradigm is viable for *small* programs (evs scripts are small read DAGs), but only with aggressive guardrails: brand handles so host-language misuse throws immediately, attach source locations to every node, and keep diagnostics in user vocabulary. PyTeal's fate (replaced by a real-syntax compiler) was driven by people writing *whole applications* in it — not evs's use case — but every one of its failure modes applies at small scale too.

---

## 3. thi.ng/shader-ast — the best typed-TS embedded DSL to copy from

Package: `@thi.ng/shader-ast` (https://www.npmjs.com/package/@thi.ng/shader-ast, README: https://github.com/thi-ng/umbrella/blob/develop/packages/shader-ast/README.md, docs: https://docs.thi.ng/umbrella/shader-ast/). Status: STABLE, used in production.

### Node representation

The whole AST is plain data: every node is a `Term<T>` where `T` is a **string-literal type parameter** naming the target-language type (`Term<"float">`, `Term<"vec3">`, samplers, matrices...). Nodes carry `tag` (node kind), `type` (the string type), and `info` (metadata for codegen). The README calls the package "both an embedded DSL **and IR format**" — the AST is serializable data decoupled from any code generator, and the DSL "define[s] a partially type checked AST" with "automatic vector-scalar overrides", argument checking, and function return type inference.

### How it keeps TS inference

All builders are generic over the string-literal types, so TS infers everything without annotations. Verbatim example from the README:

```ts
const lambert = defn(
    "float",                       // return type
    "lambert",                     // function name (for codegen)
    ["vec3", "vec3", "bool"],      // arg types
    (n, ldir, bidir) => {          // body fn receives typed Sym<"vec3">, Sym<"vec3">, Sym<"bool">
        let d: FloatSym;
        return [                   // body = array of statement nodes
            (d = sym(dot(n, ldir))),
            ret(ternary(bidir, fit1101(d), clamp(d, float(0), float(1))))
        ];
    }
);
```

Notable: `defn` returns a value that is **both an AST node and a callable TS function** — calling `lambert(x, y, z)` from another `defn` body type-checks arguments via mapped types and records a call node, and "a call graph for the function is generated". Locals are introduced with `sym(initExpr)`; statements vs expressions are syntactically distinct (`ret`, `assign`, `ifThen(test, truthy, falsy)`, `forLoop(sym, testFn, iterFn, bodyFn)`, `whileLoop`, vs expression-level `ternary`).

### Codegen architecture

- Code generation works "for individual expressions or entire shader programs, including call graph analysis and topological re-ordering of all transitively called functions" (dead-code elimination falls out of this).
- Targets are **separate packages** consuming the same IR: `@thi.ng/shader-ast-glsl` (`targetGLSL()`, GLSL ES 1.00 & 3.00), `@thi.ng/shader-ast-js` (`targetJS()` — compiles the same AST to runnable JS so shaders can execute on the CPU/Canvas2D; notably "much more involved than the GLSL code gen" because JS lacks vector ops), `@thi.ng/shader-ast-stdlib` (~220 reusable typed functions), `@thi.ng/shader-ast-optimize` (constant folding).
- Tree utilities for tooling: `walk`, `scopeChildren`, `allChildren`.
- Known gaps: structs and uniform blocks unimplemented (listed as future goals).

Lessons for evs: (a) string-literal type params (for evs: abitype's `AbiType` strings like `'uint256'`) are the proven way to keep full TS inference in a builder; (b) keep the IR serializable plain data with a stable `tag/type/info` shape, separate from codegen; (c) a second "JS interpreter" target of the same IR is the cheapest debugging/testing story (run scripts against a mocked chain in-process); (d) statement arrays + explicit `ret` make the statement/expression split unambiguous; (e) shipping a typed stdlib package multiplies the core's value.

---

## 4. AssemblyScript — why evs is NOT a real-syntax compiler

Site: https://www.assemblyscript.org/concepts.html and https://www.assemblyscript.org/status.html.

AssemblyScript compiles **actual TypeScript-ish syntax** ahead-of-time to WebAssembly. What that choice costs them (their own docs):

- "Compiled statically ahead of time", making it "infeasible to support very dynamic JavaScript features ... respectively requires stricter type checking to guarantee correctness at runtime where TypeScript would not complain."
- **No closures** ("functions with a captured environment are not yet supported and we are waiting for the Function References and Garbage collection proposals to land").
- **No union types** (`string | boolean`), no `any`, no optional properties like `firstName?: string`; generics partially substitute.
- **No exceptions** (Wasm limitation at the time).
- They had to reimplement an entire standard library, and virtually no existing npm package can be consumed — the ecosystem is parallel, not shared. The result is a language that *looks like* TypeScript but silently isn't, which is its most-cited DX complaint (e.g. https://blog.suborbital.dev/assemblyscript-vs-typescript).

For evs the equivalent trap would be parsing real TS function bodies (or a custom `.evs.ts` syntax) and compiling them to EVM bytecode: you would have to define semantics for the whole language on a 256-bit stack machine, fork type-checking, and break every editor/linter/test tool. KimlikDAO's EvmScript (section 5) pays exactly this cost with its `.evm.ts` transpiler. A plain-TS callback builder keeps oxlint/oxfmt, bun test, tsc and editor tooling working unchanged, and the type system itself (via abitype) does the heavy lifting.

Tooling lessons worth stealing from AssemblyScript anyway: they kept npm distribution and `tsconfig`-style config so the toolchain feels native; they maintain a "portable" stdlib subset that runs under both plain TS and AS (precedent for evs utilities that work both staged and unstaged); they emit source maps from day one; and their docs lead with an explicit "differences from TypeScript" page — evs docs should likewise lead with "what executes at build time vs on-chain".

---

## 5. Ecosystem survey: JS/TS EVM assemblers, DSLs, multicall builders

Nothing found does what evs does (typed plain-TS builder → EVM runtime bytecode for `eth_call` read scripts + generated `as const` ABI). The landscape:

### Assemblers / low-level DSLs

| Project | Lang/host | What it is | Status (2026-06) |
|---|---|---|---|
| `@ethersproject/asm` (https://docs.ethers.org/v5/cli/asm/, npm `@ethersproject/asm`) | JS, text DSL | "Ethers ASM Dialect": labels (auto-`JUMPDEST`), functional + stack notation with operand-count verification, multi-pass assembly "until the bytecode stabilizes" (compact jumpdests), embedded JS meta-programming via `{{! code }}` / `{{= code }}` | ethers-v5-era experimental; **not carried into ethers v6**; unmaintained |
| `evmasm` (https://github.com/ajlopez/evmasm, npm `evmasm`) | JS, text DSL | `evmasm.compile('mstore(0x40, 0x60)')` → bytecode | hobby project, stale |
| `emasm` (https://www.npmjs.com/package/emasm) | JS, S-expressions | assembles bytecode from a nested-array AST; lowercase opcode atoms; numbers → minimal-width PUSH; explicitly markets generating "**eth_call tx script payloads** or full-fledged contracts" — closest in *goal* to evs but completely untyped | stale |
| `evmscript` (npm, v0.0.2, 2021-09, Tim Coulter) | JS | "Write EVM assembly using Javascript!" (https://registry.npmjs.org/evmscript/latest) | abandoned |
| **EvmScript** (KimlikDAO, https://docs.evmscript.org/, https://github.com/KimlikDAO/EvmScript) | TS + custom syntax | `.evm.ts` modules with an `evm (...) => {}` syntax extension, transpiled (like `.tsx`) into TS library calls (`inline()`, `set()`, `staticFor()`); "typed stack algebra": `Fragment`s carry typed stack signatures so "composition fails early"; `static for` compile-time unrolling; A* "solver-guided assembly" searches minimum-cost DUP/SWAP choreography; outputs `Uint8Array` for viem/ethers/wagmi | MIT, active but tiny (6 stars); aimed at deployed gas-critical hot paths (verifiers, payout programs), **not** read scripts; no ABI generation; requires custom transpile step |
| `huffc` (TS) (https://github.com/huff-language/huffc, npm `huffc` 0.0.25) | TS, Huff lang | original Huff compiler in TypeScript | **deprecated 2022-07-04** in favor of Rust `huff-rs` (https://github.com/huff-language/huff-rs, https://huff.sh) — note: even an EVM-DSL team abandoned TS for the compiler core; evs stays TS deliberately (small programs, type-system integration is the product) |
| `etk` / EVM Toolkit (https://github.com/quilt/etk, book: https://quilt.github.io/etk) | Rust, text | `eas` assembler + `disease` disassembler; labels, macros, expressions | last release v0.2.1 (2022-05); low activity |
| `geas` "Good Ethereum Assembler" (https://github.com/fjl/geas) | Go, text | macro assembler, all EVM instructions, includes a disassembler; "intended to be a direct representation of EVM bytecode"; used to write the Pectra system contracts (EIP-2935/7002/7251 predeploys) (https://www.blog.blockscout.com/verifying-ethereum-predeploy-contracts/) | actively used by Ethereum core devs |
| SpecOps (https://github.com/solidifylabs/specops, https://pkg.go.dev/github.com/solidifylabs/specops) | Go, embedded DSL | Go-embedded bytecode DSL with execution + a **terminal debugger** (`RunTerminalDebugger`, programmatic `Step()`/`FastForward()`) | niche, maintained |

### Execution/analysis libraries (complements, not competitors)

- `@ethereumjs/evm` **v10.1.2** (https://www.npmjs.com/package/@ethereumjs/evm, MPL-2.0, Node ≥20, ESM+CJS): full EVM interpreter in TypeScript, actively maintained. No assembler — execution only. **Use it in evs unit tests** to run compiled bytecode in-process (fast feedback) before anvil integration tests.
- `sevm` (https://www.npmjs.com/package/sevm): TS symbolic EVM decompiler/disassembler, embeddable; useful dev-dependency for snapshot-testing evs codegen output.
- `acuarica/evm`, `MrLuit/evm`: bytecode decompilers/parsers (TS).

### Multicall builders (the incumbent solution for "batch reads")

- Multicall3 (canonical deployed aggregator) + `ethcall` (https://github.com/Destiner/ethcall) + viem's built-in `multicall` action.
- Deployless variants: Destiner/deployless-multicall (https://github.com/Destiner/deployless-multicall, write-up: https://destiner.io/blog/post/deployless-multicall/) — put the multicall logic in **initcode**; `eth_call` with `to: null` executes the constructor, which performs the calls and RETURNs the ABI-encoded results as the "deployed code". indexed-finance/multicall (https://github.com/indexed-finance/multicall) is the same trick with a TS wrapper.
- Vectorized/multicaller (Solady-adjacent, https://github.com/Vectorized/multicaller, npm `multicaller`): gas-optimized aggregator; supports deployless reads ("when the initialization code is sent to the 0 address as an eth_call operation, the code is not deployed and returns the data").
- Hard limitation of ALL multicall designs: calls are independently pre-encoded — **no data flow between calls** (you cannot feed `pool.token0()`'s result into `token0.symbol()` in one round trip) and no computation. This is exactly the gap evs fills with one round trip and full typing.
- HyVM (https://github.com/oguimbal/HyVM): an EVM interpreter written in Huff, deployed on-chain; you `delegatecall` it with arbitrary bytecode as calldata. Proves the "ship bytecode per request" execution model at the opposite (deployed-interpreter) end; no compiler/typing story.
- "deless": no such npm package found; searches resolve to the "deployless" multicall family above.

### viem's execution surface that evs targets

From https://viem.sh/docs/actions/public/call — viem `call` supports **deployless calls** two ways, also available through `readContract` and contract instances:

```ts
// 1. bytecode method
await publicClient.call({ code: '0x…runtimeOrWrapped…', data: encodeFunctionData({...}) })
// 2. factory method (ERC-4337 style counterfactual deploy)
await publicClient.call({ factory, factoryData, to, data })
```

plus `stateOverride` on `call`/`readContract` (per-address `{ code, balance, nonce, state, stateDiff }`, the geth `eth_call` third parameter). And from https://viem.sh/docs/typescript: viem requires **TypeScript ≥ 5.0.4 with `strict` mode**, uses **ABIType** for inference, and ABIs must be **inlined or `as const`-asserted** ("Unfortunately TypeScript doesn't support importing JSON as const" — hence `@wagmi/cli`-style generated `.ts` ABI files). evs's generated ABI artifact must therefore be an emitted `.ts` file containing a literal array `as const`, never JSON.

### Differentiation statement

evs is, as far as this survey found, the **only** project combining: (1) a plain-TS staged builder (no transpiler, no custom syntax) with (2) end-to-end abitype inference on call arguments *and* cross-call data flow, (3) compilation to a self-contained EVM runtime-bytecode artifact executed read-only via `eth_call` state-override/deployless, and (4) a generated literal ABI making the script itself a first-class viem contract. Nearest neighbors each miss ≥2 axes: weiroll (deployed interpreter, untyped, transaction-oriented), multicalls (no inter-call data flow), EvmScript (custom transpiled syntax, deploy-oriented, no ABI/read story), text assemblers (untyped, low-level), AssemblyScript (different VM, whole-language cost).

---

## 6. Distilled design lessons for evs (concrete, actionable)

1. **Recording is the only sequencing primitive — say so and enforce it.** Weiroll's top documented footgun is forgetting `planner.add`. In evs, `s.call(...)` both records and returns the handle (better than weiroll's two-step `contract.fn()` + `add`). Enforce: handles must carry a reference to their owning script instance; using a handle from another `evscript` (or after `s.return`) must throw at build time with both script names in the message (weiroll's planner does an equivalent "visibility" check during `plan()`).

2. **Brand expression handles and make host-language misuse explode immediately.** PyTeal died on "errors ... go unnoticed until the point of TEAL generation, or worse go completely unnoticed" (Puya principles). Implement `valueOf`, `Symbol.toPrimitive`, and `toString` on handle objects to `throw new EvsStagingError(...)` so `if (x)`, `x + 1`, `` `${x}` `` and `x == y` fail loudly at the exact wrong line, and type handles as branded objects (`{ readonly __evs: unique symbol }`) so TS rejects them in host positions too.

3. **Type expressions with abitype string literals, mirroring viem's vocabulary exactly.** `s.call({address, abi, functionName, args})` should have the same generic signature shape as viem `readContract` (abitype `ExtractAbiFunction`, etc.) so knowledge transfers; expression handles should be `Expr<'uint256'>` / `Expr<'address'>` style string-literal generics (shader-ast's `Term<"float">` pattern is the proof this scales). Require user ABIs `as const`; document viem's floor: TS ≥ 5.0.4, strict mode.

4. **Statements vs expressions: keep them syntactically distinct.** shader-ast bodies are arrays of statement nodes with explicit `ret(...)`; PyTeal's `Seq` demands `TealType.none` intermediates (with `Pop()` as the escape). evs: `s.call`/`s.return` are statements (recorded), everything composing values (`x.field('token0')`, arithmetic helpers) is a pure expression building IR without recording. Never let an expression have a side effect on ordering.

5. **Control flow: expression-form first, loops last (or never in v1).** PyTeal: `If(test).Then(a).Else(b)` with the type rule "both branches must return the same type"; shader-ast: statement `ifThen(test, truthy, falsy)` vs expression `ternary`. For a read DSL, `s.if(cond).then(e1).else(e2)` (typed, both-branch-equal) plus build-time-unrolled iteration over **host** arrays covers nearly everything. If you add static repetition, name it so staging is visible (EvmScript uses literally `static for`); weiroll shipped no branching at all and still found product-market fit for linear call DAGs.

6. **Capture source locations at every builder call; emit a PC→callsite map.** PyTeal only got `with_sourcemap=True` / `annotate_teal=True` / `pcs_in_sourcemap=True` in v0.24.0 after years of requests (issue #116), and it transformed debugging ("assert failed pc=70" → exact source line). evs: capture `new Error().stack` (cheap at script-build scale) into each IR node's `info`, thread it through codegen, and decorate execution failures: "STATICCALL to 0x88e6…5640 `token0()` reverted — recorded at pools.ts:12:19". Also use it for build-time diagnostics.

7. **Ship a disassembler and an annotated dump from day one.** Every healthy low-level toolchain pairs assembler+disassembler (geas, etk's `eas`/`disease`, ethers-asm, SpecOps' debugger). evs should expose `compile(...).disassemble()` returning mnemonics annotated with the originating IR node/source line, and consider `sevm` as a dev-dependency for independent cross-checks in snapshot tests.

8. **Test execution in-process before anvil.** Two proven routes: run compiled bytecode on `@ethereumjs/evm` v10 (TS, maintained) with stubbed STATICCALL targets for fast unit tests; and/or follow `@thi.ng/shader-ast-js` — a second codegen target that *interprets the IR in JS* against a mock chain, giving printf-style debugging without any EVM at all. The IR-interpreter also doubles as a differential-testing oracle against the bytecode backend.

9. **Keep the IR serializable, versioned, plain data.** shader-ast is "an embedded DSL **and IR format**"; weiroll's `{commands, state}` is similarly inspectable. A JSON-stable IR (`{tag, type, info, children}`-shaped) enables snapshot tests of compilation, caching, alternate backends, and printing the plan in error messages.

10. **Make EVM hardfork targeting an explicit compile option.** PyTeal gates features by AVM "program version" (loops/subroutines v4+). The EVM equivalent bites immediately: `PUSH0` (Shanghai), `MCOPY`/`TLOAD`/`TSTORE` (Cancun) are not available on all chains/historic blocks. Expose `compile({ evmVersion: 'paris' | 'shanghai' | 'cancun' })`, default to the most compatible (`paris`, no PUSH0), and document gas deltas. (geas and solc both expose this knob; predeploy authors hit it constantly.)

11. **Enforce resource limits with actionable build-time errors.** Weiroll documents hard limits (6 input slots/command, ≤127 state entries) and validates argument counts/types eagerly via ethers `ParamType`. evs analogs: max return-tuple size, memory budget, call-count sanity, calldata size for the deployless path — check at `compile()` and report with the source location from lesson 6, never as an opaque on-chain revert.

12. **Provide a typed escape hatch, not a free-form one.** Precedents: weiroll `.rawValue()` (bytes-out), ethers-asm `{{! js }}` blocks, geas/etk macros, EvmScript `inline()` with `Fragment`s that "carry typed stack signatures, so composition fails early". evs: `s.rawCall({to, data}) → Expr<'bytes'>` first; if inline asm is ever added, require declared input/output types so the boundary stays typed.

13. **Keep the on-chain artifact dumb; put all cleverness in the compiler.** Weiroll's generic interpreter forced audits and made Enso disable DELEGATECALL in production; evs's per-script linear `STATICCALL`-then-`RETURN` bytecode is its security story — uniform codegen patterns, no jumps unless branching is used, easily eyeballed via the disassembler. Resist features that make output bytecode shape unpredictable.

14. **Don't fork the language or toolchain.** AssemblyScript shows the cost of real-TS-syntax compilation (no closures/unions/`any`/exceptions, parallel stdlib, parallel ecosystem); EvmScript's `.evm.ts` transpiler shows the cost at small scale (custom build step, editor friction, 6 stars). evs's plain-callback builder keeps bun, oxlint/oxfmt, tsc, and editors untouched — this is a feature to advertise, with a doc page explicitly mapping "runs at build time (TS)" vs "runs on-chain (compiled)".

15. **Emit the ABI as a generated `as const` TypeScript artifact, and steal codegen niceties.** viem: ABIs must be inline or `as const`; JSON cannot be const-imported, so emit `.ts` (the `@wagmi/cli` precedent). Also steal: weiroll's literal deduplication + slot (for evs: memory/constant-pool) reuse via last-use liveness; shader-ast's call-graph topological ordering + dead-code elimination and `shader-ast-optimize`-style constant folding; EvmScript's observation that stack scheduling is a search problem (evs's linear memory model can skip this — a deliberate simplification worth documenting).

---

## Source index

- weiroll: https://github.com/weiroll/weiroll · https://github.com/weiroll/weiroll.js · https://github.com/weiroll/weiroll.js/blob/main/src/planner.ts · https://registry.npmjs.org/@weiroll/weiroll.js/latest · https://github.com/EnsoBuild/enso-weiroll · https://www.chainsecurity.com/security-audit/enso-weiroll-smart-contracts · https://blog.biconomy.io/from-scripts-to-programs-how-smart-batching-evolves-on-chain-execution/
- PyTeal/Puya: https://pyteal.readthedocs.io/en/stable/control_structures.html · https://pyteal.readthedocs.io/en/stable/sourcemap.html · https://developer.algorand.org/articles/pyteal-sourcemapping/ · https://github.com/algorand/pyteal/issues/71 · https://github.com/algorand/pyteal/issues/116 · https://github.com/algorand/pyteal/issues/232 · https://algorandfoundation.github.io/puya/principles.html
- shader-ast: https://github.com/thi-ng/umbrella/blob/develop/packages/shader-ast/README.md · https://docs.thi.ng/umbrella/shader-ast/ · https://www.npmjs.com/package/@thi.ng/shader-ast-glsl · https://docs.thi.ng/umbrella/shader-ast-js/
- AssemblyScript: https://www.assemblyscript.org/concepts.html · https://www.assemblyscript.org/status.html · https://blog.suborbital.dev/assemblyscript-vs-typescript
- Assemblers/DSLs: https://docs.ethers.org/v5/cli/asm/ · https://github.com/ajlopez/evmasm · https://www.npmjs.com/package/emasm · https://docs.evmscript.org/ · https://github.com/KimlikDAO/EvmScript · https://github.com/huff-language/huffc · https://github.com/huff-language/huff-rs · https://github.com/quilt/etk · https://github.com/fjl/geas · https://github.com/solidifylabs/specops · https://www.blog.blockscout.com/verifying-ethereum-predeploy-contracts/
- Execution/analysis: https://www.npmjs.com/package/@ethereumjs/evm · https://www.npmjs.com/package/sevm · https://github.com/oguimbal/HyVM
- Multicall/deployless: https://github.com/Destiner/ethcall · https://github.com/Destiner/deployless-multicall · https://destiner.io/blog/post/deployless-multicall/ · https://github.com/Vectorized/multicaller · https://github.com/indexed-finance/multicall
- viem: https://viem.sh/docs/actions/public/call · https://viem.sh/docs/typescript
