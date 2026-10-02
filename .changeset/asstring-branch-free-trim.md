---
'@maxencerb/evs': patch
---

`bytesN.asString()` now costs the same gas whatever the word. It used to find the last nonzero byte with a loop, about 67 gas per trailing zero byte: 2,269 gas for an all-zero `bytes32` (a failed `symbol()` read), 2,093 for `'MKR'`. The trim is now branch-free (a fold of each byte onto one flag bit, the lowest flag isolated, one multiply), so `asString()` costs about 140 gas for every word, all-zero included. A word with no trailing zero byte costs 18 gas more than before, and each `asString()` site is 63 bytes larger. Results are unchanged.
