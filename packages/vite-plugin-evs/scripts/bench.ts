/**
 * Regenerates the Vite plugin figures quoted in
 * `apps/docs/src/content/docs/concepts/overhead.mdx` ("Precompile at build time"): what an app
 * loads with and without the plugin, what its start-up no longer does, and what the build pays.
 *
 *   pnpm --filter @maxencerb/evs run build                # the library must be built first
 *   node packages/vite-plugin-evs/scripts/bench.ts        # from the repository root
 *
 * Run it from the root to be on the Node the docs name (`.node-version`). Inside this package,
 * which is where `pnpm run bench` runs it, the `node` of Vite+ follows the package's
 * `engines.node` and picks the newest Node instead. The first line printed is the Node used.
 *
 * It prints Markdown tables. It is not a gate: the timings depend on the machine, so refresh
 * the page from one run and keep the machine it names current. The sizes do not vary.
 *
 * Three apps do the same job, the eight reads of the pool metadata example (`bench-app/`):
 *
 * - `viem`: plain viem, two multicalls;
 * - `browser`: the script in a `*.evs.ts` file, built without the plugin, so the app ships the
 *   compiler and compiles the script when it starts;
 * - `plugin`: the same files, built with the plugin.
 *
 * The plugin is taken from `src/` and the library from its `dist/`, like an app takes it. The
 * timings are taken in Node: a browser on a slower device takes longer for every row.
 */
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

import type { Plugin, Rolldown } from 'vite-plus';

import type { PrecompiledScriptData } from '@maxencerb/evs/runtime';

const now = (): number => performance.now();

const self = fileURLToPath(import.meta.url);
const appRoot = fileURLToPath(new URL('bench-app', import.meta.url));

// The plugin's sources import each other with `.js` specifiers, which Node does not map back
// to the `.ts` files.
const pluginSources = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const inPlugin = context.parentURL?.startsWith(pluginSources) === true;
    const sibling = inPlugin && specifier.startsWith('.') && specifier.endsWith('.js');
    return nextResolve(sibling ? `${specifier.slice(0, -3)}.ts` : specifier, context);
  },
});

// ---------------------------------------------------------------------------
// the three apps
// ---------------------------------------------------------------------------

const APPS = {
  viem: { label: 'viem, two multicalls', entry: 'viem.ts', plugin: false },
  browser: { label: 'evs, compiled in the browser (plugin off)', entry: 'evs.ts', plugin: false },
  plugin: { label: 'evs, precompiled (plugin on)', entry: 'evs.ts', plugin: true },
} as const;

type AppName = keyof typeof APPS;

function isAppName(value: string | undefined): value is AppName {
  return value !== undefined && value in APPS;
}

interface Built {
  readonly chunks: readonly Rolldown.OutputChunk[];
  /** The whole `build()` call. */
  readonly buildMs: number;
  /** Of which the plugin's work on the `*.evs.ts` module: running it and writing its code. */
  readonly moduleMs: number;
}

/** `plugin`, with the time its `transform` hook takes added up. */
function timed(plugin: Plugin): { plugin: Plugin; spent: () => number } {
  const { transform } = plugin;
  if (transform === undefined || typeof transform === 'function') {
    throw new TypeError('expected the plugin to declare `transform` as an object hook');
  }
  const { handler } = transform;
  let spent = 0;
  return {
    plugin: {
      ...plugin,
      transform: {
        ...transform,
        async handler(...args) {
          const start = now();
          try {
            return await handler.apply(this, args);
          } finally {
            spent += now() - start;
          }
        },
      },
    },
    spent: () => spent,
  };
}

/** One production build of an app, kept in memory, with Vite's defaults (minified). */
async function buildApp(name: AppName): Promise<Built> {
  const { build } = await import('vite-plus');
  const { evs } = await import('../src/index.ts');
  const app = APPS[name];
  const plugin = timed(evs());

  const start = now();
  const output = await build({
    root: appRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: app.plugin ? [plugin.plugin] : [],
    build: {
      write: false,
      // the entry is a module, not a page: keep what it exports
      rollupOptions: { input: app.entry, preserveEntrySignatures: 'exports-only' },
    },
  });
  const buildMs = now() - start;

  if (Array.isArray(output) || !('output' in output)) {
    throw new TypeError('expected a single build output');
  }
  return {
    chunks: output.output.filter((file) => file.type === 'chunk'),
    buildMs,
    moduleMs: plugin.spent(),
  };
}

// ---------------------------------------------------------------------------
// one sample in a fresh process: `node bench.ts --build <app>`, `--start <compile|hydrate>`
// ---------------------------------------------------------------------------

/** A sample is one line of numbers: nothing to parse but the columns. */
function printSample(values: readonly number[]): void {
  console.log(values.join(' '));
}

/** The median of each column over `samples` fresh processes. */
function fresh(args: readonly string[], samples: number, env: NodeJS.ProcessEnv = {}): number[] {
  const rows: number[][] = [];
  for (let i = 0; i < samples; i++) {
    const out = execFileSync(process.execPath, [self, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    rows.push(out.trim().split(' ').map(Number));
  }
  const columns = rows[0]?.length ?? 0;
  return Array.from({ length: columns }, (_, column) =>
    median(rows.map((row) => row[column] ?? Number.NaN)),
  );
}

const DATA_VARIABLE = 'EVS_BENCH_DATA';

function isData(value: unknown): value is PrecompiledScriptData {
  return typeof value === 'object' && value !== null && 'version' in value && value.version === 1;
}

/** What `hydrate` is given in the app: the data the plugin wrote into the bundle. */
function dataFromEnvironment(): PrecompiledScriptData {
  const data: unknown = JSON.parse(process.env[DATA_VARIABLE] ?? 'null');
  if (!isData(data)) throw new TypeError(`${DATA_VARIABLE} must hold a precompiled script`);
  return data;
}

const noDebug = async (): Promise<never> => {
  throw new Error('the benchmark never explains a revert');
};

/** Start-up without the plugin: load the compiler, then record and compile the script. */
async function startCompiling(): Promise<number[]> {
  let mark = now();
  await import('viem');
  const importViem = now() - mark;
  mark = now();
  await import('@maxencerb/evs');
  const importEvs = now() - mark;
  const { recordPoolMeta } = await import('./bench-app/script.ts');

  mark = now();
  recordPoolMeta().compile().toPrecompiled();
  const first = now() - mark;
  return [importViem, importEvs, first];
}

/** Start-up with the plugin: load the runtime entry, then hydrate the script's data. */
async function startHydrating(): Promise<number[]> {
  let mark = now();
  await import('viem');
  const importViem = now() - mark;
  mark = now();
  const { hydrate } = await import('@maxencerb/evs/runtime');
  const importEvs = now() - mark;
  const data = dataFromEnvironment();

  mark = now();
  hydrate(data, { debug: noDebug });
  const first = now() - mark;
  return [importViem, importEvs, first];
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

const START_SAMPLES = 30;
const BUILD_SAMPLES = 15;
const WARM_RUNS = 2000;
const WARMUP_RUNS = 300;

function median(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/** Median wall time of `fn` in milliseconds, after a warm-up. */
function warm(fn: () => unknown): number {
  for (let i = 0; i < WARMUP_RUNS; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    const start = now();
    fn();
    samples.push(now() - start);
  }
  return median(samples);
}

const ms = (value: number): string => (value < 0.01 ? value.toFixed(4) : value.toFixed(2));
const kB = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;

const brotli = (code: string): number =>
  brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

interface Size {
  readonly minified: number;
  readonly brotli: number;
}

function sizeOf(chunks: readonly Rolldown.OutputChunk[]): Size {
  let minified = 0;
  let compressed = 0;
  for (const chunk of chunks) {
    minified += Buffer.byteLength(chunk.code);
    compressed += brotli(chunk.code); // each file is compressed on its own
  }
  return { minified, brotli: compressed };
}

/** The chunks a page downloads before it runs: the entry and what it imports statically. */
function upFrontOf(chunks: readonly Rolldown.OutputChunk[]): Rolldown.OutputChunk[] {
  const upFront = new Map<string, Rolldown.OutputChunk>();
  const visit = (fileName: string): void => {
    const chunk = chunks.find((candidate) => candidate.fileName === fileName);
    if (chunk === undefined || upFront.has(fileName)) return;
    upFront.set(fileName, chunk);
    chunk.imports.forEach(visit);
  };
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk.fileName);
  return [...upFront.values()];
}

/** The ids of the modules with code in `chunks`. */
function renderedModules(chunks: readonly Rolldown.OutputChunk[]): string[] {
  return chunks.flatMap((chunk) =>
    Object.entries(chunk.modules)
      .filter(([, module]) => module.renderedLength > 0)
      .map(([id]) => id),
  );
}

const VIEM = '/node_modules/viem/';
const isEvs = (id: string): boolean => id.includes('/evs/dist/');
const isDebugData = (id: string): boolean => id.startsWith('\0virtual:evs-debug:');

/** What an on-demand chunk holds, from the modules in it. */
function describe(chunk: Rolldown.OutputChunk): string {
  const ids = renderedModules([chunk]);
  if (ids.some(isDebugData)) return "the script's debug data";
  if (ids.some(isEvs)) return 'the explain code';
  if (ids.length > 0 && ids.every((id) => id.includes(VIEM))) return 'viem, its own lazy import';
  return chunk.name;
}

/** How many copies of viem a build holds: two would count it twice. */
function viemCopies(chunks: readonly Rolldown.OutputChunk[]): number {
  const roots = renderedModules(chunks)
    .filter((id) => id.includes(VIEM))
    .map((id) => id.slice(0, id.indexOf(VIEM)));
  return new Set(roots).size;
}

async function report(): Promise<void> {
  const { rolldownVersion, version } = await import('vite-plus');
  console.log(
    `node ${process.version}, ${process.platform} ${process.arch}, ` +
      `vite ${version} (rolldown ${rolldownVersion})\n`,
  );

  // --- sizes -------------------------------------------------------------
  const names: readonly AppName[] = ['viem', 'browser', 'plugin'];
  const builds = await Promise.all(names.map(async (name) => buildApp(name)));
  const baseline = sizeOf(upFrontOf(builds[0]?.chunks ?? []));

  console.log('## Bundle size: what loads up front (minified, then brotli)\n');
  console.log('| App | Minified | brotli | Added to the viem app | Compiler shipped |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [index, name] of names.entries()) {
    const chunks = builds[index]?.chunks ?? [];
    const size = sizeOf(upFrontOf(chunks));
    const compiler = renderedModules(chunks).some((id) => id.endsWith('/evs/dist/compile.js'));
    if (viemCopies(chunks) !== 1) throw new Error(`${name}: the build holds viem more than once`);
    console.log(
      `| ${APPS[name].label} | ${kB(size.minified)} | ${kB(size.brotli)} | ` +
        `${name === 'viem' ? '' : kB(size.brotli - baseline.brotli)} | ${compiler ? 'yes' : 'no'} |`,
    );
  }

  console.log('\n## Bundle size: what loads on demand\n');
  console.log('| App | Chunk | Minified | brotli |');
  console.log('| --- | --- | --- | --- |');
  for (const [index, name] of names.entries()) {
    const chunks = builds[index]?.chunks ?? [];
    const upFront = new Set(upFrontOf(chunks));
    for (const chunk of chunks) {
      if (upFront.has(chunk)) continue;
      const size = sizeOf([chunk]);
      console.log(
        `| ${APPS[name].label} | ${describe(chunk)} | ${kB(size.minified)} | ${kB(size.brotli)} |`,
      );
    }
  }

  // --- start-up ----------------------------------------------------------
  const { hydrate } = await import('@maxencerb/evs/runtime');
  const { recordPoolMeta } = await import('./bench-app/script.ts');
  const precompiled = recordPoolMeta().compile().toPrecompiled();
  const data = precompiled.toJSON();
  const json = JSON.stringify(precompiled);

  const compiling = fresh(['--start', 'compile'], START_SAMPLES);
  const hydrating = fresh(['--start', 'hydrate'], START_SAMPLES, { [DATA_VARIABLE]: json });
  const warmCompile = warm(() => recordPoolMeta().compile().toPrecompiled());
  const warmHydrate = warm(() => hydrate(data, { debug: noDebug }));

  console.log(`\n## Start-up in Node (ms; first: median of ${START_SAMPLES} fresh processes)\n`);
  console.log('| Step | Compiled in the app | Precompiled |');
  console.log('| --- | --- | --- |');
  console.log(
    `| Import evs, after viem | ${ms(compiling[1] ?? Number.NaN)} | ` +
      `${ms(hydrating[1] ?? Number.NaN)} |`,
  );
  console.log(
    `| Get the script, first call | ${ms(compiling[2] ?? Number.NaN)} (record and compile) | ` +
      `${ms(hydrating[2] ?? Number.NaN)} (hydrate) |`,
  );
  console.log(`| Get the script, warm | ${ms(warmCompile)} | ${ms(warmHydrate)} |`);
  console.log(
    `\nimport viem: ${ms(compiling[0] ?? Number.NaN)} ms and ${ms(hydrating[0] ?? Number.NaN)} ms; ` +
      `the script is ${(precompiled.runtimeBytecode.length - 2) / 2} bytes of bytecode`,
  );

  // --- the build ---------------------------------------------------------
  console.log(`\n## vite build (ms, median of ${BUILD_SAMPLES} fresh processes)\n`);
  console.log('| App | Build | Of which the *.evs.ts module |');
  console.log('| --- | --- | --- |');
  for (const name of names) {
    const [buildMs = Number.NaN, moduleMs = Number.NaN] = fresh(['--build', name], BUILD_SAMPLES);
    console.log(
      `| ${APPS[name].label} | ${buildMs.toFixed(0)} | ` +
        `${APPS[name].plugin ? moduleMs.toFixed(0) : ''} |`,
    );
  }
}

const [mode, argument] = process.argv.slice(2);
if (mode === '--start') {
  printSample(argument === 'hydrate' ? await startHydrating() : await startCompiling());
} else if (mode === '--build') {
  if (!isAppName(argument))
    throw new TypeError(`--build takes one of ${Object.keys(APPS).join(', ')}`);
  const built = await buildApp(argument);
  printSample([built.buildMs, built.moduleMs]);
} else {
  await report();
}
