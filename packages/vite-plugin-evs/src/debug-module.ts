/**
 * `debug-module.ts` — the virtual modules that hold the scripts' debug data.
 *
 * A precompiled script loads its debug data on the first `explainRevert()`, through a dynamic
 * import. Each script gets a virtual module of its own for it, so the bundler emits the data as
 * an on-demand chunk, apart from the chunk that holds the scripts.
 *
 * The module's name carries a hash of the data, because a browser caches a module by its URL:
 * when a script changes while the dev server runs, its new code must import a new module.
 * It also carries the path of the build-time module, so a dev server asked for debug data it
 * has not produced yet (a page kept open across a restart) knows which module to run. It ends
 * in `.js` so the dev server serves it as a script.
 */

import { createHash } from 'node:crypto';

const PREFIX = 'virtual:evs-debug:';

/** What the generated code imports: `virtual:evs-debug:<hash>:<file>.debug.js`. */
export const DEBUG_MODULE_SPECIFIER = /^virtual:evs-debug:/;

/** The resolved id: the specifier behind `\0`, which keeps other plugins away from it. */
export const DEBUG_MODULE_ID = /^\0virtual:evs-debug:[0-9a-f]{8}:(.+)\.debug\.js$/;

/** The specifier of the module that serves `debugJson`, the debug data of a script of `file`. */
export function debugModuleSpecifier(file: string, debugJson: string): string {
  const hash = createHash('sha256').update(debugJson).digest('hex').slice(0, 8);
  return `${PREFIX}${hash}:${file}.debug.js`;
}

export function debugModuleId(specifier: string): string {
  return `\0${specifier}`;
}

/** The build-time module whose script a debug module belongs to. */
export function buildTimeModuleOf(id: string): string | undefined {
  return DEBUG_MODULE_ID.exec(id)?.[1];
}

export function debugModuleCode(debugJson: string): string {
  return `export default ${debugJson};\n`;
}
