---
'@maxencerb/evs': minor
---

**Rebuild precompiled scripts after upgrading.** Data written by `toPrecompiled()` and debug data written by `debug()` with 0.6.0 still load in 0.7.0, but the data carries its bytecode: a module built with 0.6.0 keeps the behavior of 0.6.0 until it is built again. It still masks out-of-range words and still calls a function without outputs at an address without code, while `explainRevert()` lists the checks of 0.7.0 among the causes of its reverts.

Every precompiled `id` changes, also where the bytecode does not: the id covers everything `explainRevert()` reads, which now includes the keys. The `double` script of the docs goes from `0xb3356908ed9344d8` to `0x46667c5495da2cf7`. Regenerate committed data (a `.gen.ts` or `.json` module) and its debug data in one run: data of 0.6.0 with debug data of 0.7.0 is refused at the first `explainRevert()` (`the debug data given to the precompiled script … was written by another compilation of it … regenerate the two in one run`). The Vite plugin compiles on every build, so a plugin build needs nothing.
