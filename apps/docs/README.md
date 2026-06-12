# @maxencerb/evs-docs

Documentation site for [`@maxencerb/evs`](https://github.com/maxencerb/evs), built with
[Astro Starlight](https://starlight.astro.build) (Rapide theme), deployed on **Cloudflare
Workers** (static assets) at <https://evs.maxencerb.com>.

## Local development

````sh
bun install              # from the repo root
bun run build            # build @maxencerb/evs first — the snippet gate resolves its types
cd apps/docs
bun run dev              # localhost:4321
bun run build            # astro build → dist/ (validates all internal links)
bun run typecheck        # astro check
bun run check:snippets   # typechecks every ```ts fence against the real package
````

### The snippet gate

`scripts/check-snippets.ts` extracts every ` ```ts ` fence under `src/content/docs/` and runs
`tsc --noEmit` over them with `@maxencerb/evs` and `viem` resolvable. Every snippet must be a
complete, copy-pasteable module (own imports included). Fences that intentionally don't
compile opt out with ` ```ts nocheck `.

## Deployment — Cloudflare builds and deploys this site, not GitHub Actions

CI for the docs is handled by **Cloudflare Workers Builds** (the Cloudflare GitHub app),
which builds on every push, posts a check on PRs, and deploys `main` to production. The
repo's own `ci.yml` does not build the docs.

One-time setup in the Cloudflare dashboard — **Workers & Pages → Create → Workers →
Import a repository** → select `maxencerb/evs`, then:

| Setting                 | Value                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Root directory          | `/` (repo root — bun workspace install needs the root lockfile)                                             |
| Build command           | `bun install --frozen-lockfile && bun run build && cd apps/docs && bun run check:snippets && bun run build` |
| Deploy command          | `npx wrangler deploy -c apps/docs/wrangler.jsonc`                                                           |
| Non-production branches | `npx wrangler versions upload -c apps/docs/wrangler.jsonc` (preview URL, no production deploy)              |
| Build watch paths       | `apps/docs/**`, `packages/evs/src/**`, `bun.lock` (skip rebuilds for unrelated changes)                     |

The build command runs the full docs quality gate (library build → snippet typecheck →
`astro build`, which also validates every internal link), so a broken snippet or dead link
fails the Cloudflare check on the PR. To make that check merge-blocking, add it to branch
protection for `main`.

`wrangler.jsonc` declares the custom domain (`evs.maxencerb.com`); the first production
deploy creates the DNS record and certificate automatically — the `maxencerb.com` zone must
be on the same Cloudflare account.

### Manual deploy (fallback)

```sh
cd apps/docs
bunx wrangler login   # once
bun run deploy        # astro build && wrangler deploy
```
