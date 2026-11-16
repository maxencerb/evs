---
'@maxencerb/evs': patch
---

An `async` function or a generator given to `s.if`, `s.while`, `s.for` or `s.forEach` is a type error, as it already was for the `evscript` and `s.fn` bodies: it type-checked and then threw `TYPE_MISMATCH` while recording. The error names the problem: `'evs: the callback returns a Promise (an async function). The builder runs it once, synchronously, so nothing after its first await is recorded: await your data before evscript() and use a plain function'`. A callback that returns nothing, `undefined`, an `Expr` or a handle is accepted as before.
