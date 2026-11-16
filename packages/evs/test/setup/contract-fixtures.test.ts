import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'vite-plus/test';

import { requireContractFixtures } from './contract-fixtures.ts';
import { SetupError } from './setup-error.ts';

const scratch = mkdtempSync(join(tmpdir(), 'evs-contract-fixtures-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

test('a checkout without generated fixtures: one error that names the commands', () => {
  const { message, stack } = failureOf(() =>
    requireContractFixtures({ dir: join(scratch, 'never-generated') }),
  );
  expect(message).toMatch(/^packages\/evs\/test\/generated is missing: /);
  expect(message).toContain('`vp run codegen` in packages/contracts');
  expect(message).toContain('`vp run bootstrap`');
  expect(message).toContain('https://getfoundry.sh');
  // the message is the report: no frames for the test runner to print under it
  expect(stack).toBe(`SetupError: ${message}`);
});

test('generated fixtures on disk: no error', () => {
  const dir = join(scratch, 'generated');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.ts'), '');
  expect(() => requireContractFixtures({ dir })).not.toThrow();
  // the default is this checkout's own directory, which the run's global setup has checked
  expect(() => requireContractFixtures()).not.toThrow();
});
