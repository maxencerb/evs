---
'@maxencerb/evs': patch
---

Faster `compile(script, { optimize: true })` on large scripts: the liveness-based frame allocator now walks only the `if`/`while` blocks that enclose each value instead of checking every block, and keeps its occupied and free slots in heaps instead of rescanning and re-sorting them for every value. Frame layouts and bytecode are unchanged. A script with 2,000 values live at once or 2,000 `s.if` blocks lays out its frame about 5× faster.
