/**
 * Both entry points resolve, with their types, for an app on TypeScript's legacy module
 * resolution (see `tsconfig.node10.json`). That resolution reads no `exports` map: the main
 * entry comes through the manifest's `types` field, the runtime entry through `typesVersions`.
 */
import { evscript, t } from '@maxencerb/evs';
import { hydrate } from '@maxencerb/evs/runtime';

const double = evscript({ name: 'double', args: [t.uint256] }, (s, x) =>
  s.return({ doubled: x.mul(2n) }),
);

const precompiled = double.compile().toPrecompiled();
const hydrated = hydrate(precompiled.toJSON());

// typed, not `any`: a string is not the script's bytecode
// @ts-expect-error
export const notBytecode: typeof hydrated.runtimeBytecode = 42;
export const bytecode: `0x${string}` = hydrated.runtimeBytecode;
