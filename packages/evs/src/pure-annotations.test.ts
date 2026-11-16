/**
 * Where the pure-call marker may be written in the sources.
 *
 * A bundler drops an unused call marked with a `__PURE__` comment, which is how a bundle that
 * only hydrates loses the tables it never reads. But Rollup looks for the marker in every
 * comment, and warns about one it cannot attach to a call: a doc comment that merely names the
 * marker makes every app that bundles the library print a warning on each build. Comments
 * survive into `dist`, so the sources may only ever spell it on a call.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The marker directly on a call or a `new`: the only spelling a bundler can use. */
const ON_A_CALL = /^\/\* @__PURE__ \*\/ (?:new )?[A-Za-z_$][\w$.]*\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !/\.test(?:-d)?\.ts$/.test(entry.name) ? [path] : [];
  });
}

test('the pure-call marker is only written on a call', () => {
  const misplaced: string[] = [];
  let found = 0;
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/__PURE__/g)) {
      found += 1;
      // the marker sits 4 characters into `/* @__PURE__ */`
      const comment = source.slice(Math.max(0, match.index - 4));
      if (ON_A_CALL.test(comment)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      misplaced.push(`${relative(SRC, file)}:${line}`);
    }
  }
  expect(misplaced).toEqual([]);
  // the scan has something to find: the hex table of `core/bytes.ts` is marked
  expect(found).toBeGreaterThan(0);
});
