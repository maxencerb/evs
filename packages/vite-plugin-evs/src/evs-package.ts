/**
 * `evs-package.ts` — the `@maxencerb/evs` package inside a build: where the bundler finds it,
 * and which of its modules make up its `runtime` entry.
 *
 * The package has two entries. The main one exports the compiler. `runtime` is what a
 * precompiled script runs on, and reaches no module of the compiler: every module of the
 * package outside of what `runtime` reaches is compiler code.
 *
 * What `runtime` reaches is read from the package's files (`import-closure.ts`), not from the
 * build's module graph. The graph only holds what the app imports, and an app that compiles
 * every script in the browser imports nothing from `runtime`.
 *
 * The entries are resolved by the bundler, like an import of the app. Their ids, and the ids
 * found from them, are therefore the ones the bundler gives the same files in its output: the
 * real path of a linked workspace package, a path under `node_modules` for an installed one.
 */

import { posix } from 'node:path';

import type { Rolldown } from 'vite';

import { importClosureOf } from './import-closure.js';

export interface EvsPackage {
  /** Its directory, with a trailing slash: what the id of each of its modules starts with. */
  readonly root: string;
  /** The module of the main entry, `@maxencerb/evs`: the compiler's way into a bundle. */
  readonly mainEntry: string;
  /** The module of the `runtime` entry, and every module it reaches. */
  readonly runtimeModules: ReadonlySet<string>;
  /** Among them, the modules loaded by a dynamic import: the code behind `explainRevert`. */
  readonly onDemandModules: ReadonlySet<string>;
}

/**
 * Locates the evs package of the build `context` belongs to, once its module graph is complete.
 * `undefined` when the build bundles nothing of it: it is not imported, or left external.
 */
export async function locateEvsPackage(
  context: Rolldown.PluginContext,
): Promise<EvsPackage | undefined> {
  const [manifest, main, runtime] = await Promise.all([
    context.resolve('@maxencerb/evs/package.json'),
    context.resolve('@maxencerb/evs'),
    context.resolve('@maxencerb/evs/runtime'),
  ]);
  if (manifest === null || main === null || runtime === null) return undefined;
  // every import of the package goes through one of its two entries
  if (!isBundled(main, context) && !isBundled(runtime, context)) return undefined;

  const closure = await importClosureOf(runtime.id);
  return {
    root: `${posix.dirname(manifest.id)}/`,
    mainEntry: main.id,
    runtimeModules: closure.files,
    onDemandModules: closure.onDemand,
  };
}

function isBundled(resolved: Rolldown.ResolvedId, context: Rolldown.PluginContext): boolean {
  return resolved.external === false && context.getModuleInfo(resolved.id) !== null;
}

/**
 * Whether `log` is the bundler saying that a dynamic import inside evs moves nothing to a chunk
 * of its own, because another module imports the same code statically. (`log.id` is the module
 * that is imported both ways.)
 */
export function isIneffectiveImportInside(
  evsPackage: EvsPackage,
  log: Rolldown.RolldownLog,
): boolean {
  return (
    log.code === 'INEFFECTIVE_DYNAMIC_IMPORT' &&
    log.id !== undefined &&
    evsPackage.onDemandModules.has(log.id)
  );
}
