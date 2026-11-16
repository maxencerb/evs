---
'@maxencerb/evs': patch
---

`s.tuple(type)` takes a struct or tuple type in its types too: `s.tuple(t.array(Position))` type-checked and then threw `TYPE_MISMATCH` while recording. An array of structs is built with `s.newArray` or given as a literal.
