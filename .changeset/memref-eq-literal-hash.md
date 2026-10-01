---
'@maxencerb/evs': patch
---

`eq` / `neq` between a memref and a constant literal (`symbol.eq('WETH')`, `fees.neq([500n, 3000n])`, any `string` / `bytes` literal or array of word literals) now hashes the literal when the script is recorded. The bytecode stores the 32-byte hash and no longer builds and hashes the literal at run time: about 120 gas and 70 bytes less per string comparison, and more for arrays. Results are unchanged. Recording is also faster: each ABI function entry is validated and its selector computed once, and every `s.read` / `s.call` site that names it reuses the result (so do not mutate an ABI entry after a script has used it). Struct layouts are now cached as intended.
