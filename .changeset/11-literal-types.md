---
'@maxencerb/evs': minor
---

pr: 186

Three positions type a value exactly as recording takes it. The first two also refuse 0.6.0 code that recorded: an `Expr` of unknown type in `s.encodePacked`, and an array built at run time for a fixed-size type.

- `s.encodePacked` takes in its types only what `abi.encodePacked` packs: a word, `string`, `bytes`, or an array of words (an `Expr` or a `MutArray`). A `string[]`, a struct array, a struct or a nested array type-checked and then threw `TYPE_MISMATCH` while recording. An `Expr` whose type is not known (`Expr`, `Expr<EvsType>`) is no longer accepted either (`… is not assignable to parameter of type 'PackedValue'`): give it its type.
- A fixed-size array literal of a word type is checked for its length by the types, as a struct array literal already was: `s.lit(t.array(t.uint256, 3), [1n])` and a `uint8[3]` argument given `[1, 2]` were accepted and then threw `TYPE_MISMATCH` while recording. The literal is now a tuple of exactly N elements in the types, up to 99 (abitype's bound; past that, recording checks the length as before). An array built at run time (`Array.from(…)`) for a fixed-size type needs a cast to that tuple (`as [bigint, bigint, bigint]`).
- `s.tuple(type)` takes a struct or tuple type in its types too: `s.tuple(t.array(Position))` type-checked and then threw `TYPE_MISMATCH` while recording. An array of structs is built with `s.newArray` or given as a literal.
