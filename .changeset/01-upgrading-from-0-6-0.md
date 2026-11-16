---
'@maxencerb/evs': minor
---

**Upgrading from 0.6.0.** The entries below come in the order they are most likely to affect an app, and each one says what to write instead. These four can change what a running script returns:

- **Out-of-range words are refused**, as Solidity refuses them. A fork read through the ABI of the contract it copies (a PancakeSwap V3 pool through Uniswap V3's) can now fail where viem reads it.
- **A call through a function without outputs fails at an address without code.**
- **Precompiled modules keep the bytecode they were built with**: rebuild them, and every precompiled `id` changes.
- **Input that was recorded as something else is refused**: a struct literal short of a member, a sparse array, an `async` callback, an extra `s.throw` value, an unknown `s.for` key. A struct value with getters on its prototype is read instead of zeroed.

Then warnings: each has a `key` to filter on, and `ENV_FRAME_DEPENDENT` is one warning per thing read. The entries after that can stop 0.6.0 code from type-checking while it records the same script: a struct out of `Cell.get()`, `s.select()` or `s.lit()` is a `Tuple`, the operators take one operand type, a wrapper of the call verbs is typed with `ResolvedSubcallParams`, and three literal positions are typed exactly.
