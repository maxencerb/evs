/**
 * `build-time-module.ts` — which modules run at build time, and running one.
 *
 * A `*.evs.ts` module is evaluated in Node, by the module runner Vite loads its own config with
 * (`runnerImport`): the module and its relative imports go through Vite, packages are imported
 * by Node itself. Each run is a fresh evaluation, so an edited import is picked up.
 */

import { runnerImport, type ResolvedConfig } from 'vite';

/** `*.evs.ts`, `*.evs.mts`, `*.evs.js` and `*.evs.mjs`, whatever query the id carries. */
export const BUILD_TIME_MODULE = /\.evs\.m?[jt]s(?:\?|$)/;

export interface BuildTimeModule {
  /** The module namespace: every export, `default` included. */
  readonly exports: Readonly<Record<string, unknown>>;
  /** The files it imported, itself excluded. Editing one means running the module again. */
  readonly dependencies: readonly string[];
}

/** Runs `file` in Node and returns what it exports. */
export async function runBuildTimeModule(
  file: string,
  config: ResolvedConfig,
): Promise<BuildTimeModule> {
  try {
    // `runnerImport` starts from an empty config (`configFile: false`, so this plugin is not
    // part of it). Forwarded: what makes the module's imports and its `import.meta.env.MODE`
    // match the app's. The app's plugins, `define` and `.env` files do not apply.
    const { module, dependencies } = await runnerImport<Record<string, unknown>>(file, {
      root: config.root,
      mode: config.mode,
      resolve: { alias: config.resolve.alias },
    });
    return { exports: module, dependencies };
  } catch (error) {
    throw moduleFailure(error);
  }
}

/** Globals a module written for the browser reaches for, and Node does not have. */
const MISSING_BROWSER_GLOBAL =
  /^(window|document|location|localStorage|sessionStorage) is not defined$/;

/**
 * What a module threw, as the error of the build: the original message, and the original stack
 * frames under it (they point into the module).
 */
function moduleFailure(error: unknown): Error {
  const thrown = error instanceof Error ? error : new Error(String(error));
  const browserGlobal = MISSING_BROWSER_GLOBAL.exec(thrown.message)?.[1];
  const hint =
    browserGlobal === undefined
      ? ''
      : `\n\`${browserGlobal}\` does not exist here: a *.evs.ts module runs in Node at build ` +
        `time. Keep browser code out of it and out of the files it imports.`;

  const failure = new Error(
    `the module threw while it ran at build time.\n${thrown.name}: ${thrown.message}${hint}`,
  );
  const frames = /\n {4}at [^]*$/.exec(sourceMappedStack(thrown) ?? '')?.[0] ?? '';
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
