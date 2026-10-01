---
'@maxencerb/evs': patch
---

Fix builder entry points that typechecked but always failed when the script was recorded:

- `s.let(type, init)` with a `t.struct`, `t.tuple` or `tuple[]` type now returns a cell of that type. It used to throw `TYPE_MISMATCH` with a message for the one-argument form ("init must be an Expr when no type is given").
- `s.lit(type, value)` now accepts `t.struct`, `t.tuple` and `tuple[]` types and builds the value the same way a call argument or return value does. It used to reject every non-string type.
- `s.select(cond, a, b)` with a condition known at recording (`true`, or a folded comparison) now accepts every literal on the dropped side that a runtime condition accepts: `string[]`, `T[][]`, `tuple[]` and struct literals, and word arrays holding an `Expr`. They are checked under the same rules, then left out of the bytecode.
- `.length()` on a plain tuple `Expr` (reachable from plain JS or through a cast) now throws `EvsTypeError` (`TYPE_MISMATCH`) where it is called. Before, it threw `EvsInternalError` at `compile()`.
- Catching an error thrown while an `s.fn` body is recorded and then finishing the script no longer fails with `EvsInternalError` ("fn slot N was never filled"). The failed definition is discarded. If the failed body had already defined a nested `s.fn`, `evscript` now throws `EvsScopeError` (`SCOPE_VIOLATION`).
