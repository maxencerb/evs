---
'@maxencerb/evs': patch
---

Reject an empty return record. `s.return({})` used to compile to a script whose ABI output is a zero-component tuple, so every read returned `0x` and viem failed with "returned no data". It is now a type error (via the new exported `NonEmptyReturn` guard) and throws `EvsTypeError` (`ABI_SHAPE`) at recording time; `buildScriptAbi` rejects an empty `returns` list the same way. A guard-only script can return a flag such as `s.return({ ok: s.lit(t.bool, true) })`.
