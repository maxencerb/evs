---
'@maxencerb/evs': patch
---

Smaller, cheaper allocations in the emitted bytecode. `s.newArray` of strings, bytes, arrays or structs, `s.tuple` with no omitted word member, and the zero values of all-memref structs and of fixed-size arrays with `string`/`bytes`/array/struct elements no longer zero-fill memory that is overwritten right away. `s.newArray` computes its size once. On `paris` / `shanghai`, the `@memcpy` loop now costs 67 gas per copied word instead of 76, with a shorter body. Behaviour is unchanged, but the runtime bytecode of affected scripts changes. One side effect: struct zero values ending in an all-`string`/`bytes`/array struct use one fewer stack slot, so `s.tuple` / `s.newArray` over such a struct accept one more nesting level before `UNSUPPORTED_V0`.
