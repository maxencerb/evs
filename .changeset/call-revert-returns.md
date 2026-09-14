---
"@maxencerb/evs": minor
---

Add the `revertReturns` opt-in on `s.call` / `s.tryCall` (#35): declare the output types a target carries in its **revert data** (the QuoterV1 pattern — `quoteExactInput` reverts with the ABI-encoded amount) and the call decodes that payload as its result, with the same `rds ≥ 32·n` guard and dynamic-output bounds as normal outputs. It replaces the ABI outputs as the decode schema; the result handle is typed from the list (`[t.uint256]` → `Expr<'uint256'>`, `[a, b]` → a readonly tuple, a `t.struct` → a `Tuple`). A normal (non-reverting) return is the failure: `s.call` reverts `EvsDecodeError(site)` and `s.tryCall` reports `success = false` with zeroed values. The IR `call` statement gains an optional `revertReturns` field; `irVersion: 1` IR without it round-trips unchanged.
