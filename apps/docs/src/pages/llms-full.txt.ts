// `/llms-full.txt`: every documentation page in one file (see `src/lib/llms.ts`).
import type { APIRoute } from 'astro';

import { llmsDocument, originOf } from '../lib/llms.ts';

export const prerender = true;

export const GET: APIRoute = ({ site }) =>
  llmsDocument(originOf(site), 'The complete documentation of evs, every page in sidebar order.');
