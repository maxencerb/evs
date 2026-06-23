/**
 * Doc-sync test (testing.md §6, amendments 10.4) — the architecture.md §11/§15 worked
 * listings are REAL compiler output. This test recompiles the documented example scripts
 * through the public API and asserts that every `docsync`-marked listing in
 * `docs/design/architecture.md` equals the current `disassemble().format({ locs: false })`
 * output (or the documented excerpt of it). Drift between the compiler and the doc fails CI.
 *
 * Regenerate the doc blocks after an intentional codegen change:
 *
 *   DOCSYNC_UPDATE=1 bunx vitest run packages/evs/src/docsync.test.ts --project unit
 *
 * (then `bun run fmt` twice — oxfmt markdown formatting is non-idempotent on this file).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { evscript } from './builder/script.js';
import { compile } from './compile.js';
import { t } from './core/types.js';

const DOC_PATH = fileURLToPath(new URL('../../../docs/design/architecture.md', import.meta.url));

// ---------------------------------------------------------------------------
// the documented scripts (architecture §11 / §15) — public API, defaults (cancun)
// ---------------------------------------------------------------------------

const erc20SymbolAbi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

/** §11 — minimal dispatcher script: `echo(uint256)`. */
function echoListing(): string {
  const echo = evscript({ name: 'echo', args: [t.uint256] }, (s, x) => s.return({ x }));
  return compile(echo).disassemble().format({ locs: false });
}

/** §15.1 — checked ADD (uint256): `const c = a.add(b)`. */
function adduListing(): string {
  const addu = evscript({ name: 'addu', args: [t.uint256, t.uint256] }, (s, a, b) =>
    s.return({ c: a.add(b) }),
  );
  return compile(addu).disassemble().format({ locs: false });
}

/** §15.2 — STATICCALL `symbol()` → dynamic string. */
function symListing(): string {
  const sym = evscript({ name: 'sym', args: [t.address] }, (s, token0) => {
    const symbol0 = s.call({
      address: token0,
      abi: erc20SymbolAbi,
      functionName: 'symbol',
    });
    return s.return({ symbol0 });
  });
  return compile(sym).disassemble().format({ locs: false });
}

/** §15.3 — while loop with `s.let` cells: sum 0..n−1 (the documented snippet verbatim). */
function sumListing(): string {
  const sum = evscript({ name: 'sum', args: [t.uint256] }, (s, n) => {
    const total = s.let(t.uint256, 0n);
    const i = s.let(t.uint256, 0n);
    s.while(
      () => i.get().lt(n),
      () => {
        total.set(total.get().add(i.get()));
        i.set(i.get().add(1n));
      },
    );
    return s.return({ total: total.get() });
  });
  return compile(sum).disassemble().format({ locs: false });
}

// ---------------------------------------------------------------------------
// excerpt helper — a documented listing may be a contiguous slice of the full
// disassembly, delimited by unique marker substrings (inclusive on both ends)
// ---------------------------------------------------------------------------

function slice(full: string, start: string, end: string, extraLines = 0): string {
  const lines = full.split('\n');
  const a = lines.findIndex((l) => l.includes(start));
  if (a < 0) throw new Error(`docsync: start marker not found in listing: ${start}`);
  const b = lines.findIndex((l, i) => i >= a && l.includes(end));
  if (b < 0) throw new Error(`docsync: end marker not found in listing: ${end}`);
  return lines.slice(a, b + 1 + extraLines).join('\n');
}

/** Block id (as it appears in `<!-- docsync:begin <id> -->`) → expected listing text. */
function expectedBlocks(): Map<string, string> {
  const echo = echoListing();
  const addu = adduListing();
  const sym = symListing();
  const sum = sumListing();
  return new Map<string, string>([
    ['dispatcher-echo', echo],
    ['panic-tail', slice(echo, '@panic_overflow:', '; Panic(code)')],
    ['checked-add', slice(addu, '; checked add uint256', '→ @panic_overflow', 3)],
    ['call-symbol', slice(sym, '@main:', '; out #0 string', 1)],
    ['call-symbol-dfail', slice(sym, '@dfail_0:', '→ @decode_revert', 1)],
    ['while-loop', slice(sum, '; arg #0 head', '@endwhile_13:', 1)],
  ]);
}

// ---------------------------------------------------------------------------
// doc block extraction / regeneration
// ---------------------------------------------------------------------------

const BLOCK_RE = /<!-- docsync:begin ([\w-]+) -->\s*```\n([\s\S]*?)\n```\s*<!-- docsync:end -->/g;

function extractDocBlocks(doc: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const m of doc.matchAll(BLOCK_RE)) {
    const [, id, listing] = m;
    if (id === undefined || listing === undefined) continue;
    if (blocks.has(id)) throw new Error(`docsync: duplicate block id in architecture.md: ${id}`);
    blocks.set(id, listing);
  }
  return blocks;
}

function regenerateDoc(doc: string, expected: Map<string, string>): string {
  return doc.replace(BLOCK_RE, (match, id: string) => {
    const listing = expected.get(id);
    if (listing === undefined) return match;
    return `<!-- docsync:begin ${id} -->\n\n\`\`\`\n${listing}\n\`\`\`\n\n<!-- docsync:end -->`;
  });
}

// ---------------------------------------------------------------------------
// the test
// ---------------------------------------------------------------------------

describe('doc-sync: architecture.md §11/§15 listings vs real compiler output (testing.md §6)', () => {
  const expected = expectedBlocks();
  let doc = readFileSync(DOC_PATH, 'utf8');

  if (process.env.DOCSYNC_UPDATE === '1') {
    const regenerated = regenerateDoc(doc, expected);
    if (regenerated !== doc) {
      writeFileSync(DOC_PATH, regenerated);
      doc = regenerated;
    }
  }

  const docBlocks = extractDocBlocks(doc);

  test('every expected listing has a marked block in the doc, and no orphans exist', () => {
    expect([...docBlocks.keys()].toSorted()).toEqual([...expected.keys()].toSorted());
  });

  for (const [id, listing] of expected) {
    test(`block "${id}" matches current disassembly`, () => {
      expect(docBlocks.get(id)).toBe(listing);
    });
  }
});
