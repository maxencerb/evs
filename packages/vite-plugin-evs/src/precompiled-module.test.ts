/**
 * The module the plugin writes in place of a build-time module, from its exports alone: what
 * each kind of value becomes, checked by running the generated code.
 */

import { describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '@maxencerb/evs';

import { renderPrecompiledModule } from './precompiled-module.js';

const FILE = '/app/src/scripts.evs.ts';

/** Runs generated code that imports nothing, and returns its exports. */
async function run(code: string): Promise<Record<string, unknown>> {
  const module: Record<string, unknown> = await import(
    `data:text/javascript,${encodeURIComponent(code)}`
  );
  return { ...module };
}

/** The exports of the module written for `exports`, read back. */
async function roundTrip(exports: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { code } = await renderPrecompiledModule(FILE, exports);
  return run(code);
}

async function failure(exports: Record<string, unknown>): Promise<string> {
  const error: unknown = await renderPrecompiledModule(FILE, exports).then(
    () => expect.unreachable('expected the module to be refused'),
    (reason: unknown) => reason,
  );
  return error instanceof Error ? error.message : String(error);
}

describe('plain data', () => {
  test('JSON values come back as they were', async () => {
    const exports = {
      text: 'a "quoted" line\nand a second, with   in it',
      count: 42,
      ratio: -1.5e-7,
      on: true,
      off: false,
      nothing: null,
      list: [1, 'two', [3, { four: 4 }]],
      nested: { a: { b: { c: [] } }, 'not-an-identifier': 1, '': 2 },
    };
    expect(await roundTrip(exports)).toStrictEqual(exports);
  });

  test('bigint and undefined are kept, which JSON would lose', async () => {
    const exports = {
      fee: 3000n,
      negative: -(2n ** 255n),
      missing: undefined,
      inside: { amount: 10n ** 18n, optional: undefined, list: [1n, undefined] },
    };
    expect(await roundTrip(exports)).toStrictEqual(exports);
  });

  test('the numbers JSON has no notation for are kept too', async () => {
    const module = await roundTrip({ values: [Number.NaN, Infinity, -Infinity, -0] });
    expect(module.values).toStrictEqual([Number.NaN, Infinity, -Infinity, -0]);
  });

  test('a hole in an array reads as undefined', async () => {
    // oxlint-disable-next-line no-sparse-arrays -- the case under test
    expect(await roundTrip({ sparse: [1, , 3] })).toStrictEqual({ sparse: [1, undefined, 3] });
  });

  test('an own `__proto__` key stays a property', async () => {
    const data: unknown = JSON.parse('{ "__proto__": { "polluted": true }, "kept": 1 }');
    const module = await roundTrip({ data });
    expect(Object.keys(module.data ?? {})).toStrictEqual(['__proto__', 'kept']);
    expect(Object.getPrototypeOf(module.data)).toBe(Object.prototype);
  });

  test('an object without a prototype is plain data', async () => {
    const bare: Record<string, unknown> = Object.assign(Object.create(null), { a: 1 });
    expect(await roundTrip({ bare })).toStrictEqual({ bare: { a: 1 } });
  });
});

describe('export names', () => {
  test('a default export, a reserved word and a name that is no identifier', async () => {
    const exports = { default: 1, class: 2, 'kebab-case': 3, $_ok: 4 };
    const { code } = await renderPrecompiledModule(FILE, exports);
    expect(code).toBe(
      [
        'const _0 = 1;',
        'const _1 = 2;',
        'const _2 = 3;',
        'const _3 = 4;',
        'export { _0 as default, _1 as class, _2 as "kebab-case", _3 as $_ok };',
        '',
      ].join('\n'),
    );
    expect(await run(code)).toStrictEqual(exports);
  });

  test('a module without exports is an empty module', async () => {
    expect(await renderPrecompiledModule(FILE, {})).toStrictEqual({
      code: 'export {};\n',
      scripts: 0,
      debugModules: new Map(),
    });
  });
});

describe('precompiled scripts', () => {
  const one = evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) }))
    .compile()
    .toPrecompiled();
  const two = evscript({ name: 'two' }, (s) => s.return({ two: s.lit(t.uint256, 2n) }))
    .compile()
    .toPrecompiled();

  test('each becomes a pure hydrate() call on its JSON, with a debug module of its own', async () => {
    const module = await renderPrecompiledModule(FILE, { one, FEE: 500n, default: two });
    expect(module.scripts).toBe(2);

    const [oneDebug, twoDebug] = [...module.debugModules.keys()];
    expect(oneDebug).toMatch(
      /^\0virtual:evs-debug:[0-9a-f]{8}:\/app\/src\/scripts\.evs\.ts\.debug\.js$/,
    );
    expect(twoDebug).not.toBe(oneDebug);
    expect(module.code).toBe(
      [
        `import { hydrate } from '@maxencerb/evs/runtime';`,
        `const _0 = /* @__PURE__ */ hydrate(${JSON.stringify(one)}, { debug: () => import(${JSON.stringify(oneDebug?.slice(1))}) });`,
        `const _1 = 500n;`,
        `const _2 = /* @__PURE__ */ hydrate(${JSON.stringify(two)}, { debug: () => import(${JSON.stringify(twoDebug?.slice(1))}) });`,
        `export { _0 as one, _1 as FEE, _2 as default };`,
        '',
      ].join('\n'),
    );
  });

  test('a debug module default-exports the script’s debug data', async () => {
    const { debugModules } = await renderPrecompiledModule(FILE, { one });
    const [code = ''] = [...debugModules.values()];
    expect((await run(code)).default).toStrictEqual(await one.debug());
  });

  test('the debug module is named after its content: it changes with the script only', async () => {
    const first = await renderPrecompiledModule(FILE, { one, two });
    const again = await renderPrecompiledModule(FILE, { one, renamed: two });
    expect([...again.debugModules.keys()]).toStrictEqual([...first.debugModules.keys()]);
  });
});

describe('values that are refused', () => {
  test.for([
    ['a symbol', { tag: Symbol('tag') }, 'the export `tag` is a symbol, which cannot be written'],
    ['a class instance', { when: new Date(0) }, 'the export `when` is an instance of Date, which'],
    [
      'a value deep inside, by its path',
      { config: { pools: [{ ids: new Set([1]) }] } },
      'the export `config.pools[0].ids` is an instance of Set, which',
    ],
    [
      'a key that is no identifier',
      { config: { 'a-b': () => 1 } },
      'the export `config["a-b"]` is a function, and a function cannot be precompiled.',
    ],
  ] as const)('%s', async ([, exports, message]) => {
    expect(await failure(exports)).toContain(message);
  });

  test('a circular reference', async () => {
    const loop: Record<string, unknown> = {};
    loop.self = { back: loop };
    expect(await failure({ loop })).toContain(
      'the export `loop.self.back` is a circular reference, which cannot be written into the bundle.',
    );
  });

  test('the same object twice is not a circular reference', async () => {
    const shared = { fee: 500n };
    expect(await roundTrip({ a: shared, b: [shared, shared] })).toStrictEqual({
      a: shared,
      b: [shared, shared],
    });
  });
});
