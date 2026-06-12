# evs — User-Facing API Specification (binding)

Status: FINAL. Companion to `architecture.md` (mechanisms) and `module-interfaces.md` (module
law). Everything here is the public surface of `@maxencerb/evs`. TS floor: **≥ 5.5, strict
mode** (viem requires ≥ 5.0.4 strict). ESM only.

```ts
import { evscript, compile, arg, t } from '@maxencerb/evs';
```

## 1. `evscript` — entry point

```ts
export function evscript<
  const name extends string,
  const args extends readonly ArgSpec[],
  ret extends Record<string, Expr>,
>(
  def: { name: name; args: args },
  body: (s: ScriptBuilder<args>) => ScriptReturn<ret>,
  opts?: { locations?: boolean }, // default true: capture source locations
): EvsScript<name, args, ret>;

export interface EvsScript<
  name extends string = string,
  args extends readonly ArgSpec[] = readonly ArgSpec[],
  ret extends Record<string, Expr> = Record<string, Expr>,
> {
  readonly name: name;
  readonly ir: ScriptIr; // frozen, JSON-serializable
  readonly abi: ScriptAbi<name, args, ret>; // literal-typed value, exists pre-compile
  compile(options?: CompileOptions): CompiledEvsScript<name, args, ret>; // sugar for compile()
}
```

`const` type params mean inline `args` tuples and inline ABIs need no `as const`. Standalone
ABIs: declare `as const satisfies Abi`.

## 2. Args: `arg()` and the `t` type namespace (decision 1 — final)

```ts
export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name;
  readonly type: type;
}
export function arg<const name extends string, const type extends ArgType>(
  name: name,
  type: type,
): ArgSpec<name, type>;
// runtime: validates non-empty identifier name (/^[A-Za-z_]\w*$/) and known type string;
// throws EvsTypeError with the call-site loc; returns Object.freeze({ name, type }).

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
  array<const e extends WordType>(elem: e): `${e}[]`; // t.array(t.address) -> 'address[]'
};
```

Raw type strings are accepted everywhere `t.*` is (the `t` namespace is autocomplete sugar).

**Why ordered declarators (option c)**: a readonly tuple of `ArgSpec`s makes declaration order,
type-level order, runtime encode order, and ABI `inputs` order the same object — the
`UnionToTuple` reordering hazard (abitype research §4.2) cannot arise. `s.args` derives
tuple→record (safe direction). Call sites stay viem-native positional:
`args: [pool, fee]` typed as `readonly [pool: \`0x${string}\`, fee: number]`.

Argument types (`ArgType = EvsType`): word types, `string`, `bytes`, and `T[]` of word types
are all valid script args in v0. Fixed arrays `T[N]` and tuples are recording-time errors
(deferred).

## 3. Types, `Expr`, and literal coercion

```ts
export type WordType =
  | `uint${UintBits}`
  | `int${UintBits}`
  | 'address'
  | 'bool'
  | `bytes${BytesSize}`;
export type DynType = 'string' | 'bytes';
export type ArrayType = `${WordType}[]`;
export type EvsType = WordType | DynType | ArrayType;
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
  at<elem extends WordType>(this: Expr<`${elem}[]`>, i: IntoExpr<'uint256'>): Expr<elem>;
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
            : t extends `${infer e extends WordType}[]`
              ? readonly LitOf<e>[]
              : never;
export type IntoExpr<t extends EvsType> = Expr<t> | LitOf<t>;
```

Validated **at recording time** with the call-site loc (`EvsTypeError` on violation):

| Literal                     | Rule                                                      |
| --------------------------- | --------------------------------------------------------- |
| `number` for `uintN`/`intN` | must be a safe integer; range-checked against N           |
| `bigint` for `uintN`/`intN` | range-checked; negatives two's-complemented for `intN`    |
| `boolean`                   | only for `'bool'`                                         |
| `0x` string for `address`   | exactly 20 bytes; checksum NOT enforced (viem-permissive) |
| `0x` string for `bytesN`    | exactly N bytes                                           |
| `0x` string for `bytes`     | any even-length hex                                       |
| `string` for `'string'`     | UTF-8 encoded                                             |
| JS array for `T[]`          | element-wise rules of `T`                                 |

Word literals canonicalize at recording. Dynamic literals (and literal arrays) become bytecode
**data segments** materialized by CODECOPY on first use. Explicit constructor when inference
needs help: `s.lit<const t extends EvsType>(type: t, value: LitOf<t>): Expr<t>`.

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
export interface ScriptBuilder<args extends readonly ArgSpec[]> {
  readonly args: { readonly [a in args[number] as a['name']]: Expr<a['type']> }

  // values & state
  lit<const t extends EvsType>(type: t, value: LitOf<t>): Expr<t>
  let<const t extends EvsType>(type: t, init: IntoExpr<t>): Cell<t>
  let<t extends EvsType>(init: Expr<t>): Cell<t>
  newArray<const e extends WordType>(elem: e, length: IntoExpr<'uint256'>): MutArray<e>
  env<const k extends EnvKind>(kind: k): Expr<EnvTypeOf<k>>
  // EnvKind = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid'
  // address/caller → Expr<'address'>; others → Expr<'uint256'>

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
export interface MutArray<e extends WordType> {
  readonly elemType: e;
  readonly length: Expr<'uint256'>;
  set(i: IntoExpr<'uint256'>, v: IntoExpr<e>): void; // bounds-checked → Panic 0x32
  get(i: IntoExpr<'uint256'>): Expr<e>; // bounds-checked → Panic 0x32
  expr(): Expr<`${e}[]`>; // memref handle to the SAME buffer (later set() calls are visible
} //  through it — reference semantics, documented)
```

`s.newArray(elem, length)` allocates `[len][len × 32 bytes]`, **zero-filled**; runtime lengths
≥ 2^32 → Panic `0x41`. This is the building block for "loop over inputs, collect outputs" —
the multicall-replacement pattern (example E2).

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
// per-parameter union: literal (abitype Register-resolved primitive) OR Expr of that type
export type SubcallInputs<abi, name> = {
  readonly [i in keyof inputs]: AbiParameterToPrimitiveType<inputs[i], 'inputs'>
    | Expr<inputs[i]['type'] extends EvsType ? inputs[i]['type'] : never>
} // where inputs = ExtractAbiFunction<abi, name, ViewMutability>['inputs']

call<const abi extends Abi | readonly unknown[],
     name extends ContractFunctionName<abi, ViewMutability>>(
  p: SubcallParams<abi, name>,
): UnwrapSingle<SubcallOutputs<abi, name>>
// outputs []  → void;  [one] → Expr<one>;  [many] → readonly tuple of Exprs (mirrors viem)

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
- Output/arg types outside v0 (`tuple`, `T[N]`, nested arrays) → recording-time `EvsTypeError`
  naming the parameter and the deferral.
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
export interface ScriptReturn<ret extends Record<string, Expr>> { readonly [returnBrand]: ret }

return<const ret extends Record<string, Expr>>(values: ret): ScriptReturn<ret>
```

- Must be called exactly once, unconditionally (not inside `if`/`while`), as the value returned
  from the builder callback. Violations → `EvsScopeError`/`EvsTypeError` at recording.
- Record keys become the named components of the **single tuple output**; empty-string keys
  rejected. viem consumers receive an **object** (`{ token0: '0x…', symbol0: 'WETH', … }`).
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
  reason).
- **`stateOverride` mode**: deterministic `address(this)` (default
  `0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530`), controllable `msg.sender` via `account`,
  composable with extra overrides. Requires a provider supporting the 3rd `eth_call` param.
- peer dependency: `viem >= 2.14.1`.

## 11. Examples

### E1 — Flagship: Uniswap V3 pool metadata in one round trip

```ts
import { evscript, arg, t } from '@maxencerb/evs';
import { erc20Abi } from 'viem';
import { uniswapV3PoolAbi } from './abis'; // as const satisfies Abi

const poolMeta = evscript(
  { name: 'poolMeta', args: [arg('pool', t.address), arg('user', t.address)] },
  (s) => {
    const token0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token0' });
    //    ^? Expr<'address'>
    const token1 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token1' });
    const slot0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' });
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
      args: [s.args.user],
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
  { name: 'balances', args: [arg('tokens', t.array(t.address)), arg('owner', t.address)] },
  (s) => {
    const n = s.args.tokens.length();
    const out = s.newArray(t.uint256, n); // zero-filled uint256[n]
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      const token = s.args.tokens.at(i); // bounds-checked
      const r = s.tryCall({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [s.args.owner],
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
const tokenDecimals = evscript({ name: 'tokenDecimals', args: [arg('token', t.address)] }, (s) => {
  const d = s.tryCall({ address: s.args.token, abi: erc20Abi, functionName: 'decimals' });
  return s.return({ decimals: s.select(d.success, d.value, 18) });
});
```

### E4 — while loop + cells + break: first fee tier with a deployed pool

```ts
const firstPool = evscript(
  { name: 'firstPool', args: [arg('a', t.address), arg('b', t.address)] },
  (s) => {
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
          args: [s.args.a, s.args.b, fee],
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

```ts
const portfolio = evscript(
  { name: 'portfolio', args: [arg('owner', t.address), arg('tokens', t.array(t.address))] },
  (s) => {
    const meta = s.fn('meta', [arg('token', t.address)] as const, (token) => {
      const bal = s.call({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [s.args.owner],
      }); // ✗ EvsScopeError: no outer capture!
      return bal;
    });
    // correct version: pass everything as params
    const balOf = s.fn(
      'balOf',
      [arg('token', t.address), arg('who', t.address)] as const,
      (token, who) =>
        s.call({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    );
    const n = s.args.tokens.length();
    const out = s.newArray(t.uint256, n);
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      out.set(i, balOf(s.args.tokens.at(i), s.args.owner)); // fncall — fresh Expr per call
    });
    return s.return({ balances: out.expr() });
  },
);
```

(The first `meta` definition is shown to document the no-capture rule: touching `s.args.owner`
inside an `s.fn` body throws `EvsScopeError` at recording, naming both locations.)

### E6 — Conditional logic with `s.if` + cells; checked math

```ts
const healthCheck = evscript(
  { name: 'healthCheck', args: [arg('vault', t.address), arg('user', t.address)] },
  (s) => {
    const debt = s.call({
      address: s.args.vault,
      abi: vaultAbi,
      functionName: 'debtOf',
      args: [s.args.user],
    });
    const coll = s.call({
      address: s.args.vault,
      abi: vaultAbi,
      functionName: 'collateralOf',
      args: [s.args.user],
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
