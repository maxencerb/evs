---
'@maxencerb/evs': patch
---

`toUint` / `toInt` on a non-numeric receiver: the compile error now names the conversion to use first, as the recording-time `TYPE_MISMATCH` does. Since 0.3.0 `addr.toUint(t.uint160)` was rejected by tsc with an opaque "`'this'` context … is not assignable to … `Expr<never>`"; the method's `this` type is now the message itself (`".toUint(): cannot convert from 'address' — the source must be numeric (uintN/intN) — use .asUint160() first (then .toUint(…))"`, and `.asUint()` for a `bytesN`; any other non-tuple receiver gets the recording-time text without a hint, e.g. ".toUint(): cannot convert from 'bool' — …"). The same receivers are rejected as before; numeric receivers, including a generic one bounded by the numeric types, infer as before.
