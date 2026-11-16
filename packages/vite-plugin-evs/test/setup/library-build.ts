/**
 * Global setup of the `plugin` project, and the first check of the `plugin-integration` one:
 * the library must have been built.
 *
 * The plugin's tests run `@maxencerb/evs` as an app does, through its `exports`, which point
 * into the library's `dist/`. Without this check a checkout that was never built fails with
 * "Cannot find package '@maxencerb/evs/runtime'" in every file, which does not say what to run.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SetupError } from '../../../evs/test/setup/setup-error.ts';

const LIBRARY_DIST = fileURLToPath(new URL('../../../evs/dist/', import.meta.url));

export interface RequireLibraryBuildOptions {
  /** The library's build output. Defaults to `packages/evs/dist/`. */
  dir?: string;
}

/** Throws, with the command to run, unless both entries of the library are built. */
export function requireLibraryBuild(options: RequireLibraryBuildOptions = {}): void {
  const { dir = LIBRARY_DIST } = options;
  if (existsSync(join(dir, 'index.js')) && existsSync(join(dir, 'runtime.js'))) return;
  throw new SetupError(
    "packages/evs/dist is missing: the plugin's tests run the built library. " +
      'Run `vp run build` at the repository root, or `vp run bootstrap` on a fresh checkout.',
  );
}

export default function setup(): void {
  requireLibraryBuild();
}
