import { describe, expect, test } from 'vitest';

import {
  EvsCompileError,
  EvsError,
  EvsInternalError,
  EvsScopeError,
  EvsStagingError,
  EvsTypeError,
  type EvsErrorCode,
  type SourceLoc,
} from './errors.js';

const LOC: SourceLoc = { file: '/home/dev/app/pools.ts', line: 9, column: 18 };

describe('EvsError', () => {
  test('stores code, message; loc defaults to null, relatedLocs to []', () => {
    const e = new EvsError('TYPE_MISMATCH', 'boom');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('TYPE_MISMATCH');
    expect(e.message).toBe('boom');
    expect(e.loc).toBeNull();
    expect(e.relatedLocs).toEqual([]);
    expect(e.name).toBe('EvsError');
  });

  test('stores loc and relatedLocs when provided', () => {
    const related = [
      { label: 'recorded at', loc: LOC },
      { label: 'other script', loc: null },
    ] as const;
    const e = new EvsError('FOREIGN_HANDLE', 'boom', { loc: LOC, relatedLocs: related });
    expect(e.loc).toBe(LOC);
    expect(e.relatedLocs).toEqual([...related]);
  });

  test('accepts an explicit null loc', () => {
    const e = new EvsError('SCOPE_VIOLATION', 'boom', { loc: null });
    expect(e.loc).toBeNull();
  });

  test('every declared error code is constructible', () => {
    const codes: readonly EvsErrorCode[] = [
      'STAGING_MISUSE',
      'TYPE_MISMATCH',
      'LITERAL_RANGE',
      'CERTAIN_PANIC',
      'SCOPE_VIOLATION',
      'FOREIGN_HANDLE',
      'RECORDING_CLOSED',
      'UNSUPPORTED_V0',
      'ABI_SHAPE',
      'COMPILE_LIMIT',
      'EVM_VERSION',
      'INTERNAL',
    ];
    for (const code of codes) expect(new EvsError(code, 'x').code).toBe(code);
  });
});

describe('subclasses', () => {
  test('each subclass is an EvsError and reports its own name', () => {
    const cases = [
      [EvsStagingError, 'EvsStagingError', 'STAGING_MISUSE'],
      [EvsTypeError, 'EvsTypeError', 'TYPE_MISMATCH'],
      [EvsScopeError, 'EvsScopeError', 'SCOPE_VIOLATION'],
      [EvsCompileError, 'EvsCompileError', 'COMPILE_LIMIT'],
      [EvsInternalError, 'EvsInternalError', 'INTERNAL'],
    ] as const;
    for (const [Ctor, name, code] of cases) {
      const e = new Ctor(code, 'boom', { loc: LOC });
      expect(e).toBeInstanceOf(Ctor);
      expect(e).toBeInstanceOf(EvsError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(name);
      expect(e.code).toBe(code);
      expect(e.loc).toBe(LOC);
    }
  });

  test('subclasses are distinguishable from each other', () => {
    const e = new EvsTypeError('TYPE_MISMATCH', 'boom');
    expect(e).not.toBeInstanceOf(EvsScopeError);
    expect(e).not.toBeInstanceOf(EvsInternalError);
  });
});

describe('EvsInternalError', () => {
  test('message always contains "bug in evs, please report"', () => {
    const e = new EvsInternalError('INTERNAL', 'stack height mismatch at @while_1');
    expect(e.message).toContain('stack height mismatch at @while_1');
    expect(e.message).toContain('bug in evs, please report');
  });

  test('does not duplicate the marker when the message already contains it', () => {
    const msg = 'verifier failed — this is a bug in evs, please report it with the IR dump';
    const e = new EvsInternalError('INTERNAL', msg);
    expect(e.message).toBe(msg);
  });
});
