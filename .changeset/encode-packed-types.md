---
'@maxencerb/evs': patch
---

`s.encodePacked` takes in its types only what `abi.encodePacked` packs: a word, `string`, `bytes`, or an array of words (an `Expr` or a `MutArray`). A `string[]`, a struct array, a struct or a nested array type-checked and then threw `TYPE_MISMATCH` while recording. An `Expr` whose type is not known (`Expr`, `Expr<EvsType>`) is no longer accepted either: give it its type.
