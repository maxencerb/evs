---
'@maxencerb/evs': patch
---

The type error for `toUint` / `toInt` on a value that is not a number reads as one sentence, and says what to write for a `bool`. On an `address`, TypeScript 7 reported `Property '[conversionHint]' is missing in type 'Expr<"address">' but required in type '{ readonly [conversionHint]: "…" }'`, with the advice inside the type. The error is now, under every supported checker, `The 'this' context of type 'Expr<"address">' is not assignable to method's 'this' of type '".toUint(): cannot convert from 'address' — the source must be numeric (uintN/intN) — use .asUint160() first (then .toUint(…))"'`. The same goes for `wrappingToUint`, `wrappingToInt` and `asInt`. On a `bool` the message named no fix: it now ends with `— use s.select(flag, s.lit(type, 1), 0)`, in the type error and in the `TYPE_MISMATCH` thrown at recording.
