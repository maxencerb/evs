---
'@maxencerb/evs': patch
---

`compile(script, { optimize: true })` output is smaller and cheaper: a value that is read once, by the very next statement, now stays on the stack instead of being stored to memory and loaded back (so `s.if(x.lte(10n), …)` compiles to a single comparison and a conditional jump, and arithmetic chains keep no intermediate stores). The default output (`optimize: false`) is unchanged, byte for byte.
