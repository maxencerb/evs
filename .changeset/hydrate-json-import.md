---
'@maxencerb/evs': patch
---

`hydrate` type-checks on a JSON module. `import data from './script.json'` widens `version` to `number`, and `hydrate(data)` failed with a long error that printed the whole widened ABI before saying so, although the same call worked at run time. `hydrate` now has a signature for data without its literal types: it returns a `PrecompiledScript` with a wide ABI (viem infers nothing from it), and its documentation points to the `.ts` module ending with `as const` that keeps the literal types. The `debug` loader accepts a JSON module too: `() => import('./script.debug.json', { with: { type: 'json' } })`.
