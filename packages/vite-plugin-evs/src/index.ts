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
 *
 * Vite bundles a Web Worker apart, with the plugins of `worker.plugins` and none of the app's.
 * The plugin adds itself to them (`config`), so a worker's scripts are precompiled and its
 * bundle is checked like the page's.
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import type { Plugin, Rolldown } from 'vite';

import { BUILD_TIME_MODULE, runBuildTimeModule } from './build-time-module.js';
import {
  describeCount,
  describeShippedCompiler,
  findShippedCompiler,
  mergeShippedCompilers,
  type PrecompiledCount,
  type ShippedCompiler,
} from './compiler-check.js';
import { DEBUG_MODULE_ID, DEBUG_MODULE_SPECIFIER, debugModuleId } from './debug-module.js';
import { evsPackageLookup, isIneffectiveImportInsideEvs } from './evs-package.js';
import { displayPath } from './paths.js';
import { renderPrecompiledModule, type PrecompiledModule } from './precompiled-module.js';

export interface EvsPluginOptions {
  /** What to do when the evs compiler still ends up in the client bundle. Default: 'warn'. */
  compilerInBundle?: 'warn' | 'error' | 'ignore';
}

/** The name of the plugin a worker bundle gets. It reports nothing: the page's plugin does. */
const WORKER_PLUGIN = 'evs:worker';

/** What the code written for a build-time module imports. */
const RUNTIME_ENTRY = '@maxencerb/evs/runtime';

export function evs(options: EvsPluginOptions = {}): Plugin {
  const { compilerInBundle = 'warn' } = options;

  /**
   * The latest precompiled form of each build-time module, by file. Every environment and every
   * worker bundle shares it: a module precompiles to the same code for all of them.
   */
  const precompiledModules = new Map<string, PrecompiledModule>();

  /**
   * What each worker bundle holds, by the file name of its entry chunk. A worker is bundled
   * while the module that starts it is transformed, so before that module's own bundle is
   * written: its entry is then one of the files of that bundle.
   */
  const workerBundles = new Map<string, BundleContents>();

  const evsPackageOf = evsPackageLookup();

  /** Runs the build-time module `file` and writes its replacement. Fails the build, with an
   *  error that starts with the file's name, when the module or one of its exports is at fault. */
  async function precompile(
    context: Rolldown.PluginContext,
    file: string,
  ): Promise<{ module: PrecompiledModule; dependencies: readonly string[] }> {
    const config = context.environment.getTopLevelConfig();
    // (rejects with the error of the build when the module throws)
    const { exports, dependencies } = await runBuildTimeModule(file, config);
    const module = await renderPrecompiledModule(file, exports).catch((problem: unknown) =>
      context.error(new Error(`${displayPath(file, config.root)}: ${messageOf(problem)}`)),
    );
    precompiledModules.set(file, module);
    return { module, dependencies };
  }

  /** The source of the debug module `id`, when a script precompiled in this session has it. */
  function debugModuleSource(id: string): string | undefined {
    for (const module of precompiledModules.values()) {
      const source = module.debugModules.get(id);
      if (source !== undefined) return source;
    }
    return undefined;
  }

  /** What `bundle` holds, with the bundles of the workers it starts. */
  async function contentsOf(
    context: Rolldown.PluginContext,
    bundle: Rolldown.OutputBundle,
  ): Promise<BundleContents> {
    const workers = Object.keys(bundle).flatMap((fileName) => workerBundles.get(fileName) ?? []);
    const own = [...context.getModuleIds()].filter((id) => precompiledModules.has(id));
    return {
      buildTimeModules: [...own, ...workers.flatMap((worker) => worker.buildTimeModules)],
      compiler:
        compilerInBundle === 'ignore'
          ? undefined
          : mergeShippedCompilers([
              await findShippedCompiler(context, bundle, evsPackageOf),
              ...workers.map((worker) => worker.compiler),
            ]),
    };
  }

  /** The hooks of every bundle that holds build-time modules: a page's, a server's, a worker's. */
  const precompiling: Pick<Plugin, 'resolveId' | 'load' | 'transform' | 'onLog'> = {
    resolveId: {
      filter: { id: DEBUG_MODULE_SPECIFIER },
      handler: (specifier) => debugModuleId(specifier),
    },

    // A dev server is asked for a debug module by whoever reaches it, under any name. It answers
    // with a module a `transform` of this session wrote, or with an error. It never runs or
    // reads a file for one: the name holds no path, and a page that kept a name from before a
    // restart, or from before an edit, is told to reload.
    load: {
      filter: { id: DEBUG_MODULE_ID },
      handler(id) {
        const code =
          debugModuleSource(id) ??
          this.error(
            'the debug data a page asked for belongs to a version of a *.evs.ts module that ' +
              'is gone. Reload the page.',
          );
        return { code, map: NO_SOURCE_MAP };
      },
    },

    // `transform`, not `load`: on a module's first request, the dev server drops the watch
    // files a `load` hook registers.
    transform: {
      filter: { id: BUILD_TIME_MODULE },
      async handler(_source, id) {
        const { module, dependencies } = await precompile(this, id);
        // editing a file the module imports compiles its scripts again
        for (const dependency of dependencies) this.addWatchFile(dependency);
        return { code: module.code, map: NO_SOURCE_MAP };
      },
    },

    // A precompiled script imports the code behind `explainRevert` on demand, and the compiler
    // imports the same module statically. In a bundle that holds both, the bundler warns that
    // the dynamic import moves nothing to a chunk of its own. That warning is about modules of
    // evs alone, so nothing in the app can answer it. What the app can change, keeping the
    // compiler out, is what the report of `generateBundle` says. That one log is dropped, and
    // no other.
    onLog: (_level, log) => (isIneffectiveImportInsideEvs(log, evsPackageOf) ? false : null),
  };

  /**
   * The plugin of a worker bundle. It precompiles like the page's and says nothing: what the
   * bundle holds is kept for the bundle that starts the worker, whose plugin reports it.
   */
  const workerPlugin = (): Plugin => ({
    name: WORKER_PLUGIN,
    ...precompiling,
    async generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (output) => output.type === 'chunk' && output.isEntry,
      );
      if (entry !== undefined) workerBundles.set(entry.fileName, await contentsOf(this, bundle));
    },
  });

  return {
    name: 'evs',
    ...precompiling,

    config: ({ root }) => ({
      // The dev server looks for the dependencies to pre-bundle in the source of the app, where
      // a build-time module does not import the runtime entry: its replacement does. Found on
      // the first request instead, the entry is pre-bundled late, and the page reloads for it.
      optimizeDeps: { include: resolvesFrom(root, RUNTIME_ENTRY) ? [RUNTIME_ENTRY] : [] },
      // Vite merges this with the `worker.plugins` of the app's config: the app's own stay.
      worker: { plugins: () => [workerPlugin()] },
    }),

    // An app can also list `evs()` in `worker.plugins` by hand. A worker bundle then has that
    // plugin next to the one registered above: the one listed by hand stands down, so the work
    // is done once and reported once.
    applyToEnvironment: (environment) =>
      !environment.getTopLevelConfig().plugins.some((plugin) => plugin.name === WORKER_PLUGIN),

    async generateBundle(_options, bundle) {
      // only a client bundle is downloaded: a server build may hold the compiler freely
      if (this.environment.config.consumer !== 'client') return;

      const { buildTimeModules, compiler } = await contentsOf(this, bundle);
      const precompiled = countPrecompiled(buildTimeModules, precompiledModules);
      this.info(
        precompiled.scripts === 0
          ? 'no script was precompiled: this build has no *.evs.ts module that exports one'
          : `precompiled ${describeCount(precompiled)}`,
      );

      if (compiler === undefined) return;
      const report = describeShippedCompiler(compiler, precompiled, this.environment.config.root);
      if (compilerInBundle === 'error') this.error(report);
      else this.warn(report);
    },
  };
}

/** What one bundle holds, the bundles of the workers it starts included. */
interface BundleContents {
  /** The build-time modules in it, by file. One that a page and its worker both import is
   *  listed twice. */
  readonly buildTimeModules: readonly string[];
  /** The compiler code in it. `undefined` when there is none, or when nobody asked. */
  readonly compiler: ShippedCompiler | undefined;
}

/**
 * The source map of generated code that has no counterpart in a source file. Explicit: without
 * a map the bundler warns about a missing one, and the dev server makes one up (as large as the
 * module, which matters for debug data).
 */
const NO_SOURCE_MAP = { mappings: '' } as const;

/** What the build-time modules `files` precompiled to. A file is counted once. */
function countPrecompiled(
  files: readonly string[],
  precompiledModules: ReadonlyMap<string, PrecompiledModule>,
): PrecompiledCount {
  let scripts = 0;
  let count = 0;
  for (const file of new Set(files)) {
    const module = precompiledModules.get(file);
    if (module === undefined || module.scripts === 0) continue;
    scripts += module.scripts;
    count += 1;
  }
  return { scripts, files: count };
}

/**
 * Whether a module in the directory `root` (default: the working directory, like Vite's) can
 * import `specifier`. `optimizeDeps.include` only takes what the app's root resolves, and evs
 * can be the dependency of another workspace package alone.
 */
function resolvesFrom(root: string | undefined, specifier: string): boolean {
  try {
    createRequire(resolve(root ?? '.', 'package.json')).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
