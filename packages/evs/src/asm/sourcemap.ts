/**
 * M4 `asm/sourcemap.ts` — PC→source map (architecture §14).
 *
 * Contract: docs/design/module-interfaces.md §M4 (frozen). `segments` are sorted by `pc` and
 * non-overlapping; together they cover every emitted code byte (assemble guarantees this).
 * `sites` are merged in by compile.ts (the assembler emits `sites: []`).
 */

import type { SourceLoc } from '../core/errors.js';

// structural twin of `SiteId` from ir/nodes.js — asm may only import core/* (module DAG)
type SiteId = number;

export interface SourceMap {
  readonly version: 1;
  readonly segments: readonly { pc: number; len: number; loc: SourceLoc | null; note?: string }[];
  readonly sites: readonly {
    id: SiteId;
    kind: 'panic' | 'decode' | 'call' | 'stmt';
    loc: SourceLoc | null;
    detail: string;
  }[];
  readonly labels: readonly { pc: number; name: string }[];
}

/**
 * Finds the segment covering `pc` (binary search over the sorted, non-overlapping segments).
 * Returns `undefined` when no segment covers the pc.
 */
export function lookupPc(
  map: SourceMap,
  pc: number,
): { loc: SourceLoc | null; note?: string } | undefined {
  const segments = map.segments;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = segments[mid];
    if (seg === undefined) return undefined; // unreachable; satisfies noUncheckedIndexedAccess
    if (pc < seg.pc) {
      hi = mid - 1;
    } else if (pc >= seg.pc + seg.len) {
      lo = mid + 1;
    } else {
      return seg.note === undefined ? { loc: seg.loc } : { loc: seg.loc, note: seg.note };
    }
  }
  return undefined;
}

/** Finds the site with id `id`, or `undefined`. */
export function siteById(map: SourceMap, id: SiteId): SourceMap['sites'][number] | undefined {
  return map.sites.find((s) => s.id === id);
}
