---
'@maxencerb/evs': minor
---

pr: 181

Warnings and sites get a stable `key`, and it is what you filter on. A warning used to be identified by `site`, the position of its statement among everything the script recorded, and the messages said to "filter this warning on its code and site". That number moves when a statement is added or removed anywhere above (an unused `s.let` is enough), and it moved for unchanged scripts in 0.4.1, where every `s.for` and `s.forEach` began to record one statement fewer: acknowledged warnings printed again, or a stale number silenced another statement, and the same failing read reverted with `EvsDecodeError(24)` where it had been `(25)`.

A `key` names a statement by what it is: `s.read(symbol)#0` is the first `s.read` of `symbol` in the script body, and `quote/s.tryCall(swap)#0` the first `s.tryCall` of `swap` in the `s.fn` named `quote` (the second one is numbered 1). Only a statement with the same label, added or removed earlier in the same function, moves it. It does not depend on `optimize`, on `evmVersion`, or on what dead-code elimination removes. Moving statements into an `s.fn` changes their keys: they gain the function's name as a prefix. Since a key names a function by its name, a script may no longer define two `s.fn` under one name, also nested in two different functions: the second throws `EvsTypeError` (`TYPE_MISMATCH`). Give each its own name, or call the handle the first `s.fn` returned again.

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

- `EvsDiagnostic` gains `key` and `sites`. `key` is the key of the statement you wrote for `LOOP_ALLOCATION` (see the next item), the thing read from the frame for `ENV_FRAME_DEPENDENT` (`s.env(caller)`, `s.env(address)`, `s.balance(s.env(address))`, or the paying call, `s.call(deposit)`), and the returned value for `DEPLOYLESS_RESULT_PREFIX` (`s.return(bps)`, also when that value is a script argument). `sites` lists the statements the warning covers, each as `{ id, key }`. `site` is still there: the id of the first of them.
- `LOOP_ALLOCATION` is keyed on the allocating statement, or on the statement of the verb that recorded the allocation for itself, so that adding an unrelated literal or encoding does not move it: a `struct: true` call on the call (`s.tryRead(latestRoundData)#0`, not the `tuple(…)` statement that builds the struct), an `s.eq`, `.eq()` or `s.neq` of two structs or arrays on the comparison (`eq#0`, one warning that lists the encodings of both operands), and an `s.keccak256` of anything but a single `bytes` or `string` on its `keccak256` statement. `sites` lists the statements that allocate.
- `ENV_FRAME_DEPENDENT` is now one warning per thing read, not one per statement. A script that read `s.env('address')` three times and `s.env('caller')` twice got five warnings with two texts; it gets two, and each lists its statements in `sites`. **If you counted these warnings, or relied on one per statement, read `sites`.** The warning about a call that sends a `value` now ends "the call reverts" (or "the call reports success = false") where it said "the site".
- Every entry of `compiled.sourceMap.sites` gains `key`, and so do the sites `explainRevert()` returns (`site` and `candidateSites`): log and match `explanation.site.key`, the number in `EvsDecodeError(uint256 site)` stays a position.
- The messages of `LOOP_ALLOCATION` and `DEPLOYLESS_RESULT_PREFIX` now say "filter this warning on its code and key". No warning tells you to filter on a site id any more.
- Precompiled scripts: the debug data holds the keys. Debug data written by 0.6.0 or earlier still loads, and its sites get the same keys, computed from the program it holds. The keys leave the emitted bytecode as it was.

The label part of a key is now public text: a release that moves the key of a warning says so. The docs list the labels under "Keys" on the diagnostics page.
