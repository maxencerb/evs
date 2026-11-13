import { defineConfig, type Plugin } from 'vite-plus';

/**
 * `sourcemap: true` makes the bundler end every output file with a `sourceMappingURL` comment,
 * the declaration files included, and `dts.sourcemap: false` then drops the declaration maps
 * those comments name. This takes the comments out, so no published file points at a missing
 * one. (packages/evs/vite.config.ts has the same plugin.)
 */
const noDeclarationMapComment: Plugin = {
  name: 'no-declaration-map-comment',
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type !== 'chunk' || !file.fileName.endsWith('.d.ts')) continue;
      file.code = file.code.replace(/\n\/\/# sourceMappingURL=\S+\.d\.ts\.map\s*$/, '\n');
    }
  },
};

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
    plugins: [noDeclarationMapComment],
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
