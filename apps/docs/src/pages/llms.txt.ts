// `/llms.txt`: the index of every page's Markdown rendition (see `src/lib/llms.ts`).
import type { APIRoute } from 'astro';

import { llmsIndex, originOf } from '../lib/llms.ts';

export const prerender = true;

export const GET: APIRoute = ({ site }) => llmsIndex(originOf(site));
