# pool-meta — flagship example (api.md E1)

Reads a Uniswap-V3-style pool's `token0`/`token1`/`fee`/`slot0`, then each token's
`symbol` (data flowing between calls **on-chain**), a `tryCall`'d `decimals` with a
default, and the user's balance — all in **one** deployless `eth_call`, fully typed.

```sh
bun install && bun run build   # once, from the repo root
bun examples/pool-meta/index.ts
```

Spawns a throwaway local anvil, deploys mock contracts, runs the compiled script via
`readContract({ ...compiled.toViem() })`, prints the typed result, and tears down.
