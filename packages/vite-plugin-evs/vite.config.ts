import { defineConfig } from 'vite-plus';

export default defineConfig({
  // Plugin build (`vp pack`, tsdown): same shape as the library's (packages/evs/vite.config.ts).
  pack: {
    entry: ['src/index.ts'],
    format: 'esm',
    unbundle: true,
    fixedExtension: false,
    sourcemap: true,
    outputOptions: { sourcemapExcludeSources: false },
    dts: { sourcemap: false },
  },
  test: {
    projects: [
      {
        // Everything that needs no node: the plugin is taken from src/ and drives Vite
        // programmatically over test/fixtures (builds, the dev server), so no dist is needed.
        // It runs the library from its dist, like an app does: build the library first.
        test: {
          name: 'plugin',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        // The built output of a fixture, executed against anvil (foundry must be installed).
        test: {
          name: 'plugin-integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
