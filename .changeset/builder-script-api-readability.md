---
'@maxencerb/evs': minor
---

The strict and try call-verb types now share one definition per mutability bucket. New exported types: `SubcallVerbOf<mut, tried>` (the verb shape for one mutability bucket and flavour), `CallVerbOf<tried>` (the `s.call` / `s.tryCall` shape, with the `revertReturns` overload) and `Tried<tried, v>` (the one difference between the flavours: a try verb wraps the strict result `v` as `{ success, value }`). `SubcallVerb`, `TrySubcallVerb`, `CallVerb` and `TryCallVerb` are now type aliases of these instead of interfaces (`ReadVerb`, `TryReadVerb`, `WriteVerb` and `TryWriteVerb` were already aliases), so they can no longer be extended by declaration merging. Every verb resolves to the same result types as before.

Fixes the collision error for a script named like one of its declared errors when that name starts with `Evs` (for example a script `EvsFoo` declaring `t.error('EvsFoo')`): the message now says "a declared error" instead of wrongly calling it "an evs runtime error every artifact carries". Bytecode does not change.
