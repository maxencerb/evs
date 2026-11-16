/**
 * The two helpers that read a node's own error, as an app would use them in a `catch`: a
 * deployless limit falls back to state-override mode, and an unsupported opcode recompiles for
 * the target the explanation names. Both results discriminate on `kind`.
 */
import {
  explainDeploylessError,
  explainUnsupportedOpcode,
  evscript,
  t,
  type DeploylessLimitExplanation,
  type EvmVersion,
  type UnsupportedOpcodeExplanation,
} from '@maxencerb/evs';
import {
  explainDeploylessError as explainDeploylessErrorAtRuntime,
  explainUnsupportedOpcode as explainUnsupportedOpcodeAtRuntime,
  hydrate,
} from '@maxencerb/evs/runtime';

import { expectType, type Same } from './assert.js';

const double = evscript({ name: 'double', args: [t.uint256] }, (s, x) =>
  s.return({ doubled: x.mul(2n) }),
);
const compiled = double.compile();
const hydrated = hydrate(compiled.toPrecompiled().toJSON());

expectType<
  Same<
    DeploylessLimitExplanation['kind'],
    'result-starts-with-ef' | 'result-too-large' | 'data-too-large' | 'result-deposit-out-of-gas'
  >
>();
expectType<Same<UnsupportedOpcodeExplanation['kind'], 'unsupported-opcode'>>();
expectType<Same<UnsupportedOpcodeExplanation['opcode'], 'MCOPY' | 'PUSH0' | undefined>>();
expectType<Same<UnsupportedOpcodeExplanation['recompileWith'], EvmVersion>>();

export function retryPlan(error: unknown): 'stateOverride' | EvmVersion | undefined {
  const limit = explainDeploylessError(error);
  expectType<Same<typeof limit, DeploylessLimitExplanation | undefined>>();
  if (limit !== undefined) return 'stateOverride';

  const opcode = explainUnsupportedOpcode(compiled, error);
  expectType<Same<typeof opcode, UnsupportedOpcodeExplanation | undefined>>();
  if (opcode === undefined) return undefined;
  // the explanation names a target `compile()` accepts
  double.compile({ evmVersion: opcode.recompileWith });
  return opcode.recompileWith;
}

/** One `switch` over what either helper recognized. */
export function describe(error: unknown): string {
  const why = explainDeploylessError(error) ?? explainUnsupportedOpcode(hydrated, error);
  if (why === undefined) return 'not a node limit';
  switch (why.kind) {
    case 'unsupported-opcode':
      expectType<Same<typeof why, UnsupportedOpcodeExplanation>>();
      return `recompile with ${why.recompileWith}`;
    case 'result-too-large':
    case 'data-too-large':
      return `${why.size ?? '?'} bytes over ${why.limit ?? '?'}`;
    case 'result-starts-with-ef':
    case 'result-deposit-out-of-gas':
      return why.message;
    default: {
      const unreachable: never = why;
      return unreachable;
    }
  }
}

// the compiler-free entry exports the same two helpers
expectType<Same<typeof explainDeploylessErrorAtRuntime, typeof explainDeploylessError>>();
expectType<Same<typeof explainUnsupportedOpcodeAtRuntime, typeof explainUnsupportedOpcode>>();
explainUnsupportedOpcodeAtRuntime(hydrated, 'invalid opcode: MCOPY');
explainUnsupportedOpcodeAtRuntime(hydrated.toJSON(), 'invalid opcode: MCOPY');

// @ts-expect-error the script comes first
explainUnsupportedOpcode(new Error('invalid opcode: MCOPY'), compiled);
