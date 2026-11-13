// The three plain-text outputs for LLMs, assembled from the same per-page Markdown the `.md`
// endpoint serves (`page-markdown.ts`): `/llms.txt` indexes every page, `/llms-full.txt` holds
// every page, `/llms-small.txt` holds everything but the per-function reference. Pages follow
// the sidebar order. Building them from the raw MDX costs a few milliseconds; rendering every
// page to HTML and converting it back took a third of the site build.
import { getCollection, type CollectionEntry } from 'astro:content';

import { sidebar } from '../../sidebar.mjs';
import { markdownPath, pageToMarkdown } from './page-markdown.ts';

const SUMMARY =
  'Typed EVM read scripts in plain TypeScript: a callback-builder compiled to EVM bytecode that batches dozens of dependent on-chain reads into a single deployless eth_call, with full viem type inference and no deployed contracts.';

const DETAILS =
  'evs (`@maxencerb/evs`) lets you write read-only EVM scripts in TypeScript, compile them to runtime bytecode, and execute them with viem in one eth_call, including reads whose targets depend on earlier reads, which a multicall cannot batch.';

const LINKS = [
  { label: 'GitHub repository', url: 'https://github.com/maxencerb/evs' },
  { label: 'npm package', url: 'https://www.npmjs.com/package/@maxencerb/evs' },
];

type Page = CollectionEntry<'docs'>;

interface Group {
  label: string;
  slugs: string[];
}

/** Every page slug under a sidebar entry, in order (sub-groups are flattened). */
function slugsOf(item: unknown): string[] {
  if (typeof item !== 'object' || item === null) return [];
  if ('slug' in item && typeof item.slug === 'string') return [item.slug];
  if ('items' in item && Array.isArray(item.items)) return item.items.flatMap(slugsOf);
  return [];
}

/** The top-level sidebar groups with the pages each one holds. */
function sidebarGroups(): Group[] {
  const groups: Group[] = [];
  for (const group of sidebar) {
    if (typeof group === 'object' && 'label' in group && typeof group.label === 'string') {
      groups.push({ label: group.label, slugs: slugsOf(group) });
    }
  }
  return groups;
}

async function pagesBySlug(): Promise<Map<string, Page>> {
  return new Map((await getCollection('docs')).map((page) => [page.id, page]));
}

function pageOf(pages: Map<string, Page>, slug: string): Page {
  const page = pages.get(slug);
  if (page === undefined) throw new Error(`llms: no page for the sidebar slug "${slug}"`);
  return page;
}

function markdownOf(page: Page, origin: string): string {
  const { title, description, hero } = page.data;
  return pageToMarkdown({ body: page.body, title, description, hero }, origin);
}

const textResponse = (text: string) =>
  new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** `/llms.txt`: what evs is, then one link per page to its Markdown rendition. */
export async function llmsIndex(origin: string): Promise<Response> {
  const pages = await pagesBySlug();
  const sections = sidebarGroups().map(({ label, slugs }) => {
    const lines = slugs.map((slug) => {
      const { title, description } = pageOf(pages, slug).data;
      return `- [${title}](${origin}${markdownPath(slug)}): ${description ?? ''}`;
    });
    return `## ${label}\n\n${lines.join('\n')}`;
  });
  return textResponse(
    [
      '# evs',
      `> ${SUMMARY}`,
      DETAILS,
      'Every documentation page is also served as plain Markdown: append `.md` to its path without the trailing slash (`/reference/builder/read/` is `/reference/builder/read.md`; the landing page is `/index.md`).',
      ...sections,
      '## Documentation sets',
      [
        `- [Complete documentation](${origin}/llms-full.txt): every page in one file`,
        `- [Guides only](${origin}/llms-small.txt): the introduction, guides, examples and concepts, without the per-function reference`,
      ].join('\n'),
      '## Optional',
      LINKS.map(({ label, url }) => `- [${label}](${url})`).join('\n'),
    ].join('\n\n') + '\n',
  );
}

/**
 * `/llms-full.txt` and `/llms-small.txt`: the pages themselves, one after the other, each
 * opening with its level-1 title. `include` selects pages by slug.
 */
export async function llmsDocument(
  origin: string,
  intro: string,
  include: (slug: string) => boolean = () => true,
): Promise<Response> {
  const pages = await pagesBySlug();
  const slugs = sidebarGroups()
    .flatMap((group) => group.slugs)
    .filter(include);
  const documents = slugs.map((slug) => markdownOf(pageOf(pages, slug), origin));
  return textResponse(
    [`${intro} The page index is at ${origin}/llms.txt.\n`, ...documents].join('\n'),
  );
}

/** The site origin without a trailing slash. */
export function originOf(site: URL | undefined): string {
  return (site?.href ?? 'https://evs.maxencerb.com').replace(/\/$/, '');
}
