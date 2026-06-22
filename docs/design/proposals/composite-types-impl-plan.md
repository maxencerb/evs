# Composite Types — Implementation Plan / Contract (issue #2)

> This is the BINDING implementation contract for the composite-types change (GitHub issue #2).
> It is the single source of truth that every implementing agent works against. The frozen
> design docs (`module-interfaces.md`, `api.md`, `architecture.md`) are amended by this change;
> an `amendments.md` entry (section 16) is required. Do NOT re-derive decisions — they are locked
> here.

## 0. Scope of this PR

**Delivered (must be green + tested):**

1. **Type API** — `t.struct({...})`, `t.tuple(a, b, …)`, extended `t.array(...)`; a raw
   `readonly AbiParameter[]` is accepted wherever a tuple type is expected.
2. **Args rewrite (breaking)** — `args` is a single `t.*` type or a `readonly` array of them
   (`args: t.uint256` ≡ `args: [t.uint256]`). Args arrive as **positional callback params after
   `s`**: `(s, token, amount) => {…}`. `arg()`/`s.args`/`ArgSpec`-as-script-args are gone for the
   script-args surface (`arg()`/`ArgSpec` are RETAINED for `s.fn` param declarations — see §4).
3. **Tuple/struct decode** — a `'tuple'` ABI output of `s.call`/`s.tryCall` → a `Tuple<C>` memref
   handle with named/positional Cell-like field handles (`.field.get()`, `.at(i).get()`).
4. **Tuple construction + mutation** — `s.tuple(type, init?)` allocator; field `.set(v)`; the
   SAME handle type as a decoded tuple (one unified tuple type).
5. **Composite call args (encode)** — `s.call({…, args: [structHandleOrLiteral]})` for
   struct-taking view functions; `SubcallInputs` accepts a tuple handle OR a literal struct.
6. **Tuples flow out** — `s.return({ x: tupleHandle.expr() })` returns a tuple, abitype-typed.

**Deferred to a follow-up (represented in the type vocabulary, but builder/codegen restricted —
emit a clear `UNSUPPORTED_V0` if reached, and note in the amendment):**

- Arrays of tuples (`tuple[]`) and nested string arrays (`uint256[][]`, `string[]`). `s.newArray`
  stays word-element-only; `at()` on a tuple-element array is the follow-up. The `TupleType`
  vocabulary already represents `tuple[]`/`tuple[][]` and `ArrayType` represents nested string
  arrays, so the follow-up is additive (codegen `case` + builder wiring), not a rewrite.

If a deferred shape is reached at runtime, throw `EvsTypeError('UNSUPPORTED_V0', …)` naming it.

## 1. Type model (IMPLEMENTED in `core/types.ts` — do not change, only consume)

- `EvsType = WordType | DynType | ArrayType | TupleType`.
  - `WordType`, `DynType` — unchanged strings.
  - `ScalarType = WordType | DynType`; `ArrayType = `${ScalarType}[]`|`…[][]`|`…[][][]``(string-encoded nested arrays).`StringType = ScalarType | ArrayType`.
  - `TupleType = { readonly type: 'tuple'|'tuple[]'|'tuple[][]'; readonly components: readonly
NamedType[] }` — an abitype-`AbiParameter`-shaped object (so abitype infers it directly).
  - `NamedType = { readonly name: string; readonly type: string; readonly components?: readonly
NamedType[] }` — structurally identical to the IR `PlainAbiParam`. A struct member has a
    non-empty `name`; a positional `t.tuple` member has `name: ''`.
- **Runtime helpers** (all exported, already implemented):
  - `isWordType(s: string | TupleType): s is WordType` — typeof-guarded; `false` for tuples.
  - `isNumeric`, `isSigned` — typeof-guarded.
  - `isDynamicType(s): boolean` — memref-valued (string|bytes|`T[]`|**tuple → true**).
  - `isArrayValueType(s): s is ArrayType | TupleType` — a `T[]` (string array or tuple array).
  - `isTupleType(v): v is TupleType`; `isEvsValueType(v): v is EvsType` (string or tuple, recursive
    validation); `isEvsType(s: string): s is StringType` (string-only validity); `isStringType`.
  - `elemTypeOf(s: ArrayType | TupleType): EvsType` — one `[]` peeled (string arrays) or the
    element tuple (`tuple[]` → `tuple`).
  - `typesEqual(a, b): boolean` — STRUCTURAL equality. **Every `a.type === b.type` / `!==`
    comparison on value types MUST use `typesEqual` (tuple descriptors are fresh objects, never
    `===`).** This is load-bearing in the recorder and validator.
  - `abiParamToType(p: {type; components?}): EvsType` — PlainAbiParam/NamedType → EvsType.
  - `typeToAbiParam(name, ty): NamedType` — EvsType → named abitype component (inverse).
- **`t` namespace** (implemented): `t.struct(record)` (named comps; runtime order =
  `Object.keys` insertion order — the only encode-order source of truth), `t.tuple(...types)`
  (positional, `name: ''`), `t.array(elem)` (string → `${elem}[]`; tuple → `tuple[]`; raw
  `AbiParameter[]` → `tuple[]`). All validate + freeze.
- **Type-level**: `LitOf<TupleType>` delegates to abitype `AbiParameterToPrimitiveType` (object
  when all members named, positional tuple otherwise). `Expr.at<elem extends StringType>` broadened
  for nested string arrays. `StructTypeOf`/`TupleTypeOf`/`TupleArrayOf`/`TypeToComponent` exported
  for the namespace overloads.

## 2. IR (IMPLEMENTED in `ir/nodes.ts` + `ir/validate.ts`)

New `Stmt` variants (decode + validate done):

- `{ k: 'tuplenew'; inits: readonly { index: number; value: ValueId }[]; out: ValueId }` — the
  out value's `values[out].type` is the `TupleType` (carries components). Allocates a tuple block,
  zero-fills, MSTOREs each provided member.
- `{ k: 'field'; tuple: ValueId; index: number; out: ValueId }` — member read; out type =
  `abiParamToType(components[index])`.
- `{ k: 'tupleset'; tuple: ValueId; index: number; value: ValueId }` — member write.
- `arrnew.elem` widened to `EvsType` (validate still restricts to word — composite arrays deferred).

`ValueInfo.type`/`args`/`returns`/fn types are now `EvsType` (string OR tuple object); serialize
handles objects; `asEvsType` (deserialize) reconstructs tuple descriptors. `checkAbiParams`
recurses through tuple components. `validate.ts` uses `typesEqual` for all type comparisons.

## 3. Memory layout decision — FLAT-POINTER tuples (architecture.md §5)

A tuple is a **memref to a packed `[w0][w1]…[w_{n-1}]` block of `n` words** (`n` = component
count, NO length prefix; `n = components.length`). Each `wᵢ` is:

- a **canonical word** if member `i` is static (word type), or
- a **memref pointer** if member `i` is dynamic/composite (string/bytes/array/tuple) — the field
  slot holds the pointer to that member's memref.

Operations:

- `field i` read = `MLOAD(tuplePtr + 32*i)` → the canonical word or the pointer.
- `field i` write = `MSTORE(tuplePtr + 32*i, v)`.
- `s.tuple(type, init)` = bump-alloc `32*n` bytes, **zero-fill** the whole block (via the
  `CALLDATACOPY(dst, CALLDATASIZE, size)` past-end idiom — memory above the free ptr is NOT zero,
  architecture §5), then MSTORE each provided member. (Skip-zero-write optimization is deferred;
  zero-fill-then-write is correct and simple. A literal-`0`/omitted member needs no MSTORE since
  the block is already zeroed.)
- Reference semantics: a tuple handle is the pointer; passing it copies the pointer, so a later
  `.field.set()` is visible through every alias (document in api.md §5).

**Decoding a call's tuple output into flat-pointer layout** (codegen `call.ts` + interp): the ABI
returndata tuple is head/tail; convert to a freshly-allocated flat block: for each component, if
static → copy the head word into `wᵢ`; if dynamic → decode it into a memref (aliasing the snapshot,
as today for arrays/strings) and store its pointer into `wᵢ`. So a decoded tuple is a NEW flat
block whose dynamic members point into the returndata snapshot.

**Encoding a tuple arg/return (flat-pointer → ABI head/tail)**: standard head/tail over components:
static members inline in the head; dynamic members get a head offset + a tail (recursively encode
the member's memref — an array/string memref is `[len][payload]`; a nested tuple memref is itself a
flat block re-encoded head/tail). Reuse the EXACT machinery in `codegen/abi.ts emitReturnEncode`
(the two-pass encoder) and the dynamic-tail emission; keep the running cursor in scratch (`0x00`)
so every `emitMemCopy` happens at stack height exactly `[dst, src, len]` (the pre-cancun `@memcpy`
ABI contract). A tuple is ABI-DYNAMIC iff any component is dynamic; ABI-STATIC (all-word) tuples
inline `n` head words.

## 4. Args rewrite (`builder/script.ts`, `abi/artifact.ts`, `builder/expr.ts`)

### evscript signature (new)

```ts
export function evscript<
  const name extends string,
  const args extends ArgsInput,
  ret extends Record<string, Expr>,
>(
  def: { name: name; args?: args },
  body: (s: ScriptBuilder, ...args: ArgHandles<NormalizeArgs<args>>) => ScriptReturn<ret>,
  opts?: { locations?: boolean },
): EvsScript<name, NormalizeArgs<args>, ret>;
```

- `ArgsInput = EvsType | readonly EvsType[]` (a lone type or a list). `NormalizeArgs<a> =
a extends readonly EvsType[] ? a : readonly [a]` (lone → one-element tuple). `args` is OPTIONAL
  (a zero-arg script omits it).
- `ArgHandles<types extends readonly EvsType[]> = { readonly [i in keyof types]: ArgHandle<types[i]> }`
  — homomorphic mapped tuple (preserves order/labels; NO `UnionToTuple` — order is structural).
  `ArgHandle<t> = t extends TupleType ? Tuple<t> : Expr<t>` (a struct/tuple arg → a `Tuple` handle;
  a scalar → an `Expr`).
- `ScriptBuilder` loses its `args` type param and its `s.args` member. It is now non-generic.
- **ABI inputs**: each normalized arg `i` → `{ name: 'arg{i}', type }` (auto-named; names are just
  labels — viem infers `args` positionally regardless). Tuple args → `{ name, type:'tuple',
components }`. `ScriptAbi<name, args extends readonly EvsType[], ret>` is reparameterized from
  `args extends readonly ArgSpec[]` to `args extends readonly EvsType[]`; `inputs` maps
  `typeToAbiParam('arg{i}', args[i])`-shaped entries. The labeled-positional-tuple CI type test
  must still pass (`ReadContractParameters<abi,name>['args']`).
- `arg()`/`ArgSpec` are RETAINED in `core/types.ts` for `s.fn` param declarations only (still
  exported; `s.fn(name, [arg('x', t.uint256)], (x) => …)` keeps working — do NOT break it). The
  args-as-record `s.args` getter is removed from `ScriptBuilder`/`Recorder`.

### Recorder (`builder/expr.ts`)

- Constructor still receives `args: readonly { name; type: EvsType }[]`. It already builds an arg
  Expr per arg. Replace `argRecord()` with `argHandles(): readonly (Expr|Tuple)[]` — a positional
  list of handles (a tuple-typed arg → a `Tuple` handle over its arg ValueId). `script.ts` spreads
  these into the body callback after `s`.

## 5. Builder handles (`builder/script.ts` interfaces + `builder/expr.ts` impl)

- `Tuple<C>` (public interface; `C` is a `TupleType`): exposes, for each named component, a
  property keyed by the component name returning a `Field<componentType>`; plus `at(i): Field<…>`
  (positional, literal index `number`), and `expr(): Expr<C>` (the raw memref, for returning /
  passing). Typed via abitype over `C['components']`. A nested-tuple component's `Field.get()`
  returns a `Tuple<innerC>`; a word component's `Field.get()` returns `Expr<word>`.
- `Field<t>` (Cell-like): `get(): t extends TupleType ? Tuple<t> : Expr<t>`; `set(v): void`
  (`v` is `IntoExpr<t>` for words, or a `Tuple`/literal for composite members).
- `s.tuple(type, init?)`: `type` is a `t.struct`/`t.tuple` (or raw `readonly AbiParameter[]`);
  `init` is a partial, name-keyed (or positional) record of members; returns `Tuple<type>`.
  Lowers to `tuplenew` (alloc + zero-fill + MSTORE provided members; omitted/literal-0 → no MSTORE).
- `s.call` output unwrap: outputs `[]`→void; `[one]`→ `Expr<one>` if scalar OR `Tuple<one>` if the
  single output is a tuple; `[many]`→ `readonly [...]` of (Expr|Tuple) per output. The decode lowers
  to a tuple-decode (call.ts) for tuple outputs.
- `SubcallInputs` per-parameter union extends to: `AbiParameterToPrimitiveType<input,'inputs'> |
Expr<input.type> | (input is tuple ? Tuple<input> : never)`. A tuple arg may be a `Tuple` handle,
  a `s.tuple(...)` result, or a plain literal object (the recorder builds the tuple from the object
  via `tuplenew`, fields literal-or-Expr, omitted → 0).
- The recorder's `coerceToId` must gain a tuple branch: if the target type is a tuple and the value
  is (a) a `Tuple` handle of this recorder → reuse its ValueId (reference); (b) a plain object →
  build a `tuplenew` from it (members coerced per component type); else type error. Field handles
  are module-private (WeakMap like Expr/Cell). `Tuple` handles install staging traps like Expr.
- `Recorder` records: `tuplenew` (s.tuple / literal-object coercion), `field` (Field.get),
  `tupleset` (Field.set), and tuple decode for call outputs (a tuple output ValueId of TupleType;
  see §3 decode).

## 6. Codegen (`codegen/{layout? no — abi/layout.ts}`, `codegen/lower.ts`, `codegen/frame.ts`,

`codegen/abi.ts`, `codegen/call.ts`)

- `abi/layout.ts`: add `{ kind: 'tuple'; abi: string; components: TypeLayout[]; dynamic: boolean }`
  to `TypeLayout`; `layoutOf` accepts a tuple type (string `'tuple'`+components is NOT how it
  arrives — `layoutOf` currently takes a string; ADD an overload `layoutOfType(t: EvsType)` that
  handles `TupleType` objects and nested string arrays, delegating to `layoutOf` for strings). A
  tuple is `dynamic` iff any component layout `isDynamic`. `headBytes` already walks PlainAbiParam.
- `codegen/frame.ts`: `outsOf` must include the out of `tuplenew`/`field` (and the new nodes carry
  one `out`). A tuple value occupies ONE frame slot (a pointer). No multi-slot values.
- `codegen/lower.ts`: add `lowerTupleNew` (model on `lowerArrnew`: bump-alloc `32*n`, zero-fill via
  CALLDATACOPY-past-end, MSTORE provided members at `ptr + 32*i`), `lowerField` (`MLOAD(ptr+32*i)
→ slot`), `lowerTupleSet` (`MSTORE(ptr+32*i, value)`). `refOf` already folds `data` consts; a
  fully-constant tuple may stay a runtime `tuplenew` (simplest) — do NOT need a const fold.
- `codegen/abi.ts` (`emitReturnEncode` + `emitCalldataDecode`/`emitDynCalldataArg`): add a
  `case 'tuple'` per emitter that recurses head/tail over components (static inline, dynamic
  offset+tail). Keep the cursor in scratch; reuse `emitMemCopy`/`emitNormalizeWord`/
  `emitNormalizeElemsLoop`. The `headSize`/`dynOff` math must count a STATIC inner tuple as
  `headBytes(components)` head words (NOT 1) — break the "one head word per component" assumption
  with a cumulative head-offset walk.
- `codegen/call.ts`: a tuple ARG (encode) → calldata head/tail like the return encoder; a tuple
  OUTPUT (decode) → allocate a flat block and decode components into it (static word → copy head
  word into `wᵢ`; dynamic member → decode into a memref aliasing the snapshot, store its pointer
  into `wᵢ`). The `staticMinSize`/`headOffset = 32*j` guards must count cumulative head words for
  static tuple outputs.

**Differential bar**: emitted RETURN/calldata bytes for tuples MUST equal viem
`encodeAbiParameters([{type:'tuple', components}], [obj])` / round-trip `decodeFunctionResult`, on
paris/shanghai/cancun. This is the acceptance gate (testing.md §4.2).

## 7. Interpreter (`ir/interp.ts`) — byte-exact oracle

- Add `interface TupleVal { readonly kind: 'tuple'; readonly fields: Value[] }` to `Value`. A tuple
  field is itself a `Value` (bigint word, BytesVal, ArrayVal, or TupleVal). Reference semantics
  (shared, like ArrayVal): `tupleset` mutates `fields[i]` in place; `field` reads `fields[i]`.
- `execStmt`: `tuplenew` (build a TupleVal with zero-filled fields, then set provided), `field`
  (read), `tupleset` (write). A `memref(id)` accessor must accept TupleVal.
- ABI codec: `encodeParamsBlock`/`encodeTail` and `decodeOutputs` gain a tuple case (head/tail over
  components; static inline, dynamic offset+tail). `constValue`/`zeroValue`/`jsValueOf`/`coerceArg`/
  the type guards gain tuple branches. `zeroValue(tuple)` = a TupleVal of zero fields. `jsValueOf`
  of a tuple = the named object (all-named) or positional array, matching abitype.
- These must reproduce codegen byte-for-byte (the differential suite cross-checks both vs viem).

## 8. `compile.ts` / `viem.ts` / `index.ts`

- `compile.ts`: `CompiledEvsScript<name, args extends readonly EvsType[], ret>` (args type param
  changes from `readonly ArgSpec[]`). The `CompiledOf`/`compile` structural constraint updates.
- `viem.ts`: unchanged (it forwards the literal `ScriptAbi`).
- `index.ts`: export `TupleType`, `NamedType`, `Tuple`, `Field`, `ScalarType`, `StringType`, and
  the `StructTypeOf`/`TupleTypeOf`/`TupleArrayOf`/`TypeToComponent`/`TupleLitOf`/`TupleAsParam`
  type helpers as needed. Keep `ArgSpec`/`arg` exported (s.fn). Remove nothing the public surface
  still needs; the public surface is governed by module-interfaces (amend it).

## 9. Tests

- New `packages/contracts/src/Composite.sol` (solc 0.8.30, optimizer off, evm prague): a struct
  return (`positions()`-style, mirror Uniswap V3 `INonfungiblePositionManager.positions`), a nested
  struct return, a struct-taking view fn (`quote(QuoteParams) returns (...)`), a struct echo
  (`echoStruct(P) returns (P)`), all `external pure`/`view` deterministic. Add `'Composite'` to
  `CONTRACTS` in `packages/contracts/scripts/codegen.ts`.
- Unit tests: `core/types` (t.struct/t.tuple/array, guards, typesEqual), `abi/layout`,
  `ir/nodes`+`ir/validate` (tuple round-trip + rejection), recorder (s.tuple/field/decode).
- Type tests (`*.test-d.ts`): args-as-positional-params inference, `t.struct` field-handle typing
  (`slot0.tick.get(): Expr<'int24'>`), tuple output → `Tuple` handle, `ReadContractReturnType`
  object with struct fields, `ReadContractParameters['args']` labeled positional tuple, abitype
  §4.2 interning regression still green.
- Differential (`src/differential.test.ts`): tuple decode/encode byte-exact vs viem across
  paris/shanghai/cancun; s.tuple construct+mutate; struct call arg byte-exact calldata.
- Integration (`test/integration/`): a script calling `Composite` struct getters across all three
  `toViem` paths; assert fully-typed object result.
- **Rewrite ALL existing tests/examples off `arg()`+`s.args`** to the new positional-callback-param
  API. This is mechanical but broad (flagship.test, execution-paths, differential, builder.test-d,
  validation.test, script.test snapshots, etc.). Regenerate `__snapshots__` where args/ABI shape
  changed (review diffs). Add regression assertions where behavior is preserved.

## 10. Docs (after green)

- `api.md` §2 (args — superseded), §3 (EvsType/LitOf/at), §5 (tuple reference semantics, `s.tuple`),
  §6 (tuple outputs → `Tuple` handle; `SubcallInputs` tuple/struct literals; drop the deferral).
- `architecture.md` §0 (drop unanimous-`arg()`), §2/§2.1 (supersede ordered-declarator; address the
  `UnionToTuple` hazard for `t.struct` records — SAFE because struct→named tuple→object, runtime
  order = `Object.keys`), §5 (tuple memrefs + skip-zero-write soundness), §8/§8.2 (`case 'tuple'`).
- `module-interfaces.md` — update frozen `evscript`/`ScriptBuilder`/`t`/`Expr`/`ScriptAbi`/
  `CompiledEvsScript`; add `Tuple`/`Field`/`TupleType`/`s.tuple`.
- `amendments.md` — new `## 16. Composite types (issue #2)` section; quote each pre-change frozen
  signature in `Law:`, the new one in `Shipped:`, `Rationale:`, `Status: **accepted**`.
- `apps/docs` Starlight: rewrite affected pages; every ` ```ts ` fence must pass `check:snippets`.
- `examples/pool-meta`, `examples/token-balances`: rewrite to positional params + showcase a struct
  return (pool-meta: use a struct getter and `slot0.tick.get()`). `README.md` updated.

## 11. Process rules (CLAUDE.md)

- NEVER `bun test`. Use `bun run build`, `bun run test` (unit+types), `bunx vitest run <file>
--project unit`, `bun run test:integration`, `bun run check` (fmt:check+lint:ci+typecheck).
- Commit identity `dev@maxencerb.com`. Do not run keep-awake processes. Catalog-pinned deps; run
  `bun install` only if deps change (they should not).
- Lint is `oxlint --deny-warnings` (no unused imports/vars). Format with `oxfmt` (`bun run fmt`).
