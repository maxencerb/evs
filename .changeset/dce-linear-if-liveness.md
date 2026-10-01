---
'@maxencerb/evs': patch
---

`compile()` and `eliminateDeadCode` are faster on scripts with many nested or chained `s.if`s. The dead-code pass used to re-scan every `if` until nothing changed, which cost time quadratic in the length of a chain of ifs linked through cells and cubic in the depth of nested ifs (about 145 ms for 400 nested ifs). It now runs in time linear in the script's size (under 1 ms for the same script). The pass keeps exactly the same statements, so the emitted bytecode does not change.
