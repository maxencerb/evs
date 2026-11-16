---
'@maxencerb/evs': minor
---

pr: 183

`bitAnd`, `bitOr`, `bitXor` and `bitNot` are typed for `intN`. They already recorded, folded and ran on a signed integer, with the result Solidity gives, but `tick.bitAnd(0xff)` on an `int24` was a type error, the reference listed `uintN` and `bytesN` only, and the error for an `address` operand said so too. The methods and `s.bitAnd` / `s.bitOr` / `s.bitXor` / `s.bitNot` now take a `uintN`, an `intN` or a `bytesN`: on an `intN` they work on the two's-complement bits of the value and the result is an `intN` of the same width (`-2 & 0xff` is `254` on an `int24`, `~-2` is `1`). The exported `BitsType` includes `IntType`, and the `TYPE_MISMATCH` message reads `operands must be uintN/intN/bytesN`. Going through `asUint()` and back with `asInt()` to mask a signed value is no longer needed.
