---
'@maxencerb/evs': minor
---

pr: 182

The call verbs accept an ABI entry that has no `stateMutability`, the shape solc wrote before 0.4.16 and block explorers still serve for older contracts. Every verb used to refuse such an entry, each one pointing at another (`function "totalSupply" is unspecified. s.read() … use s.call`, and the reverse from `s.call`). The entry is now read by its `constant` and `payable` flags, as abitype reads them: `constant: true` is `view` (`s.read`, `s.tryRead`), `payable: true` is `payable`, anything else is `nonpayable` (`s.call`, `s.simulate` and their `try` forms). A `stateMutability` that is present wins over the flags, and one that is none of `pure`, `view`, `nonpayable`, `payable` is now reported as such (`ABI_SHAPE`) instead of a steer to another verb. In TypeScript, an ABI with such an entry is not a viem `Abi`: it is accepted, with any `functionName`, unchecked `args` and an untyped result to cast, like an ABI imported from JSON; add `stateMutability` to an entry to get its types.
