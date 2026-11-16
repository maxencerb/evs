---
'@maxencerb/evs': patch
---

`s.read`, `s.tryRead`, `s.call`, `s.tryCall`, `s.simulate` and `s.trySimulate` now require `args` in their types when the function takes arguments, as viem's `readContract` does. `s.read({ address, abi: erc20Abi, functionName: 'balanceOf' })` used to type-check and then throw while recording (`function "balanceOf" expects 1 argument(s), got 0`); it is now a compile error, `Property 'args' is missing`. `args` stays optional when the function takes none (`args: []` is accepted too), for an overloaded name that has an overload without arguments (the one such a call resolves to), and for an ABI that has no literal type.
