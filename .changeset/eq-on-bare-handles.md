---
'@maxencerb/evs': minor
---

`s.eq` and `s.neq` are typed for a `Tuple` or a `MutArray` handle. Recording has always taken a bare handle there for its memref, but the types refused `s.eq(array, mutArray)` and `s.eq(position, other.expr())`, so a script that compared two structs had to call `.expr()` on both. A handle now types the comparison like the `Expr` of its `expr()`: the other side is a handle, an `Expr` or a literal of that type, and a handle of another type is an error on the second operand.
