---
"@maxencerb/evs": minor
---

Add an opt-in peephole optimizer behind `compile(script, { optimize: true })` (#39). The built-in pass (`evsPeephole`, also exported) folds store-then-reload slot pairs (`PUSH s MSTORE PUSH s MLOAD` → `DUP1 PUSH s MSTORE`), reloads of a just-loaded slot, arithmetic over two immediates (256-bit wraparound, EVM division-by-zero semantics, never widening the immediate), and stack identities (`SWAP1 SWAP1`, `DUP1 POP`, `PUSH 0 ADD`, …). It never rewrites across a `JUMPDEST` or touches a jump target, preserves every source-map location, and runs before the mandatory verifiers. `optimize` defaults to `false` and the default output is byte-identical to before; a user `peephole` hook keeps working and runs after the built-in pass.
