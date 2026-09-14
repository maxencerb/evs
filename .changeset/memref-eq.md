---
"@maxencerb/evs": minor
---

`eq` / `neq` now accept memref operands (`string`, `bytes`, `T[]`, structs) as **hash equality**: `a.eq(b)` records exactly `s.keccak256(a).eq(s.keccak256(b))` — byte-for-byte equality for `string`/`bytes` (raw bytes hashed, Solidity's `keccak256(bytes(a)) == keccak256(bytes(b))` idiom), element-wise equality through the standard `abi.encode` for arrays and structs. Both operands must have the same evs type; literal right-hand sides (`symbol.eq('WETH')`, `fees.neq([500n, 3000n])`) coerce like any `IntoExpr`. The `Expr.eq`/`Expr.neq` methods and `s.eq`/`s.neq` are no longer typed word-only. Closes #38.
