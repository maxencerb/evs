# evs

Typed EVM read scripts in plain TypeScript: a callback builder compiled to runtime
bytecode, executed via `eth_call` (deployless or state-override), with full viem inference.

Work in progress. Start with the documentation:

- Binding design docs: [docs/design](docs/design) (module-interfaces, architecture, api, testing, repo-layout)
- Research notes: [docs/research](docs/research)

Monorepo layout: `packages/evs` (the `@maxencerb/evs` library), `packages/contracts` (foundry), `examples/`.
