---
'@maxencerb/evs': minor
---

Add opt-in wrapping arithmetic and a full-precision `mulDiv`. `wrappingAdd` / `wrappingSub` / `wrappingMul` (on any numeric `Expr`, and as `s.wrappingAdd(a, b)`, …) compute Solidity's `unchecked` result modulo 2^N and never revert; checked arithmetic stays the default. `mulDiv(b, d)` / `mulDivRoundingUp(b, d)` (on `Expr<'uint256'>`, and as `s.mulDiv(a, b, d)`, …) compute `⌊a·b/d⌋` / `⌈a·b/d⌉` over a 512-bit intermediate with the FullMath algorithm, reverting `Panic(0x12)` on a zero denominator and `Panic(0x11)` when the quotient overflows uint256 (OpenZeppelin `Math.mulDiv`'s codes). Both are verified against solc 0.8.30. The serialized IR gains the `bin` ops `wrapadd` / `wrapsub` / `wrapmul` and the `modarith` ops `muldiv` / `muldivup`; existing scripts compile to the same bytes.
