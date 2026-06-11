/**
 * Standalone vitest config for the harness's own tests (module-interfaces §M10 "Tests of
 * the harness itself").
 *
 * The scaffolded package config (testing.md §1, frozen) only includes `src/**` in the
 * `unit` project, so the harness self-tests carry their own config:
 *
 *   bunx vitest run -c test/harness/vitest.harness.config.ts --project unit
 */

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    name: 'unit',
    include: ['test/harness/**/*.test.ts'],
    environment: 'node',
  },
});
