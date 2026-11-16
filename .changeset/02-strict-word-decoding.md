---
'@maxencerb/evs': minor
---

pr: 184

A word that is out of range for its ABI type is now refused, as Solidity's ABI decoder refuses it. It used to be masked into range, and the script went on with a value nobody returned: a `uint8` output holding 300 read as 44, a `bool` holding 2 as `true`, an `int8` holding `0x80` as -128, and an `address` or a `bytesN` lost its extra bits. solc 0.8.30 reverts on every one of these words.

- In the return data of `s.read`, `s.call` and `s.simulate`, the script reverts with `EvsDecodeError(site)`, like any return data that does not decode.
- In the return data of `s.tryRead`, `s.tryCall` and `s.trySimulate`, `success` is `false` and every output is its zero value. It used to be `true`, with the masked value.
- In the script's own arguments, the script reverts with `EvsInvalidCalldata()`. viem encodes `args` in range, so only hand-written calldata is concerned.

Every decoded word is checked: a top-level value, a struct member, an array element, at any depth, and the revert data decoded with `revertReturns`. One out-of-range word fails the whole call, also when the script never reads that output. `interpret()` gives the same outcomes, and `explainRevert()` lists an out-of-range word among the causes of an `EvsDecodeError`. Words a script computes are unchanged: `wrappingToUint`, `wrappingToInt` and the wrapping operations still wrap.

**viem's decoder does not refuse these words**: `readContract` and `decodeFunctionResult` return the whole value, so a script checked against viem on 0.6.0 can fail on 0.7.0 while viem still reads the contract. The common case is a fork that widens a field, read through the ABI of the contract it copies. PancakeSwap V3 declares `slot0`'s `feeProtocol` as a `uint32` (two 16-bit fees, such as `78644400`), where Uniswap V3's ABI declares a `uint8`. Read through the Uniswap V3 ABI, every PancakeSwap V3 pool now reverts in `s.read`, and reports `success: false` with every output zero in `s.tryRead` (`sqrtPriceX96` included), so a router that skips the pools that fail drops them all without an error. The fix is in the ABI you pass to the call: declare the field as wide as the contract returns it (`uint32 feeProtocol` here; `uint256` fits any word), then narrow it in the script if you need to, for example with `wrappingToUint(t.uint8)`.

The check costs 16 gas more than the mask per narrow word for a `uintN`, `bool`, `address` or `bytesN`, 22 for an `intN`, and 4 more in a try form. Bytecode gets smaller where a script decodes an `address` (a 4-byte test replaces a 21-byte mask) and a few bytes larger per `uintN`, `intN`, `bool` or `bytesN` word.
