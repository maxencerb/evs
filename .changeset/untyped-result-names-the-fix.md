---
'@maxencerb/evs': minor
---

The result of a call verb on an ABI with no literal type (typed `Abi`, imported from JSON, or declared without `as const`) now says what is missing when it is used. Its type, `WideSubcallResult`, is declared under the name `TypedResultRequiresAbiAsConst`, and its member for a function without outputs is `void` instead of `undefined`. `decimals.toUint(t.uint256)` on such a result used to give `'decimals' is possibly 'undefined'` followed by an error on a three-member union; it now gives `Property 'toUint' does not exist on type 'TypedResultRequiresAbiAsConst'`. Casting the result (`as Expr<'uint8'>`) works as before. Two type-level changes come with it: the result no longer fits a slot typed `… | undefined` (compare it with `=== undefined` or cast it), and an `s.read` or `s.simulate` call (or their `try` forms) whose parameter object is typed `any` now gets this result instead of `Tuple<TupleType>`.
