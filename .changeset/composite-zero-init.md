---
'@maxencerb/evs': patch
---

Fix unset composite `s.newArray` elements and omitted composite `s.tuple` members reading garbage on the EVM. A string/bytes/`T[]` slot now holds the empty value and a tuple slot holds its own fresh zeroed struct, where before both were pointer `0x00` into scratch memory. The docs' fill-a-`tuple[]`-in-place example now returns the right values. Also fixes two try-mode decode-failure stack annotations, which made `s.tryRead`/`s.tryCall` fail to compile when the output was a dynamic struct or an array of dynamic structs.
