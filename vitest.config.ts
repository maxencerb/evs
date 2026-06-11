import { defineConfig } from 'vitest/config';

import evsConfig from './packages/evs/vitest.config.ts';

// Deviation from repo-layout.md §8 (`projects: ['packages/*/vitest.config.ts']`): vitest 3.2
// does NOT flatten nested `projects` out of a referenced package config — the glob registers
// one opaque project per package and `--project unit` matches nothing. The package config
// stays the single source of truth (testing.md §1); its projects are re-rooted here so
// `vitest run --project unit|types|integration` works from the repo root.
const evsProjects = (evsConfig.test?.projects ?? []).map((project) => {
  if (typeof project === 'string' || typeof project === 'function' || project instanceof Promise) {
    throw new TypeError('packages/evs/vitest.config.ts projects must be inline config objects');
  }
  return Object.assign({}, project, { root: './packages/evs' });
});

export default defineConfig({
  test: {
    projects: evsProjects,
    coverage: { provider: 'v8', include: ['packages/evs/src/**'] },
  },
});
