---
'@maxencerb/evs': patch
---

Drop the `abitype` dependency: evs now takes abitype's types (`Address`, `Abi`, `AbiParameter`, …) from `viem`, its required peer, and has no dependencies of its own. The `abitype ^1.3.0` range made npm and bun install a second abitype next to the exact version viem pins, so an abitype `Register` augmentation in your app (a custom `addressType`, for example) reached only one copy, and evs's `Address` no longer matched viem's. Now there is a single copy, and the augmentation applies to evs and viem alike. The exported types are unchanged.
