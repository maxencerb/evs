---
"@maxencerb/evs": minor
---

Add a liveness-based frame allocator behind `compile(script, { optimize: true })` (#41). With `optimize` on, codegen computes a live range for every value over the linearized statement order and linear-scans the static frame, so a value takes over the slot of one that is dead — long chains of temporaries collapse to a slot or two, and the frame (hence memory-expansion gas for every later allocation) shrinks. Args, cells and fn params keep dedicated slots; fn frames stay separate; a value that crosses a loop boundary stays live for the whole loop, and a value read in one `if` branch stays live through the whole `if`. `optimize` remains the single switch (it also enables the peephole pass), and the default output is byte-identical to before.
