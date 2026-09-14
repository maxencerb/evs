# Releasing @maxencerb/evs

Releases are driven by **[changesets](https://github.com/changesets/changesets)** and
`.github/workflows/release.yml`, which publishes to npm via **OIDC trusted publishing** —
no token stored anywhere.

## Day to day

1. In a PR that changes the library in a user-visible way, run `vp run changeset` (or
   `bunx changeset`), pick the bump (`patch` / `minor` / `major`), write the changelog line,
   and commit the generated `.changeset/*.md`. Tooling-only PRs need no changeset.
2. Merge to `main`. `release.yml` sees pending changesets and opens / refreshes the
   **"chore(release): version packages"** PR: it bumps `packages/evs/package.json`, writes
   `packages/evs/CHANGELOG.md`, deletes the consumed changesets and re-syncs `bun.lock`.
3. Merge that PR. `release.yml` now finds no changesets and a version that is not on npm,
   re-runs the full gate (contracts → build → `vp run check` → unit/type → integration),
   then runs `scripts/publish.ts`:
   `bun pm pack` → `publint` → `npm publish <tarball> --provenance` → `changeset git-tag`.
   The action pushes the `@maxencerb/evs@X.Y.Z` tag and creates the GitHub release from the
   changelog entry. Watch it: `gh run watch --repo maxencerb/evs`.

The committed version in `packages/evs/package.json` is always the **last released**
version; only the release PR changes it.

### Why `bun pm pack` + `npm publish` (and not `bun publish` / `changeset publish`)

- `bun publish` cannot do npm OIDC trusted publishing (oven-sh/bun#22423 — still open; the
  OIDC PR #29374 was closed unmerged). The upload must be the npm CLI (>= 11.5.1; Node 24
  bundles a newer one, and the workflow upgrades npm anyway).
- `npm publish <dir>` (what `changeset publish` does) ships `catalog:` and `workspace:`
  specs verbatim. `bun pm pack` rewrites both to concrete ranges, and npm happily publishes
  a prebuilt tarball with provenance.

### Prereleases

```sh
bunx changeset pre enter beta   # commit; subsequent version PRs produce X.Y.Z-beta.N
bunx changeset pre exit         # commit; the next version PR produces the stable X.Y.Z
```

`scripts/publish.ts` publishes any version with a prerelease component under the `next`
dist-tag, stable versions under `latest`.

## One-time setup (already done for this repo)

- npm cannot use trusted publishing for a package's **first** publish (npm/cli#8544); the
  package was bootstrapped by hand, and the trusted publisher on npmjs.com → `@maxencerb/evs`
  → **Settings → Trusted publishing → GitHub Actions** is configured with EXACTLY
  (case-sensitive): organization `maxencerb`, repository `evs`, workflow filename
  `release.yml`, environment blank. **Do not rename `release.yml`.**
- GitHub → Settings → Actions → General: **"Allow GitHub Actions to create and approve pull
  requests"** must be enabled (the version PR is opened by `github-actions[bot]`).
- The repo is public and releases publish **with provenance attestations**
  (`publishConfig.provenance: true` + `--provenance`). If the repo ever goes private again,
  flip both off or publishes fail.
