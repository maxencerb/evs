/**
 * Unit tests — what a user holds on to across edits and upgrades: the `key` of a warning, of a
 * site and of an explained revert, through `compile()`.
 *
 * Site ids are positions. A statement added above, a dead statement, or a release of evs that
 * records a builder verb with one statement fewer renumbers them, and the filter of an
 * acknowledged warning used to be written on them. Each test here makes the ids move and holds
 * the keys still.
 */

import { erc20Abi, parseAbi, toFunctionSelector } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import type { EvmVersion } from './asm/ops.js';
import { evscript } from './builder/script.js';
import { compile, type CompiledEvsScript, type CompileOptions } from './compile.js';
import type { EvsDiagnostic } from './core/errors.js';
import { t, type Hex } from './core/types.js';
import { interpret } from './ir/interp.js';
import { siteKeysOf } from './ir/site-keys.js';

const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

type Script = Parameters<typeof compile>[0];

function compiledWith(
  script: Script,
  options: CompileOptions = {},
): { compiled: CompiledEvsScript; warnings: EvsDiagnostic[] } {
  const warnings: EvsDiagnostic[] = [];
  const compiled: CompiledEvsScript = compile(script, {
    ...options,
    onDiagnostic: (warning) => warnings.push(warning),
  });
  return { compiled, warnings };
}

/** The site table as a user reads it: what each id is called. */
const keysById = (compiled: CompiledEvsScript): Map<number, string> =>
  new Map(compiled.sourceMap.sites.map((site) => [site.id, site.key]));

/**
 * A loop that reads a `string` (a `LOOP_ALLOCATION`), then a strict read whose empty returndata
 * reverts `EvsDecodeError(site)`. `above` records statements before both: a counter loop, which
 * is what a release of evs changed the recording of, or an unused cell.
 */
function probe(above: 'nothing' | 'a loop' | 'an unused cell') {
  return evscript({ name: 'probe', args: [t.array(t.address), t.uint256] }, (s, tokens, n) => {
    const acc = s.let(t.uint256, 0n);
    if (above === 'a loop') s.for({ from: 0n, until: n }, (i) => acc.set(acc.get().add(i)));
    if (above === 'an unused cell') s.let(t.uint256, 7n);
    s.forEach(tokens, (token) => {
      const symbol = s.read({ address: token, abi: TOKEN_ABI, functionName: 'symbol' });
      acc.set(acc.get().add(symbol.length()));
    });
    const decimals = s.read({ address: tokens.at(0n), abi: TOKEN_ABI, functionName: 'decimals' });
    return s.return({ acc: acc.get(), decimals });
  });
}

/** `symbol()` answers an empty string, `decimals()` answers nothing at all. */
const NO_DECIMALS = {
  staticcall: ({ data }: { data: Hex }) =>
    data.startsWith(toFunctionSelector('function symbol()'))
      ? { success: true, data: `0x${'00'.repeat(31)}20${'00'.repeat(32)}` as Hex }
      : { success: true, data: '0x' as Hex },
};

function decodeRevertOf(script: ReturnType<typeof probe>): Hex {
  const { outcome } = interpret(
    script,
    [['0x00000000000000000000000000000000000000aa'], 3n],
    NO_DECIMALS,
  );
  if (outcome.kind !== 'revert') throw new Error(`expected a revert, got ${outcome.kind}`);
  return outcome.data;
}

describe('a filter on code and key survives what renumbers the sites', () => {
  const base = compiledWith(probe('nothing'));
  const baseWarning = base.warnings.find((w) => w.code === 'LOOP_ALLOCATION');

  test.each(['a loop', 'an unused cell'] as const)(
    '%s above: the site id of the warning moves, its key does not',
    (above) => {
      const edited = compiledWith(probe(above));
      const warning = edited.warnings.find((w) => w.code === 'LOOP_ALLOCATION');
      expect(baseWarning?.key).toBe('s.read(symbol)#0');
      expect(warning?.key).toBe('s.read(symbol)#0');
      expect(warning?.site).not.toBe(baseWarning?.site);
      expect(warning?.message).toBe(baseWarning?.message);

      // the filter a user wrote on the id now lets the warning through; the one on the key holds
      const bySite = (w: EvsDiagnostic): boolean =>
        w.code === 'LOOP_ALLOCATION' && w.site === baseWarning?.site;
      const byKey = (w: EvsDiagnostic): boolean =>
        w.code === 'LOOP_ALLOCATION' && w.key === 's.read(symbol)#0';
      expect(base.warnings.filter((w) => !bySite(w) && w.code === 'LOOP_ALLOCATION')).toEqual([]);
      expect(edited.warnings.filter((w) => !bySite(w) && w.code === 'LOOP_ALLOCATION')).toEqual([
        warning,
      ]);
      expect(edited.warnings.filter((w) => !byKey(w) && w.code === 'LOOP_ALLOCATION')).toEqual([]);
    },
  );

  test.each(['a loop', 'an unused cell'] as const)(
    '%s above: the same failing read reverts with another site number and the same key',
    (above) => {
      const edited = compiledWith(probe(above));
      const baseRevert = decodeRevertOf(probe('nothing'));
      const editedRevert = decodeRevertOf(probe(above));
      // EvsDecodeError(uint256 site): the number in the payload is the position
      expect(editedRevert).not.toBe(baseRevert);
      const before = base.compiled.explainRevert(baseRevert);
      const after = edited.compiled.explainRevert(editedRevert);
      expect(before.kind).toBe('evs-decode');
      expect(before.site?.key).toBe('s.read(decimals)#0');
      expect(after.site?.key).toBe('s.read(decimals)#0');
      expect(after.site?.id).not.toBe(before.site?.id);
      expect(BigInt(`0x${editedRevert.slice(-64)}`)).toBe(BigInt(after.site?.id ?? -1));
      expect(after.site?.detail).toBe(before.site?.detail);
    },
  );

  test('every warning that names a statement names it by a key of the site table', () => {
    for (const above of ['nothing', 'a loop', 'an unused cell'] as const) {
      const { compiled, warnings } = compiledWith(probe(above));
      const keys = keysById(compiled);
      expect(warnings.length).toBeGreaterThan(0);
      for (const warning of warnings) {
        for (const site of warning.sites ?? []) expect(keys.get(site.id)).toBe(site.key);
        expect(warning.site).toBe(warning.sites?.[0]?.id);
      }
    }
  });
});

describe('the keys are a function of the recorded script alone', () => {
  const script = probe('a loop');
  const recorded = siteKeysOf(script.ir);
  const reference = compiledWith(script);

  test.each<[string, CompileOptions]>([
    ['optimize: true', { optimize: true }],
    ['evmVersion: paris', { evmVersion: 'paris' }],
    ['evmVersion: paris, optimize: true', { evmVersion: 'paris', optimize: true }],
  ])('%s: other bytes, same site keys, same warning keys', (_name, options) => {
    const other = compiledWith(script, options);
    expect(other.compiled.runtimeBytecode).not.toBe(reference.compiled.runtimeBytecode);
    expect([...keysById(other.compiled)]).toEqual([...keysById(reference.compiled)]);
    expect(other.warnings.map((w) => [w.code, w.key, w.sites])).toEqual(
      reference.warnings.map((w) => [w.code, w.key, w.sites]),
    );
  });

  test('every emitted site carries the key of its statement in the recorded IR', () => {
    for (const evmVersion of ['paris', 'shanghai', 'cancun'] satisfies EvmVersion[]) {
      for (const optimize of [false, true]) {
        const { compiled } = compiledWith(script, { evmVersion, optimize });
        for (const site of compiled.sourceMap.sites) expect(site.key).toBe(recorded.get(site.id));
      }
    }
  });

  test('a dead statement keeps its place in the count: removing it by hand is the only edit that moves a key', () => {
    // the first sum is never read, so dead-code elimination drops its `add` and its site
    const build = (dead: boolean) =>
      evscript({ name: 'dead', args: [t.uint256, t.uint256] }, (s, a, b) => {
        if (dead) a.add(1n);
        return s.return({ sum: a.add(b) });
      });
    const withDead = compiledWith(build(true)).compiled;
    const without = compiledWith(build(false)).compiled;
    const adds = (compiled: CompiledEvsScript): string[] =>
      compiled.sourceMap.sites.map((site) => site.key).filter((key) => key.startsWith('add#'));
    // one emitted `add` either way: the bytecode is the same …
    expect(withDead.runtimeBytecode).toBe(without.runtimeBytecode);
    // … and the surviving one is still the second `add` the script wrote
    expect(adds(withDead)).toEqual(['add#1']);
    expect(adds(without)).toEqual(['add#0']);
    expect(
      [...siteKeysOf(build(true).ir).values()].filter((key) => key.startsWith('add#')),
    ).toEqual(['add#0', 'add#1']);
  });
});

describe('LOOP_ALLOCATION: a statement the builder records for a verb is reported on that verb', () => {
  const FEED_ABI = parseAbi([
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function getRoundData(uint80 id) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function description() view returns (string)',
    'function meta() view returns (string name, uint8 decimals)',
  ]);
  const Round = t.struct({ roundId: t.uint80, answer: t.int256 });
  const loopWarnings = (script: Script): EvsDiagnostic[] =>
    compiledWith(script).warnings.filter((w) => w.code === 'LOOP_ALLOCATION');
  const summary = (w: EvsDiagnostic | undefined) => ({
    key: w?.key,
    sites: w?.sites?.map((site) => site.key),
  });

  /** A `struct: true` read in a loop; `above` records statements before the loop that each add a
   *  `tuple(uint80,int256,uint256,uint256,uint80)` statement. */
  const feedLoop = (above: 'nothing' | 'another struct read' | 'an s.tuple of the same members') =>
    evscript({ name: 'feeds', args: [t.array(t.address)] }, (s, feeds) => {
      const total = s.let(t.int256, 0n);
      if (above === 'another struct read') {
        const first = s.read({
          address: feeds.at(0n),
          abi: FEED_ABI,
          functionName: 'getRoundData',
          args: [1n],
          struct: true,
        });
        total.set(first.answer.get());
      }
      if (above === 'an s.tuple of the same members') {
        const R = t.fromOutputs(FEED_ABI, 'latestRoundData');
        total.set(s.tuple(R, { answer: 1n }).answer.get());
      }
      s.forEach(feeds, (feed) => {
        const round = s.tryRead({
          address: feed,
          abi: FEED_ABI,
          functionName: 'latestRoundData',
          struct: true,
        });
        total.set(total.get().add(round.value.answer.get()));
      });
      return s.return({ total: total.get() });
    });

  test.each(['another struct read', 'an s.tuple of the same members'] as const)(
    'struct: true: keyed on the call, so %s above moves nothing',
    (above) => {
      const [base, ...extraBase] = loopWarnings(feedLoop('nothing'));
      const [edited, ...extraEdited] = loopWarnings(feedLoop(above));
      expect(extraBase).toEqual([]);
      expect(extraEdited).toEqual([]);
      expect(summary(base)).toEqual({
        key: 's.tryRead(latestRoundData)#0',
        sites: ['tuple(uint80,int256,uint256,uint256,uint80)#0'],
      });
      expect(edited?.key).toBe('s.tryRead(latestRoundData)#0');
      expect(edited?.sites?.map((site) => site.key)).toEqual([
        'tuple(uint80,int256,uint256,uint256,uint80)#1',
      ]);
      expect(edited?.message).toBe(base?.message);
      expect(base?.message).toMatch(/^s\.tryRead\(latestRoundData\) struct \(flat-block/);
    },
  );

  test('struct: true on a call that allocates too: one warning on the call, listing both statements', () => {
    const script = evscript({ name: 'metas', args: [t.array(t.address)] }, (s, tokens) => {
      const n = s.let(t.uint256, 0n);
      s.forEach(tokens, (token) => {
        const m = s.read({ address: token, abi: FEED_ABI, functionName: 'meta', struct: true });
        n.set(n.get().add(m.name.get().length()));
      });
      return s.return({ n: n.get() });
    });
    const warnings = loopWarnings(script);
    expect(warnings.map(summary)).toEqual([
      { key: 's.read(meta)#0', sites: ['s.read(meta)#0', 'tuple(string,uint8)#0'] },
    ]);
    expect(warnings[0]?.site).toBe(warnings[0]?.sites?.[0]?.id);
    expect(warnings[0]?.message).toMatch(
      /^s\.read\(meta\) \(returndata snapshot\) and s\.read\(meta\) struct \(flat-block allocation\) allocate memory on every loop iteration;/,
    );
  });

  /** A struct comparison in a loop, and the user's own `s.encode` after it. */
  const compareLoop = (above: 'nothing' | 'an s.encode', op: 'eq' | 'neq' | '.eq') =>
    evscript(
      { name: 'cmp', args: [t.array(t.uint80), Round, t.array(t.uint256)] },
      (s, ids, wanted, values) => {
        const hits = s.let(t.uint256, 0n);
        if (above === 'an s.encode') hits.set(s.encode(wanted).length());
        s.forEach(ids, (id) => {
          const mine = s.tuple(Round, { roundId: id });
          const same =
            op === 'eq'
              ? s.eq(mine, wanted)
              : op === 'neq'
                ? s.neq(mine, wanted)
                : mine.expr().eq(wanted);
          hits.set(hits.get().add(s.select(same, s.lit(t.uint256, 1n), 0n)));
        });
        const digest = s.keccak256(values);
        return s.return({ hits: hits.get(), digest });
      },
    );

  test.each([
    ['eq', 'eq#0'],
    ['neq', 'neq#0'],
    ['.eq', 'eq#0'],
  ] as const)(
    '%s of two structs: one warning on the comparison, listing both encodings',
    (op, key) => {
      const warnings = loopWarnings(compareLoop('nothing', op));
      expect(warnings.map(summary)).toEqual([
        { key: 'tuple(uint80,int256)#0', sites: ['tuple(uint80,int256)#0'] },
        { key, sites: ['encode#0', 'encode#1'] },
      ]);
      expect(warnings[1]?.message).toMatch(/left operand.* and .*right operand.* allocate memory/);
    },
  );

  test('an s.encode added above moves the encodings and not the key', () => {
    const [, base] = loopWarnings(compareLoop('nothing', 'eq'));
    const [, edited] = loopWarnings(compareLoop('an s.encode', 'eq'));
    expect(base?.key).toBe('eq#0');
    expect(edited?.key).toBe('eq#0');
    expect(edited?.sites?.map((site) => site.key)).toEqual(['encode#1', 'encode#2']);
    expect(edited?.message).toBe(base?.message);
  });

  test('s.keccak256 of values that need an encoding: keyed on the keccak256', () => {
    const script = evscript(
      { name: 'h', args: [t.array(t.uint256), t.address] },
      (s, values, who) => {
        const acc = s.let(t.bytes32, `0x${'00'.repeat(32)}`);
        s.forEach(values, (v) => {
          acc.set(s.keccak256(acc.get(), v, who));
        });
        const own = s.keccak256(s.encode(who, who));
        return s.return({ acc: acc.get(), own });
      },
    );
    expect(loopWarnings(script).map(summary)).toEqual([
      { key: 'keccak256#0', sites: ['encode#0'] },
    ]);
  });
});

describe('ENV_FRAME_DEPENDENT: one warning per thing read from the frame', () => {
  test('six uses, three warnings: each lists its statements', () => {
    const script = evscript({ name: 'f', args: [t.address] }, (s, who) =>
      s.return({
        a: s.env('address'),
        b: s.balance(s.env('address')),
        same: s.env('address').eq(who),
        c1: s.env('caller'),
        c2: s.env('caller').eq(who),
      }),
    );
    const { compiled, warnings } = compiledWith(script);
    expect(warnings.every((w) => w.code === 'ENV_FRAME_DEPENDENT')).toBe(true);
    expect(new Set(warnings.map((w) => w.message)).size).toBe(warnings.length);
    expect(warnings.map((w) => ({ key: w.key, sites: w.sites?.map((site) => site.key) }))).toEqual([
      {
        key: 's.env(address)',
        sites: ['s.env(address)#0', 's.env(address)#1', 's.env(address)#2'],
      },
      { key: 's.balance(s.env(address))', sites: ['s.balance#0'] },
      { key: 's.env(caller)', sites: ['s.env(caller)#0', 's.env(caller)#1'] },
    ]);
    // six statements in all, each one in the site table under that key
    const covered = warnings.flatMap((w) => w.sites ?? []);
    expect(covered).toHaveLength(6);
    const keys = keysById(compiled);
    for (const site of covered) expect(keys.get(site.id)).toBe(site.key);
    for (const w of warnings) expect(w.site).toBe(Math.min(...(w.sites ?? []).map((x) => x.id)));
  });

  test('the key holds when a use is added: one more statement, the same warning', () => {
    const build = (again: boolean) =>
      evscript({ name: 'f', args: [t.address] }, (s, who) =>
        s.return({
          mine: s.env('caller').eq(who),
          ...(again ? { caller: s.env('caller') } : {}),
        }),
      );
    const [one] = compiledWith(build(false)).warnings;
    const [two] = compiledWith(build(true)).warnings;
    expect(one?.key).toBe('s.env(caller)');
    expect(two?.key).toBe('s.env(caller)');
    expect(two?.message).toBe(one?.message);
    expect(one?.sites).toHaveLength(1);
    expect(two?.sites).toHaveLength(2);
  });

  test('a use inside an s.fn is listed under the function: by id, whatever the emission order', () => {
    const script = evscript({ name: 'f', args: [t.address] }, (s, who) => {
      const isCaller = s.fn('isCaller', [t.address], (x) => x.eq(s.env('caller')));
      return s.return({ direct: s.env('caller'), viaFn: isCaller(who) });
    });
    const { warnings } = compiledWith(script);
    expect(warnings.map((w) => w.key)).toEqual(['s.env(caller)']);
    // the fn body was recorded first (lower ids), the script body is walked first
    expect(warnings[0]?.sites?.map((site) => site.key)).toEqual([
      'isCaller/s.env(caller)#0',
      's.env(caller)#0',
    ]);
  });
});

describe('DEPLOYLESS_RESULT_PREFIX: the key is the returned value', () => {
  const shareBps = (unused: boolean) =>
    evscript({ name: 'shareBps', args: [t.address, t.address] }, (s, token, owner) => {
      if (unused) s.let(t.uint256, 7n);
      const supply = s.read({ address: token, abi: erc20Abi, functionName: 'totalSupply' });
      const balance = s.read({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
      const bps = s.let(t.uint256, 0n);
      s.if(supply.gt(0n), () => {
        bps.set(balance.mul(10_000n).div(supply));
      });
      return s.return({ bps: bps.get() });
    });

  test('an unused cell above moves the site and leaves the key', () => {
    const [before] = compiledWith(shareBps(false)).warnings;
    const [after] = compiledWith(shareBps(true)).warnings;
    expect(before?.code).toBe('DEPLOYLESS_RESULT_PREFIX');
    expect(before?.key).toBe('s.return(bps)');
    expect(after?.key).toBe('s.return(bps)');
    expect(after?.site).toBe((before?.site ?? Number.NaN) + 2);
    expect(after?.message).toBe(before?.message);
    expect(after?.message).toContain('filter this warning on its code and key');
  });
});

describe('no message sends a user to the site id', () => {
  test('nothing a compile reports says to filter or acknowledge by site', () => {
    const scripts: Script[] = [probe('a loop'), supplyEcho(), frameReader()];
    const warnings = scripts.flatMap((script) => compiledWith(script).warnings);
    expect(warnings.map((w) => w.code)).toEqual([
      'LOOP_ALLOCATION',
      'DEPLOYLESS_RESULT_PREFIX',
      'DEPLOYLESS_RESULT_PREFIX',
      'ENV_FRAME_DEPENDENT',
      'ENV_FRAME_DEPENDENT',
    ]);
    for (const { message } of warnings) {
      expect(message).not.toMatch(/\b(by|on) its (code and )?site\b/);
      expect(message).not.toContain('site ids');
    }
    // the two codes a user acknowledges one by one say what to filter on
    const hinted = warnings.filter((w) =>
      w.message.includes('filter this warning on its code and key'),
    );
    expect(hinted.map((w) => w.code)).toEqual([
      'LOOP_ALLOCATION',
      'DEPLOYLESS_RESULT_PREFIX',
      'DEPLOYLESS_RESULT_PREFIX',
    ]);
    // and every warning that can be filtered one by one has the key to do it
    for (const warning of warnings) expect(warning.key).toBeTypeOf('string');
  });
});

function supplyEcho(): Script {
  return evscript({ name: 'echo', args: [t.address] }, (s, token) =>
    s.return({ supply: s.read({ address: token, abi: erc20Abi, functionName: 'totalSupply' }) }),
  );
}

function frameReader(): Script {
  return evscript({ name: 'who', args: [] }, (s) =>
    s.return({ me: s.env('caller'), self: s.env('address') }),
  );
}
