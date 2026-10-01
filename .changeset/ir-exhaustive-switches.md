---
"@maxencerb/evs": patch
---

`interpret(…, { trace: true })`: the trace note of a fixed-size `arrnew` now shows its size
(`arrnew uint256[3]`, previously `arrnew uint256[]`). `validateIr` now rejects a hand-built
`un`, `env` or `modarith` statement whose `op` is not a known one (it used to check it as
`bitnot`, type it `uint256`, or accept it and interpret it as `mulmod`). Internally, the IR
statement and op switches in `validateIr`, `deserializeIr`, the interpreter and the
dead-code pass are now checked for exhaustiveness at compile time, and `validateIr`'s
statement checker is split into per-family methods. No bytecode changes.
