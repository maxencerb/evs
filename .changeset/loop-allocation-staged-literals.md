---
'@maxencerb/evs': patch
---

`LOOP_ALLOCATION` now flags a sub-call in a loop that stages literal arguments. A call with a struct, fixed-size array or array-of-composites argument is encoded without folding its literals into the calldata: each literal `string`/`bytes` or all-literal word-array argument is first copied into a block allocated at the free pointer, on every execution. Before, such a call with word-only outputs (for example `f((uint256), string)` returning `uint256`, with the string from an `s.lit` hoisted before the loop) grew memory on every iteration without a warning. The message names it as `s.read(f) (staged call-arg literals)`. The bytecode is unchanged.
