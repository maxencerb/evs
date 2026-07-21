/**
 * Gate for the playground's premade examples.
 *
 * Always: type-checks every example against the exact d.ts payload Monaco loads
 * (`src/generated/playground-dts.json`) — if this passes, the editor shows no red
 * squiggles for the shipped examples.
 *
 * With `--run`: additionally executes each example against the built runtime
 * bundles (`public/playground/*.js`) and the public mainnet RPC, mirroring the
 * browser run path (import rewrite included). Network-dependent, so not part of
 * the build; run it locally when touching examples or the gen script.
 *
 * Requires `bun scripts/gen-playground.ts` to have run first.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import payload from '../src/generated/playground-dts.json';
import { examples } from '../src/playground/examples.ts';
import { REGISTRY_KEY, rewriteImports } from '../src/playground/rewrite.ts';

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'evs-playground-check-'));

try {
  // Materialize the Monaco virtual FS: file:///node_modules/... → real files.
  for (const [uri, content] of Object.entries(payload.files as Record<string, string>)) {
    const path = join(work, uri.replace('file:///', ''));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  for (const example of examples) {
    writeFileSync(join(work, `${example.id}.ts`), example.code);
  }
  writeFileSync(
    join(work, 'tsconfig.json'),
    JSON.stringify({
      // Mirrors tsconfig.base.json (evs inference relies on exactOptionalPropertyTypes
      // for overload selection) — keep in sync with the Monaco compilerOptions in
      // src/playground/main.ts.
      compilerOptions: {
        target: 'ES2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ['ES2023', 'DOM'],
      },
      include: ['*.ts'],
    }),
  );

  const tsc = spawnSync('bunx', ['tsc', '-p', work], { cwd: docsRoot, encoding: 'utf8' });
  if (tsc.status !== 0) {
    console.error(tsc.stdout || tsc.stderr);
    console.error('playground examples FAILED typecheck against the Monaco d.ts payload');
    process.exit(1);
  }
  console.log(`${examples.length} playground example(s) typecheck against the Monaco payload.`);

  if (process.argv.includes('--run')) {
    const bundles = join(docsRoot, 'public/playground');
    for (const example of examples) {
      // Mirror the browser run path exactly: tsc emit → rewriteImports → execute
      // with the runtime bundles parked on the global registry.
      const emitted = ts.transpileModule(example.code, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
      }).outputText;
      const rewritten = rewriteImports(emitted);
      const prelude = [
        `import * as __evs from '${join(bundles, 'evs.js')}';`,
        `import * as __viem from '${join(bundles, 'viem.js')}';`,
        `globalThis.${REGISTRY_KEY} = { '@maxencerb/evs': __evs, viem: __viem };`,
        `globalThis.__EVS_PLAYGROUND_RPC__ = 'https://ethereum-rpc.publicnode.com';`,
      ].join('\n');
      const file = join(work, `${example.id}.run.mjs`);
      writeFileSync(file, `${prelude}\n${rewritten}`);
      const run = spawnSync('bun', [file], { encoding: 'utf8', timeout: 60_000 });
      if (run.status !== 0) {
        console.error(run.stdout);
        console.error(run.stderr);
        console.error(`playground example '${example.id}' FAILED to execute`);
        process.exit(1);
      }
      console.log(`▶ ${example.id}\n${run.stdout.trimEnd()}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
