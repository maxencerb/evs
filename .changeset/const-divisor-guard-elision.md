---
'@maxencerb/evs': patch
---

Checked `div` / `mod` by a nonzero literal divisor no longer emits the `Panic(0x12)` division-by-zero check, and signed `div` by a literal other than `-1` no longer emits the `minN / -1` overflow check. Neither can fire for such divisors, so behavior is unchanged; bytecode is smaller and cheaper (about 19% bytes and 27% gas on a const-divisor-heavy script).
