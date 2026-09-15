import { defineConfig } from 'vite-plus';

import evsConfig from './packages/evs/vite.config.ts';

// Shared toolchain config for the whole workspace (Vite+): formatter, linter, and the test
// projects. Per-package Vite/Vitest config stays next to the package; the library's test
// projects (packages/evs/vite.config.ts, the single source of truth per testing.md §1) are
// re-rooted here so `vp test --project unit|types|integration` works from the repo root —
// vitest does not flatten nested `projects` out of a referenced package config.
const evsProjects = (evsConfig.test?.projects ?? []).map((project) => {
  if (typeof project === 'string' || typeof project === 'function' || project instanceof Promise) {
    throw new TypeError('packages/evs/vite.config.ts projects must be inline config objects');
  }
  return Object.assign({}, project, { root: './packages/evs' });
});

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
        },
      },
      {
        files: ['examples/**', 'scripts/**'],
        rules: {
          'no-console': 'off',
          'no-await-in-loop': 'off',
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
    projects: evsProjects,
    coverage: { provider: 'v8', include: ['packages/evs/src/**'] },
  },
});
