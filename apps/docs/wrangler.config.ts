// Bundler-side companion of cloudflare.config.ts (Worker settings live there, not here). `cf`
// delegates the Build Output step of an assets-only project to wrangler (`cf-wrangler build`),
// which reads the static-assets directory from this file: `cloudflare.config.ts` has no
// assets-directory field.
import { defineWranglerConfig } from 'wrangler/experimental-config';

export default defineWranglerConfig({
  assetsDirectory: './dist',
  // No Worker script, so no `env` types to generate (would write .cloudflare/types/).
  types: { generate: false },
});
