---
'@maxencerb/evs': patch
---

`s.select` now suggests `.toUint(…)` / `.toInt(…)` when its two branches are numeric types of different widths, like the arithmetic and comparison ops already did. The rest is internal: the builder's recording helpers are deduplicated and its statements are type-checked against the IR schema. The recorded IR and the compiled bytecode are unchanged.
