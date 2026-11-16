/**
 * Type-checks the workspace under every type checker the library supports, so a type that only
 * one of them accepts fails here instead of in an app.
 *
 *   node packages/type-tests/scripts/matrix.ts [--only <checker>[,<checker>…]]
 *
 * Checkers: `tsc-5.5` (the floor of the `typescript` peer range), `tsc-6` (the workspace
 * TypeScript), `tsc-7` (the Go compiler), `bun` (`bun check`) and `tsrs` (the Rust port).
 * Projects: the library with its type tests, the Vite plugin, and this package's fixtures, which
 * use the published declarations as an app would (so the library has to be built first). One
 * more project holds the fixtures of an app on TypeScript's legacy module resolution.
 *
 * `vp run typecheck` already runs the workspace TypeScript on the two packages, and their sources
 * only have to be consumable, not buildable, by the oldest supported TypeScript: those two
 * checkers run the fixtures only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '../..');
const require = createRequire(join(packageDir, 'package.json'));

interface Project {
  /** The project's directory, or its `tsconfig` file when it is not `tsconfig.json`. */
  readonly path: string;
  /** `false`: sources of a package, which only the current compilers have to check. */
  readonly fixtures: boolean;
  /** The only checkers that can run this project; every checker when absent. */
  readonly only?: readonly string[];
}

const PROJECTS: readonly Project[] = [
  { path: 'packages/evs', fixtures: false },
  { path: 'packages/vite-plugin-evs', fixtures: false },
  { path: 'packages/type-tests', fixtures: true },
  // TypeScript's legacy resolution (`moduleResolution: "node"`), which does not read `exports`.
  // TypeScript 6 deprecates it and TypeScript 7 has none, so the floor is the one checker left.
  { path: 'packages/type-tests/tsconfig.node10.json', fixtures: true, only: ['tsc-5.5'] },
];

interface Checker {
  readonly id: string;
  readonly label: string;
  /** `true`: this checker runs the fixtures only (see the file header). */
  readonly fixturesOnly: boolean;
  /** The command that checks the project at `project` (a directory or a `tsconfig` file), or
   *  why this checker cannot run here. */
  command(project: string): readonly string[] | { readonly unavailable: string };
}

/** The `tsc` of the TypeScript this package installs under `name`. Never `.bin/tsc`: three
 *  TypeScript versions are installed here and each one provides that name. */
function tsc(name: string): (dir: string) => readonly string[] {
  const packageJson = require.resolve(`${name}/package.json`);
  const bin = join(dirname(packageJson), 'bin/tsc');
  return (dir) => [process.execPath, bin, '--noEmit', '--pretty', 'false', '-p', dir];
}

/** `bun check` exists since Bun 1.4.3. */
function bunCheck(dir: string): readonly string[] | { readonly unavailable: string } {
  const version = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (version.error !== undefined || version.status !== 0) {
    return { unavailable: 'bun is not installed' };
  }
  const [major = 0, minor = 0, patch = 0] = version.stdout.trim().split('.').map(Number);
  if (major < 1 || (major === 1 && (minor < 4 || (minor === 4 && patch < 3)))) {
    return { unavailable: `bun ${version.stdout.trim()} has no \`bun check\` (needs 1.4.3)` };
  }
  // --no-script: the repository root has a `check` script, which `bun check` would run instead
  return ['bun', 'check', '--no-script', '--no-pretty', '-p', dir];
}

const CHECKERS: readonly Checker[] = [
  { id: 'tsc-5.5', label: 'TypeScript 5.5', fixturesOnly: true, command: tsc('typescript-5.5') },
  { id: 'tsc-6', label: 'TypeScript 6', fixturesOnly: true, command: tsc('typescript') },
  { id: 'tsc-7', label: 'TypeScript 7', fixturesOnly: false, command: tsc('typescript-7') },
  { id: 'bun', label: 'bun check', fixturesOnly: false, command: bunCheck },
  {
    id: 'tsrs',
    label: 'tsrs',
    fixturesOnly: false,
    command: (dir) => [
      join(packageDir, 'node_modules/.bin/tsrs'),
      '--noEmit',
      '--pretty',
      'false',
      '-p',
      dir,
    ],
  },
];

function selectedCheckers(argv: readonly string[]): readonly Checker[] {
  const flag = argv.indexOf('--only');
  if (flag === -1) return CHECKERS;
  const ids = (argv[flag + 1] ?? '').split(',').filter((id) => id !== '');
  const unknown = ids.filter((id) => !CHECKERS.some((checker) => checker.id === id));
  if (ids.length === 0 || unknown.length > 0) {
    const known = CHECKERS.map((checker) => checker.id).join(', ');
    throw new Error(`--only takes checker ids among ${known}; got "${argv[flag + 1] ?? ''}"`);
  }
  return CHECKERS.filter((checker) => ids.includes(checker.id));
}

/** What a checker printed, with the absolute paths of this machine shortened. */
function report(output: string): string {
  return output
    .trim()
    .split('\n')
    .slice(0, 60)
    .map((line) => `    ${line.replaceAll(`${repoRoot}/`, '')}`)
    .join('\n');
}

function main(): number {
  if (!existsSync(join(repoRoot, 'packages/evs/dist/index.d.ts'))) {
    console.error('packages/evs/dist is missing: run `vp run build` first.');
    return 1;
  }
  // a checker that cannot run is a failure in CI, where every one of them is installed
  const strict = process.env['CI'] !== undefined && process.env['CI'] !== '';
  let failures = 0;
  let skipped = 0;
  for (const checker of selectedCheckers(process.argv.slice(2))) {
    for (const project of PROJECTS) {
      if (checker.fixturesOnly && !project.fixtures) continue;
      if (project.only !== undefined && !project.only.includes(checker.id)) continue;
      const cell = `${checker.label.padEnd(14)} ${project.path}`;
      const command = checker.command(join(repoRoot, project.path));
      if ('unavailable' in command) {
        console.log(`${strict ? 'FAIL' : 'skip'}  ${cell}  (${command.unavailable})`);
        if (strict) failures += 1;
        else skipped += 1;
        continue;
      }
      const [bin = '', ...args] = command;
      const started = performance.now();
      const run = spawnSync(bin, args, { cwd: repoRoot, encoding: 'utf8' });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      if (run.status === 0) {
        console.log(`ok    ${cell}  (${seconds} s)`);
        continue;
      }
      failures += 1;
      const why = run.error === undefined ? `exit ${run.status}` : run.error.message;
      console.log(`FAIL  ${cell}  (${why})`);
      console.log(report(`${run.stdout}${run.stderr}`));
      console.log(`    rerun: ${[relative(repoRoot, bin) || bin, ...args].join(' ')}`);
    }
  }
  if (skipped > 0) console.log(`\n${skipped} check(s) skipped: not every checker is installed.`);
  if (failures > 0) console.log(`\n${failures} check(s) failed.`);
  return failures > 0 ? 1 : 0;
}

process.exitCode = main();
