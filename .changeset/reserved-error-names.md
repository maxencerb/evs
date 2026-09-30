---
'@maxencerb/evs': patch
---

Reject error and script names that collide with an existing arm of the error switch.

- `t.error('empty', …)` and `t.error('unknown', …)` now throw `EvsTypeError('ERROR_DECL')`: both names are built-in `decodeScriptError` arms (empty revert, unrecognized selector). `matchScriptError` also sends those args-less arms to `_`, never to a same-named declared handler, and the `_` handler's type now includes them.
- A script whose `name` equals an error name in its ABI (a declared error, `EvsDecodeError` or `EvsInvalidCalldata`) now throws `EvsTypeError('ERROR_DECL')` from `evscript`. Before, it compiled, but viem could not call it (`Function not found on ABI`). `Panic` and `Error` script names still work.
