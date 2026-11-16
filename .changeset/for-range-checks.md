---
'@maxencerb/evs': minor
---

`s.for` checks its range. A key the range does not have was ignored, so `s.for({ from: 0n, until: 6n, setp: 2n }, …)` recorded a step of 1: it now throws `TYPE_MISMATCH` naming the key and, for a typo, the key it resembles. `step: null` was read as the default and is now refused (leave `step` out for a step of 1). A literal `step` of `0` recorded a loop that only ends by running out of gas: it now throws `LITERAL_RANGE`. A step computed at run time is recorded as before.
