// pnpm hooks for the workspace. pnpm loads this file for every install and every pack/publish;
// editing it changes `pnpmfileChecksum` in pnpm-lock.yaml, so re-run `vp install` after an edit
// (a stale checksum fails `--frozen-lockfile` in CI and on the docs build).
'use strict';

const PUBLISHED = '@maxencerb/evs';

module.exports = {
  hooks: {
    // Runs on the manifest `pnpm pack` / `pnpm publish` writes into the tarball (the release's
    // `changeset publish` goes through `pnpm publish`), after pnpm has rewritten the `catalog:` /
    // `workspace:` specs and dropped the publish lifecycle scripts; the package.json on disk is
    // never touched. The repository's scripts, devDependencies and `//` comment fields mean
    // nothing to a consumer (npm never installs a dependency's devDependencies), so the published
    // manifest leaves them out.
    beforePacking(manifest) {
      if (manifest.name !== PUBLISHED) return manifest;
      const packed = { ...manifest };
      delete packed.scripts;
      delete packed.devDependencies;
      for (const key of Object.keys(packed)) {
        if (key.startsWith('//')) delete packed[key];
      }
      return packed;
    },
  },
};
