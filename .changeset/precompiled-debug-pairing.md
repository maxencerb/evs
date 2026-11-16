---
'@maxencerb/evs': patch
---

A precompiled script no longer explains a revert with the debug data of another script or of another build. `hydrate(data, { debug })` used to accept any debug data: with a loader that pointed at the wrong file, or a debug file left from an earlier build, `explainRevert()` named the statements of the wrong program, with no warning. `toPrecompiled()` now writes one `id` into the script's data (`toJSON()`) and into its debug data (`debug()`), and a hydrated script compares the two when the debug data loads: `explainRevert()` and `debug()` reject with an `EvsTypeError` (`TYPE_MISMATCH`) that names both scripts, or both builds. Data and debug data written by 0.5.0 have no `id` and still hydrate; they are matched on the script's name, which tells another script apart but not another build, so regenerate both files to get the full check. The format `version` stays `1`.
