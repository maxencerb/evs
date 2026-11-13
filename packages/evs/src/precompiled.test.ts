/**
 * Unit tests — `precompiled.ts`: a precompiled script is the artifact it came from, minus the
 * compiler. For a corpus of real scripts (pure, sub-calls, declared errors, a loop, a
 * value-sending call) under each `optimize` setting and a `paris` build, the script rebuilt by
 * `hydrate` from JSON gives the same `toViem()` shapes and errors and the same `explainRevert`
 * as `compile()`'s. Then `hydrate`'s input checks, the lazy `debug` loader, the
 * `isPrecompiledScript` brand, and the serialized shape.
 */

import { encodeErrorResult, parseAbi } from 'viem';
import { describe, expect, test, vi } from 'vite-plus/test';

import { EVS_ERROR_ABI } from './abi/artifact.js';
import { evscript } from './builder/script.js';
import { compile, type CompiledEvsScript, type CompileOptions } from './compile.js';
import { EvsCompileError, EvsError, EvsTypeError } from './core/errors.js';
import { namedArg, t, type Hex } from './core/types.js';
import { serializeIr } from './ir/nodes.js';
import {
  hydrate,
  isPrecompiledScript,
  type PrecompiledScript,
  type PrecompiledScriptData,
  type PrecompiledScriptDebug,
} from './precompiled.js';
import { DEFAULT_SCRIPT_ADDRESS, type ToViemMode } from './viem.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TOKEN = '0xa000000000000000000000000000000000000001' as const;
const WHO = '0xb000000000000000000000000000000000000002' as const;
const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function deposit() payable',
]);

const NoBalance = t.error('NoBalance', [
  namedArg('balance', t.uint256),
  namedArg('who', t.address),
]);
const NotOwner = t.error('NotOwner');

/** One script per feature `explainRevert` and `toViem()` depend on. */
const SCRIPTS = {
  // pure arithmetic: panic sites, no call site
  sum: () =>
    evscript({ name: 'sum', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ total: s.add(a, b) }),
    ),
  // a strict read of a dynamic value: a decode site that bubbles callee reverts
  symbol: () =>
    evscript({ name: 'sym', args: [] }, (s) =>
      s.return({ symbol: s.read({ address: TOKEN, abi: TOKEN_ABI, functionName: 'symbol' }) }),
    ),
  // declared errors, with and without args
  guard: () =>
    evscript(
      { name: 'guard', args: [t.uint256, t.address], errors: [NoBalance, NotOwner] },
      (s, x, who) => {
        s.if(x.lt(10n), () => {
          s.throw(NoBalance, { balance: x, who });
        });
        s.if(x.eq(999n), () => {
          s.throw(NotOwner);
        });
        return s.return({ doubled: x.mul(2n) });
      },
    ),
  // a loop over a runtime array, with a strict read, a try read and an allocation
  balances: () =>
    evscript({ name: 'balances', args: [t.address, t.array(t.address)] }, (s, token, holders) => {
      const out = s.newArray(t.uint256, holders.length());
      const total = s.let(t.uint256, 0n);
      s.forEach(holders, (holder, i) => {
        const balance = s.read({
          address: token,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [holder],
        });
        out.set(i, balance);
        total.set(total.get().add(balance));
      });
      const supply = s.tryRead({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply' });
      return s.return({ balances: out.expr(), total: total.get(), hasSupply: supply.success });
    }),
  // a strict call that sends a value: the unfunded-script explanations
  pay: () =>
    evscript({ name: 'pay', args: [t.address, t.uint256] }, (s, token, amount) => {
      s.call({ address: token, abi: TOKEN_ABI, functionName: 'deposit', value: amount });
      return s.return({ paid: amount });
    }),
} as const;

const BUILDS: readonly (readonly [string, CompileOptions])[] = [
  ['default', {}],
  ['optimize', { optimize: true }],
  ['paris', { evmVersion: 'paris' }],
];

/** Every script under every build, as `[label, artifact]` rows for `describe.each`. */
const CASES: readonly (readonly [string, CompiledEvsScript])[] = Object.entries(SCRIPTS).flatMap(
  ([name, script]) =>
    BUILDS.map(([build, options]) => [`${name} (${build})`, compile(script(), options)] as const),
);

const sumCompiled = compile(SCRIPTS.sum());

function jsonRoundTrip<T>(value: T): T {
  const parsed: T = JSON.parse(JSON.stringify(value));
  return parsed;
}

/** What a client holds after a build step: the script rebuilt from its two JSON documents. */
async function hydrateFromJson(compiled: CompiledEvsScript): Promise<PrecompiledScript> {
  const precompiled = compiled.toPrecompiled();
  const data = jsonRoundTrip(precompiled.toJSON());
  const debug = jsonRoundTrip(await precompiled.debug());
  return hydrate(data, { debug: () => Promise.resolve(debug) });
}

/** `hydrate` on a value its parameter type rejects. */
function hydrateUnchecked(data: unknown): PrecompiledScript {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime checks are under test
  return hydrate(data as PrecompiledScriptData);
}

/** The `EvsError` `fn` throws, as plain data (so two throws can be compared). */
function thrownBy(fn: () => unknown): { name: string; code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof EvsError) {
      return { name: error.name, code: error.code, message: error.message };
    }
    throw error;
  }
  return expect.unreachable('expected the call to throw');
}

// ---------------------------------------------------------------------------
// toViem(): every mode, and the same errors
// ---------------------------------------------------------------------------

const ADDRESS = '0x2000000000000000000000000000000000000002' as const;
const SENDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const SENDER_LOWERCASE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as const;

/** A mode read from configuration: typed `ToViemMode`, not a literal (the catch-all overload). */
const fromConfig = (value: string): ToViemMode =>
  value === 'stateOverride' ? 'stateOverride' : 'deployless';

type HasToViem = Pick<PrecompiledScript, 'toViem'>;

const TO_VIEM_CALLS: readonly (readonly [string, (script: HasToViem) => unknown])[] = [
  ['default', (s) => s.toViem()],
  ['deployless', (s) => s.toViem({ mode: 'deployless' })],
  ['stateOverride', (s) => s.toViem({ mode: 'stateOverride' })],
  ['stateOverride + address', (s) => s.toViem({ mode: 'stateOverride', address: ADDRESS })],
  ['sender', (s) => s.toViem({ mode: 'stateOverride', sender: SENDER })],
  [
    'sender + the same address',
    (s) => s.toViem({ mode: 'stateOverride', sender: SENDER, address: SENDER_LOWERCASE }),
  ],
  [
    'run-time mode: deployless',
    (s) => s.toViem({ mode: fromConfig('deployless'), address: ADDRESS }),
  ],
  [
    'run-time mode: stateOverride',
    (s) => s.toViem({ mode: fromConfig('stateOverride'), sender: SENDER }),
  ],
];

const TO_VIEM_ERRORS: readonly (readonly [string, (script: HasToViem) => unknown])[] = [
  ['a malformed address', (s) => s.toViem({ mode: 'stateOverride', address: '0x1234' })],
  ['a malformed sender', (s) => s.toViem({ mode: 'stateOverride', sender: '0x1234' })],
  [
    'a sender and a different address',
    (s) => s.toViem({ mode: 'stateOverride', sender: SENDER, address: DEFAULT_SCRIPT_ADDRESS }),
  ],
  [
    'a malformed address next to a sender',
    (s) => s.toViem({ mode: 'stateOverride', sender: SENDER, address: '0x1234' }),
  ],
];

// ---------------------------------------------------------------------------
// explainRevert: one payload per revert kind, plus what each script's own sites add
// ---------------------------------------------------------------------------

const ERROR_ABI = [
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
  { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
  NoBalance.abi,
  NotOwner.abi,
] as const;

const decodeError = (site: number): Hex =>
  encodeErrorResult({ abi: EVS_ERROR_ABI, errorName: 'EvsDecodeError', args: [BigInt(site)] });

const NO_BALANCE = encodeErrorResult({
  abi: ERROR_ABI,
  errorName: 'NoBalance',
  args: [5n, WHO],
});

const PAYLOADS: readonly Hex[] = [
  '0x', // empty
  '0x4e48', // shorter than a selector
  encodeErrorResult({ abi: ERROR_ABI, errorName: 'Panic', args: [0x11n] }), // overflow
  encodeErrorResult({ abi: ERROR_ABI, errorName: 'Panic', args: [0x32n] }), // array index
  encodeErrorResult({ abi: ERROR_ABI, errorName: 'Panic', args: [0x01n] }), // no site raises it
  '0x4e487b7100', // the Panic selector over a short body
  encodeErrorResult({ abi: ERROR_ABI, errorName: 'Error', args: ['boom'] }),
  '0x08c379a0ffff', // the Error selector over garbage
  encodeErrorResult({ abi: EVS_ERROR_ABI, errorName: 'EvsInvalidCalldata' }),
  decodeError(999_999), // a site no script has
  `${decodeError(0)}${'00'.repeat(32)}`, // not the 36 bytes the compiler emits
  NO_BALANCE, // declared by `guard`, a foreign selector elsewhere
  encodeErrorResult({ abi: ERROR_ABI, errorName: 'NotOwner' }),
  `0x${NO_BALANCE.slice(2, 10)}ff`, // a declared selector over malformed args
  '0xdeadbeef', // an unknown selector
];

/** The shared payloads, then `EvsDecodeError(id)` for every site of the script: the decode
 *  sites it names exactly and the other kinds it must refuse to attribute. */
function payloadsFor(compiled: CompiledEvsScript): readonly Hex[] {
  return [...PAYLOADS, ...compiled.sourceMap.sites.map((site) => decodeError(site.id))];
}

// ---------------------------------------------------------------------------
// parity with the artifact
// ---------------------------------------------------------------------------

describe.each(CASES)('hydrated from JSON: %s', (_label, compiled) => {
  test('the script fields are the artifact’s', async () => {
    const hydrated = await hydrateFromJson(compiled);
    expect(hydrated.abi).toEqual(compiled.abi);
    expect(hydrated.runtimeBytecode).toBe(compiled.runtimeBytecode);
    expect(hydrated.initBytecode).toBe(compiled.initBytecode);
    expect(hydrated.evmVersion).toBe(compiled.options.evmVersion);
  });

  test.each(TO_VIEM_CALLS)('toViem(): %s', async (_mode, call) => {
    const hydrated = await hydrateFromJson(compiled);
    expect(call(hydrated)).toEqual(call(compiled));
    expect(call(compiled.toPrecompiled())).toEqual(call(compiled));
  });

  test.each(TO_VIEM_ERRORS)('toViem() throws the same error for %s', async (_what, call) => {
    const hydrated = await hydrateFromJson(compiled);
    const expected = thrownBy(() => call(compiled));
    expect(expected.name).toBe('EvsTypeError');
    expect(thrownBy(() => call(hydrated))).toEqual(expected);
    expect(thrownBy(() => call(compiled.toPrecompiled()))).toEqual(expected);
  });

  test('explainRevert() resolves to the artifact’s explanation, for every payload', async () => {
    const direct = compiled.toPrecompiled();
    const hydrated = await hydrateFromJson(compiled);
    const payloads = payloadsFor(compiled);
    const expected = payloads.map((payload) => compiled.explainRevert(payload));
    expect(await Promise.all(payloads.map((p) => direct.explainRevert(p)))).toStrictEqual(expected);
    expect(await Promise.all(payloads.map((p) => hydrated.explainRevert(p)))).toStrictEqual(
      expected,
    );
  });

  test('the debug data is JSON-safe: a round trip changes nothing', async () => {
    const debug = await compiled.toPrecompiled().debug();
    const copy = jsonRoundTrip(debug);
    expect(copy).toEqual(debug);
    expect(serializeIr(copy.ir)).toBe(serializeIr(compiled.ir));
    expect(copy.sites).toStrictEqual(compiled.sourceMap.sites);
  });
});

test('the payload corpus reaches every explanation kind, with and without an exact site', () => {
  const explanations = CASES.flatMap(([, compiled]) =>
    payloadsFor(compiled).map((payload) => compiled.explainRevert(payload)),
  );
  expect(new Set(explanations.map((e) => e.kind))).toEqual(
    new Set([
      'panic',
      'evs-decode',
      'evs-invalid-calldata',
      'error-string',
      'script-error',
      'custom',
      'empty',
    ]),
  );
  expect(explanations.some((e) => e.site !== undefined)).toBe(true);
  expect(explanations.some((e) => (e.candidateSites?.length ?? 0) > 0)).toBe(true);
  expect(explanations.some((e) => e.errorArgs !== undefined)).toBe(true);
  // the value-sending call of `pay`, and a fork-gated opcode on the non-paris builds
  expect(explanations.some((e) => e.message.includes('balance was below'))).toBe(true);
  expect(explanations.some((e) => e.message.includes('PUSH0 (shanghai)'))).toBe(true);
});

// ---------------------------------------------------------------------------
// toPrecompiled() and the serialized shape
// ---------------------------------------------------------------------------

describe('toPrecompiled()', () => {
  test('narrows the artifact: same ABI object, same bytecode, its evmVersion', () => {
    const paris = compile(SCRIPTS.symbol(), { evmVersion: 'paris' });
    const precompiled = paris.toPrecompiled();
    expect(precompiled.abi).toBe(paris.abi);
    expect(precompiled.runtimeBytecode).toBe(paris.runtimeBytecode);
    expect(precompiled.initBytecode).toBe(paris.initBytecode);
    expect(precompiled.evmVersion).toBe('paris');
    expect(Object.keys(precompiled).toSorted()).toEqual([
      'abi',
      'debug',
      'evmVersion',
      'explainRevert',
      'initBytecode',
      'runtimeBytecode',
      'toJSON',
      'toViem',
    ]);
  });

  test('debug() is the artifact’s recorded IR and emitted sites', async () => {
    const debug = await sumCompiled.toPrecompiled().debug();
    expect(Object.keys(debug)).toEqual(['version', 'ir', 'sites']);
    expect(debug.version).toBe(1);
    expect(debug.ir).toBe(sumCompiled.ir);
    expect(debug.sites).toBe(sumCompiled.sourceMap.sites);
  });

  test('toJSON() is exactly the four data keys, and what JSON.stringify writes', () => {
    const precompiled = sumCompiled.toPrecompiled();
    const data = precompiled.toJSON();
    expect(Object.keys(data)).toEqual(['version', 'abi', 'runtimeBytecode', 'evmVersion']);
    expect(data).toEqual({
      version: 1,
      abi: sumCompiled.abi,
      runtimeBytecode: sumCompiled.runtimeBytecode,
      evmVersion: 'cancun',
    });
    expect(JSON.stringify(precompiled)).toBe(JSON.stringify(data));
    // the init bytecode is derived, never serialized: the runtime ships once
    expect(JSON.stringify(precompiled)).not.toContain(sumCompiled.initBytecode.slice(2));
  });

  test('a hydrated script serializes back to the data it was given', async () => {
    const data = jsonRoundTrip(sumCompiled.toPrecompiled().toJSON());
    const hydrated = hydrate(data);
    expect(hydrated.toJSON()).toEqual(data);
    expect(hydrated.abi).toBe(data.abi); // kept as given, not copied
    expect(hydrate(jsonRoundTrip(hydrated.toJSON())).toViem()).toEqual(sumCompiled.toViem());
  });

  test('the script and its data are frozen', () => {
    const scripts = [sumCompiled.toPrecompiled(), hydrate(sumCompiled.toPrecompiled().toJSON())];
    for (const script of scripts) {
      expect(Object.isFrozen(script)).toBe(true);
      expect(Object.isFrozen(script.toJSON())).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// hydrate: input checks
// ---------------------------------------------------------------------------

describe('hydrate rejects what is not precompiled script data', () => {
  const data = sumCompiled.toPrecompiled().toJSON();

  test('data of another format version must be regenerated', () => {
    const stale = () => hydrateUnchecked({ ...data, version: 2 });
    expect(stale).toThrowError(EvsTypeError);
    expect(stale).toThrowError(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    expect(stale).toThrowError(
      /^hydrate: the precompiled script data has version 2 and this evs reads version 1: another version of evs produced it, so it must be regenerated/,
    );
    expect(() => hydrateUnchecked({ ...data, version: '1' })).toThrowError(/has version "1"/);
  });

  test.each([
    ['data with no version', { ...data, version: undefined }],
    ['a module namespace around the data', { default: data }],
    ['null', null],
    ['undefined', undefined],
    ['a string', JSON.stringify(data)],
  ])('%s is not a precompiled script', (_what, value) => {
    const notData = () => hydrateUnchecked(value);
    expect(notData).toThrowError(EvsTypeError);
    expect(notData).toThrowError(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    expect(notData).toThrowError(
      /^hydrate: the precompiled script data has no `version`: it is not what a precompiled script serializes to$/,
    );
  });

  test.each([
    ['an object', { ...data, abi: { 0: data.abi[0] } }],
    ['a JSON string', { ...data, abi: JSON.stringify(data.abi) }],
    ['missing', { ...data, abi: undefined }],
  ])('`abi` must be an array: %s', (_what, value) => {
    const badAbi = () => hydrateUnchecked(value);
    expect(badAbi).toThrowError(EvsTypeError);
    expect(badAbi).toThrowError(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    expect(badAbi).toThrowError(/^hydrate: `abi` must be an array/);
  });

  test.each([
    ['odd-length hex', '0x123'],
    ['no 0x prefix', data.runtimeBytecode.slice(2)],
    ['not hex', '0xzz'],
    ['bytes', new Uint8Array([0x60, 0x00])],
    ['missing', undefined],
  ])('`runtimeBytecode` must be 0x even-length hex: %s', (_what, runtimeBytecode) => {
    const badBytecode = () => hydrateUnchecked({ ...data, runtimeBytecode });
    expect(badBytecode).toThrowError(EvsTypeError);
    expect(badBytecode).toThrowError(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    expect(badBytecode).toThrowError(
      /^hydrate: `runtimeBytecode` must be 0x-prefixed even-length hex$/,
    );
  });

  test.each([['frontier'], ['prague'], ['Cancun'], [undefined], [7]])(
    'an unknown evmVersion: %s',
    (evmVersion) => {
      const badFork = () => hydrateUnchecked({ ...data, evmVersion });
      expect(badFork).toThrowError(EvsCompileError);
      expect(badFork).toThrowError(expect.objectContaining({ code: 'EVM_VERSION' }));
      expect(badFork).toThrowError(
        /^hydrate: unknown evmVersion .* — expected 'paris', 'shanghai' or 'cancun'$/,
      );
    },
  );

  test('an empty runtime and an empty ABI are valid data', () => {
    const empty = hydrate({ version: 1, abi: [], runtimeBytecode: '0x', evmVersion: 'shanghai' });
    expect(empty.initBytecode).toBe('0x61000080600a5f395ff3');
  });
});

// ---------------------------------------------------------------------------
// the debug loader
// ---------------------------------------------------------------------------

describe('debug data', () => {
  const compiled = compile(SCRIPTS.guard());
  const data = compiled.toPrecompiled().toJSON();
  const loadDebug = (): Promise<PrecompiledScriptDebug> => compiled.toPrecompiled().debug();

  test('without a loader, explainRevert() and debug() reject with DEBUG_DATA_MISSING', async () => {
    const bare = hydrate(data);
    const rejections = await Promise.allSettled([bare.explainRevert(NO_BALANCE), bare.debug()]);
    for (const rejection of rejections) {
      const error: unknown = rejection.status === 'rejected' ? rejection.reason : undefined;
      expect(error).toBeInstanceOf(EvsError);
      expect(error).toMatchObject({ name: 'EvsError', code: 'DEBUG_DATA_MISSING' });
      expect(error).toHaveProperty(
        'message',
        expect.stringMatching(/^this precompiled script was hydrated without debug data/),
      );
    }
    // everything that needs no debug data still works
    expect(bare.toViem()).toEqual(compiled.toViem());
    expect(bare.toJSON()).toEqual(data);
  });

  test('the loader runs on the first use, once, and its result is shared', async () => {
    const debug = await loadDebug();
    const load = vi.fn<() => Promise<PrecompiledScriptDebug>>(() => Promise.resolve(debug));
    const script = hydrate(data, { debug: load });
    script.toViem();
    script.toJSON();
    expect(load).not.toHaveBeenCalled();

    // concurrent first uses share one load
    const [first, second, loaded] = await Promise.all([
      script.explainRevert(NO_BALANCE),
      script.explainRevert('0x'),
      script.debug(),
    ]);
    expect(first).toStrictEqual(compiled.explainRevert(NO_BALANCE));
    expect(second).toStrictEqual(compiled.explainRevert('0x'));
    expect(loaded).toBe(debug);
    expect(await script.debug()).toBe(debug);
    await script.explainRevert('0xdeadbeef');
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a module namespace is accepted: the loader can be `() => import(…)`', async () => {
    const debug = await loadDebug();
    // what `import('./script.debug.json')` resolves to, with and without named exports
    const namespaces = [{ default: debug }, { default: debug, ...debug }];
    const scripts = namespaces.map((namespace) =>
      hydrate(data, { debug: () => Promise.resolve(namespace) }),
    );
    expect(await Promise.all(scripts.map((script) => script.debug()))).toEqual([debug, debug]);
    expect(await scripts[0]?.debug()).toBe(debug);
    expect(await scripts[1]?.explainRevert(NO_BALANCE)).toStrictEqual(
      compiled.explainRevert(NO_BALANCE),
    );
  });

  test('a failed load is not kept: the next call loads again', async () => {
    const debug = await loadDebug();
    const load = vi
      .fn<() => Promise<PrecompiledScriptDebug>>()
      .mockRejectedValueOnce(new Error('chunk failed to load'))
      .mockResolvedValue(debug);
    const script = hydrate(data, { debug: load });
    await expect(script.explainRevert('0x')).rejects.toThrowError('chunk failed to load');
    expect(await script.explainRevert('0x')).toStrictEqual(compiled.explainRevert('0x'));
    expect(await script.debug()).toBe(debug);
    expect(load).toHaveBeenCalledTimes(2);
  });

  /** A script whose loader resolves to `loaded`, whatever its type says. */
  const withDebug = (loaded: unknown): PrecompiledScript =>
    hydrate(data, {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime check is under test
      debug: () => Promise.resolve(loaded as PrecompiledScriptDebug),
    });

  test('debug data of another format version is rejected, not explained with', async () => {
    const stale = withDebug({ ...(await loadDebug()), version: 2 });
    const message =
      /^the debug data of the precompiled script has version 2 and this evs reads version 1: another version of evs produced it, so it must be regenerated/;
    await expect(stale.debug()).rejects.toThrowError(EvsTypeError);
    await expect(stale.debug()).rejects.toThrowError(message);
    await expect(stale.explainRevert('0x')).rejects.toThrowError(message);
  });

  test.each([
    ['undefined (a wrong export)', undefined, 'has no `version`'],
    ['null', null, 'has no `version`'],
    ['an empty module namespace', { default: undefined }, 'has no `version`'],
    ['the script data', data, 'must hold `ir` and `sites`'],
  ])('a loader that resolves to %s is rejected', async (_what, loaded, problem) => {
    const script = withDebug(loaded);
    await expect(script.debug()).rejects.toThrowError(EvsTypeError);
    await expect(script.explainRevert('0x')).rejects.toThrowError(
      `the debug data of the precompiled script ${problem}`,
    );
  });

  test('explainRevert() rejects malformed revert data with the artifact’s error', async () => {
    const script = hydrate(data, { debug: loadDebug });
    const expected = thrownBy(() => compiled.explainRevert('0x123'));
    expect(expected.name).toBe('EvsTypeError');
    await expect(script.explainRevert('0x123')).rejects.toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// isPrecompiledScript
// ---------------------------------------------------------------------------

describe('isPrecompiledScript', () => {
  test('recognizes the scripts toPrecompiled() and hydrate() build', () => {
    const precompiled = sumCompiled.toPrecompiled();
    expect(isPrecompiledScript(precompiled)).toBe(true);
    expect(isPrecompiledScript(hydrate(precompiled.toJSON()))).toBe(true);
  });

  test('rejects everything else, the artifact and the plain data included', () => {
    const precompiled = sumCompiled.toPrecompiled();
    const others = [
      sumCompiled,
      precompiled.toJSON(),
      jsonRoundTrip(precompiled),
      { ...precompiled }, // a copy of the members is not a script
      {},
      [],
      null,
      undefined,
      'script',
      0,
    ];
    for (const value of others) expect(isPrecompiledScript(value)).toBe(false);
  });

  test('the brand is a registered symbol, so a script of another copy of evs is recognized', () => {
    // what a duplicated install of the package stamps on its own scripts
    const brand = Symbol.for('@maxencerb/evs/precompiled');
    expect(isPrecompiledScript({ [brand]: true })).toBe(true);
    expect(isPrecompiledScript({ [brand]: false })).toBe(false);
    // hidden from the script's own keys and from its JSON
    const precompiled = sumCompiled.toPrecompiled();
    expect(Object.getOwnPropertySymbols(precompiled)).toEqual([brand]);
    expect(Object.getOwnPropertyDescriptor(precompiled, brand)?.enumerable).toBe(false);
  });
});
