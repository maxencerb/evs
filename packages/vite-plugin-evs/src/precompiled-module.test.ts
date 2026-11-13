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

  test('an own `__proto__` key stays a property', async () => {
    const data: unknown = JSON.parse('{ "__proto__": { "polluted": true }, "kept": 1 }');
    const module = await roundTrip({ data });
    expect(Object.keys(module.data ?? {})).toStrictEqual(['__proto__', 'kept']);
    expect(Object.getPrototypeOf(module.data)).toBe(Object.prototype);
  });

  test('a frozen value and a getter are written as the data they hold', async () => {
    const frozen = Object.freeze({ fees: Object.freeze([500n]) });
    const computed = {
      get total() {
        return 3;
      },
    };
    expect(await roundTrip({ frozen, computed })).toStrictEqual({
      frozen: { fees: [500n] },
      computed: { total: 3 },
    });
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

  /** The ids of the debug modules written for `exports`. */
  async function debugIds(exports: Record<string, unknown>, file = FILE): Promise<string[]> {
    return [...(await renderPrecompiledModule(file, exports)).debugModules.keys()];
  }

  /** The part of a debug module id that changes with the debug data. */
  const hashOf = (id: string): string => id.slice(0, id.indexOf('/'));

  test('each becomes a pure hydrate() call on its JSON, with a debug module of its own', async () => {
    const module = await renderPrecompiledModule(FILE, { one, FEE: 500n, default: two });
    expect(module.scripts).toBe(2);

    const [oneDebug = '', twoDebug = ''] = [...module.debugModules.keys()];
    expect(module.code).toBe(
      [
        `import { hydrate } from '@maxencerb/evs/runtime';`,
        `const _0 = /* @__PURE__ */ hydrate(${JSON.stringify(one)}, { debug: () => import(${JSON.stringify(oneDebug.slice(1))}) });`,
        `const _1 = 500n;`,
        `const _2 = /* @__PURE__ */ hydrate(${JSON.stringify(two)}, { debug: () => import(${JSON.stringify(twoDebug.slice(1))}) });`,
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

  test('a debug module is named by a hash of its data, the file’s base name and the export', async () => {
    const [oneDebug = '', twoDebug = ''] = await debugIds({ one, default: two });
    expect(oneDebug).toMatch(/^\0virtual:evs-debug:[0-9a-f]{8}\/scripts\.evs\.one\.debug\.js$/);
    expect(twoDebug).toMatch(/^\0virtual:evs-debug:[0-9a-f]{8}\/scripts\.evs\.default\.debug\.js$/);
    expect(hashOf(twoDebug)).not.toBe(hashOf(oneDebug));
  });

  test('the hash changes with the script only, not with its file or its export', async () => {
    const here = await debugIds({ one, two });
    const elsewhere = await debugIds({ one, renamed: two }, '/elsewhere/other.evs.ts');
    expect(elsewhere.map(hashOf)).toStrictEqual(here.map(hashOf));
  });

  test('the name holds no path: nothing of the directory the file is in', async () => {
    const [id = ''] = await debugIds({ one }, '/home/me/app/src/pool.evs.mts');
    expect(id).toBe(`${hashOf(id)}/pool.evs.one.debug.js`);
  });

  test('an export name is kept as far as it is safe in a file name and in a URL', async () => {
    const [id = ''] = await debugIds({ '../a b?#%/é': one });
    expect(id).toBe(`${hashOf(id)}/scripts.evs..._a_b_____.debug.js`);
  });

  test('a script exported under two names is written once, and is one object', async () => {
    const module = await renderPrecompiledModule(FILE, {
      one,
      FEE: 500n,
      alias: one,
      default: one,
    });
    expect(module.scripts).toBe(1);
    expect(module.debugModules.size).toBe(1);

    const [debug = ''] = [...module.debugModules.keys()];
    expect(debug).toContain('/scripts.evs.one.debug.js'); // labelled with its first name
    expect(module.code).toBe(
      [
        `import { hydrate } from '@maxencerb/evs/runtime';`,
        `const _0 = /* @__PURE__ */ hydrate(${JSON.stringify(one)}, { debug: () => import(${JSON.stringify(debug.slice(1))}) });`,
        `const _1 = 500n;`,
        `export { _0 as one, _1 as FEE, _0 as alias, _0 as default };`,
        '',
      ].join('\n'),
    );
  });

  test('two scripts with the same content are two scripts', async () => {
    const twin = evscript({ name: 'one' }, (s) => s.return({ one: s.lit(t.uint256, 1n) }))
      .compile()
      .toPrecompiled();
    const module = await renderPrecompiledModule(FILE, { one, twin });
    expect(module.scripts).toBe(2);
    expect(module.code.match(/hydrate\(/g)).toHaveLength(2);
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

  // Each of these would be written as another value than the one the module exported: a client
  // would run on other data than the build, so the build stops instead.
  describe('data a literal would change', () => {
    const WHY = ', which cannot be written into the bundle. A *.evs.ts module exports';

    test('a hole in an array, which would read as undefined', async () => {
      // oxlint-disable-next-line no-sparse-arrays -- the case under test
      expect(await failure({ sparse: [1, , 3] })).toContain(
        `the export \`sparse[1]\` is a hole in an array${WHY}`,
      );
    });

    test('an object without a prototype, which would get one', async () => {
      const bare: Record<string, unknown> = Object.assign(Object.create(null), { a: 1 });
      expect(await failure({ config: { bare } })).toContain(
        `the export \`config.bare\` is an object without a prototype${WHY}`,
      );
    });

    test('a property with a symbol key, which would be dropped', async () => {
      expect(await failure({ tagged: { kept: 1, [Symbol('tag')]: 2 } })).toContain(
        `the export \`tagged[Symbol(tag)]\` is a property with a symbol key${WHY}`,
      );
    });

    test('a property that is not enumerable, which would be dropped', async () => {
      const hidden = Object.defineProperty({ kept: 1 }, 'secret', { value: 2, enumerable: false });
      expect(await failure({ hidden })).toContain(
        `the export \`hidden.secret\` is a property that is not enumerable${WHY}`,
      );
    });

    test('a property added to an array, which would be dropped', async () => {
      const list = Object.assign([1, 2], { unit: 'wei' });
      expect(await failure({ list })).toContain(
        `the export \`list.unit\` is a property added to an array${WHY}`,
      );
      const tagged = Object.assign([1], { [Symbol('tag')]: true });
      expect(await failure({ tagged })).toContain(
        `the export \`tagged[Symbol(tag)]\` is a property added to an array${WHY}`,
      );
    });

    test('an instance of a subclass of Array, which would become an array', async () => {
      class Fees extends Array<bigint> {}
      expect(await failure({ fees: Fees.from([500n]) })).toContain(
        `the export \`fees\` is an instance of Fees${WHY}`,
      );
    });
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
