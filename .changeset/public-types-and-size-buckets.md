---
'@maxencerb/evs': minor
---

Export the types that public signatures name, so consumers can write the return and parameter types of the public API by name. The newly exported types are `CompiledOf` (the return type of `compile()`), `HandlerResult` (the return type of `matchScriptError`), `EnvKind`, `EnvTypeOf`, `EvsFn`, `FnResult`, `FnReturn`, `MutArrayElem`, `MutArrayValueOf`, `RebuildExprs`, `RebuildFnResult`, `ThrowArgRecord`, `ThrowArgTuple`, `TupleArrayElem`, `UnwrapSingle`, `ErrorsToAbi`, `ReturnSpecToComponents`, `TypeOfReturn`, `TupleArrayTag`, `LabelCarrier`, `ArgsToInputs`, `ArgName`, `ResolveArgName`, `ToArgSpec`, `SignatureName`, `AbiParameterSignature`, `AbiParametersSignature`, `SiteId`, `Mnemonic` and `DisasmLine`. The node types inside `ScriptIr` (statements, value and function ids) are not exported: the IR is public as a JSON-serializable snapshot, but its schema is not a stable API.

When a script exceeds the EIP-170 code-size limit, the `COMPILE_LIMIT` error's byte breakdown now has its own `trampoline N,` bucket for scripts that use `s.simulate`. The simulate trampoline is no longer counted under `fns`/`body`, so those two numbers drop by the trampoline's size. Emitted bytecode does not change.
