---
'@maxencerb/evs': minor
---

A struct out of `Cell.get()`, `s.select()` and `s.lit()` is now a `Tuple` handle, like a struct out of a field, an array element, a call or an `s.fn`. It was an `Expr` of the struct, which has no members: `s.let(Position, a).get().owner.get()` threw a raw `TypeError` while recording, and a struct picked with `s.select` could not be read at all. Now its members read as on any struct (`best.get().owner.get()`), and the bytecode of a script is unchanged.

`s.select`'s branches and the one-argument `s.let(init)` also take a bare `Tuple` or `MutArray` handle, so a selected struct can be selected again or kept in a cell. Code that called an `Expr` method on such a value (`cell.get().eq(other)`) now calls it on `cell.get().expr()`, or uses `s.eq(cell.get(), other)`; in JavaScript, `.eq()` and `.neq()` on a struct handle throw an `EvsTypeError` (`TYPE_MISMATCH`) that says so. A generic helper that selects between two `Expr<n>` of a type parameter `n` gets `ArgHandle<n>` back, which TypeScript resolves only once `n` is known; a `Cell<n>` still reads an `Expr<n>`.
