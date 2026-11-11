---
'@maxencerb/evs': patch
---

Hand-written or deserialized IR with a `bytes` / `string` literal that is not padded to a word boundary now compiles when the literal is passed as a call argument (it used to throw an internal error), and a literal whose padding after its declared length is not zero is now rejected by `validateIr` instead of reaching the callee's calldata (where it made `compile()` and `interpret()` disagree). Scripts built with the builder are unaffected.
