import { describe, expect, test } from 'vitest';

import type { SourceLoc } from '../core/errors.js';
import { lookupPc, siteById, type SourceMap } from './sourcemap.js';

const LOC_A: SourceLoc = { file: '/home/dev/app/pools.ts', line: 9, column: 18 };
const LOC_B: SourceLoc = { file: '/home/dev/app/pools.ts', line: 12, column: 3 };

const MAP: SourceMap = {
  version: 1,
  segments: [
    { pc: 0, len: 2, loc: LOC_A, note: 'prologue' },
    { pc: 2, len: 3, loc: null },
    { pc: 5, len: 1, loc: LOC_B },
    // gap: pc 6..9
    { pc: 10, len: 4, loc: null, note: 'data segment guard' },
  ],
  sites: [
    { id: 7, kind: 'decode', loc: LOC_A, detail: 'decoding symbol() returndata' },
    { id: 9, kind: 'panic', loc: LOC_B, detail: 'checked add' },
  ],
  labels: [{ pc: 5, name: 'main' }],
};

describe('lookupPc', () => {
  test('hits inside a segment, including both boundaries', () => {
    expect(lookupPc(MAP, 0)).toEqual({ loc: LOC_A, note: 'prologue' });
    expect(lookupPc(MAP, 1)).toEqual({ loc: LOC_A, note: 'prologue' });
    expect(lookupPc(MAP, 2)).toEqual({ loc: null });
    expect(lookupPc(MAP, 4)).toEqual({ loc: null });
    expect(lookupPc(MAP, 5)).toEqual({ loc: LOC_B });
    expect(lookupPc(MAP, 13)).toEqual({ loc: null, note: 'data segment guard' });
  });

  test('omits the note key entirely when the segment has none', () => {
    const hit = lookupPc(MAP, 2);
    expect(hit).toBeDefined();
    expect(hit !== undefined && 'note' in hit).toBe(false);
  });

  test('misses in gaps, before start, and past the end', () => {
    expect(lookupPc(MAP, 6)).toBeUndefined();
    expect(lookupPc(MAP, 9)).toBeUndefined();
    expect(lookupPc(MAP, 14)).toBeUndefined();
    expect(lookupPc(MAP, -1)).toBeUndefined();
  });

  test('works on an empty map', () => {
    const empty: SourceMap = { version: 1, segments: [], sites: [], labels: [] };
    expect(lookupPc(empty, 0)).toBeUndefined();
  });
});

describe('siteById', () => {
  test('finds a site by id', () => {
    expect(siteById(MAP, 7)?.detail).toBe('decoding symbol() returndata');
    expect(siteById(MAP, 9)?.kind).toBe('panic');
  });

  test('returns undefined for unknown ids', () => {
    expect(siteById(MAP, 1234)).toBeUndefined();
  });
});
