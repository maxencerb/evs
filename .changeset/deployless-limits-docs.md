---
'@maxencerb/evs': patch
---

Document the limits of the default deployless execution mode: it runs as a contract creation, so the script's result is capped at 24,576 bytes and must not start with byte `0xEF`, viem's wrapper plus `initBytecode` plus the encoded args (ABI-framed and padded) must fit in 49,152 bytes, and the creation adds about 75,000 gas plus about 220 gas per runtime byte and 200 gas per result byte. State-override mode has none of these limits. The execution guide ties these limits to the `DEPLOYLESS_RESULT_*` compile warnings, `deploylessDataSize()` and `explainDeploylessError()`. The docs also explain that historical reads need an `evmVersion` matching the fork active at the pinned block, that `s.env('blocknumber')` is an approximate L1 block on Arbitrum (the `EnvKind` JSDoc says so too), and that EIP-170 binds only deployless mode. The token-balances example now states its 765-token deployless ceiling.
