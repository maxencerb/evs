# Type-level design for readContract-grade inference (abitype + viem)

Research date: 2026-06-11.
Verified against locally installed packages (all claims below were compile-tested with `tsc --strict`):

| Package      | Version verified                         | Notes                                                                                                                                   |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `abitype`    | **1.2.4** (npm latest as of 2026-06-11)  | viem's direct dependency                                                                                                                |
| `viem`       | **2.52.2** (npm latest as of 2026-06-11) | requires **TypeScript >= 5.0.4**, `strict: true` ([viem.sh/docs/typescript](https://viem.sh/docs/typescript))                           |
| `typescript` | **6.0.3** (npm latest)                   | `const` type params work unchanged; new: `tsc file.ts` errors with TS5112 if a `tsconfig.json` exists unless `--ignoreConfig` is passed |

viem treats _type_ enhancements as non-breaking patch releases — pin viem to an exact patch version in evs's test matrix ([viem.sh/docs/typescript](https://viem.sh/docs/typescript)).

---

## 1. abitype utilities to type `s.call` like `readContract`

All from the `abitype` package root export. Signatures below are copied verbatim (modulo formatting) from `abitype@1.2.4` `dist/types/abi.d.ts` and `dist/types/utils.d.ts`. Docs: [abitype.dev/api/utilities](https://abitype.dev/api/utilities), [abitype.dev/api/types](https://abitype.dev/api/types).

### Core data types (`abitype/dist/types/abi.d.ts`)

```ts
export type Address = ResolvedRegister['addressType']; // default `0x${string}`
export type AbiStateMutability = 'pure' | 'view' | 'nonpayable' | 'payable';
export type AbiParameterKind = 'inputs' | 'outputs';

// AbiType = every solidity type string: 'address' | 'bool' | `bytes${MBytes}` |
// 'function' | 'string' | 'tuple' | `${'u'|''}int${MBits}` | array forms `${T}[${n|''}]`
export type AbiType =
  | SolidityArray
  | SolidityAddress
  | SolidityBool
  | SolidityBytes
  | SolidityFunction
  | SolidityInt
  | SolidityString
  | SolidityTuple;

export type AbiParameter = Pretty<
  {
    type: ResolvedAbiType; // = AbiType when strictAbiType, else string
    name?: string | undefined;
    internalType?: AbiInternalType | undefined;
  } & (
    | { type: Exclude<ResolvedAbiType, SolidityTuple | SolidityArrayWithTuple> }
    | { type: SolidityTuple | SolidityArrayWithTuple; components: readonly AbiParameter[] }
  )
>;

export type AbiFunction = {
  type: 'function';
  inputs: readonly AbiParameter[];
  name: string;
  outputs: readonly AbiParameter[];
  stateMutability: AbiStateMutability;
  // deprecated optional: constant?, gas?, payable?
};

export type Abi = readonly (
  | AbiConstructor
  | AbiError
  | AbiEvent
  | AbiFallback
  | AbiFunction
  | AbiReceive
)[];
```

### Extraction utilities (`abitype/dist/types/utils.d.ts`)

```ts
export type ExtractAbiFunctions<
  abi extends Abi,
  abiStateMutability extends AbiStateMutability = AbiStateMutability,
> = Extract<abi[number], { type: 'function'; stateMutability: abiStateMutability }>;

export type ExtractAbiFunctionNames<
  abi extends Abi,
  abiStateMutability extends AbiStateMutability = AbiStateMutability,
> = ExtractAbiFunctions<abi, abiStateMutability>['name'];

export type ExtractAbiFunction<
  abi extends Abi,
  functionName extends ExtractAbiFunctionNames<abi>,
  abiStateMutability extends AbiStateMutability = AbiStateMutability,
> = Extract<ExtractAbiFunctions<abi, abiStateMutability>, { name: functionName }>;
```

Note: `ExtractAbiFunction`'s `functionName` is constrained by `ExtractAbiFunctionNames<abi>` **without** the mutability filter; mutability is a separate third parameter. If the same name exists with several overloads, `ExtractAbiFunction` returns a **union** of `AbiFunction`s (viem disambiguates by args — see `ExtractAbiFunctionForArgs` in section 2).

### Primitive-type conversion

```ts
export type AbiParameterToPrimitiveType<
  abiParameter extends AbiParameter | { name: string; type: unknown },
  abiParameterKind extends AbiParameterKind = AbiParameterKind,
> = ... // 'address' -> `0x${string}` ; 'uint256' -> bigint ; 'uint24'/'int24'/... (<=48 bits) -> number
       // 'tuple' + all components named -> { [name]: ... } object
       // 'tuple' + any unnamed component -> positional array
       // 'T[]' -> readonly T[] ; 'T[3]' -> 3-tuple

export type AbiParametersToPrimitiveTypes<
  abiParameters extends readonly AbiParameter[],
  abiParameterKind extends AbiParameterKind = AbiParameterKind,
  experimental_namedTuples extends boolean = ResolvedRegister['experimental_namedTuples'],
> = experimental_namedTuples extends true
  ? AbiParametersToPrimitiveTypes_named<abiParameters, abiParameterKind>   // labeled tuple
  : AbiParametersToPrimitiveTypes_mapped<abiParameters, abiParameterKind>  // plain tuple
```

Key facts:

- `abiParameterKind` exists because `bytesType` in the Register can differ between `inputs` and `outputs` (default both `0x${string}`). Always pass `'inputs'` when typing args and `'outputs'` when typing returns.
- **Third type param `experimental_namedTuples` (new in abitype 1.x line):** when `true`, the result is a _labeled_ tuple, e.g. `readonly [pool: \`0x${string}\`]` instead of `readonly [\`0x${string}\`]`. **viem 2.52.2 hardcodes `true`\*\* at every call site (it does not consult the user's Register).
- Labels come from a **finite generated lookup** `AbiParameterTupleNameLookup<type>` in `abitype/dist/types/generated.d.ts` (a 1523-line interface of common parameter names: `pool`, `token0`, `token1`, `symbol`, `decimals`, `fee`, `owner`, `amount`, ... each mapped to `[name: type]`). It `extends Record<string, [type]>`, so an unknown name (e.g. `symbol0`, which is _not_ in the list) falls back to an **unlabeled** element — the _type_ is always preserved, only the cosmetic label is lost. Verified: inputs `[{name:'zzNotInLookup',type:'uint256'},{name:'pool',type:'address'}]` produce `readonly [bigint, pool: \`0x${string}\`]`.
- The `_named` variant recursion processes parameters in chunks of up to 6 with a hard depth cap of 15 (`depth['length'] extends 15 ? readonly unknown[] : ...`), i.e. functions with roughly more than ~90 parameters degrade to `readonly unknown[]`. Irrelevant for evs in practice.

### The canonical `s.call` generic shape

```ts
import type { Abi, ExtractAbiFunction, ExtractAbiFunctionNames } from 'abitype'

declare function call<
  const abi extends Abi,
  name extends ExtractAbiFunctionNames<abi, 'view' | 'pure'>,
>(parameters: {
  abi: abi
  // the union keeps IDE autocomplete alive even before `name` is fixed:
  functionName: name | ExtractAbiFunctionNames<abi, 'view' | 'pure'>
  ...
}): ... // built from ExtractAbiFunction<abi, name, 'view' | 'pure'>['outputs']
```

`const abi` (TS 5.0 const type parameter) means callers can pass an inline ABI array literal **without** `as const` and still get literal inference. A non-inline ABI still needs `as const` at its declaration site (best paired with `satisfies Abi`, see gotchas).

---

## 2. How viem 2.52.2 types `readContract`

Source files (verified locally in `viem/_types/`, upstream at
[github.com/wevm/viem/blob/main/src/types/contract.ts](https://github.com/wevm/viem/blob/main/src/types/contract.ts) and
[github.com/wevm/viem/blob/main/src/actions/public/readContract.ts](https://github.com/wevm/viem/blob/main/src/actions/public/readContract.ts)).

### The action signature

```ts
export declare function readContract<
  chain extends Chain | undefined,
  const abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi, 'pure' | 'view'>,
  const args extends ContractFunctionArgs<abi, 'pure' | 'view', functionName>,
>(
  client: Client<Transport, chain>,
  parameters: ReadContractParameters<abi, functionName, args>,
): Promise<ReadContractReturnType<abi, functionName, args>>;
```

Both `abi` **and** `args` use `const` type parameters. `args` being a generic (not just `ContractFunctionArgs<...>` inline) is what lets viem disambiguate overloaded functions by the literal args provided.

### The four load-bearing types (verbatim from `viem@2.52.2 _types/types/contract.d.ts`)

```ts
export type ContractFunctionName<
  abi extends Abi | readonly unknown[] = Abi,
  mutability extends AbiStateMutability = AbiStateMutability,
> =
  ExtractAbiFunctionNames<
    abi extends Abi ? abi : Abi,
    mutability
  > extends infer functionName extends string
    ? [functionName] extends [never]
      ? string
      : functionName
    : string;

export type ContractFunctionArgs<
  abi extends Abi | readonly unknown[] = Abi,
  mutability extends AbiStateMutability = AbiStateMutability,
  functionName extends ContractFunctionName<abi, mutability> = ContractFunctionName<
    abi,
    mutability
  >,
> =
  AbiParametersToPrimitiveTypes<
    ExtractAbiFunction<abi extends Abi ? abi : Abi, functionName, mutability>['inputs'],
    'inputs',
    true // <-- named tuple labels, hardcoded
  > extends infer args
    ? [args] extends [never]
      ? readonly unknown[]
      : args
    : readonly unknown[];

export type ContractFunctionParameters<
  abi extends Abi | readonly unknown[] = Abi,
  mutability extends AbiStateMutability = AbiStateMutability,
  functionName extends ContractFunctionName<abi, mutability> = ContractFunctionName<
    abi,
    mutability
  >,
  args extends ContractFunctionArgs<abi, mutability, functionName> = ContractFunctionArgs<
    abi,
    mutability,
    functionName
  >,
  deployless extends boolean = false,
  allFunctionNames = ContractFunctionName<abi, mutability>,
  allArgs = ContractFunctionArgs<abi, mutability, functionName>,
  abiFunction = ExtractAbiFunction<abi extends Abi ? abi : Abi, functionName, mutability>,
> = {
  abi: abi;
  functionName: allFunctionNames | (functionName extends allFunctionNames ? functionName : never);
} & (readonly [] extends allArgs
  ? {
      args?:
        | allArgs
        | (abi extends Abi
            ? Abi extends abi
              ? never
              : UnionWiden<IsUnion<abiFunction> extends true ? args : allArgs>
            : never)
        | undefined;
    }
  : { args: IsUnion<abiFunction> extends true ? args : allArgs }) &
  (deployless extends true
    ? { address?: undefined; code: Hex } // "deployless" call: bytecode instead of address
    : { address: Address });

export type ContractFunctionReturnType<
  abi extends Abi | readonly unknown[] = Abi,
  mutability extends AbiStateMutability = AbiStateMutability,
  functionName extends ContractFunctionName<abi, mutability> = ContractFunctionName<
    abi,
    mutability
  >,
  args extends ContractFunctionArgs<abi, mutability, functionName> = ContractFunctionArgs<
    abi,
    mutability,
    functionName
  >,
> = abi extends Abi
  ? Abi extends abi
    ? unknown // unparameterized Abi -> permissive
    : AbiParametersToPrimitiveTypes<
          ExtractAbiFunctionForArgs<abi, mutability, functionName, args>['outputs'],
          'outputs',
          true
        > extends infer types
      ? types extends readonly []
        ? void // no outputs -> void
        : types extends readonly [infer type]
          ? type // SINGLE output -> UNWRAPPED
          : types // multiple outputs -> (labeled) tuple
      : never
  : unknown;
```

And the action-level wrappers (`_types/actions/public/readContract.d.ts`):

```ts
export type ReadContractParameters<abi, functionName, args> = UnionEvaluate<
  Pick<
    CallParameters,
    | 'account'
    | 'authorizationList'
    | 'blockHash'
    | 'blockNumber'
    | 'blockOverrides'
    | 'blockTag'
    | 'factory'
    | 'factoryData'
    | 'requireCanonical'
    | 'stateOverride'
  >
> &
  ContractFunctionParameters<abi, 'pure' | 'view', functionName, args, boolean>;
//                                                                   ^^^^^^^
// deployless = boolean -> the union {address: Address} | {address?: undefined; code: Hex}
// i.e. readContract natively supports viem "deployless" calls via `code`,
// and stateOverride is available for the set-code-at-address strategy.

export type ReadContractReturnType<abi, functionName, args> = ContractFunctionReturnType<
  abi,
  'pure' | 'view',
  functionName,
  args
>;
```

Compile-verified: `{ abi, functionName, args, code: '0x...' }` and `{ abi, functionName, args, address, stateOverride: [{address, code}] }` both type-check as `ReadContractParameters`; omitting both `address` and `code` is a type error. **Both evs execution strategies (deployless + state override) are already first-class typed in `readContract`.** Caveat: `Pick<ReadContractParameters<...>, 'code'>` fails — `ContractFunctionParameters` is a _union_ (address vs code branch) and `keyof` of a union only yields common keys.

### Recurring viem patterns worth mirroring in evs

1. **Graceful widening, never hard failure**: every generic is `abi extends Abi | readonly unknown[]`, then inside: `abi extends Abi ? (Abi extends abi ? <permissive> : <inferred>) : <permissive>`. The inner `Abi extends abi` test ("is this just the unparameterized `Abi` type?") is viem's `IsNarrowable<abi, Abi>` trick. A user passing a non-`as const` ABI gets `functionName: string`, `args: readonly unknown[]`, return `unknown` — not an error.
2. **`[x] extends [never]` guards** after every `Extract`, falling back to permissive types.
3. **Overload disambiguation**: `ExtractAbiFunctionForArgs<abi, mutability, functionName, args>` — if `ExtractAbiFunction` produced a union (overloads), `UnionToTuple` it and keep the member whose `AbiParametersToPrimitiveTypes<inputs,'inputs',true>` accepts `args` (`CheckArgs`). evs can skip this initially (reject overloaded names) but the pattern is there to copy.
4. **`Widen` / `UnionWiden`**: maps literal arg types back to their canonical primitive (e.g. `'0xabc...'` -> `\`0x${string}\``, `5n`->`bigint`, `5`->`number`) so that optional-args unions don't over-narrow. Useful for evs when an arg can be `Expr<T> | literal`.

---

## 3. Type-level literal-ABI construction for the evs builder

Goal: from `evscript({ name: 'poolMeta', args: { pool: 'address' } }, s => ... s.return({ token0, symbol0, tick }))` produce the precise type

```ts
readonly [{
  readonly type: 'function'
  readonly name: 'poolMeta'
  readonly stateMutability: 'view'
  readonly inputs: readonly [{ readonly name: 'pool'; readonly type: 'address' }]
  readonly outputs: readonly [{
    readonly name: 'result'
    readonly type: 'tuple'
    readonly components: readonly [
      { readonly name: 'token0'; readonly type: 'address' },
      { readonly name: 'symbol0'; readonly type: 'string' },
      ...
    ]
  }]
}]
```

**Design decision (important, justified in section 4.2): emit the return record as ONE output of type `'tuple'` with named `components`** — viem then unwraps the single output and (all components being named) infers an **object** `{ token0: \`0x${string}\`; symbol0: string }`, which is immune to type-level key-ordering instability. Do NOT emit one output per record key.

### Full worked snippet — compiles clean under `tsc --strict` with abitype@1.2.4, viem@2.52.2, TS 6.0.3

```ts
import type {
  Abi,
  AbiParameter,
  AbiParameterToPrimitiveType,
  AbiType,
  Address,
  ExtractAbiFunction,
  ExtractAbiFunctionNames,
} from 'abitype';
import type { ReadContractReturnType, ReadContractParameters } from 'viem';

// ---------------------------------------------------------------------------
// Expr<T>: branded handle produced by the builder
// ---------------------------------------------------------------------------
declare const exprBrand: unique symbol;
export interface Expr<t extends AbiType = AbiType> {
  readonly [exprBrand]: t;
}

// ---------------------------------------------------------------------------
// s.call — readContract-shaped; each arg accepts primitive OR Expr handle
// ---------------------------------------------------------------------------
type CallInput<param extends AbiParameter> =
  | AbiParameterToPrimitiveType<param, 'inputs'>
  | Expr<param['type'] extends AbiType ? param['type'] : never>;

type CallInputs<params extends readonly AbiParameter[]> = {
  readonly [k in keyof params]: CallInput<params[k]>;
};

type CallOutputs<params extends readonly AbiParameter[]> = {
  readonly [k in keyof params]: Expr<params[k]['type'] extends AbiType ? params[k]['type'] : never>;
};

// mirror viem's single-output unwrapping for the Expr results of s.call
type UnwrapSingle<outs> = outs extends readonly []
  ? void
  : outs extends readonly [infer only]
    ? only
    : outs;

type ViewMutability = 'pure' | 'view';

export interface CallParameters<
  abi extends Abi,
  name extends ExtractAbiFunctionNames<abi, ViewMutability>,
  fn extends ExtractAbiFunction<abi, name, ViewMutability> = ExtractAbiFunction<
    abi,
    name,
    ViewMutability
  >,
> {
  address: Address | Expr<'address'>;
  abi: abi;
  functionName: name | ExtractAbiFunctionNames<abi, ViewMutability>;
  args?: CallInputs<fn['inputs']>;
  // production version: mirror viem —
  //   readonly [] extends CallInputs<fn['inputs']> ? { args?: ... } : { args: ... }
}

export interface ScriptBuilder<argsSpec extends Record<string, AbiType>> {
  readonly args: { readonly [k in keyof argsSpec]: Expr<argsSpec[k]> };

  call<const abi extends Abi, name extends ExtractAbiFunctionNames<abi, ViewMutability>>(
    parameters: CallParameters<abi, name>,
  ): UnwrapSingle<CallOutputs<ExtractAbiFunction<abi, name, ViewMutability>['outputs']>>;

  return<const r extends Record<string, Expr>>(values: r): ScriptReturn<r>;
}

declare const returnBrand: unique symbol;
export interface ScriptReturn<r extends Record<string, Expr>> {
  readonly [returnBrand]: r;
}

// ---------------------------------------------------------------------------
// Literal-ABI construction
// ---------------------------------------------------------------------------
// UnionToTuple — same trick viem uses internally (src/types/utils.ts)
type UnionToIntersection<u> = (u extends unknown ? (x: u) => void : never) extends (
  x: infer i,
) => void
  ? i
  : never;
type LastOf<u> =
  UnionToIntersection<u extends unknown ? () => u : never> extends () => infer last ? last : never;
type UnionToTuple<u, last = LastOf<u>> = [u] extends [never]
  ? []
  : [...UnionToTuple<Exclude<u, last>>, last];

// {pool:'address'} -> readonly [{name:'pool', type:'address'}]
// WARNING: tuple ORDER is not guaranteed to match declaration order — see 4.2
type SpecToAbiParameters<
  spec extends Record<string, AbiType>,
  keys extends readonly unknown[] = UnionToTuple<keyof spec>,
> = {
  readonly [i in keyof keys]: {
    readonly name: keys[i] & string;
    readonly type: spec[keys[i] & keyof spec];
  };
};

// {token0: Expr<'address'>} -> {token0: 'address'}
type ReturnSpecToTypeSpec<r extends Record<string, Expr>> = {
  [k in keyof r]: r[k] extends Expr<infer t> ? t : never;
};

export type ScriptAbi<
  name extends string,
  argsSpec extends Record<string, AbiType>,
  returnSpec extends Record<string, Expr>,
> = readonly [
  {
    readonly type: 'function';
    readonly name: name;
    readonly stateMutability: 'view';
    readonly inputs: SpecToAbiParameters<argsSpec>;
    readonly outputs: readonly [
      {
        readonly name: 'result';
        readonly type: 'tuple';
        readonly components: SpecToAbiParameters<ReturnSpecToTypeSpec<returnSpec>>;
      },
    ];
  },
];

export interface CompiledScript<
  name extends string,
  argsSpec extends Record<string, AbiType>,
  returnSpec extends Record<string, Expr>,
> {
  readonly abi: ScriptAbi<name, argsSpec, returnSpec>;
  readonly bytecode: `0x${string}`;
  readonly name: name;
}

// const type params capture 'poolMeta' / 'address' literals WITHOUT `as const`
export declare function evscript<
  const name extends string,
  const argsSpec extends Record<string, AbiType>,
  returnSpec extends Record<string, Expr>,
>(
  options: { name: name; args: argsSpec },
  body: (s: ScriptBuilder<argsSpec>) => ScriptReturn<returnSpec>,
): CompiledScript<name, argsSpec, returnSpec>;
```

### Usage (every assertion below was compile-verified)

```ts
const uniswapV3PoolAbi = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
    ],
  },
] as const;

const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const script = evscript({ name: 'poolMeta', args: { pool: 'address' } }, (s) => {
  const token0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'token0' });
  //    ^? Expr<'address'>                                  (single output unwrapped)
  const slot0 = s.call({ address: s.args.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' });
  //    ^? readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'uint16'>]
  const symbol0 = s.call({ address: token0, abi: erc20Abi, functionName: 'symbol' });
  //    ^? Expr<'string'>          (Expr<'address'> accepted in address position)
  const bal = s.call({ address: token0, abi: erc20Abi, functionName: 'balanceOf', args: [token0] }); // Expr arg OK
  const bal2 = s.call({
    address: token0,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: ['0x00000000000000000000000000000000000000002'],
  }); // literal arg OK
  // s.call({ ..., functionName: 'balanceOf', args: [bal] })   // error: Expr<'uint256'> ≠ address
  // s.call({ ..., functionName: 'transfer' })                 // error: not a view/pure fn
  return s.return({ token0, symbol0, tick: slot0[1] });
});

type GeneratedAbi = typeof script.abi;
// inputs is exactly: readonly [{ readonly name: 'pool'; readonly type: 'address' }]
// functionName 'poolMeta', stateMutability 'view' — all literal.

// viem inference over the generated ABI:
type Result = ReadContractReturnType<GeneratedAbi, 'poolMeta'>;
//   ^? { token0: `0x${string}`; symbol0: string; tick: number }     // int24 -> number!
type Params = ReadContractParameters<GeneratedAbi, 'poolMeta'>;
//   Params['args'] = readonly [pool: `0x${string}`]                 // labeled tuple
//   Params['functionName'] = 'poolMeta'
```

Note `tick: number` — abitype maps `int<M>`/`uint<M>` with `M <= 48` to `number` and `M > 48` to `bigint` by default (configurable via Register, section 4.4).

---

## 4. Gotchas

### 4.1 `const` type parameters (TS 5.0+)

Docs: [typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#const-type-parameters](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#const-type-parameters). Still works identically on TS 6.0.3 (verified).

- `const abi extends Abi` on `evscript` / `s.call` gives `as const`-quality inference **only for literal expressions written at the call site**. If the user binds the ABI to a `const x = [...]` variable first _without_ `as const`, the literal types are already widened before inference — `const` on the type parameter cannot undo that. Document this; recommend `as const satisfies Abi` for standalone ABIs (validates shape AND keeps literals, no widening).
- viem itself declares `const abi` and `const args` on `readContract` (verified in 2.52.2 d.ts), so inline ABIs need no `as const` there either.
- `const` type params require the constraint to be compatible with readonly types: constrain with `extends Abi` (`Abi` is already `readonly ...[]`) or `Record<string, AbiType>` — do not constrain with mutable array types or const inference silently degrades.

### 4.2 Union order is NOT declaration order — the record→tuple trap (demonstrated)

Converting `Record<string, AbiType>` to an ordered tuple via `UnionToTuple<keyof spec>` is **order-unstable**. TypeScript orders union members by internal type IDs (interning/creation order across the whole program), not by property declaration order. Concretely reproduced during this research: for `s.return({ token0, symbol0, tick })`, the generated components tuple came out as `[tick, token0, symbol0]` — because the string literal type `'tick'` had already been interned earlier in the file (it appears as an output name inside `uniswapV3PoolAbi`). Adding/removing an unrelated ABI elsewhere in the file can silently reorder the tuple.

Consequences and the mitigation matrix:

| Surface                                                                            | Positional at runtime?                                                                | Order-sensitive in types?                                                                          | Verdict                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Outputs as ONE named `tuple`** (recommended)                                     | yes (component encode order = runtime `Object.keys(returnRecord)`, insertion-ordered) | **no** — viem produces an _object_ keyed by component names; TS object types are order-insensitive | SAFE. Type-level component order may differ from runtime order; harmless because decoding uses the runtime ABI array and the result type is an object. |
| **Inputs as positional params from a record**                                      | yes                                                                                   | **yes** — `args` is a positional tuple typed from the type-level inputs order                      | UNSAFE with >1 input of compatible types: type-level order can diverge from runtime encode order with no compile error. Fine for 0–1 inputs.           |
| **Inputs as ONE named `tuple` param**                                              | components positional                                                                 | no — viem types `args` as `readonly [params: { pool: ..., fee: ... }]` (verified)                  | SAFE; user passes one object.                                                                                                                          |
| **Inputs as an entries tuple spec** `args: [['pool','address'], ['fee','uint24']]` | yes                                                                                   | no — tuple spec preserves order by construction                                                    | SAFE; positional call-site ergonomics preserved.                                                                                                       |

Compile-verified entries-spec converter:

```ts
type ParamEntry = readonly [name: string, type: AbiType];
type EntriesToAbiParameters<entries extends readonly ParamEntry[]> = {
  readonly [i in keyof entries]: { readonly name: entries[i][0]; readonly type: entries[i][1] };
};
// evscript({ name: 'multi', args: [['pool', 'address'], ['fee', 'uint24']] }, ...)
// -> inputs: readonly [{name:'pool',type:'address'}, {name:'fee',type:'uint24'}]  (order kept)
```

Recommendation for evs: keep the record API for `s.return` (single tuple output ⇒ immune); for script _args_ either restrict the record API to scripts where order divergence is detectable, or use the entries-tuple / single-tuple-input form for multi-arg scripts. At minimum, ship a CI type-test (vitest `expectTypeOf` / `assertType`) asserting `ReadContractParameters<abi, name>['args']` for representative scripts, and make the runtime compiler derive encode order from `Object.keys()` (insertion order — guaranteed for string keys by ECMA-262).

### 4.3 Named vs unnamed outputs — exactly how viem shapes the return type

From `ContractFunctionReturnType` (section 2) + abitype's `AbiComponentsToPrimitiveType`:

1. `outputs: []` → `void`.
2. **Exactly one output → unwrapped** (the `types extends readonly [infer type] ? type` branch): `outputs: [{type:'address'}]` → `\`0x${string}\``, named or not.
3. **Multiple outputs → a positional (labeled) TUPLE, never an object.** Verified: Uniswap `slot0` → `readonly [sqrtPriceX96: bigint, tick: number, observationIndex: number]`. Labels are cosmetic (from the finite `AbiParameterTupleNameLookup`); access is by index.
4. **A single output of type `'tuple'`** → unwrapped, then abitype converts components: if **every** component has a non-empty `name`, the result is an **object** `{ [name]: type }`; if **any** component has `name: ''` or no name, the whole thing degrades to a positional array. The exact abitype check (utils.d.ts):
   ```ts
   components[number]['name'] extends Exclude<components[number]['name'] & string, undefined | ''>
     ? { [component in components[number] as component['name'] & {}]: ... }   // object
     : { [key in keyof components]: ... }                                     // positional
   ```
   Verified: one component named `''` among named ones → `readonly [\`0x${string}\`, string]` instead of an object. **The evs compiler must therefore guarantee every emitted component has a non-empty name** (the builder's record keys give this for free, but guard against empty-string keys at runtime/type level).
5. Tuple labels on args/returns: viem passes `true` for `experimental_namedTuples` everywhere; the user's Register `experimental_namedTuples` setting is ignored by viem.

### 4.4 abitype Register (module augmentation)

Docs: [abitype.dev/config](https://abitype.dev/config). Mechanism: declaration merging on the **empty** `Register` interface; `ResolvedRegister` reads it with `Register extends { addressType: infer type } ? type : Default...` (also accepts deprecated PascalCase keys `AddressType` etc.).

```ts
// e.g. in the consumer's types.d.ts
declare module 'abitype' {
  export interface Register {
    addressType: `0x${string}`; // default `0x${string}`
    bigIntType: bigint; // int/uint with M > 48; default bigint
    intType: number; // int/uint with M <= 48; default number
    bytesType: { inputs: `0x${string}`; outputs: `0x${string}` }; // defaults shown
    arrayMaxDepth: false; // default false (= unbounded via `${T}[${string}]` template)
    fixedArrayMinLength: 1; // default 1
    fixedArrayMaxLength: 99; // default 99
    strictAbiType: false; // default false; true validates AbiParameter['type'] against AbiType
    experimental_namedTuples: false; // default false (viem overrides to true internally)
  }
}
```

- Because viem depends on `abitype` as a regular (hoisted) dependency, `declare module 'abitype'` affects viem too **as long as exactly one abitype copy resolves**. With a nested copy you'd have to augment `'viem/node_modules/abitype'` — avoid this by making evs declare `abitype` as a **peer-or-aligned direct dependency** matching viem's range (viem 2.52.2 depends on abitype ^1.x).
- viem also exports its own `Register`/`ResolvedRegister` from `viem` (verified in `viem/_types/types/register.d.ts`) but that one only carries `CapabilitiesSchema` (EIP-5792) — it is NOT the abitype register. Don't confuse them.
- evs should consume `Address = ResolvedRegister['addressType']` and `AbiParameterToPrimitiveType` rather than hardcoding `\`0x${string}\``/`bigint`, so user Register config flows through evs exactly as it does through viem.
- `strictAbiType: true` makes `AbiParameter['type']` be the closed `AbiType` union instead of `string` — significantly slower compile; abitype's own JSDoc says only enable for debugging.

### 4.5 Depth limits & performance

- Non-tail-recursive conditional types (like `UnionToTuple`, which builds `[...rec, last]`) hit TS's instantiation-depth ceiling around ~50 recursions → fine for ABI-sized records (< 50 keys), but don't reuse `UnionToTuple` for big unions. Tail-recursive conditional types get up to ~1000 iterations since TS 4.5 ([typescriptlang.org/docs/handbook/release-notes/typescript-4-5.html#tail-recursion-elimination-on-conditional-types](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-5.html#tail-recursion-elimination-on-conditional-types)). Error signature to watch in CI: `TS2589: Type instantiation is excessively deep and possibly infinite`.
- abitype's own guards: `AbiParametersToPrimitiveTypes_named` caps at depth 15 × 6 params/iteration (≈90 params) then yields `readonly unknown[]`; `arrayMaxDepth: false` avoids recursion entirely by matching `\`${T}[${string}]\``.
- abitype maps `'tuple'` _without_ `components` to `Record<string, unknown>`, and unknown type strings to `unknown` (non-strict mode) — useful fallbacks to mirror in `Expr` typing.
- Keep `ScriptAbi` built from **interfaces/aliases over the generic params** (lazy) rather than eagerly `Pretty`-flattening; only flatten leaf objects shown to users.

### 4.6 Variance & misc

- Brand `Expr` with a `unique symbol` property (`readonly [exprBrand]: t`). A plain `{ __type: t }` brand makes `Expr<'address'>` assignable from structurally-similar user objects and makes `Expr<AbiType>` accept any subtype where you want exactness; the symbol keeps it nominal. Note `Expr<'uint256'>` IS assignable to `Expr<AbiType>` (covariant via the readonly property) — that's desirable for `Record<string, Expr>` constraints.
- `keyof (union)` only yields common keys: `Pick<ReadContractParameters<...>, 'code'>` fails even though `code` is accepted, because the address/code branches form a union (verified). When deriving helper types from viem params, use `Extract`/distributive conditionals, not `Pick`.
- `functionName: name | ExtractAbiFunctionNames<abi, 'view' | 'pure'>` (viem's `allFunctionNames` union) is what keeps autocomplete working before TS fixes `name`; with only the bare generic, the IDE shows no suggestions.
- Mutability filter at the _name_ level (`ExtractAbiFunctionNames<abi, 'view' | 'pure'>`) makes nonpayable/payable functions a compile error in `s.call` (verified via `@ts-expect-error`).
- For args that may be `Expr<T> | literal`: the union must be per-parameter (`CallInput<param>`), not over the whole tuple, or mixing `['0x..', expr]` fails. Mapped tuple `{ readonly [k in keyof params]: CallInput<params[k]> }` preserves tuple-ness and labels.
- TS 6.0.x CLI change: passing a file to `tsc` alongside an existing `tsconfig.json` now errors (TS5112) unless `--ignoreConfig` is given — relevant for evs CI scripts.

---

## Sources

- abitype utilities & types: https://abitype.dev/api/utilities , https://abitype.dev/api/types
- abitype config (Register): https://abitype.dev/config
- abitype source of truth verified locally: `abitype@1.2.4` `dist/types/{abi,utils,register,generated}.d.ts` (https://github.com/wevm/abitype)
- viem contract types: https://github.com/wevm/viem/blob/main/src/types/contract.ts (verified against `viem@2.52.2` `_types/types/contract.d.ts`)
- viem readContract: https://github.com/wevm/viem/blob/main/src/actions/public/readContract.ts , https://viem.sh/docs/contract/readContract
- viem TypeScript requirements & ABIType integration: https://viem.sh/docs/typescript
- TS 5.0 const type parameters: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#const-type-parameters
- TS 4.5 tail-recursive conditional types: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-5.html#tail-recursion-elimination-on-conditional-types
