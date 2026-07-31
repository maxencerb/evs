import type { Abi } from 'abitype';
/**
 * M5 unit tests — IR snapshots (`serializeIr`) per builder API family, value semantics,
 * constant folding, scope positives, and recorded-IR validity (`validateIr` on every script).
 *
 * Snapshot scripts are recorded with `{ locations: false }` so the serialized IR is
 * deterministic (no absolute paths / line numbers); loc-sensitive assertions live in
 * `validation.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { EvsError } from '../core/errors.js';
import { namedArg, t, type Expr } from '../core/types.js';
import { serializeIr, walkStmts, type ScriptIr, type Stmt } from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { evscript, type LoopCtl, type ScriptBuilder, type Tuple } from './script.js';

const NO_LOC = { locations: false } as const;

const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const poolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'poke',
    stateMutability: 'view',
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

/** Collects every statement (recursively) for structural assertions. */
function allStmts(ir: ScriptIr): Stmt[] {
  const out: Stmt[] = [];
  walkStmts(ir.body, (s) => out.push(s));
  return out;
}

function constHexOf(ir: ScriptIr, id: number): string | undefined {
  let hex: string | undefined;
  walkStmts(ir.body, (s) => {
    if (s.k === 'const' && s.out === id) hex = s.data.hex;
  });
  return hex;
}

/** Ordinary JS helper composing builder ops — exercised by the value-semantics suite. */
const twice = (s: ScriptBuilder, e: Expr<'uint256'>): Expr<'uint256'> => s.add(e, e);

// ---------------------------------------------------------------------------
// args + return + artifact shape
// ---------------------------------------------------------------------------

describe('script shell', () => {
  const script = evscript(
    { name: 'shell', args: [t.address, t.uint256] },
    (s, pool, n) => s.return({ pool, n }),
    NO_LOC,
  );

  test('IR snapshot', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
  });

  test('args bind to ValueIds 0…n−1, in declaration order, auto-named with debugNames', () => {
    expect(script.ir.args).toEqual([
      { name: 'arg0', type: 'address' },
      { name: 'arg1', type: 'uint256' },
    ]);
    expect(script.ir.values[0]).toMatchObject({ type: 'address', debugName: 'args.arg0' });
    expect(script.ir.values[1]).toMatchObject({ type: 'uint256', debugName: 'args.arg1' });
  });

  test('returns keep insertion order and reference the arg values', () => {
    expect(script.ir.returns).toEqual([
      { name: 'pool', type: 'address', value: 0 },
      { name: 'n', type: 'uint256', value: 1 },
    ]);
  });

  test('ir is deep-frozen and JSON-serializable; script object is frozen', () => {
    expect(Object.isFrozen(script)).toBe(true);
    expect(Object.isFrozen(script.ir)).toBe(true);
    expect(Object.isFrozen(script.ir.body)).toBe(true);
    expect(Object.isFrozen(script.ir.values)).toBe(true);
    expect(() => JSON.parse(serializeIr(script.ir))).not.toThrow();
  });

  test('abi mirrors the script (function + the two evs errors)', () => {
    expect(script.abi).toHaveLength(3);
    expect(script.abi[0]).toMatchObject({
      type: 'function',
      name: 'shell',
      stateMutability: 'view',
    });
    expect(script.abi[0].inputs).toEqual([
      { name: 'arg0', type: 'address' },
      { name: 'arg1', type: 'uint256' },
    ]);
    expect(script.abi[1].name).toBe('EvsInvalidCalldata');
    expect(script.abi[2].name).toBe('EvsDecodeError');
  });

  test('recorded IR passes validateIr', () => {
    expect(() => validateIr(script.ir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// named args (issue #9) — namedArg threads the user name into the IR + ABI; bare args keep the
// positional arg{i} fallback; the single-arg shorthand extends to a lone namedArg.
// ---------------------------------------------------------------------------

describe('named args (namedArg)', () => {
  test('a namedArg threads its name into ir.args + abi inputs; bare args fall back to arg{i}', () => {
    const script = evscript(
      { name: 'named', args: [namedArg('token', t.address), t.uint24, namedArg('who', t.address)] },
      (s, token, _fee, who) => s.return({ token, who }),
      NO_LOC,
    );
    expect(script.ir.args).toEqual([
      { name: 'token', type: 'address' },
      { name: 'arg1', type: 'uint24' }, // bare → positional fallback
      { name: 'who', type: 'address' },
    ]);
    expect(script.abi[0].inputs).toEqual([
      { name: 'token', type: 'address' },
      { name: 'arg1', type: 'uint24' },
      { name: 'who', type: 'address' },
    ]);
    expect(script.ir.values[0]).toMatchObject({ debugName: 'args.token' });
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('single-arg shorthand: a lone namedArg (no array wrapper)', () => {
    const script = evscript(
      { name: 'lone', args: namedArg('amount', t.uint256) },
      (s, amount) => s.return({ amount }),
      NO_LOC,
    );
    expect(script.ir.args).toEqual([{ name: 'amount', type: 'uint256' }]);
    expect(script.abi[0].inputs).toEqual([{ name: 'amount', type: 'uint256' }]);
  });

  test('duplicate arg names are rejected (ABI_SHAPE)', () => {
    let code: string | undefined;
    try {
      evscript(
        { name: 'dup', args: [namedArg('x', t.address), namedArg('x', t.uint256)] },
        (s, a) => s.return({ a }),
        NO_LOC,
      );
    } catch (e) {
      if (e instanceof EvsError) code = e.code;
    }
    expect(code).toBe('ABI_SHAPE');
  });

  test('a namedArg struct arg: Tuple handle in the callback, named tuple ABI input (issue #25)', () => {
    const MarketParams = t.struct({ loanToken: t.address, lltv: t.uint256 });
    const script = evscript(
      { name: 'position', args: [namedArg('marketParams', MarketParams)] },
      (s, marketParams) => s.return({ loan: marketParams.loanToken.get() }),
      NO_LOC,
    );
    expect(script.ir.args).toEqual([{ name: 'marketParams', type: MarketParams }]);
    expect(script.abi[0].inputs).toEqual([
      {
        name: 'marketParams',
        type: 'tuple',
        components: [
          { name: 'loanToken', type: 'address' },
          { name: 'lltv', type: 'uint256' },
        ],
      },
    ]);
    expect(script.ir.values[0]).toMatchObject({ debugName: 'args.marketParams' });
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('s.fn composite params stay deferred: UNSUPPORTED_V0 for namedArg and bare (issue #25)', () => {
    const Pair = t.struct({ token: t.address, fee: t.uint24 });
    for (const param of [namedArg('pair', Pair), Pair]) {
      let code: string | undefined;
      let message = '';
      try {
        evscript({ name: 'fnc', args: [] }, (s) => {
          s.fn('f', param, () => undefined);
          return s.return({ x: s.lit(t.uint256, 1n) });
        });
      } catch (e) {
        if (e instanceof EvsError) ({ code, message } = e);
      }
      expect(code).toBe('UNSUPPORTED_V0');
      expect(message).toContain('composite (t.struct/t.tuple) params are not supported in v0');
    }
  });

  test('s.fn: bare-type and lone-namedArg shorthand; names land in the fn IR params', () => {
    const script = evscript(
      { name: 'fnnames', args: [t.uint256] },
      (s, n) => {
        const dbl = s.fn('dbl', t.uint256, (x) => x.add(x)); // bare-type shorthand
        const inc = s.fn('inc', namedArg('a', t.uint256), (a) => a.add(1n)); // lone namedArg
        return s.return({ a: dbl(n), b: inc(n) });
      },
      NO_LOC,
    );
    const [dblFn, incFn] = script.ir.fns;
    expect(dblFn?.params.map((p) => ({ name: p.name, type: p.type }))).toEqual([
      { name: 'arg0', type: 'uint256' }, // bare → positional fallback
    ]);
    expect(incFn?.params.map((p) => p.name)).toEqual(['a']); // named
    expect(() => validateIr(script.ir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// literals
// ---------------------------------------------------------------------------

describe('literals (s.lit + coercion)', () => {
  const script = evscript(
    { name: 'lits', args: [] },
    (s) => {
      const u8 = s.lit(t.uint8, 250);
      const i24 = s.lit(t.int24, -2n);
      const addr = s.lit(t.address, '0x00000000000000000000000000000000DeaDBeef');
      const flag = s.lit(t.bool, true);
      const b4 = s.lit(t.bytes4, '0x95d89b41');
      const str = s.lit(t.string, 'hello evs');
      const raw = s.lit(t.bytes, '0xdeadbeef');
      const arr = s.lit(t.array(t.uint24), [100n, 500n, 3000n]);
      return s.return({ u8, i24, addr, flag, b4, str, raw, arr });
    },
    NO_LOC,
  );

  test('IR snapshot (word canonicalization + memref data consts)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('int literals are sign-extended; bytesN left-aligned; address lowercased', () => {
    const i24 = script.ir.returns.find((r) => r.name === 'i24');
    expect(constHexOf(script.ir, i24?.value ?? -1)).toBe(`0x${'f'.repeat(64 - 1)}e`);
    const b4 = script.ir.returns.find((r) => r.name === 'b4');
    expect(constHexOf(script.ir, b4?.value ?? -1)).toBe(`0x95d89b41${'0'.repeat(56)}`);
    const addr = script.ir.returns.find((r) => r.name === 'addr');
    expect(constHexOf(script.ir, addr?.value ?? -1)).toBe(
      `0x${'0'.repeat(24)}00000000000000000000000000000000deadbeef`,
    );
  });

  test('identical literals dedupe to the same ValueId; distinct types do not', () => {
    const script2 = evscript(
      { name: 'dedup', args: [] },
      (s) => {
        const a = s.lit(t.uint256, 7n);
        const b = s.lit(t.uint256, 7);
        const c = s.lit(t.uint8, 7n);
        return s.return({ a, b, c });
      },
      NO_LOC,
    );
    const [ra, rb, rc] = script2.ir.returns;
    expect(ra?.value).toBe(rb?.value); // same (type, hex) → interned
    expect(ra?.value).not.toBe(rc?.value); // different type → distinct const
    expect(allStmts(script2.ir).filter((s) => s.k === 'const')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// op families (no folding — operands are args)
// ---------------------------------------------------------------------------

describe('arithmetic / comparison / bool / bitwise families', () => {
  const script = evscript(
    { name: 'ops', args: [t.uint256, t.uint256, t.int8] },
    (s, a, b, s8) => {
      const sum = a.add(b);
      const diff = s.sub(a, 1n); // literal-right
      const prod = s.mul(2n, b); // literal-left
      const quot = a.div(b);
      const rem = a.mod(b);
      const ltc = a.lt(b);
      const gtc = s.gt(a, 100n);
      const lec = s.lte(a, b);
      const gec = a.gte(0n);
      const eqc = s.eq(a, b);
      const nec = s8.neq(-1n);
      const both = ltc.and(gtc);
      const either = s.or(eqc, nec);
      const nope = s.not(both);
      const band = a.bitAnd(0xffn);
      const bor = s.bitOr(a, 1n);
      const bxor = s.bitXor(a, b);
      const bnot = s.bitNot(a);
      const left = s.shl(a, 8n);
      const right = a.shr(4n);
      return s.return({
        sum,
        diff,
        prod,
        quot,
        rem,
        ltc,
        gtc,
        lec,
        gec,
        eqc,
        nec,
        both,
        either,
        nope,
        band,
        bor,
        bxor,
        bnot,
        left,
        right,
      });
    },
    NO_LOC,
  );

  test('IR snapshot', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('comparisons produce bool-typed values; signed type drives the same bin op', () => {
    const ltc = script.ir.returns.find((r) => r.name === 'ltc');
    expect(ltc?.type).toBe('bool');
    const nec = script.ir.returns.find((r) => r.name === 'nec');
    expect(nec?.type).toBe('bool');
  });
});

// ---------------------------------------------------------------------------
// conversions
// ---------------------------------------------------------------------------

describe('conversions', () => {
  const script = evscript(
    { name: 'convs', args: [t.uint256, t.bytes32, t.int128] },
    (s, x, w, i) => {
      const narrowed = x.toUint(t.uint8); // checked narrowing
      const widened = narrowed.toUint(t.uint256); // free widening
      const signed = i.toInt(t.int256);
      const crossed = i.toUint(t.uint128); // cross-sign, checked
      const addr1 = x.asAddress();
      const addr2 = w.asAddress();
      const asU = w.asUint256();
      const asB = x.asBytes32();
      return s.return({ narrowed, widened, signed, crossed, addr1, addr2, asU, asB });
    },
    NO_LOC,
  );

  test('IR snapshot + result types', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const types = Object.fromEntries(script.ir.returns.map((r) => [r.name, r.type]));
    expect(types).toEqual({
      narrowed: 'uint8',
      widened: 'uint256',
      signed: 'int256',
      crossed: 'uint128',
      addr1: 'address',
      addr2: 'address',
      asU: 'uint256',
      asB: 'bytes32',
    });
  });
});

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

describe('env', () => {
  const script = evscript(
    { name: 'envs', args: [] },
    (s) => {
      return s.return({
        self: s.env('address'),
        caller: s.env('caller'),
        ts: s.env('timestamp'),
        bn: s.env('blocknumber'),
        chain: s.env('chainid'),
      });
    },
    NO_LOC,
  );

  test('IR snapshot + out types (address/caller → address, others → uint256)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const types = Object.fromEntries(script.ir.returns.map((r) => [r.name, r.type]));
    expect(types).toEqual({
      self: 'address',
      caller: 'address',
      ts: 'uint256',
      bn: 'uint256',
      chain: 'uint256',
    });
  });
});

// ---------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------

describe('cells (s.let)', () => {
  const script = evscript(
    { name: 'cells', args: [t.uint256] },
    (s, x) => {
      const c = s.let(t.uint256, 0n); // (type, literal) overload
      const d = s.let(x); // (Expr) overload — type inferred
      c.set(x);
      c.set(5n);
      const snap = c.get();
      d.set(snap);
      return s.return({ snap, last: d.get() });
    },
    NO_LOC,
  );

  test('IR snapshot (cellnew/cellget/cellset)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(script.ir.cells).toHaveLength(2);
  });

  test('each .get() is a fresh snapshot (distinct ValueIds)', () => {
    const script2 = evscript(
      { name: 'snaps', args: [] },
      (s) => {
        const c = s.let(t.uint256, 1n);
        const one = c.get();
        const two = c.get();
        return s.return({ one, two });
      },
      NO_LOC,
    );
    const [one, two] = script2.ir.returns;
    expect(one?.value).not.toBe(two?.value);
  });
});

// ---------------------------------------------------------------------------
// mutable arrays
// ---------------------------------------------------------------------------

describe('MutArray (s.newArray)', () => {
  const script = evscript(
    { name: 'arrs', args: [t.uint256] },
    (s, n) => {
      const out = s.newArray(t.uint256, n);
      out.set(0n, 42n);
      const first = out.get(0n);
      return s.return({ first, len: out.length, all: out.expr() });
    },
    NO_LOC,
  );

  test('IR snapshot (arrnew/len/arrset/index)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('expr() aliases the arrnew ValueId (reference semantics)', () => {
    const arrnew = allStmts(script.ir).find((s) => s.k === 'arrnew');
    const all = script.ir.returns.find((r) => r.name === 'all');
    expect(arrnew?.k === 'arrnew' && arrnew.out).toBe(all?.value);
    expect(all?.type).toBe('uint256[]');
  });

  test('indexing args arrays via .at() and .length()', () => {
    const script2 = evscript(
      { name: 'argarr', args: [t.array(t.address)] },
      (s, xs) => s.return({ n: xs.length(), first: xs.at(0n) }),
      NO_LOC,
    );
    expect(serializeIr(script2.ir)).toMatchSnapshot();
    expect(() => validateIr(script2.ir)).not.toThrow();
    expect(script2.ir.returns.find((r) => r.name === 'first')?.type).toBe('address');
  });
});

// ---------------------------------------------------------------------------
// tuples / structs (s.tuple, field get/set, decode) — issue #2
// ---------------------------------------------------------------------------

const positionAbi = [
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'liquidity', type: 'uint128' },
          { name: 'owner', type: 'address' },
        ],
      },
    ],
  },
] as const satisfies Abi;

describe('Tuple (s.tuple + field get/set)', () => {
  const Position = t.struct({ liquidity: t.uint128, owner: t.address });

  test('s.tuple allocates a tuplenew, MSTORE-ing provided members; fields read via field stmt', () => {
    const script = evscript(
      { name: 'mkPos', args: [t.address] },
      (s, owner) => {
        const pos = s.tuple(Position, { liquidity: 42n, owner });
        return s.return({ liq: pos.liquidity.get(), owner: pos.owner.get(), pos: pos.expr() });
      },
      NO_LOC,
    );
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const news = allStmts(script.ir).filter((s) => s.k === 'tuplenew');
    expect(news).toHaveLength(1);
    expect(allStmts(script.ir).filter((s) => s.k === 'field')).toHaveLength(2);
    // field reads carry the member types
    expect(script.ir.returns.find((r) => r.name === 'liq')?.type).toBe('uint128');
    expect(script.ir.returns.find((r) => r.name === 'owner')?.type).toBe('address');
    // the tuple flows out as a TupleType return
    expect(script.ir.returns.find((r) => r.name === 'pos')?.type).toMatchObject({ type: 'tuple' });
  });

  test('Field.set records a tupleset; reference semantics share the block', () => {
    const script = evscript(
      { name: 'mut', args: [] },
      (s) => {
        const pos = s.tuple(Position);
        pos.liquidity.set(7n);
        pos.at(1).set('0x00000000000000000000000000000000deadbeef');
        return s.return({ liq: pos.liquidity.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(allStmts(script.ir).filter((s) => s.k === 'tupleset')).toHaveLength(2);
  });

  test('a tuple call output decodes into a Tuple handle (field read after decode)', () => {
    const script = evscript(
      { name: 'getPos', args: [t.address, t.uint256] },
      (s, manager, tokenId) => {
        const pos = s.read({
          address: manager,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        return s.return({ liquidity: pos.liquidity.get(), pos: pos.expr() });
      },
      NO_LOC,
    );
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    // the single tuple output yields a Tuple handle whose field read is uint128-typed
    expect(script.ir.returns.find((r) => r.name === 'liquidity')?.type).toBe('uint128');
    expect(script.ir.returns.find((r) => r.name === 'pos')?.type).toMatchObject({ type: 'tuple' });
  });

  test('s.return accepts a Tuple handle DIRECTLY (no .expr()) — identical IR to the .expr() form', () => {
    // a decoded tuple-output handle returned bare …
    const direct = evscript(
      { name: 'getPos', args: [t.address, t.uint256] },
      (s, manager, tokenId) => {
        const pos = s.read({
          address: manager,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        return s.return({ liquidity: pos.liquidity.get(), pos });
      },
      NO_LOC,
    );
    // … vs. the explicit `.expr()` form.
    const viaExpr = evscript(
      { name: 'getPos', args: [t.address, t.uint256] },
      (s, manager, tokenId) => {
        const pos = s.read({
          address: manager,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        return s.return({ liquidity: pos.liquidity.get(), pos: pos.expr() });
      },
      NO_LOC,
    );
    expect(() => validateIr(direct.ir)).not.toThrow();
    // byte-identical IR: the bare handle is the same memref ValueId the `.expr()` would re-wrap.
    expect(serializeIr(direct.ir)).toBe(serializeIr(viaExpr.ir));
    // the bare `pos` flows out as a named tuple return component.
    expect(direct.ir.returns.find((r) => r.name === 'pos')?.type).toMatchObject({ type: 'tuple' });
    expect(direct.ir.returns.find((r) => r.name === 'liquidity')?.type).toBe('uint128');
  });

  test('an s.tuple(...) result is returnable directly too (same IR as .expr())', () => {
    const direct = evscript(
      { name: 'mkPos', args: [t.address] },
      (s, owner) => {
        const pos = s.tuple(Position, { liquidity: 42n, owner });
        return s.return({ pos });
      },
      NO_LOC,
    );
    const viaExpr = evscript(
      { name: 'mkPos', args: [t.address] },
      (s, owner) => {
        const pos = s.tuple(Position, { liquidity: 42n, owner });
        return s.return({ pos: pos.expr() });
      },
      NO_LOC,
    );
    expect(() => validateIr(direct.ir)).not.toThrow();
    expect(serializeIr(direct.ir)).toBe(serializeIr(viaExpr.ir));
    expect(direct.ir.returns.find((r) => r.name === 'pos')?.type).toMatchObject({ type: 'tuple' });
  });

  test('a foreign Tuple handle returned directly throws FOREIGN_HANDLE naming both scripts', () => {
    let foreign: Tuple<typeof Position> | undefined;
    evscript(
      { name: 'donor', args: [t.address] },
      (s, owner) => {
        foreign = s.tuple(Position, { liquidity: 1n, owner });
        return s.return({ ok: owner });
      },
      NO_LOC,
    );
    expect(() =>
      evscript({ name: 'thief', args: [t.address] }, (s) => s.return({ stolen: foreign! }), NO_LOC),
    ).toThrow(/Tuple belongs to script "donor".*cannot be used in script "thief"/s);
  });
});

// ---------------------------------------------------------------------------
// ABI encoding + hashing (s.encode / s.encodePacked / s.keccak256) — issue #17
// ---------------------------------------------------------------------------

describe('s.encode / s.encodePacked / s.keccak256', () => {
  const Pair = t.struct({ token: t.address, fee: t.uint24 });

  test('s.encode records one encode(abi) stmt over the staged values (incl. bare handles)', () => {
    const script = evscript(
      { name: 'enc', args: [t.uint256, t.string, t.array(t.uint256)] },
      (s, x, str, arr) => {
        const pair = s.tuple(Pair, { fee: 500n });
        const out = s.encode(x, str, arr, pair);
        return s.return({ out });
      },
      NO_LOC,
    );
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const enc = allStmts(script.ir).filter((s) => s.k === 'encode');
    expect(enc).toHaveLength(1);
    expect(enc[0]?.k === 'encode' && enc[0].mode).toBe('abi');
    expect(enc[0]?.k === 'encode' && enc[0].args).toHaveLength(4);
    expect(script.ir.returns[0]?.type).toBe('bytes');
  });

  test('s.encodePacked records encode(packed); s.keccak256 standard-encodes then hashes (#24)', () => {
    const script = evscript(
      { name: 'hashes', args: [t.uint256, t.string] },
      (s, x, str) => {
        const packed = s.encodePacked(x, str);
        const h = s.keccak256(x, str);
        return s.return({ packed, h });
      },
      NO_LOC,
    );
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const encs = allStmts(script.ir).filter((s) => s.k === 'encode');
    expect(encs).toHaveLength(2);
    expect(encs.map((s) => s.k === 'encode' && s.mode)).toEqual(['packed', 'abi']);
    const hash = allStmts(script.ir).find((s) => s.k === 'keccak256');
    // the hash consumes the standard (abi) encode's out value
    expect(hash?.k === 'keccak256' && hash.a).toBe(encs[1]?.k === 'encode' && encs[1].out);
    expect(script.ir.returns.find((r) => r.name === 'h')?.type).toBe('bytes32');
  });

  test('s.keccak256 of a single bytes/string value hashes it directly (no encode stmt)', () => {
    const script = evscript(
      { name: 'direct', args: [t.bytes, t.string] },
      (s, b, str) => s.return({ hb: s.keccak256(b), hs: s.keccak256(str) }),
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(allStmts(script.ir).filter((s) => s.k === 'encode')).toHaveLength(0);
    const hashes = allStmts(script.ir).filter((s) => s.k === 'keccak256');
    expect(hashes).toHaveLength(2);
    // both hash the arg memrefs directly (ValueIds 0 and 1)
    expect(hashes.map((s) => s.k === 'keccak256' && s.a)).toEqual([0, 1]);
  });

  test('s.keccak256 of a single word standard-encodes it first (keccak256(abi.encode(x)) — #24)', () => {
    const script = evscript(
      { name: 'word', args: [t.uint8] },
      (s, x) => s.return({ h: s.keccak256(x) }),
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    const enc = allStmts(script.ir).find((s) => s.k === 'encode');
    expect(enc?.k === 'encode' && enc.mode).toBe('abi');
  });

  test('s.keccak256 accepts structs and composite arrays directly (#24)', () => {
    const script = evscript(
      { name: 'structHash', args: [t.array(t.string)] },
      (s, strs) => {
        const pair = s.tuple(Pair, { fee: 500n });
        return s.return({ hp: s.keccak256(pair), hs: s.keccak256(strs, pair) });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    const encs = allStmts(script.ir).filter((s) => s.k === 'encode');
    expect(encs.map((s) => s.k === 'encode' && s.mode)).toEqual(['abi', 'abi']);
    expect(allStmts(script.ir).filter((s) => s.k === 'keccak256')).toHaveLength(2);
  });

  test('rejects zero values and raw literals with a steering message', () => {
    expect(() =>
      evscript({ name: 'bad', args: [] }, (s) =>
        s.return({
          // @ts-expect-error — zero values is a type error too; the runtime guard is pinned here
          x: s.encode(),
        }),
      ),
    ).toThrowError(/at least one value/);
    expect(() =>
      evscript({ name: 'bad2', args: [] }, (s) =>
        s.return({
          // @ts-expect-error — a raw literal is not a staged value (runtime steering pinned)
          x: s.keccak256('hello'),
        }),
      ),
    ).toThrowError(/s\.lit\(type, value\)/);
  });

  test('rejects packed-mode composites, matching solc (structs / nested / string[])', () => {
    expect(() =>
      evscript({ name: 'bad3', args: [] }, (s) => {
        const pair = s.tuple(Pair);
        return s.return({
          // @ts-expect-error — a Tuple is not a PackedValue (runtime rejection pinned)
          x: s.encodePacked(pair),
        });
      }),
    ).toThrowError(/cannot be packed-encoded/);
    expect(() =>
      evscript({ name: 'bad4', args: [t.array(t.string)] }, (s, strs) =>
        // string[] is a valid PackedValue at the type level; the record-time guard rejects it
        s.return({ x: s.encodePacked(strs) }),
      ),
    ).toThrowError(/cannot be packed-encoded/);
    // …while s.encode / s.keccak256 accept the same values (standard ABI covers composites — #24)
    expect(() =>
      evscript(
        { name: 'ok', args: [t.array(t.string)] },
        (s, strs) => {
          const pair = s.tuple(Pair);
          return s.return({ x: s.encode(pair, strs), h: s.keccak256(pair, strs) });
        },
        NO_LOC,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

describe('s.if', () => {
  const script = evscript(
    { name: 'iffy', args: [t.uint256] },
    (s, x) => {
      const big = s.let(t.bool, false);
      s.if(
        x.gt(100n),
        () => {
          big.set(true);
        },
        () => {
          big.set(false);
        },
      );
      s.if(x.eq(0n), () => {
        big.set(false);
      }); // no else
      return s.return({ big: big.get() });
    },
    NO_LOC,
  );

  test('IR snapshot (cond evaluated once, before the branches; empty else)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const ifs = allStmts(script.ir).filter((s) => s.k === 'if');
    expect(ifs).toHaveLength(2);
    expect(ifs[1]?.k === 'if' && ifs[1].else).toEqual([]);
  });
});

describe('s.while', () => {
  const script = evscript(
    { name: 'looped', args: [t.uint256] },
    (s, n) => {
      const total = s.let(t.uint256, 0n);
      const i = s.let(t.uint256, 0n);
      s.while(
        () => i.get().lt(n),
        (loop) => {
          s.if(i.get().eq(7n), () => {
            loop.break();
          });
          s.if(i.get().eq(3n), () => {
            loop.continue();
          });
          total.set(total.get().add(i.get()));
          i.set(i.get().add(1n));
        },
      );
      return s.return({ total: total.get() });
    },
    NO_LOC,
  );

  test('IR snapshot (header block + cond + body with break/continue)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const wh = allStmts(script.ir).find((s) => s.k === 'while');
    if (wh?.k !== 'while') throw new Error('expected a while statement');
    expect(wh.header.length).toBeGreaterThan(0);
    expect(wh.body.length).toBeGreaterThan(0);
  });

  test('header values are visible in the body (header dominates the body)', () => {
    const script2 = evscript(
      { name: 'hdr', args: [t.uint256] },
      (s, n) => {
        const i = s.let(t.uint256, 0n);
        let snapshot: Expr<'uint256'> | undefined;
        s.while(
          () => {
            snapshot = i.get(); // recorded in the header
            return snapshot.lt(n);
          },
          () => {
            if (snapshot === undefined) throw new Error('unreachable');
            i.set(snapshot.add(1n)); // used in the body — legal
          },
        );
        return s.return({ i: i.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script2.ir)).not.toThrow();
  });
});

describe('s.for', () => {
  const script = evscript(
    { name: 'fored', args: [t.uint256] },
    (s, n) => {
      const acc = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
        acc.set(acc.get().add(i));
      });
      return s.return({ acc: acc.get() });
    },
    NO_LOC,
  );

  test('IR snapshot (sugar over while + an internal cell; step defaults to 1)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('loop.continue() records the step before the continue (jump "to the step")', () => {
    const script2 = evscript(
      { name: 'forcont', args: [t.uint64] },
      (s, n) => {
        const acc = s.let(t.uint64, 0n);
        s.for({ type: t.uint64, from: 0n, until: n, step: 2n }, (i, loop) => {
          s.if(i.eq(4n), () => {
            loop.continue();
          });
          acc.set(acc.get().add(i));
        });
        return s.return({ acc: acc.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script2.ir)).not.toThrow();
    const wh = allStmts(script2.ir).find((s) => s.k === 'while');
    expect(wh?.k).toBe('while');
    if (wh?.k !== 'while') return;
    // inside the if-then of the body: [cellget, bin add, cellset, continue]
    const ifStmt = wh.body.find((s) => s.k === 'if');
    expect(ifStmt?.k).toBe('if');
    if (ifStmt?.k !== 'if') return;
    expect(ifStmt.then.map((s) => s.k)).toEqual(['cellget', 'bin', 'cellset', 'continue']);
    // and the natural end of the body repeats the step
    const tail = wh.body.slice(-3).map((s) => s.k);
    expect(tail).toEqual(['cellget', 'bin', 'cellset']);
  });

  test('generic over signed word types', () => {
    const script3 = evscript(
      { name: 'forint', args: [] },
      (s) => {
        const last = s.let(t.int16, 0n);
        s.for({ type: t.int16, from: -3n, until: 3n }, (i) => {
          last.set(i);
        });
        return s.return({ last: last.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script3.ir)).not.toThrow();
  });

  test('range.type is optional and defaults to uint256 — IR identical to the typed form (issue #12)', () => {
    const typed = evscript(
      { name: 'fordef', args: [t.uint256] },
      (s, n) => {
        const acc = s.let(t.uint256, 0n);
        s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
          acc.set(acc.get().add(i));
        });
        return s.return({ acc: acc.get() });
      },
      NO_LOC,
    );
    const untyped = evscript(
      { name: 'fordef', args: [t.uint256] },
      (s, n) => {
        const acc = s.let(t.uint256, 0n);
        s.for({ from: 0n, until: n }, (i) => {
          acc.set(acc.get().add(i));
        });
        return s.return({ acc: acc.get() });
      },
      NO_LOC,
    );
    expect(serializeIr(untyped.ir)).toEqual(serializeIr(typed.ir));
    expect(() => validateIr(untyped.ir)).not.toThrow();
  });
});

describe('s.forEach', () => {
  const script = evscript(
    { name: 'summed', args: [t.array(t.uint256)] },
    (s, xs) => {
      const total = s.let(t.uint256, 0n);
      s.forEach(xs, (x, i) => {
        total.set(total.get().add(x).add(i));
      });
      return s.return({ total: total.get() });
    },
    NO_LOC,
  );

  test('IR snapshot (one len snapshot before the loop; index per iteration; step tail)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    const stmts = allStmts(script.ir);
    // the array length is snapshot ONCE, outside the while
    expect(stmts.filter((s) => s.k === 'len')).toHaveLength(1);
    const wh = stmts.find((s) => s.k === 'while');
    if (wh?.k !== 'while') throw new Error('expected a while statement');
    expect(wh.header.some((s) => s.k === 'len')).toBe(false);
    expect(wh.body.some((s) => s.k === 'index')).toBe(true);
    // the counter step at the natural end of the body: cellget + add + cellset
    expect(wh.body.slice(-3).map((s) => s.k)).toEqual(['cellget', 'bin', 'cellset']);
  });

  test('loop.continue() records the step before the continue; loop.break() works', () => {
    const script2 = evscript(
      { name: 'ctl', args: [t.array(t.uint256)] },
      (s, xs) => {
        const total = s.let(t.uint256, 0n);
        s.forEach(xs, (x, i, loop) => {
          s.if(i.eq(0n), () => {
            loop.continue();
          });
          s.if(x.gt(100n), () => {
            loop.break();
          });
          total.set(total.get().add(x));
        });
        return s.return({ total: total.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script2.ir)).not.toThrow();
    const wh = allStmts(script2.ir).find((s) => s.k === 'while');
    if (wh?.k !== 'while') throw new Error('expected a while statement');
    const [contIf, breakIf] = wh.body.filter((s) => s.k === 'if');
    if (contIf?.k !== 'if' || breakIf?.k !== 'if') throw new Error('expected two if statements');
    expect(contIf.then.map((s) => s.k)).toEqual(['cellget', 'bin', 'cellset', 'continue']);
    expect(breakIf.then.map((s) => s.k)).toEqual(['break']);
  });

  test('a tuple[] array hands the body a Tuple element handle', () => {
    const Pair = t.struct({ token: t.address, fee: t.uint24 });
    const script3 = evscript(
      { name: 'pairs', args: [t.array(Pair)] },
      (s, pairs) => {
        const last = s.let(t.address, '0x0000000000000000000000000000000000000000');
        s.forEach(pairs, (pair) => {
          last.set(pair.token.get());
        });
        return s.return({ last: last.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script3.ir)).not.toThrow();
    // the element arrives as a Tuple: reading .token records a field stmt off the index out
    expect(allStmts(script3.ir).filter((s) => s.k === 'field')).toHaveLength(1);
    expect(allStmts(script3.ir).filter((s) => s.k === 'index')).toHaveLength(1);
  });
});

describe('s.select', () => {
  const script = evscript(
    { name: 'sel', args: [t.bool, t.uint256, t.uint256] },
    (s, c, a, b) =>
      s.return({
        picked: s.select(c, a, b),
        defaulted: s.select(c, a, 0n),
      }),
    NO_LOC,
  );

  test('IR snapshot (eager both sides)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('literal condition folds to the chosen operand (no select stmt)', () => {
    const script2 = evscript(
      { name: 'self', args: [t.uint256, t.uint256] },
      (s, a, b) => {
        const picked = s.select(true, a, b);
        const dropped = s.select(false, a, b);
        return s.return({ picked, dropped });
      },
      NO_LOC,
    );
    expect(allStmts(script2.ir).filter((s) => s.k === 'select')).toHaveLength(0);
    expect(script2.ir.returns[0]?.value).toBe(0); // aliases args.a
    expect(script2.ir.returns[1]?.value).toBe(1); // aliases args.b
  });
});

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

describe('s.call / s.tryCall', () => {
  const script = evscript(
    { name: 'calls', args: [t.address, t.address] },
    (s, pool, user) => {
      const symbol = s.read({ address: pool, abi: erc20Abi, functionName: 'symbol' });
      const bal = s.read({
        address: pool,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [user],
        gas: 100_000n,
      });
      const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0' });
      const dec = s.tryRead({ address: pool, abi: erc20Abi, functionName: 'decimals' });
      const decimals = s.select(dec.success, dec.value, s.lit(t.uint8, 18));
      return s.return({ symbol, bal, tick: slot0[1], decimals });
    },
    NO_LOC,
  );

  test('IR snapshot (strict + try, literal/expr args, gas, multi-output)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('selectors are computed (symbol() → 0x95d89b41) and fnAbi is plain', () => {
    const calls = allStmts(script.ir).filter((s) => s.k === 'call');
    expect(calls).toHaveLength(4);
    const sym = calls.find((c) => c.k === 'call' && c.fnAbi.name === 'symbol');
    expect(sym?.k === 'call' && sym.fnAbi.selector).toBe('0x95d89b41');
  });

  test('strict mode has no successOut; try mode has one; gas is threaded', () => {
    const calls = allStmts(script.ir).filter((s) => s.k === 'call');
    const bal = calls.find((c) => c.k === 'call' && c.fnAbi.name === 'balanceOf');
    const dec = calls.find((c) => c.k === 'call' && c.fnAbi.name === 'decimals');
    expect(bal?.k === 'call' && bal.successOut).toBeUndefined();
    expect(bal?.k === 'call' && bal.gas).toBeTypeOf('number');
    expect(dec?.k === 'call' && dec.mode).toBe('try');
    expect(dec?.k === 'call' && dec.successOut).toBeTypeOf('number');
  });

  test('void output → undefined; literal address arg works', () => {
    const script2 = evscript(
      { name: 'voidcall', args: [t.address] },
      (s, pool) => {
        const nothing = s.read({ address: pool, abi: poolAbi, functionName: 'poke' });
        expect(nothing).toBeUndefined();
        const bal = s.read({
          address: '0x00000000000000000000000000000000deadbeef',
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: ['0x1111111111111111111111111111111111111111'],
        });
        return s.return({ bal });
      },
      NO_LOC,
    );
    expect(() => validateIr(script2.ir)).not.toThrow();
  });

  test('output handles carry debugNames for inspectability', () => {
    const symId = script.ir.returns.find((r) => r.name === 'symbol')?.value ?? -1;
    expect(script.ir.values[symId]?.debugName).toBe('s.read(symbol)');
  });
});

// ---------------------------------------------------------------------------
// user functions
// ---------------------------------------------------------------------------

describe('s.fn', () => {
  const script = evscript(
    { name: 'fns', args: [t.address, t.array(t.address)] },
    (s, owner, tokens) => {
      const balOf = s.fn(
        'balOf',
        [namedArg('token', t.address), namedArg('who', t.address)] as const,
        (token, who) =>
          s.read({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
      );
      const a = balOf(tokens.at(0n), owner);
      const b = balOf(tokens.at(1n), owner);
      return s.return({ a, b });
    },
    NO_LOC,
  );

  test('IR snapshot (fn body recorded once; two fncalls)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(script.ir.fns).toHaveLength(1);
    expect(allStmts(script.ir).filter((s) => s.k === 'fncall')).toHaveLength(2);
  });

  test('two calls never alias (fresh outs per call site)', () => {
    const [ra, rb] = script.ir.returns;
    expect(ra?.value).not.toBe(rb?.value);
  });

  test('tuple results and void fns', () => {
    const script2 = evscript(
      { name: 'fnshapes', args: [t.uint256] },
      (s, x) => {
        const pair = s.fn(
          'pair',
          [namedArg('a', t.uint256)] as const,
          (a) => [a.add(1n), a.eq(0n)] as const,
        );
        const noop = s.fn('noop', [] as const, () => {});
        const r = pair(x);
        expect(noop()).toBeUndefined();
        return s.return({ plus: r[0], isZero: r[1] });
      },
      NO_LOC,
    );
    expect(() => validateIr(script2.ir)).not.toThrow();
    expect(script2.ir.fns.map((f) => f.results.length)).toEqual([2, 0]);
  });

  test('uncalled fns are still recorded in ir.fns (codegen drops them)', () => {
    const script3 = evscript(
      { name: 'uncalled', args: [t.uint256] },
      (s, x) => {
        s.fn('unused', [namedArg('a', t.uint256)] as const, (a) => a.add(1n));
        return s.return({ x });
      },
      NO_LOC,
    );
    expect(script3.ir.fns).toHaveLength(1);
    expect(() => validateIr(script3.ir)).not.toThrow();
  });

  test('fn literals coerce against param types at the call site', () => {
    const script4 = evscript(
      { name: 'fnlit', args: [] },
      (s) => {
        const inc = s.fn('inc', [namedArg('a', t.uint8)] as const, (a) => a.add(1n));
        return s.return({ two: inc(1n) });
      },
      NO_LOC,
    );
    expect(() => validateIr(script4.ir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// constant folding
// ---------------------------------------------------------------------------

describe('all-literal folding', () => {
  test('arithmetic, comparison, bool, bitwise, shift, and convert folds collapse to consts', () => {
    const script = evscript(
      { name: 'folds', args: [] },
      (s) => {
        const sum = s.lit(t.uint8, 250).add(5); // 255
        const cmp = s.lit(t.uint256, 3n).lt(4n); // true
        const bothWays = s.lit(t.bool, true).and(false); // false
        const masked = s.lit(t.uint16, 0xabcdn).bitAnd(0xff00n); // 0xab00
        const flipped = s.lit(t.uint8, 0).bitNot(); // 0xff
        const shifted = s.lit(t.bytes4, '0x11223344').shl(8n); // 0x22334400
        const inverted = s.not(false); // true
        const narrowed = s.lit(t.uint256, 200n).toUint(t.uint8); // 200 fits
        const signedDiv = s.lit(t.int8, -7n).div(2n); // −3 (trunc toward zero)
        // intN shifts are outside the typed BitsType surface; the engine implements SAR
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberate type-surface bypass
        const signedShr = (s.lit(t.int16, -8n) as Expr<never>).shr(1n); // SAR → −4
        return s.return({
          sum,
          cmp,
          bothWays,
          masked,
          flipped,
          shifted,
          inverted,
          narrowed,
          signedDiv,
          signedShr,
        });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    // every stmt in the body is a const — no bin/un/convert survived
    expect(allStmts(script.ir).every((s) => s.k === 'const')).toBe(true);
    expect(serializeIr(script.ir)).toMatchSnapshot();

    const hex = (name: string): string | undefined =>
      constHexOf(script.ir, script.ir.returns.find((r) => r.name === name)?.value ?? -1);
    expect(hex('sum')).toBe(`0x${'0'.repeat(62)}ff`);
    expect(hex('cmp')).toBe(`0x${'0'.repeat(63)}1`);
    expect(hex('bothWays')).toBe(`0x${'0'.repeat(64)}`);
    expect(hex('masked')).toBe(`0x${'0'.repeat(60)}ab00`);
    expect(hex('flipped')).toBe(`0x${'0'.repeat(62)}ff`);
    expect(hex('shifted')).toBe(`0x22334400${'0'.repeat(56)}`);
    expect(hex('inverted')).toBe(`0x${'0'.repeat(63)}1`);
    expect(hex('narrowed')).toBe(`0x${'0'.repeat(62)}c8`);
    expect(hex('signedDiv')).toBe(`0x${'f'.repeat(63)}d`); // −3 sign-extended
    expect(hex('signedShr')).toBe(`0x${'f'.repeat(63)}c`); // −4 sign-extended
  });

  test('mixed literal/expr does not fold; expr-literal + raw literal does', () => {
    const script = evscript(
      { name: 'mixed', args: [t.uint256] },
      (s, x) => {
        const live = x.add(1n); // bin stmt survives
        const folded = s.lit(t.uint256, 2n).mul(3n); // folds to 6
        return s.return({ live, folded });
      },
      NO_LOC,
    );
    const kinds = allStmts(script.ir).map((s) => s.k);
    expect(kinds.filter((k) => k === 'bin')).toHaveLength(1);
    const folded = script.ir.returns.find((r) => r.name === 'folded');
    expect(constHexOf(script.ir, folded?.value ?? -1)).toBe(`0x${'0'.repeat(63)}6`);
  });

  test('the documented escape hatch defers a certain panic to runtime', () => {
    const max = 2n ** 256n - 1n;
    const script = evscript(
      { name: 'hatch', args: [] },
      (s) => {
        const v = s.let(t.uint256, max).get().add(1n); // would fold-panic without the cell
        return s.return({ v });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(allStmts(script.ir).some((s) => s.k === 'bin' && s.op === 'add')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// value semantics
// ---------------------------------------------------------------------------

describe('value semantics', () => {
  test('handle reuse re-reads the slot — no re-execution, no new stmts', () => {
    const script = evscript(
      { name: 'reuse', args: [t.uint256] },
      (s, x) => {
        const doubled = x.mul(2n);
        const a = doubled.add(1n);
        const b = doubled.add(2n); // reuses `doubled`, records only one extra bin
        return s.return({ a, b });
      },
      NO_LOC,
    );
    const bins = allStmts(script.ir).filter((s) => s.k === 'bin');
    expect(bins).toHaveLength(3); // mul, add, add — `doubled` never re-executed
  });

  test('builder facade is reusable across helper functions (plain JS composition)', () => {
    const script = evscript(
      { name: 'compose', args: [] },
      (s) => {
        const x = s.lit(t.uint256, 21n);
        const cell = s.let(t.uint256, x);
        return s.return({ y: twice(s, cell.get()) });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('loops record their body exactly once', () => {
    let bodyRuns = 0;
    const script = evscript(
      { name: 'once', args: [t.uint256] },
      (s, n) => {
        const i = s.let(t.uint256, 0n);
        s.while(
          () => i.get().lt(n),
          () => {
            bodyRuns += 1;
            i.set(i.get().add(1n));
          },
        );
        return s.return({ i: i.get() });
      },
      NO_LOC,
    );
    expect(bodyRuns).toBe(1);
    expect(() => validateIr(script.ir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// locations (default on)
// ---------------------------------------------------------------------------

describe('source locations', () => {
  test('locations: true (default) captures the evscript call site and stmt locs in this file', () => {
    const script = evscript({ name: 'located', args: [t.uint256] }, (s, x) =>
      s.return({ y: x.add(1n) }),
    );
    expect(script.ir.loc?.file).toMatch(/script\.test\.ts/);
    const bin = allStmts(script.ir).find((s) => s.k === 'bin');
    expect(bin?.loc?.file).toMatch(/script\.test\.ts/);
    expect(bin?.loc?.line).toBeGreaterThan(0);
  });

  test('locations: false yields null locs everywhere', () => {
    const script = evscript(
      { name: 'unlocated', args: [t.uint256] },
      (s, x) => s.return({ y: x.add(1n) }),
      NO_LOC,
    );
    expect(script.ir.loc).toBeNull();
    for (const st of allStmts(script.ir)) expect(st.loc).toBeNull();
    for (const v of script.ir.values) expect(v.loc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// flagship-shaped smoke (api.md E1/E4 reduced)
// ---------------------------------------------------------------------------

describe('integration-shaped recording', () => {
  test('E4-shaped script (data-segment literal array, while + cells + break) records valid IR', () => {
    const FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
    const factoryAbi = [
      {
        type: 'function',
        name: 'getPool',
        stateMutability: 'view',
        inputs: [
          { name: 'a', type: 'address' },
          { name: 'b', type: 'address' },
          { name: 'fee', type: 'uint24' },
        ],
        outputs: [{ name: '', type: 'address' }],
      },
    ] as const satisfies Abi;
    const ZERO = '0x0000000000000000000000000000000000000000';
    const script = evscript(
      { name: 'firstPool', args: [t.address, t.address] },
      (s, a, b) => {
        const fees = s.lit(t.array(t.uint24), [100n, 500n, 3000n, 10000n]);
        const found = s.let(t.address, ZERO);
        const feeOut = s.let(t.uint24, 0n);
        const i = s.let(t.uint256, 0n);
        s.while(
          () => i.get().lt(fees.length()),
          (loop: LoopCtl) => {
            const fee = fees.at(i.get());
            const pool = s.read({
              address: FACTORY,
              abi: factoryAbi,
              functionName: 'getPool',
              args: [a, b, fee],
            });
            s.if(pool.neq(ZERO), () => {
              found.set(pool);
              feeOut.set(fee);
              loop.break();
            });
            i.set(i.get().add(1n));
          },
        );
        return s.return({ pool: found.get(), fee: feeOut.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(serializeIr(script.ir)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// composite-type ergonomics — issue #5 (s.fn struct returns, struct: true named
// multi-output decode, bare MutArray return, call/constructed tuple unification)
// ---------------------------------------------------------------------------

describe('issue #5 ergonomics', () => {
  const TokenMeta = t.struct({ symbol: t.string, decimals: t.uint8 });

  // -- ask #1: s.fn returns a struct/composite directly -----------------------------------
  test('s.fn returns a struct directly — byte-identical IR to .expr(); the result type is the struct', () => {
    const direct = evscript(
      { name: 'meta', args: [t.address] },
      (s, token) => {
        const getMeta = s.fn('getMeta', [namedArg('tok', t.address)] as const, (tok) =>
          s.tuple(TokenMeta, {
            symbol: s.read({ address: tok, abi: erc20Abi, functionName: 'symbol' }),
            decimals: s.read({ address: tok, abi: erc20Abi, functionName: 'decimals' }),
          }),
        );
        const m = getMeta(token);
        return s.return({ symbol: m.symbol.get(), decimals: m.decimals.get(), meta: m });
      },
      NO_LOC,
    );
    const viaExpr = evscript(
      { name: 'meta', args: [t.address] },
      (s, token) => {
        const getMeta = s.fn('getMeta', [namedArg('tok', t.address)] as const, (tok) =>
          s
            .tuple(TokenMeta, {
              symbol: s.read({ address: tok, abi: erc20Abi, functionName: 'symbol' }),
              decimals: s.read({ address: tok, abi: erc20Abi, functionName: 'decimals' }),
            })
            .expr(),
        );
        const m = getMeta(token);
        return s.return({ symbol: m.symbol.get(), decimals: m.decimals.get(), meta: m });
      },
      NO_LOC,
    );
    expect(() => validateIr(direct.ir)).not.toThrow();
    // the bare-Tuple fn return is byte-identical to wrapping it in `.expr()`.
    expect(serializeIr(direct.ir)).toBe(serializeIr(viaExpr.ir));
    expect(serializeIr(direct.ir)).toMatchSnapshot();
    // the fn result type is recorded as the full struct.
    expect(direct.ir.fns[0]?.results[0]?.type).toMatchObject({ type: 'tuple' });
    // the call site receives a Tuple handle (field reads are member-typed via `field` stmts).
    expect(direct.ir.returns.find((r) => r.name === 'symbol')?.type).toBe('string');
    expect(direct.ir.returns.find((r) => r.name === 'decimals')?.type).toBe('uint8');
    expect(direct.ir.returns.find((r) => r.name === 'meta')?.type).toMatchObject({ type: 'tuple' });
  });

  test('s.fn can return a MutArray (composite/array result) — call site gets an array Expr', () => {
    const script = evscript(
      { name: 'mkArr', args: [t.uint256] },
      (s, n) => {
        const build = s.fn('build', [namedArg('len', t.uint256)] as const, (len) => {
          const arr = s.newArray(t.uint256, len);
          arr.set(0n, 7n);
          return arr;
        });
        const a = build(n);
        return s.return({ all: a, len: a.length() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(script.ir.fns[0]?.results[0]?.type).toBe('uint256[]');
    expect(script.ir.returns.find((r) => r.name === 'all')?.type).toBe('uint256[]');
  });

  // (recursion stays unsupported — the fn handle does not exist inside its own body, so a
  //  self-call is unconstructible by design; issue #5 widened only the RETURN type, not this.)

  // -- ask #2: struct: true named multi-output decode --------------------------------------
  test('s.read({ struct: true }) decodes named multi-outputs into one Tuple (tuplenew over outputs)', () => {
    const script = evscript(
      { name: 'pool', args: [t.address] },
      (s, pool) => {
        const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
        return s.return({ price: slot0.sqrtPriceX96.get(), tick: slot0.tick.get(), slot0 });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(serializeIr(script.ir)).toMatchSnapshot();
    // ONE tuplenew composes the three decoded outputs; the default positional path emits none.
    const news = allStmts(script.ir).filter((st) => st.k === 'tuplenew');
    expect(news).toHaveLength(1);
    expect(news[0]?.k === 'tuplenew' && news[0].inits).toHaveLength(3);
    // named field reads carry the output types.
    expect(script.ir.returns.find((r) => r.name === 'price')?.type).toBe('uint160');
    expect(script.ir.returns.find((r) => r.name === 'tick')?.type).toBe('int24');
    // the whole struct flows out as a tuple, components in ABI declaration order.
    expect(script.ir.returns.find((r) => r.name === 'slot0')?.type).toMatchObject({
      type: 'tuple',
      components: [{ name: 'sqrtPriceX96' }, { name: 'tick' }, { name: 'unlocked' }],
    });
  });

  test('the default [many] shape is unchanged without struct: true (no tuplenew, positional)', () => {
    const script = evscript(
      { name: 'pos', args: [t.address] },
      (s, pool) => {
        const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0' });
        return s.return({ price: slot0[0], tick: slot0[1] });
      },
      NO_LOC,
    );
    expect(allStmts(script.ir).filter((st) => st.k === 'tuplenew')).toHaveLength(0);
    expect(script.ir.returns.find((r) => r.name === 'price')?.type).toBe('uint160');
  });

  test('s.read({ struct: true }) rejects an unnamed output (would degrade viem to positional)', () => {
    const unnamedAbi = [
      {
        type: 'function',
        name: 'pair',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          { name: 'a', type: 'uint256' },
          { name: '', type: 'uint256' },
        ],
      },
    ] as const satisfies Abi;
    expect(() =>
      evscript(
        { name: 'bad', args: [t.address] },
        (s, x) =>
          s.return({
            r: s.read({ address: x, abi: unnamedAbi, functionName: 'pair', struct: true }),
          }),
        NO_LOC,
      ),
    ).toThrow(/unnamed/);
  });

  test('struct: true works through tryCall too', () => {
    const script = evscript(
      { name: 'trySlot', args: [t.address] },
      (s, pool) => {
        const r = s.tryRead({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
        return s.return({ ok: r.success, tick: r.value.tick.get() });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    expect(allStmts(script.ir).filter((st) => st.k === 'tuplenew')).toHaveLength(1);
    expect(script.ir.returns.find((r) => r.name === 'tick')?.type).toBe('int24');
  });

  // -- ask #5: bare MutArray return --------------------------------------------------------
  test('s.return accepts a bare MutArray handle — byte-identical IR to .expr()', () => {
    const direct = evscript(
      { name: 'arr', args: [t.uint256] },
      (s, n) => {
        const out = s.newArray(t.uint256, n);
        out.set(0n, 42n);
        return s.return({ all: out });
      },
      NO_LOC,
    );
    const viaExpr = evscript(
      { name: 'arr', args: [t.uint256] },
      (s, n) => {
        const out = s.newArray(t.uint256, n);
        out.set(0n, 42n);
        return s.return({ all: out.expr() });
      },
      NO_LOC,
    );
    expect(() => validateIr(direct.ir)).not.toThrow();
    expect(serializeIr(direct.ir)).toBe(serializeIr(viaExpr.ir));
    expect(direct.ir.returns.find((r) => r.name === 'all')?.type).toBe('uint256[]');
  });

  test('a tuple[] MutArray is returnable bare (the flagship `s.return({ metadata })` shape)', () => {
    const Item = t.struct({ a: t.uint256, b: t.address });
    const direct = evscript(
      { name: 'items', args: [t.uint256] },
      (s, n) => {
        const arr = s.newArray(Item, n);
        return s.return({ metadata: arr });
      },
      NO_LOC,
    );
    const viaExpr = evscript(
      { name: 'items', args: [t.uint256] },
      (s, n) => {
        const arr = s.newArray(Item, n);
        return s.return({ metadata: arr.expr() });
      },
      NO_LOC,
    );
    expect(() => validateIr(direct.ir)).not.toThrow();
    expect(serializeIr(direct.ir)).toBe(serializeIr(viaExpr.ir));
    expect(direct.ir.returns.find((r) => r.name === 'metadata')?.type).toMatchObject({
      type: 'tuple[]',
    });
  });

  test('a bare MutArray passed as a struct array member aliases the array (no copy)', () => {
    const Wrapper = t.struct({ xs: t.array(t.uint256) });
    const script = evscript(
      { name: 'wrap', args: [t.uint256] },
      (s, n) => {
        const xs = s.newArray(t.uint256, n);
        const w = s.tuple(Wrapper, { xs });
        return s.return({ w });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    // the tuplenew member init points straight at the arrnew out (reference, not a rebuild).
    const arrnew = allStmts(script.ir).find((st) => st.k === 'arrnew');
    const tuplenew = allStmts(script.ir).find((st) => st.k === 'tuplenew');
    expect(tuplenew?.k === 'tuplenew' && tuplenew.inits[0]?.value).toBe(
      arrnew?.k === 'arrnew' ? arrnew.out : -1,
    );
  });

  test('a bare MutArray of the WRONG element type is rejected at record time (runtime typesEqual guard)', () => {
    // `IntoArray`/`AnyMutArray` erase the element type, so this typechecks; the runtime `typesEqual`
    // guard in `coerceToId` is what rejects a `bool[]` where a `uint256[]` is expected.
    const Wrapper = t.struct({ xs: t.array(t.uint256) });
    expect(() =>
      evscript(
        { name: 'wrongElem', args: [t.uint256] },
        (s, n) => {
          const wrong = s.newArray(t.bool, n);
          return s.return({ w: s.tuple(Wrapper, { xs: wrong }) });
        },
        NO_LOC,
      ),
    ).toThrow(/expected 'uint256\[\]', got Expr<'bool\[\]'>/);
  });

  test('a bare MutArray passed as a call arg aliases the array (call args route through coerceToId)', () => {
    const consumerAbi = [
      {
        type: 'function',
        name: 'useStructs',
        stateMutability: 'view',
        inputs: [
          {
            name: 'ps',
            type: 'tuple[]',
            components: [
              { name: 'liquidity', type: 'uint128' },
              { name: 'owner', type: 'address' },
            ],
          },
        ],
        outputs: [{ name: '', type: 'uint256' }],
      },
    ] as const satisfies Abi;
    const Pos = t.struct({ liquidity: t.uint128, owner: t.address });
    const script = evscript(
      { name: 'callarg', args: [t.address, t.uint256] },
      (s, target, n) => {
        const arr = s.newArray(Pos, n);
        const r = s.read({
          address: target,
          abi: consumerAbi,
          functionName: 'useStructs',
          args: [arr],
        });
        return s.return({ r });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    const arrnew = allStmts(script.ir).find((st) => st.k === 'arrnew');
    const call = allStmts(script.ir).find((st) => st.k === 'call');
    expect(call?.k === 'call' && call.args[0]).toBe(arrnew?.k === 'arrnew' ? arrnew.out : -1);
  });

  // -- ask #3: a call-decoded tuple flows straight into a constructed struct ----------------
  test('a single-tuple call output passes directly into an s.tuple member (aliases, no rebuild)', () => {
    const Outer = t.struct({ pos: t.fromOutputs(positionAbi, 'positions'), tag: t.uint256 });
    const script = evscript(
      { name: 'nest', args: [t.address, t.uint256] },
      (s, manager, tokenId) => {
        const pos = s.read({
          address: manager,
          abi: positionAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        const outer = s.tuple(Outer, { pos, tag: tokenId });
        return s.return({ outer });
      },
      NO_LOC,
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    // exactly ONE tuplenew (the outer struct) — the inner tuple aliases the call's decoded block.
    expect(allStmts(script.ir).filter((st) => st.k === 'tuplenew')).toHaveLength(1);
    expect(script.ir.returns.find((r) => r.name === 'outer')?.type).toMatchObject({
      type: 'tuple',
    });
  });
});

// ---------------------------------------------------------------------------
// try verbs — result wrapper shape (facade regression: the six verbs are table-built)
// ---------------------------------------------------------------------------

describe('calling-verb facade shape', () => {
  const writeAbi = [
    {
      type: 'function',
      name: 'poke2',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: [{ name: '', type: 'uint8' }],
    },
  ] as const satisfies Abi;

  test('tryRead/tryCall/trySimulate return a frozen { success, value } wrapper', () => {
    const wrappers: object[] = [];
    evscript(
      { name: 'shape', args: [t.address] },
      (s, pool) => {
        const a = s.tryRead({ address: pool, abi: erc20Abi, functionName: 'decimals' });
        const b = s.tryCall({ address: pool, abi: writeAbi, functionName: 'poke2' });
        const c = s.trySimulate({ address: pool, abi: writeAbi, functionName: 'poke2' });
        wrappers.push(a, b, c);
        return s.return({ a: a.value, b: b.value, c: c.value });
      },
      NO_LOC,
    );
    expect(wrappers).toHaveLength(3);
    for (const w of wrappers) {
      expect(Object.isFrozen(w)).toBe(true);
      expect(Object.keys(w).toSorted()).toEqual(['success', 'value']);
    }
  });
});
