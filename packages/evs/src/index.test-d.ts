/**
 * Types named by public signatures are importable from the entry point (the exports map blocks
 * deep imports). Pins the helper types a public declaration mentions — `ScriptAbi['inputs']`,
 * the `EvsFn`/`ArgHandles` label default, the `s.forEach`/`.at` tuple-array bound,
 * `ReturnSpecToComponents`, `RevertExplanation`/`SourceMap` site ids, `AsmNode['op']`,
 * `Disassembly['lines']`, `ToViemMode`, `InterpOptions` / `InterpValues`, the shared call-verb
 * shapes behind `ReadVerb` & co — so dropping one from `index.ts` fails here. The IR node types
 * behind `ScriptIr` are deliberately not exported (the IR schema is not a stable API). Typecheck
 * only.
 */
import type { Address as ViemAddress } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import type {
  Address,
  AbiParameterSignature,
  AbiParametersSignature,
  ArgName,
  ArgsToInputs,
  CallVerb,
  CallVerbOf,
  DisasmLine,
  Disassembly,
  InterpOptions,
  InterpValues,
  LabelCarrier,
  Mnemonic,
  ResolveArgName,
  SignatureName,
  SiteId,
  SubcallVerbOf,
  ToArgSpec,
  ToViemMode,
  Tried,
  TryCallVerb,
  TryReadVerb,
  TupleArrayTag,
  TypeOfReturn,
  Expr,
  ViewMutability,
} from './index.js';

test('public-signature helper types are exported by name', () => {
  expectTypeOf<SignatureName<'get(uint256)'>>().toEqualTypeOf<'get'>();
  expectTypeOf<
    AbiParameterSignature<{
      readonly name: 'p';
      readonly type: 'tuple[]';
      readonly components: readonly [{ readonly name: 'a'; readonly type: 'uint256' }];
    }>
  >().toEqualTypeOf<'(uint256)[]'>();
  expectTypeOf<
    AbiParametersSignature<readonly [{ readonly type: 'uint256' }, { readonly type: 'address' }]>
  >().toEqualTypeOf<'uint256,address'>();
  expectTypeOf<'tuple[2]'>().toMatchTypeOf<TupleArrayTag>();
  expectTypeOf<TypeOfReturn<Expr<'uint256'>>>().toEqualTypeOf<'uint256'>();
  expectTypeOf<Disassembly['lines'][number]>().toEqualTypeOf<DisasmLine>();
  expectTypeOf<'PUSH1'>().toMatchTypeOf<Mnemonic>();
  expectTypeOf<SiteId>().toEqualTypeOf<number>();
  // the args helpers are nameable
  expectTypeOf<ArgName<'0'>>().toEqualTypeOf<'arg0'>();
  expectTypeOf<ResolveArgName<'', '1'>>().toEqualTypeOf<'arg1'>();
  expectTypeOf<ResolveArgName<'who', '1'>>().toEqualTypeOf<'who'>();
  expectTypeOf<ToArgSpec<'uint256'>['type']>().toEqualTypeOf<'uint256'>();
  expectTypeOf<ArgsToInputs<readonly []>>().toEqualTypeOf<readonly []>();
  expectTypeOf<LabelCarrier<readonly []>>().toEqualTypeOf<readonly []>();
  // interpret()'s options and the values type of its script overload
  expectTypeOf<InterpOptions['maxSteps']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<
    InterpValues<
      readonly [
        {
          readonly type: 'function';
          readonly name: 'f';
          readonly stateMutability: 'view';
          readonly inputs: readonly [];
          readonly outputs: readonly [
            {
              readonly name: 'result';
              readonly type: 'tuple';
              readonly components: readonly [{ readonly name: 'y'; readonly type: 'uint256' }];
            },
          ];
        },
      ]
    >
  >().toEqualTypeOf<{ y: bigint }>();
  // the run-time mode accepted by toViem()'s catch-all overload
  expectTypeOf<ToViemMode>().toEqualTypeOf<'deployless' | 'stateOverride'>();
  // the verb types are aliases of the shared strict/try shapes
  expectTypeOf<TryReadVerb>().toEqualTypeOf<SubcallVerbOf<ViewMutability, true>>();
  expectTypeOf<CallVerb>().toEqualTypeOf<CallVerbOf<false>>();
  expectTypeOf<TryCallVerb>().toEqualTypeOf<CallVerbOf<true>>();
  expectTypeOf<Tried<true, Expr<'uint8'>>>().toEqualTypeOf<{
    readonly success: Expr<'bool'>;
    readonly value: Expr<'uint8'>;
  }>();
  expectTypeOf<Tried<false, Expr<'uint8'>>>().toEqualTypeOf<Expr<'uint8'>>();
});

// Without a `Register` augmentation two abitype copies agree on `0x${string}`, so this only pins
// the export; the single-copy guarantee is `abitype.test.ts`'s augmented fixture.
test("abitype's types come through viem: evs's Address is viem's", () => {
  expectTypeOf<Address>().toEqualTypeOf<ViemAddress>();
});

test('LabelCarrier keeps one element per spec past the six-at-a-time batch (through viem)', () => {
  type Seven = readonly [
    ToArgSpec<'uint256'>,
    ToArgSpec<'address'>,
    ToArgSpec<'bool'>,
    ToArgSpec<'uint8'>,
    ToArgSpec<'bytes32'>,
    ToArgSpec<'string'>,
    ToArgSpec<'int24'>,
  ];
  // the element type is the constant `uint256` placeholder; only the length and labels matter
  expectTypeOf<LabelCarrier<Seven>>().toEqualTypeOf<
    readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]
  >();
});
