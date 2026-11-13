// @ts-check
// The page index of /llms.txt: one section per sidebar group, one line per page with the URL of
// its Markdown version and its description, so an agent can fetch the few pages it needs instead
// of the full dump. Built from `sidebar.mjs` and each page's frontmatter when the config loads.
import { existsSync, readFileSync } from 'node:fs';

import { sidebar } from './sidebar.mjs';

const SITE = 'https://evs.maxencerb.com';
const content = new URL('./src/content/docs/', import.meta.url);

/** A single-line YAML scalar, with its quotes removed. */
function scalar(/** @type {string} */ raw) {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

/** The title and description of the page behind a sidebar slug. */
function frontmatter(/** @type {string} */ slug) {
  for (const candidate of [`${slug}.mdx`, `${slug}/index.mdx`]) {
    const file = new URL(candidate, content);
    if (!existsSync(file)) continue;
    const block = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
    const field = (/** @type {string} */ name) => {
      const raw = new RegExp(`^${name}:(.*)$`, 'm').exec(block)?.[1];
      if (raw === undefined || /^\s*[>|]/.test(raw)) {
        throw new Error(`llms index: "${candidate}" needs a single-line ${name}`);
      }
      return scalar(raw);
    };
    return { title: field('title'), description: field('description') };
  }
  throw new Error(`llms index: no page for the sidebar slug "${slug}"`);
}

/**
 * Every page under a sidebar entry, in sidebar order (sub-groups are flattened).
 *
 * @param {unknown} item
 * @returns {string[]}
 */
function slugsOf(item) {
  if (typeof item !== 'object' || item === null) return [];
  if ('slug' in item && typeof item.slug === 'string') return [item.slug];
  if ('items' in item && Array.isArray(item.items)) return item.items.flatMap(slugsOf);
  return [];
}

/** Markdown for the `details` slot of starlight-llms-txt: `## Group` headings over link lists. */
export function llmsPageIndex() {
  const sections = [];
  for (const group of sidebar) {
    if (typeof group !== 'object' || !('label' in group)) continue;
    const lines = slugsOf(group).map((slug) => {
      const { title, description } = frontmatter(slug);
      return `- [${title}](${SITE}/${slug}.md): ${description}`;
    });
    sections.push(`## ${group.label}\n\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}
