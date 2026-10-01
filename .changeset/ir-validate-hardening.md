---
'@maxencerb/evs': patch
---

`compile()` and `interpret()` now reject deserialized IR that the builder can never record, instead of compiling it or letting the interpreter and the bytecode disagree: a `tuplenew` typed as a tuple array (the bytecode read member 0 as the array length), an `arrset` on anything but an `arrnew` result (a decoded `uint256[]` output aliases the returndata, so the write could change another output), zero-component tuples, arrays nested deeper than four levels in any declared type or call ABI, and return names that are not identifiers. A type whose ABI static size is 2^32 bytes or more, anywhere in the IR, is rejected by both with the same `EvsTypeError` (`UNSUPPORTED_V0`) the `t` constructors throw; before, `interpret()` ran such IR while `compile()` rejected it. An empty `returns` list stays legal at the IR level, and the docs now say so.
