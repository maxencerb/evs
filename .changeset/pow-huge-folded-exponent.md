---
'@maxencerb/evs': patch
---

`compile()` no longer crashes with `RangeError: Maximum BigInt size exceeded` when `s.pow` has a literal or folded exponent of about 2^30 or more (up to 2^256 − 1). Such a power now compiles to the same result as solc: bases 0 and 1 (and −1 for signed types) return their exact value, and every other base panics with `Panic(0x11)`.
