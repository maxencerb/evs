/**
 * `evs-package.ts` — the `@maxencerb/evs` packages inside a build: which modules are theirs, and
 * which of those make up their `runtime` entry.
 *
 * The package has two entries. The main one exports the compiler. `runtime` is what a
 * precompiled script runs on, and reaches no module of the compiler: every module of the
 * package outside of what `runtime` reaches is compiler code.
 *
 * A module belongs to the package whose `package.json` is the nearest one above it. The
 * packages of a build are found that way, from the modules the build holds, and not by
 * resolving `@maxencerb/evs`: a specifier resolves from the module that imports it, which can
 * sit in another workspace package than the app, and a build can hold two copies. The nearest
 * manifest also keeps a dependency installed inside the package (`<evs>/node_modules/viem`)
 * from being taken for a part of it.
 *
 * What `runtime` reaches is read from the package's files (`import-closure.ts`), not from the
 * build's module graph. The graph only holds what the app imports, and an app that compiles
 * every script in the browser imports nothing from `runtime`.
 *
 * Every path here is cut from a module id or joined to one, and never rewritten (no real path):
 * a module of the package is named the way the bundler names it, under `node_modules` or not.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, posix } from 'node:path';

import type { Rolldown } from 'vite';

import { importClosureOf } from './import-closure.js';
import { fileOf } from './paths.js';

const EVS = '@maxencerb/evs';

/**
 * From a module id to the directory of the evs package the module belongs to. `undefined` for a
 * module of anything else: the app, another package, a virtual module.
 */
export type EvsPackageLookup = (id: string) => string | undefined;

/** A lookup that reads each directory's manifest once. */
export function evsPackageLookup(): EvsPackageLookup {
  const byDirectory = new Map<string, string | undefined>();

  /** The evs package the files of `directory` belong to. */
  function packageOf(directory: string): string | undefined {
    if (byDirectory.has(directory)) return byDirectory.get(directory);
    const manifest = readManifest(directory);
    const parent = dirname(directory);
    let found: string | undefined;
    if (manifest !== undefined) found = manifest.name === EVS ? directory : undefined;
    else if (parent !== directory) found = packageOf(parent);
    byDirectory.set(directory, found);
    return found;
  }

  return (id) => {
    const file = fileOf(id);
    // (a virtual module is no file, and in no package)
    return isAbsolute(file) ? packageOf(dirname(file)) : undefined;
  };
}

export interface EvsPackage {
  /** The module of the main entry, `@maxencerb/evs`: the compiler's way into a bundle. */
  readonly mainEntry: string | undefined;
  /** The module of the `runtime` entry, and every module it reaches. Empty for a version of the
   *  package without that entry: all of it is the compiler's. */
  readonly runtimeModules: ReadonlySet<string>;
}

/** Reads the evs package in the directory `root`, which a lookup found. */
export async function readEvsPackage(root: string): Promise<EvsPackage> {
  const { exports } = readManifest(root) ?? {};
  const entry = (subpath: string): string | undefined => {
    const target = isRecord(exports) ? targetFile(exports[subpath]) : undefined;
    return target === undefined ? undefined : posix.join(root, target);
  };
  const runtime = entry('./runtime');
  return {
    mainEntry: entry('.'),
    runtimeModules: runtime === undefined ? new Set() : await importClosureOf(runtime),
  };
}

/**
 * Whether `log` is the bundler saying that a dynamic import inside evs moves nothing to a chunk
 * of its own, because another module of evs imports the same code statically. (`log.id` is the
 * module imported both ways, `log.ids` are the modules that import it.) An app that imports a
 * module of evs both ways gets the log like any other: one of these modules is its own.
 */
export function isIneffectiveImportInsideEvs(
  log: Rolldown.RolldownLog,
  evsPackageOf: EvsPackageLookup,
): boolean {
  return (
    log.code === 'INEFFECTIVE_DYNAMIC_IMPORT' &&
    log.id !== undefined &&
    [log.id, ...(log.ids ?? [])].every((id) => evsPackageOf(id) !== undefined)
  );
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

interface Manifest {
  readonly name?: unknown;
  readonly exports?: unknown;
}

/** The `package.json` of `directory`. `undefined` when there is none to read. */
function readManifest(directory: string): Manifest | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
    return isRecord(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** The file an `exports` target names for an `import`: a path, or what its `import` or
 *  `default` condition names. */
function targetFile(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  return isRecord(target) ? targetFile(target.import ?? target.default) : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
