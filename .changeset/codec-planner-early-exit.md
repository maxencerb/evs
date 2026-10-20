---
'@maxencerb/evs': patch
---

Faster compiles for scripts that never repeat a struct or composite-array codec: the shared-codec planner now skips its full pass over the script when no codec is used twice. The compiled bytecode is unchanged.
