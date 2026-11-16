---
'@maxencerb/evs': minor
---

The types of the positions that take a value of a given type now accept what recording takes there, as call arguments already did. `s.lit`, `s.let(type, init)` and `Cell.set` took only constants for a struct or a struct array, and no bare handle: `s.lit(Position, { owner, amount: 1n })` with `owner` an `Expr`, `s.let(Position, position)` with a `Tuple`, `cell.set(list)` with a `MutArray` were type errors, and all of them recorded. `s.select`'s branches and `x.eq(v)` take the same now: `s.select(flag, a.expr(), { owner, amount })`, `position.expr().eq(other)` with `other` a `Tuple`.

An `Expr` of a struct also fits wherever a struct value is taken (a member of a struct argument, an element of a struct array, `Field.set`, `MutArray.set`, an `s.tuple` member, an `s.fn` argument): the types refused it, recording took it.
