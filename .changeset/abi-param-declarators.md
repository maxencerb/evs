---
'@maxencerb/evs': patch
---

A struct ABI parameter (`{ name: 'p', type: 'tuple', components }`, e.g. `abi[0].inputs[0]`) now works as an `evscript` arg, an `s.fn` param and a `t.error` param. Before, the types accepted it but the runtime read it as `namedArg('p', 'tuple')` and threw `TYPE_MISMATCH`, so a function's `inputs` could be reused only when none of them was a struct. The parameter's own `name` labels the arg (`p`, not `arg{i}`), the same as for a scalar ABI parameter, in the runtime ABI and in the inferred types. The three declaring sites now share one normalizer, which aligns the edge cases. A declarator named `''` gets the positional `arg{i}` name everywhere, as the types already said: `evscript` used to fail with `ABI_SHAPE` on it and `s.fn` with `TYPE_MISMATCH`. An invalid or duplicate script arg name is still `ABI_SHAPE`, but it is now reported before the callback runs.
