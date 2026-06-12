import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Deviation from testing.md §1 (include was `src/**/*.test.ts` only), recorded in
        // docs/design/amendments.md: the M10 harness self-tests (test/harness/*.test.ts,
        // in-process @ethereumjs/evm — no anvil needed) run in the `unit` project so the
        // regular `bun run test` flow exercises them. The `integration` project
        // (test/integration/**) is unaffected.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/harness/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'types',
          include: ['src/**/*.test-d.ts'],
          typecheck: { enabled: true, only: true, include: ['src/**/*.test-d.ts'] },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
