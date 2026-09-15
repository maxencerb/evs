---
"@maxencerb/evs": patch
---

`decodeScriptError` / `matchScriptError` now recognise a revert thrown by any copy of viem, not only the one evs resolved. The decoder walked the error tree through `instanceof BaseError` against its own viem import, so when the caller's viem was a different module instance (a second bundle on a page, a pnpm-duplicated version, two lockfile entries in a monorepo) a genuine revert failed the check and `matchScriptError` rethrew it as "not a script error". The walk is now shape-based: it follows the `cause` chain and identifies the carrier by its `name`/`raw` or hex `data` fields. viem is no longer a runtime import of the error decoder.
