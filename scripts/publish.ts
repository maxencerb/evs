/**
 * Publish step for `release.yml` (invoked by changesets/action/publish as its `script`).
 *
 * Why not `changeset publish` / `bun publish`:
 * - `bun publish` has no npm OIDC (trusted publishing) support — oven-sh/bun#22423, still
 *   open — so the upload must be the npm CLI.
 * - `npm publish <dir>` / `changeset publish` would ship `catalog:` and `workspace:` specs
 *   verbatim (npm does not understand them); `bun pm pack` rewrites both to concrete ranges.
 *
 * So: `bun pm pack` → `npm publish <tarball> --provenance` (OIDC) → `changeset git-tag`.
 * `changeset git-tag` honours CHANGESETS_OUTPUT (set by the action), which is how the action
 * learns which tags to push and which GitHub releases to create.
 */

import { $ } from 'bun';

const pkgDir = new URL('../packages/evs/', import.meta.url).pathname;
const manifest: unknown = await Bun.file(`${pkgDir}package.json`).json();
if (
  typeof manifest !== 'object' ||
  manifest === null ||
  !('name' in manifest) ||
  !('version' in manifest) ||
  typeof manifest.name !== 'string' ||
  typeof manifest.version !== 'string'
) {
  throw new Error('packages/evs/package.json: expected string `name` and `version`');
}
const pkg = { name: manifest.name, version: manifest.version };

const alreadyPublished = await $`npm view ${pkg.name}@${pkg.version} version`
  .quiet()
  .nothrow()
  .text();
if (alreadyPublished.trim() === pkg.version) {
  console.log(`${pkg.name}@${pkg.version} is already on npm — skipping publish, tagging only.`);
} else {
  // Prerelease versions (1.2.3-beta.1) go to the `next` dist-tag; stable ones to `latest`.
  const distTag = pkg.version.includes('-') ? 'next' : 'latest';

  const tarball = (await $`bun pm pack --quiet`.cwd(pkgDir).text()).trim().split('\n').at(-1);
  if (tarball === undefined || tarball.length === 0)
    throw new Error('bun pm pack produced no tarball');

  await $`bunx publint ${tarball}`.cwd(pkgDir);
  await $`npm publish ${tarball} --access public --provenance --tag ${distTag}`.cwd(pkgDir);
  console.log(`Published ${pkg.name}@${pkg.version} (dist-tag ${distTag}).`);
}

// Creates the annotated `@maxencerb/evs@X.Y.Z` tag locally and reports it through
// CHANGESETS_OUTPUT; changesets/action/publish pushes it and creates the GitHub release.
await $`bunx changeset git-tag`;
