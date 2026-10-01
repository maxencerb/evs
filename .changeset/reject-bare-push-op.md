---
"@maxencerb/evs": patch
---

`assemble()` now rejects an `op` node naming `PUSH1`–`PUSH32` with an `EvsInternalError`, including when a `compile({ peephole })` hook returns one. Such a node assembled to the bare opcode with no immediate, so the EVM read the following bytes as push data while the stack verifier still checked the node stream; the mismatched bytecode could ship (for example a `sum` script whose `RETURN` byte became the immediate and that reverted with a false `Panic(0x11)`). Immediates must stay in `push` / `pushBytes` / `pushLabel` nodes; a bare `PUSH0` op node is still accepted. An `op` node with an unknown mnemonic now also throws `EvsInternalError` instead of a raw `TypeError`, and so does a `push` node whose `value` is not a `bigint` (a JS number `0` would otherwise assemble to `PUSH0` even on `paris`).
