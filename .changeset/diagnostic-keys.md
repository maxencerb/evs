---
'@maxencerb/evs': minor
---

Warnings and sites get a stable `key`, and it is what you filter on. A warning used to be identified by `site`, the position of its statement among everything the script recorded, and the messages said to "filter this warning on its code and site". That number moves when a statement is added or removed anywhere above (an unused `s.let` is enough), and it moved for unchanged scripts in 0.4.1, where every `s.for` and `s.forEach` began to record one statement fewer: acknowledged warnings printed again, or a stale number silenced another statement, and the same failing read reverted with `EvsDecodeError(24)` where it had been `(25)`.

A `key` names a statement by what it is: `s.read(symbol)#0` is the first `s.read` of `symbol` in the script body, and `quote/s.tryCall(swap)#1` the second `s.tryCall` of `swap` in the `s.fn` named `quote`. Only a statement with the same label, added or removed earlier in the same function, moves it. It does not depend on `optimize`, on `evmVersion`, or on what dead-code elimination removes.

```ts
// before: stops matching, or matches another statement, after an edit above or an upgrade
onDiagnostic: (w) => {
  if (w.code === 'LOOP_ALLOCATION' && w.site === 118) return;
  console.warn(w.message);
};

// now
onDiagnostic: (w) => {
  if (w.code === 'LOOP_ALLOCATION' && w.key === 's.tryCall(quoteExactInput)#0') return;
  console.warn(w.message);
};
```

What changed, field by field:

- `EvsDiagnostic` gains `key` and `sites`. `key` is the statement's key for `LOOP_ALLOCATION`, the thing read from the frame for `ENV_FRAME_DEPENDENT` (`s.env(caller)`, `s.env(address)`, `s.balance(s.env(address))`, or the paying call, `s.call(deposit)`), and the returned value for `DEPLOYLESS_RESULT_PREFIX` (`s.return(bps)`, also when that value is a script argument). `sites` lists the statements the warning covers, each as `{ id, key }`. `site` is still there: the id of the first of them.
- `ENV_FRAME_DEPENDENT` is now one warning per thing read, not one per statement. A script that read `s.env('address')` three times and `s.env('caller')` twice got five warnings with two texts; it gets two, and each lists its statements in `sites`. **If you counted these warnings, or relied on one per statement, read `sites`.**
- Every entry of `compiled.sourceMap.sites` gains `key`, and so do the sites `explainRevert()` returns (`site` and `candidateSites`): log and match `explanation.site.key`, the number in `EvsDecodeError(uint256 site)` stays a position.
- The messages of `LOOP_ALLOCATION` and `DEPLOYLESS_RESULT_PREFIX` now say "filter this warning on its code and key". No warning tells you to filter on a site id any more.
- Precompiled scripts: the debug data holds the keys. Debug data written by 0.6.0 or earlier still loads, and its sites get the same keys, computed from the program it holds. No emitted bytecode changes.

The label part of a key is now public text: a release that moves the key of a warning says so. The docs list the labels under "Keys" on the diagnostics page.
