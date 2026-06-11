# npm Trusted Publishing (OIDC) from GitHub Releases — Research Report

Research date: 2026-06-11. All claims verified against current npm/GitHub docs and recent (2026) practitioner reports; bun behavior verified locally with **bun 1.3.14**. Written for implementers without web access — all load-bearing details are inlined.

---

## 1. Trusted publisher configuration on npmjs.com

### Where to configure

npmjs.com → sign in → **Packages** → *your package* (`@maxencerb/evs`) → **Settings** tab → **Trusted publishing** section → choose **GitHub Actions**. The direct URL form is `https://www.npmjs.com/package/@maxencerb/evs/access` (the package *access/settings* page — several people report not finding the section because they look at the general account settings instead; it is **per-package**, configured individually for every package).
Sources: [docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers/), [philna.sh 2026-01-28](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/).

### Exact fields (GitHub Actions provider)

| Field | Value for this project | Notes |
|---|---|---|
| **Organization or user** | `maxencerb` | GitHub username/org. **Case-sensitive** — must match exactly. |
| **Repository** | `evs` | Repository name only (not `owner/repo`). Case-sensitive. |
| **Workflow filename** | `release.yml` | Filename **only** (not the path), but it must live in `.github/workflows/`. Must include the `.yml`/`.yaml` extension. Case-sensitive; a single hidden trailing space here causes silent auth failures (reported in [GH community discussion #176761](https://github.com/orgs/community/discussions/176761)). |
| **Environment name** *(optional)* | leave blank (or e.g. `npm`) | If you set this, the publishing **job** must run with `environment: <name>`; the OIDC token then carries an `environment` claim that npm matches. If you leave it blank, do NOT set an environment requirement — a mismatch in either direction fails auth. |
| **Allowed actions** *(required since 2026-05-20)* | check **`npm publish`** | New field: "Trusted publisher configurations created before May 20, 2026 are automatically set to allow `npm publish` only… Configurations created after May 20, 2026 require you to explicitly select at least one allowed action." Options are `npm publish`, `npm stage publish` (the new [staged publishing](https://docs.npmjs.com/staged-publishing/) flow), or both. For a normal release pipeline pick `npm publish`. |

After it works, optionally set the package's **Publishing access** to "Require two-factor authentication and disallow tokens (recommended)" so OIDC becomes the *only* publish path ([blog.robino.dev](https://blog.robino.dev/posts/npm-trusted-publishing)).

### CLI alternative: `npm trust` (npm ≥ 11.10.0)

Current npm (docs shown for 11.16.0) ships an `npm trust` command:

```
npm trust github [package] --file [--repo|--repository] [--env|--environment] [--allow-publish] [--allow-stage-publish] [-y|--yes]
npm trust list
npm trust revoke <id>
```

e.g. `npm trust github @maxencerb/evs --file release.yml --repo maxencerb/evs --allow-publish`. Requires `npm@11.10.0+`, and — important — "The package you're configuring must already exist on the npm registry" (see §3). Granular access tokens with "bypass 2FA" are not supported by `npm trust`. Source: [docs.npmjs.com/cli/v11/commands/npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

### Other constraints

- Only **cloud-hosted runners** are supported (GitHub-hosted runners, GitLab.com shared runners, CircleCI cloud). "Self-hosted runners are not currently supported but are planned for future releases." ([trusted-publishers doc](https://docs.npmjs.com/trusted-publishers/))
- The OIDC token's workflow claim refers to the **top-level triggered workflow file**. Publishing from a *reusable* workflow (`workflow_call`) breaks the filename match — one author hit auth failures with `workflow_call` and succeeded after switching to `workflow_run`/direct triggers ([thecandidstartup.org 2026-01-26](https://www.thecandidstartup.org/2026/01/26/bootstrapping-npm-provenance-github-actions.html)). Run `npm publish` directly inside `release.yml`.

---

## 2. Workflow requirements

### Permissions

```yaml
permissions:
  id-token: write   # REQUIRED: lets the job mint a GitHub OIDC token
  contents: read    # needed for actions/checkout once you set any permissions block
```

`id-token: write` is the one hard requirement; npm CLI auto-detects the GitHub Actions OIDC environment and exchanges the GitHub token for a short-lived npm credential before falling back to classic tokens. Source: [docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers/), [GitHub changelog 2025-07-31](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/).

### npm version floor (the #1 failure cause)

- **Trusted publishing requires npm CLI ≥ 11.5.1** (and "Node version 22.14.0 or higher" per npm docs). With older npm you get a generic auth/404 error, not a helpful message.
- Bundled npm per Node release (verified against `nodejs.org/dist/index.json` on 2026-06-11):

  | Node | bundled npm | OIDC-capable? |
  |---|---|---|
  | 22.x (latest 22.22.3, LTS "Jod") | 10.9.8 | **No** — must upgrade npm |
  | 24.0.0 – 24.4.x | 11.3.0 – 11.4.2 | **No** |
  | 24.5.0 | 11.5.1 | yes (exact floor) |
  | 24.16.0 (current LTS "Krypton") | 11.13.0 | yes |
  | 26.3.0 (current) | 11.16.0 | yes |

- So `actions/setup-node@v6` with `node-version: 24` (resolves to latest 24.x ⇒ npm 11.13+) is sufficient *today*, but the robust pattern used by the npm docs' troubleshooting and practitioners is to **upgrade npm explicitly on the runner**:

  ```yaml
  - run: npm install -g npm@latest   # works without sudo on setup-node's tool-cache node
  - run: npm --version               # sanity log; must be >= 11.5.1
  ```

  ([philna.sh](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/) — this single step fixed their auth failure.)

### `--provenance`: implied, but pin it down anyway

- Official position: "When you publish using trusted publishing from GitHub Actions or GitLab CI/CD, npm automatically generates and publishes provenance attestations for your package… you don't need to add the `--provenance` flag." Opt out with `NPM_CONFIG_PROVENANCE=false`. ([trusted-publishers doc](https://docs.npmjs.com/trusted-publishers/), [GitHub changelog](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/))
- In practice multiple authors (philna.sh, Jan 2026) found provenance was *not* attached until they passed it explicitly. Passing it is harmless in an OIDC context, so be explicit. Three equivalent mechanisms:
  - flag: `npm publish --provenance`
  - package.json: `"publishConfig": { "provenance": true }`
  - env: `NPM_CONFIG_PROVENANCE: true`
- Provenance prerequisites ([generating-provenance-statements doc](https://docs.npmjs.com/generating-provenance-statements/)):
  - cloud-hosted runner (same restriction as OIDC);
  - the **repository must be public** — "For packages in private repositories, provenance will not be generated even though you're using trusted publishing";
  - `package.json` must have "a public `repository` that matches (case-sensitive) where you are publishing with provenance from". For the monorepo set:

    ```json
    "repository": {
      "type": "git",
      "url": "git+https://github.com/maxencerb/evs.git",
      "directory": "packages/evs"
    }
    ```

### `setup-node` / `registry-url` — the NODE_AUTH_TOKEN trap

The official npm docs example *does* use `registry-url`:

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: '24'
    registry-url: 'https://registry.npmjs.org'
    package-manager-cache: false  # docs: never use caching in release builds
```

**However**: when `registry-url` is set, `actions/setup-node` writes an `.npmrc` containing `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` *and exports a placeholder `NODE_AUTH_TOKEN`*. That placeholder token can shadow OIDC and produce `npm error 404 Not Found - PUT https://registry.npmjs.org/<pkg>` / "`<pkg>@x.y.z` is not in this registry" (really a 403). Two verified fixes ([GH discussion #176761](https://github.com/orgs/community/discussions/176761), [kettanaito's 2026 gist](https://gist.github.com/kettanaito/debde3cabfae4f68d37cf0f8f3a6a666)):

1. **Omit `registry-url` entirely** (npm publishes to `https://registry.npmjs.org` by default) — the working config in the GitHub discussion does exactly this; or
2. Keep `registry-url` (matches official docs; also guards against accidental registry overrides) and **neutralize the placeholder** on the publish step:

   ```yaml
   env:
     NODE_AUTH_TOKEN: ""
   ```

The reference workflow in §7 uses option 2 (docs-conformant + defensive). Note one author conversely failed *without* an explicit registry ([thecandidstartup](https://www.thecandidstartup.org/2026/01/26/bootstrapping-npm-provenance-github-actions.html)), which is why "registry-url present + empty NODE_AUTH_TOKEN" is the belt-and-braces choice.

---

## 3. First-publish gotcha (verified current as of 2026-06)

**A package that has never been published CANNOT use trusted publishing for its first publish.** This is still true in mid-2026:

- The npmjs.com trusted-publisher UI lives on the package settings page, which only exists after the package exists.
- The CLI route is equally blocked: `npm trust` docs state "The package you're configuring must already exist on the npm registry."
- The feature request to allow pre-registration (as PyPI does) is [npm/cli#8544 "Allow publishing initial version with OIDC"](https://github.com/npm/cli/issues/8544), opened 2025-09-01 — **still open, unassigned, no milestone** as of 2026-06-11.

**Bootstrap procedure for `@maxencerb/evs`:**

1. Publish `0.0.0` (or the real first version) once with classic auth — either locally (`npm login && npm publish --access public` from `packages/evs`, after `bun pm pack`-ing as in §4), or in CI via a temporary granular access token with "Bypass 2FA" stored as a GitHub secret ([kettanaito gist](https://gist.github.com/kettanaito/debde3cabfae4f68d37cf0f8f3a6a666), [azu/setup-npm-trusted-publish](https://github.com/azu/setup-npm-trusted-publish) automates a placeholder publish).
2. Configure the trusted publisher (§1) on the now-existing package.
3. **Revoke the token** on npmjs.com, delete the GitHub secret, and optionally flip the package to "Require 2FA and disallow tokens".
4. All subsequent releases go through OIDC.

---

## 4. The bun angle: `bun pm pack` → `npm publish <tarball>`

### Can npm publish a prebuilt tarball with provenance? Yes.

- `npm publish` accepts as `<package-spec>`: "a) a folder containing a program described by a `package.json` file **b) a gzipped tarball containing (a)** c) a url that resolves to (b)" — [npm-publish docs](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
- Provenance is a registry-side signature **over the uploaded tarball** ("the bundled package tarball is the same as the one that is associated with the metadata about provenance" — [github.com/npm/provenance](https://github.com/npm/provenance)), so it is agnostic to who built the tarball; what matters is that `npm publish` runs on a cloud-hosted runner with OIDC. There is also `--provenance-file <path>` if you ever generate the bundle yourself.
- OIDC trusted publishing authorizes the `npm publish` *command* (and `npm stage publish`); a tarball argument does not change the auth path.

### Scoped public package flags

- Current npm-publish docs say `--access` "Default: 'public' for new packages, existing packages it will not change the current level" — but pass **`--access public` explicitly** anyway: it is free, it is what the provenance docs themselves recommend for first publishes ("`npm publish --provenance --access public`"), and it removes any ambiguity for scoped packages on older npm behavior where scoped first publishes defaulted to restricted. You can instead bake `"publishConfig": { "access": "public" }` into `packages/evs/package.json` (recommended — survives any publish path).

### `bun pm pack` specifics (verified locally, bun 1.3.14)

Flags: `--dry-run`, `--destination <dir>`, `--filename <name>`, `--ignore-scripts` (skips `prepack`/`prepare`/`postpack` — i.e. those scripts DO run by default), `--gzip-level 0-9` (default 9), `--quiet` (prints only the tarball filename — ideal for capturing in a variable).

Default tarball name for `@maxencerb/evs@0.1.0` is `maxencerb-evs-0.1.0.tgz` (scope `@` dropped, `/` → `-`), written to the package directory.

```bash
cd packages/evs
TARBALL="$(bun pm pack --quiet)"        # → maxencerb-evs-0.1.0.tgz
npm publish "$TARBALL" --provenance --access public
```

Note: `bun publish` itself also exists and "will automatically pack your package into a tarball, strip catalog and workspace protocols" ([bun.com/docs/pm/cli/publish](https://bun.com/docs/pm/cli/publish)) — but **bun does not implement npm's OIDC token exchange or provenance**, so for trusted publishing the publish step must be the npm CLI. `bun pm pack` + `npm publish <tgz>` is exactly the right split.

---

## 5. Trigger + version injection from the release tag

### Trigger

```yaml
on:
  release:
    types: [published]
```

- `published` fires for both stable releases **and** pre-releases, including ones promoted from drafts: "If you want a workflow to run when stable *and* pre-releases publish, subscribe to `published` instead of `released` and `prereleased`." For the release event, `GITHUB_REF` is `refs/tags/<tag_name>` and `GITHUB_SHA` is the "last commit in the tagged release". Source: [GitHub docs — events that trigger workflows #release](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).
- The tag is available as `github.event.release.tag_name` (equivalently `github.ref_name` for this event). `github.event.release.prerelease` is a boolean you can use to publish prereleases under `--tag next`.

### Deriving and injecting the version

Guard the tag against full semver (the regex below is the official semver.org pattern with a mandatory `v` prefix), then strip the `v`:

```bash
# step with: env: { TAG: "${{ github.event.release.tag_name }}" }  ← env indirection avoids script injection
SEMVER_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(\+([0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*))?$'
[[ "$TAG" =~ $SEMVER_RE ]] || { echo "::error::tag '$TAG' is not vMAJOR.MINOR.PATCH[-pre][+build]"; exit 1; }
echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"
```

Three ways to write it into `packages/evs/package.json` (keep the committed version at `0.0.0` and treat the tag as the single source of truth):

1. **`npm version` (recommended — extra validation/normalization):**
   `npm version "$VERSION" --no-git-tag-version` run with `working-directory: packages/evs`. Only rewrites `package.json` (no `package-lock.json` exists in a bun repo); also accepts `v0.1.0` and normalizes it.
2. **bun-native:** `bun pm version "$VERSION" --no-git-tag-version` — verified working on bun 1.3.14 (prints `v0.1.0`, edits only `package.json`, no git tag created). `bun pm pkg set version="$VERSION"` also works but performs no semver validation.
3. **jq fallback:** `jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json`.

**Ordering matters with bun:** run `bun install --frozen-lockfile` **before** the version bump — bun's frozen-lockfile check hashes workspace `package.json`s, so bumping first can fail the install; and `bun pm pack` needs a completed install (see §6).

---

## 6. Monorepo: packing only `packages/evs`

Verified locally with bun 1.3.14 in a scratch workspace (`workspaces: ["packages/*"]`, dep `@maxencerb/evs-other@1.2.3`):

| In `packages/evs/package.json` | In the packed tarball's `package.json` |
|---|---|
| `"@maxencerb/evs-other": "workspace:*"` | `"@maxencerb/evs-other": "1.2.3"` (exact pin) |
| `"@maxencerb/evs-other": "workspace:^"` | `"@maxencerb/evs-other": "^1.2.3"` |
| (by analogy `workspace:~` → `~1.2.3`; `workspace:1.2.3` → `1.2.3`) | |

So **`bun pm pack` rewrites `workspace:` (and `catalog:`) protocols to real registry ranges** — no manual rewriting needed. Two pitfalls:

1. **Pack without install fails.** Exact error (bun 1.3.14): `error: Failed to resolve workspace version for "@maxencerb/evs-other" in `dependencies`. Run `bun install` and try again.` — always `bun install` (workspace root) before packing in CI.
2. **Resolution uses installed/lockfile state.** If you ever publish multiple workspace packages in one release and bump versions in the same job, pack may embed the *pre-bump* version of sibling deps. For the single-package `packages/evs` publish this is moot, but if `evs` ever gains a published workspace dependency, bump all versions first, re-run `bun install` (non-frozen) to refresh resolution, then pack.

Also for the monorepo: `repository.directory: "packages/evs"` in the package manifest (§2) keeps provenance/`repository` validation happy, and run pack/publish with `working-directory: packages/evs` rather than cd-ing from root.

---

## 7. Complete `.github/workflows/release.yml`

Filename **must** be `release.yml` to match the trusted-publisher config (§1). Assumes: public repo `maxencerb/evs`, package `@maxencerb/evs` in `packages/evs` with `"publishConfig": { "access": "public", "provenance": true }` and the `repository` block from §2, and a `build` script in the package (drop that step if compile-on-prepack).

```yaml
name: Release

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write # required for npm trusted publishing (OIDC)

concurrency:
  group: release-${{ github.event.release.tag_name }}
  cancel-in-progress: false

jobs:
  publish:
    name: Publish @maxencerb/evs to npm
    runs-on: ubuntu-latest
    # environment: npm   # ONLY if an environment name is set in the npm trusted publisher config
    steps:
      - uses: actions/checkout@v6

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      # Node 24 LTS bundles npm >= 11.13 (OIDC needs npm >= 11.5.1).
      # registry-url makes setup-node write .npmrc for registry.npmjs.org; the
      # NODE_AUTH_TOKEN placeholder it exports is neutralized at the publish step.
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false # npm docs: never cache in release builds

      - name: Ensure npm supports OIDC trusted publishing (>= 11.5.1)
        run: |
          npm install -g npm@latest
          npm --version

      - name: Derive version from release tag
        id: version
        env:
          TAG: ${{ github.event.release.tag_name }} # env indirection: no script injection
        run: |
          SEMVER_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(\+([0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*))?$'
          if [[ ! "$TAG" =~ $SEMVER_RE ]]; then
            echo "::error::Release tag '$TAG' must look like v1.2.3, v1.2.3-beta.1, ..."
            exit 1
          fi
          echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"

      # Install BEFORE bumping the version: bun's frozen-lockfile check hashes
      # workspace package.jsons, and `bun pm pack` requires an install anyway.
      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Inject version into packages/evs
        working-directory: packages/evs
        run: npm version "${{ steps.version.outputs.version }}" --no-git-tag-version
        # bun-native alternative: bun pm version "$V" --no-git-tag-version

      - name: Build
        working-directory: packages/evs
        run: bun run build

      - name: Pack (resolves workspace: protocols to real versions)
        id: pack
        working-directory: packages/evs
        run: echo "tarball=$(bun pm pack --quiet)" >> "$GITHUB_OUTPUT"

      - name: Publish to npm via OIDC
        working-directory: packages/evs
        env:
          NODE_AUTH_TOKEN: "" # defuse setup-node's placeholder token so OIDC wins
        run: |
          TAG_FLAG=latest
          if [ "${{ github.event.release.prerelease }}" = "true" ]; then TAG_FLAG=next; fi
          npm publish "${{ steps.pack.outputs.tarball }}" \
            --provenance \
            --access public \
            --tag "$TAG_FLAG"
```

(If you prefer the minimal-docs variant: drop `registry-url`, the npm upgrade step, and the `NODE_AUTH_TOKEN` override — the GitHub-discussion-verified config works with just `setup-node node-version: 24` + `npm publish`. The version above is the defensive superset.)

---

## 8. Troubleshooting catalogue (error → cause)

| Symptom | Cause / fix |
|---|---|
| `ENEEDAUTH` on publish | Workflow filename on npmjs.com doesn't exactly match (extension, case, hidden spaces); or org/repo case mismatch; or npm < 11.5.1. "All fields are case-sensitive and must be exact." ([trusted-publishers doc](https://docs.npmjs.com/trusted-publishers/)) |
| `404 Not Found - PUT …/<pkg>` / "`pkg@x.y.z` is not in this registry" | (a) classic-token path shadowing OIDC via setup-node's `NODE_AUTH_TOKEN` placeholder — set it to `""` or drop `registry-url`; (b) first-ever publish attempted via OIDC (impossible, §3); (c) trusted publisher config mismatch. "404 meaning 403." |
| Publish OK but no provenance badge | npm older quirk — pass `--provenance` explicitly; or repo is private (provenance unsupported); or `repository` field mismatch. |
| `Failed to validate repository information` / provenance error | `package.json` `repository.url` must match `git+https://github.com/maxencerb/evs.git` case-sensitively, with `directory` for the monorepo. |
| Auth fails only via reusable workflow | OIDC workflow claim = top-level workflow file; don't publish from `workflow_call`. |
| Auth fails with environment configured | Job must declare `environment:` matching the npm-side environment name exactly (and vice versa: don't declare one if npm-side is blank). |
| `TLOG_CREATE_ENTRY_ERROR` | Transient Sigstore backend issue — retry. ([thecandidstartup](https://www.thecandidstartup.org/2026/01/26/bootstrapping-npm-provenance-github-actions.html)) |
| `error: Failed to resolve workspace version for "<pkg>" in \`dependencies\`. Run \`bun install\` and try again.` | `bun pm pack` before `bun install` in the monorepo. |

## 9. Sources

- https://docs.npmjs.com/trusted-publishers/ (config fields, npm ≥ 11.5.1, Node ≥ 22.14.0, allowed-actions May 20 2026 change, auto-provenance, runner restrictions, ENEEDAUTH note, example workflow with setup-node@v6 / node 24 / registry-url / package-manager-cache: false)
- https://docs.npmjs.com/cli/v11/commands/npm-trust/ (npm trust synopsis, npm ≥ 11.10.0, package-must-exist)
- https://docs.npmjs.com/generating-provenance-statements/ (public repo + matching `repository` requirement, `--provenance --access public`)
- https://docs.npmjs.com/cli/v11/commands/npm-publish/ (tarball package-spec, `--access` default, `--provenance-file`)
- https://docs.npmjs.com/staged-publishing/ (npm stage publish allowed action)
- https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ (GA announcement, provenance default, NPM_CONFIG_PROVENANCE=false)
- https://github.com/npm/cli/issues/8544 (first-publish-via-OIDC still open as of 2026-06)
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release (release event types, published vs released/prereleased, GITHUB_REF/GITHUB_SHA)
- https://philna.sh/blog/2026/01/28/trusted-publishing-npm/ (npm upgrade step, explicit --provenance, per-package access page, repository field)
- https://github.com/orgs/community/discussions/176761 (NODE_AUTH_TOKEN placeholder fix, case-sensitivity, working minimal workflow)
- https://gist.github.com/kettanaito/debde3cabfae4f68d37cf0f8f3a6a666 (first-publish bootstrap with temp token, "404 meaning 403", Node 24 requirement)
- https://www.thecandidstartup.org/2026/01/26/bootstrapping-npm-provenance-github-actions.html (first-publish-manual confirmation, workflow_call gotcha, TLOG error)
- https://blog.robino.dev/posts/npm-trusted-publishing (Settings tab UI wording, disallow-tokens recommendation)
- https://bun.com/docs/pm/cli/publish (bun strips workspace/catalog protocols; bun publish tarball mode)
- https://github.com/azu/setup-npm-trusted-publish (placeholder-package bootstrap tool)
- Local verification, bun 1.3.14: `workspace:*` → exact pin, `workspace:^` → caret range, pack-without-install error text, `bun pm pack --quiet/--filename/--destination/--ignore-scripts/--gzip-level/--dry-run` flags, `bun pm version <v> --no-git-tag-version`, scoped tarball naming `maxencerb-evs-<version>.tgz`.
- nodejs.org/dist/index.json (bundled npm per Node version, fetched 2026-06-11).
