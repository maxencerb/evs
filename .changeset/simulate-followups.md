---
"@maxencerb/evs": minor
---

`s.simulate` follow-ups (#36):

- **`gas` on the simulated target.** The optional `gas` cap of `s.simulate` / `s.trySimulate` now bounds the _inner_ target `CALL` (it used to cap the self-call hop). The trampoline wire header grows a gas word — `[trampSel(4)][target(32)][gas(32)][calldata]` — and the hop itself always forwards all gas, so a gas-hungry target surfaces as a failed dry-run (`success = false` / an empty revert) instead of starving the trampoline. `s.call` / `s.read` caps are unchanged; the 63/64 rule is documented.
- **Nested simulate is documented and pinned.** Simulate sites compose (inside `s.fn` bodies, one dry-run feeding the next) — new differential and anvil tests cover it.
- **Sender mode.** `toViem({ mode: 'stateOverride', sender })` installs the script _at_ `sender` and sets `account: sender`, so every sub-call target — including a simulated write — sees `msg.sender = sender`. `toViemStateOverride` takes the same `sender` option.
- **`MockChain` requests carry `gas`.** `staticcall` / `call` receive the site's `gas` cap (when given) as `req.gas` — informational, for mocks that want to emulate an out-of-gas target.

Bytecode of scripts containing `s.simulate` changes (the wider wire header); scripts without it are byte-identical.
