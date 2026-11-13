/**
 * `hydrate.ts` — `hydrate`: the data of a precompiled script (`precompiled.ts`) made callable
 * again, in a client that never loads the compiler.
 *
 * What arrives here is parsed JSON or generated code, possibly written by another version of
 * evs, so everything is checked before it is used. The explain code (`explain.ts`) is a dynamic
 * import: a bundler puts it in a chunk of its own, fetched on the first `explainRevert()`
 * together with the script's debug data.
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
  type PrecompiledScriptDebug,
} from './precompiled.js';
import { assertEvmVersion } from './viem.js';

/** A `debug` loader's result: the data itself, or a module namespace whose `default` is the
 *  data, which is what `() => import('./script.debug.json')` resolves to. */
type LoadedDebug = PrecompiledScriptDebug | { readonly default: PrecompiledScriptDebug };

/**
 * Turns the data of a precompiled script back into a `PrecompiledScript`. `options.debug` loads
 * the script's debug data, on the first `explainRevert()` / `debug()` call only; without it both
 * reject with `DEBUG_DATA_MISSING`.
 *
 * Throws `EvsTypeError` (`TYPE_MISMATCH`) on data that is not a precompiled script, including
 * data of another format version, and `EvsCompileError` (`EVM_VERSION`) on an unknown
 * `evmVersion`. The ABI array is kept as given, not copied.
 */
export function hydrate<const abi extends Abi | readonly unknown[]>(
  data: PrecompiledScriptData<abi>,
  options?: { debug?: () => Promise<LoadedDebug> },
): PrecompiledScript<abi> {
  assertData(data);
  const load = options?.debug;
  return createPrecompiledScript(data, {
    debug: () => loadDebug(load),
    // a dynamic import: bundlers put the explain code in a chunk of its own
    explain: async () => (await import('./explain.js')).explainRevert,
  });
}

// ---------------------------------------------------------------------------
// input checks
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function assertData(data: PrecompiledScriptData): void {
  assertVersion(data, 'hydrate: the precompiled script data');
  if (!Array.isArray(data.abi)) {
    throw new EvsTypeError('TYPE_MISMATCH', 'hydrate: `abi` must be an array (the script ABI)');
  }
  if (!isHexString(data.runtimeBytecode)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      'hydrate: `runtimeBytecode` must be 0x-prefixed even-length hex',
    );
  }
  assertEvmVersion(data.evmVersion, 'hydrate: ');
}

/** Both JSON shapes carry `version`; `what` names the one checked, after the caller's name. */
function assertVersion(value: unknown, what: string): void {
  const version: unknown = isObject(value) && 'version' in value ? value.version : undefined;
  if (version === FORMAT_VERSION) return;
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    version === undefined
      ? `${what} has no \`version\`: it is not what a precompiled script serializes to`
      : `${what} has version ${JSON.stringify(version)} and this evs reads version ` +
          `${FORMAT_VERSION}: another version of evs produced it, so it must be regenerated ` +
          `(compile the script again)`,
  );
}

// ---------------------------------------------------------------------------
// debug data
// ---------------------------------------------------------------------------

const NO_DEBUG_DATA =
  'this precompiled script was hydrated without debug data, which explainRevert() and debug() ' +
  'need: pass hydrate(data, { debug }) a loader of what `compiled.toPrecompiled().debug()` ' +
  'returned at build time (decodeScriptError() needs the ABI alone)';

async function loadDebug(
  load: (() => Promise<LoadedDebug>) | undefined,
): Promise<PrecompiledScriptDebug> {
  if (load === undefined) throw new EvsError('DEBUG_DATA_MISSING', NO_DEBUG_DATA);
  const loaded = await load();
  const debug = isObject(loaded) && 'default' in loaded ? loaded.default : loaded;
  assertDebug(debug);
  return debug;
}

function assertDebug(debug: PrecompiledScriptDebug): void {
  const what = 'the debug data of the precompiled script';
  assertVersion(debug, what);
  if (!isObject(debug.ir) || !Array.isArray(debug.sites)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${what} must hold \`ir\` and \`sites\`: expected what the script's debug() returns`,
    );
  }
}
