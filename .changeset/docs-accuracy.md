---
'@maxencerb/evs': patch
---

`s.return` rejects a literal value with a fix that fits its shape: an array of struct literals now points at `s.lit(t.array(type), value)` or `s.newArray`, and a struct literal at `s.lit` or `s.tuple`; a multi-output call result (an array of handles) or a try verb's `{ success, value }` wrapper is told to return its outputs under their own keys (or use `struct: true`). Documentation fixes: dirty returndata words are normalized like Solidity's ABI coder v1 (not "like viem's decoder"), and `s.tryRead`'s `success` is not a range check; `s.return` takes handles only; `UNSUPPORTED_V0` can be an `EvsCompileError` at compile time and `INTERNAL` can come from invalid loaded IR.
