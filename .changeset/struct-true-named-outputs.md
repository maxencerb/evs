---
'@maxencerb/evs': patch
---

`struct: true` is now a compile error on a call whose function has an unnamed output, or no output. It used to type-check, the result being a `Tuple` with a member named `""`, and recording then threw `ABI_SHAPE` (`output #0 of "getConfig" is unnamed`). The error sits on `struct` and says why: `'evs: struct: true needs every output named': "an output of getConfig is unnamed — use the default positional result (omit struct)"`. A Solidity getter that returns a struct has one unnamed tuple output: its default result is already a `Tuple` keyed by member name.
