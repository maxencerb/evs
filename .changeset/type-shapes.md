---
"@maxencerb/evs": minor
---

Close the remaining array shapes (#4): fixed-size arrays `T[N]`, two-level tuple arrays `tuple[][]`, and arrays nested deeper than one level, with the stack-based decoder kept for the shapes that already worked (#52).

- **Fixed-size arrays**: `t.array(elem, N)`, the `'uint256[2]'` string form, and `tuple[N]` descriptors, over any element (word, struct, dynamic, array). In memory a `T[N]` is laid out exactly like a `T[]` (its length word is always `N`), so `.length()`, `.at(i)`, `s.forEach`, `set`, cells and fn params work unchanged; only the ABI codec differs (no length word on the wire, inlined into the head when the element is static). Literals must have exactly `N` elements (`TYPE_MISMATCH` at recording). `s.newArray(elem, N, { fixed: true })` allocates one from a literal length. The `arrnew` IR statement gains an optional `fixed` field (additive, `irVersion` stays 1).
- **`tuple[][]` and deeper nesting**: `uint256[][][]`, `string[][]`, `bytes[][]`, `tuple[][]`, `uint256[2][]`, `uint256[][2]`, … work as script args, call args, call outputs (strict and try) and returns, byte-exact vs viem and real solc on paris/shanghai/cancun. Arrays nest up to four levels; a deeper type is still `UNSUPPORTED_V0` in `t.array`, type-string validation, the ABI layer and IR validation.
- **Decoder cost (#52)**: the one- and two-level shapes (`T[]`, `T[][]`, `tuple[]`, `string[]`/`bytes[]`) keep the stack-based decode loop and compile to the same bytes as before. The new shapes decode through heap-allocated loop frames, and a fast-path shape nested too deep for the 16-item stack budget falls back to them automatically.
- Typed zero values cover the new shapes: an unset `s.newArray` slot, an omitted `s.tuple` member and a failed `try*` output of a fixed-size type hold `N` zero elements.
- Word-array literals may mix in staged values (`[x, 1n]` with `x` an `Expr`); they are built element-wise.
- A tuple type written as a string (`'tuple[]'`) and a malformed array suffix (`'uint256[0]'`) are now `TYPE_MISMATCH` with an explanation, instead of `UNSUPPORTED_V0`.
- New exports: the `FixedLengthOf` and `PeelArraySuffix` types. `ArrayType` keeps the exact dynamic literals up to three levels and admits every other suffix chain through one catch-all pattern (so the leaf of a fixed-size string is validated at recording, not by the type checker).
