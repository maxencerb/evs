/**
 * `@maxencerb/evs/runtime` — the compiler-free entry: everything a client that holds only
 * precompiled scripts needs to run them and read their failures.
 *
 * A build step compiles the scripts and serializes each as plain data
 * (`compiled.toPrecompiled()`, then `toJSON()`); the client imports `hydrate` from here and never
 * loads the compiler. Nothing this file reaches may import the compiler: `runtime-graph.test.ts`
 * walks its import graph. Like the main entry, it re-exports every type its signatures name.
 */

// precompiled scripts
export { hydrate } from './hydrate.js';
export { isPrecompiledScript } from './precompiled.js';
export type {
  PrecompiledScript,
  PrecompiledScriptData,
  PrecompiledScriptDebug,
} from './precompiled.js';
export type { RevertExplanation } from './explain.js'; // what precompiled.explainRevert() resolves to
export type { ScriptIr, SiteId } from './ir/nodes.js'; // PrecompiledScriptDebug / RevertExplanation
export type { SourceMap } from './asm/sourcemap.js'; // PrecompiledScriptDebug['sites']

// execution shapes + client-side error decoding
export { decodeScriptError, DEFAULT_SCRIPT_ADDRESS, matchScriptError } from './viem.js';
export type {
  DecodedBuiltinError,
  DecodedScriptError,
  ErrorArgsOf,
  HandlerResult,
  ScriptErrorHandlers,
  ToViem, // the toViem() overloads of a compiled and a precompiled script
  ToViemMode,
} from './viem.js';

// deployless-mode limits
export {
  DEPLOYLESS_MAX_DATA_BYTES,
  DEPLOYLESS_MAX_RESULT_BYTES,
  deploylessDataSize,
  explainDeploylessError,
} from './deployless.js';
export type { DeploylessLimitExplanation } from './deployless.js';

// errors + the small types a caller names
export {
  EvsCompileError,
  EvsError,
  EvsInternalError,
  EvsScopeError,
  EvsStagingError,
  EvsTypeError,
} from './core/errors.js';
export type { EvsDiagnostic, EvsErrorCode } from './core/errors.js';
export type { Address, Hex } from './core/types.js';
export type { EvmVersion } from './asm/forks.js';
