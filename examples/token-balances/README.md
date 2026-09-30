# token-balances — batch reads (api.md E2)

The multicall replacement: one compiled script loops over a **runtime** `address[]`,
`tryRead`s `balanceOf` on each (EOAs default to `0` instead of reverting the batch), and
returns `{ balances: readonly bigint[] }` from a single `eth_call`.

Script args arrive as **positional callback params** after `s` — the `evscript({ args:
[t.array(t.address), t.address] }, (s, tokens, owner) => …)` shape, no `s.args`; the array
arg exposes `tokens.length()` / `tokens.at(i)`.

```sh
bun install && bun run build                 # once, from the repo root
(cd packages/contracts && bun run codegen)   # once: forge build → the mock-contract artifacts
bun examples/token-balances/index.ts
```

Needs [foundry](https://getfoundry.sh) (`forge` + `anvil`) and the `forge-std` submodule
(`git submodule update --init`).
