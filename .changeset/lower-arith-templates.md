---
'@maxencerb/evs': patch
---

Smaller and cheaper bytecode for common arithmetic, array and `select` patterns, with unchanged results and panics. Unsigned `mul` by a literal checks the other operand against `⌊max / c⌋` instead of running the general overflow test, and `int256` `add` / `sub` by a literal checks only the overflow direction the literal's sign allows (a negative literal is applied as its magnitude, so `x.add(-1n)` no longer pushes a 32-byte immediate). `array.at(k)` and `MutArray.set(k, …)` with a literal index below 2^32 use a constant bound and offset. `s.select` no longer jumps: it compiles to `b ^ ((a ^ b) · cond)`. With `optimize: true`, method chains such as `x.add(y).mul(z)` now fuse every intermediate store and reload: the commutative ops and the comparisons load the operand the previous statement just stored first. Compiled bytecode changes for scripts that use these patterns.
