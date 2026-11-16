/**
 * What the plugin's test projects check before they run: the library's build, and for the
 * integration project an anvil. Each missing one is a single error that says what to do.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, expect, test, vi } from 'vite-plus/test';

import { SetupError } from '../../evs/test/setup/setup-error.ts';
import integrationSetup from './integration/global-setup.ts';
import { requireLibraryBuild } from './setup/library-build.ts';

const scratch = mkdtempSync(join(tmpdir(), 'evs-plugin-setup-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

/** The `SetupError` a check throws. */
function failureOf(check: () => void): SetupError {
  try {
    check();
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error('the check passed');
}

test('a library that was never built: one error that names the build', () => {
  const { message, stack } = failureOf(() =>
    requireLibraryBuild({ dir: join(scratch, 'never-built') }),
  );
  expect(message).toMatch(/^packages\/evs\/dist is missing: /);
  expect(message).toContain('`vp run build`');
  expect(message).toContain('`vp run bootstrap`');
  // the message is the report: no frames for the test runner to print under it
  expect(stack).toBe(`SetupError: ${message}`);
});

test('a build with one entry only is not a build', () => {
  const dir = join(scratch, 'half-built');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.js'), '');
  expect(() => requireLibraryBuild({ dir })).toThrow(SetupError);
  writeFileSync(join(dir, 'runtime.js'), '');
  expect(() => requireLibraryBuild({ dir })).not.toThrow();
});

test("the built library of this checkout passes (the run's global setup has checked it)", () => {
  expect(() => requireLibraryBuild()).not.toThrow();
});

test('the integration setup without anvil on the PATH: fails at once, says to install Foundry', async () => {
  vi.stubEnv('PATH', mkdtempSync(join(scratch, 'empty-')));
  const provided: string[] = [];
  const project = { provide: (key: string) => void provided.push(key) };
  await expect(integrationSetup(project)).rejects.toThrow(
    'anvil was not found on the PATH: install Foundry (https://getfoundry.sh)',
  );
  expect(provided).toStrictEqual([]);
}, 5_000);
