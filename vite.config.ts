import { defineConfig } from 'vite-plus';

import evsConfig from './packages/evs/vite.config.ts';
import pluginConfig from './packages/vite-plugin-evs/vite.config.ts';

// Shared toolchain config for the whole workspace (Vite+): formatter, linter, and the test
// projects. Per-package Vite/Vitest config stays next to the package; the test projects of the
// library and of the Vite plugin (their own vite.config.ts, the single source of truth) are
// re-rooted here so `vp test --project unit|types|integration|plugin|plugin-integration` works
// from the repo root — vitest does not flatten nested `projects` out of a referenced package
// config.
function projectsOf(config: typeof evsConfig, root: string) {
  return (config.test?.projects ?? []).map((project) => {
    if (
      typeof project === 'string' ||
      typeof project === 'function' ||
      project instanceof Promise
    ) {
      throw new TypeError(`${root}/vite.config.ts projects must be inline config objects`);
    }
    return Object.assign({}, project, { root });
  });
}

const generatedAndVendored = [
  '**/dist/**',
  '**/coverage/**',
  '**/contracts/out/**',
  '**/contracts/cache/**',
  '**/contracts/lib/**',
  '**/test/generated/**',
];

export default defineConfig({
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
    arrowParens: 'always',
    endOfLine: 'lf',
    sortImports: { internalPattern: ['@maxencerb/'] },
    sortPackageJson: true,
    ignorePatterns: [
      ...generatedAndVendored,
      'apps/docs/src/content/**',
      '**/.astro/**',
      '**/.wrangler/**',
      '**/.snippets/**',
      '.changeset/*.md',
      // Written by changesets on the "Version Packages" PR in its own markdown style
      // (`format: false` in .changeset/config.json); checking it made that PR's CI fail.
      '**/CHANGELOG.md',
      'README.md', // root symlink → packages/evs/README.md (formatted through its real path)
    ],
  },
  lint: {
    plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'promise', 'node'],
    categories: {
      correctness: 'error',
      suspicious: 'warn',
      perf: 'warn',
    },
    options: {
      typeAware: true,
      typeCheck: true,
      reportUnusedDisableDirectives: 'warn',
    },
    env: {
      'shared-node-browser': true,
      es2026: true,
    },
    rules: {
      'typescript/no-floating-promises': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/await-thenable': 'error',
      'typescript/strict-boolean-expressions': 'error',
      'import/no-cycle': 'error',
      'no-console': 'warn',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    ignorePatterns: [...generatedAndVendored, 'apps/docs/**'],
    overrides: [
      {
        files: ['**/*.test.ts', '**/*.test-d.ts', '**/test/**'],
        plugins: ['vitest'],
        rules: {
          'vitest/no-focused-tests': 'error',
          'typescript/no-explicit-any': 'off',
          'no-console': 'off',
          // oxlint >= 1.85 (Vite+ 1.0) flags fixture builders declared inside `describe`/`it`;
          // keeping them next to the one test that uses them is deliberate.
          'unicorn/consistent-function-scoping': 'off',
        },
      },
      {
        // The library takes abitype's types through viem (a required peer that pins its own
        // abitype): a direct `abitype` import needs a dependency of its own, which installs a
        // second copy next to viem's, and an app's abitype `Register` augmentation would then
        // reach only one of them.
        files: ['packages/evs/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              paths: [
                {
                  name: 'abitype',
                  message: "import abitype's types from 'viem', which re-exports them",
                },
              ],
            },
          ],
        },
      },
      {
        // A published Vite plugin imports its peer by its real name, and so does the example
        // app a user copies: `vite-plus` is this repository's toolchain, not something a user
        // of the plugin has installed.
        files: ['packages/vite-plugin-evs/src/**', 'examples/vite-precompile/**'],
        rules: {
          'vite-plus/prefer-vite-plus-imports': 'off',
        },
      },
      {
        files: ['examples/**'],
        rules: {
          'no-console': 'off',
          'no-await-in-loop': 'off',
        },
      },
      {
        // The plugin's benchmark prints its tables.
        files: ['packages/vite-plugin-evs/scripts/**'],
        rules: {
          'no-console': 'off',
        },
      },
      {
        files: ['packages/evs/test/integration/**'],
        plugins: ['vitest'],
        rules: {
          'vitest/no-conditional-expect': 'off',
          'no-await-in-loop': 'off',
          'typescript/no-unsafe-type-assertion': 'off',
          // `abi: X as Abi` / `args: v as never` widenings are load-bearing there: they stop
          // viem's generic inference from going "excessively deep" on the fixture ABIs.
          'typescript/no-unnecessary-type-assertion': 'off',
        },
      },
    ],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
  },
  test: {
    projects: [
      ...projectsOf(evsConfig, './packages/evs'),
      ...projectsOf(pluginConfig, './packages/vite-plugin-evs'),
    ],
    // Vitest 5 matches coverage globs against paths relative to the project root
    // (packages/evs); the old repo-relative `packages/evs/src/**` matched nothing there.
    // Same file set as under Vitest 4 (plus the src/index.ts barrel).
    coverage: { provider: 'v8', include: ['src/**/*.ts'] },
  },
});
