---
'@maxencerb/evs': minor
---

Overloaded functions no longer need a pruned ABI. When a `functionName` has several overloads in the verb's mutability bucket, `s.read`/`s.tryRead`/`s.call`/`s.tryCall`/`s.simulate`/`s.trySimulate` pick the overload whose inputs accept the `args` (arity, then handle types or the literal's JS kind), and type the result from that overload, like viem's `readContract`. Args that fit several overloads fail to compile and throw `EvsTypeError` (`ABI_SHAPE`) at recording instead of the former `UNSUPPORTED_V0`; args that fit none throw `TYPE_MISMATCH`. A canonical signature such as `functionName: 'balanceOf(address)'` names one overload exactly (it is also offered in autocomplete and accepted by `t.fromOutputs`). New exported types: `SubcallFunctionName`, `ResolveOverload`, `ResolvedSubcallParams`, `AbiFunctionSignature`.
