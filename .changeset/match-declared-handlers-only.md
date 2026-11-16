---
'@maxencerb/evs': minor
---

`matchScriptError` calls a handler by name for a declared error only. A handler under `Panic` or `Error` used to take that revert away from `_` and was called with `{}` as its first argument, so `Panic: (p) => p.code` read `undefined`; a handler under `EvsDecodeError` or `EvsInvalidCalldata` was called too. These reverts now always reach `_`, and a handler under any key that is neither a declared error nor `_` is a type error, a misspelled error name included (it used to compile once its parameters were annotated). The reference page listed the four names as optional handlers: move such a handler into `_` and switch on `other.name` there, where each arm is typed (`other.code` and `other.meaning` for a Panic, `other.reason` for an `Error(string)`).
