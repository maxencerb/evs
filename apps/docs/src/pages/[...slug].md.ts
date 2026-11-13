// Serves every docs page as plain Markdown next to its HTML: `/reference/builder/read/` is also
// `/reference/builder/read.md`, and the landing page is `/index.md`. Prerendered, so the files
// ship as static assets. The conversion lives in `src/lib/page-markdown.ts`.
import type { APIRoute, GetStaticPaths, InferGetStaticPropsType } from 'astro';
import { getCollection } from 'astro:content';

import { hasMarkdown, markdownPath, pageToMarkdown } from '../lib/page-markdown.ts';

export const prerender = true;

export const getStaticPaths = (async () => {
  const entries = await getCollection('docs');
  return entries
    .filter((entry) => hasMarkdown(entry.id))
    .map((entry) => ({
      // The route pattern appends `.md`, so the param is the path without it.
      params: { slug: markdownPath(entry.id).slice(1, -'.md'.length) },
      props: { entry },
    }));
}) satisfies GetStaticPaths;

type Props = InferGetStaticPropsType<typeof getStaticPaths>;

export const GET: APIRoute<Props> = ({ props, site }) => {
  const { body, data } = props.entry;
  const markdown = pageToMarkdown(
    { body, title: data.title, description: data.description, hero: data.hero },
    site?.href ?? 'https://evs.maxencerb.com',
  );
  return new Response(markdown, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
