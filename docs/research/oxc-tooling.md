# oxlint + oxfmt — current state and recommended configs for the `evs` monorepo

Research date: **2026-06-11**. All versions verified against the npm registry and the
oxc.rs docs on this date; CLI help text captured from the actual published binaries
(`bunx oxlint@1.69.0 --help`, `bunx oxfmt@0.54.0 --help`).

---

## 1. Versions (verified on npm, 2026-06-11)

| Package           | Latest version | Notes                                                                                                                           |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `oxlint`          | **1.69.0**     | Stable (1.x since mid-2025). Node engines: `^20.19.0 \|\| >=22.12.0` (native binary; runs fine under Bun via `bunx`/`bun run`). |
| `oxfmt`           | **0.54.0**     | **Beta** (pre-1.0). Beta announced 2026-02-24; passes 100% of Prettier's JS/TS conformance tests.                               |
| `oxlint-tsgolint` | **0.23.0**     | Type-aware linting backend (typescript-go). `oxlint` declares it as an **optional peerDependency** `oxlint-tsgolint: >=0.22.1`. |
| `@oxlint/migrate` | **1.69.0**     | Converts an existing ESLint config to `.oxlintrc.json` (`npx @oxlint/migrate`). Versioned in lockstep with oxlint.              |

Sources: <https://www.npmjs.com/package/oxlint>, <https://www.npmjs.com/package/oxfmt>,
`npm view oxlint version peerDependencies peerDependenciesMeta engines`.

---

## 2. oxlint

Docs: <https://oxc.rs/docs/guide/usage/linter/config.html>,
<https://oxc.rs/docs/guide/usage/linter/config-file-reference.html>,
<https://oxc.rs/docs/guide/usage/linter/cli.html>

### 2.1 Config file: `.oxlintrc.json`

- File names searched: **`.oxlintrc.json`** (JSONC — comments allowed) or **`oxlint.config.ts`**
  (TS/JS config is _experimental_ and requires running via Node.js per the CLI help — for a Bun
  monorepo, **use `.oxlintrc.json`**).
- Aims for **ESLint v8 (eslintrc) compatibility** in shape.
- JSON schema for editor validation: `"$schema": "./node_modules/oxlint/configuration_schema.json"`.
- `oxlint --init` scaffolds a default config.

#### Top-level keys (full schema)

| Key              | Type                     | Default              | Purpose                                                                                                   |
| ---------------- | ------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `$schema`        | string                   | —                    | editor validation                                                                                         |
| `categories`     | object                   | correctness enabled  | enable rule groups by severity                                                                            |
| `plugins`        | string[]                 | `null` → default set | built-in plugin set (see below)                                                                           |
| `rules`          | object                   | —                    | per-rule severity/options                                                                                 |
| `overrides`      | array                    | —                    | per-glob config (see shape below)                                                                         |
| `extends`        | string[]                 | —                    | inherit other config files                                                                                |
| `ignorePatterns` | string[]                 | `[]`                 | extra ignore globs                                                                                        |
| `env`            | `Record<string,boolean>` | —                    | predefined globals (`browser`, `node`, `es2026`, `shared-node-browser`, 40+ envs incl. test frameworks)   |
| `globals`        | `Record<string,string>`  | —                    | custom globals: `"readonly"` / `"writable"` / `"off"`                                                     |
| `settings`       | object                   | —                    | plugin-wide shared settings (ESLint-style, e.g. `settings.react`, `settings.jsdoc`)                       |
| `jsPlugins`      | array                    | —                    | JavaScript plugins (**alpha** since 2026-03-11, <https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha>) |
| `options`        | object                   | —                    | linter-level options (below)                                                                              |

#### `options` fields (exact names)

- `typeAware` (boolean) — enable type-aware rules
- `typeCheck` (boolean) — experimental: include TypeScript compiler diagnostics
- `maxWarnings` (integer)
- `denyWarnings` (boolean)
- `reportUnusedDisableDirectives` (`"allow" | "off" | "warn" | "error" | "deny"` or integer)
- `respectEslintDisableDirectives` (boolean)

`options.typeAware` and `options.typeCheck` are **root-config-only**: oxlint errors if they appear
in a nested config (<https://oxc.rs/docs/guide/usage/linter/nested-config.html>).

#### Categories

`correctness` (the only one enabled by default), `suspicious`, `pedantic`, `perf`, `style`,
`restriction`, `nursery`. CLI also accepts `all` (= everything except `nursery`; does not
auto-enable plugins).

**Important verified behavior:** by default, correctness diagnostics are emitted as
**warnings** and the exit code is **0** (verified empirically with oxlint 1.69.0 on a file
containing `debugger` / unused vars: `warning eslint(no-debugger) ... exit=0`). For CI you must
either set categories/rules to `"error"` in config or pass `--deny-warnings`.

#### Plugins

- **Enabled by default:** `eslint`, `typescript`, `unicorn`, `oxc`.
- **Opt-in:** `react`, `react-perf`, `nextjs`, `import`, `jsdoc`, `jsx-a11y`, `node`, `promise`,
  `jest`, `vitest`, `vue`.
- Setting the `plugins` array **replaces** the default set — you must re-list the defaults you
  want to keep.
- Plugin provenance: `typescript` = typescript-eslint rules; `import` = eslint-plugin-import /
  import-x; `vitest` = @vitest/eslint-plugin; `promise` = eslint-plugin-promise; `node` =
  eslint-plugin-n. (<https://oxc.rs/docs/guide/usage/linter/plugins.html>)

#### `rules`

Severity `"off" | "warn" | "error"` or `[severity, options]`. Plugin prefix is optional for
unambiguous rule names; prefixed form is e.g. `"typescript/no-floating-promises"`,
`"import/no-cycle"`, `"vitest/no-focused-tests"`.

#### `overrides` shape

```jsonc
{
  "overrides": [
    {
      "files": ["**/*.test.ts"], // required, glob array
      "excludeFiles": ["**/fixtures/**"], // optional
      "plugins": ["vitest"], // plus env, globals, rules, jsPlugins
      "rules": { "typescript/no-explicit-any": "off" },
    },
  ],
}
```

#### `extends`

Array of file paths, resolved **relative to the config file declaring them**. Extendable
properties: `rules`, `plugins`, `overrides`. In `oxlint.config.ts` you instead import config
objects and pass them to `extends`.

### 2.2 CLI flags (exact, from `oxlint@1.69.0 --help`)

- Config: `-c, --config=<./.oxlintrc.json>`, `--tsconfig=<./tsconfig.json>` (override TS config
  used for **import resolution**; oxlint auto-discovers the relevant `tsconfig.json` per file —
  only needed for non-standard names/locations), `--init`
- Severity accumulation (left→right): `-A/--allow=NAME`, `-W/--warn=NAME`, `-D/--deny=NAME`
  (rules or categories, e.g. `-D correctness -A no-debugger`)
- Plugin toggles: `--disable-unicorn-plugin`, `--disable-oxc-plugin`, `--disable-typescript-plugin`,
  `--import-plugin`, `--react-plugin`, `--jsdoc-plugin`, `--jest-plugin`, `--vitest-plugin`,
  `--jsx-a11y-plugin`, `--nextjs-plugin`, `--react-perf-plugin`, `--promise-plugin`,
  `--node-plugin`, `--vue-plugin`
- Fixes: `--fix` (safe), `--fix-suggestions` (may change behavior), `--fix-dangerously`
- Ignore: `--ignore-path=PATH` (`.eslintignore`-style), `--ignore-pattern=PAT`, `--no-ignore`
- Warnings: `--quiet`, `--deny-warnings`, `--max-warnings=INT`
- Output: `-f, --format=` one of `checkstyle | default | agent | github | gitlab | json | junit | sarif | stylish | unix`; `--debug=files,timings`
- Misc: `--silent`, `--no-error-on-unmatched-pattern`, `--threads=INT`, `--print-config`,
  `--rules`, `--lsp`, `--disable-nested-config`,
  `--report-unused-disable-directives[-severity=SEVERITY]`
- **`--type-aware`** and **`--type-check`** (see below)

### 2.3 Type-aware linting (`oxlint-tsgolint`)

Docs: <https://oxc.rs/docs/guide/usage/linter/type-aware.html>

- Enable via CLI `oxlint --type-aware` **or** config `{"options": {"typeAware": true}}`
  (CLI flag takes precedence; root config only).
- Requires the extra dev dependency: `bun add -d oxlint-tsgolint@latest` (docs say
  `npm add -D oxlint-tsgolint@latest`). oxlint 1.69.0 requires `oxlint-tsgolint >= 0.22.1`
  (optional peer dep).
- Powered by **typescript-go**; requires **TypeScript 7.0+ semantics** — some legacy tsconfig
  options are unsupported (notably **`baseUrl`**); deprecated TS 6.0 options must be migrated
  first.
- Coverage: **59 of 61** typescript-eslint type-aware rules, with identical rule options; rules
  live in the `typescript/*` namespace (e.g. `typescript/no-floating-promises`,
  `typescript/no-misused-promises`, `typescript/await-thenable`).
- Monorepo caveat: **build dependent workspace packages first so `.d.ts` files exist** before
  running type-aware lint across package boundaries (or point packages at source via tsconfig
  references/`paths`).
- Known caveat: high memory usage on very large codebases. Per release notes, tsgolint got
  "~35% faster type checking" in oxlint v1.58 (<https://releasebot.io/updates/oxc>).
- `--type-check` is a separate **experimental** flag that surfaces full TS compiler diagnostics
  through oxlint (i.e. can replace `tsc --noEmit` in lint); treat as experimental, keep a real
  `tsc --noEmit` (or tsgo) typecheck script for now.

**Recommendation for evs: enable `typeAware: true`.** A heavily-typed builder/compiler library
benefits directly from `no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`,
etc. The feature is past alpha, covers 59/61 rules, and the codebase is small enough that memory
is a non-issue. Conditions: tsconfig must be TS7-clean (no `baseUrl` — use `paths` with relative
entries or workspace `exports`), and CI must install `oxlint-tsgolint`. Do NOT enable
`typeCheck` yet (experimental).

### 2.4 Nested configs / monorepo semantics

(<https://oxc.rs/docs/guide/usage/linter/nested-config.html>)

- For each linted file, oxlint uses the **nearest** `.oxlintrc.json` / `oxlint.config.ts`.
- **Nested configs do NOT merge with parent configs** — nearest file wins entirely. Use
  `extends` from the package config to the root config if a package needs deviations.
- `-c/--config` with an explicit path uses only that file; `--disable-nested-config` turns the
  feature off.
- CLI options always override config files.

---

## 3. oxfmt

Docs: <https://oxc.rs/docs/guide/usage/formatter.html>,
<https://oxc.rs/docs/guide/usage/formatter/config.html>,
<https://oxc.rs/docs/guide/usage/formatter/config-file-reference.html>.
Beta announcement: <https://oxc.rs/blog/2026-02-24-oxfmt-beta>;
alpha announcement: <https://voidzero.dev/posts/announcing-oxfmt-alpha> (Jan 2026, InfoQ:
<https://www.infoq.com/news/2026/01/oxfmt-rust-prettier/>).

### 3.1 Maturity as of mid-2026

- npm package name: **`oxfmt`**, latest **0.54.0** (pre-1.0, releases every ~1-2 weeks).
- Status: **beta**, explicitly positioned as a Prettier replacement. Passes **100% of Prettier's
  JavaScript and TypeScript conformance tests**; remaining edge inconsistencies are being fixed
  jointly with the Prettier team.
- Adopted by Vue.js, Turborepo, Sentry repos.
- Performance: **>30× faster than Prettier, ~3× faster than Biome** (initial run, no cache).
- **TS/TSX support: full.** Supported languages: JavaScript, JSX, TypeScript, TSX, JSON, JSONC,
  JSON5, YAML, TOML, HTML, Angular, Vue, Svelte, CSS, SCSS, Less, Markdown, MDX, GraphQL, Ember,
  Handlebars.
- Known limitations (mid-2026):
  - **No Prettier plugin support yet** (on the roadmap to 1.0). Docs: "Stay on Prettier only if
    you still depend on exact plugin behavior not yet covered by Oxfmt." Built-ins already cover
    the common plugins: import sorting, Tailwind class sorting, package.json sorting, JSDoc
    formatting.
  - Pre-1.0: output may shift slightly between minor versions — **pin the exact version** in
    `package.json` and reformat on upgrades.
  - Editor/LSP rough edges still appear (e.g. `.oxfmtrc.json` `overrides` not applied via the
    VS Code LSP path: <https://github.com/oxc-project/oxc/issues/21385>).
  - **Default `printWidth` is 100, not Prettier's 80** — set it explicitly if you care.
- Migration: `oxfmt --migrate=prettier` (or `biome`) converts existing config.

### 3.2 Config file

Searched in order: **`.oxfmtrc.json`**, **`.oxfmtrc.jsonc`**, **`oxfmt.config.ts`**. Nearest
config to each file wins (nested configs supported; disable with `--disable-nested-config`,
added in oxfmt v0.46). Schema: `"$schema": "./node_modules/oxfmt/configuration_schema.json"`.
`.editorconfig` is respected as fallback (`indent_size`, `end_of_line`, `max_line_length`).
Precedence: defaults → root config → overrides → `.editorconfig` fallback.

#### All options (exact names, types, defaults)

| Option                       | Type                                        | Default                                                |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `printWidth`                 | integer                                     | `100`                                                  |
| `tabWidth`                   | integer                                     | `2`                                                    |
| `useTabs`                    | boolean                                     | `false`                                                |
| `semi`                       | boolean                                     | `true`                                                 |
| `singleQuote`                | boolean                                     | `false`                                                |
| `jsxSingleQuote`             | boolean                                     | `false`                                                |
| `quoteProps`                 | `"as-needed" \| "consistent" \| "preserve"` | `"as-needed"`                                          |
| `trailingComma`              | `"all" \| "es5" \| "none"`                  | `"all"`                                                |
| `arrowParens`                | `"always" \| "avoid"`                       | `"always"`                                             |
| `bracketSpacing`             | boolean                                     | `true`                                                 |
| `bracketSameLine`            | boolean                                     | `false`                                                |
| `objectWrap`                 | `"preserve" \| "collapse"`                  | `"preserve"`                                           |
| `endOfLine`                  | `"lf" \| "crlf" \| "cr"`                    | `"lf"`                                                 |
| `insertFinalNewline`         | boolean                                     | `true`                                                 |
| `proseWrap`                  | `"always" \| "never" \| "preserve"`         | `"preserve"`                                           |
| `embeddedLanguageFormatting` | `"auto" \| "off"`                           | `"auto"`                                               |
| `htmlWhitespaceSensitivity`  | `"css" \| "strict" \| "ignore"`             | `"css"`                                                |
| `singleAttributePerLine`     | boolean                                     | `false`                                                |
| `vueIndentScriptAndStyle`    | boolean                                     | `false`                                                |
| `ignorePatterns`             | string[]                                    | `[]`                                                   |
| `overrides`                  | array                                       | `[]`                                                   |
| `sortImports`                | object \| boolean                           | disabled                                               |
| `sortPackageJson`            | object \| boolean                           | **enabled** (`sortScripts` sub-option default `false`) |
| `sortTailwindcss`            | object \| boolean                           | disabled                                               |
| `jsdoc`                      | object \| boolean                           | disabled                                               |
| `svelte`                     | object \| boolean                           | disabled                                               |

#### `sortImports` sub-options

- `groups` (default `["builtin", "external", ["internal", "subpath"], ["parent", "sibling", "index"], "style", "unknown"]`)
- `internalPattern` (string[], default `["~/", "@/", "#"]`) — add your workspace scope here
- `customGroups` (array of `{ groupName, elementNamePattern[], selector, modifiers[] }`;
  selectors: `type | side_effect_style | side_effect | style | index | sibling | parent | subpath | internal | builtin | external | import`;
  modifiers: `side_effect | type | value | default | wildcard | named`)
- `order` (`"asc" | "desc"`, default `"asc"`), `ignoreCase` (default `true`)
- `newlinesBetween` (default `true`), `partitionByComment` (default `false`),
  `partitionByNewline` (default `false`), `sortSideEffects` (default `false`)

#### `overrides` shape

```jsonc
{ "overrides": [{ "files": ["*.md"], "excludeFiles": [], "options": { "printWidth": 80 } }] }
```

### 3.3 CLI (exact, from `oxfmt@0.54.0 --help`)

Usage: `oxfmt [-c=PATH] [PATH]...` (globs supported, quote them; `!`-prefixed exclusions work).

- Mode: `--init`, `--migrate=SOURCE` (`prettier`, `biome`), `--lsp`, `--stdin-filepath=PATH`
- Output: `--write` (**default behavior**, format in place), `--check` (verify + stats,
  non-zero exit on unformatted), `--list-different`
- Config: `-c, --config=PATH` (`.json/.jsonc/.ts/.mts/.cts/.js/.mjs/.cjs`),
  `--disable-nested-config`
- Ignore: `--ignore-path=PATH` (repeatable); **if not specified, `.gitignore` and
  `.prettierignore` in the cwd are used**; `--with-node-modules` (node_modules skipped by default)
- Runtime: `--no-error-on-unmatched-pattern`, `--threads=INT`
- `-h/--help`, `-V/--version`

---

## 4. Recommended drop-in setup for the evs Bun monorepo

Single **root-level** config for both tools (nested configs don't merge for oxlint, and one shared
style is what we want). Per-file deviations go in `overrides`.

### 4.1 Install

```sh
bun add -d oxlint oxfmt oxlint-tsgolint
```

Pin `oxfmt` exactly (pre-1.0 output drift): in `package.json` use `"oxfmt": "0.54.0"` (no caret),
or rely on the lockfile and upgrade deliberately.

### 4.2 `/.oxlintrc.json` (repo root)

```jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  // `plugins` REPLACES the default set — defaults re-listed explicitly.
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "node"],
  "categories": {
    "correctness": "error",
    "suspicious": "warn",
    "perf": "warn",
  },
  "options": {
    // requires devDep oxlint-tsgolint and a TS7-clean tsconfig (no baseUrl)
    "typeAware": true,
    "reportUnusedDisableDirectives": "warn",
  },
  "env": { "shared-node-browser": true, "es2026": true },
  "rules": {
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "import/no-cycle": "error",
    "no-console": "warn",
  },
  "ignorePatterns": [
    "**/dist/**",
    "**/coverage/**",
    "**/contracts/out/**",
    "**/contracts/cache/**",
    "**/*.gen.ts",
  ],
  "overrides": [
    {
      "files": ["**/*.test.ts", "**/*.spec.ts", "**/test/**"],
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

Notes:

- Categories set to `"error"`/`"warn"` explicitly because the built-in default emits warnings
  with exit code 0 (verified) — CI would otherwise pass on violations.
- evs writes lots of `as const` ABI/typelevel code; if `unicorn`/`oxc` pedantry fights the
  builder DSL, demote per-rule rather than dropping the plugin.

### 4.3 `/.oxfmtrc.json` (repo root)

```jsonc
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "arrowParens": "always",
  "endOfLine": "lf",
  "sortImports": {
    "internalPattern": ["@maxencerb/"],
  },
  "sortPackageJson": true,
  "ignorePatterns": [
    "**/dist/**",
    "**/coverage/**",
    "**/contracts/out/**",
    "**/contracts/cache/**",
    "**/contracts/lib/**",
    "**/*.gen.ts",
  ],
}
```

(oxfmt also honors `.gitignore` automatically, so build dirs already gitignored are skipped even
without `ignorePatterns`. Foundry `contracts/lib` submodules should be excluded explicitly since
`--with-node-modules` only covers `node_modules`.)

### 4.4 Root `package.json` scripts

```jsonc
{
  "scripts": {
    "lint": "oxlint",
    "lint:fix": "oxlint --fix --fix-suggestions",
    "lint:ci": "oxlint --deny-warnings --format github",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "check": "bun run fmt:check && bun run lint:ci",
  },
}
```

- `oxfmt` with no flags **writes** files (Prettier needed `--write`; do not pass `--write`-less
  oxfmt in CI by accident).
- `--format github` emits GitHub Actions workflow annotations; `--deny-warnings` makes
  warn-level findings fail CI without forcing everything to `"error"` locally.
- Both binaries are workspace-aware enough that running once from the repo root covers all
  packages — no per-package scripts or turbo orchestration needed (they're ms-fast).

### 4.5 CI (GitHub Actions sketch)

```yaml
- uses: oven-sh/setup-bun@v2
- run: bun install --frozen-lockfile
# type-aware rules need workspace .d.ts across package boundaries:
- run: bun run build # or tsc -b for the packages/ graph
- run: bun run fmt:check
- run: bun run lint:ci
```

### 4.6 Editor integration

- **VS Code / Cursor:** extension **`oxc.oxc-vscode`** (Oxc), runs `oxlint --lsp` and provides
  oxfmt formatting + `source.fixAll.oxc` code action.
  (<https://github.com/oxc-project/oxc/blob/main/editors/vscode/README.md>,
  <https://open-vsx.org/extension/oxc/oxc-vscode>)

  `.vscode/settings.json`:

  ```jsonc
  {
    "editor.defaultFormatter": "oxc.oxc-vscode",
    "editor.formatOnSave": true,
    "editor.formatOnSaveMode": "file",
    "editor.codeActionsOnSave": { "source.fixAll.oxc": "explicit" },
  }
  ```

- **JetBrains:** "Oxc" plugin (<https://plugins.jetbrains.com/plugin/27061-oxc>).
- **Other editors (Zed/Neovim/Helix):** both tools ship LSP servers — `oxlint --lsp` and
  `oxfmt --lsp`.
- Known beta caveat: oxfmt `overrides` may be ignored when formatting through the VS Code LSP
  (oxc issue #21385); CLI is the source of truth.

---

## 5. tsconfig paths / workspace interplay

1. **Import-plugin resolution:** oxlint auto-discovers the relevant `tsconfig.json` **per file**
   (works with per-package tsconfigs in a workspace). Use `--tsconfig=<path>` only for
   non-standard tsconfig names/locations. `paths` aliases are honored for `import/*` rules
   (e.g. `import/no-cycle`).
2. **Type-aware (tsgolint / typescript-go) constraints:** TS 7 semantics — **`baseUrl` is not
   supported**; express aliases purely via `paths` with relative mappings, or better, via
   package `exports` + workspace deps (`"@maxencerb/evs": "workspace:*"`), which is the natural
   bun-workspaces shape anyway. Deprecated TS6 options must be removed.
3. **Cross-package types:** type-aware lint resolves workspace imports through declarations —
   **build `.d.ts` (or run `tsc -b` on a project-references graph) before `lint:ci`**. Without
   this, `typescript/*` type-aware rules degrade on imports from sibling packages.
4. **Nested configs:** both tools pick the _nearest_ config per file and oxlint configs do
   **not** merge upward — keep exactly one root `.oxlintrc.json` + one root `.oxfmtrc.json`; if
   a package ever needs its own, have it `extends: ["../../.oxlintrc.json"]` (extends merges
   `rules`, `plugins`, `overrides`).
5. **oxfmt import sorting vs aliases:** `sortImports.internalPattern` (default
   `["~/", "@/", "#"]`) controls which specifiers count as `internal`; add `"@maxencerb/"` so
   workspace-sibling imports group separately from npm externals. Subpath imports (`#x`) are a
   distinct `subpath` selector.

---

## 6. Source URLs

- oxlint config guide: https://oxc.rs/docs/guide/usage/linter/config.html
- oxlint config file reference: https://oxc.rs/docs/guide/usage/linter/config-file-reference.html
- oxlint CLI: https://oxc.rs/docs/guide/usage/linter/cli.html
- oxlint plugins: https://oxc.rs/docs/guide/usage/linter/plugins.html
- oxlint type-aware: https://oxc.rs/docs/guide/usage/linter/type-aware.html
- oxlint nested config: https://oxc.rs/docs/guide/usage/linter/nested-config.html
- oxlint JS plugins alpha: https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha
- oxfmt guide: https://oxc.rs/docs/guide/usage/formatter.html
- oxfmt config: https://oxc.rs/docs/guide/usage/formatter/config.html + config-file-reference.html
- oxfmt beta announcement: https://oxc.rs/blog/2026-02-24-oxfmt-beta
- oxfmt alpha (VoidZero): https://voidzero.dev/posts/announcing-oxfmt-alpha
- npm: https://www.npmjs.com/package/oxlint, https://www.npmjs.com/package/oxfmt
- VS Code extension: https://github.com/oxc-project/oxc/blob/main/editors/vscode/README.md
- oxfmt LSP overrides bug: https://github.com/oxc-project/oxc/issues/21385
- Release stream: https://github.com/oxc-project/oxc/releases, https://releasebot.io/updates/oxc
