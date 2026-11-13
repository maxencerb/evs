/**
 * `precompiled.ts` — the precompiled script: what a client needs to RUN a compiled script, and
 * nothing of the compiler.
 *
 * `compile()` returns the artifact (`CompiledEvsScript`): the bytecode plus everything the
 * toolchain can say about it (IR, source map, disassembly). A precompiled script is its narrow,
 * shippable form (the ABI, the runtime bytecode and its `evmVersion`), in two shapes:
 *
 * - `PrecompiledScriptData`: plain JSON-safe data, what a build step writes into a client bundle
 *   (`JSON.stringify(precompiled)`, through the script's `toJSON()`);
 * - `PrecompiledScript`: that data made callable again by `hydrate`, with the same `toViem()` as
 *   the artifact. `compiled.toPrecompiled()` builds one directly.
 *
 * `explainRevert` needs more: the recorded IR and the emitted sites (`PrecompiledScriptDebug`),
 * and the explain code (`explain.ts`). Neither is part of the data. `hydrate` takes a `debug`
 * loader and the explain module is a dynamic import, so both load on the first `explainRevert()`
 * and a bundler keeps them out of the chunk that holds the scripts.
 *
 * This module is the core of the `@maxencerb/evs/runtime` entry and must stay compiler-free
 * (`runtime-graph.test.ts` checks its import graph).
 */

import type { Abi } from 'viem';

import type { EvmVersion } from './asm/forks.js';
import type { SourceMap } from './asm/sourcemap.js';
import { isHexString } from './core/bytes.js';
import { EvsError, EvsTypeError } from './core/errors.js';
import type { Hex } from './core/types.js';
import type { RevertExplanation } from './explain.js';
import type { ScriptIr } from './ir/nodes.js';
import { assertEvmVersion, createToViem, toCreationBytecode, type ToViem } from './viem.js';

// ---------------------------------------------------------------------------
// public contract
// ---------------------------------------------------------------------------

/** The plain-data form of a precompiled script: what gets serialized into a client bundle.
 *  JSON-safe. */
export interface PrecompiledScriptData<abi extends Abi | readonly unknown[] = readonly unknown[]> {
  readonly version: 1;
  readonly abi: abi;
  readonly runtimeBytecode: Hex;
  readonly evmVersion: EvmVersion;
}

/** What `explainRevert` needs beyond {@link PrecompiledScriptData}. JSON-safe; loaded on demand. */
export interface PrecompiledScriptDebug {
  readonly version: 1;
  readonly ir: ScriptIr; // the recorded IR
  readonly sites: SourceMap['sites']; // the emitted sites (the artifact's `sourceMap.sites`)
}

export interface PrecompiledScript<abi extends Abi | readonly unknown[] = readonly unknown[]> {
  readonly abi: abi;
  readonly runtimeBytecode: Hex;
  readonly initBytecode: Hex; // derived from runtimeBytecode + evmVersion, never serialized
  readonly evmVersion: EvmVersion;
  readonly toViem: ToViem<abi>; // the artifact's own toViem(): same overloads, same results
  /** The artifact's `explainRevert`, asynchronous: the first call loads the debug data and the
   *  explain code. Rejects (`DEBUG_DATA_MISSING`) when the script was hydrated without them. */
  explainRevert(data: Hex): Promise<RevertExplanation>;
  /** The data behind `explainRevert`, loaded once. A build step serializes it next to the
   *  script and hands it back through `hydrate`'s `debug` option. */
  debug(): Promise<PrecompiledScriptDebug>;
  /** The plain data `hydrate` takes, so `JSON.stringify(precompiled)` serializes the script. */
  toJSON(): PrecompiledScriptData<abi>;
}

// ---------------------------------------------------------------------------
// hydrate
// ---------------------------------------------------------------------------

/** The version of both JSON shapes (`PrecompiledScriptData`, `PrecompiledScriptDebug`). */
const FORMAT_VERSION = 1;

/**
 * Marks a precompiled script. A registered symbol, so `isPrecompiledScript` recognizes a script
 * built by another copy of the package (a duplicated install, or the copy a build step runs).
 */
const PRECOMPILED = Symbol.for('@maxencerb/evs/precompiled');

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
  const { abi, runtimeBytecode, evmVersion } = data;
  const initBytecode = toCreationBytecode(runtimeBytecode, evmVersion);
  const json: PrecompiledScriptData<abi> = Object.freeze({
    version: FORMAT_VERSION,
    abi,
    runtimeBytecode,
    evmVersion,
  });
  const debug = loadOnce(options?.debug);

  const script: PrecompiledScript<abi> = {
    abi,
    runtimeBytecode,
    initBytecode,
    evmVersion,
    toViem: createToViem({ abi, runtimeBytecode, initBytecode }),
    explainRevert: async (revertData) => {
      // a dynamic import: bundlers put the explain code in a chunk of its own
      const [{ ir, sites }, { explainRevert }] = await Promise.all([
        debug(),
        import('./explain.js'),
      ]);
      return explainRevert(revertData, { ir, sites, abi, runtimeBytecode, evmVersion });
    },
    debug,
    toJSON: () => json,
  };
  return Object.freeze(Object.defineProperty(script, PRECOMPILED, { value: true }));
}

/** Whether `value` is a precompiled script (from `hydrate` or `compiled.toPrecompiled()`), built
 *  by any copy of the package. */
export function isPrecompiledScript(value: unknown): value is PrecompiledScript {
  return (
    typeof value === 'object' &&
    value !== null &&
    PRECOMPILED in value &&
    value[PRECOMPILED] === true
  );
}

// ---------------------------------------------------------------------------
// input checks — the parameters are typed, but what arrives is parsed JSON or generated code,
// possibly written by another version of evs
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

/**
 * The `debug()` of a script: `load` runs on the first call and every later call shares its
 * result. A failed load is not kept, so a chunk that did not download can be retried.
 */
function loadOnce(
  load: (() => Promise<LoadedDebug>) | undefined,
): () => Promise<PrecompiledScriptDebug> {
  let pending: Promise<PrecompiledScriptDebug> | undefined;
  return () => {
    pending ??= loadDebug(load).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

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
