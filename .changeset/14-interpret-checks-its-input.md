---
'@maxencerb/evs': minor
---

pr: 180

`interpret` checks its chain and its script before running. A chain without a `staticcall` function failed at the first sub-call with a raw `TypeError: this.chain.staticcall is not a function`, and only on a run that reached one: it is now a `TYPE_MISMATCH` thrown up front for a script that makes a call, even when that call sits in a branch the run does not take. A script that makes no call still runs without a chain. A precompiled or hydrated script, which holds no IR, threw `TypeError: Cannot read properties of undefined (reading 'length')` and now gets a `TYPE_MISMATCH` that says to pass the `evscript()` result or its compiled artifact.
