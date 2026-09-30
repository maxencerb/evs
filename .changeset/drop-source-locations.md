---
'@maxencerb/evs': minor
---

Remove source-location capture. Recording no longer snapshots a stack trace per op, which makes `evscript()` recording about 10x faster (record + compile about 3x faster overall).

Breaking (pre-1.0):
- Removed the `SourceLoc` type export, `EvsError.loc` / `EvsError.relatedLocs`, `EvsDiagnostic.loc`, and the `evscript(def, body, { locations })` options parameter / `CompileOptions.locations`.
- Removed `loc` from `RevertExplanation.site` / `candidateSites`, `SourceMap` segments and sites, `lookupPc()` results, `InterpResult.trace` entries and `DisasmLine`. `Disassembly.format()` takes no options.
- `explainRevert` messages identify sites as `detail (site N)` instead of `detail at file:line:col`.

Build-time errors are thrown synchronously inside your `evscript` callback, so the error's stack trace still points at the offending line. Previously serialized IR that contains `loc` keys still deserializes.

Also fixes a struct field named `toString` / `valueOf` / `toJSON` crashing the recorder.
