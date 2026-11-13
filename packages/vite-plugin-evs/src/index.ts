/**
 * `@maxencerb/vite-plugin-evs` — compiles `*.evs.ts` modules at build time.
 *
 * A `*.evs.ts` module is run in Node during the build (`build-time-module.ts`) and replaced by
 * the values it exports (`precompiled-module.ts`): each precompiled script as its bytecode and
 * ABI, hydrated by `@maxencerb/evs/runtime`. The client bundle then holds the scripts and not
 * the compiler. The debug data behind `explainRevert()` is served from virtual modules
 * (`debug-module.ts`) and ends up in on-demand chunks.
 *
 * The same file works without the plugin, with the same bytecode: the plugin only moves the
 * compilation from the browser to the build. When the compiler reaches the client bundle
 * anyway, through another module, the build says so (`compiler-check.ts`): the compiler is told
 * apart from the rest of the evs package by `evs-package.ts`.
 */

import { isFileLoadingAllowed, type Environment, type Plugin, type Rolldown } from 'vite';

import { BUILD_TIME_MODULE, runBuildTimeModule } from './build-time-module.js';
import {
  describeCount,
  describeShippedCompiler,
  findShippedCompiler,
  type PrecompiledCount,
} from './compiler-check.js';
import {
  buildTimeModuleOf,
  DEBUG_MODULE_ID,
  DEBUG_MODULE_SPECIFIER,
  debugModuleId,
} from './debug-module.js';
import { isIneffectiveImportInside, locateEvsPackage, type EvsPackage } from './evs-package.js';
import { displayPath, fileOf } from './paths.js';
import { renderPrecompiledModule, type PrecompiledModule } from './precompiled-module.js';

export interface EvsPluginOptions {
  /** What to do when the evs compiler still ends up in the client bundle. Default: 'warn'. */
  compilerInBundle?: 'warn' | 'error' | 'ignore';
}

export function evs(options: EvsPluginOptions = {}): Plugin {
  const { compilerInBundle = 'warn' } = options;

  /** The latest precompiled form of each build-time module, by file. Every environment shares
   *  it: a module precompiles to the same code for the client and for the server. */
  const precompiledModules = new Map<string, PrecompiledModule>();

  /** The evs package each environment's build bundles, located before its output is written. */
  const evsPackages = new WeakMap<Environment, EvsPackage | undefined>();

  /** Runs the build-time module `file` and writes its replacement. Fails the build, with an
   *  error that starts with the file's name, when the module or one of its exports is at fault. */
  async function precompile(
    context: Rolldown.PluginContext,
    file: string,
  ): Promise<{ module: PrecompiledModule; dependencies: readonly string[] }> {
    const config = context.environment.getTopLevelConfig();
    try {
      const { exports, dependencies } = await runBuildTimeModule(file, config);
      const module = await renderPrecompiledModule(file, exports);
      precompiledModules.set(file, module);
      return { module, dependencies };
    } catch (error) {
      return context.error(errorIn(displayPath(file, config.root), error));
    }
  }

  return {
    name: 'evs',

    resolveId: {
      filter: { id: DEBUG_MODULE_SPECIFIER },
      handler: (specifier) => debugModuleId(specifier),
    },

    load: {
      filter: { id: DEBUG_MODULE_ID },
      async handler(id) {
        const file = buildTimeModuleOf(id);
        if (file === undefined) return null;
        const config = this.environment.getTopLevelConfig();

        let module = precompiledModules.get(file);
        if (module === undefined) {
          // A dev server can be asked for debug data before it ran the module in this session
          // (a page kept open across a restart): run it now. The id names the file and anyone
          // who reaches the server can ask for any id, so only a module it would serve is run.
          if (!BUILD_TIME_MODULE.test(file) || !isFileLoadingAllowed(config, file)) return null;
          ({ module } = await precompile(this, file));
        }
        const code =
          module.debugModules.get(id) ??
          this.error(
            `${displayPath(file, config.root)}: the debug data a page asked for belongs to a ` +
              `version of this module that is gone. Reload the page.`,
          );
        return { code, map: NO_SOURCE_MAP };
      },
    },

    // `transform`, not `load`: on a module's first request, the dev server drops the watch
    // files a `load` hook registers.
    transform: {
      filter: { id: BUILD_TIME_MODULE },
      async handler(_source, id) {
        const { module, dependencies } = await precompile(this, fileOf(id));
        // editing a file the module imports compiles its scripts again
        for (const dependency of dependencies) this.addWatchFile(dependency);
        return { code: module.code, map: NO_SOURCE_MAP };
      },
    },

    // Runs once the module graph is complete, before the bundler makes the chunks and logs
    // about them. The evs package is located here for the two hooks below: `onLog` is
    // synchronous, so it cannot look for it.
    async renderStart() {
      evsPackages.set(this.environment, await locateEvsPackage(this));
    },

    // A precompiled script imports the code behind `explainRevert` on demand, and the compiler
    // imports the same module statically. In a bundle that holds both, the bundler warns that
    // the dynamic import moves nothing to a chunk of its own. That warning is about two modules
    // of evs, so nothing in the app can answer it. What the app can change, keeping the compiler
    // out, is what the report of `generateBundle` says. That one log is dropped, and no other.
    onLog(_level, log) {
      const evsPackage = evsPackages.get(this.environment);
      const isAboutEvs = evsPackage !== undefined && isIneffectiveImportInside(evsPackage, log);
      return isAboutEvs ? false : null;
    },

    generateBundle(_options, bundle) {
      // only a client bundle is downloaded: a server build may hold the compiler freely
      if (this.environment.config.consumer !== 'client') return;

      const precompiled = countPrecompiled(this.getModuleIds(), precompiledModules);
      this.info(
        precompiled.scripts === 0
          ? 'no script was precompiled: this build has no *.evs.ts module that exports one'
          : `precompiled ${describeCount(precompiled)}`,
      );

      if (compilerInBundle === 'ignore') return;
      const evsPackage = evsPackages.get(this.environment);
      if (evsPackage === undefined) return;
      const compiler = findShippedCompiler(this, bundle, evsPackage);
      if (compiler === undefined) return;
      const report = describeShippedCompiler(compiler, precompiled, this.environment.config.root);
      if (compilerInBundle === 'error') this.error(report);
      else this.warn(report);
    },
  };
}

/**
 * The source map of generated code that has no counterpart in a source file. Explicit: without
 * a map the bundler warns about a missing one, and the dev server makes one up (as large as the
 * module, which matters for debug data).
 */
const NO_SOURCE_MAP = { mappings: '' } as const;

/** What the build-time modules among `moduleIds` (the modules of one build) precompiled to. */
function countPrecompiled(
  moduleIds: Iterable<string>,
  precompiledModules: ReadonlyMap<string, PrecompiledModule>,
): PrecompiledCount {
  let scripts = 0;
  let files = 0;
  for (const id of moduleIds) {
    const module = precompiledModules.get(fileOf(id));
    if (module === undefined || module.scripts === 0) continue;
    scripts += module.scripts;
    files += 1;
  }
  return { scripts, files };
}

/** `error` with a message that starts with the file it is about. The stack frames are kept. */
function errorIn(file: string, error: unknown): Error {
  if (!(error instanceof Error)) return new Error(`${file}: ${String(error)}`);
  const failure = new Error(`${file}: ${error.message}`);
  if (error.stack !== undefined) {
    // (a function: a replacement string would expand the `$` patterns of the message)
    failure.stack = error.stack.replace(error.message, () => failure.message);
  }
  return failure;
}
