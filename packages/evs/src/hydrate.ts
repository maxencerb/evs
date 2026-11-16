/**
 * `hydrate.ts` — `hydrate`: the data of a precompiled script (`precompiled.ts`) made callable
 * again, in a client that never loads the compiler.
 *
 * What arrives here is parsed JSON or generated code, possibly written by another version of
 * evs, so everything is checked before it is used. The data is checked here, on entry. The
 * debug data is checked when it loads, by code that loads with it (`debug-data.ts`): a client
 * that never explains a revert carries none of it.
 *
 * The explain code (`explain.ts`) is a dynamic import: a bundler puts it in a chunk of its own,
 * fetched on the first `explainRevert()` together with the script's debug data.
 *
 * Only the `@maxencerb/evs/runtime` entry reaches this module. The compiler builds its
 * precompiled scripts without it (`compiled.toPrecompiled()`), so a bundle that holds the
 * compiler, where the explain code is a static import, has no dynamic import of it.
 */

import type { Abi } from 'viem';

import { isHexString } from './core/bytes.js';
import { EvsError, EvsTypeError } from './core/errors.js';
import {
  createPrecompiledScript,
  FORMAT_VERSION,
  type PrecompiledScript,
  type PrecompiledScriptData,
} from './precompiled.js';
import { assertEvmVersion } from './viem.js';

/**
 * The debug data as a `debug` loader may type it. Loose on purpose: a `.json` import widens
 * every literal of the document (`version` to `number`, a statement kind to `string`), and the
 * document is checked when it loads, whatever its type says.
 */
interface LoadedDebugData {
  readonly version: number;
  readonly ir: object;
  readonly sites: readonly unknown[];
}

interface HydrateOptions {
  /**
   * Loads the script's debug data (what `compiled.toPrecompiled().debug()` returned at build
   * time), on the first `explainRevert()` / `debug()` call only. It resolves to the data, or to
   * a module namespace whose `default` is the data, which is what
   * `() => import('./script.debug.json')` resolves to.
   */
  debug?: () => Promise<LoadedDebugData | { readonly default: LoadedDebugData }>;
}

/**
 * Turns the data of a precompiled script back into a `PrecompiledScript`. `options.debug` loads
 * the script's debug data, on the first `explainRevert()` / `debug()` call only; without it both
 * reject with `DEBUG_DATA_MISSING`. Debug data that was not written with this data (another
 * script's, or another build's: the two carry different `id`s) makes both reject with
 * `TYPE_MISMATCH`.
 *
 * Throws `EvsTypeError` (`TYPE_MISMATCH`) on data that is not a precompiled script, including
 * data of another format version, and `EvsCompileError` (`EVM_VERSION`) on an unknown
 * `evmVersion`. The ABI array is kept as given, not copied.
 */
export function hydrate<const abi extends Abi | readonly unknown[]>(
  data: PrecompiledScriptData<abi>,
  options?: HydrateOptions,
): PrecompiledScript<abi>;
/**
 * `hydrate`, for data that lost its literal types: what `import data from './script.json'`
 * gives. The script runs the same, but its ABI is wide, so viem infers no function name,
 * argument or result from it. For literal types, have the build step write a `.ts` module that
 * ends with `as const` (`export const data = {…} as const`) and import that instead.
 */
export function hydrate(
  data: {
    readonly version: number;
    readonly id?: string;
    readonly abi: readonly unknown[];
    readonly runtimeBytecode: string;
    readonly evmVersion: string;
  },
  options?: HydrateOptions,
): PrecompiledScript<Abi>;
export function hydrate(data: unknown, options?: HydrateOptions): PrecompiledScript {
  assertData(data);
  const load = options?.debug;
  // The explain code and the checks of the debug data, loaded together. A dynamic import:
  // bundlers put them in a chunk of their own. Without a loader nothing can be explained, so
  // nothing is imported either.
  const onDemand = () =>
    load === undefined
      ? Promise.reject(new EvsError('DEBUG_DATA_MISSING', NO_DEBUG_DATA))
      : import('./explain.js');
  return createPrecompiledScript(data, {
    debug: async () => {
      const [{ debugDataOf }, loaded] = await Promise.all([onDemand(), load?.()]);
      return debugDataOf(loaded, data);
    },
    explain: async () => (await onDemand()).explainRevert,
  });
}

const NO_DEBUG_DATA =
  'this precompiled script was hydrated without debug data, which explainRevert() and debug() ' +
  'need: pass hydrate(data, { debug }) a loader of what `compiled.toPrecompiled().debug()` ' +
  'returned at build time (decodeScriptError() needs the ABI alone)';

// ---------------------------------------------------------------------------
// input checks
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * Checks everything that can be checked without the compiler. Whether the bytecode is whole,
 * and the one the ABI was written with, cannot: that takes a hash, which a client that only
 * hydrates must not carry.
 */
function assertData(data: unknown): asserts data is PrecompiledScriptData {
  if (!isObject(data) || data['version'] === undefined) throw notData(data);
  if (data['version'] !== FORMAT_VERSION) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `hydrate: the precompiled script data has version ${JSON.stringify(data['version'])} and ` +
        `this evs reads version ${FORMAT_VERSION}: another version of evs produced it, so it ` +
        `must be regenerated (compile the script again)`,
    );
  }
  const { abi, runtimeBytecode } = data;
  // the script ABI is the script's function, then its errors
  const entry: unknown = Array.isArray(abi) ? abi[0] : undefined;
  if (!isObject(entry) || entry['type'] !== 'function' || typeof entry['name'] !== 'string') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      "hydrate: `abi` must be the script ABI: an array that starts with the script's function",
    );
  }
  // a compiled script always has code
  if (!isHexString(runtimeBytecode) || runtimeBytecode === '0x') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      'hydrate: `runtimeBytecode` must be non-empty 0x-prefixed even-length hex',
    );
  }
  assertEvmVersion(data['evmVersion'], 'hydrate: ');
}

/**
 * The error for a value that is not the data: it names what was passed and what to pass. The
 * JSON text, the precompiled script itself and the compiled script are the usual ones; the two
 * scripts are told by their methods, which costs a client less than the script brand.
 */
function notData(value: unknown): EvsTypeError {
  let got: string;
  if (typeof value === 'string') {
    got = 'a string: pass JSON.parse(text)';
  } else if (!isObject(value) || !('toViem' in value)) {
    got =
      `${isObject(value) ? 'an object with no `version`' : String(value)}: pass what ` +
      'JSON.stringify(compiled.toPrecompiled()) wrote, parsed';
  } else if ('toPrecompiled' in value) {
    got = 'a compiled script: pass compiled.toPrecompiled().toJSON()';
  } else {
    got = 'a precompiled script: pass script.toJSON(), or use the script as it is';
  }
  return new EvsTypeError(
    'TYPE_MISMATCH',
    `hydrate: expected the data of a precompiled script, got ${got}`,
  );
}
