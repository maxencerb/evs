---
'@maxencerb/evs': patch
---

Internal: the largest source files (the builder recorder, the ABI codec, the interpreter, lowering, calls and the type vocabulary) are split into focused modules. The public API, the emitted types and the compiled bytecode are unchanged.
