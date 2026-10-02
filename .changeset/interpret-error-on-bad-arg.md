---
'@maxencerb/evs': patch
---

`interpret(script, args, chain)` now reports a wrong argument or chain on the offending value: a number for a `uint256`, a struct missing a member, a missing argument or a chain without `staticcall` reads "Type 'number' is not assignable to type 'bigint'" (or the like) right there. Before, it was "No overload matches this call" on the whole call, led (under TypeScript 7, replaced) by the script "missing the following properties from type 'ScriptIr'". `interpret` is now one signature, generic in the script's ABI, in place of the script and bare-`ScriptIr` overloads. The inferred `args` and `outcome.values` types are unchanged for both kinds of target, and a wrapper generic in its script type (`<S extends EvsScript>(s: S, args: readonly unknown[]) => interpret(s, args, chain)`) compiles as before.
