import { describe, expect, test } from 'vite-plus/test';

import { lookupPc, siteById, type SourceMap } from './sourcemap.js';

const MAP: SourceMap = {
  version: 1,
  segments: [
    { pc: 0, len: 2, note: 'prologue' },
    { pc: 2, len: 3 },
    { pc: 5, len: 1 },
    // gap: pc 6..9
    { pc: 10, len: 4, note: 'data segment guard' },
  ],
  sites: [
    { id: 7, kind: 'decode', detail: 'decoding symbol() returndata' },
    { id: 9, kind: 'panic', detail: 'checked add' },
  ],
  labels: [{ pc: 5, name: 'main' }],
};

describe('lookupPc', () => {
  test('hits inside a segment, including both boundaries', () => {
    expect(lookupPc(MAP, 0)).toEqual({ note: 'prologue' });
    expect(lookupPc(MAP, 1)).toEqual({ note: 'prologue' });
    expect(lookupPc(MAP, 2)).toEqual({});
    expect(lookupPc(MAP, 4)).toEqual({});
    expect(lookupPc(MAP, 5)).toEqual({});
    expect(lookupPc(MAP, 13)).toEqual({ note: 'data segment guard' });
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
