---
'@maxencerb/evs': patch
---

`compile()` now reports every oversized script as `EvsCompileError('COMPILE_LIMIT')` with the EIP-170 per-region breakdown. Scripts whose runtime grew past 64 KiB (e.g. several hundred host-unrolled reads) used to throw an `EvsInternalError` asking to report a bug, because the size check ran only after the assembler had tried to patch 16-bit jump targets.
