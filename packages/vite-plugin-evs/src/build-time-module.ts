/**
 * `build-time-module.ts` — which modules run at build time, and running one.
 *
 * A `*.evs.ts` module is evaluated in Node, by the module runner Vite loads its own config with
 * (`runnerImport`): the module and its relative imports go through Vite, packages are imported
 * by Node itself. Each run is a fresh evaluation, so an edited import is picked up.
 *
 * Running a module is running code on the machine that builds or serves the app, so which
 * modules run is decided here, from the whole id and from the file it names, and nowhere else.
 */

import { realpathSync } from 'node:fs';

import { runnerImport, type ResolvedConfig } from 'vite';

import { displayPath } from './paths.js';

/**
 * The name of a build-time module, as a whole id: `*.evs.ts`, `*.evs.mts`, `*.evs.js` or
 * `*.evs.mjs`, and nothing after it. An id with a query or a hash is not one, wherever the
 * suffix is in it: `?raw`, `?url` and the like ask for something else than the module's
 * exports, and a dev server is sent any query by whoever reaches it. Nor is an id with a NUL:
 * that is the virtual module of another plugin, and no file.
 *
 * The name alone does not make a build-time module: see {@link isBuildTimeModule}.
 */
export const BUILD_TIME_MODULE_NAME = /^[^?#\0]*\.evs\.m?[jt]s$/;

/** A path with a `node_modules` directory in it. */
const INSIDE_NODE_MODULES = /(?:^|[\\/])node_modules[\\/]/;

/**
 * Whether the module `id` runs at build time: it has the name of a build-time module, and it
 * is a file of the app or of a package of its workspace.
 *
 * A file of an installed package never is, whatever its name. Such a package is the code of
 * someone else, written to run in the app: running it at build time would hand it the machine
 * that builds, and its environment. It is told by the real path of the file, which is under
 * `node_modules` for an installed package under every package manager, and outside of it for a
 * workspace package, which is only linked there. (The id does not tell: a dev server adds a
 * query to the id of a dependency and a build does not, and `resolve.preserveSymlinks` keeps
 * the link in the id of a workspace package.)
 */
export function isBuildTimeModule(id: string): boolean {
  if (!BUILD_TIME_MODULE_NAME.test(id)) return false;
  const file = realPathOf(id);
  return file !== undefined && !INSIDE_NODE_MODULES.test(file);
}

/** The real path of the file `path`. `undefined` when there is no such file. */
function realPathOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export interface BuildTimeModule {
  /** The module namespace: every export, `default` included. */
  readonly exports: Readonly<Record<string, unknown>>;
  /** The files it imported, itself excluded. Editing one means running the module again. */
  readonly dependencies: readonly string[];
}

/**
 * Runs `file` in Node and returns what it exports. When the module throws, rejects with the
 * error of the build: it names the file and says what was thrown.
 */
export async function runBuildTimeModule(
  file: string,
  config: ResolvedConfig,
): Promise<BuildTimeModule> {
  // `runnerImport` starts from an empty config (`configFile: false`, so this plugin is not part
  // of it) and decides itself how a package is loaded, for Node (`resolve.external`,
  // `conditions`, `mainFields`). Forwarded: the mode behind `import.meta.env.MODE`, and what
  // decides which file an import names, so the module gets the files the app's own code gets
  // (aliases, tsconfig `paths` and the tsconfig they are read from, extensions, symlinks,
  // deduped packages). The app's plugins, `define` and `.env` files do not apply.
  const { root, mode, tsconfig } = config;
  const { alias, dedupe, extensions, preserveSymlinks, tsconfigPaths } = config.resolve;
  try {
    const { module, dependencies } = await runnerImport<Record<string, unknown>>(file, {
      root,
      mode,
      ...(tsconfig === undefined ? {} : { tsconfig }),
      resolve: { alias, dedupe, extensions, preserveSymlinks, tsconfigPaths },
    });
    return { exports: module, dependencies };
  } catch (thrown) {
    throw moduleFailure(displayPath(file, root), thrown);
  }
}

/** Globals a module written for the browser reaches for, and Node does not have. */
const MISSING_BROWSER_GLOBAL =
  /^(window|document|location|localStorage|sessionStorage) is not defined$/;

/**
 * The error of a build whose build-time module threw: the module as a message names it (`name`),
 * what it threw, and the original stack frames under it (they point into the module).
 */
function moduleFailure(name: string, thrown: unknown): Error {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  const browserGlobal = MISSING_BROWSER_GLOBAL.exec(error.message)?.[1];
  const hint =
    browserGlobal === undefined
      ? ''
      : `\n\`${browserGlobal}\` does not exist here: a *.evs.ts module runs in Node at build ` +
        `time. Keep browser code out of it and out of the files it imports.`;

  const failure = new Error(
    `${name}: the module threw while it ran at build time.\n` +
      `${error.name}: ${error.message}${hint}`,
  );
  const frames = /\n {4}at [^]*$/.exec(sourceMappedStack(error) ?? '')?.[0] ?? '';
  failure.stack = `${failure.name}: ${failure.message}${frames}`;
  return failure;
}

/**
 * The stack of an error a build-time module threw, with frames that point at the sources.
 * Node formats a stack when it is first read, and maps it only while its source-map support is
 * on. The module runner turns that on for the run and off again before the error gets here, so
 * it is on for the read.
 */
function sourceMappedStack(error: Error): string | undefined {
  const wasEnabled = process.sourceMapsEnabled;
  process.setSourceMapsEnabled(true);
  try {
    return error.stack;
  } finally {
    process.setSourceMapsEnabled(wasEnabled);
  }
}
