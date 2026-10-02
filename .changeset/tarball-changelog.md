---
'@maxencerb/evs': patch
---

The npm package now ships `CHANGELOG.md`, so the release notes (breaking changes included) can be read from `node_modules/@maxencerb/evs` instead of GitHub only. Its `package.json` no longer carries the repository's `scripts`, `devDependencies` and `//` comment fields, which a consumer never uses. The library code and bytecode are unchanged.
