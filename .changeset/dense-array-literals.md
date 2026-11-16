---
'@maxencerb/evs': minor
---

An array literal with a hole or an `undefined` element is refused, naming the index. A sparse array (`[a, , c]`, `new Array(n)`, a `delete`d element) used to throw a raw `TypeError: Cannot convert undefined to a BigInt` for a constant word array, and to record a zero, an empty string or a zeroed struct in the hole everywhere else (`[x, , 7n]` recorded `[x, 0, 7]`). Every array literal now throws `EvsTypeError` (`TYPE_MISMATCH`), for example `s.lit()[1]: the element is a hole (the array is sparse) — an array literal gives every element a value`.
