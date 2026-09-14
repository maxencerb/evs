---
"@maxencerb/evs": minor
---

`s.fn` params accept composite `t.struct` / `t.tuple` types, exactly like top-level script args (#37). A struct/tuple param arrives in the fn body as a `Tuple` handle with named field access (`p.field.get()`); a composite array (`tuple[]`) or scalar param stays an `Expr`. Call sites accept a `Tuple` handle (a script arg, an `s.tuple(...)`, another fn's struct result) or a literal object, and the param is passed by reference — the caller stores the memref pointer word into the callee's param slot, so no copy is made. The former `UNSUPPORTED_V0` rejection ("composite (t.struct/t.tuple) params are not supported yet") is gone; `EvsFn` call-site params are now typed `IntoMember<t>` (an `IntoTuple` for composite params, unchanged `IntoExpr` for scalars, `IntoArray` for arrays).
