/**
 * Global setup of the `unit` and `types` projects, and the first check of the `integration`
 * one: the contract fixtures must have been generated.
 *
 * `test/generated/` is gitignored and written by the contracts codegen. Test files import it
 * (two unit files, most integration files), and the type tests check the whole package, `test/`
 * included. Without this check a fresh checkout fails with a resolver error per importing file
 * and a type error per import, none of which says what to run.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SetupError } from './setup-error.ts';

const GENERATED_DIR = fileURLToPath(new URL('../generated/', import.meta.url));

export interface RequireContractFixturesOptions {
  /** The directory the codegen writes to. Defaults to `packages/evs/test/generated/`. */
  dir?: string;
}

/** Throws, with the command to run, unless the contract fixtures are on disk. */
export function requireContractFixtures(options: RequireContractFixturesOptions = {}): void {
  const { dir = GENERATED_DIR } = options;
  if (existsSync(join(dir, 'index.ts'))) return;
  throw new SetupError(
    'packages/evs/test/generated is missing: the tests import the contract fixtures it holds. ' +
      'Run `vp run codegen` in packages/contracts, or `vp run bootstrap` at the repository ' +
      'root on a fresh checkout (both need Foundry: https://getfoundry.sh).',
  );
}

export default function setup(): void {
  requireContractFixtures();
}
