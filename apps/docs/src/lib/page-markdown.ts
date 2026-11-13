// Plain-Markdown rendition of a docs page, built from the entry's raw MDX body (not from the
// rendered HTML), so code fences, tables and link targets stay exactly as written. Served by
// `src/pages/[...slug].md.ts` and linked from every page (`<link rel="alternate">`, the "Copy
// page" and "View as Markdown" actions).
//
// MDX is reduced with a line-oriented pass rather than a full parser: code (fences and inline
// spans) is masked first so nothing inside it is ever rewritten, then ESM lines, JSX and asides
// are resolved on what is left. Any component this file has no rule for is stripped down to its
// text, so a page using a new component still exports.
import { captions } from '../components/diagrams/captions.ts';

/** Path of a page's Markdown rendition: `reference/builder/read` → `/reference/builder/read.md`. */
export function markdownPath(entryId: string): string {
  return `/${entryId === '' ? 'index' : entryId}.md`;
}

/** Whether an entry has a Markdown rendition (the 404 page does not). */
export function hasMarkdown(entryId: string): boolean {
  return entryId !== '404' && !entryId.endsWith('/404');
}

interface HeroAction {
  text: string;
  link: string;
}

export interface PageSource {
  body: string | undefined;
  title: string;
  description?: string | undefined;
  hero?: { tagline?: string | undefined; actions?: HeroAction[] | undefined } | undefined;
}

// Placeholders for masked code. NUL cannot appear in MDX source, so they never collide.
const MASK = '\u0000';
const FENCE_TOKEN = new RegExp(`${MASK}F(\\d+)${MASK}`);
const CODE_TOKEN = new RegExp(`${MASK}C(\\d+)${MASK}`, 'g');

const ASIDE_LABEL: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  caution: 'Caution',
  danger: 'Danger',
};

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === '';
const captionOf = (name: string): string | undefined =>
  Object.hasOwn(captions, name) ? captions[name as keyof typeof captions] : undefined;

/** A masked fenced block: its lines, de-indented to the opening fence. */
type Fence = string[];

/** Keeps the language and an explicit title; drops presentation-only meta (`{5}`, `collapse=`). */
function cleanFenceInfo(info: string): string {
  const lang = /^[^\s{]+/.exec(info.trim())?.[0] ?? '';
  const title = /\btitle=("[^"]*"|'[^']*')/.exec(info)?.[0];
  return [lang, title].filter(Boolean).join(' ');
}

/** Replaces every fenced block with a one-line token (at the fence's indent). */
function maskFences(lines: string[], fences: Fence[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? '');
    if (!open) {
      out.push(lines[i] ?? '');
      continue;
    }
    const [, indent = '', marker = '', info = ''] = open;
    const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
    const block = [`${marker}${cleanFenceInfo(info)}`];
    i++;
    while (i < lines.length && !close.test(lines[i] ?? '')) {
      const line = lines[i] ?? '';
      block.push(line.slice(Math.min(indent.length, indentOf(line))));
      i++;
    }
    block.push(marker);
    out.push(`${indent}${MASK}F${fences.length}${MASK}`);
    fences.push(block);
  }
  return out;
}

/** Masks inline code spans; a span never crosses a blank line. */
function maskInlineCode(text: string, spans: string[]): string {
  return text.replace(/(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1(?!`)/g, (span) => {
    spans.push(span);
    return `${MASK}C${spans.length - 1}${MASK}`;
  });
}

/** MDX ESM: an `import` / `export` at column 0 runs until the next blank line. */
function dropEsm(lines: string[]): string[] {
  const out: string[] = [];
  let inEsm = false;
  for (const line of lines) {
    if (inEsm) {
      if (!isBlank(line)) continue;
      inEsm = false;
    } else if (/^(import|export)\s/.test(line)) {
      inEsm = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
  /** Index just past the tag's `>`. */
  end: number;
}

/** Reads the component tag starting at `text[start] === '<'`; quotes and `{…}` may hold `>`. */
function readTag(text: string, start: number): Tag | undefined {
  const head = /^<(\/?)([A-Z][\w.]*)/.exec(text.slice(start, start + 80));
  if (!head) return undefined;
  const name = head[2] ?? '';
  const attrs: Record<string, string> = {};
  let i = start + head[0].length;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '>')
      return { name, attrs, closing: head[1] === '/', selfClosing: false, end: i + 1 };
    if (ch === '/' && text[i + 1] === '>') {
      return { name, attrs, closing: false, selfClosing: true, end: i + 2 };
    }
    // A string-valued or bare attribute. `name={expr}` falls through to the brace skip below.
    const attr = /^([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'))?/.exec(text.slice(i));
    if (attr && text[i + attr[0].length] !== '=') {
      attrs[attr[1] ?? ''] = attr[2] ?? attr[3] ?? '';
      i += attr[0].length;
      continue;
    }
    if (ch === '{') {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
    }
    i++;
  }
  return undefined;
}

/** Joins a component tag written over several lines into one line. */
function joinMultilineTags(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lt = line.search(/<\/?[A-Z]/);
    let joined = line;
    if (lt !== -1 && lt === indentOf(line) && !readTag(line, lt)) {
      // Bounded lookahead: an unterminated `<` must not swallow the rest of the page.
      for (let extra = 1; extra <= 40 && i + extra < lines.length; extra++) {
        joined = `${joined} ${(lines[i + extra] ?? '').trim()}`;
        if (readTag(joined, lt)) {
          i += extra;
          break;
        }
        if (extra === 40 || i + extra === lines.length - 1) joined = line;
      }
    }
    out.push(joined);
  }
  return out;
}

type Node = string | Container;

interface Container {
  kind: 'jsx' | 'aside';
  name: string;
  attrs: Record<string, string>;
  indent: number;
  children: Node[];
}

const ASIDE_OPEN = /^\s*:::(note|tip|caution|danger)(?:\[(.*)\])?\s*$/;
const ASIDE_CLOSE = /^\s*:::\s*$/;

/** The tag on a line that holds nothing else, if any. */
function soleTag(line: string): Tag | undefined {
  const trimmed = line.trim();
  if (!/^<\/?[A-Z]/.test(trimmed)) return undefined;
  const tag = readTag(trimmed, 0);
  return tag && tag.end === trimmed.length ? tag : undefined;
}

/** Groups lines into block containers: component tags alone on a line, and `:::` asides. */
function parseBlocks(lines: string[]): Node[] {
  const root: Container = { kind: 'jsx', name: '', attrs: {}, indent: 0, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1] ?? root;
  const open = (node: Container, hasChildren: boolean) => {
    top().children.push(node);
    if (hasChildren) stack.push(node);
  };
  for (const line of lines) {
    const indent = indentOf(line);
    const aside = ASIDE_OPEN.exec(line);
    if (aside) {
      const attrs = { title: aside[2] ?? '' };
      open({ kind: 'aside', name: aside[1] ?? 'note', attrs, indent, children: [] }, true);
      continue;
    }
    if (ASIDE_CLOSE.test(line) && top().kind === 'aside') {
      stack.pop();
      continue;
    }
    const tag = soleTag(line);
    if (!tag) {
      top().children.push(line);
    } else if (tag.closing) {
      // A stray closing tag is dropped: it only pops when it matches an open container.
      const at = stack.findLastIndex((c) => c.kind === 'jsx' && c.name === tag.name);
      if (at > 0) stack.length = at;
    } else {
      open(
        { kind: 'jsx', name: tag.name, attrs: tag.attrs, indent, children: [] },
        !tag.selfClosing,
      );
    }
  }
  return root.children;
}

/** Moves a block so its least-indented line sits at `indent`, keeping relative indentation. */
function reindent(lines: string[], indent: number): string[] {
  const current = Math.min(...lines.filter((l) => !isBlank(l)).map(indentOf));
  if (!Number.isFinite(current)) return lines;
  const pad = ' '.repeat(indent);
  return lines.map((line) => (isBlank(line) ? '' : pad + line.slice(current)));
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? '')) start++;
  while (end > start && isBlank(lines[end - 1] ?? '')) end--;
  return lines.slice(start, end);
}

function renderNodes(nodes: Node[], fences: Fence[]): string[] {
  return nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : renderContainer(node, fences),
  );
}

function renderContainer(node: Container, fences: Fence[]): string[] {
  const pad = ' '.repeat(node.indent);
  // Children are pulled back to the container's own indent: MDX authors indent a component's
  // content for readability, and four spaces of it would turn prose into a code block.
  const body = reindent(renderNodes(node.children, fences), node.indent);

  if (node.kind === 'aside') {
    const label = ASIDE_LABEL[node.name] ?? 'Note';
    const title = node.attrs.title ? `${label}: ${node.attrs.title}` : label;
    const quoted = trimBlankEdges(body).map((line) => {
      const text = line.slice(Math.min(node.indent, indentOf(line)));
      return text === '' ? `${pad}>` : `${pad}> ${text}`;
    });
    return ['', `${pad}> **${title}**`, `${pad}>`, ...quoted, ''];
  }

  const { name, attrs } = node;
  const caption = captionOf(name);
  if (caption) return ['', pad + caption, ''];

  switch (name) {
    case 'TabItem': {
      // A fence that carries its own title already names the tab.
      const titled = body.some((line) => {
        const token = FENCE_TOKEN.exec(line);
        return token !== null && /\btitle=/.test(fences[Number(token[1])]?.[0] ?? '');
      });
      const label = attrs.label && !titled ? [`${pad}**${attrs.label}**`, ''] : [];
      return ['', ...label, ...body, ''];
    }
    case 'Card':
      return attrs.title ? ['', `${pad}**${attrs.title}**`, '', ...body, ''] : body;
    case 'LinkCard': {
      const link = `[${attrs.title ?? attrs.href ?? ''}](${attrs.href ?? ''})`;
      return [`${pad}- ${link}${attrs.description ? `: ${attrs.description}` : ''}`];
    }
    case 'LinkButton':
      return [`${pad}[${body.join(' ').trim()}](${attrs.href ?? ''})`];
    case 'Aside': {
      const type = attrs.type && Object.hasOwn(ASIDE_LABEL, attrs.type) ? attrs.type : 'note';
      return renderContainer({ ...node, kind: 'aside', name: type }, fences);
    }
    case 'Badge':
      return attrs.text ? [pad + attrs.text] : [];
    default:
      // Tabs, Steps, CardGrid and anything unknown: the wrapper goes, its content stays.
      return body;
  }
}

/** Component tags left inside a line of prose: resolved in place, or stripped to their text. */
function resolveInlineTags(text: string): string {
  let out = '';
  let i = 0;
  const hrefs: string[] = [];
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    const tag = /^<\/?[A-Z]/.test(text.slice(lt, lt + 3)) ? readTag(text, lt) : undefined;
    if (!tag) {
      out += text.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    out += text.slice(i, lt);
    i = tag.end;
    if (tag.name === 'Badge') out += tag.attrs.text ?? '';
    else if (tag.name === 'LinkButton' || tag.name === 'LinkCard') {
      if (tag.selfClosing) out += `[${tag.attrs.title ?? ''}](${tag.attrs.href ?? ''})`;
      else if (tag.closing) out += `](${hrefs.pop() ?? ''})`;
      else {
        hrefs.push(tag.attrs.href ?? '');
        out += '[';
      }
    } else out += captionOf(tag.name) ?? '';
  }
  return out + text.slice(i);
}

/** Converts an MDX body to Markdown. Site-internal links become absolute against `site`. */
export function mdxToMarkdown(body: string, site: string): string {
  const origin = site.replace(/\/$/, '');
  const fences: Fence[] = [];
  const spans: string[] = [];

  let lines = maskFences(body.replace(/\r\n?/g, '\n').split('\n'), fences);
  lines = dropEsm(lines);
  let text = maskInlineCode(lines.join('\n'), spans);
  // MDX comments, and the `{' '}` spacer editors insert between inline elements.
  text = text
    .replace(/[ \t]*\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\{\s*(['"])\s*\1\s*\}/g, ' ');

  lines = renderNodes(parseBlocks(joinMultilineTags(text.split('\n'))), fences);
  text = resolveInlineTags(lines.join('\n'));

  // Site-internal links: Markdown targets, reference definitions and leftover HTML attributes.
  text = text
    .replace(/\]\(\/(?!\/)/g, `](${origin}/`)
    .replace(/^(\s*\[[^\]]+\]:\s*)\/(?!\/)/gm, `$1${origin}/`)
    .replace(/\b(href|src)=(["'])\/(?!\/)/g, `$1=$2${origin}/`);

  // Blank runs are collapsed while fences are still masked, so code keeps its own blank lines.
  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(CODE_TOKEN, (_, n: string) => spans[Number(n)] ?? '');

  const out: string[] = [];
  for (const line of text.split('\n')) {
    const token = FENCE_TOKEN.exec(line);
    if (!token) {
      out.push(line);
      continue;
    }
    // Everything before the token (indentation, a blockquote marker) prefixes each fence line.
    const prefix = line.slice(0, token.index);
    for (const fenceLine of fences[Number(token[1])] ?? [])
      out.push((prefix + fenceLine).trimEnd());
  }
  return out.join('\n');
}

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, '');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The whole Markdown document for a page: title, description, then the converted body. */
export function pageToMarkdown(page: PageSource, site: string): string {
  const origin = site.replace(/\/$/, '');
  const absolute = (link: string) => (link.startsWith('/') ? origin + link : link);
  const body = mdxToMarkdown(page.body ?? '', site);
  const parts = [`# ${page.title}`];

  // Most pages open with the first sentence of their description, give or take code spans and
  // links, which a description cannot hold; it is not repeated then.
  const plain = (text: string) =>
    squash(text)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '');
  const firstParagraph = plain(body.split(/\n\s*\n/, 1)[0] ?? '');
  const description = squash(page.description ?? '');
  const opening = plain(description.split(/(?<=\.)\s/, 1)[0] ?? description);
  if (description !== '' && !firstParagraph.startsWith(opening)) parts.push(description);

  if (page.hero?.tagline) parts.push(squash(stripHtml(page.hero.tagline)));
  if (page.hero?.actions?.length) {
    parts.push(page.hero.actions.map((a) => `- [${a.text}](${absolute(a.link)})`).join('\n'));
  }

  if (body) parts.push(body);
  return `${parts.join('\n\n')}\n`;
}
