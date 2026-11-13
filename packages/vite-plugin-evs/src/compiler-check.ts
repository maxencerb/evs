/**
 * `compiler-check.ts` — is the evs compiler in the bundle, and how did it get there?
 *
 * Precompiling a script only pays off when nothing else in the app imports the compiler: one
 * module that still calls `evscript()` or `compile()` at run time brings all of it along.
 *
 * "The compiler" is every module of `@maxencerb/evs` that its `runtime` entry does not reach
 * (`evs-package.ts`). A module counts once it has code in an output chunk: tree shaking drops
 * the compiler when an app takes only helpers from the main entry, and that is not reported.
 */

import type { Rolldown } from 'vite';

import type { EvsPackage } from './evs-package.js';
import { displayPath } from './paths.js';

export interface ShippedCompiler {
  /** Its size in the output, as written (minified when the build minifies), before compression. */
  readonly bytes: number;
  /** The output chunks that hold it. */
  readonly chunks: readonly CompilerChunk[];
  /** The modules that import the main entry of evs: where the compiler comes in. */
  readonly importers: readonly string[];
}

interface CompilerChunk {
  readonly fileName: string;
  /** Loaded with the page, or only when a dynamic import asks for it. */
  readonly upFront: boolean;
}

/** Looks for compiler code in `bundle`. `undefined` when there is none. */
export function findShippedCompiler(
  context: Rolldown.PluginContext,
  bundle: Rolldown.OutputBundle,
  evsPackage: EvsPackage,
): ShippedCompiler | undefined {
  // only the main entry exports the compiler: a build without that module holds none of it
  const mainEntry = context.getModuleInfo(evsPackage.mainEntry);
  if (mainEntry === null) return undefined;

  const isCompiler = (id: string): boolean =>
    id.startsWith(evsPackage.root) && !evsPackage.runtimeModules.has(id);

  const outputChunks = Object.values(bundle).filter((output) => output.type === 'chunk');
  const upFront = chunksLoadedUpFront(outputChunks);
  const chunks: CompilerChunk[] = [];
  let bytes = 0;
  for (const chunk of outputChunks) {
    const size = compilerBytes(chunk, isCompiler);
    if (size === 0) continue;
    bytes += size;
    chunks.push({ fileName: chunk.fileName, upFront: upFront.has(chunk.fileName) });
  }
  if (chunks.length === 0) return undefined;

  return { bytes, chunks, importers: [...mainEntry.importers, ...mainEntry.dynamicImporters] };
}

/**
 * How much of `chunk` is compiler code. The bundler reports each module's size before
 * minification, so the compiler's share of those sizes is applied to the chunk as written.
 */
function compilerBytes(chunk: Rolldown.OutputChunk, isCompiler: (id: string) => boolean): number {
  let compiler = 0;
  let total = 0;
  for (const [id, module] of Object.entries(chunk.modules)) {
    total += module.renderedLength;
    if (isCompiler(id)) compiler += module.renderedLength;
  }
  return compiler === 0 ? 0 : Math.round((chunk.code.length * compiler) / total);
}

/** The chunks a page loads before it runs: the entries and what they import statically. */
function chunksLoadedUpFront(chunks: readonly Rolldown.OutputChunk[]): Set<string> {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const upFront = new Set<string>();
  const pending = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (upFront.has(name)) continue;
    upFront.add(name);
    pending.push(...(byName.get(name)?.imports ?? []));
  }
  return upFront;
}

// ---------------------------------------------------------------------------
// the message
// ---------------------------------------------------------------------------

/** What was precompiled in a build: `scripts` scripts, exported by `files` build-time modules. */
export interface PrecompiledCount {
  readonly scripts: number;
  readonly files: number;
}

/** `3 scripts from 2 files`. */
export function describeCount({ scripts, files }: PrecompiledCount): string {
  return `${plural(scripts, 'script')} from ${plural(files, 'file')}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The report of a shipped compiler: where it is, how it got there, and the ways out. */
export function describeShippedCompiler(
  compiler: ShippedCompiler,
  precompiled: PrecompiledCount,
  root: string,
): string {
  const kilobytes = Math.max(1, Math.round(compiler.bytes / 1000));
  const outcome =
    precompiled.scripts === 0
      ? 'No script was precompiled, and the compiler ships in:'
      : `${describeCount(precompiled)} ${precompiled.scripts === 1 ? 'was' : 'were'} ` +
        `precompiled, but the compiler still ships in:`;
  const width = Math.max(...compiler.chunks.map((chunk) => chunk.fileName.length));

  return [
    `The evs compiler is in the client bundle: about ${kilobytes} kB before compression.`,
    '',
    outcome,
    ...compiler.chunks.map(
      (chunk) =>
        `  ${chunk.fileName.padEnd(width)}  ${chunk.upFront ? 'loaded up front' : 'loaded on demand'}`,
    ),
    '',
    `It comes in through the modules that import '@maxencerb/evs':`,
    ...compiler.importers.map((importer) => `  ${displayPath(importer, root)}`),
    '',
    'To keep it out:',
    '  - move the scripts these modules compile into a *.evs.ts file',
    `  - import run-time helpers (decodeScriptError, ...) from '@maxencerb/evs/runtime'`,
    `  - or set evs({ compilerInBundle: 'ignore' }) if compiling in the browser is intended`,
  ].join('\n');
}
