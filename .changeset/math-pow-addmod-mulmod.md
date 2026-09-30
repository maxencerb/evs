---
'@maxencerb/evs': minor
---

Add checked exponentiation and modular arithmetic. `x.pow(e)` / `s.pow(x, e)` is Solidity's checked `x ** e`: it reverts with `Panic(0x11)` when the power does not fit the base's type (including signed bases, where `(-2) ** 7` fits `int8`), `0 ** 0 == 1`, and the exponent is any unsigned `Expr` or a literal. A literal base or a literal exponent compiles to one range check plus one `EXP`; otherwise evs runs solc's square-and-multiply loop. `x.addmod(y, n)` / `x.mulmod(y, n)` (and `s.addmod` / `s.mulmod`) compute `(x + y) % n` and `(x * y) % n` over `uint256` without wrapping the intermediate, and revert with `Panic(0x12)` on a zero modulus. The check is dropped for a nonzero literal modulus. `shl` / `shr` now also accept `intN` on the typed surface, where `shr` is the arithmetic shift, as in Solidity. Results and panic codes match solc 0.8.30.
