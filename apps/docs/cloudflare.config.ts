// Cloudflare Worker `evs`: the static docs site at https://evs.maxencerb.com, deployed with
// Cloudflare's `cf` CLI by Workers Builds (settings in CONTRIBUTING.md, "Docs site").
//
// Assets-only Worker (no script): `pnpm run build` writes the site to `./dist` (the directory
// is set in `wrangler.config.ts`), then `pnpm run deploy` / `deploy:preview` package it as
// Build Output under `.cloudflare/output/` and upload it with `cf deploy --prebuilt` /
// `cf previews deploy --prebuilt`.
import { defineConfig } from 'cf/config';

// A factory so the custom domain is production-only: `deploy:preview` builds with
// `isPreview: true` (CLOUDFLARE_PREVIEW_BUILD=true), and Worker Previews reject `domains`.
export default defineConfig(({ isPreview }) => ({
  worker: {
    name: 'evs',
    compatibilityDate: '2026-06-12',
    // Unknown paths get dist/404.html with a 404 status.
    assets: { notFoundHandling: '404-page' },
    // Production serves only the custom domain (the DNS record + certificate for it are
    // managed by Cloudflare; the maxencerb.com zone must be on the account).
    domains: isPreview ? [] : ['evs.maxencerb.com'],
    workersDev: false,
    // Explicit on purpose: every deploy syncs this flag, and when it was left unset it followed
    // `workersDev` and each merge to main switched preview URLs back off.
    previewUrls: true,
  },
}));
