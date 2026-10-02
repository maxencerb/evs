---
'@maxencerb/evs': patch
---

`mulDiv` / `mulDivRoundingUp` no longer inline the whole FullMath sequence at every site: a script with two or more sites emits it once as a shared subroutine that each site calls, so an extra site costs about 10 bytes (and about 55 gas per evaluation) instead of about 111 bytes. Five sites shrink from 1,169 to 685 runtime bytes, about 104k less gas in the default deployless mode; a script with a single site compiles exactly as before. Results, Panic codes and `explainRevert` attribution are unchanged.
