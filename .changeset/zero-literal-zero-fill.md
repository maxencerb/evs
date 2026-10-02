---
"@maxencerb/evs": patch
---

An all-zero or mostly-zero literal (one whose memory image is at least half zero words, such as `s.lit(t.array(t.uint256, 800), zeros)` or an empty `bytes`) is now a zero-filled allocation plus one store per nonzero word instead of a bytecode data segment that spent 32 bytes on every zero word. A zero `uint256[800]` used to fail with `COMPILE_LIMIT` (25,867 bytes of runtime); it now compiles to 237 bytes, and a zero `uint256[64]` shrinks from 2,314 to 235 bytes. The zero-fill costs the same gas per word as the `CODECOPY` it replaces (+8 gas for an all-zero literal), and each nonzero word of a sparse literal adds about 17 gas for its store. `s.newArray(elem, n, { fixed: true })` is the mutable spelling of the same zero array; `s.let` still requires an init.
