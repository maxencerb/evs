// Starlight route middleware: runs for every docs page before it renders.
import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

import { hasMarkdown, markdownPath } from './lib/page-markdown.ts';

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  if (!hasMarkdown(route.entry.id)) return;
  // Points agents and tools at the page's Markdown rendition (src/pages/[...slug].md.ts).
  route.head.push({
    tag: 'link',
    attrs: {
      rel: 'alternate',
      type: 'text/markdown',
      // Root-relative, so preview deployments point at their own copy.
      href: markdownPath(route.entry.id),
    },
    content: '',
  });
});
