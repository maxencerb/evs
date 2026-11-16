---
'@maxencerb/evs': patch
---

The operators on the builder check their operands in the types, as the methods do. `s.add(amount, decimals)` with a `uint256` and a `uint8` type-checked and then threw `TYPE_MISMATCH` when the script was recorded, where `amount.add(decimals)` was a type error: TypeScript inferred the operand type from both arguments, as the union of the two. The same held for every two-operand function on `s` (`s.sub` … `s.mod`, the `wrapping` forms, `s.lt` … `s.gte`, `s.eq`, `s.neq`, `s.and`, `s.or`, `s.bitAnd`, `s.bitOr`, `s.bitXor`), for the branches of `s.select`, for `s.let(type, init)` and for the bounds of an `s.for` with a `type`. `s.eq(cell, 1n)` and `s.select(flag, tuple, tuple)` type-checked too, and so did two literals (`s.add(1n, 2n)`), which no operand gives a type.

The type now comes from the operand that is an `Expr`, and the other operand is checked against it. Two `Expr`s of different types are an error on the second operand, in the words of the method form: `Argument of type 'Expr<"uint8">' is not assignable to parameter of type 'IntoExpr<"uint256">'`. With two literals the error is the recorder's message, `at least one operand must be an Expr — type a literal with s.lit(type, value)`. A literal on either side of an `Expr` works as before, and nothing changes when a script is recorded.

Two calls that were accepted are now type errors although some of their uses record: a first operand typed `IntoExpr<t>` next to a literal (`s.mul(x, 2n)` with `x: IntoExpr<'uint256'>`, which throws when `x` is a literal), and a first operand typed `any` next to a literal. Give the first operand its type, or type the literal with `s.lit`.
