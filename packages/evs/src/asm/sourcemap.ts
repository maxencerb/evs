/**
 * `asm/sourcemap.ts` — the PC map: code segments (with their optional codegen notes), sites and
 * labels.
 *
 * `segments` are sorted by `pc` and non-overlapping; together they cover every emitted code byte
 * (assemble guarantees this). Each is a maximal run of consecutive bytes sharing the same note (or
 * no note): adjacent instructions with one note share a segment, so a segment spans one or more
 * whole instructions (or data blobs) and `lookupPc` is the per-pc view. `sites` are merged in by
 * compile.ts (the assembler emits `sites: []`).
 */

// structural twin of `SiteId` from ir/nodes.js — asm may only import core/* (module DAG)
type SiteId = number;

export interface SourceMap {
  readonly version: 1;
  readonly segments: readonly { pc: number; len: number; note?: string }[];
  readonly sites: readonly {
    id: SiteId;
    kind: 'panic' | 'decode' | 'call' | 'stmt';
    detail: string; // display only — match on `kind` / `panicCodes`, never on this text
    // 'panic' sites only: the Panic(uint256) codes this site can raise (non-empty)
    panicCodes?: readonly number[];
    // 'decode' / 'call' sites of s.call / s.simulate (and their try* forms) only: present when
    // the CALL sends a `value` (not a literal 0), paid from the script's own balance
    sendsValue?: true;
  }[];
  readonly labels: readonly { pc: number; name: string }[];
}

/**
 * Finds the segment covering `pc` (binary search over the sorted, non-overlapping segments).
 * Returns `undefined` when no segment covers the pc.
 */
export function lookupPc(map: SourceMap, pc: number): { note?: string } | undefined {
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
      return seg.note === undefined ? {} : { note: seg.note };
    }
  }
  return undefined;
}

/** Finds the site with id `id`, or `undefined`. */
export function siteById(map: SourceMap, id: SiteId): SourceMap['sites'][number] | undefined {
  return map.sites.find((s) => s.id === id);
}
