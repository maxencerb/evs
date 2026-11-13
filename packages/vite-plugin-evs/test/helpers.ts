/**
 * Test helpers: drive Vite programmatically over `test/fixtures`, with the plugin taken from
 * `src/` (no built dist needed) and every log the build prints captured.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { build, createLogger, type InlineConfig, type Logger, type Rolldown } from 'vite-plus';
import { afterAll } from 'vite-plus/test';

import { evs, type EvsPluginOptions } from '../src/index.js';

export const packageRoot: string = fileURLToPath(new URL('..', import.meta.url));
export const appRoot: string = join(packageRoot, 'test/fixtures/app');

/** What a build logged, without colors. */
export interface Logs {
  readonly info: string[];
  readonly warnings: string[];
}

/** A Vite logger that records instead of printing. */
export function recordingLogger(): { logger: Logger; logs: Logs } {
  const logs: Logs = { info: [], warnings: [] };
  const logger = createLogger('info');
  const warn = (message: string): void =>
    void logs.warnings.push(stripVTControlCharacters(message));
  logger.info = (message) => void logs.info.push(stripVTControlCharacters(message));
  logger.warn = warn;
  logger.warnOnce = warn;
  return { logger, logs };
}

export interface Built {
  readonly chunks: readonly Rolldown.OutputChunk[];
  /** The chunk of the entry. */
  readonly entry: Rolldown.OutputChunk;
  readonly logs: Logs;
  /** The lines the plugin logged at info level, without the `[plugin evs] ` prefix. */
  readonly pluginInfo: readonly string[];
  /** The warnings of the plugin, without the prefix. */
  readonly pluginWarnings: readonly string[];
  /** Where the output was written, when `write` was asked for. */
  readonly outDir: string | undefined;
  /** Imports the written entry chunk in Node. */
  importEntry(): Promise<Record<string, unknown>>;
}

export interface BuildOptions {
  /** The app's root. Default: `test/fixtures/app`. */
  root?: string;
  plugin?: EvsPluginOptions;
  /** Writes the output to a temporary directory, so the test can import it. */
  write?: boolean;
  /** Merged over the test defaults. */
  config?: InlineConfig;
}

const PREFIX = '[plugin evs] ';

function ofPlugin(messages: readonly string[]): string[] {
  return messages
    .filter((message) => message.startsWith(PREFIX))
    .map((message) => message.slice(PREFIX.length));
}

/**
 * Builds the fixture app from `entry` (a path relative to the root), as a client build unless
 * `config` says otherwise. The entry keeps its exports, so a test can import what was built.
 */
export async function buildApp(entry: string, options: BuildOptions = {}): Promise<Built> {
  const { logger, logs } = recordingLogger();
  const outDir = options.write === true ? temporaryOutDir() : undefined;
  const { build: { rollupOptions, ...buildConfig } = {}, ...config } = options.config ?? {};

  const output = await build({
    root: options.root ?? appRoot,
    configFile: false,
    logLevel: 'silent', // nothing on the terminal: the logger below records every message
    customLogger: logger,
    plugins: [evs(options.plugin)],
    ...config,
    build: {
      write: outDir !== undefined,
      ...(outDir === undefined ? {} : { outDir, emptyOutDir: true }),
      // no preload helper: it needs a `document`, and the tests import the output in Node
      modulePreload: false,
      rollupOptions: { input: entry, preserveEntrySignatures: 'exports-only', ...rollupOptions },
      ...buildConfig,
    },
  });
  if (Array.isArray(output) || !('output' in output)) {
    throw new TypeError('expected a single build output');
  }

  const chunks = output.output.filter((file) => file.type === 'chunk');
  const entryChunk = chunks.find((chunk) => chunk.isEntry);
  if (entryChunk === undefined) throw new TypeError('the build has no entry chunk');
  return {
    chunks,
    entry: entryChunk,
    logs,
    pluginInfo: ofPlugin(logs.info),
    pluginWarnings: ofPlugin(logs.warnings),
    outDir,
    importEntry: async () => {
      if (outDir === undefined)
        throw new TypeError('build with `write: true` to import the output');
      const module: Record<string, unknown> = await import(
        pathToFileURL(join(outDir, entryChunk.fileName)).href
      );
      return module;
    },
  };
}

/**
 * A directory for one build's output. It lives under `node_modules`, where git, the formatter
 * and the linter never look and where Vitest imports a file with Node itself: the tests run the
 * output as it was written.
 */
function temporaryOutDir(): string {
  const parent = join(packageRoot, 'node_modules/.vite-plugin-evs-test');
  mkdirSync(parent, { recursive: true });
  // Node finds no package scope under node_modules: say that the `.js` output is ESM
  writeFileSync(join(parent, 'package.json'), '{ "type": "module" }\n');
  const outDir = mkdtempSync(join(parent, 'build-'));
  outDirs.push(outDir);
  return outDir;
}

// Removed when the test file is done (this module is evaluated once per test file): a chunk
// that loads on demand must still be there when a later test asks for it.
const outDirs: string[] = [];
afterAll(() => {
  for (const outDir of outDirs) rmSync(outDir, { recursive: true, force: true });
});

/** The chunks a page downloads before it runs: the entry and what it imports statically. */
export function upFrontChunks(built: Built): Rolldown.OutputChunk[] {
  const upFront = new Map<string, Rolldown.OutputChunk>();
  const visit = (fileName: string): void => {
    const chunk = built.chunks.find((candidate) => candidate.fileName === fileName);
    if (chunk === undefined || upFront.has(fileName)) return;
    upFront.set(fileName, chunk);
    chunk.imports.forEach(visit);
  };
  visit(built.entry.fileName);
  return [...upFront.values()];
}

/** The ids of the modules with code in `chunks`. */
export function renderedModules(chunks: readonly Rolldown.OutputChunk[]): string[] {
  return chunks.flatMap((chunk) =>
    Object.entries(chunk.modules)
      .filter(([, module]) => module.renderedLength > 0)
      .map(([id]) => id),
  );
}

/**
 * Whether a module is part of the evs compiler. The plugin reads this from the imports of the
 * package's files; the tests name the directories and files, so the two cannot be wrong in the
 * same way.
 */
export function isCompilerModule(id: string): boolean {
  return /\/evs\/dist\/(?:compile\.js|builder\/|codegen\/|ir\/(?:dce|interp|validate))/.test(id);
}

/** The message of a build that must fail. */
export async function buildFailure(entry: string, options?: BuildOptions): Promise<string> {
  try {
    await buildApp(entry, options);
  } catch (error) {
    return error instanceof Error ? stripVTControlCharacters(error.message) : String(error);
  }
  throw new Error(`expected the build of ${entry} to fail`);
}
