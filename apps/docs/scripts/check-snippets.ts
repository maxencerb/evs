/**
 * Snippet typecheck gate for the docs site.
 *
 * Extracts every ```ts / ```typescript fence from src/content/docs into .snippets/, one
 * directory per page and one module per fence (an `export {}` is appended so identifiers never
 * collide across snippets), and runs `tsc --noEmit` over the lot, with `@maxencerb/evs` and
 * `viem` resolvable.
 *
 * Conventions enforced on doc authors:
 * - every ts fence must typecheck STANDALONE (own imports included) — that keeps examples
 *   copy-pasteable;
 * - a fence titled with a file name (`title="abi.ts"`) is written under that name, so the other
 *   fences of the SAME page can import it (`import { poolAbi } from './abi'`): that is how a
 *   tabbed `script.ts` / `abi.ts` example typechecks. When a title repeats on a page, the first
 *   fence owns the name;
 * - fences that intentionally do not typecheck (staging-misuse demos etc.) opt out with a
 *   `nocheck` word in the fence meta: ```ts nocheck
 *
 * Line ranges in a fence's meta (`collapse={1-8}`, the `{12}` / `{3-5}` line markers) must fall
 * inside the fence: a range past the last line is reported here instead of rendering silently
 * wrong.
 *
 * Arguments narrow the run to the pages whose path contains one of them
 * (`pnpm run check:snippets reference/builder guides/calls`): a partial run writes to its own
 * scratch directory, so several can run side by side. No argument checks everything.
 *
 * Requires `@maxencerb/evs` to be built first (`pnpm run build` / `vp run build` at the repo
 * root) — the package resolves through its dist/ types. Run via `pnpm run check:snippets` (plain
 * Node, no Vite+ needed: the Cloudflare docs build runs it).
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsRoot = fileURLToPath(new URL('..', import.meta.url));
const contentDir = join(docsRoot, 'src/content/docs');
const filters = process.argv.slice(2);
// The full gate owns `.snippets/` itself; a filtered run gets a private subdirectory, removed
// again when it passes.
const scratchRoot = join(docsRoot, '.snippets');
const scratchDir = filters.length > 0 ? join(scratchRoot, `partial-${process.pid}`) : scratchRoot;

interface Snippet {
  page: string;
  line: number;
  code: string;
  meta: string;
  checked: boolean;
}

async function collectPages(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectPages(full)));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function extractSnippets(page: string, source: string): Snippet[] {
  const snippets: Snippet[] = [];
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length) {
    const open = /^(\s*)```(ts|typescript)\b(.*)$/.exec(lines[i] ?? '');
    if (open === null) {
      i += 1;
      continue;
    }
    const [, indent = '', , meta = ''] = open;
    const fenceLine = i + 1; // 1-based line of the opening fence
    const body: string[] = [];
    i += 1;
    while (i < lines.length && (lines[i] ?? '').trim() !== '```') {
      const line = lines[i] ?? '';
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line);
      i += 1;
    }
    i += 1; // skip the closing fence
    snippets.push({
      page,
      line: fenceLine,
      code: body.join('\n'),
      meta,
      checked: !/\bnocheck\b/.test(meta),
    });
  }
  return snippets;
}

/** Every line number named by a `{…}` group of the fence meta (`collapse={1-8}`, `{12}`, `{3-5, 9}`). */
function metaLines(meta: string): number[] {
  const lines: number[] = [];
  for (const group of meta.matchAll(/\{([\d\s,-]+)\}/g)) {
    for (const n of (group[1] ?? '').matchAll(/\d+/g)) lines.push(Number(n[0]));
  }
  return lines;
}

const pages = (await collectPages(contentDir)).filter(
  (page) => filters.length === 0 || filters.some((f) => relative(contentDir, page).includes(f)),
);
if (pages.length === 0) {
  console.error(`no page under src/content/docs matches: ${filters.join(', ')}`);
  process.exit(1);
}

const all: Array<Snippet & { file: string }> = [];
const rangeErrors: string[] = [];
for (const page of pages) {
  const source = await readFile(page, 'utf8');
  const rel = relative(contentDir, page);
  for (const snippet of extractSnippets(page, source)) {
    const length = snippet.code.split('\n').length;
    const past = metaLines(snippet.meta).filter((n) => n < 1 || n > length);
    if (past.length > 0) {
      rangeErrors.push(
        `${rel}:${snippet.line} meta names line ${past.join(', ')} but the fence has ${length} line(s)`,
      );
    }
    if (!snippet.checked) continue;
    // one directory per page; the file is the fence's title when it names a .ts file (so sibling
    // fences can import it), else its line: a tsc error then reads as page + file or fence line
    const dir = rel.replace(/\.mdx?$/, '').replaceAll('/', '__');
    const title = /\btitle=(["'])([\w.-]+\.ts)\1/.exec(snippet.meta)?.[2];
    const named = title === undefined ? undefined : `${dir}/${title}`;
    const file =
      named !== undefined && !all.some((s) => s.file === named)
        ? named
        : `${dir}/L${snippet.line}.ts`;
    all.push({ ...snippet, file });
  }
}

if (rangeErrors.length > 0) {
  console.error(`fence meta line range(s) out of bounds:\n  ${rangeErrors.join('\n  ')}`);
  process.exit(1);
}

await rm(scratchDir, { recursive: true, force: true });
await mkdir(scratchDir, { recursive: true });

for (const { file, page, line, code } of all) {
  const header = `// from ${relative(docsRoot, page)}:${line}\n`;
  await mkdir(dirname(join(scratchDir, file)), { recursive: true });
  await writeFile(join(scratchDir, file), `${header}${code}\n\nexport {};\n`);
}

await writeFile(
  join(scratchDir, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'es2022',
        lib: ['es2023'],
        module: 'esnext',
        moduleResolution: 'bundler',
        types: [],
      },
      include: ['**/*.ts'],
    },
    null,
    2,
  )}\n`,
);

console.log(`checking ${all.length} snippet(s) from ${pages.length} page(s)…`);

// The workspace's own TypeScript, run on the current Node (no package-manager executor needed).
const tscBin = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const tsc = spawnSync(
  process.execPath,
  [tscBin, '-p', join(scratchDir, 'tsconfig.json'), '--pretty'],
  { cwd: docsRoot, stdio: 'inherit' },
);
if (tsc.status !== 0) {
  console.error(
    `\nsnippet typecheck FAILED — files are <page>/L<fence line>.ts or <page>/<fence title> (kept in ${relative(docsRoot, scratchDir)}/).`,
  );
  process.exit(tsc.status ?? 1);
}
if (filters.length > 0) await rm(scratchDir, { recursive: true, force: true });
console.log('all snippets typecheck.');
