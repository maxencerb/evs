---
'@maxencerb/evs': patch
---

Fix `s.tryRead` / `s.tryCall` / `s.trySimulate` failing to compile (`EvsInternalError`, asm verifier stack-height mismatch) when the called function's output has a dynamic leaf inside a composite: arrays with dynamic elements (`string[]`, `bytes[]`, `T[][]`, `tuple[]` with a dynamic member) and structs with a `string` / `bytes` / `T[]` member. These now compile and, at runtime, report `success = true` with the decoded value, or `success = false` with the zero value when the call reverts or the returndata is malformed.
