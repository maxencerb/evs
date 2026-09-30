# pool-meta — flagship example (api.md E1)

Reads a Uniswap-V3-style pool's `token0`/`token1`/`fee`/`slot0`, then each token's
`symbol` (data flowing between calls **on-chain**), a `tryRead`'d `decimals` with a
default, and the user's balance — all in **one** deployless `eth_call`, fully typed.

Script args arrive as **positional callback params** after `s` — the `evscript({ args:
[t.address, t.address] }, (s, pool, user) => …)` shape, no `s.args`.

A second script, `poolSlot0`, showcases a **struct-returning** getter: a `'tuple'` output
decodes into a `Tuple` handle whose fields are read by name (`slot0.tick.get()`, typed
`int24`), and the whole struct flows out as a typed object.

```sh
bun install && bun run build                 # once, from the repo root
(cd packages/contracts && bun run codegen)   # once: forge build → the mock-contract artifacts
bun examples/pool-meta/index.ts
```

Needs [foundry](https://getfoundry.sh) (`forge` + `anvil`) and the `forge-std` submodule
(`git submodule update --init`).

Spawns a throwaway local anvil, deploys mock contracts, runs the compiled scripts via
`readContract({ ...compiled.toViem() })`, prints the typed results, and tears down.
