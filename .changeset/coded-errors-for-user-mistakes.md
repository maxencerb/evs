---
'@maxencerb/evs': patch
---

Four mistakes a user can make no longer end in an internal error or a raw `TypeError`:

- a script named `__evs_simulate` with the arguments `(address, bytes)` that uses `s.simulate` failed `compile()` with an `EvsInternalError` asking to report a bug in evs; it is now an `EvsTypeError` (`ABI_SHAPE`) that says the selector is reserved and to rename the script;
- `eliminateDeadCode(script)` (the script instead of `script.ir`) threw `TypeError: Cannot read properties of undefined`; it is now a `TYPE_MISMATCH` that says what to pass;
- an operand that cannot be turned into a string, such as `x.add(Object.create(null))`, threw `TypeError: Cannot convert object to primitive value` from the error message itself; a rejected literal is now described as `an object` without calling its `toString`, and a `Proxy` around a handle is named as the operand it is;
- the `LoopCtl` of an `s.while` exposed its recorder and an `emit()` method that recorded a `break` with no scope check, which `compile()` then reported as an internal error. A loop control now holds nothing but `break` and `continue`, and both are refused outside the body of their loop.
