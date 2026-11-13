---
'@maxencerb/evs': minor
---

Add precompiled scripts and the compiler-free `@maxencerb/evs/runtime` entry, so an app can compile its scripts at build time and ship only their bytecode. `compiled.toPrecompiled()` narrows a compiled script to its ABI, its runtime bytecode and `toViem()`; `JSON.stringify` turns that into plain data, and `hydrate(data)` from `@maxencerb/evs/runtime` rebuilds it in the client without loading the compiler. A precompiled script's `explainRevert()` is asynchronous and loads its debug data on the first call. The runtime entry also exports `decodeScriptError`, `matchScriptError` and the deployless helpers. The `toViem()` overloads are now the exported `ToViem<abi>` type.
