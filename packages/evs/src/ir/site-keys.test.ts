/* oxlint-disable unicorn/no-thenable --
   an `if` statement of the IR has a `then` block */
/**
 * Unit tests — statement keys (`ir/site-keys.ts`): the label of every statement kind, the key
 * table of one realistic script, and what moves a key and what does not.
 *
 * The texts pinned here are public: users store them in the filters of their acknowledged
 * warnings. A change that makes one of these tests fail is a breaking change of the library,
 * whatever caused it (a label, the count, or a builder verb that records other statements).
 */

import { parseAbi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { evscript } from '../builder/script.js';
import { namedArg, t } from '../core/types.js';
import { walkStmts, type ScriptIr, type Stmt } from './nodes.js';
import { siteKeysOf, siteLabel } from './site-keys.js';

const VAULT_ABI = parseAbi([
  'function asset() view returns (address)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function reserves(address pool) view returns (uint112 r0, uint112 r1)',
  'function quote(uint256 amountIn) returns (uint256 amountOut)',
  'function deposit(address to) payable returns (uint256 shares)',
]);

const Position = t.struct({ shares: t.uint256, value: t.uint256 });
const Stale = t.error('Stale', [namedArg('vault', t.address)]);

/** A script shaped like the ones apps write: reads in a loop, an `s.fn`, a guard, a struct. */
function portfolio(edit: { unrelatedAbove?: boolean; sameLabelAbove?: boolean } = {}) {
  return evscript(
    {
      name: 'portfolio',
      args: [
        namedArg('vaults', t.array(t.address)),
        namedArg('owner', t.address),
        namedArg('minValue', t.uint256),
      ],
      errors: [Stale],
    },
    (s, vaults, owner, minValue) => {
      if (edit.unrelatedAbove === true) s.let(t.bool, false).set(owner.eq(s.env('caller')));
      if (edit.sameLabelAbove === true) {
        s.read({ address: owner, abi: VAULT_ABI, functionName: 'decimals' });
      }
      const valueOf = s.fn('valueOf', [t.address, t.uint256], (vault, shares) => {
        const quoted = s.tryCall({
          address: vault,
          abi: VAULT_ABI,
          functionName: 'quote',
          args: [shares],
        });
        return s.select(quoted.success, quoted.value, 0n);
      });
      const total = s.let(t.uint256, 0n);
      const positions = s.newArray(Position, vaults.length());
      s.forEach(vaults, (vault, i) => {
        const symbol = s.read({ address: vault, abi: VAULT_ABI, functionName: 'symbol' });
        const shares = s.read({
          address: vault,
          abi: VAULT_ABI,
          functionName: 'balanceOf',
          args: [owner],
        });
        const value = valueOf(vault, shares);
        s.if(symbol.length().eq(0n), () => s.throw(Stale, { vault }));
        positions.set(i, s.tuple(Position, { shares, value }));
        total.set(total.get().add(value));
      });
      const first = vaults.at(0n);
      const decimals = s.read({ address: first, abi: VAULT_ABI, functionName: 'decimals' });
      const reserves = s.read({
        address: first,
        abi: VAULT_ABI,
        functionName: 'reserves',
        args: [first],
        struct: true,
      });
      const scale = s.lit(t.uint256, 10n).pow(decimals.toUint(t.uint256));
      return s.return({
        enough: total.get().gte(minValue),
        total: total.get(),
        scaled: s.mulDiv(total.get(), scale, reserves.r0.get().toUint(t.uint256).add(1n)),
        id: s.keccak256(s.encodePacked(owner, s.env('chainid'))),
        positions,
      });
    },
  );
}

/** The key of every statement of `ir`, in the order the keys are counted. */
function keyTable(ir: ScriptIr): string[] {
  const keys = siteKeysOf(ir);
  const table: string[] = [];
  const list = (stmts: readonly Stmt[]): void => {
    walkStmts(stmts, (s) => table.push(keys.get(s.site) ?? `no key for site ${s.site}`));
  };
  list(ir.body);
  for (const fn of ir.fns) list(fn.body);
  return table;
}

describe('siteLabel: the label of every statement kind', () => {
  const ir: ScriptIr = {
    irVersion: 1,
    name: 'labels',
    args: [],
    values: [
      { type: 'uint256' },
      { type: 'string' },
      {
        type: {
          type: 'tuple',
          components: [
            { name: 'a', type: 'uint112' },
            { name: 'b', type: 'address[]' },
          ],
        },
      },
      { type: 'address[]' },
    ],
    cells: [{ type: 'uint256' }],
    fns: [{ name: 'quote', params: [], results: [], body: [], resultValues: [] }],
    body: [],
    returns: [],
    errors: [{ name: 'Stale', selector: '0x00000000', inputs: [] }],
  };
  const fnAbi = { name: 'balanceOf', selector: '0x70a08231', inputs: [], outputs: [] } as const;
  const call = { k: 'call', site: 0, target: 0, fnAbi, args: [], outs: [] } as const;
  const word = { kind: 'word', hex: '0x00' } as const;

  // one row per statement kind (and per variant that changes the label), with the full text
  test.each<[string, Stmt]>([
    ['s.read(balanceOf)', { ...call, mode: 'strict' }],
    ['s.read(balanceOf)', { ...call, mode: 'strict', kind: 'static' }],
    ['s.tryRead(balanceOf)', { ...call, mode: 'try' }],
    ['s.call(balanceOf)', { ...call, mode: 'strict', kind: 'call' }],
    ['s.tryCall(balanceOf)', { ...call, mode: 'try', kind: 'call' }],
    ['s.simulate(balanceOf)', { ...call, mode: 'strict', kind: 'simulate' }],
    ['s.trySimulate(balanceOf)', { ...call, mode: 'try', kind: 'simulate' }],
    // options do not rename a call: a `value`, a gas cap and `revertReturns` are the same verb
    ['s.call(balanceOf)', { ...call, mode: 'strict', kind: 'call', value: 0, gas: 0 }],
    ['s.call(balanceOf)', { ...call, mode: 'strict', kind: 'call', revertReturns: ['uint256'] }],
    ['quote()', { k: 'fncall', site: 0, fn: 0, args: [], outs: [] }],
    ['s.env(caller)', { k: 'env', site: 0, op: 'caller', out: 0 }],
    ['s.env(address)', { k: 'env', site: 0, op: 'address', out: 0 }],
    ['s.env(timestamp)', { k: 'env', site: 0, op: 'timestamp', out: 0 }],
    ['s.env(blocknumber)', { k: 'env', site: 0, op: 'blocknumber', out: 0 }],
    ['s.env(chainid)', { k: 'env', site: 0, op: 'chainid', out: 0 }],
    ['s.balance', { k: 'account', site: 0, op: 'balance', a: 0, out: 0 }],
    ['s.codeSize', { k: 'account', site: 0, op: 'codesize', a: 0, out: 0 }],
    ['s.codeHash', { k: 'account', site: 0, op: 'codehash', a: 0, out: 0 }],
    ['s.throw(Stale)', { k: 'throw', site: 0, error: 0, args: [] }],
    ['literal(uint256)', { k: 'const', site: 0, out: 0, data: word, type: 'uint256' }],
    ['literal(string)', { k: 'const', site: 0, out: 1, data: word, type: 'string' }],
    ['literal(address[])', { k: 'const', site: 0, out: 3, data: word, type: 'address[]' }],
    ['array(address[])', { k: 'arrnew', site: 0, elem: 'address', length: 0, out: 3 }],
    ['array(address[3])', { k: 'arrnew', site: 0, elem: 'address', length: 0, fixed: 3, out: 3 }],
    ['array(uint256[][])', { k: 'arrnew', site: 0, elem: 'uint256[]', length: 0, out: 3 }],
    ['tuple(uint112,address[])', { k: 'tuplenew', site: 0, inits: [], out: 2 }],
    ['convert(uint256)', { k: 'convert', site: 0, a: 1, out: 0 }],
    ['convert(string)', { k: 'convert', site: 0, a: 0, out: 1, wrap: true }],
    ['encode', { k: 'encode', site: 0, mode: 'abi', args: [], out: 1 }],
    ['encodePacked', { k: 'encode', site: 0, mode: 'packed', args: [], out: 1 }],
    ['add', { k: 'bin', site: 0, op: 'add', a: 0, b: 0, out: 0 }],
    ['wrapadd', { k: 'bin', site: 0, op: 'wrapadd', a: 0, b: 0, out: 0 }],
    ['lte', { k: 'bin', site: 0, op: 'lte', a: 0, b: 0, out: 0 }],
    ['iszero', { k: 'un', site: 0, op: 'iszero', a: 0, out: 0 }],
    ['muldivup', { k: 'modarith', site: 0, op: 'muldivup', a: 0, b: 0, n: 0, out: 0 }],
    ['select', { k: 'select', site: 0, cond: 0, a: 0, b: 0, out: 0 }],
    ['index', { k: 'index', site: 0, arr: 3, i: 0, out: 0 }],
    ['len', { k: 'len', site: 0, a: 3, out: 0 }],
    ['slice', { k: 'slice', site: 0, a: 1, start: 0, end: 0, out: 1 }],
    ['arrset', { k: 'arrset', site: 0, arr: 3, i: 0, value: 0 }],
    ['field', { k: 'field', site: 0, tuple: 2, index: 0, out: 0 }],
    ['tupleset', { k: 'tupleset', site: 0, tuple: 2, index: 0, value: 0 }],
    ['keccak256', { k: 'keccak256', site: 0, a: 1, out: 0 }],
    ['cellnew', { k: 'cellnew', site: 0, cell: 0, init: 0 }],
    ['cellget', { k: 'cellget', site: 0, cell: 0, out: 0 }],
    ['cellset', { k: 'cellset', site: 0, cell: 0, value: 0 }],
    ['if', { k: 'if', site: 0, cond: 0, then: [], else: [] }],
    ['while', { k: 'while', site: 0, header: [], cond: 0, body: [] }],
    ['break', { k: 'break', site: 0 }],
    ['continue', { k: 'continue', site: 0 }],
  ])('%s', (label, stmt) => {
    expect(siteLabel(stmt, ir)).toBe(label);
  });

  test('a debugName never reaches a label', () => {
    const named: ScriptIr = {
      ...ir,
      values: ir.values.map((value) => ({ ...value, debugName: 'renamed by the builder' })),
    };
    const stmts: readonly Stmt[] = [
      { ...call, mode: 'strict' },
      { k: 'tuplenew', site: 0, inits: [], out: 2 },
      { k: 'arrnew', site: 0, elem: 'address', length: 0, out: 3 },
      { k: 'env', site: 0, op: 'caller', out: 0 },
    ];
    for (const stmt of stmts) expect(siteLabel(stmt, named)).toBe(siteLabel(stmt, ir));
  });
});

describe('siteKeysOf: the key table of a realistic script', () => {
  test('every key, in counting order', () => {
    expect(keyTable(portfolio().ir)).toEqual([
      // the script body
      'literal(uint256)#0',
      'cellnew#0',
      'len#0',
      'array((uint256,uint256)[])#0',
      // s.forEach: its own length, counter and bound, then the loop
      'len#1',
      'len#2',
      'cellnew#1',
      'literal(uint256)#1',
      'while#0',
      'cellget#0',
      'lt#0',
      'index#0',
      's.read(symbol)#0',
      's.read(balanceOf)#0',
      'valueOf()#0',
      'len#3',
      'eq#0',
      'if#0',
      's.throw(Stale)#0',
      'tuple(uint256,uint256)#0',
      'arrset#0',
      'cellget#1',
      'add#0',
      'cellset#0',
      'add#1',
      'cellset#1',
      // after the loop
      'index#1',
      's.read(decimals)#0',
      's.read(reserves)#0',
      'tuple(uint112,uint112)#0',
      'literal(uint256)#2',
      'convert(uint256)#0',
      'pow#0',
      'cellget#2',
      'gte#0',
      'cellget#3',
      'cellget#4',
      'field#0',
      'convert(uint256)#1',
      'add#2',
      'muldiv#0',
      's.env(chainid)#0',
      'encodePacked#0',
      'keccak256#0',
      // s.fn('valueOf'): counted apart, under its name
      'valueOf/s.tryCall(quote)#0',
      'valueOf/literal(uint256)#0',
      'valueOf/select#0',
    ]);
  });

  test('every statement has one, and no two share it', () => {
    const { ir } = portfolio();
    const table = keyTable(ir);
    let statements = 0;
    walkStmts(ir.body, () => statements++);
    for (const fn of ir.fns) walkStmts(fn.body, () => statements++);
    expect(table).toHaveLength(statements);
    expect(new Set(table).size).toBe(statements);
    expect(table.every((key) => /^(\w+\/)?[^/#]+#\d+$/.test(key))).toBe(true);
  });

  test('deterministic: recording the script again gives the same table', () => {
    expect(keyTable(portfolio().ir)).toEqual(keyTable(portfolio().ir));
  });
});

describe('what moves a key', () => {
  /** The keys of the builder verbs (`s.read(…)`, `s.env(…)`, …), in counting order. */
  const calls = (ir: ScriptIr): string[] => keyTable(ir).filter((key) => /s\.\w+\(/.test(key));

  test('statements with other labels above it do not: the keys of the rest are unchanged', () => {
    const base = portfolio();
    const edited = portfolio({ unrelatedAbove: true });
    const added = ['cellnew#0', 'literal(bool)#0', 's.env(caller)#0', 'eq#0', 'cellset#0'];
    // five more statements, so every site id after them moved …
    const firstRead = (ir: ScriptIr): number | undefined =>
      [...siteKeysOf(ir)].find(([, key]) => key === 's.read(symbol)#0')?.[0];
    expect(firstRead(edited.ir)).toBe((firstRead(base.ir) ?? Number.NaN) + added.length);
    // … and no key of a statement with another label did
    const untouched = (key: string): boolean => !/^(cellnew|cellset|eq|literal\(bool\))#/.test(key);
    expect(keyTable(edited.ir).filter(untouched)).toEqual([
      's.env(caller)#0',
      ...keyTable(base.ir).filter(untouched),
    ]);
    expect(calls(edited.ir).filter((key) => key !== 's.env(caller)#0')).toEqual(calls(base.ir));
  });

  test('a statement with the same label, earlier in the same function, does', () => {
    const base = keyTable(portfolio().ir);
    const edited = keyTable(portfolio({ sameLabelAbove: true }).ir);
    expect(base.filter((key) => key.startsWith('s.read(decimals)'))).toEqual([
      's.read(decimals)#0',
    ]);
    expect(edited.filter((key) => key.startsWith('s.read(decimals)'))).toEqual([
      's.read(decimals)#0',
      's.read(decimals)#1',
    ]);
    // only that label moved
    const others = (table: string[]): string[] =>
      table.filter((key) => !key.startsWith('s.read(decimals)'));
    expect(others(edited)).toEqual(others(base));
  });

  test('the count is per function: an s.fn body has its own', () => {
    const script = evscript({ name: 'scoped', args: [t.address, t.address] }, (s, token, who) => {
      const inner = s.fn('inner', [t.address], (holder) =>
        s.read({ address: holder, abi: VAULT_ABI, functionName: 'balanceOf', args: [holder] }),
      );
      const outer = s.read({
        address: token,
        abi: VAULT_ABI,
        functionName: 'balanceOf',
        args: [who],
      });
      return s.return({ sum: outer.add(inner(who)).add(inner(token)) });
    });
    expect(keyTable(script.ir)).toEqual([
      's.read(balanceOf)#0',
      'inner()#0',
      'add#0',
      'inner()#1',
      'add#1',
      'inner/s.read(balanceOf)#0',
    ]);
  });

  test('unique whatever the names: the count runs on the rendered text', () => {
    // names no recorder accepts, built to make `<fn>/<label>` collide across functions
    const stmt = (site: number): Stmt => ({ k: 'fncall', site, fn: 1, args: [], outs: [] });
    const fn = (name: string, body: readonly Stmt[]): ScriptIr['fns'][number] => ({
      name,
      params: [],
      results: [],
      body,
      resultValues: [],
    });
    const ir: ScriptIr = {
      irVersion: 1,
      name: 'odd',
      args: [],
      values: [],
      cells: [],
      fns: [fn('a', [stmt(1), stmt(2)]), fn('b()#0', []), fn('a', [stmt(3)])],
      body: [stmt(0)],
      returns: [],
    };
    const table = keyTable(ir);
    expect(table).toEqual(['b()#0()#0', 'a/b()#0()#0', 'a/b()#0()#1', 'a/b()#0()#2']);
    expect(new Set(table).size).toBe(table.length);
  });
});
