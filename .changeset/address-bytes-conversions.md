---
'@maxencerb/evs': minor
---

Address and bytes conversions, ordering and byte access, with Solidity's semantics:

- `lt` / `gt` / `lte` / `gte` (and `s.lt` …) now order `address` and `bytesN` values as unsigned words, so a token pair sorts in-script (`a.lt(b)`).
- `address.asUint160()` and `uint160.asAddress()` convert for free (widen on with `toUint`).
- `bytesN.asUint()` / `uintN.asBytesN()` convert between same-width fixed bytes and integers (`bytes4` ↔ `uint32`).
- `string.asBytes()` / `bytes.asString()` reinterpret for free; `bytesN.asString()` builds a string from the word with its trailing zero bytes trimmed (the legacy `bytes32` `symbol()`).
- `string` / `bytes` gain `byteAt(i)` (a `bytes1`) and `slice(start, end?)` (a fresh copy), both bounds-checked with `Panic(0x32)`.

New exported types: `OrderedType`, `UintOfBytesN`, `BytesNOfUint`.
