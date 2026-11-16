/**
 * Type tests — `explainUnsupportedOpcode`: what it takes as a script (anything that carries a
 * `runtimeBytecode`: the artifact, a precompiled script, its data), and its result, whose
 * `recompileWith` is an `evmVersion` `compile()` accepts. Typecheck only.
 */

import { expectTypeOf, test } from 'vite-plus/test';

import {
  compile,
  evscript,
  explainDeploylessError,
  explainUnsupportedOpcode,
  t,
  type DeploylessLimitExplanation,
  type EvmVersion,
  type Hex,
  type UnsupportedOpcodeExplanation,
} from './index.js';
import {
  explainUnsupportedOpcode as fromRuntime,
  type UnsupportedOpcodeExplanation as FromRuntime,
} from './runtime.js';

const script = evscript({ name: 'n', args: [t.uint256] }, (s, x) => s.return({ x }));
const compiled = compile(script);

test('explainUnsupportedOpcode yields an explanation or undefined', () => {
  const explained = explainUnsupportedOpcode(compiled, new Error('x'));
  expectTypeOf(explained).toEqualTypeOf<UnsupportedOpcodeExplanation | undefined>();
  expectTypeOf<UnsupportedOpcodeExplanation['kind']>().toEqualTypeOf<'unsupported-opcode'>();
  expectTypeOf<UnsupportedOpcodeExplanation['opcode']>().toEqualTypeOf<
    'MCOPY' | 'PUSH0' | undefined
  >();
  expectTypeOf<UnsupportedOpcodeExplanation['recompileWith']>().toEqualTypeOf<EvmVersion>();
  expectTypeOf(explainUnsupportedOpcode).parameter(1).toEqualTypeOf<unknown>();
});

test('the script is the artifact, a precompiled script or its data', () => {
  const precompiled = compiled.toPrecompiled();
  type Explained = UnsupportedOpcodeExplanation | undefined;
  expectTypeOf(explainUnsupportedOpcode(precompiled, 'x')).toEqualTypeOf<Explained>();
  expectTypeOf(explainUnsupportedOpcode(precompiled.toJSON(), 'x')).toEqualTypeOf<Explained>();
  expectTypeOf(
    explainUnsupportedOpcode({ runtimeBytecode: compiled.runtimeBytecode }, 'x'),
  ).toEqualTypeOf<Explained>();
  expectTypeOf(explainUnsupportedOpcode).parameter(0).toEqualTypeOf<{
    readonly runtimeBytecode: Hex;
  }>();
  // @ts-expect-error -- the script comes first: an error is not one
  explainUnsupportedOpcode(new Error('x'), compiled);
  // @ts-expect-error -- the recorded script has no bytecode yet
  explainUnsupportedOpcode(script, 'x');
});

test('recompileWith is an evmVersion compile() takes', () => {
  expectTypeOf<UnsupportedOpcodeExplanation['recompileWith']>().toExtend<
    NonNullable<Parameters<typeof script.compile>[0]>['evmVersion']
  >();
});

test('the two node-error explanations discriminate on kind', () => {
  const why = explainDeploylessError('x') ?? explainUnsupportedOpcode(compiled, 'x');
  expectTypeOf(why).toEqualTypeOf<
    DeploylessLimitExplanation | UnsupportedOpcodeExplanation | undefined
  >();
  if (why?.kind === 'unsupported-opcode') {
    expectTypeOf(why).toEqualTypeOf<UnsupportedOpcodeExplanation>();
  } else if (why !== undefined) {
    expectTypeOf(why).toEqualTypeOf<DeploylessLimitExplanation>();
  }
});

test('the runtime entry exports the same function and type', () => {
  expectTypeOf(fromRuntime).toEqualTypeOf(explainUnsupportedOpcode);
  expectTypeOf<FromRuntime>().toEqualTypeOf<UnsupportedOpcodeExplanation>();
});
