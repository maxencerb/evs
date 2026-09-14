# Changesets

This repo versions `@maxencerb/evs` with [changesets](https://github.com/changesets/changesets).

- Made a user-visible change to the library? Run `bun run changeset` (or `bunx changeset`) and
  commit the generated `.changeset/*.md` file with your PR.
- Tooling-only change? Skip the changeset — nothing is released.
- On merge to `main`, `release.yml` opens/updates a "Version Packages" PR. Merging that PR
  publishes to npm via OIDC trusted publishing and tags the release.

See `RELEASING.md` for the full flow.
