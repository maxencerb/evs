/* oxlint-disable typescript/no-unsafe-type-assertion --
 * fixture builders cast hand-assembled (and deliberately malformed) structures on purpose. */
/* oxlint-disable unicorn/no-thenable --
 * the frozen IR schema (module-interfaces.md §M2) names the if-statement branch field `then`. */
/* oxlint-disable vitest/expect-expect --
 * several rejection tests assert exclusively through the reject() helper, which wraps the
 * expect(...).toThrowError(...) pair. */
import { describe, expect, test } from 'vitest';

import { EvsInternalError, EvsTypeError, type SourceLoc } from '../core/errors.js';
import { typeToAbiParam, type EvsType, type Hex, type WordType } from '../core/types.js';
import {
  deserializeIr,
  serializeIr,
  walkStmts,
  type ScriptIr,
  type Stmt,
  type ValueInfo,
} from './nodes.js';

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const LOC: SourceLoc = { file: '/home/dev/app/pools.ts', line: 9, column: 18 };

function mk(body: DistOmit<Stmt, 'loc' | 'site'>, site = 0, loc: SourceLoc | null = null): Stmt {
  return { loc, site, ...body } as Stmt;
}

function vi(type: EvsType, debugName?: string): ValueInfo {
  return debugName === undefined ? { type, loc: null } : { type, loc: LOC, debugName };
}

function ir(p: Partial<ScriptIr>): ScriptIr {
  return {
    irVersion: 1,
    name: 'fixture',
    args: [],
    values: [],
    cells: [],
    fns: [],
    body: [],
    returns: [],
    loc: null,
    ...p,
  };
}

function wordHex(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** [len:32][payload zero-padded to 32] memref hex for a short byte string. */
function dataHex(payload: string): Hex {
  const len = payload.length / 2;
  const padded = payload.padEnd(Math.ceil(len / 32) * 64, '0');
  return `0x${BigInt(len).toString(16).padStart(64, '0')}${padded}`;
}

// ---------------------------------------------------------------------------
// the corpus — every statement kind appears at least once
// ---------------------------------------------------------------------------

const KITCHEN_SINK: ScriptIr = ir({
  name: 'kitchen',
  args: [
    { name: 'a', type: 'uint256' },
    { name: 'flag', type: 'bool' },
    { name: 'tokens', type: 'address[]' },
  ],
  values: [
    vi('uint256', 'a'), // v0 (arg)
    vi('bool', 'flag'), // v1 (arg)
    vi('address[]', 'tokens'), // v2 (arg)
    vi('uint256'), // v3 const 5
    vi('uint256'), // v4 add
    vi('bool'), // v5 not
    vi('address'), // v6 env caller
    vi('uint128'), // v7 convert
    vi('uint256'), // v8 select
    vi('uint256'), // v9 len
    vi('address'), // v10 index
    vi('uint256[]'), // v11 arrnew
    vi('uint256'), // v12 cellget
    vi('uint256'), // v13 call out
    vi('string'), // v14 tryCall out
    vi('bool'), // v15 tryCall successOut
    vi('bytes'), // v16 const data
    vi('uint256'), // v17 fncall out
    vi('uint256'), // v18 if-then const
    vi('uint256'), // v19 if-else const
    vi('uint256'), // v20 while-header cellget
    vi('bool'), // v21 while cond
    vi('bool'), // v22 eq
    vi('uint256'), // v23 bitand
    vi('uint256'), // v24 shl
    vi('uint256', 'x'), // v25 fn param
    vi('uint256'), // v26 fn body add
  ],
  cells: [{ type: 'uint256', loc: LOC, debugName: 'acc' }],
  fns: [
    {
      name: 'double',
      params: [{ name: 'x', type: 'uint256', value: 25 }],
      results: [{ type: 'uint256' }],
      body: [mk({ k: 'bin', op: 'add', a: 25, b: 25, out: 26 }, 20)],
      resultValues: [26],
      loc: LOC,
    },
  ],
  body: [
    mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(5n) }, type: 'uint256' }, 1, LOC),
    mk({ k: 'bin', op: 'add', a: 0, b: 3, out: 4 }, 2),
    mk({ k: 'un', op: 'not', a: 1, out: 5 }, 3),
    mk({ k: 'env', op: 'caller', out: 6 }, 4),
    mk({ k: 'convert', a: 4, out: 7 }, 5),
    mk({ k: 'select', cond: 1, a: 4, b: 3, out: 8 }, 6),
    mk({ k: 'len', a: 2, out: 9 }, 7),
    mk({ k: 'index', arr: 2, i: 3, out: 10 }, 8),
    mk({ k: 'arrnew', elem: 'uint256', length: 9, out: 11 }, 9),
    mk({ k: 'arrset', arr: 11, i: 3, value: 4 }, 10),
    mk({ k: 'cellnew', cell: 0, init: 4 }, 11),
    mk({ k: 'cellget', cell: 0, out: 12 }, 12),
    mk({ k: 'cellset', cell: 0, value: 12 }, 13),
    mk(
      {
        k: 'call',
        target: 6,
        fnAbi: {
          name: 'balanceOf',
          selector: '0x70a08231',
          inputs: [{ name: 'owner', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
        args: [10],
        outs: [13],
        mode: 'strict',
        gas: 4,
      },
      14,
      LOC,
    ),
    mk(
      {
        k: 'call',
        target: 10,
        fnAbi: {
          name: 'symbol',
          selector: '0x95d89b41',
          inputs: [],
          outputs: [{ name: '', type: 'string' }],
        },
        args: [],
        outs: [14],
        mode: 'try',
        successOut: 15,
      },
      15,
    ),
    mk({ k: 'const', out: 16, data: { kind: 'data', hex: dataHex('abcdef') }, type: 'bytes' }, 16),
    mk({ k: 'fncall', fn: 0, args: [4], outs: [17] }, 17),
    mk(
      {
        k: 'if',
        cond: 1,
        then: [
          mk({ k: 'const', out: 18, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint256' }),
        ],
        else: [
          mk({ k: 'const', out: 19, data: { kind: 'word', hex: wordHex(2n) }, type: 'uint256' }),
        ],
      },
      18,
    ),
    mk(
      {
        k: 'while',
        header: [
          mk({ k: 'cellget', cell: 0, out: 20 }),
          mk({ k: 'bin', op: 'lt', a: 20, b: 4, out: 21 }),
        ],
        cond: 21,
        body: [
          mk({ k: 'cellset', cell: 0, value: 12 }),
          mk({ k: 'if', cond: 21, then: [mk({ k: 'break' })], else: [mk({ k: 'continue' })] }),
        ],
      },
      19,
    ),
    mk({ k: 'bin', op: 'eq', a: 6, b: 10, out: 22 }, 20),
    mk({ k: 'bin', op: 'bitand', a: 4, b: 3, out: 23 }, 21),
    mk({ k: 'bin', op: 'shl', a: 23, b: 3, out: 24 }, 22),
  ],
  returns: [
    { name: 'sum', type: 'uint256', value: 4 },
    { name: 'sym', type: 'string', value: 14 },
    { name: 'arr', type: 'uint256[]', value: 11 },
  ],
  loc: LOC,
});

/** small IRs that exercise corners the kitchen sink does not. */
const CORPUS: readonly [string, ScriptIr][] = [
  ['kitchen sink', KITCHEN_SINK],
  ['empty script', ir({})],
  [
    'unary + env variants',
    ir({
      values: [vi('uint256'), vi('uint256'), vi('bool'), vi('uint256'), vi('uint256')],
      body: [
        mk({ k: 'env', op: 'timestamp', out: 0 }),
        mk({ k: 'env', op: 'blocknumber', out: 1 }),
        mk({ k: 'un', op: 'iszero', a: 0, out: 2 }),
        mk({ k: 'un', op: 'bitnot', a: 1, out: 3 }),
        mk({ k: 'env', op: 'chainid', out: 4 }),
      ],
    }),
  ],
  [
    'array const + locs',
    ir({
      values: [vi('uint24[]', 'fees')],
      body: [
        mk(
          {
            k: 'const',
            out: 0,
            data: { kind: 'data', hex: dataHex(wordHex(100n).slice(2) + wordHex(500n).slice(2)) },
            type: 'uint24[]',
          },
          7,
          LOC,
        ),
      ],
      loc: { file: 'b.ts', line: 1, column: 1 },
    }),
  ],
];

// ---------------------------------------------------------------------------
// round trips
// ---------------------------------------------------------------------------

describe('serializeIr / deserializeIr round trip', () => {
  test.each(CORPUS)('%s deep-equals after a round trip', (_name, fixture) => {
    const json = serializeIr(fixture);
    const back = deserializeIr(json);
    expect(back).toEqual(fixture);
    // and re-serialization is byte-stable
    expect(serializeIr(back)).toBe(json);
  });

  test('output is valid JSON', () => {
    const parsed: unknown = JSON.parse(serializeIr(KITCHEN_SINK));
    expect(parsed).toBeTypeOf('object');
  });

  test('deserializeIr deep-freezes the result', () => {
    const back = deserializeIr(serializeIr(KITCHEN_SINK));
    expect(Object.isFrozen(back)).toBe(true);
    expect(Object.isFrozen(back.body)).toBe(true);
    expect(Object.isFrozen(back.body[0])).toBe(true);
    expect(Object.isFrozen(back.values[0])).toBe(true);
    const callStmt = back.body[13];
    expect(callStmt?.k).toBe('call');
    const fnAbi = callStmt !== undefined && callStmt.k === 'call' ? callStmt.fnAbi : undefined;
    expect(Object.isFrozen(fnAbi?.inputs[0])).toBe(true);
  });

  test('serialization is independent of property insertion order', () => {
    const a = ir({
      values: [vi('uint256')],
      body: [
        {
          loc: null,
          site: 3,
          k: 'const',
          out: 0,
          data: { kind: 'word', hex: wordHex(1n) },
          type: 'uint256',
        } as Stmt,
      ],
    });
    const reordered = {
      loc: null,
      returns: [],
      body: [
        {
          type: 'uint256',
          data: { hex: wordHex(1n), kind: 'word' },
          out: 0,
          k: 'const',
          site: 3,
          loc: null,
        } as Stmt,
      ],
      fns: [],
      cells: [],
      values: [vi('uint256')],
      args: [],
      name: 'fixture',
      irVersion: 1,
    } as ScriptIr;
    expect(serializeIr(reordered)).toBe(serializeIr(a));
  });

  test('undefined-valued optional properties are omitted', () => {
    const explicit = ir({
      values: [{ type: 'uint256', loc: null, debugName: undefined } as unknown as ValueInfo],
    });
    const implicit = ir({ values: [{ type: 'uint256', loc: null }] });
    expect(serializeIr(explicit)).toBe(serializeIr(implicit));
    expect(serializeIr(explicit)).not.toContain('debugName');
  });

  test('serializeIr throws EvsInternalError on non-JSON-safe values', () => {
    const poisoned = ir({
      values: [{ type: 'uint256', loc: null, debugName: 5n as unknown as string }],
    });
    expect(() => serializeIr(poisoned)).toThrowError(EvsInternalError);
    expect(() => serializeIr(poisoned)).toThrowError(/bigint/);
  });
});

// ---------------------------------------------------------------------------
// seeded property test — random structurally-valid IRs survive the round trip
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(seed: number): {
  int: (max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  bool: () => boolean;
} {
  const rnd = mulberry32(seed);
  const int = (max: number) => Math.floor(rnd() * max);
  return {
    int,
    pick: (items) => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error('pick on empty list');
      return item;
    },
    bool: () => rnd() < 0.5,
  };
}

type Gen = ReturnType<typeof makeGen>;

const GEN_TYPES: readonly EvsType[] = [
  'uint256',
  'uint8',
  'int24',
  'int256',
  'address',
  'bool',
  'bytes4',
  'bytes32',
  'string',
  'bytes',
  'address[]',
  'uint128[]',
  // a tuple descriptor — exercises serialize/deserialize round-trip through composite types
  {
    type: 'tuple',
    components: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'address' },
    ],
  },
];
const GEN_WORDS: readonly WordType[] = ['uint256', 'int128', 'address', 'bool', 'bytes32'];

function genLoc(g: Gen): SourceLoc | null {
  return g.bool() ? null : { file: `f${g.int(5)}.ts`, line: g.int(500), column: g.int(120) };
}

function genHex(g: Gen, bytes: number): Hex {
  let s = '';
  for (let i = 0; i < bytes; i++) s += g.int(256).toString(16).padStart(2, '0');
  return `0x${s}`;
}

function genStmt(g: Gen, depth: number): Stmt {
  const id = () => g.int(12);
  const kinds = [
    'const',
    'bin',
    'un',
    'env',
    'convert',
    'select',
    'index',
    'len',
    'arrnew',
    'arrset',
    'cellnew',
    'cellget',
    'cellset',
    'call',
    'fncall',
    'break',
    'continue',
    ...(depth > 0 ? (['if', 'while'] as const) : []),
  ] as const;
  const k = g.pick(kinds);
  const loc = genLoc(g);
  const site = g.int(64);
  switch (k) {
    case 'const':
      return mk(
        g.bool()
          ? { k, out: id(), data: { kind: 'word', hex: genHex(g, 32) }, type: g.pick(GEN_TYPES) }
          : { k, out: id(), data: { kind: 'data', hex: genHex(g, 32 + g.int(64)) }, type: 'bytes' },
        site,
        loc,
      );
    case 'bin':
      return mk(
        {
          k,
          op: g.pick(['add', 'sub', 'eq', 'shl', 'bitor'] as const),
          a: id(),
          b: id(),
          out: id(),
        },
        site,
        loc,
      );
    case 'un':
      return mk(
        { k, op: g.pick(['not', 'bitnot', 'iszero'] as const), a: id(), out: id() },
        site,
        loc,
      );
    case 'env':
      return mk(
        {
          k,
          op: g.pick(['address', 'caller', 'timestamp', 'blocknumber', 'chainid'] as const),
          out: id(),
        },
        site,
        loc,
      );
    case 'convert':
      return mk({ k, a: id(), out: id() }, site, loc);
    case 'select':
      return mk({ k, cond: id(), a: id(), b: id(), out: id() }, site, loc);
    case 'index':
      return mk({ k, arr: id(), i: id(), out: id() }, site, loc);
    case 'len':
      return mk({ k, a: id(), out: id() }, site, loc);
    case 'arrnew':
      return mk({ k, elem: g.pick(GEN_WORDS), length: id(), out: id() }, site, loc);
    case 'arrset':
      return mk({ k, arr: id(), i: id(), value: id() }, site, loc);
    case 'cellnew':
      return mk({ k, cell: g.int(4), init: id() }, site, loc);
    case 'cellget':
      return mk({ k, cell: g.int(4), out: id() }, site, loc);
    case 'cellset':
      return mk({ k, cell: g.int(4), value: id() }, site, loc);
    case 'call': {
      const nIn = g.int(3);
      const nOut = g.int(3);
      const mode = g.bool() ? ('strict' as const) : ('try' as const);
      return mk(
        {
          k,
          target: id(),
          fnAbi: {
            name: `fn${g.int(10)}`,
            selector: genHex(g, 4),
            inputs: Array.from({ length: nIn }, (_, i) =>
              typeToAbiParam(`p${i}`, g.pick(GEN_TYPES)),
            ),
            outputs: Array.from({ length: nOut }, (_, i) =>
              typeToAbiParam(`o${i}`, g.pick(GEN_TYPES)),
            ),
          },
          args: Array.from({ length: nIn }, id),
          outs: Array.from({ length: nOut }, id),
          mode,
          ...(mode === 'try' ? { successOut: id() } : {}),
          ...(g.bool() ? { gas: id() } : {}),
        },
        site,
        loc,
      );
    }
    case 'fncall':
      return mk(
        {
          k,
          fn: g.int(3),
          args: Array.from({ length: g.int(3) }, id),
          outs: Array.from({ length: g.int(3) }, id),
        },
        site,
        loc,
      );
    case 'if':
      return mk(
        { k, cond: id(), then: genBlock(g, depth - 1), else: genBlock(g, depth - 1) },
        site,
        loc,
      );
    case 'while':
      return mk(
        { k, header: genBlock(g, depth - 1), cond: id(), body: genBlock(g, depth - 1) },
        site,
        loc,
      );
    case 'break':
    case 'continue':
    default:
      return mk({ k: k === 'continue' ? ('continue' as const) : ('break' as const) }, site, loc);
  }
}

function genBlock(g: Gen, depth: number): Stmt[] {
  return Array.from({ length: g.int(4) }, () => genStmt(g, depth));
}

function genIr(seed: number): ScriptIr {
  const g = makeGen(seed);
  return ir({
    name: `script_${seed}`,
    args: Array.from({ length: g.int(4) }, (_, i) => ({ name: `a${i}`, type: g.pick(GEN_TYPES) })),
    values: Array.from({ length: 12 }, () =>
      g.bool() ? vi(g.pick(GEN_TYPES)) : vi(g.pick(GEN_TYPES), `v${g.int(40)}`),
    ),
    cells: Array.from({ length: g.int(4) }, () => ({ type: g.pick(GEN_TYPES), loc: genLoc(g) })),
    fns: Array.from({ length: g.int(3) }, (_, f) => ({
      name: `fn${f}`,
      params: Array.from({ length: g.int(3) }, (_p, i) => ({
        name: `p${i}`,
        type: g.pick(GEN_TYPES),
        value: g.int(12),
      })),
      results: Array.from({ length: g.int(3) }, () => ({ type: g.pick(GEN_TYPES) })),
      body: genBlock(g, 1),
      resultValues: Array.from({ length: g.int(3) }, () => g.int(12)),
      loc: genLoc(g),
    })),
    body: genBlock(g, 2),
    returns: Array.from({ length: g.int(3) }, (_, i) => ({
      name: `r${i}`,
      type: g.pick(GEN_TYPES),
      value: g.int(12),
    })),
    loc: genLoc(g),
  });
}

describe('round-trip property test (seeded)', () => {
  test('serialize → deserialize → serialize is the identity on 40 random IRs', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const fixture = genIr(seed);
      const json = serializeIr(fixture);
      const back = deserializeIr(json);
      expect(back, `seed ${seed}`).toEqual(fixture);
      expect(serializeIr(back), `seed ${seed}`).toBe(json);
    }
  });
});

// ---------------------------------------------------------------------------
// deserializeIr — shape + version rejection
// ---------------------------------------------------------------------------

describe('deserializeIr rejections', () => {
  function reject(mutate: (raw: Record<string, any>) => void, msg: RegExp): void {
    const raw: Record<string, any> = JSON.parse(serializeIr(KITCHEN_SINK));
    mutate(raw);
    const json = JSON.stringify(raw);
    expect(() => deserializeIr(json)).toThrowError(EvsTypeError);
    expect(() => deserializeIr(json)).toThrowError(msg);
  }

  test('rejects non-JSON input', () => {
    expect(() => deserializeIr('{nope')).toThrowError(EvsTypeError);
    expect(() => deserializeIr('{nope')).toThrowError(/not valid JSON/);
  });

  test('rejects non-object roots', () => {
    for (const bad of ['null', '42', '"x"', '[1,2]']) {
      expect(() => deserializeIr(bad)).toThrowError(EvsTypeError);
    }
  });

  test('rejects wrong or missing irVersion', () => {
    reject((r) => (r['irVersion'] = 2), /irVersion/);
    reject((r) => (r['irVersion'] = '1'), /irVersion/);
    reject((r) => delete r['irVersion'], /irVersion/);
  });

  test('rejects missing/malformed top-level fields', () => {
    reject((r) => delete r['name'], /ir\.name/);
    reject((r) => (r['name'] = 7), /ir\.name/);
    reject((r) => (r['args'] = {}), /ir\.args/);
    reject((r) => delete r['values'], /ir\.values/);
    reject((r) => (r['cells'] = 'x'), /ir\.cells/);
    reject((r) => (r['fns'] = null), /ir\.fns/);
    reject((r) => (r['body'] = 3), /ir\.body/);
    reject((r) => delete r['returns'], /ir\.returns/);
    reject((r) => (r['loc'] = 5), /ir\.loc/);
  });

  test('rejects malformed locs', () => {
    reject((r) => (r['loc'] = { file: 'a.ts', line: -1, column: 0 }), /loc\.line/);
    reject((r) => (r['loc'] = { file: 'a.ts', line: 1.5, column: 0 }), /loc\.line/);
    reject((r) => (r['loc'] = { file: 9, line: 1, column: 0 }), /loc\.file/);
    reject((r) => (r['loc'] = { file: 'a.ts', line: 1 }), /loc\.column/);
  });

  test('rejects malformed value/cell infos', () => {
    reject((r) => (r['values'][0] = { loc: null }), /values\[0\]\.type/);
    reject((r) => (r['values'][0]['type'] = 'uint7'), /values\[0\]\.type/);
    reject((r) => (r['values'][0]['type'] = 'tuple'), /values\[0\]\.type/); // bare 'tuple' string (needs the object form)
    reject((r) => (r['values'][0]['debugName'] = 4), /debugName/);
    reject((r) => (r['cells'][0]['type'] = 'uint8[5]'), /cells\[0\]\.type/); // fixed-size array still invalid
  });

  test('rejects malformed args and returns', () => {
    reject((r) => (r['args'][0] = { name: 'a' }), /args\[0\]\.type/);
    reject((r) => (r['args'][0]['name'] = 3), /args\[0\]\.name/);
    reject((r) => (r['returns'][0]['value'] = -1), /returns\[0\]\.value/);
    reject((r) => (r['returns'][0]['value'] = 1.5), /returns\[0\]\.value/);
    reject((r) => (r['returns'][0]['type'] = 'uint257'), /returns\[0\]\.type/);
  });

  test('rejects malformed fns', () => {
    reject((r) => (r['fns'][0]['params'][0]['value'] = 'x'), /fns\[0\]\.params\[0\]\.value/);
    reject((r) => (r['fns'][0]['results'][0] = { type: 'tuple' }), /fns\[0\]\.results\[0\]\.type/);
    reject((r) => (r['fns'][0]['resultValues'] = [null]), /fns\[0\]\.resultValues\[0\]/);
    reject((r) => delete r['fns'][0]['body'], /fns\[0\]\.body/);
  });

  test('rejects unknown statement kinds and ops', () => {
    reject((r) => (r['body'][0]['k'] = 'frobnicate'), /unknown statement kind/);
    reject((r) => delete r['body'][0]['k'], /\.k/);
    reject((r) => (r['body'][1]['op'] = 'pow'), /unknown bin op/);
    reject((r) => (r['body'][2]['op'] = 'neg'), /unknown un op/);
    reject((r) => (r['body'][3]['op'] = 'basefee'), /unknown env op/);
  });

  test('rejects malformed statement fields', () => {
    reject((r) => (r['body'][0]['site'] = -3), /site/);
    reject((r) => (r['body'][0]['out'] = 1.2), /\.out/);
    reject((r) => (r['body'][0]['data'] = { kind: 'words', hex: '0x00' }), /data\.kind/);
    reject((r) => (r['body'][0]['data']['hex'] = '0x123'), /hex/); // odd length
    reject((r) => (r['body'][0]['data']['hex'] = '0xzz'), /hex/);
    reject((r) => (r['body'][8]['elem'] = 'uint7'), /elem/); // arrnew elem must be a valid type
    reject((r) => (r['body'][13]['mode'] = 'maybe'), /mode/);
    reject((r) => (r['body'][13]['fnAbi']['selector'] = 5), /selector/);
    reject((r) => (r['body'][13]['args'] = [0, 'x']), /args\[1\]/);
    reject((r) => (r['body'][17]['then'] = {}), /then/);
    reject((r) => (r['body'][18]['header'] = null), /header/);
  });

  test('rejects malformed nested statements with their JSON path in the message', () => {
    reject((r) => (r['body'][17]['then'][0]['out'] = null), /body\[17\]\.then\[0\]\.out/);
    reject(
      (r) => (r['body'][18]['body'][1]['then'][0]['k'] = 'jump'),
      /body\[18\]\.body\[1\]\.then\[0\]/,
    );
  });

  test('treats an absent loc as null', () => {
    const raw: Record<string, any> = JSON.parse(serializeIr(KITCHEN_SINK));
    delete raw['body'][1]['loc'];
    const back = deserializeIr(JSON.stringify(raw));
    expect(back.body[1]?.loc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// walkStmts
// ---------------------------------------------------------------------------

describe('walkStmts', () => {
  test('visits depth-first pre-order with disambiguated paths', () => {
    const stmts: Stmt[] = [
      mk({ k: 'env', op: 'caller', out: 0 }),
      mk({
        k: 'if',
        cond: 0,
        then: [mk({ k: 'break' }), mk({ k: 'continue' })],
        else: [
          mk({
            k: 'while',
            header: [mk({ k: 'env', op: 'chainid', out: 1 })],
            cond: 1,
            body: [mk({ k: 'break' })],
          }),
        ],
      }),
      mk({ k: 'env', op: 'timestamp', out: 2 }),
    ];
    const visited: [string, readonly number[]][] = [];
    walkStmts(stmts, (s, path) => visited.push([s.k, path]));
    expect(visited).toEqual([
      ['env', [0]],
      ['if', [1]],
      ['break', [1, 0, 0]],
      ['continue', [1, 0, 1]],
      ['while', [1, 1, 0]],
      ['env', [1, 1, 0, 0, 0]],
      ['break', [1, 1, 0, 1, 0]],
      ['env', [2]],
    ]);
  });

  test('walks an empty list without visiting', () => {
    let count = 0;
    walkStmts([], () => {
      count += 1;
    });
    expect(count).toBe(0);
  });

  test('visits every statement of the kitchen sink exactly once, parents before children', () => {
    const paths: string[] = [];
    walkStmts(KITCHEN_SINK.body, (_s, path) => paths.push(path.join('.')));
    expect(new Set(paths).size).toBe(paths.length); // unique paths
    // a child path always appears after its parent
    const violations = paths.filter((p) => {
      const parts = p.split('.');
      if (parts.length <= 2) return false;
      const parent = parts.slice(0, -2).join('.');
      return paths.indexOf(parent) >= paths.indexOf(p);
    });
    expect(violations).toEqual([]);
  });
});
