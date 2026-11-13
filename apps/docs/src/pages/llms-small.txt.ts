// `/llms-small.txt`: the narrative pages only, without the per-function reference (see
// `src/lib/llms.ts`).
import type { APIRoute } from 'astro';

import { llmsDocument, originOf } from '../lib/llms.ts';

export const prerender = true;

export const GET: APIRoute = ({ site }) =>
  llmsDocument(
    originOf(site),
    'The evs introduction, guides, examples and concepts. The per-function reference is left out: it is in /llms-full.txt.',
    (slug) => !slug.startsWith('reference/'),
  );
