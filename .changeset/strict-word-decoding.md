---
'@maxencerb/evs': minor
---

A word that is out of range for its ABI type is now refused, as Solidity's ABI decoder refuses it. It used to be masked into range, and the script went on with a value nobody returned: a `uint8` output holding 300 read as 44, a `bool` holding 2 as `true`, an `int8` holding `0x80` as -128, and an `address` or a `bytesN` lost its extra bits. solc 0.8.30 reverts on every one of these words.

- In the return data of `s.read`, `s.call` and `s.simulate`, the script reverts with `EvsDecodeError(site)`, like any return data that does not decode.
- In the return data of `s.tryRead`, `s.tryCall` and `s.trySimulate`, `success` is `false` and every output is its zero value. It used to be `true`, with the masked value.
- In the script's own arguments, the script reverts with `EvsInvalidCalldata()`. viem encodes `args` in range, so only hand-written calldata is concerned.

Every decoded word is checked: a top-level value, a struct member, an array element, at any depth, and the revert data decoded with `revertReturns`. `interpret()` gives the same outcomes, and `explainRevert()` lists an out-of-range word among the causes of an `EvsDecodeError`. Words a script computes are unchanged: `wrappingToUint`, `wrappingToInt` and the wrapping operations still wrap.

If you relied on the masking to read a contract that returns a wider word than it declares, declare that output as `uint256` in the ABI you pass to the call and narrow it in the script, for example with `wrappingToUint(t.uint8)`.

The check costs 16 gas more than the mask per narrow word. Bytecode gets smaller where a script decodes an `address` (a 4-byte test replaces a 21-byte mask) and a few bytes larger per `uintN`, `intN`, `bool` or `bytesN` word.
