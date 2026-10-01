---
"@maxencerb/evs": patch
---

Tighten four places where the types accepted code that fails at recording or typed a result the runtime does not return.

- `toUint` / `toInt` are typed for numeric receivers only, like the other conversions: `addr.toUint(t.uint160)`, `flag.toUint(t.uint8)` or `word32.toInt(t.int256)` on an `address` / `bool` / `bytes32` / `string` / array `Expr` is now a compile error instead of a `TYPE_MISMATCH` thrown at recording. A `bytes32` goes through `asUint256()` first.
- With a widened ABI (typed `Abi`, imported from JSON, or declared without `as const`), `s.read` / `s.call` / `s.simulate` and the `value` of their `try*` variants are typed `Expr | Tuple | readonly (Expr | Tuple)[] | undefined`, the shapes the recorder returns for no output, one output and several outputs. They were typed `readonly (Expr | Tuple)[]`, so `res[0]` or `const [x] = res` on a single-output function type-checked and then failed at recording.
- With an `as const` ABI that has no function in the verb's mutability bucket (an all-`nonpayable` ABI under `s.read`, an all-`view` ABI under `s.call`), `functionName` now accepts nothing, so the wrong verb is a compile error as it already was for mixed ABIs. `SubcallFunctionName` returns `never` there instead of viem's `string` fallback; a widened ABI still accepts any name.
- A script returning more than about 45 keys no longer overflows the type-instantiation depth: `client.readContract(...)` on it was typed `unknown`. The return record is now ordered with the same tail-recursive helper `t.struct` uses (checked up to 150 keys).
