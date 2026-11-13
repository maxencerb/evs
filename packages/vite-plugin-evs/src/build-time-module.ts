/**
 * `build-time-module.ts` — which modules run at build time, and running one.
 *
 * A `*.evs.ts` module is evaluated in Node, by the module runner Vite loads its own config with
 * (`runnerImport`): the module and its relative imports go through Vite, packages are imported
 * by Node itself. Each run is a fresh evaluation, so an edited import is picked up.
 */

import { runnerImport, type ResolvedConfig } from 'vite';

import { displayPath } from './paths.js';

/**
 * `*.evs.ts`, `*.evs.mts`, `*.evs.js` and `*.evs.mjs`. An id with a query is not one: `?raw`,
 * `?url` and the like ask for something else than the module's exports.
 */
export const BUILD_TIME_MODULE = /\.evs\.m?[jt]s$/;

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
