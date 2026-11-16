---
'@maxencerb/evs': patch
---

`hydrate` checks what it is given, and says what to pass. An empty `runtimeBytecode` (`0x`) and an `abi` that does not start with the script's function are now rejected on entry (`TYPE_MISMATCH`); both used to be accepted, and the failure showed later, in the call. `hydrate(compiled.toPrecompiled())`, `hydrate(compiled)` and `hydrate(jsonText)` each get a message that names what was passed and what to pass (`script.toJSON()`, `compiled.toPrecompiled().toJSON()`, `JSON.parse(text)`). Malformed debug data now rejects with the documented `EvsTypeError` when it loads: `{ version: 1, ir: {}, sites: [] }` or a `null` site used to reject `explainRevert()` with a raw `TypeError`, and an IR of another version was accepted. `explainRevert()` on a script hydrated without a `debug` loader rejects with `DEBUG_DATA_MISSING` at once, without downloading the explain code first.
