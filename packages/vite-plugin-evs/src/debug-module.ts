/**
 * `debug-module.ts` — the virtual modules that hold the scripts' debug data.
 *
 * A precompiled script loads its debug data on the first `explainRevert()`, through a dynamic
 * import. Each script gets a virtual module of its own for it, so the bundler emits the data as
 * an on-demand chunk, apart from the chunk that holds the scripts.
 *
 * The module's name is a hash of the data and a label. The hash is there because a browser
 * caches a module by its URL: when a script changes while the dev server runs, its new code
 * must import a new module. The label, the file's base name and the export, only gives the
 * emitted chunk a name a person recognizes. It ends in `.js` so the dev server serves it as a
 * script.
 *
 * The name holds no path. An output chunk therefore says nothing about the machine it was built
 * on, and a dev server, which anyone who reaches it can ask for any name, has no file to read
 * or run for one: a name is only ever looked up among the modules the plugin wrote.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const PREFIX = 'virtual:evs-debug:';

/** What the generated code imports: `virtual:evs-debug:<hash>/<file>.<export>.debug.js`. */
export const DEBUG_MODULE_SPECIFIER = /^virtual:evs-debug:/;

/** The resolved id: the specifier behind `\0`, which keeps other plugins away from it. */
export const DEBUG_MODULE_ID = /^\0virtual:evs-debug:/;

/**
 * The specifier of the module that serves `debugJson`, the debug data of the script that the
 * build-time module `file` exports as `exportName`.
 */
export function debugModuleSpecifier(file: string, exportName: string, debugJson: string): string {
  const hash = createHash('sha256').update(debugJson).digest('hex').slice(0, 8);
  const baseName = posix.basename(file).replace(/\.[^.]+$/, ''); // `pool.evs.ts` → `pool.evs`
  // an export name is any string: only what is safe in a file name and in a URL is kept
  const label = `${baseName}.${exportName}`.replace(/[^\w$.-]/g, '_');
  return `${PREFIX}${hash}/${label}.debug.js`;
}

export function debugModuleId(specifier: string): string {
  return `\0${specifier}`;
}

export function debugModuleCode(debugJson: string): string {
  return `export default ${debugJson};\n`;
}
