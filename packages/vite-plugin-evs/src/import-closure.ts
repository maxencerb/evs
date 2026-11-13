/**
 * `import-closure.ts` — the files an ES module reaches through its relative imports, read from
 * disk.
 *
 * Each file is parsed, and its `import` and `export ... from` statements are followed, as are
 * its dynamic `import('...')` of a string literal. A relative specifier names a file, found
 * from the directory of the file that holds it; any other specifier (a package) is left alone.
 * That is exact for a package published like evs: unbundled ES modules that name each other by
 * a relative path with its extension, so there is nothing to resolve.
 *
 * Files are named the way the bundler names modules, by an absolute path with forward slashes
 * on every platform, and nothing here rewrites a path (no real path, no other separator): the
 * closure of a module id holds the ids the bundler gives the same files.
 */

import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import { parseSync } from 'vite';

export interface ImportClosure {
  /** The entry and every file it reaches. */
  readonly files: ReadonlySet<string>;
  /** Among them, the files a dynamic import names: what is loaded on demand. */
  readonly onDemand: ReadonlySet<string>;
}

/** Walks the relative imports of `entry`, static and dynamic alike. */
export async function importClosureOf(entry: string): Promise<ImportClosure> {
  const files = new Set<string>();
  const onDemand = new Set<string>();

  async function visit(file: string): Promise<void> {
    if (files.has(file)) return;
    files.add(file);
    const imports = await relativeImportsOf(file);
    for (const imported of imports.dynamic) onDemand.add(imported);
    await Promise.all([...imports.static, ...imports.dynamic].map(visit));
  }

  await visit(entry);
  return { files, onDemand };
}

interface RelativeImports {
  readonly static: readonly string[];
  readonly dynamic: readonly string[];
}

/** The files `file` imports by a relative path. */
async function relativeImportsOf(file: string): Promise<RelativeImports> {
  const code = await readFile(file, 'utf8');
  // `module` is the parser's own list of the imports and exports: no syntax tree to walk
  const { module } = parseSync(file, code);
  const directory = posix.dirname(file);
  const filesOf = (specifiers: readonly (string | undefined)[]): string[] =>
    specifiers.filter(isRelative).map((specifier) => posix.join(directory, specifier));

  return {
    static: filesOf([
      ...module.staticImports.map((statement) => statement.moduleRequest.value),
      ...module.staticExports.flatMap((statement) =>
        statement.entries.map((entry) => entry.moduleRequest?.value),
      ),
    ]),
    // a dynamic import is listed with the position of its argument, which can be any expression
    dynamic: filesOf(
      module.dynamicImports.map(({ moduleRequest }) =>
        stringLiteralValue(code.slice(moduleRequest.start, moduleRequest.end)),
      ),
    ),
  };
}

function isRelative(specifier: string | undefined): specifier is string {
  return specifier !== undefined && /^\.\.?\//.test(specifier);
}

/** What the string literal `source` holds: `"./explain.js"` → `./explain.js`. `undefined` for
 *  any other expression, and for a literal with an escape, which no file path needs. */
function stringLiteralValue(source: string): string | undefined {
  return /^(["'])([^"'\\]*)\1$/.exec(source)?.[2];
}
