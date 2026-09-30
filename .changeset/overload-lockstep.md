---
'@maxencerb/evs': patch
---

Overload resolution now reaches the same overload at the type level and at recording for every array shape. Before, a `MutArray` argument could be typed from one overload while the recorder recorded another (a silently wrong result type). Fixed-size `T[N]` parameters were matched as scalars by the types. `tuple[N]` / `tuple[][]` parameters, `MutArray` arguments to scalar-array parameters and array literals holding `Expr`s fell back to an untyped result, and `MutArray` arguments to `tuple[]` overloads that differ by component type were a false ambiguity. A handle now fits only a parameter of exactly its type, on both sides. That covers `Expr`s, `MutArray`s (dynamic or fixed) and struct `Tuple`s (the types compare member names and types). An array literal fits when its elements fit, at any depth, and a fixed-size `T[N]` takes exactly N elements, which the recorder now checks too. Arguments that fit none of several same-arity overloads are now a compile error (`'evs: no overload matches'`), matching the recorder's `TYPE_MISMATCH`.

Host literals of multi-level array types whose outer size is fixed (`'uint256[2][3]'`, `'uint256[][2]'`, `'bool[2][2]'`) are now element-checked by the type checker instead of being typed `readonly unknown[]`.
