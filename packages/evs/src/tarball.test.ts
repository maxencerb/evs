/**
 * Unit tests — what `pnpm publish` puts in the npm tarball. The release publishes with
 * `changeset publish` → `pnpm publish`, which packs exactly like `pnpm pack`, so the tarball is
 * packed here the same way (workspace root, `.pnpmfile.cjs` hooks and all). 0.3.0 shipped no
 * CHANGELOG.md (`files` was `dist` only, and pnpm adds README / LICENSE / package.json but never
 * a changelog), so an app reading the breaking-change notes from `node_modules` found none; its
 * manifest also carried the repository's `scripts` and `devDependencies`, which mean nothing to
 * a consumer.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, expect, test } from 'vite-plus/test';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'evs-tarball-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

interface PackResult {
  filename: string;
  files: { path: string }[];
}

// Lazily packed once for the file's tests (a real pack, not `--dry-run`: the manifest checks
// need the packed package.json, which pnpm rewrites and runs `beforePacking` on).
let packed: { paths: string[]; manifest: Record<string, unknown> } | undefined;
function pack(): NonNullable<typeof packed> {
  if (packed) return packed;
  const stdout = execFileSync('pnpm', ['pack', '--json', '--pack-destination', outDir], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  const result: PackResult = JSON.parse(stdout);
  // pnpm reports the tarball's absolute path when given a destination
  const tgz = resolve(outDir, result.filename);
  const manifest: Record<string, unknown> = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  packed = { paths: result.files.map((file) => file.path), manifest };
  return packed;
}

test('the tarball ships the changelog next to the README and the license', () => {
  const { paths } = pack();
  for (const file of ['CHANGELOG.md', 'README.md', 'LICENSE', 'package.json']) {
    expect(paths).toContain(file);
  }
});

test('everything else in the tarball is the built library (no sources, no tests)', () => {
  const { paths } = pack();
  // `pnpm pack` runs no build (the only build hook is `prepublishOnly`), so without these the
  // test would pass on an unbuilt checkout whose tarball holds the four meta files alone. The
  // entry points are the ones `exports["."]` resolves; run `vp run build` first.
  for (const entry of ['dist/index.js', 'dist/index.d.ts']) {
    expect(paths, `${entry} missing from the tarball: build the library first`).toContain(entry);
  }
  const rest = paths.filter(
    (path) => !['CHANGELOG.md', 'README.md', 'LICENSE', 'package.json'].includes(path),
  );
  for (const path of rest) {
    expect(path).toMatch(/^dist\//);
    expect(path).not.toMatch(/\.test(-d)?\./);
  }
});

test('the packed manifest drops the repository-only fields', () => {
  const { manifest } = pack();
  expect(manifest).not.toHaveProperty('scripts');
  expect(manifest).not.toHaveProperty('devDependencies');
  expect(Object.keys(manifest).filter((key) => key.startsWith('//'))).toEqual([]);
  // what a consumer resolves stays
  expect(manifest).toHaveProperty('exports');
  expect(manifest).toHaveProperty('peerDependencies.viem');
  expect(manifest).toHaveProperty('engines.node');
});
