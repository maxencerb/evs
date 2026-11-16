---
'@maxencerb/evs': patch
---

A fixed-size array literal of a word type is checked for its length by the types, as a struct array literal already was: `s.lit(t.array(t.uint256, 3), [1n])` and a `uint8[3]` argument given `[1, 2]` were accepted and then threw `TYPE_MISMATCH` while recording. The literal is now a tuple of exactly N elements in the types, up to 99 (abitype's bound; past that, recording checks the length as before). An array built at run time (`Array.from(…)`) for a fixed-size type needs a cast to that tuple.
