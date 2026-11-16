---
'@maxencerb/evs': minor
---

`s.throw` refuses values after its args instead of dropping them: `s.throw(E, { a: 1n }, { a: 2n })` recorded the first record and ignored the second, and now throws `TYPE_MISMATCH`. A misspelled arg name is still refused, and now names the arg it resembles.
