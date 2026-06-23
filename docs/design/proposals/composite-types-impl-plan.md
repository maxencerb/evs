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
6. **Tuples flow out** — `s.return({ x: tupleHandle })` returns a tuple, abitype-typed (the handle
   is returnable directly; `tupleHandle.expr()` is the equivalent bare-memref form).

**Delivered by the §12 follow-up (same PR, issue #2's "arrays of tuples" + `T[][]`):**

- Arrays of tuples (`tuple[]`, static-element AND dynamic-member element) and one-level nested
  arrays (`uint256[][]`, `string[]`) — decode/read, construct/mutate, return, and call-arg encode.
  See **§12** for the binding byte-exact spec.

**Still deferred (represented in the type vocabulary, builder/codegen restricted — emit a clear
`UNSUPPORTED_V0` if reached, and note in the amendment):**

- Two-level arrays of tuples (`tuple[][]`), fixed-size arrays (`T[N]`), and string-array nesting
  deeper than `[][]`. The vocabulary already represents them; closing them is additive on top of
  §12 (one more nesting level / a separate `T[N]` codepath).

If a still-deferred shape is reached at runtime, throw `EvsTypeError('UNSUPPORTED_V0', …)` naming it.

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

## 12. Arrays of composite (`tuple[]`, `T[][]`, `string[]`) — byte-exact spec

> BINDING for the in-PR follow-up. Closes issue #2's "arrays of tuples" + `T[][]`. Builds additively
> on §3 (flat-pointer tuples). Scope: ONE level of array nesting over a composite/dynamic element —
> `tuple[]` (static-element e.g. `Position[]` AND dynamic-member element e.g. `WithBytes[]`),
> `uint256[][]`, `string[]`/`bytes[]`. OUT (still `UNSUPPORTED_V0`): `tuple[][]`, `T[N]`, string
> arrays nested deeper than `[][]`.

### 12.1 Memory representation — array of pointers (reuses the word-array layout verbatim)

A composite-element array is a memref to **`[len:32][p0:32][p1:32]…[p_{len-1}:32]`** — IDENTICAL to
the word-array block (§ word-array: `[len][w0]…`, element addr `ptr + 32 + 32·i`), except each slot
`pᵢ` holds a **memref pointer** to element `i`'s own block rather than an inline value word:

- `tuple[]` → `pᵢ` points to a flat tuple block (`32·k` words, §3).
- `T[][]` → `pᵢ` points to an inner array block (`[len_i][…]`).
- `string[]`/`bytes[]` → `pᵢ` points to a bytes block (`[len_i][payload]`).

Consequence: `lowerArrnew`/`lowerIndex`/`lowerArrset` address arithmetic (`ptr + 32 + (i<<5)`, len
at `ptr`, bounds `i<len`→Panic 0x32, alloc cap `2^32-1`→Panic 0x41, CALLDATACOPY-past-end zero-fill)
is **element-type-agnostic and reused unchanged**. Only the _leaf semantics_ differ: `index` yields
the pointer as the out-value (its out-type is the element tuple/array/bytes, so downstream
`field`/`at` dereference it); `arrset` stores a memref pointer; `arrnew` zero-fills pointer slots
(null until `arrset` — a user dereferencing an unset slot is UB exactly like Solidity).

### 12.2 ABI wire format (what viem/solc produce — the differential bar)

For an array `E[]` written at a position whose **data start** `D` = first word after `len`:

- **Static element** `E` (e.g. a static tuple `Position`, or a word): `[len]` then each element
  inlined contiguously, `len · staticSize(E)` bytes, NO offset words. `staticSize` = `headBytes(E.components)`
  for a static tuple, `32` for a word.
- **Dynamic element** `E` (dynamic tuple, inner array, string/bytes): `[len]` then `len` offset
  words at `[D, D+32·len)`, **each `offᵢ` relative to `D`** (NOT the enclosing block base — arrays
  rebase to their own data start), then the element tails appended from `D+32·len` onward.

Note the offset-base difference from §3 tuples: a **tuple** member's dynamic offset is relative to
the tuple **block base**; an **array** element's offset is relative to the array **data start `D`**
(the word after `len`). Both are "relative to the start of the enclosing head/offset region." Get
this exactly right — a one-word base error silently mis-encodes.

### 12.3 `abi/layout.ts` — widen `array.elem`

`TypeLayout` array variant: `elem: WordLayout` → **`elem: TypeLayout`**. `layoutOf` (string path)
returns an array layout for `s.endsWith('[]')` when the element is a word OR `string`/`bytes` OR a
one-level `T[]` (narrow the `badTypeError` to still reject `T[N]` and `[][][]+`). `layoutOfType`
(tuple path): a `TupleType` with `.type === 'tuple[]'` → `{ kind:'array', abi:'tuple[]', elem:
tupleLayoutOf(elemTuple) }`; keep `'tuple[][]'` throwing `UNSUPPORTED_V0`. An array is always
`isDynamic` (existing `l.kind !== 'word'`). `headBytes`: an array param is always one 32-byte offset
slot (unchanged — arrays are dynamic). `staticSize(elem)` helper = `isDynamic(elem) ? error : (elem.kind==='tuple' ? headBytes(elem.components) : 32)`.

### 12.4 `ir/validate.ts` — admit composite elements

`checkElemType` (arrnew/array element gate): accept `word | string | bytes | one-level T[] | tuple`
elements; still reject `T[N]`, `tuple[][]`, and `[][]`-deeper string arrays with `UNSUPPORTED_V0`.
`index`/`arrset`/`len` already use `isArrayValueType` + `elemTypeOf` — structurally ready. `checkAbiParam`
already accepts `tuple[]`. Add a focused backstop: a `tuple[][]` IR node still fails validation.

### 12.5 Interp oracle (`ir/interp.ts`) — widen `ArrayVal`, mirror the loops

`ArrayVal` becomes **`{ kind:'array'; elem: EvsType; items: Value[] }`** (was `elem:WordType;
words:bigint[]`). A word-element array's `items` are `bigint`s; a composite-element array's `items`
are memref `Value`s (TupleVal/ArrayVal/BytesVal). Reference semantics preserved (`items` mutated in
place by `arrset`). Touch points: `arrnew` (zero-fill = `zeroValue(elemType)` per slot, NOT `0n`
for composite — but a null/zero pointer is fine; use `zeroValue` so reads are well-typed); `index`
(returns `items[i]`); `arrset` (stores the element `Value`); `encodeTail`/`encodeStatic` (the `T[]`
arm: static element → inline each `encodeStatic(elem,itemᵢ)`; dynamic element → `[len]` + per-element
offsets relative to data start + appended `encodeTail(elem,itemᵢ)`); `decodeDynamic` (the `T[]`
arm: read `len`, bounds; static element → `decodeStatic` each at `D+i·staticSize`; dynamic element →
per-element offset word at `D+32·i` relative to `D`, recurse `decodeDynamic(elem, …)`); `zeroValue`/
`constValue`/`coerceValue`/`jsValueOf` array branches carry the element `Value`. This is the
REFERENCE the codegen is diffed against — implement it first and exactly.

### 12.6 ABI decode codegen (`codegen/abi.ts` + `call.ts`) — on-stack element loop (no memcpy)

Add `emitDecodeArrayToMem(w, elemLayout, pushBase, pushEnd, fail, belowFlat)`: decode reads `len`
at `base`, bounds `len ≤ 2^64-1`; allocates the pointer array `[len][p0…]` (`32 + 32·len` bytes,
bump `FREE_PTR`); `D = base + 32`; then a loop `i = 0..len-1`:

- static element: elementBase = `D + i·staticSize`; bounds `elementBase + staticSize ≤ end`;
  recurse `emitDecodeTupleToMem`(static tuple) / inline-word read; store the element block pointer
  (tuple) or value (word) into `arr + 32 + 32·i`.
- dynamic element: read `offᵢ` at `D + 32·i`, bounds `offᵢ ≤ 2^64-1`; `elemPtr = D + offᵢ`, bounds
  `elemPtr + 32 ≤ end`; recurse the matching decoder (`emitDecodeTupleToMem` for dynamic tuple, a
  nested `emitDecodeArrayToMem` for `T[][]`, the leaf string/bytes alias for `string[]`); store the
  returned block pointer into `arr + 32 + 32·i`.

Decode uses **no `emitMemCopy`** (it aliases leaf bytes and freshly allocates tuple/array blocks) →
the loop counter MAY live on the stack. Keep loop state as `[i, len, D, arr, …below]`; checked loop
labels at absolute height `belowFlat + (loop-state size)`, mirroring `emitNormalizeElemsLoop`. Wire
into `emitCalldataDecode` (args path) and `call.ts` return-decode (snapshot base/end from scratch
`SNAP_SLOT`, exactly as the tuple output path does). The free-ptr churn from per-element allocation
is fine — base/end are read from scratch, never the stack.

### 12.7 ABI encode codegen (`codegen/abi.ts` + `call.ts`) — scratch-frame element loop

Add `emitEncodeArrayTail(w, elemLayout, pushArrPtr, tails, opts)`, written at the shared tail cursor
(`TAIL_CURSOR = 0x00`, §3):

1. `MSTORE(cursor, len)` (`len = MLOAD(arrPtr)`); `D = cursor + 32`.
2. **static element**: advance `cursor` to `D + len·staticSize` (reserve the body), then loop
   `i`: `emitEncodeBlock`(static tuple) with `base = D + i·staticSize`, member source words from
   `MLOAD(elemPtrᵢ + 32·j)` where `elemPtrᵢ = MLOAD(arrPtr + 32 + 32·i)` (a static tuple has no
   tail, so this writes inline only; for a word element just `MSTORE`). No memcpy.
3. **dynamic element**: advance `cursor` to `D + 32·len` (reserve the offset words); loop `i`:
   record `tailPos = cursor`, `MSTORE(D + 32·i, tailPos − D)` (offset relative to `D`), then encode
   element `i`'s tail at `cursor` — for a dynamic tuple reserve `headBytes` then `emitEncodeBlock`;
   for `T[][]` recurse `emitEncodeArrayTail`; for `string[]`/`bytes[]` `emitLeafDynTail`. Each
   element extends the shared monotone `cursor`, exactly like a dynamic tuple member (§3).

**Scratch-frame discipline (the load-bearing risk).** `emitLeafDynTail`/`emitMemCopy` require the
operand stack to be EXACTLY `[dst,src,len]` (height 3) at the pre-cancun `@memcpy` subroutine entry.
A dynamic-element encode loop that holds `[i,len,D,arrPtr]` on the stack would violate that. So the
dynamic-element loop keeps its state in a **reserved scratch frame**, not on the stack: at
`emitReturnEncode`/call-arg-encode entry, before computing `out`, bump `FREE_PTR` by `32·FRAMES·SLOTS`
to reserve `FRAMES` loop frames BELOW the output buffer (so `out = MLOAD(0x40)` sits above them and
`RETURN(out,…)` never returns scratch). `FRAMES` = the max concurrent array-nesting depth along any
path of the encoded type (statically known; `tuple[]`=1, a `tuple[]` whose member is `T[][]`=2…).
Each frame holds `{arrPtr, D, len, i}` (4 words) at a fixed offset; the loop reads/writes `i` and
recomputes `elemPtrᵢ` from `arrPtr` so nothing but the live `[dst,src,len]` is on the stack when
`emitMemCopy` runs. Static-element loops use no memcpy, so they may keep counter state on the stack.

### 12.8 Builder handles (`builder/{script,expr}.ts`)

- `index`/`at(i)` on an array whose element is composite returns the element handle: `tuple[]`→a
  `Tuple<elem>` handle bound to the `index` out ValueId; `T[][]`→an array (Mut/read) handle;
  `string[]`→`Expr<'string'>`. `atOp`/`MutArrayImpl` widen `elem` from `WordType` to `EvsType`; the
  read handle for a tuple element installs the same `TUPLE_INTERNALS` as a decoded tuple (one
  unified tuple handle, §3/§4).
- `s.newArray(elem, len)`: widen off word-only to admit `tuple`/`string`/`bytes`/one-level `T[]`
  elements (keep `T[N]`/`tuple[][]` gated, still `UNSUPPORTED_V0`/`TYPE_MISMATCH`). `arrset` accepts
  a `Tuple` handle / array handle / `Expr` per element type.
- `s.call` tuple-array OUTPUT → an array-of-`Tuple` read handle; `SubcallInputs` tuple-array arg
  accepts an array handle or a literal `readonly T[]`. abitype: `t.array(t.struct(...))` infers
  `readonly Struct[]`; `s.call` output `'tuple[]'` infers `readonly Struct[]`; `uint256[][]`→
  `readonly (readonly bigint[])[]`; `string[]`→`readonly string[]`.

### 12.9 Un-gate (narrow, do not delete)

`abi/artifact.ts:~261` (accept `tuple[]` ABI params), `abi/layout.ts:80-108` (array-of-composite
layout), `builder/expr.ts` `coerceTupleToId`/`s.tuple`/`s.newArray`, `core/types.ts` `arrayTypeRT`
(allow `t.array(struct)`→`tuple[]`). Each guard NARROWS to the still-deferred shapes
(`tuple[][]`, `T[N]`, deeper nesting) rather than disappearing.

### 12.10 Tests + acceptance

- LOCK migration: `validation.test.ts` (`uint256[][]` arg) and `abi/artifact.test.ts` (`tuple[]`
  output) flip from "throws `UNSUPPORTED_V0`" to "succeeds"; ADD new lock tests that `tuple[][]` and
  `T[N]` STILL throw.
- Differential (`src/differential.test.ts`, all of paris/shanghai/cancun): read+return a
  `Position[]` (static-element), a `WithBytes[]` (dynamic-member), a `uint256[][]` (ragged), a
  `string[]`; encode a `Position[]` call arg. **interp == compiled bytecode == viem
  `encodeAbiParameters`** byte-exact is the acceptance gate.
- Integration (`test/integration/`, real solc `Composite.sol` getters added in prep —
  `positionsBatch`, `withBytesBatch`, `matrix`, `names`, `sumLiquidity`): `eth_call` each through a
  compiled evs script on anvil; assert exact returndata + fully-typed result.
- Implementation ORDER (each verified before the next): layout+IR widen → interp oracle → decode
  codegen (verify read via returning a derived word) → static-element encode (verify `Position[]`
  return/arg) → dynamic-element encode + scratch frames (verify `string[]`/`uint256[][]`/
  `WithBytes[]` return) → builder handles + un-gate → tests/docs.
