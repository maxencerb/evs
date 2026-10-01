---
'@maxencerb/evs': minor
---

`interpret()` now runs dead-code elimination before executing, so it agrees with the compiled bytecode when an unused checked operation would revert. Before, `interpret(script.ir, …)` executed the recorded IR: a script such as `a.sub(b); return s.return({ a })` reverted with `Panic(0x11)` under the interpreter for `a < b`, while the bytecode `compile()` emits (lowered from `eliminateDeadCode(ir)`, which drops the unused subtraction and its guard) returned. The same applied to unused `div`/`mod`, `pow`, `addmod`/`mulmod`, narrowing conversions, `array.at(i)`, `s.newArray` length guards and calls to pure `s.fn`s. The new `opts.dce` flag (default `true`) opts out: `interpret(ir, args, chain, { dce: false })` runs the IR exactly as recorded. With tracing on, `stmtPath`s index the IR that ran. Emitted bytecode is unchanged.

The docs no longer claim that dropping unused revert guards matches the Solidity optimizer: solc 0.8.30 keeps the `Panic` of an unused `a - b;` with the optimizer off, on and via-IR. The `CERTAIN_PANIC` message and the arithmetic guide now say that the cell escape hatch only panics at runtime if its result is used.
