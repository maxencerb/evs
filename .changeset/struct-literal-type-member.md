---
'@maxencerb/evs': patch
---

A struct literal with a member named `type` is no longer mistaken for a forged `Expr` handle. With a value such as `'address'` or `'uint256'`, `.eq()` / `.neq()` on a struct `Expr`, `s.eq` / `s.neq` and `s.select` threw `EvsScopeError` (`FOREIGN_HANDLE`, "looks like an Expr handle but was not created by this copy of evs") where call args and `s.lit` took the same literal. An object is now reported as a foreign handle only when it also carries the `Expr` methods.
