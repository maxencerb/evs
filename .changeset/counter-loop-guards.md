---
'@maxencerb/evs': patch
---

`s.for` and `s.forEach` loops are cheaper and smaller: the counter step no longer carries an overflow check and `s.forEach`'s element read no longer carries a bounds check, since the loop condition already proves both. The same applies to `arr.at(i)` / `out.set(i, …)` inside an `s.for` running until that array's length (or an `s.newArray` length), and under an `s.if(i.lt(arr.length()), …)` guard. Behavior is unchanged: every value, result and revert stays the same.
