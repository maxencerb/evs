---
'@maxencerb/evs': minor
---

pr: 180

An `async` or generator callback is refused instead of being recorded in part. Every callback the builder runs is called once, synchronously, while the script is recorded: an `async` `s.if` branch was recorded up to its first `await` and the rest was dropped without a word (`s.if(flag, async () => { c.set(1n); await x; c.set(2n) })` gave a script that returns 1), an `async` loop body that awaits first recorded an empty loop, and a `function*` recorded nothing. The dropped statements then failed later as an unhandled `RECORDING_CLOSED` rejection that never mentioned `async`. The `evscript` body, both `s.if` branches, the `s.while` condition and body, the `s.for` / `s.forEach` body and the `s.fn` body now throw `EvsTypeError` (`TYPE_MISMATCH`) naming the callback, and no unhandled rejection follows. Await what the script needs before `evscript()` and use the values in a plain callback.

The types refuse them too: an `async` function or a generator given to `s.if`, `s.while`, `s.for` or `s.forEach` is a type error, as it already was for the `evscript` and `s.fn` bodies. The error names the problem: `'evs: the callback returns a Promise (an async function). The builder runs it once, synchronously, so nothing after its first await is recorded: await your data before evscript() and use a plain function'`. A callback that returns nothing, `undefined`, an `Expr` or a handle is accepted as before.
