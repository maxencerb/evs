---
'@maxencerb/evs': minor
---

Export every type that a public signature names, so consumers can write the return and parameter types of the public API by name. The newly exported types include `CompiledOf` (the return type of `compile()`), `HandlerResult` (the return type of `matchScriptError`), `EnvKind`, `EnvTypeOf`, `EvsFn`, `FnResult`, `FnReturn`, `MutArrayElem`, `MutArrayValueOf`, `RebuildExprs`, `RebuildFnResult`, `ThrowArgRecord`, `ThrowArgTuple`, `TupleArrayElem`, `UnwrapSingle`, `ErrorsToAbi` and `ReturnSpecToComponents`.

When a script exceeds the EIP-170 code-size limit, the `COMPILE_LIMIT` error's byte breakdown now has its own `trampoline N,` bucket for scripts that use `s.simulate`. The simulate trampoline is no longer counted under `fns`/`body`, so those two numbers drop by the trampoline's size. Emitted bytecode does not change.
