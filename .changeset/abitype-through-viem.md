---
'@maxencerb/evs': patch
---

Drop the `abitype` dependency: evs now takes abitype's types (`Address`, `Abi`, `AbiParameter`, …) from `viem`, its required peer, and has no dependencies of its own. The `abitype ^1.3.0` range could not share the exact version viem pins, so every package manager installed a second abitype next to it. An abitype `Register` augmentation in your app (a custom `addressType`, for example) then reached only one copy, and evs's `Address` no longer matched viem's. Now there is a single copy, and the augmentation applies to evs and viem alike. The exported types are unchanged, with one caveat: the parameter names your editor shows for a script body or `s.fn` callback (a `namedArg` name, or `arg0`/`arg1`/…) now come from viem's abitype, which supports named tuples from viem 2.43.0. With an older viem (the peer range still starts at 2.14.1), the parameters keep the same types but show generic names.
