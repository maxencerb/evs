# Releasing @maxencerb/evs

Releases are driven by **GitHub releases**: publishing release `vX.Y.Z` runs
`.github/workflows/release.yml`, which re-runs the full test gate, injects `X.Y.Z` into
`packages/evs/package.json` (the committed version stays `0.0.0` — the tag is the source of
truth), packs with `bun pm pack`, and publishes the tarball with `npm publish` via **OIDC
trusted publishing** — no token stored anywhere.

## One-time bootstrap (manual — npm requires it)

npm cannot use trusted publishing for a package's **first** publish (npm/cli#8544): the
package must already exist before a trusted publisher can be configured. Once, by hand:

```sh
cd packages/evs
bun install && bun run build
npm login                                   # as the owner of the @maxencerb scope
npm version 0.0.1 --no-git-tag-version      # first real version
cd ../.. && bun install                     # re-sync the lockfile before packing
cd packages/evs
TARBALL=$(bun pm pack --quiet)
npm publish "$TARBALL" --access public      # NO --provenance while the repo is private
git checkout -- . && cd ../.. && bun install  # restore version 0.0.0 + lockfile
```

Then configure the trusted publisher on npmjs.com → package `@maxencerb/evs` → **Settings →
Trusted publishing → GitHub Actions**, with EXACTLY (all fields case-sensitive):

| Field                | Value                                        |
| -------------------- | -------------------------------------------- |
| Organization or user | `maxencerb`                                  |
| Repository           | `evs`                                        |
| Workflow filename    | `release.yml`                                |
| Environment          | _(leave blank — the workflow declares none)_ |
| Allowed actions      | npm publish                                  |

Finally **log out / revoke any publish token** — from now on only the workflow publishes.

## Every release after that

1. Make sure `main` is green.
2. GitHub → Releases → "Draft a new release" → tag `vX.Y.Z` (semver; a `-beta.N` suffix
   publishes under the `beta` dist-tag, etc.) → Publish.
3. The workflow does the rest. Watch it: `gh run watch --repo maxencerb/evs`.

## When the repo goes public

Provenance attestations require a public repo. Two coordinated edits (both marked with
comments in place):

1. `packages/evs/package.json` → `publishConfig.provenance`: `false` → `true`.
2. `.github/workflows/release.yml` → enable the `--provenance` flag on the publish step
   (see the comment next to it).
