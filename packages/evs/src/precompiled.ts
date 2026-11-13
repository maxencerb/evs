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
 * - `PrecompiledScript`: that data made callable again, with the same `toViem()` as the artifact.
 *   `compiled.toPrecompiled()` builds one directly, and `hydrate` (`hydrate.ts`) rebuilds one
 *   from the data.
 *
 * `explainRevert` needs more: the recorded IR and the emitted sites (`PrecompiledScriptDebug`),
 * and the explain code (`explain.ts`). Neither is part of the data, and this module imports
 * neither: whoever builds the script says how to load them (`PrecompiledSources`). The artifact
 * already holds both; `hydrate` loads them on the first `explainRevert()`.
 *
 * This module is part of the `@maxencerb/evs/runtime` entry and must stay compiler-free
 * (`runtime-graph.test.ts` checks its import graph).
 */

import type { Abi } from 'viem';

import type { EvmVersion } from './asm/forks.js';
import type { SourceMap } from './asm/sourcemap.js';
import type { Hex } from './core/types.js';
import type { explainRevert, RevertExplanation } from './explain.js';
import type { ScriptIr } from './ir/nodes.js';
import { createToViem, toCreationBytecode, type ToViem } from './viem.js';

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

/** The version of both JSON shapes (`PrecompiledScriptData`, `PrecompiledScriptDebug`). */
export const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

/**
 * How a precompiled script reaches what `explainRevert` needs. Both are loaders, so the script
 * itself costs nothing until a revert is explained: the artifact resolves them at once, and
 * `hydrate` imports them.
 */
export interface PrecompiledSources {
  readonly debug: () => Promise<PrecompiledScriptDebug>;
  readonly explain: () => Promise<typeof explainRevert>;
}

/**
 * Marks a precompiled script. A registered symbol, so `isPrecompiledScript` recognizes a script
 * built by another copy of the package (a duplicated install, or the copy a build step runs).
 */
const PRECOMPILED = Symbol.for('@maxencerb/evs/precompiled');

/**
 * Builds the precompiled script of `data`, which the caller has already checked. The debug data
 * is loaded once and shared by every later `debug()` / `explainRevert()` call.
 */
export function createPrecompiledScript<const abi extends Abi | readonly unknown[]>(
  data: PrecompiledScriptData<abi>,
  sources: PrecompiledSources,
): PrecompiledScript<abi> {
  const { abi, runtimeBytecode, evmVersion } = data;
  const initBytecode = toCreationBytecode(runtimeBytecode, evmVersion);
  const json: PrecompiledScriptData<abi> = Object.freeze({
    version: FORMAT_VERSION,
    abi,
    runtimeBytecode,
    evmVersion,
  });
  const debug = loadOnce(sources.debug);

  const script: PrecompiledScript<abi> = {
    abi,
    runtimeBytecode,
    initBytecode,
    evmVersion,
    toViem: createToViem({ abi, runtimeBytecode, initBytecode }),
    explainRevert: async (revertData) => {
      const [{ ir, sites }, explain] = await Promise.all([debug(), sources.explain()]);
      return explain(revertData, { ir, sites, abi, runtimeBytecode, evmVersion });
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

/**
 * `load`, run on the first call and shared by every later one. A failed load is not kept, so a
 * chunk that did not download can be retried.
 */
function loadOnce<value>(load: () => Promise<value>): () => Promise<value> {
  let pending: Promise<value> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
