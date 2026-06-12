# token-balances — batch reads (api.md E2)

The multicall replacement: one compiled script loops over a **runtime** `address[]`,
`tryCall`s `balanceOf` on each (EOAs default to `0` instead of reverting the batch), and
returns `{ balances: readonly bigint[] }` from a single `eth_call`.

```sh
bun install && bun run build   # once, from the repo root
bun examples/token-balances/index.ts
```
