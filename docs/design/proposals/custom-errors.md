# Custom Errors — Design Proposal / Implementation Contract (issue #15)

> Status: **ACCEPTED + IMPLEMENTED** (2026-07-24) — the binding contract for the change;
> amendments.md §24 records the law deltas. Implementation deviations from the text below
> (all recorded in §24): `EvsErrorType` carries no `selector` field (M1 core may not import
> viem — selectors are computed in M3 and recorded on the IR `PlainAbiError`);
> `matchScriptError` infers the whole handlers object rather than a single shared `r` return
> type; `_` joins the reserved error names (it is the match default-arm key).

## 0. Decision summary (locked in discussion)

1. **Declare-first, not inferred.** Errors are module-level values created with `t.error(...)`
   and **declared on the script def** (`errors: [...]`). `s.throw` is type-restricted to the
   declared set, so throwing an undeclared error is an **editor/type error at the throw
   site**, backed by a record-time runtime check. This deliberately replaces the
   generator/`yield` rework considered in the discussion: evs bodies are staged (the callback
   runs once at record time), so a `yield` would carry no runtime meaning — declaration in
   the def gives the same end-to-end typing with zero churn to the existing callback surface.
2. **Errors ride in the script ABI.** Declared errors append to `ScriptAbi` as literal-typed
   `{ type: 'error', name, inputs }` entries. Since `toViem()` already hands the full ABI to
   viem, `readContract` decodes script reverts into `ContractFunctionRevertedError`
   (`errorName`/`args`) **natively — no call-site changes, no wrapper**.
3. **No `readScriptSafe` / call wrappers.** Users keep calling viem directly. The library
   ships only client-side **decode utilities**: `decodeScriptError` (caught error or raw
   revert bytes → typed discriminated union) and `matchScriptError` (exhaustive switch over
   the declared set with a mandatory default arm for unknown errors).
4. **One error namespace per script.** `s.fn` bodies close over the same `s`, so their throws
   are checked against the same declared set — internal-function error propagation is
   automatic, with no per-fn declarations and no `yield*`-style plumbing at call sites.
5. **Non-breaking.** Every touched public type gains a trailing type parameter with a wide
   default; scripts without `errors` compile byte-identically.

## 1. Type API — `t.error` (M1 `core/types.ts`)

```ts
// params take the SAME ArgsInput shorthand as `s.fn` params / `evscript` args (issue #9/#25):
// a bare t.* type, a single namedArg(...), or a readonly list mixing named and bare.
const NoBalance = t.error('NoBalance', [namedArg('balance', t.uint256)]);
const NotOwner = t.error('NotOwner'); // zero-param
const BadPair = t.error('BadPair', [t.address, t.address]); // bare → arg0/arg1 fallback names
```

- Signature:

  ```ts
  t.error<const name extends string, const params extends ArgsInput = readonly []>(
    name: name,
    params?: params,
  ): EvsErrorType<name, NormalizeArgs<params>>;

  interface EvsErrorType<
    name extends string = string,
    params extends readonly ArgSpec[] = readonly ArgSpec[],
  > {
    readonly kind: 'error';                 // runtime discriminant (vs EvsType / ArgSpec)
    readonly name: name;
    readonly params: params;                // normalized ArgSpecs (namedArg names or '' sentinels)
    readonly abi: ErrorAbiEntry<name, params>; // the literal { type:'error', name, inputs } entry
    readonly selector: Hex;                 // 4-byte, keccak of the canonical signature
  }
  ```

- The selector derives from the canonical Solidity signature (`NoBalance(uint256)`), computed
  via the existing M3 `selectorOf`/`canonicalTypeSignature` machinery — struct params flatten
  to their canonical tuple signature exactly like function selectors.
- `inputs` reuse the M3 `ArgsToInputs` mapping (resolved names: `namedArg` name or the
  positional `arg{i}` fallback), so a `t.struct` param becomes a named `tuple` component.
  Since issue #25 `namedArg` accepts every `EvsType`, struct/array error params come free.
- Record-time validation: `name` must match `IDENT_RE`; params must be v0-representable
  (same `assertV0Type` path as args). The value is frozen.

## 2. Builder surface (M5 `builder/script.ts`)

### 2.1 Declaration on the def

```ts
const script = evscript(
  { name: 'check', args: t.address, errors: [NoBalance, NotOwner] },
  (s, who) => { ... },
);
```

- `evscript<name, args, ret, errs>` — `def` gains `errors?: errs` where
  `errs extends readonly EvsErrorType[] = readonly []`. A lone `EvsErrorType` normalizes to a
  one-element list (same sugar as `args`).
- `EvsScript`, `ScriptAbi`, `CompiledEvsScript` each gain a TRAILING
  `errs extends readonly EvsErrorType[] = readonly EvsErrorType[]` parameter (wide default —
  preserves the default-instantiation-is-a-supertype property pinned by compile.test-d, and
  keeps existing explicit `EvsScript<n, a, r>` instantiations compiling).
- Record-time checks on the declared list: duplicate names rejected; a declared selector
  colliding with the built-ins (`Panic(uint256)`, `Error(string)`, `EvsDecodeError(uint256)`,
  `EvsInvalidCalldata()`) rejected (`EvsTypeError`, code `ERROR_DECL`). A declared-but-never-
  thrown error is **allowed** (Solidity parity; declaring shared errors is not a defect).

### 2.2 `s.throw`

```ts
s.if(bal.lt(min), () => {
  s.throw(NoBalance, { balance: bal }); // all-named params → required name-keyed record
});
s.throw(BadPair, [tokenA, tokenB]); // any bare param → required positional tuple
s.throw(NotOwner); // zero-param → args omitted
```

- `ScriptBuilder<errs extends readonly EvsErrorType[] = readonly EvsErrorType[]>` gains:

  ```ts
  throw<const e extends errs[number]>(error: e, ...args: ThrowArgs<e>): void;
  ```

  `ThrowArgs` mirrors the `TupleInit` named/positional split but with **required** members
  (Solidity parity — no zero-defaulting): all params named → one name-keyed record argument;
  otherwise a positional readonly tuple; zero params → no argument. Each member accepts the
  param type's `IntoMember` (literal, `Expr`, `Tuple`/`MutArray` handle — same coercions as
  call args).

- **Undeclared throw**: a type error at the site (the `errs[number]` bound), AND a record-time
  `EvsTypeError` (`ERROR_UNDECLARED`, message names the error and says to add it to
  `errors: [...]`) for untyped callers — this is the "compilation must refuse an unsurfaced
  throw" requirement from the discussion, enforced statically instead of via `yield`.
- Return type is `void`, not `never`: the callback keeps executing at record time, and TS's
  never-call CFA would mark legitimate sibling recording unreachable. Statements recorded
  after an unconditional `throw` in the same scope are dead in the emitted program; the
  recorder MAY warn (non-blocking) — same policy as other dead-code shapes.
- `s.fn` bodies: nothing new — they record through the same `Recorder`, so a throw inside a
  fn is checked against the same declared set (decision #4).

## 3. IR (M2 `ir/nodes.ts`)

```ts
export interface PlainAbiError {
  readonly name: string;
  readonly inputs: readonly PlainAbiParam[];
}
// ScriptIr gains (OPTIONAL, defaulting to [] — v1 serialized IR deserializes unchanged,
// mirroring the call-stmt `kind?` precedent):
readonly errors?: readonly PlainAbiError[];

// new Stmt arm:
| { k: 'throw'; error: number /* index into ir.errors */; args: readonly ValueId[] }
```

- `validateIr`: `error` index in range; `args` arity/types match the error's inputs.
- The interpreter (M6) models `throw` as: standard-abi-encode the args (existing `encode`
  semantics), prefix the selector, terminate with a revert carrying those bytes — so the
  differential suite compares revert payloads byte-exactly against the EVM.

## 4. Codegen (M7/M8)

Lowered **inline at the throw site** (payloads are value-dependent; the shared-tail pattern
only fits fixed payloads):

- **Zero-param error**: exactly the `EvsInvalidCalldata` tail shape — store the selector word,
  `REVERT(offset, 4)`.
- **With params**: reuse the existing standard-encode emitter (the `encode` stmt, mode
  `'abi'`) to materialize `abi.encode(args)` as a fresh bytes memref `[len | payload…]` at
  `ptr`. Then `MSTORE(ptr, selector)` — the selector lands in bytes `[ptr+28, ptr+32)`,
  clobbering the low bytes of the length word, which is dead at this point — and
  `REVERT(ptr + 28, 4 + len)`. No new encoding machinery; byte-exact
  `selector ‖ abi.encode(params)`, identical to solc's custom-error revert data.

## 5. ABI artifact (M3 `abi/artifact.ts`) + compile (M9)

- `buildScriptAbi` appends the declared error entries AFTER the existing built-ins, keeping
  the current prefix stable for existing assertions:

  ```
  [ function, EvsInvalidCalldata, EvsDecodeError, ...declaredErrors ]
  ```

- `ScriptAbi<name, args, ret, errs>` types the appended entries literally (name + `inputs`
  via the same `ArgsToInputs` used for script inputs), so abitype/viem see the exact error
  shapes. `Panic(uint256)`/`Error(string)` are NOT added — viem decodes those natively.
- `explainRevert` (M9): after the built-in selector arms and before the generic `custom`
  fallback, match the declared selectors from `ir.errors` and return a new
  `RevertExplanation` arm — `kind: 'script-error'` with `{ name, args }` (runtime-decoded via
  viem `decodeAbiParameters`, name-keyed by the resolved input names) plus the usual
  formatted `message`. The `RevertExplanation['kind']` union widens by one member
  (amendment).

## 6. Client-side decode utilities (M9 `viem.ts`) — NO wrappers

The read path is unchanged and wrapper-free: users spread `script.toViem()` into
`readContract`/`simulateContract` as today; because the errors are in the ABI, viem already
throws a decoded `ContractFunctionRevertedError`. The library adds two pure utilities for
the catch side:

### 6.1 `decodeScriptError`

```ts
function decodeScriptError<const abi extends Abi>(
  script: { abi: abi }, // EvsScript or CompiledEvsScript (or anything ABI-bearing)
  input: unknown, // the CAUGHT error (viem error tree) — or raw revert bytes (Hex)
): DecodedScriptError<abi> | undefined;
```

- `input` handling: a `Hex` string is treated as raw revert data; anything else is walked
  with viem's `BaseError.walk` for a `ContractFunctionRevertedError` and its `raw` bytes
  (per the discussion: "pass this viem error data — whatever gives us the returned bytes").
  **Returns `undefined` when no revert data is found** (network error, timeout, non-viem
  throw): absence of revert data means "not a script error", and the caller — or
  `matchScriptError`, §6.2 — rethrows rather than funneling transport failures into the
  default arm.
- Result: a discriminated union on `name`:
  - one arm per declared error, `{ name: 'NoBalance', args: { balance: bigint } }` — args as
    a name-keyed record (resolved names, `arg{i}` fallback), types via abitype over the
    literal `inputs`;
  - built-in arms for `Panic` (code + meaning), `Error` (reason string), `EvsDecodeError`,
    `EvsInvalidCalldata`, `{ name: 'unknown', selector, data }` (unrecognized selector —
    e.g. a callee error bubbled verbatim), and `{ name: 'empty' }`. These are exactly the
    `explainRevert` classifications, surfaced as a typed union.

### 6.2 `matchScriptError`

```ts
const msg = matchScriptError(script, err, {
  NoBalance: ({ balance }) => `short by ${balance}`,
  NotOwner: () => 'not the owner',
  _: (other) => `unexpected: ${other.name}`, // Panic | Error | Evs* | unknown | empty
});
```

- Handlers for **every declared error are required** (adding an error to the script without
  updating the switch is a type error — the exhaustiveness the issue asks for), and `_` is
  **always required** (an unknown revert is always possible: panics, bubbled callee errors,
  future script versions). Return type is the union of the handler returns.
- If `decodeScriptError` yields `undefined` (no revert data in `err`), the original error is
  **rethrown** — transport failures never masquerade as script errors.
- Pure sugar over `decodeScriptError`; users preferring a raw `switch (decoded.name)` use the
  primitive directly.

## 7. Out of scope / follow-ups

- **`s.throw('reason')` `Error(string)` sugar** — deferred. Declare-first covers the need,
  and viem decodes `Error(string)` without ABI help; revisit on demand.
- **Collecting CALLEE ABIs' error entries** into the artifact ABI (deduped by selector), so
  bubbled sub-call reverts decode too — runtime-ABI-only (invisible to the type level in any
  design). Worth its own issue; the `unknown` arm covers it until then.
- Cross-script/standalone fns with their own error sets (callee-set ⊆ script-set checking) —
  only if fns ever become shareable across scripts.

## 8. Test & docs obligations (testing.md tiers)

- **Unit**: `t.error` validation (names, v0 params, selector goldens vs viem
  `toFunctionSelector`); record-time `ERROR_UNDECLARED`/`ERROR_DECL` rejections; IR shape +
  serialize/deserialize round-trip (including v1-IR-without-`errors` compat); bytecode
  goldens for zero-param and multi-param throws; `explainRevert` `script-error` arm;
  `decodeScriptError`/`matchScriptError` over synthetic revert bytes and synthetic viem
  error trees (rethrow path included).
- **Type tests**: undeclared `s.throw` rejected; `ThrowArgs` record/positional/zero shapes;
  `ScriptAbi` literal includes the error entries; declared-arm exhaustiveness + required `_`
  in `matchScriptError`; default-instantiation supertype property still holds with the new
  `errs` params.
- **Integration (anvil)**: throw → assert raw revert data is byte-exact
  `selector ‖ abi.encode(args)`; viem `readContract` with the artifact ABI decodes
  `errorName`/`args`; caught error → `matchScriptError` round-trip; differential suite covers
  `throw` (interp vs EVM revert payloads).
- **Docs**: `guides/errors-and-debugging.mdx` — declaring, throwing, catching with plain viem
  - `matchScriptError` (every fence typechecks); playground premade with a throwing script.
