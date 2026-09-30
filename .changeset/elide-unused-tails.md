---
'@maxencerb/evs': patch
---

Compiled scripts no longer carry unreferenced revert tails: the `Panic` stubs (and the shared `Panic` core), the `EvsDecodeError` tail, the `EvsInvalidCalldata` tail and the pre-cancun `@memcpy` subroutine are emitted only when some code jumps to them. Runtime bytecode shrinks by up to ~80 bytes per script (e.g. a checked `add` goes from 175 to 136 bytes on cancun, 217 to 136 on shanghai); behavior and revert payloads are unchanged.
