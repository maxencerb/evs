/**
 * Snippet typecheck gate for the docs site.
 *
 * Extracts every ```ts / ```typescript fence from src/content/docs into .snippets/ as one
 * module each (an `export {}` is appended so identifiers never collide across snippets) and
 * runs `tsc --noEmit` over the lot, with `@maxencerb/evs` and `viem` resolvable.
 *
 * Conventions enforced on doc authors:
 * - every ts fence must typecheck STANDALONE (own imports included) — that keeps examples
 *   copy-pasteable;
 * - fences that intentionally do not typecheck (staging-misuse demos etc.) opt out with a
 *   `nocheck` word in the fence meta: ```ts nocheck
 *
 * Requires `@maxencerb/evs` to be built first (`bun run build` at the repo root) — the
 * package resolves through its dist/ types. Run via `bun run check:snippets`.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const docsRoot = new URL('..', import.meta.url).pathname;
const contentDir = join(docsRoot, 'src/content/docs');
const scratchDir = join(docsRoot, '.snippets');

interface Snippet {
  page: string;
  line: number;
  code: string;
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
    if (!/\bnocheck\b/.test(meta)) snippets.push({ page, line: fenceLine, code: body.join('\n') });
  }
  return snippets;
}

const pages = await collectPages(contentDir);
const all: Array<Snippet & { file: string }> = [];
for (const page of pages) {
  const source = await readFile(page, 'utf8');
  for (const snippet of extractSnippets(page, source)) {
    const file = `snippet-${String(all.length).padStart(3, '0')}.ts`;
    all.push({ ...snippet, file });
  }
}

await rm(scratchDir, { recursive: true, force: true });
await mkdir(scratchDir, { recursive: true });

for (const { file, page, line, code } of all) {
  const header = `// from ${relative(docsRoot, page)}:${line}\n`;
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
      include: ['*.ts'],
    },
    null,
    2,
  )}\n`,
);

console.log(`checking ${all.length} snippet(s) from ${pages.length} page(s)…`);

const tsc = spawnSync('bunx', ['tsc', '-p', join(scratchDir, 'tsconfig.json'), '--pretty'], {
  cwd: docsRoot,
  stdio: 'inherit',
});
if (tsc.status !== 0) {
  console.error(
    '\nsnippet typecheck FAILED — each .snippets/*.ts header names its source page:line.',
  );
  process.exit(tsc.status ?? 1);
}
console.log('all snippets typecheck.');
