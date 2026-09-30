---
'@maxencerb/evs': patch
---

`toViem({ mode: 'stateOverride' })`: the sender overload now accepts `address` alongside `sender` (it may restate the sender; a different value still throws), and a malformed `address` now throws `EvsTypeError` (`TYPE_MISMATCH`) up front, like a malformed `sender`, instead of being passed through to viem.
