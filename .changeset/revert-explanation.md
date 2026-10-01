---
'@maxencerb/evs': patch
---

`explainRevert` attributes reverts precisely. Panic candidates are now only the sites that can
actually raise the code: `mod`, free conversions (widenings, `asUint256`/`asBytes32`) and checks
that a literal operand removes (a nonzero literal divisor, `pow` by 0 or 1, …) are no longer listed,
so a panic bubbled from a callee is reported as such instead of being blamed on the script.
Source-map sites carry a structured `panicCodes` field, and every site `detail` names its operands
(`array index args.prices[0] — Panic 0x32`; a debug name several values share, such as two
`s.newArray(uint256)`, gets its `#id`), so same-kind candidates are distinguishable. Empty,
`Error(string)` and foreign-selector payloads now list the strict call sites they can have been
bubbled through as `candidateSites` (and say when the script has none), and the off-script hedge on
evs-selector and declared-error attributions now appears only when the script has such a strict call
site (`try*` and `revertReturns` sites never bubble). An `EvsDecodeError` payload longer than the 36
bytes evs emits is now kind `'evs-decode'` (no `site`) instead of `'custom'`, and a declared error
whose args do not decode lists its candidate call sites. The empty-payload message names the
fork-gated opcodes (`PUSH0`, `MCOPY`) the runtime uses, with the older-`evmVersion` fix for
historical blocks. `explainRevert` and `decodeScriptError` now share one revert classifier, so they
always agree on what a payload is, and `decodeScriptError` caches its error-selector table per
(frozen) script ABI.
