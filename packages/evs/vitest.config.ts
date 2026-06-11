import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' },
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
