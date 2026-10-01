---
'@maxencerb/evs': patch
---

Bound the work of decoding nested arrays whose element offsets overlap. A callee could point every offset of a `uint256[][]`, `uint8[][]` or struct array at the same inner array, so a few dozen KB of returndata made the decoder build hundreds of copies: hundreds of millions of gas, enough to run the whole `eth_call` out of gas even from `s.tryRead`. Inner `uint256[]`/`int256[]`/`bytes32[]` arrays now point straight into the returndata instead of being copied, so such payloads decode cheaply (`uint256[][]` decodes are also smaller and cheaper). Every other array the decoder has to build is charged to a per-call budget of the returndata size plus 8192 words, the same allowance as viem's `recursiveReadLimit`; well-formed data never comes close, and returndata that exhausts it fails like any other malformed returndata (`success = false` under `try*` verbs, `EvsDecodeError(site)` under strict verbs). `interpret` applies the same budget.
