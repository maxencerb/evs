# evs — User-Facing API Specification (binding)

Status: FINAL. Companion to `architecture.md` (mechanisms) and `module-interfaces.md` (module
law). Everything here is the public surface of `@maxencerb/evs`. TS floor: **≥ 5.5, strict
mode** (viem requires ≥ 5.0.4 strict). ESM only.

```ts
import { evscript, compile, t } from '@maxencerb/evs';
```

> **Amended by #2 (composite types).** Script args are now a single `t.*` type or a `readonly`
> list of them, arriving as **positional callback params after `s`**; `arg()`/`s.args`/`ArgSpec`
> are no longer the script-args surface. `arg()`/`ArgSpec` are RETAINED for `s.fn` param
> declarations only (§8). See amendments.md §16. The pre-change forms are quoted there as `Law:`.

## 1. `evscript` — entry point

```ts
export function evscript<
  const name extends string,
  const args extends ArgsInput = readonly [],
  ret extends Record<string, Expr> = Record<string, Expr>,
>(
  def: { name: name; args?: args },
  body: (s: ScriptBuilder, ...args: ArgHandles<NormalizeArgs<args>>) => ScriptReturn<ret>,
  opts?: { locations?: boolean }, // default true: capture source locations
): EvsScript<name, NormalizeArgs<args>, ret>;

export interface EvsScript<
  name extends string = string,
  args extends readonly EvsType[] = readonly EvsType[],
  ret extends Record<string, Expr> = Record<string, Expr>,
> {
  readonly name: name;
  readonly ir: ScriptIr; // frozen, JSON-serializable
  readonly abi: ScriptAbi<name, args, ret>; // literal-typed value, exists pre-compile
  compile(options?: CompileOptions): CompiledEvsScript<name, args, ret>; // sugar for compile()
}
```

`const` type params mean inline `args` lists and inline ABIs need no `as const`. Standalone
ABIs: declare `as const satisfies Abi`.

## 2. Args: positional callback params and the `t` type namespace (decision 1 — amended by #2)

```ts
export type ArgsInput = EvsType | readonly EvsType[]; // a lone type or a list
export type NormalizeArgs<a extends ArgsInput> = a extends readonly EvsType[] ? a : readonly [a];

// the body-callback handle for one normalized arg type
export type ArgHandle<t extends EvsType> = t extends TupleType ? Tuple<t> : Expr<t>;
// the positional handle tuple spread into the body after `s` (homomorphic — order preserved)
export type ArgHandles<types extends readonly EvsType[]> = {
  readonly [i in keyof types]: ArgHandle<types[i]>;
};

export const t: {
  readonly address: 'address';
  readonly bool: 'bool';
  readonly uint8: 'uint8';
  /* …every uintN/intN multiple of 8… */ readonly uint256: 'uint256';
  readonly int8: 'int8';
  /* … */ readonly int256: 'int256';
  readonly bytes1: 'bytes1';
  /* … */ readonly bytes32: 'bytes32';
  readonly string: 'string';
  readonly bytes: 'bytes';
  array<const e extends StringType>(elem: e): `${e}[]`; // t.array(t.address) -> 'address[]'
  array<const e extends TupleType>(elem: e): TupleArrayOf<e>; // t.array(t.struct({…})) -> tuple[]
  struct<const spec extends Record<string, EvsType>>(spec: spec): StructTypeOf<spec>; // named tuple
  tuple<const items extends readonly EvsType[]>(...items: items): TupleTypeOf<items>; // positional
};
```

`args` is a single `t.*` type or a `readonly` list of them; a lone type is sugar for a
one-element list (`args: t.uint256` ≡ `args: [t.uint256]`), and a zero-arg script omits `args`
entirely. Args arrive as **positional callback params after `s`**:
`(s, token, amount) => {…}`. A scalar/string/array arg arrives as an `Expr`; a `t.struct`/
`t.tuple` arg arrives as a `Tuple` handle (§5/§6). Raw type strings are accepted everywhere
`t.*` is (the `t` namespace is autocomplete sugar); a raw `readonly AbiParameter[]` is accepted
wherever a tuple type is expected.

`t.struct({...})` builds a **named** tuple type (its runtime member order is `Object.keys`
insertion order — the only encode-order source of truth); `t.tuple(...)` builds a **positional**
tuple type (members `name: ''`); `t.array(elem)` is extended to tuple elements (`tuple` →
`tuple[]`). See §3 for `EvsType`/`TupleType`.

**No `UnionToTuple` hazard.** A `t.struct` record is unordered at the type level, but it
compiles to a single NAMED ABI `tuple`, which abitype infers as an **order-insensitive object**
(abitype research §4.2). Positional `t.tuple(...)` and the positional script-arg list both use
**ordered declarators** and never reach `UnionToTuple`. Call sites stay viem-native positional:
`args: [pool, fee]` typed as `readonly [arg0: \`0x${string}\`, arg1: number]`.

Argument types: word types, `string`, `bytes`, `T[]`, `t.struct`/`t.tuple` types, and — added by
the #2 follow-up — one-level arrays of composite/dynamic elements (`tuple[]`, `uint256[][]`,
`string[]`/`bytes[]`) are valid script args. Fixed arrays `T[N]`, two-level arrays of tuples
(`tuple[][]`), and string arrays nested deeper than `[][]` remain recording-time errors
(`EvsTypeError('UNSUPPORTED_V0', …)`); the `TupleType`/`ArrayType` vocabulary already represents
them, so they are an additive follow-up (one more nesting level + builder wiring), not a rewrite.

## 3. Types, `Expr`, and literal coercion

```ts
export type WordType =
  | `uint${UintBits}`
  | `int${UintBits}`
  | 'address'
  | 'bool'
  | `bytes${BytesSize}`;
export type DynType = 'string' | 'bytes';
// amended by #2: a scalar leaf is a word or a dyn byte-blob; arrays are string-encoded and
// nestable to a bounded depth; tuples are descriptor OBJECTS (named members can't live in a
// string).
export type ScalarType = WordType | DynType;
export type ArrayType = `${ScalarType}[]` | `${ScalarType}[][]` | `${ScalarType}[][][]`;
export type StringType = ScalarType | ArrayType; // every string-encoded type
export interface TupleType {
  readonly type: 'tuple' | 'tuple[]' | 'tuple[][]';
  readonly components: readonly NamedType[];
}
export interface NamedType {
  // a TupleType member: structurally an abitype `AbiParameter` (and the IR `PlainAbiParam`)
  readonly name: string; // non-empty for a struct field; '' for a positional t.tuple member
  readonly type: string; // canonical Solidity string ('uint256', 'tuple', 'tuple[]', …)
  readonly components?: readonly NamedType[]; // present iff type starts with 'tuple'
}
export type EvsType = WordType | DynType | ArrayType | TupleType; // string OR tuple object
export type NumericType = `uint${UintBits}` | `int${UintBits}`;
export type BitsType = `uint${UintBits}` | `bytes${BytesSize}`;

declare const exprBrand: unique symbol;
export interface Expr<t extends EvsType = EvsType> {
  readonly [exprBrand]: t; // nominal, covariant phantom
  readonly type: t; // runtime-readable type tag

  // arithmetic — checked (Panic 0x11 / 0x12); this-parameter restricts to numeric types
  add(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  sub(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  mul(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  div(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  mod(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;

  // comparisons — LT/GT vs SLT/SGT chosen from the static type
  lt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  lte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  eq(this: Expr<t & WordType>, rhs: IntoExpr<t>): Expr<'bool'>; // word types only (typed)
  neq(this: Expr<t & WordType>, rhs: IntoExpr<t>): Expr<'bool'>;

  // bool logic — eager, NOT short-circuiting (use s.if for conditional execution)
  and(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>;
  or(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>;
  not(this: Expr<'bool'>): Expr<'bool'>;

  // bitwise (result re-canonicalized to t's width)
  bitAnd(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitOr(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitXor(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitNot(this: Expr<t & BitsType>): Expr<t>;
  shl(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>;
  shr(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>; // SAR for intN via s.shr

  // conversions — widening free; NARROWING IS CHECKED (Panic 0x11 on out-of-range)
  toUint<const u extends `uint${UintBits}`>(target: u): Expr<u>;
  toInt<const i extends `int${UintBits}`>(target: i): Expr<i>;
  asAddress(this: Expr<'uint256' | 'bytes32'>): Expr<'address'>; // checked: high 96 bits zero
  asUint256(this: Expr<'bytes32'>): Expr<'uint256'>; // free reinterpret
  asBytes32(this: Expr<'uint256'>): Expr<'bytes32'>; // free reinterpret

  // dynamic / array values (memrefs)
  length(this: Expr<DynType | ArrayType>): Expr<'uint256'>;
  // amended by #2: `elem` broadened to StringType (nested string arrays in the vocabulary); the
  // `& ArrayType` pins `${elem}[]` to the depth-bounded array set (an unbounded `${StringType}[]`
  // could reach depth 4, which is not an EvsType).
  at<elem extends StringType>(
    this: Expr<`${elem}[]` & ArrayType>,
    i: IntoExpr<'uint256'>,
  ): Expr<elem>;
  // amended by the #2 follow-up: a tuple-array Expr's `.at(i)` returns a typed Tuple element handle
  // (the same unified Tuple — `.at(i).field.get()`).
  at<C extends TupleType>(this: Expr<C & { type: 'tuple[]' }>, i: IntoExpr<'uint256'>): Tuple</* elem */>;
  // bounds-checked → Panic 0x32
}
```

Every method on the builder also exists as a free function (`s.add(a, b)`, `s.lt(a, b)`, …) for
literal-left cases (`s.sub(100n, x)`); at least one operand must be an `Expr`.

### Literal coercion (`IntoExpr`) and validation rules

```ts
export type LitOf<t extends EvsType> = t extends NumericType
  ? bigint | number
  : t extends 'address'
    ? `0x${string}`
    : t extends 'bool'
      ? boolean
      : t extends `bytes${BytesSize}`
        ? `0x${string}`
        : t extends 'string'
          ? string
          : t extends 'bytes'
            ? `0x${string}`
            : t extends TupleType // amended by #2: tuple literal via abitype (object/positional)
              ? TupleLitOf<t>
              : t extends `${infer e extends StringType}[]`
                ? readonly LitOf<e>[]
                : never;
// A TupleType viewed as an unnamed abitype AbiParameter and run through abitype's
// AbiParameterToPrimitiveType: every member named → an object keyed by names; any member unnamed
// → a positional tuple; recurses through nested components / array suffixes.
export type TupleLitOf<t extends TupleType> = AbiParameterToPrimitiveType<
  TupleAsParam<t>,
  'inputs'
>;
export type IntoExpr<t extends EvsType> = Expr<t> | LitOf<t>;
```

Validated **at recording time** with the call-site loc (`EvsTypeError` on violation):

| Literal                               | Rule                                                      |
| ------------------------------------- | --------------------------------------------------------- |
| `number` for `uintN`/`intN`           | must be a safe integer; range-checked against N           |
| `bigint` for `uintN`/`intN`           | range-checked; negatives two's-complemented for `intN`    |
| `boolean`                             | only for `'bool'`                                         |
| `0x` string for `address`             | exactly 20 bytes; checksum NOT enforced (viem-permissive) |
| `0x` string for `bytesN`              | exactly N bytes                                           |
| `0x` string for `bytes`               | any even-length hex                                       |
| `string` for `'string'`               | UTF-8 encoded                                             |
| JS array for `T[]`                    | element-wise rules of `T`                                 |
| object/tuple for `t.struct`/`t.tuple` | member-wise rules per component (omitted → zero)          |

Word literals canonicalize at recording. Dynamic literals (`string`/`bytes`) and **word-array**
literals become bytecode **data segments** materialized by CODECOPY on first use. A
**composite-array literal** (a JS array for `tuple[]`/`uint256[][]`/`string[]`/`bytes[]`, added by
the #2 follow-up) is the exception: it has no flat data-segment blob (its elements are pointers into
freshly-allocated blocks), so the recorder BUILDS it at record time as `arrnew` + per-element
(`tuplenew`/`arrset`) with reference semantics and a fresh `[len][p0…]` block — constructible
anywhere its value type is expected (a call arg, `s.return`, a cell, `s.newArray` element).
Explicit constructor when inference needs help: `s.lit<const t extends EvsType>(type: t, value:
LitOf<t>): Expr<t>`.

**All-literal pure ops fold at recording.** If the fold would certainly Panic
(`s.add(2n**256n - 1n, 1n)`, `x.div(0n)` with literal x, out-of-range `toUint`), recording
throws `EvsTypeError` at that line. Escape hatch (if a guaranteed runtime panic is intended):
route one operand through a cell — `s.let(t.uint256, a).get().add(b)`.

### Staging misuse

Handles throw `EvsStagingError` from `valueOf`, `Symbol.toPrimitive`, `toString`, `toJSON`
(`x + 1`, `` `${x}` ``, `x == 5`, `JSON.stringify(x)` all explode at the offending line, citing
where the handle was recorded). `console.log(x)` is fine (non-throwing inspect:
`Expr<address> #4 ← s.call(token0) at pools.ts:9:18`). `if (x)` cannot be trapped at runtime —
front-page docs warning; enable `typescript/strict-boolean-expressions` (oxlint + tsgolint).

## 4. `ScriptBuilder` — full surface

```ts
// amended by #2: ScriptBuilder is now NON-GENERIC — it lost its `args` type param and its
// `s.args` member; script args arrive as positional callback params (§2). It gained `s.tuple`.
export interface ScriptBuilder {
  // values & state
  lit<const t extends EvsType>(type: t, value: LitOf<t>): Expr<t>
  let<const t extends EvsType>(type: t, init: IntoExpr<t>): Cell<t>
  let<t extends EvsType>(init: Expr<t>): Cell<t>
  newArray<const e extends WordType>(elem: e, length: IntoExpr<'uint256'>): MutArray<e>
  tuple<const c extends TupleType>(type: c, init?: TupleInit<c>): Tuple<c>  // §5 — allocator
  env<const k extends EnvKind>(kind: k): Expr<EnvTypeOf<k>>
  // EnvKind = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid'
  // address/caller → Expr<'address'>; others → Expr<'uint256'>
  // ⚠ FRAME-DEPENDENT: 'caller'/'address' lower to bare CALLER/ADDRESS, whose values depend
  // on the execution frame the chosen toViem() mode produces. In the DEFAULT deployless mode
  // caller = viem's internal wrapper contract (0xBd770416a3345F91E4B34576cb804a576fa48EB1
  // when no `account` is passed) and address = a per-script counterfactual CREATE2 address —
  // neither controllable (research/viem-integration.md §3.1). Caller-relative reads (e.g.
  // balanceOf(s.env('caller'))) REQUIRE toViem({ mode: 'stateOverride' }) + `account`; there
  // is no deployless workaround. compile() emits ENV_FRAME_DEPENDENT via onDiagnostic for
  // these two ops. timestamp/blocknumber/chainid are block context — identical across modes.

  // ops (free-function mirrors of the Expr methods; same checked semantics)
  add<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>     // ≥1 operand an Expr
  sub<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
  mul<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
  div<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
  mod<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
  lt<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>
  gt<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>
  lte<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>
  gte<t extends NumericType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>
  eq<t extends WordType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>
  neq<t extends WordType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<'bool'>
  and(a: IntoExpr<'bool'>, b: IntoExpr<'bool'>): Expr<'bool'>
  or(a: IntoExpr<'bool'>, b: IntoExpr<'bool'>): Expr<'bool'>
  not(a: IntoExpr<'bool'>): Expr<'bool'>
  bitAnd<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
  bitOr<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
  bitXor<t extends BitsType>(a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>
  bitNot<t extends BitsType>(a: Expr<t>): Expr<t>
  shl<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>
  shr<t extends BitsType>(a: Expr<t>, bits: IntoExpr<'uint256'>): Expr<t>

  // control flow (combinators — §7)
  if(cond: IntoExpr<'bool'>, then: () => void, otherwise?: () => void): void
  while(cond: () => IntoExpr<'bool'>, body: (loop: LoopCtl) => void): void
  for<const t extends NumericType>(
    range: { type: t; from: IntoExpr<t>; until: IntoExpr<t>; step?: IntoExpr<t> },
    body: (i: Expr<t>, loop: LoopCtl) => void,
  ): void
  select<t extends EvsType>(cond: IntoExpr<'bool'>, a: IntoExpr<t>, b: IntoExpr<t>): Expr<t>

  // calls (§6), functions (§8), return (§9)
  call: /* §6 */; tryCall: /* §6 */; fn: /* §8 */
  return<const ret extends Record<string, Expr>>(values: ret): ScriptReturn<ret>
}
```

## 5. Cells, mutable arrays, loop control

```ts
export interface Cell<t extends EvsType> {
  readonly type: t;
  get(): Expr<t>; // fresh snapshot at this program point
  set(value: IntoExpr<t>): void;
}
```

A `Cell` is **not** an `Expr` — reads are always explicit `.get()`, so "snapshot vs current
value" is visible at every use. For dynamic types the cell holds a memref pointer; `set` is
pointer assignment (reference semantics — documented).

```ts
// amended by #2 follow-up: `e` widens from WordType to EvsType — a composite-element array
// (tuple[], T[][], string[]/bytes[]) is an array OF POINTERS, [len][p0][p1]… (architecture §5).
export interface MutArray<e extends EvsType> {
  readonly elemType: e;
  readonly length: Expr<'uint256'>;
  set(i: IntoExpr<'uint256'>, v: IntoMember<e>): void; // a word→IntoExpr; a tuple→Tuple/literal;
  //                                                       a sub-array→an array handle. Panic 0x32
  get(i: IntoExpr<'uint256'>): e extends TupleType ? Tuple<e> : Expr<e>; // tuple→Tuple; else Expr
  expr(): Expr<TypeOfArray<e>>; // memref handle to the SAME buffer (later set() calls are visible
} //  through it — reference semantics, documented). TypeOfArray<e> is `${e}[]` / a tuple[] type.
```

`s.newArray(elem, length)` allocates a zero-filled array; runtime lengths ≥ 2^32 → Panic `0x41`.
For a word element this is `[len][len × 32 bytes]`. For a **composite/dynamic element** (amended by
#2 follow-up — `tuple`, `string`, `bytes`, or a one-level `T[]`) it is an **array of pointers**
`[len][p0][p1]…`: each slot holds a memref pointer to that element's own block (a flat tuple block
for `tuple[]`, an inner array for `T[][]`, a bytes block for `string[]`), exactly Solidity
`Struct[]`/`T[][]`/`string[]` memory (architecture §5). `arr.get(i)` on a `tuple[]` returns a
`Tuple` element handle (the same unified handle as a decoded tuple — `arr.get(i).field.get()`);
`arr.set(i, v)` stores the element pointer. This is the building block for "loop over inputs,
collect outputs" — the multicall-replacement pattern (example E2). Fixed-size `T[N]`, two-level
`tuple[][]`, and deeper-than-`[][]` arrays are still recording-time `EvsTypeError('UNSUPPORTED_V0', …)`.

### Tuples / structs (`Tuple`, `Field`, `s.tuple`) — added by #2

```ts
// the value a composite member accepts on write/init: a Tuple handle or a host literal
export type IntoTuple<t extends TupleType> = Tuple<t> | LitOf<t>;
export type IntoMember<t extends EvsType> = t extends TupleType ? IntoTuple<t> : IntoExpr<t>;

// a field handle over one tuple member (Cell-like). A composite member's `.get()` follows the
// pointer and yields a Tuple handle; a scalar member's `.get()` yields an Expr.
export interface Field<t extends EvsType> {
  readonly type: t;
  get(): t extends TupleType ? Tuple<t> : Expr<t>;
  set(value: IntoMember<t>): void;
}

// a tuple / struct memref handle. For each NAMED component, a property keyed by the component
// name yields a Field over that member; `at(i)` is the positional accessor (literal index); and
// `expr()` is the raw memref Expr (for returning the tuple or passing it as a call arg). Typed via
// abitype over `C['components']`.
export type Tuple<C extends TupleType> = {
  readonly [c in C['components'][number] as c['name'] extends '' ? never : c['name']]: Field</* member type */>;
} & {
  at(i: number): Field</* element member type */>;
  expr(): Expr<C>;
};

// the partial member record accepted by `s.tuple(type, init?)`: a fully-named struct takes a
// name-keyed object; a positional t.tuple takes a positional record. Every member is optional
// (omitted → zero) and accepts a literal, an Expr, or a Tuple (per member type).
export type TupleInit<C extends TupleType> = /* named object | positional record */;

// the allocator (on ScriptBuilder, §4):
tuple<const c extends TupleType>(type: c, init?: TupleInit<c>): Tuple<c>
```

`s.tuple(type, init?)` bump-allocates a packed `[w0][w1]…[w_{n-1}]` block (`n` = component
count, **no length prefix**), **zero-fills** it, then `MSTORE`s each provided member; an
omitted or literal-`0` member needs no write since the block is already zeroed. Each `wᵢ` is a
canonical word for a static member, or a memref pointer for a dynamic/composite member
(string/bytes/array/tuple). `field.get()` reads `wᵢ`; `field.set(v)` writes it.

**Reference semantics** (documented, like `MutArray.expr()` and dynamic cells): a `Tuple` handle
**is** the pointer. Passing it (to a call arg, `s.return`, a cell, or another field) copies the
pointer, not the block — so a later `field.set()` is visible through every alias. The SAME handle
type is produced by `s.tuple(...)`, by a decoded `'tuple'` call output (§6), and by a
struct/tuple script arg (§2) — one unified tuple type.

```ts
export interface LoopCtl {
  break(): void; // jump past the owning loop
  continue(): void; // jump to the owning loop's header (for-loops: to the step)
}
```

`LoopCtl` is scoped: calling it outside its owning loop's body recording → `EvsScopeError`.

## 6. Calls — `s.call` / `s.tryCall`

```ts
type ViewMutability = 'pure' | 'view'

export interface SubcallParams<
  abi extends Abi | readonly unknown[],
  name extends ContractFunctionName<abi, ViewMutability>,
> {
  readonly address: IntoExpr<'address'>
  readonly abi: abi
  readonly functionName: name | ContractFunctionName<abi, ViewMutability>  // autocomplete union
  readonly args?: SubcallInputs<abi, name>
  readonly gas?: IntoExpr<'uint256'>            // optional cap; default forward-all
}
// per-parameter union (amended by #2): the abitype Register-resolved primitive (a literal object
// for a struct, a positional array for an unnamed tuple, a readonly Struct[] for a tuple[]) OR an
// Expr of that type OR — for a tuple param — a Tuple handle / s.tuple(...) result. A tuple[] param
// (added by the #2 follow-up) accepts the readonly Struct[] literal, an Expr<tuple[]>, or an array
// handle (its .expr()).
export type SubcallInputs<abi, name> = {
  readonly [i in keyof inputs]: inputs[i]['type'] extends 'tuple'
    ? AbiParameterToPrimitiveType<inputs[i], 'inputs'> | Tuple</* inputs[i] */> | Expr</* inputs[i] */>
    : AbiParameterToPrimitiveType<inputs[i], 'inputs'>
        | Expr<inputs[i]['type'] extends EvsType ? inputs[i]['type'] : never>
} // where inputs = ExtractAbiFunction<abi, name, ViewMutability>['inputs']

call<const abi extends Abi | readonly unknown[],
     name extends ContractFunctionName<abi, ViewMutability>>(
  p: SubcallParams<abi, name>,
): UnwrapSingle<SubcallOutputs<abi, name>>
// outputs []  → void;  [one] → Expr<one> | Tuple<one> (Tuple if the single output is a tuple);
// [many] → readonly tuple of (Expr|Tuple) per output (mirrors viem). A tuple[] output → a
// readonly Struct[] Expr whose .at(i) yields a typed Tuple element (added by the #2 follow-up).

tryCall<const abi extends Abi | readonly unknown[],
        name extends ContractFunctionName<abi, ViewMutability>>(
  p: SubcallParams<abi, name>,
): { readonly success: Expr<'bool'>; readonly value: UnwrapSingle<SubcallOutputs<abi, name>> }
```

Semantics and permissiveness:

- **Graceful widening (viem pattern, adopted)**: a non-`as const` ABI degrades to
  `functionName: string`, `args: readonly unknown[]`, outputs `Expr<EvsType>` — never a hard
  type error. `[x] extends [never]` guards after every Extract.
- Mutability filtered at the name level: nonpayable/payable functions are compile errors.
- Overloaded names → recording-time `EvsTypeError` (disambiguation via a pruned ABI; viem's
  `ExtractAbiFunctionForArgs` is the documented later fix).
- **Tuple/struct outputs** (`'tuple'`) decode to a `Tuple` handle (§5); a single tuple output
  unwraps to `Tuple<one>`, a tuple among many to its slot in the handle list. **Tuple/struct args**
  may be a `Tuple` handle, an `s.tuple(...)` result, or a plain literal object (the recorder builds
  the tuple from the object, members literal-or-`Expr`, omitted → 0). Amended by #2 — the previous
  "`tuple` → recording-time `EvsTypeError`" deferral is dropped.
- **Composite-element array outputs/args** (`tuple[]`, `T[][]`, `string[]`/`bytes[]`, added by the
  #2 follow-up): a `tuple[]` output decodes to a `readonly Struct[]` (an array of `Tuple` element
  handles — `out.at(i).field.get()`); `uint256[][]` → `readonly (readonly bigint[])[]`; `string[]` →
  `readonly string[]`. A `tuple[]` arg accepts an `Expr<tuple[]>` / an array handle / a
  `readonly Struct[]` literal (the recorder builds the array-of-pointers block — §5).
- Arg/output types still outside the surface (`T[N]`, two-level arrays of tuples `tuple[][]`, string
  arrays nested deeper than `[][]`) → recording-time `EvsTypeError('UNSUPPORTED_V0', …)` naming the
  parameter; these remain a follow-up (the vocabulary already represents them — §2).
- **Strict mode**: callee revert bubbles **verbatim** (Error/Panic/custom alike). Structural
  returndata decode failure reverts `EvsDecodeError(site)` — viem names it, `explainRevert`
  maps the site to your source line.
- **`tryCall`**: `success` is false on call failure **or** malformed returndata; `value` is
  then zeros / empty strings / empty arrays — always safe to use. (Divergence from Solidity
  try/catch, documented.)
- Dirty high bits in word outputs are **normalized**, not reverted (viem-lenient).

## 7. Control flow combinators

- `s.if(cond, then, otherwise?)` — `cond` is a plain value, evaluated once before the branch.
- `s.while(() => cond, (loop) => { ... })` — the condition is a **thunk**; its recorded ops
  land in the loop header and re-execute every iteration. Values recorded in the header are
  visible in the body; nothing recorded inside the loop is visible after it (use cells).
- `s.for({ type, from, until, step? }, (i, loop) => { ... })` — sugar over `while` + an internal
  cell, generic over any numeric word type. `until` and `step` are snapshot **once** before the
  loop (documented). Iterates while `i < until`; `step` defaults to 1; checked arithmetic
  applies.
- `s.select(cond, a, b)` — **eager both sides** (they are already-computed values). For
  conditional execution use `s.if` + a cell.
- `loop.break()` / `loop.continue()` — see §5.

## 8. User functions — `s.fn`

```ts
fn<const params extends readonly ArgSpec[], const r extends FnReturn>(
  name: string,
  params: params,
  body: (...args: { [i in keyof params]: Expr<params[i]['type']> }) => r,
): EvsFn<params, r>

export type FnReturn = Expr | readonly Expr[] | void
export type EvsFn<params extends readonly ArgSpec[], r extends FnReturn> =
  (...args: { [i in keyof params]: IntoExpr<params[i]['type']> }) => RebuildExprs<r>
// RebuildExprs: Expr<t> → fresh Expr<t>; tuples → fresh tuples; void → void
```

- The body runs **once at definition** in an isolated scope. Params may be any `EvsType`
  (memrefs pass as pointer words). **No capture** of outer Exprs/Cells (`EvsScopeError`).
- Calling the `EvsFn` records one statement and returns fresh handles; two calls never alias.
- Recursion is unconstructible (the handle does not exist inside its own body).
- Compiled as a JUMPDEST subroutine — code emitted once regardless of call count; uncalled fns
  are dropped.

## 9. `s.return`

```ts
declare const returnBrand: unique symbol
// a return value is an Expr OR a Tuple handle (ReturnValue = Expr | AnyTuple)
export interface ScriptReturn<ret extends Record<string, ReturnValue>> { readonly [returnBrand]: ret }

return<const ret extends Record<string, ReturnValue>>(values: ret): ScriptReturn<ret>
```

- Must be called exactly once, unconditionally (not inside `if`/`while`), as the value returned
  from the builder callback. Violations → `EvsScopeError`/`EvsTypeError` at recording.
- Record keys become the named components of the **single tuple output**; empty-string keys
  rejected. viem consumers receive an **object** (`{ token0: '0x…', symbol0: 'WETH', … }`).
- Each value is an `Expr`, or a `Tuple` handle **directly** (no `.expr()` — it flows out as a
  `'tuple'` component, abitype-typed; `tupleHandle.expr()` remains equivalent).
- `s.return` seals the recorder; any later builder call → `EvsScopeError(RECORDING_CLOSED)`.

## 10. `compile()` and the artifact

```ts
export function compile<s extends EvsScript>(script: s, options?: CompileOptions): CompiledOf<s>

export interface CompileOptions {
  evmVersion?: 'paris' | 'shanghai' | 'cancun'    // default 'cancun'
  peephole?: (nodes: readonly AsmNode[]) => AsmNode[]   // default identity (no optimizer in v0)
  onDiagnostic?: (d: EvsDiagnostic) => void       // warnings (e.g. LOOP_ALLOCATION); never logged
  locations?: boolean                             // default true
}

export interface CompiledEvsScript<name, args, ret> {
  readonly abi: ScriptAbi<name, args, ret>        // literal-typed: [function, EvsInvalidCalldata, EvsDecodeError]
  readonly runtimeBytecode: `0x${string}`         // ≤ 24,576 bytes (EIP-170), enforced
  readonly initBytecode: `0x${string}`            // 61RRRR80600A5F395FF3 ++ runtime (paris: 5F→3D)
  readonly sourceMap: SourceMap
  readonly ir: ScriptIr
  readonly options: Readonly<Required<CompileOptions>>
  toViem(): { abi: ScriptAbi<…>; code: `0x${string}` }                       // deployless (default)
  toViem(o: { mode: 'deployless' }): { abi: …; code: `0x${string}` }
  toViem(o: { mode: 'stateOverride'; address?: Address }): {
    abi: …; address: Address
    stateOverride: readonly [{ address: Address; code: `0x${string}` }]
  }
  disassemble(): Disassembly                      // .format() → annotated listing with source lines
  explainRevert(data: `0x${string}`): RevertExplanation
}
```

- **`toViem()` default = deployless** (`{ abi, code }` with `code` = init bytecode): plain
  2-param `eth_call`, works on every provider. Never pass `runtimeBytecode` to viem's `code` —
  it fails _silently_ (the artifact never exposes a field named `code`/`bytecode` for this
  reason). ⚠ In this mode `s.env('caller')` = viem's internal wrapper contract and
  `s.env('address')` = a per-script counterfactual CREATE2 address — neither controllable;
  see the §4 env warning.
- **`stateOverride` mode**: deterministic `address(this)` (default
  `0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`), controllable `msg.sender` via `account`,
  composable with extra overrides. Requires a provider supporting the 3rd `eth_call` param.
  This is the ONLY mode where `s.env('caller')`/`s.env('address')` are meaningful and
  controllable — caller-relative reads must use it.
- peer dependency: `viem >= 2.14.1`.

## 11. Examples

### E1 — Flagship: Uniswap V3 pool metadata in one round trip

```ts
import { evscript, t } from '@maxencerb/evs';
import { erc20Abi } from 'viem';
import { uniswapV3PoolAbi } from './abis'; // as const satisfies Abi

const poolMeta = evscript(
  { name: 'poolMeta', args: [t.address, t.address] }, // pool, user — positional
  (s, pool, user) => {
    const token0 = s.call({ address: pool, abi: uniswapV3PoolAbi, functionName: 'token0' });
    //    ^? Expr<'address'>
    const token1 = s.call({ address: pool, abi: uniswapV3PoolAbi, functionName: 'token1' });
    const slot0 = s.call({ address: pool, abi: uniswapV3PoolAbi, functionName: 'slot0' });
    //    ^? readonly [Expr<'uint160'>, Expr<'int24'>, …]
    const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' });
    //    ^? Expr<'string'>   — data flows BETWEEN calls; multicall cannot do this
    const symbol1 = s.call({ address: token1, abi: erc20Abi, functionName: 'symbol' });
    const dec = s.tryCall({ address: token0, abi: erc20Abi, functionName: 'decimals' });
    const decimals0 = s.select(dec.success, dec.value, 18); // default on failure
    const bal0 = s.call({
      address: token0,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [user],
    });
    return s.return({ token0, token1, symbol0, symbol1, tick: slot0[1], decimals0, bal0 });
  },
);

const compiled = poolMeta.compile();
const out = await client.readContract({
  ...compiled.toViem(), // { abi, code } — deployless
  functionName: 'poolMeta',
  args: [pool, user], // readonly [pool: `0x${string}`, user: `0x${string}`]
});
// out: { token0: `0x${string}`; token1: `0x${string}`; symbol0: string; symbol1: string;
//        tick: number; decimals0: number; bal0: bigint }
```

### E2 — Batch reads over a runtime `address[]` arg (multicall replacement)

```ts
const balances = evscript(
  { name: 'balances', args: [t.array(t.address), t.address] }, // tokens, owner
  (s, tokens, owner) => {
    const n = tokens.length();
    const out = s.newArray(t.uint256, n); // zero-filled uint256[n]
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      const token = tokens.at(i); // bounds-checked
      const r = s.tryCall({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
      out.set(i, s.select(r.success, r.value, 0n)); // non-token addresses → 0, no revert
    });
    return s.return({ balances: out.expr() });
  },
);

const res = await client.readContract({
  ...balances.compile().toViem(),
  functionName: 'balances',
  args: [[usdc, weth, dai], owner],
});
// res: { balances: readonly bigint[] }
```

### E3 — tryCall with a default (no boilerplate)

```ts
const tokenDecimals = evscript({ name: 'tokenDecimals', args: t.address }, (s, token) => {
  const d = s.tryCall({ address: token, abi: erc20Abi, functionName: 'decimals' });
  return s.return({ decimals: s.select(d.success, d.value, 18) });
});
```

### E4 — while loop + cells + break: first fee tier with a deployed pool

```ts
const firstPool = evscript(
  { name: 'firstPool', args: [t.address, t.address] }, // a, b
  (s, a, b) => {
    const fees = s.lit(t.array(t.uint24), [100n, 500n, 3000n, 10000n]); // data segment
    const found = s.let(t.address, '0x0000000000000000000000000000000000000000');
    const feeOut = s.let(t.uint24, 0n);
    const i = s.let(t.uint256, 0n);
    s.while(
      () => i.get().lt(fees.length()),
      (loop) => {
        const fee = fees.at(i.get());
        const pool = s.call({
          address: FACTORY,
          abi: uniswapV3FactoryAbi,
          functionName: 'getPool',
          args: [a, b, fee],
        });
        s.if(pool.neq('0x0000000000000000000000000000000000000000'), () => {
          found.set(pool);
          feeOut.set(fee);
          loop.break();
        });
        i.set(i.get().add(1n));
      },
    );
    return s.return({ pool: found.get(), fee: feeOut.get() });
  },
);
```

### E5 — `s.fn`: reusable typed subroutine

`arg()`/`ArgSpec` are RETAINED for `s.fn` param declarations (only the script-args surface
moved to positional callback params):

```ts
import { evscript, arg, t } from '@maxencerb/evs'; // `arg` is still needed for s.fn params

const portfolio = evscript(
  { name: 'portfolio', args: [t.address, t.array(t.address)] }, // owner, tokens
  (s, owner, tokens) => {
    const meta = s.fn('meta', [arg('token', t.address)] as const, (token) => {
      const bal = s.call({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      }); // ✗ EvsScopeError: no outer capture! (`owner` is an outer arg handle)
      return bal;
    });
    // correct version: pass everything as params
    const balOf = s.fn(
      'balOf',
      [arg('token', t.address), arg('who', t.address)] as const,
      (token, who) =>
        s.call({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    );
    const n = tokens.length();
    const out = s.newArray(t.uint256, n);
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      out.set(i, balOf(tokens.at(i), owner)); // fncall — fresh Expr per call
    });
    return s.return({ balances: out.expr() });
  },
);
```

(The first `meta` definition is shown to document the no-capture rule: touching the outer arg
handle `owner` inside an `s.fn` body throws `EvsScopeError` at recording, naming both locations.)

### E6 — Conditional logic with `s.if` + cells; checked math

```ts
const healthCheck = evscript(
  { name: 'healthCheck', args: [t.address, t.address] }, // vault, user
  (s, vault, user) => {
    const debt = s.call({
      address: vault,
      abi: vaultAbi,
      functionName: 'debtOf',
      args: [user],
    });
    const coll = s.call({
      address: vault,
      abi: vaultAbi,
      functionName: 'collateralOf',
      args: [user],
    });
    const ratioBps = s.let(t.uint256, 0n);
    s.if(
      debt.gt(0n),
      () => ratioBps.set(coll.mul(10_000n).div(debt)), // mul checked: Panic 0x11 on overflow
      () => ratioBps.set(s.lit(t.uint256, 2n ** 255n)), // "infinite" sentinel
    );
    const healthy = ratioBps.get().gte(15_000n);
    return s.return({ debt, coll, ratioBps: ratioBps.get(), healthy });
  },
);
```

### E6b — Composite types: struct output, field access, struct arg (added by #2)

```ts
import { evscript, t } from '@maxencerb/evs';
import { poolManagerAbi } from './abis'; // as const satisfies Abi — has slot0() -> (tuple) and
//                                          quote((address,address,uint24,uint256)) -> (uint256,tuple)

const composite = evscript(
  { name: 'composite', args: [t.address, t.address] }, // pool, tokenIn
  (s, pool, tokenIn) => {
    // a 'tuple' output decodes to a Tuple handle; `.field.get()` follows the flat-pointer block
    const slot0 = s.call({ address: pool, abi: poolManagerAbi, functionName: 'slot0Struct' });
    //    ^? Tuple<{ sqrtPriceX96: uint160; tick: int24; … }>
    const tick = slot0.tick.get(); // Expr<'int24'>

    // build a struct arg with s.tuple (omitted members default to zero) and pass it to a call
    const params = s.tuple(
      t.struct({ tokenIn: t.address, tokenOut: t.address, fee: t.uint24, amountIn: t.uint256 }),
      { tokenIn, fee: 3000n, amountIn: 1_000_000n }, // tokenOut omitted → zero address
    );
    const [amountOut, position] = s.call({
      address: pool,
      abi: poolManagerAbi,
      functionName: 'quote',
      args: [params], // a Tuple handle, an s.tuple(...) result, or a plain literal object
    });
    //    ^? [Expr<'uint256'>, Tuple<{ nonce; operator; liquidity; … }>]

    // a Tuple handle flows out of s.return DIRECTLY, abitype-typed (viem decodes it to a named
    // object); `position.expr()` is equivalent, for the bare memref Expr.
    return s.return({ tick, amountOut, position });
  },
);
// readContract returns { tick: number; amountOut: bigint; position: { nonce: bigint; … } }
```

A one-level array of composite/dynamic elements (added by the #2 follow-up) reads, constructs,
returns, and passes the same way — `tuple[]` outputs are `readonly Struct[]`, `.at(i)` yields a
typed `Tuple` element:

```ts nocheck
const positions = evscript(
  { name: 'positions', args: [t.address, t.array(t.uint256)] }, // manager, tokenIds
  (s, manager, tokenIds) => {
    // a tuple[] output decodes to an array of Tuple element handles (readonly Struct[] to viem)
    const all = s.call({
      address: manager,
      abi: managerAbi,
      functionName: 'positionsBatch',
      args: [tokenIds],
    });
    const first = all.at(0n); //   ^? Tuple<{ liquidity: uint128; tickLower: int24; … }>
    const liq = first.liquidity.get(); // Expr<'uint128'>

    // build a tuple[] / uint256[][] from JS literals OR with s.newArray + arrset (reference block)
    const echoed = s.newArray(t.struct({ a: t.uint256, b: t.uint256 }), 2n);
    echoed.set(0n, { a: 1n, b: 2n }); // a Tuple handle, s.tuple(...) result, or a literal object
    return s.return({ all: all.expr(), first, liq, echoed: echoed.expr() });
  },
);
// readContract returns { all: readonly {liquidity; tickLower; …}[]; first: {…}; liq: bigint; echoed: readonly {a; b}[] }
```

### E7 — State-override mode, block pinning, and `explainRevert`

```ts
const compiled = poolMeta.compile({ evmVersion: 'paris' }); // pre-Shanghai L2 target

// state-override: stable address(this), controllable msg.sender
const out = await client.readContract({
  ...compiled.toViem({ mode: 'stateOverride' }),
  functionName: 'poolMeta',
  args: [pool, user],
  blockNumber: 22_000_000n, // historical reads work — it is just eth_call
  account: someEoa, // msg.sender seen by the script
});

// when something reverts:
try {
  await client.readContract({ ...compiled.toViem(), functionName: 'poolMeta', args: [pool, user] });
} catch (e) {
  const revertData = extractRevertData(e); // from viem's ContractFunctionRevertedError
  console.log(compiled.explainRevert(revertData).message);
  // "decoding `symbol()` returndata failed (EvsDecodeError site 7) — recorded at pools.ts:9:18"
  console.log(compiled.disassemble().format()); // annotated listing, source lines per pc
}
```

## 12. What runs when (the one-page mental model)

| Runs at build time (TS)                                 | Runs on-chain (compiled)                     |
| ------------------------------------------------------- | -------------------------------------------- |
| the builder callback, exactly once                      | the recorded statements, in recorded order   |
| JS `if`/`for` over host values (unrolled/specialized)   | `s.if`/`s.while`/`s.for` over runtime values |
| literal validation & folding, ABI resolution, selectors | checked arithmetic, calls, decoding          |
| `s.fn` body (once, at definition)                       | the subroutine, once per recorded call       |
| loop-condition thunks: recorded once into the header    | the header, once per iteration               |

Everything that composes runtime values returns a branded `Expr`; everything that uses one in a
host position throws. Recording is the only sequencing primitive.
