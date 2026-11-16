---
'@maxencerb/evs': patch
---

Explain the node errors that real providers answer when a call fails for a reason that is not the script's logic.

`explainDeploylessError` missed several node texts. It now reads the size out of `max code size exceeded: size 28160 limit 24576` (the wording a provider uses at a pinned block; `size` was `undefined`), recognizes Nethermind's `transaction size over max init code size` as `data-too-large` and a bare `invalid code` as `result-starts-with-ef`, and has a fourth kind, `result-deposit-out-of-gas`, for geth's `contract creation code storage out of gas`: the script ran, but the gas left could not pay the 200 gas per byte that depositing a deployless result costs. A bare `out of gas` is still not matched, because an out-of-gas in the script reads the same.

A script compiled for a fork the chain does not have at the block it reads (a `cancun` build before Dencun, or on a chain without `MCOPY`) had no explanation in state-override mode: the node answers `invalid opcode: MCOPY` or `NotActivated`, viem shows "Missing or invalid parameters", and both `decodeScriptError` and `explainDeploylessError` return `undefined`. The new `explainUnsupportedOpcode(script, error)`, exported from both entries, recognizes that error and returns the opcode the node rejected and `recompileWith`, the newest `evmVersion` without it.

`explainRevert('0x')` now lists its causes in a numbered order that starts with the opcodes the build needs, names at most three strict call sites in `message` (`candidateSites` still holds them all), and includes a deployless limit among the causes, since zkSync Era and Monad report one as an empty revert.

`DEPLOYLESS_RESULT_PREFIX` no longer warns for a returned `bytesN` literal whose first byte is not `0xEF`, and it is no longer missing for a result built from a signed division that can reach `2^255` (`-2^b / -1` is `+2^b`, one bit more than the analysis allowed).
