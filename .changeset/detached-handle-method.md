---
'@maxencerb/evs': patch
---

A handle method called without its handle, passed on as a callback (`xs.map(x.add)`, `s.if(done, loop.break)`) or stored and called bare (`const f = x.add; f(y)`), now throws `EvsTypeError` (`TYPE_MISMATCH`) naming the method and the arrow to write instead: `Expr.add was called without its handle … (v) => x.add(v)`. It used to throw an `EvsInternalError` asking to report a bug in evs (`Expr`, `Cell`, `MutArray`, tuple and field handles), or a bare JS `TypeError` (`LoopCtl.break` / `.continue`). A method invoked on another value (`x.add.call(cell, 1n)`) gets the same error, naming what it was called on.
