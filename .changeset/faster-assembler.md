---
'@maxencerb/evs': patch
---

Faster assembly and a smaller source map. `sourceMap.segments` are now maximal runs of consecutive instructions sharing one note (or none) instead of one segment per instruction: 3–8× fewer segments and a 2–4× smaller serialized map on large scripts, while `lookupPc`, `disassemble()` and `explainRevert` answer exactly as before for every pc. The assembler lays the bytecode out in a single buffer and hex-encodes it through a lookup table, which cuts `compile()` time by about a third on scripts near the EIP-170 limit. The bytecode is unchanged.
