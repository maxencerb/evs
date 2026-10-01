---
'@maxencerb/evs': patch
---

An unfunded call `value` is now named as the cause when it is one. Source-map sites of `s.call` / `s.simulate` (and their `try*` forms) that send a `value` (anything but a literal 0) carry `sendsValue: true`. When such a site fails, `explainRevert` adds that the script's balance may have been below the `value`, so the `CALL` failed before the target ran: in the empty-payload message of a strict `s.call`, and in the `EvsDecodeError` message of a strict `s.simulate` (whose value-carrying self-call hop is what fails). `compile` also warns `ENV_FRAME_DEPENDENT` for every value-sending site, since the default deployless `toViem()` mode cannot fund the script and the `CALL` always fails there. Fund it with a `balance` in its `toViem({ mode: 'stateOverride' })` entry, or use sender mode.
