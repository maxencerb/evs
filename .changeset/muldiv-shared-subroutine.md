---
'@maxencerb/evs': patch
---

`mulDiv` / `mulDivRoundingUp` no longer inline the whole FullMath sequence (about 110 bytes) at every site: a script with two or more sites emits it once as a shared subroutine that each site calls, so an extra site costs about 8 bytes and 36 gas per evaluation (about 10 bytes and 61 gas when the script mixes `mulDiv` and `mulDivRoundingUp`). Five `mulDiv` sites shrink from 1,169 to 657 runtime bytes, about 110k less gas in the default deployless mode; a script with a single site compiles exactly as before. Results, Panic codes and `explainRevert` attribution are unchanged.
