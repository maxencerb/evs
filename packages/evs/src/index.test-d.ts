/**
 * Types named by public signatures are importable from the entry point (the exports map blocks
 * deep imports). Pins the helper types a public declaration mentions — `ScriptAbi['inputs']`,
 * the `EvsFn`/`ArgHandles` label default, the `s.forEach`/`.at` tuple-array bound,
 * `ReturnSpecToComponents`, `RevertExplanation`/`SourceMap` site ids, `AsmNode['op']`,
 * `Disassembly['lines']` — so dropping one from `index.ts` fails here. The IR node types behind
 * `ScriptIr` are deliberately not exported (the IR schema is not a stable API). Typecheck only.
 */
import { expectTypeOf, test } from 'vite-plus/test';

import type {
  AbiParameterSignature,
  AbiParametersSignature,
  ArgName,
  ArgsToInputs,
  DisasmLine,
  Disassembly,
  LabelCarrier,
  Mnemonic,
  ResolveArgName,
  SignatureName,
  SiteId,
  ToArgSpec,
  TupleArrayTag,
  TypeOfReturn,
  Expr,
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
});
