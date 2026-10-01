---
"@maxencerb/evs": patch
---

Scripts now accept empty calldata, so they can receive ETH. A bare call into a script (empty calldata, any value) now succeeds with no output instead of reverting `EvsInvalidCalldata()`. Before, any target that pays ETH to its caller failed under `s.call` / `s.simulate` — `WETH.withdraw` (`msg.sender.transfer`), a swap out to native ETH — and in sender mode (`toViem({ mode: 'stateOverride', sender })`) such a call reverted even though it succeeds from the plain account, because the script replaces the sender's empty code. The receive path costs 15 gas, well inside the 2,300-gas `transfer`/`send` stipend. Calldata of 1–3 bytes still reverts `EvsInvalidCalldata()`.

Every script's runtime bytecode grows by 7 bytes (the check runs before the free-pointer prologue), and a correct call pays 16 more gas.
