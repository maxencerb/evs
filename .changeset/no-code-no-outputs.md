---
'@maxencerb/evs': minor
---

A call through a function that declares no outputs now fails when its address has no code, as the same call reverts from Solidity. It used to succeed: a call to an address without code succeeds with empty return data, and with no output there was nothing to decode. So `s.tryRead` of a validation function such as a Safe's `checkSignatures` reported `success: true` on a wrong or not yet deployed address, where the reference pages of `s.read` and `s.tryRead` said it failed.

- `s.read`, `s.call` and `s.simulate` revert with `EvsDecodeError(site)`.
- `s.tryRead`, `s.tryCall` and `s.trySimulate` report `success: false`.

The script checks the address before the call (`EXTCODESIZE`, about 120 gas more per call), so the call is not made and no `value` is sent. A call through a function with outputs is unchanged: it already failed on an address without code, and gets no check.

If you relied on the old behavior: an `s.call` or `s.tryCall` that sends `value` through a function without outputs to an account without code, which worked as a plain transfer, now fails, as it does from Solidity. A precompile has no code either.

`interpret()` follows: a `MockChain` that answers a function without outputs must report `code` at that address from its `account` method, or the call fails before `staticcall` or `call` is asked.

`explainRevert()` names the cause of an `EvsDecodeError`: for a function without outputs, an address without code.
