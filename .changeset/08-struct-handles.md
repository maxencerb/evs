---
'@maxencerb/evs': minor
---

pr: 186

A struct out of `Cell.get()`, `s.select()` and `s.lit()` is now a `Tuple` handle, like a struct out of a field, an array element, a call or an `s.fn`. It was an `Expr` of the struct, which has no members: `s.let(Position, a).get().owner.get()` threw a raw `TypeError` while recording, and a struct picked with `s.select` could not be read at all. Now its members read as on any struct (`best.get().owner.get()`). This change leaves the bytecode of a script as it was.

What 0.6.0 code that used such a struct as an `Expr` changes:

- An `Expr` method on it (`cell.get().eq(other)`, `.neq(other)`) is called on `cell.get().expr()`, or replaced by `s.eq(cell.get(), other)`. In JavaScript, `.eq()` and `.neq()` on a struct handle throw an `EvsTypeError` (`TYPE_MISMATCH`) that says so.
- `.type` is gone from it (`undefined` in JavaScript, unless the struct has a member named `type`): read `cell.get().expr().type`. A generic helper that wrote `s.let(v.type, v)` can write `s.let(v)`, which now takes a struct handle.
- A generic helper that selects between two `Expr<n>` of a type parameter `n` gets `ArgHandle<n>` back, which TypeScript resolves only once `n` is known: cast it, `s.select(c, a, b) as Expr<n>`. A `Cell<n>` still reads an `Expr<n>`.

The positions that take a struct take the handle itself, and more of what recording took there:

- `s.select`'s branches and the one-argument `s.let(init)` take a bare `Tuple` or `MutArray` handle, so a selected struct can be selected again or kept in a cell. `s.select(flag, tuple, tuple)` on two struct handles, which 0.6.0 typed and then refused while recording, records.
- `s.lit`, `s.let(type, init)` and `Cell.set` took only constants for a struct or a struct array in their types, and no bare handle: `s.lit(Position, { owner, amount: 1n })` with `owner` an `Expr`, `s.let(Position, position)` with a `Tuple`, `cell.set(list)` with a `MutArray` were type errors, and all of them recorded. `s.select`'s branches and `x.eq(v)` take the same now: `s.select(flag, a.expr(), { owner, amount })`, `position.expr().eq(other)` with `other` a `Tuple`.
- An `Expr` of a struct also fits wherever a struct value is taken (a member of a struct argument, an element of a struct array, `Field.set`, `MutArray.set`, an `s.tuple` member, an `s.fn` argument): the types refused it, recording took it.
- `s.eq` and `s.neq` are typed for a `Tuple` or a `MutArray` handle. Recording has always taken a bare handle there for its memref, but the types refused `s.eq(array, mutArray)` and `s.eq(position, other.expr())`, so a script that compared two structs had to call `.expr()` on both. A handle now types the comparison like the `Expr` of its `expr()`: the other side is a handle, an `Expr` or a literal of that type, and a handle of another type is an error on the second operand.
