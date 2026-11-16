/**
 * Unit tests — `precompiled.ts`: a precompiled script is the artifact it came from, minus the
 * compiler. For a corpus of real scripts (pure, sub-calls, declared errors, a loop, a
 * value-sending call) under each `optimize` setting and a `paris` build, the script rebuilt by
 * `hydrate` from JSON gives the same `toViem()` shapes and errors and the same `explainRevert`
 * as `compile()`'s. Then `hydrate`'s input checks, the lazy `debug` loader, the pairing of a
 * script's data with its debug data, the `isPrecompiledScript` brand, and the serialized shape.
 */

import { encodeErrorResult, parseAbi } from 'viem';
import { describe, expect, test, vi } from 'vite-plus/test';

import { EVS_ERROR_ABI } from './abi/artifact.js';
import { evscript } from './builder/script.js';
import { compile, type CompiledEvsScript, type CompileOptions } from './compile.js';
import { EvsCompileError, EvsError, EvsTypeError } from './core/errors.js';
import { namedArg, t, type Hex } from './core/types.js';
import { hydrate } from './hydrate.js';
import { serializeIr } from './ir/nodes.js';
import {
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

/** The value `toPrecompiled()` writes into a script's data and into its debug data. */
const ID = /^0x[0-9a-f]{16}$/;

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

/** An `EvsTypeError` (`TYPE_MISMATCH`) as {@link thrownBy} and {@link rejectionsOf} describe it. */
function typeMismatch(message: string): { name: string; code: string; message: string } {
  return { name: 'EvsTypeError', code: 'TYPE_MISMATCH', message };
}

/**
 * What `debug()` and `explainRevert(payload)` reject with, duplicates dropped. Both load the
 * debug data, so they fail alike: one entry is the error of both.
 */
async function rejectionsOf(
  script: PrecompiledScript,
  payload: Hex = '0x',
): Promise<{ name: string; code?: string; message: string }[]> {
  const settled = await Promise.allSettled([script.debug(), script.explainRevert(payload)]);
  const outcomes = settled.map((result) => {
    if (result.status === 'fulfilled') return { name: 'none', message: 'the call resolved' };
    const error: unknown = result.reason;
    return error instanceof EvsError
      ? { name: error.name, code: error.code, message: error.message }
      : { name: 'not an EvsError', message: String(error) };
  });
  return outcomes.filter(
    (outcome, i) => outcomes.findIndex((other) => other.message === outcome.message) === i,
  );
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
    expect(Object.keys(debug)).toEqual(['version', 'id', 'ir', 'sites']);
    expect(debug.version).toBe(1);
    expect(debug.ir).toBe(sumCompiled.ir);
    expect(debug.sites).toBe(sumCompiled.sourceMap.sites);
  });

  test('toJSON() is exactly the five data keys, and what JSON.stringify writes', () => {
    const precompiled = sumCompiled.toPrecompiled();
    const data = precompiled.toJSON();
    expect(Object.keys(data)).toEqual(['version', 'id', 'abi', 'runtimeBytecode', 'evmVersion']);
    expect(data).toEqual({
      version: 1,
      id: expect.stringMatching(ID),
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

  const PASS_THE_DATA = 'pass what JSON.stringify(compiled.toPrecompiled()) wrote, parsed';

  test.each([
    ['the JSON text', JSON.stringify(data), 'a string: pass JSON.parse(text)'],
    [
      'a precompiled script',
      sumCompiled.toPrecompiled(),
      'a precompiled script: pass script.toJSON(), or use the script as it is',
    ],
    [
      'a hydrated script',
      hydrate(data),
      'a precompiled script: pass script.toJSON(), or use the script as it is',
    ],
    ['a compiled script', sumCompiled, 'a compiled script: pass compiled.toPrecompiled().toJSON()'],
    [
      'data with no version',
      { ...data, version: undefined },
      `an object with no \`version\`: ${PASS_THE_DATA}`,
    ],
    [
      'a module namespace around the data',
      { default: data },
      `an object with no \`version\`: ${PASS_THE_DATA}`,
    ],
    ['an array around the data', [data], `an object with no \`version\`: ${PASS_THE_DATA}`],
    ['null', null, `null: ${PASS_THE_DATA}`],
    ['undefined', undefined, `undefined: ${PASS_THE_DATA}`],
  ])('%s: the error says what was passed and what to pass', (_what, value, got) => {
    const notData = () => hydrateUnchecked(value);
    expect(notData).toThrowError(EvsTypeError);
    expect(thrownBy(notData)).toEqual({
      name: 'EvsTypeError',
      code: 'TYPE_MISMATCH',
      message: `hydrate: expected the data of a precompiled script, got ${got}`,
    });
  });

  const [scriptFunction, ...scriptErrors] = data.abi;

  test.each([
    ['an object', { 0: scriptFunction }],
    ['a JSON string', JSON.stringify(data.abi)],
    ['missing', undefined],
    ['empty', []],
    ['entries that are not ABI items', [null, 1, 'x']],
    ['the error entries alone', scriptErrors],
    ['a function entry with no name', [{ ...scriptFunction, name: undefined }, ...scriptErrors]],
  ])('`abi` must start with the script’s function: %s', (_what, abi) => {
    const badAbi = () => hydrateUnchecked({ ...data, abi });
    expect(badAbi).toThrowError(EvsTypeError);
    expect(thrownBy(badAbi)).toEqual({
      name: 'EvsTypeError',
      code: 'TYPE_MISMATCH',
      message:
        "hydrate: `abi` must be the script ABI: an array that starts with the script's function",
    });
  });

  test.each([
    ['empty', '0x'],
    ['odd-length hex', '0x123'],
    ['one digit short of the code', data.runtimeBytecode.slice(0, -1)],
    ['no 0x prefix', data.runtimeBytecode.slice(2)],
    ['not hex', '0xzz'],
    ['bytes', new Uint8Array([0x60, 0x00])],
    ['missing', undefined],
  ])('`runtimeBytecode` must be non-empty 0x even-length hex: %s', (_what, runtimeBytecode) => {
    const badBytecode = () => hydrateUnchecked({ ...data, runtimeBytecode });
    expect(badBytecode).toThrowError(EvsTypeError);
    expect(thrownBy(badBytecode)).toEqual({
      name: 'EvsTypeError',
      code: 'TYPE_MISMATCH',
      message: 'hydrate: `runtimeBytecode` must be non-empty 0x-prefixed even-length hex',
    });
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

  test('fields the format does not have are ignored, and not kept', () => {
    const script = hydrateUnchecked({ ...data, initBytecode: '0xdead', extra: 1 });
    expect(script.initBytecode).toBe(sumCompiled.initBytecode);
    expect(script.toJSON()).toEqual(data);
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

  test('a loader that throws instead of rejecting is a rejection too', async () => {
    const script = hydrate(data, {
      debug: () => {
        throw new Error('no such chunk');
      },
    });
    await expect(script.debug()).rejects.toThrowError('no such chunk');
    await expect(script.explainRevert('0x')).rejects.toThrowError('no such chunk');
  });

  /** A script whose loader resolves to `loaded`, whatever its type says. */
  const withDebug = (loaded: unknown): PrecompiledScript =>
    hydrate(data, {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime check is under test
      debug: () => Promise.resolve(loaded as PrecompiledScriptDebug),
    });

  const WHAT = 'the debug data of the precompiled script';
  const REGENERATE =
    'another version of evs produced it, so it must be regenerated (compile the script again)';
  const EXPECTED = "what the script's debug() returned at build time";

  test('debug data of another format version is rejected, not explained with', async () => {
    const stale = withDebug({ ...(await loadDebug()), version: 2 });
    expect(await rejectionsOf(stale)).toEqual([
      typeMismatch(`${WHAT} has version 2 and this evs reads version 1: ${REGENERATE}`),
    ]);
  });

  test('an IR of another version is rejected, not explained with', async () => {
    const debug = await loadDebug();
    const future = withDebug({ ...debug, ir: { ...debug.ir, irVersion: 99 } });
    expect(await rejectionsOf(future)).toEqual([
      typeMismatch(`the IR in ${WHAT} has version 99 and this evs reads version 1: ${REGENERATE}`),
    ]);
  });

  test.each([
    ['undefined (a wrong export)', undefined],
    ['null', null],
    ['an empty module namespace', { default: undefined }],
    ['the JSON text', '{"version":1}'],
    ['an object with no version', { ir: {}, sites: [] }],
  ])('a loader that resolves to %s is rejected', async (_what, loaded) => {
    expect(await rejectionsOf(withDebug(loaded))).toEqual([
      typeMismatch(
        `${WHAT} has no \`version\`: the \`debug\` loader must resolve to ${EXPECTED}, or to a ` +
          'module whose default export is that',
      ),
    ]);
  });

  test('a loader that resolves to the script’s data is rejected', async () => {
    expect(await rejectionsOf(withDebug(data))).toEqual([
      typeMismatch(
        `${WHAT} must hold \`ir\` and \`sites\`: the \`debug\` loader must resolve to ${EXPECTED}`,
      ),
    ]);
  });

  test('explainRevert() rejects malformed revert data with the artifact’s error', async () => {
    const script = hydrate(data, { debug: loadDebug });
    const expected = thrownBy(() => compiled.explainRevert('0x123'));
    expect(expected.name).toBe('EvsTypeError');
    await expect(script.explainRevert('0x123')).rejects.toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// malformed debug data
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Every path into a JSON document (array indices as keys), the root left out. */
function pathsOf(value: unknown, at: readonly string[] = []): (readonly string[])[] {
  if (!isRecord(value)) return [];
  const paths: (readonly string[])[] = [];
  for (const key of Object.keys(value)) {
    const path = [...at, key];
    paths.push(path, ...pathsOf(value[key], path));
  }
  return paths;
}

/** A copy of `document` with `junk` at `path`. */
function withJunkAt(document: unknown, path: readonly string[], junk: unknown): unknown {
  const copy: unknown = jsonRoundTrip(document);
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = isRecord(parent) ? parent[key] : undefined;
  const last = path.at(-1);
  if (isRecord(parent) && last !== undefined) parent[last] = junk;
  return copy;
}

/** The debug data as `debug()` returns it. */
function asWritten(debug: PrecompiledScriptDebug): unknown {
  return debug;
}

/** The debug data as evs 0.6.0 wrote it: the same document, its sites without a `key`. */
function withoutSiteKeys(debug: PrecompiledScriptDebug): unknown {
  return { ...debug, sites: debug.sites.map(({ key: _key, ...site }) => site) };
}

describe('debug data written before sites had a key', () => {
  test.each([
    ['guard', SCRIPTS.guard],
    ['balances', SCRIPTS.balances],
    ['pay', SCRIPTS.pay],
  ])('%s: it loads, and its sites get the keys the compiler gives them', async (_name, script) => {
    const artifact = compile(script());
    const precompiled = artifact.toPrecompiled();
    const old = withoutSiteKeys(jsonRoundTrip(await precompiled.debug()));
    const hydrated = hydrate(precompiled.toJSON(), {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a document of another version
      debug: () => Promise.resolve(old as PrecompiledScriptDebug),
    });
    expect((await hydrated.debug()).sites).toEqual(artifact.sourceMap.sites);
    const payloads = payloadsFor(artifact);
    expect(await Promise.all(payloads.map((payload) => hydrated.explainRevert(payload)))).toEqual(
      payloads.map((payload) => artifact.explainRevert(payload)),
    );
  });

  test.each([
    ['as written today', asWritten],
    ['as evs 0.6.0 wrote it', withoutSiteKeys],
  ])('an explained site carries its key: debug data %s', async (_name, format) => {
    const artifact = compile(SCRIPTS.balances());
    const precompiled = artifact.toPrecompiled();
    const debug = format(jsonRoundTrip(await precompiled.debug()));
    const site = artifact.sourceMap.sites.find((s) => s.kind === 'decode');
    if (site === undefined) throw new Error('the fixture has a strict read');
    const hydrated = hydrate(precompiled.toJSON(), {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a document of another version
      debug: () => Promise.resolve(debug as PrecompiledScriptDebug),
    });
    const explained = await hydrated.explainRevert(decodeError(site.id));
    expect(explained.site).toEqual({ id: site.id, key: site.key, detail: site.detail });
    expect(explained.site?.key).toMatch(/^s\.read\(\w+\)#\d+$/);
  });

  test('a key that is not a string is a malformed site, not a missing one', async () => {
    const artifact = compile(SCRIPTS.guard());
    const precompiled = artifact.toPrecompiled();
    const debug = jsonRoundTrip(await precompiled.debug());
    const damaged = withJunkAt(debug, ['sites', '0', 'key'], 7);
    const hydrated = hydrate(precompiled.toJSON(), {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime check is under test
      debug: () => Promise.resolve(damaged as PrecompiledScriptDebug),
    });
    expect(await rejectionsOf(hydrated)).toEqual([
      typeMismatch(
        'the debug data of the precompiled script has a malformed `sites`: the `debug` loader ' +
          "must resolve to what the script's debug() returned at build time",
      ),
    ]);
  });
});

describe('malformed debug data', () => {
  const compiled = compile(SCRIPTS.guard());
  const data = compiled.toPrecompiled().toJSON();
  const loadDebug = (): Promise<PrecompiledScriptDebug> => compiled.toPrecompiled().debug();
  const withDebug = (loaded: unknown): PrecompiledScript =>
    hydrate(data, {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime check is under test
      debug: () => Promise.resolve(loaded as PrecompiledScriptDebug),
    });
  const PANIC = encodeErrorResult({ abi: ERROR_ABI, errorName: 'Panic', args: [0x11n] });

  const MALFORMED_IR = 'has a malformed `ir`';
  const MALFORMED_SITES = 'has a malformed `sites`';

  test.each([
    ['an empty `ir`', (debug: PrecompiledScriptDebug) => ({ ...debug, ir: {} }), MALFORMED_IR],
    [
      'an `ir` with no version',
      (debug: PrecompiledScriptDebug) => ({ ...debug, ir: { ...debug.ir, irVersion: undefined } }),
      MALFORMED_IR,
    ],
    [
      'a statement that is not an object',
      (debug: PrecompiledScriptDebug) => ({ ...debug, ir: { ...debug.ir, body: ['const'] } }),
      MALFORMED_IR,
    ],
    [
      'a loop body that is not a list of statements',
      (debug: PrecompiledScriptDebug) => ({
        ...debug,
        ir: { ...debug.ir, body: [{ k: 'while', header: [], cond: 0, body: null, site: 0 }] },
      }),
      MALFORMED_IR,
    ],
    [
      'a function with no body',
      (debug: PrecompiledScriptDebug) => ({ ...debug, ir: { ...debug.ir, fns: [{ name: 'f' }] } }),
      MALFORMED_IR,
    ],
    [
      'an argument with no type',
      (debug: PrecompiledScriptDebug) => ({
        ...debug,
        ir: { ...debug.ir, args: [{ name: 'x' }, ...debug.ir.args.slice(1)] },
      }),
      MALFORMED_IR,
    ],
    [
      'a tuple argument with no components',
      (debug: PrecompiledScriptDebug) => ({
        ...debug,
        ir: { ...debug.ir, args: [{ name: 'x', type: { type: 'tuple' } }] },
      }),
      MALFORMED_IR,
    ],
    [
      'a null site',
      (debug: PrecompiledScriptDebug) => ({ ...debug, sites: [null] }),
      MALFORMED_SITES,
    ],
    [
      'a hole in the sites',
      (debug: PrecompiledScriptDebug) => ({ ...debug, sites: Array.from({ length: 1 }) }),
      MALFORMED_SITES,
    ],
    [
      'panic codes that are not numbers',
      (debug: PrecompiledScriptDebug) => ({
        ...debug,
        sites: [{ id: 0, kind: 'panic', detail: 'checked add', panicCodes: ['0x11'] }],
      }),
      MALFORMED_SITES,
    ],
    [
      '`sites` as an object',
      (debug: PrecompiledScriptDebug) => ({ ...debug, sites: { 0: debug.sites[0] } }),
      'must hold `ir` and `sites`',
    ],
  ])('%s is a TYPE_MISMATCH that names the part', async (_what, damage, problem) => {
    const script = withDebug(damage(await loadDebug()));
    expect(await rejectionsOf(script, PANIC)).toEqual([
      typeMismatch(
        `the debug data of the precompiled script ${problem}: the \`debug\` loader must resolve ` +
          "to what the script's debug() returned at build time",
      ),
    ]);
  });

  // The check has to cover everything explainRevert reads, and nothing ties the two together
  // but this: junk at every position of real debug data, explained with every payload kind.
  // Debug data without site keys has them computed from its IR, which reads more of it: the
  // same damage is done to a document as evs 0.6.0 wrote it.
  describe.each([
    ['guard', SCRIPTS.guard, withoutSiteKeys],
    ['guard', SCRIPTS.guard, asWritten],
    ['balances', SCRIPTS.balances, withoutSiteKeys],
    ['balances', SCRIPTS.balances, asWritten],
    ['pay', SCRIPTS.pay, withoutSiteKeys],
    ['pay', SCRIPTS.pay, asWritten],
  ])('junk anywhere in the debug data of %s (%o)', (_name, script, format) => {
    const artifact = compile(script());
    const precompiled = artifact.toPrecompiled();
    const payloads = payloadsFor(artifact);
    const JUNK: readonly unknown[] = [undefined, null, 0, 'x', {}, [], [null], [[]]];

    test('is rejected with an EvsTypeError or explained: no other error escapes', async () => {
      const debug = format(jsonRoundTrip(await precompiled.debug()));
      const damages = pathsOf(debug).flatMap((path) => JUNK.map((junk) => ({ path, junk })));
      const outcomes = await Promise.all(
        damages.map(async ({ path, junk }) => {
          const damaged = hydrate(precompiled.toJSON(), {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime check is under test
            debug: () => Promise.resolve(withJunkAt(debug, path, junk) as PrecompiledScriptDebug),
          });
          const settled = await Promise.allSettled(payloads.map((p) => damaged.explainRevert(p)));
          return settled.map((result) => {
            if (result.status === 'fulfilled') return 'explained';
            if (result.reason instanceof EvsTypeError) return 'rejected';
            return `${path.join('.')} = ${JSON.stringify(junk)}: ${String(result.reason)}`;
          });
        }),
      );
      // both occur, and nothing else: the corpus damages what is read and what is not
      expect([...new Set(outcomes.flat())].toSorted()).toEqual(['explained', 'rejected']);
    });
  });
});

// ---------------------------------------------------------------------------
// pairing: the debug data must be the script's own
// ---------------------------------------------------------------------------

describe('the debug data is paired with the script it was written with', () => {
  const QUOTE_ARGS = [
    namedArg('xs', t.array(t.uint256)),
    namedArg('i', t.uint256),
    namedArg('d', t.uint256),
  ] as const;
  // two builds of one script: the second records one more statement before the division
  const quote = compile(
    evscript({ name: 'quote', args: QUOTE_ARGS }, (s, xs, i, d) =>
      s.return({ q: xs.at(i).div(d) }),
    ),
  );
  const quoteEdited = compile(
    evscript({ name: 'quote', args: QUOTE_ARGS }, (s, xs, i, d) =>
      s.return({ q: xs.at(i).add(xs.at(0n)).sub(d).div(d) }),
    ),
  );
  const other = compile(
    evscript({ name: 'other', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ r: a.mod(b) }),
    ),
  );
  const PANIC_DIVISION = encodeErrorResult({ abi: ERROR_ABI, errorName: 'Panic', args: [0x12n] });
  const GIVEN = 'the debug data given to the precompiled script `quote`';
  const NO_ID = 'no id (evs 0.5.0 wrote it)';

  /** The two documents a build step writes for `compiled`. */
  async function documentsOf(compiled: CompiledEvsScript) {
    const precompiled = compiled.toPrecompiled();
    return {
      data: jsonRoundTrip(precompiled.toJSON()),
      debug: jsonRoundTrip(await precompiled.debug()),
    };
  }

  /** The same two documents as evs 0.5.0 wrote them: with no `id`. */
  async function documentsOf050(compiled: CompiledEvsScript) {
    const { data, debug } = await documentsOf(compiled);
    const { id: _dataId, ...legacyData } = data;
    const { id: _debugId, ...legacyDebug } = debug;
    return { data: legacyData, debug: legacyDebug };
  }

  const paired = (data: PrecompiledScriptData, debug: PrecompiledScriptDebug): PrecompiledScript =>
    hydrate(data, { debug: () => Promise.resolve(debug) });

  test.each(CASES)(
    'toPrecompiled() writes one id into both documents: %s',
    async (_label, compiled) => {
      const { data, debug } = await documentsOf(compiled);
      expect(data.id).toMatch(ID);
      expect(debug.id).toBe(data.id);
      // asked again, the artifact gives the same id
      expect(compiled.toPrecompiled().toJSON().id).toBe(data.id);
    },
  );

  test('the id is the compilation’s: the same source and options give the same one', () => {
    const first = compile(SCRIPTS.guard()).toPrecompiled().toJSON();
    const second = compile(SCRIPTS.guard()).toPrecompiled().toJSON();
    expect(second.id).toBe(first.id);
    // so a rebuild of an unchanged script writes the same two files
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test('another script, another build of a script and another target each have their own id', () => {
    const idOf = (compiled: CompiledEvsScript) => compiled.toPrecompiled().toJSON().id;
    const ids = [
      idOf(quote),
      idOf(quoteEdited),
      idOf(other),
      idOf(compile(SCRIPTS.symbol())),
      idOf(compile(SCRIPTS.symbol(), { evmVersion: 'paris' })),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a hydrated script keeps the id of its data, and explains with its own debug data', async () => {
    const { data, debug } = await documentsOf(quoteEdited);
    const script = paired(data, debug);
    expect(script.toJSON().id).toBe(data.id);
    expect((await script.debug()).id).toBe(data.id);
    expect(await script.explainRevert(PANIC_DIVISION)).toStrictEqual(
      quoteEdited.explainRevert(PANIC_DIVISION),
    );
  });

  test('the debug data of another script is rejected, and both scripts are named', async () => {
    const { data } = await documentsOf(quoteEdited);
    const { debug } = await documentsOf(other);
    expect(await rejectionsOf(paired(data, debug), PANIC_DIVISION)).toEqual([
      typeMismatch(
        `${GIVEN} is the one of another script, \`other\`: the debug data has id ${debug.id} ` +
          `and the script's data has id ${data.id}. Pass hydrate() a \`debug\` loader of the ` +
          "debug data written with this script's data",
      ),
    ]);
  });

  test('the debug data of another build of the script is rejected, and both ids are named', async () => {
    const { data } = await documentsOf(quoteEdited);
    const { debug } = await documentsOf(quote);
    expect(debug.ir.name).toBe('quote');
    expect(await rejectionsOf(paired(data, debug), PANIC_DIVISION)).toEqual([
      typeMismatch(
        `${GIVEN} was written by another compilation of it: the debug data has id ${debug.id} ` +
          `and the script's data has id ${data.id}. One compilation writes both: regenerate ` +
          'the two in one run',
      ),
    ]);
  });

  test('the debug data of the same script under other options is another build too', async () => {
    const { data } = await documentsOf(compile(SCRIPTS.symbol()));
    const { debug } = await documentsOf(compile(SCRIPTS.symbol(), { evmVersion: 'paris' }));
    expect(await rejectionsOf(paired(data, debug))).toEqual([
      typeMismatch(
        'the debug data given to the precompiled script `sym` was written by another ' +
          `compilation of it: the debug data has id ${debug.id} and the script's data has id ` +
          `${data.id}. One compilation writes both: regenerate the two in one run`,
      ),
    ]);
  });

  test('a rejected pairing is not kept: the loader runs again on the next call', async () => {
    const { data, debug } = await documentsOf(quoteEdited);
    const stale = (await documentsOf(quote)).debug;
    const load = vi
      .fn<() => Promise<PrecompiledScriptDebug>>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(debug);
    const script = hydrate(data, { debug: load });
    await expect(script.explainRevert(PANIC_DIVISION)).rejects.toThrowError(EvsTypeError);
    expect(await script.explainRevert(PANIC_DIVISION)).toStrictEqual(
      quoteEdited.explainRevert(PANIC_DIVISION),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  describe('documents written by evs 0.5.0, which have no id', () => {
    test('still hydrate, serialize back without one, and explain', async () => {
      const { data, debug } = await documentsOf050(quoteEdited);
      expect(data).not.toHaveProperty('id');
      expect(debug).not.toHaveProperty('id');
      const script = paired(data, debug);
      expect(Object.keys(script.toJSON())).toEqual([
        'version',
        'abi',
        'runtimeBytecode',
        'evmVersion',
      ]);
      expect(script.toViem()).toEqual(quoteEdited.toViem());
      expect(await script.debug()).toBe(debug);
      expect(await script.explainRevert(PANIC_DIVISION)).toStrictEqual(
        quoteEdited.explainRevert(PANIC_DIVISION),
      );
    });

    test('are told apart by the script’s name: the debug data of another script is rejected', async () => {
      const { data } = await documentsOf050(quoteEdited);
      const { debug } = await documentsOf050(other);
      expect(await rejectionsOf(paired(data, debug))).toEqual([
        typeMismatch(
          `${GIVEN} is the one of another script, \`other\`: the debug data has ${NO_ID} and ` +
            `the script's data has ${NO_ID}. Pass hydrate() a \`debug\` loader of the debug ` +
            "data written with this script's data",
        ),
      ]);
    });

    test('carry nothing that tells two builds of one script apart', async () => {
      const { data } = await documentsOf050(quoteEdited);
      const { debug } = await documentsOf050(quote);
      expect(await paired(data, debug).debug()).toBe(debug);
    });

    test('do not pair with a document that has an id: the two come from different builds', async () => {
      const current = await documentsOf(quoteEdited);
      const legacy = await documentsOf050(quoteEdited);
      const REGENERATE = 'One compilation writes both: regenerate the two in one run';
      expect(await rejectionsOf(paired(current.data, legacy.debug))).toEqual([
        typeMismatch(
          `${GIVEN} was written by another compilation of it: the debug data has ${NO_ID} and ` +
            `the script's data has id ${current.data.id}. ${REGENERATE}`,
        ),
      ]);
      expect(await rejectionsOf(paired(legacy.data, current.debug))).toEqual([
        typeMismatch(
          `${GIVEN} was written by another compilation of it: the debug data has id ` +
            `${current.debug.id} and the script's data has ${NO_ID}. ${REGENERATE}`,
        ),
      ]);
    });
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
