# evs — Repository Layout & Release Engineering (binding)

Status: FINAL. Sources: stack-testing.md, npm-oidc-release.md, oxc-tooling.md.

## 1. Monorepo tree

```
evs/
  package.json                  # private root: workspaces + catalogs + tool scripts
  bun.lock
  tsconfig.base.json            # shared strict compiler options
  vitest.config.ts              # projects: ['packages/*/vitest.config.ts']; coverage (root-only)
  .oxlintrc.json
  .oxfmtrc.json
  .gitignore                    # dist/, coverage/, contracts/out|cache, *.tgz
  .github/workflows/ci.yml
  .github/workflows/release.yml # filename must match the npm trusted-publisher config exactly
  docs/
    research/ …                 # the seven reports
    design/ …                   # this set
  packages/
    evs/                        # @maxencerb/evs — the published library
      package.json
      tsconfig.json             # typecheck (noEmit), includes src + test
      tsconfig.build.json       # emit: dist/ js + d.ts + maps, src only
      vitest.config.ts          # unit / types / integration projects (testing.md §1)
      src/                      # module layout per module-interfaces.md
        core/  ir/  abi/  builder/  asm/  codegen/
        compile.ts  viem.ts  index.ts
      test/
        harness/  integration/  global-setup.ts
    contracts/                  # foundry package — no node integration required
      package.json              # minimal, private; lets `bun run --filter` drive forge
      foundry.toml
      remappings.txt
      src/  test/  lib/forge-std/   # forge-std as git submodule
      scripts/codegen.ts        # emits as-const TS artifacts for tests (bun script)
  examples/
    pool-meta/                  # the api.md examples as runnable scripts (private workspace)
      package.json  index.ts
```

## 2. Root `package.json`

```json
{
  "name": "evs-monorepo",
  "private": true,
  "workspaces": {
    "packages": ["packages/*", "examples/*"],
    "catalog": {
      "typescript": "^5.9.0",
      "viem": "2.52.2",
      "abitype": "^1.2.4"
    },
    "catalogs": {
      "testing": {
        "vitest": "^3.2.4",
        "prool": "^0.2.4",
        "@ethereumjs/evm": "^10.1.2"
      }
    }
  },
  "scripts": {
    "build": "bun run --filter '@maxencerb/evs' build",
    "typecheck": "bun run --filter '*' typecheck",
    "test": "vitest run --project unit --project types",
    "test:integration": "vitest run --project integration",
    "test:all": "vitest run",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix --fix-suggestions",
    "lint:ci": "oxlint --deny-warnings --format github",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "check": "bun run fmt:check && bun run lint:ci && bun run typecheck"
  },
  "devDependencies": {
    "oxlint": "^1.69.0",
    "oxfmt": "0.54.0",
    "oxlint-tsgolint": "^0.23.0",
    "typescript": "catalog:",
    "vitest": "catalog:testing",
    "prool": "catalog:testing",
    "publint": "^0.3.0",
    "@arethetypeswrong/cli": "^0.18.0"
  }
}
```

Notes: `viem` is pinned **exact** in the catalog (viem ships type changes in patches; the type
tests depend on it — bump deliberately). `oxfmt` pinned exact (pre-1.0 output drift). Bun ≥
1.3.x assumed (isolated installs, catalogs); always `bun install` after version bumps before
packing (bun.lock substitution bug, stack-testing §1).

## 3. `packages/evs/package.json`

```json
{
  "name": "@maxencerb/evs",
  "version": "0.0.0",
  "description": "Typed EVM read scripts in plain TypeScript: a callback builder compiled to runtime bytecode, executed via eth_call (deployless or state-override) with full viem inference",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/maxencerb/evs.git",
    "directory": "packages/evs"
  },
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=20.19" },
  "files": ["dist", "src", "!src/**/*.test.ts", "!src/**/*.test-d.ts", "!dist/**/*.test.*"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --project unit --project types",
    "test:integration": "vitest run --project integration",
    "prepublishOnly": "bun run build"
  },
  "peerDependencies": {
    "typescript": ">=5.5",
    "viem": ">=2.14.1"
  },
  "peerDependenciesMeta": {
    "typescript": { "optional": true }
  },
  "dependencies": {
    "abitype": "catalog:"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "viem": "catalog:",
    "vitest": "catalog:testing",
    "prool": "catalog:testing",
    "@ethereumjs/evm": "catalog:testing"
  },
  "//publishConfig": "provenance MUST stay false while the repo is private — npm cannot generate provenance for private repos and the publish would fail/skip it confusingly. FLIP provenance to true (and keep --access public) the moment the repo goes public.",
  "publishConfig": {
    "access": "public",
    "provenance": false
  }
}
```

Rationale: ESM-only (`type: module`, no `require` condition); `types` condition first in each
exports entry; `src/` shipped for `declarationMap` go-to-definition; `viem >= 2.14.1` floor
(deployless `code` + `stateOverride` on readContract, viem-integration §1.2); `abitype` is a
**direct dependency** aligned with viem's `^1.x` so exactly one copy resolves and user
`Register` augmentation flows through (abitype §4.4). Validate every release with `publint`
and `attw --pack`.

## 4. `packages/contracts`

```json
{
  "name": "@maxencerb/evs-contracts",
  "private": true,
  "scripts": { "build": "forge build", "test": "forge test", "codegen": "bun scripts/codegen.ts" }
}
```

```toml
# foundry.toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.30"
auto_detect_solc = false
evm_version = "prague"
optimizer = false            # reference semantics, not gas golf — keep codegen predictable
via_ir = false
```

`remappings.txt`: `forge-std/=lib/forge-std/src/` (submodule via `forge install`). Contents of
`src/` per testing.md §4.3 (`EvsReference.sol`, `MockERC20.sol`, `MockUniV3Pool.sol`,
`Reverter.sol`, `Malformed.sol`). `scripts/codegen.ts` writes
`packages/evs/test/generated/*.ts` with `as const` ABIs + bytecode (JSON imports widen types —
prior-art §5 / stack-testing §4).

## 5. TypeScript configuration

`tsconfig.base.json` (root):

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    // NO baseUrl — required by oxlint-tsgolint (TS7 semantics, oxc-tooling §5)
  },
}
```

`packages/evs/tsconfig.json`: `{ "extends": "../../tsconfig.base.json",
"compilerOptions": { "noEmit": true }, "include": ["src", "test"] }`

`packages/evs/tsconfig.build.json`:

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test-d.ts"],
}
```

`isolatedDeclarations` is NOT enabled: the builder's inference-heavy generics (`s.call`,
`ScriptAbi`) would be forced into widened annotations — declaration quality is the product
(stack-testing §5 tradeoff, decided). Guard quality with attw + d.ts snapshot tests instead.

## 6. `.oxlintrc.json` (root, single config — nested configs do not merge)

```jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "node"],
  "categories": { "correctness": "error", "suspicious": "warn", "perf": "warn" },
  "options": {
    "typeAware": true,
    "reportUnusedDisableDirectives": "warn",
  },
  "env": { "shared-node-browser": true, "es2026": true },
  "rules": {
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/strict-boolean-expressions": "error",
    "import/no-cycle": "error",
    "no-console": "warn",
  },
  "ignorePatterns": [
    "**/dist/**",
    "**/coverage/**",
    "**/contracts/out/**",
    "**/contracts/cache/**",
    "**/contracts/lib/**",
    "**/test/generated/**",
  ],
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.test-d.ts", "**/test/**"],
      "plugins": ["vitest"],
      "rules": {
        "vitest/no-focused-tests": "error",
        "typescript/no-explicit-any": "off",
        "no-console": "off",
      },
    },
  ],
}
```

`strict-boolean-expressions` is load-bearing: it is the lint-level mitigation for the
un-poisonable `if (expr)` truthiness gap on builder handles (architecture §3). Type-aware
rules require `oxlint-tsgolint` installed and built `.d.ts` for cross-package imports — CI
builds before linting.

## 7. `.oxfmtrc.json` (root)

```jsonc
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "arrowParens": "always",
  "endOfLine": "lf",
  "sortImports": { "internalPattern": ["@maxencerb/"] },
  "sortPackageJson": true,
  "ignorePatterns": [
    "**/dist/**",
    "**/coverage/**",
    "**/contracts/out/**",
    "**/contracts/cache/**",
    "**/contracts/lib/**",
    "**/test/generated/**",
  ],
}
```

(Reminder: bare `oxfmt` WRITES; CI must use `oxfmt --check`.)

## 8. Root `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    coverage: { provider: 'v8', include: ['packages/evs/src/**'] },
  },
});
```

Per-package config: testing.md §1. Vitest 3.2+ `projects`; migration note for vitest 4
(`poolOptions` removal) recorded in stack-testing §2.

## 9. `.github/workflows/ci.yml` (final)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  check-and-test:
    name: Lint, typecheck, unit & type tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          submodules: recursive # contracts/lib/forge-std

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      # vitest executes on Node (bun is the package manager / script runner)
      - uses: actions/setup-node@v6
        with:
          node-version: 24

      - uses: foundry-rs/foundry-toolchain@v1
        with:
          version: v1.7.1 # pinned: anvil/forge determinism

      - run: bun install --frozen-lockfile

      - name: Build + test contracts (reference + mocks)
        working-directory: packages/contracts
        run: forge build && forge test && bun run codegen

      # build first: type-aware lint resolves workspace imports through .d.ts
      - name: Build library
        run: bun run build

      - run: bun run fmt:check
      - run: bun run lint:ci
      - run: bun run typecheck

      - name: Unit + type tests
        run: bun run test

      - name: Integration tests (anvil via prool)
        run: bun run test:integration

      - name: Package health (publint + attw)
        working-directory: packages/evs
        run: |
          bunx publint
          bunx @arethetypeswrong/cli --pack .

  fork-tests:
    name: Mainnet-fork suite (scheduled / manual)
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { submodules: recursive }
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - uses: actions/setup-node@v6
        with: { node-version: 24 }
      - uses: foundry-rs/foundry-toolchain@v1
        with: { version: v1.7.1 }
      - run: bun install --frozen-lockfile
      # the integration suite imports gitignored test/generated/ artifacts — regenerate them
      - name: Build contracts (reference + mocks)
        working-directory: packages/contracts
        run: forge build && bun run codegen
      - run: bun run build
      - name: Fork integration
        env:
          ANVIL_FORK_URL: ${{ secrets.ANVIL_FORK_URL }}
        run: bun run test:integration
```

(Add `schedule:` and `workflow_dispatch:` triggers to `on:` when the fork secret is
provisioned; the job is skipped otherwise.)

## 10. `.github/workflows/release.yml` (final)

Per npm-oidc-release.md. Trusted-publisher config on npmjs.com (per-package settings of
`@maxencerb/evs`): org `maxencerb`, repo `evs`, workflow filename `release.yml` (exact,
case-sensitive), no environment, allowed action `npm publish`. **First-publish bootstrap**: a
never-published package cannot use OIDC — publish `0.0.0` once with a classic token
(`npm publish --access public` locally), configure the trusted publisher, revoke the token,
then this workflow handles every release. The committed version stays `0.0.0`; the release
tag (`vX.Y.Z`) is the single source of truth.

```yaml
name: Release

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write # npm trusted publishing (OIDC)

concurrency:
  group: release-${{ github.event.release.tag_name }}
  cancel-in-progress: false

jobs:
  publish:
    name: Publish @maxencerb/evs to npm
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          submodules: recursive

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      # Node 24 bundles npm >= 11.13 (OIDC floor is 11.5.1); registry-url writes .npmrc whose
      # NODE_AUTH_TOKEN placeholder is defused at the publish step so OIDC wins.
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false

      - name: Ensure npm supports OIDC trusted publishing (>= 11.5.1)
        run: |
          npm install -g npm@latest
          npm --version

      - name: Derive version from release tag
        id: version
        env:
          TAG: ${{ github.event.release.tag_name }} # env indirection: no script injection
          RELEASE_PRERELEASE: ${{ github.event.release.prerelease }}
        run: |
          SEMVER_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(\+([0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*))?$'
          if [[ ! "$TAG" =~ $SEMVER_RE ]]; then
            echo "::error::Release tag '$TAG' must look like v1.2.3 or v1.2.3-beta.1"
            exit 1
          fi
          # the dist-tag follows the tag's semver prerelease component (BASH_REMATCH[4]),
          # not the GitHub release checkbox — hard-fail when the two disagree
          PRERELEASE=false
          if [[ -n "${BASH_REMATCH[4]}" ]]; then PRERELEASE=true; fi
          if [[ "$PRERELEASE" != "$RELEASE_PRERELEASE" ]]; then
            echo "::error::Tag '$TAG' (prerelease=$PRERELEASE per semver) disagrees with the GitHub release prerelease checkbox ($RELEASE_PRERELEASE) — fix the release and retry"
            exit 1
          fi
          echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"
          echo "prerelease=$PRERELEASE" >> "$GITHUB_OUTPUT"

      # Install BEFORE the version bump (bun's frozen-lockfile hashes workspace manifests),
      # and bun pm pack requires a completed install.
      - name: Install dependencies
        run: bun install --frozen-lockfile

      - uses: foundry-rs/foundry-toolchain@v1
        with:
          version: v1.7.1

      - name: Full test gate
        run: |
          (cd packages/contracts && forge build && forge test && bun run codegen)
          bun run build
          bun run check
          bun run test
          bun run test:integration

      - name: Inject version
        working-directory: packages/evs
        run: npm version "${{ steps.version.outputs.version }}" --no-git-tag-version

      - name: Rebuild with release version
        working-directory: packages/evs
        run: bun run build

      - name: Pack (bun rewrites workspace:/catalog: protocols)
        id: pack
        working-directory: packages/evs
        run: echo "tarball=$(bun pm pack --quiet)" >> "$GITHUB_OUTPUT"

      # validate the EXACT tarball being published (testing.md §8) — publint accepts a
      # tarball path and checks the rewritten manifest, not the workspace source
      - name: Package health on the packed tarball (publint)
        working-directory: packages/evs
        run: bunx publint "${{ steps.pack.outputs.tarball }}"

      - name: Publish to npm via OIDC
        working-directory: packages/evs
        env:
          NODE_AUTH_TOKEN: "" # defuse setup-node's placeholder so OIDC wins
          # While the repo is PRIVATE, provenance must stay off (publishConfig.provenance=false
          # in package.json). When the repo goes public: flip publishConfig.provenance to true
          # and append --provenance below.
        run: |
          TAG_FLAG=latest
          if [ "${{ steps.version.outputs.prerelease }}" = "true" ]; then TAG_FLAG=next; fi
          npm publish "${{ steps.pack.outputs.tarball }}" \
            --access public \
            --tag "$TAG_FLAG"
```

## 11. `.gitignore` (relevant entries)

```
node_modules/
dist/
coverage/
packages/contracts/out/
packages/contracts/cache/
packages/evs/test/generated/
*.tgz
```

## 12. Editor settings (`.vscode/settings.json`, committed)

```jsonc
{
  "editor.defaultFormatter": "oxc.oxc-vscode",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": { "source.fixAll.oxc": "explicit" },
}
```
