---
'@maxencerb/evs': minor
---

The `viem` peer range is now `>=2.22.12 <3` (it was `>=2.14.1`). On viem 2.14.1 to 2.22.11, `decodeScriptError` returned `{ name: 'empty' }` for every revert, a declared error and a Panic included, and `matchScriptError` called `_` instead of the declared handler: those versions do not keep the revert data on the error `readContract` throws (viem added `ContractFunctionRevertedError.raw` in 2.22.12). Compiling and running a script worked there, only the two decoders were wrong, and silently. On an older viem the package manager now reports the peer conflict, and an error from such a version is rethrown instead of being decoded as an empty revert. The range also stops below viem 3: its root entry no longer exports the functions the library imports, so the library fails at import there. The cap goes away with the release that supports viem 3.
