/**
 * Type tests — the deployless-limit surface: `explainDeploylessError`'s result (a `kind`
 * discriminant or `undefined`), `deploylessDataSize` taking a compiled artifact as-is, and the
 * two `DEPLOYLESS_RESULT_*` codes on `EvsDiagnostic`. Typecheck only.
 */

import { expectTypeOf, test } from 'vite-plus/test';

import {
  compile,
  deploylessDataSize,
  evscript,
  explainDeploylessError,
  t,
  type DeploylessLimitExplanation,
  type EvsDiagnostic,
  type Hex,
} from './index.js';

test('explainDeploylessError yields a kind-discriminated explanation or undefined', () => {
  const explained = explainDeploylessError(new Error('x'));
  expectTypeOf(explained).toEqualTypeOf<DeploylessLimitExplanation | undefined>();
  expectTypeOf<DeploylessLimitExplanation['kind']>().toEqualTypeOf<
    'result-starts-with-ef' | 'result-too-large' | 'data-too-large'
  >();
  expectTypeOf<DeploylessLimitExplanation['size']>().toEqualTypeOf<number | undefined>();
  expectTypeOf(explainDeploylessError).parameter(0).toEqualTypeOf<unknown>();
});

test('deploylessDataSize takes the compiled artifact and calldata', () => {
  const compiled = compile(evscript({ name: 'n', args: [t.uint256] }, (s, x) => s.return({ x })));
  expectTypeOf(deploylessDataSize(compiled, '0x')).toEqualTypeOf<number>();
  expectTypeOf(deploylessDataSize).parameter(1).toEqualTypeOf<Hex>();
  // @ts-expect-error -- the runtime-only shape has no initBytecode
  deploylessDataSize({ runtimeBytecode: compiled.runtimeBytecode }, '0x');
});

test('EvsDiagnostic carries the deployless result codes', () => {
  expectTypeOf<'DEPLOYLESS_RESULT_PREFIX'>().toMatchTypeOf<EvsDiagnostic['code']>();
  expectTypeOf<'DEPLOYLESS_RESULT_SIZE'>().toMatchTypeOf<EvsDiagnostic['code']>();
});
