import { afterEach, describe, expect, test, vi } from 'vitest';

import { captureLoc, setLocCapture } from './loc.js';

afterEach(() => {
  setLocCapture(true);
  vi.unstubAllGlobals();
});

/** Replace the global Error so `captureLoc()` sees a synthetic stack string. */
function stubStack(stack: string | undefined): void {
  class FakeError {
    stack = stack;
  }
  vi.stubGlobal('Error', FakeError);
}

/** Stub, capture, unstub — assertions must run against the real Error. */
function captureWithStack(stack: string | undefined): ReturnType<typeof captureLoc> {
  stubStack(stack);
  const loc = captureLoc();
  vi.unstubAllGlobals();
  return loc;
}

describe('captureLoc (real runtime stack)', () => {
  test('reports the caller in this test file (test files are exempt from the src skip)', () => {
    const loc = captureLoc();
    expect(loc).not.toBeNull();
    expect(loc?.file).toMatch(/loc\.test\.ts/);
    expect(loc?.line).toBeGreaterThan(0);
    expect(loc?.column).toBeGreaterThan(0);
  });

  test('SourceLoc fields are lazy getters (stack is parsed on first access)', () => {
    const loc = captureLoc();
    expect(loc).not.toBeNull();
    for (const key of ['file', 'line', 'column'] as const) {
      const desc = Object.getOwnPropertyDescriptor(loc, key);
      expect(typeof desc?.get).toBe('function');
    }
  });

  test('setLocCapture(false) disables capture; re-enabling restores it', () => {
    setLocCapture(false);
    expect(captureLoc()).toBeNull();
    setLocCapture(true);
    expect(captureLoc()).not.toBeNull();
  });

  test('returns null when no stack is available', () => {
    expect(captureWithStack(undefined)).toBeNull();
    expect(captureWithStack('')).toBeNull();
  });
});

describe('node/V8-format stacks', () => {
  test('skips @maxencerb/evs frames and node internals, returns the first user frame', () => {
    const loc = captureWithStack(
      [
        'Error',
        '    at captureLoc (/repo/node_modules/@maxencerb/evs/dist/core/loc.js:24:15)',
        '    at arg (/repo/node_modules/@maxencerb/evs/dist/core/types.js:120:9)',
        '    at recordPools (/home/dev/app/pools.ts:9:18)',
        '    at node:internal/main/run_main_module:28:49',
      ].join('\n'),
    );
    expect(loc?.file).toBe('/home/dev/app/pools.ts');
    expect(loc?.line).toBe(9);
    expect(loc?.column).toBe(18);
  });

  test('handles frames without a function name', () => {
    const loc = captureWithStack(
      ['Error: staged', '    at /home/dev/app/pools.ts:42:7'].join('\n'),
    );
    expect(loc?.file).toBe('/home/dev/app/pools.ts');
    expect(loc?.line).toBe(42);
    expect(loc?.column).toBe(7);
  });

  test('strips file:// URLs (node ESM frames)', () => {
    const loc = captureWithStack(
      ['Error', '    at async run (file:///home/dev/my%20app/pools.ts:3:11)'].join('\n'),
    );
    expect(loc?.file).toBe('/home/dev/my app/pools.ts');
    expect(loc?.line).toBe(3);
    expect(loc?.column).toBe(11);
  });

  test('skips pnpm-store copies of the package', () => {
    const loc = captureWithStack(
      [
        'Error',
        '    at arg (/r/node_modules/.pnpm/@maxencerb+evs@0.0.0/node_modules/@maxencerb/evs/dist/core/types.js:5:3)',
        '    at user (/home/dev/app/main.ts:1:20)',
      ].join('\n'),
    );
    expect(loc?.file).toBe('/home/dev/app/main.ts');
  });

  test('skips in-repo src frames but accepts test files inside src', () => {
    const srcCoreDir = new URL('.', import.meta.url).pathname; // …/packages/evs/src/core/
    const skipped = captureWithStack(
      [
        'Error',
        `    at arg (${srcCoreDir}types.ts:120:9)`,
        '    at user (/home/dev/app/main.ts:7:5)',
      ].join('\n'),
    );
    expect(skipped?.file).toBe('/home/dev/app/main.ts');

    const exempt = captureWithStack(
      ['Error', `    at check (${srcCoreDir}fancy.test.ts:3:7)`].join('\n'),
    );
    expect(exempt?.file).toBe(`${srcCoreDir}fancy.test.ts`);
    expect(exempt?.line).toBe(3);
  });
});

describe('bun/JSC-format stacks', () => {
  test('parses fn@file:line:col frames and skips evs/native frames', () => {
    const loc = captureWithStack(
      [
        'captureLoc@/repo/node_modules/@maxencerb/evs/dist/core/loc.js:24:15',
        'arg@/repo/node_modules/@maxencerb/evs/dist/core/types.js:120:9',
        'module code@/home/dev/app/pools.ts:9:18',
        'forEach@[native code]',
      ].join('\n'),
    );
    expect(loc?.file).toBe('/home/dev/app/pools.ts');
    expect(loc?.line).toBe(9);
    expect(loc?.column).toBe(18);
  });

  test('parses anonymous @file:line:col frames', () => {
    const loc = captureWithStack('@/home/dev/app/pools.ts:5:1');
    expect(loc?.file).toBe('/home/dev/app/pools.ts');
    expect(loc?.line).toBe(5);
    expect(loc?.column).toBe(1);
  });

  test('parses bun "at (…)" frames with <anonymous> callee names', () => {
    const loc = captureWithStack(
      [
        'Error:',
        '      at captureLoc (/repo/node_modules/@maxencerb/evs/dist/core/loc.js:24:15)',
        '      at <anonymous> (/home/dev/app/pools.ts:9:18)',
      ].join('\n'),
    );
    expect(loc?.file).toBe('/home/dev/app/pools.ts');
    expect(loc?.line).toBe(9);
    expect(loc?.column).toBe(18);
  });
});

describe('unparseable stacks', () => {
  test('resolve to the <unknown> sentinel on first access', () => {
    const loc = captureWithStack('total garbage\nnothing useful here');
    expect(loc).not.toBeNull();
    expect(loc?.file).toBe('<unknown>');
    expect(loc?.line).toBe(0);
    expect(loc?.column).toBe(0);
  });

  test('frames with only native/internal entries resolve to the sentinel', () => {
    const loc = captureWithStack(
      ['Error', '    at node:internal/x:1:1', 'forEach@[native code]'].join('\n'),
    );
    expect(loc?.file).toBe('<unknown>');
  });
});
