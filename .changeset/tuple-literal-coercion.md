---
'@maxencerb/evs': minor
---

Tuple literals now follow abitype and viem's naming rule everywhere: a literal is an object keyed by member name only when every member is named, and a positional array as soon as one member is unnamed (an empty `name`, or no `name` key at all, as viem's `parseAbi` emits). This applies to `s.tuple` inits, `Field.set`, `Cell.set`, `MutArray.set`, call arguments (overload resolution included), `s.fn` arguments, `tuple[]` literal elements and `s.throw` arguments, at the type level and at recording alike. Before, a partly named tuple (common in `t.fromOutputs` of a verified ABI, such as `returns (uint256 amountOut, uint256)`) was typed positionally in call args and returns (viem) but as a name-keyed record in `s.tuple` inits, and recorded only as a name-keyed record, so its unnamed member was silently zero. **Behavior change:** `s.tuple(T, { amountOut })` for such a tuple now throws; write `s.tuple(T, [amountOut])`.

Shapes that used to be accepted or ignored now throw `TYPE_MISMATCH` at recording:

- a struct literal key that names no member (before, the intended member silently stayed zero);
- an element past the last member of a positional literal;
- an index-keyed record such as `{ 0: x, 1: y }` for a fully unnamed `t.tuple` (before, it was read positionally); write the array `[x, y]`;
- a `Cell`, `Field` or `MutArray` handle where a tuple is expected (before, it became an all-zero tuple; read it with `.get()`);
- a `Tuple` or `Expr` handle as an `s.tuple` init (before, an all-zero tuple); pass the handle itself where the tuple is expected.

Struct members are read from the literal's own properties, so an omitted member named like an `Object.prototype` method (`toString`, `constructor`, …) zero-fills like any other instead of throwing, and `s.throw` reports such a missing named arg as missing.
