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

import { arg, t, type Expr } from '../core/types.js';
import { serializeIr, walkStmts, type ScriptIr, type Stmt } from '../ir/nodes.js';
import { validateIr } from '../ir/validate.js';
import { evscript, type LoopCtl, type ScriptBuilder } from './script.js';

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
const twice = (s: ScriptBuilder<readonly []>, e: Expr<'uint256'>): Expr<'uint256'> => s.add(e, e);

// ---------------------------------------------------------------------------
// args + return + artifact shape
// ---------------------------------------------------------------------------

describe('script shell', () => {
  const script = evscript(
    { name: 'shell', args: [arg('pool', t.address), arg('n', t.uint256)] },
    (s) => s.return({ pool: s.args.pool, n: s.args.n }),
    NO_LOC,
  );

  test('IR snapshot', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
  });

  test('args bind to ValueIds 0…n−1, in declaration order, with debugNames', () => {
    expect(script.ir.args).toEqual([
      { name: 'pool', type: 'address' },
      { name: 'n', type: 'uint256' },
    ]);
    expect(script.ir.values[0]).toMatchObject({ type: 'address', debugName: 'args.pool' });
    expect(script.ir.values[1]).toMatchObject({ type: 'uint256', debugName: 'args.n' });
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
      { name: 'pool', type: 'address' },
      { name: 'n', type: 'uint256' },
    ]);
    expect(script.abi[1].name).toBe('EvsInvalidCalldata');
    expect(script.abi[2].name).toBe('EvsDecodeError');
  });

  test('recorded IR passes validateIr', () => {
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
    { name: 'ops', args: [arg('a', t.uint256), arg('b', t.uint256), arg('s8', t.int8)] },
    (s) => {
      const sum = s.args.a.add(s.args.b);
      const diff = s.sub(s.args.a, 1n); // literal-right
      const prod = s.mul(2n, s.args.b); // literal-left
      const quot = s.args.a.div(s.args.b);
      const rem = s.args.a.mod(s.args.b);
      const ltc = s.args.a.lt(s.args.b);
      const gtc = s.gt(s.args.a, 100n);
      const lec = s.lte(s.args.a, s.args.b);
      const gec = s.args.a.gte(0n);
      const eqc = s.eq(s.args.a, s.args.b);
      const nec = s.args.s8.neq(-1n);
      const both = ltc.and(gtc);
      const either = s.or(eqc, nec);
      const nope = s.not(both);
      const band = s.args.a.bitAnd(0xffn);
      const bor = s.bitOr(s.args.a, 1n);
      const bxor = s.bitXor(s.args.a, s.args.b);
      const bnot = s.bitNot(s.args.a);
      const left = s.shl(s.args.a, 8n);
      const right = s.args.a.shr(4n);
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
    { name: 'convs', args: [arg('x', t.uint256), arg('w', t.bytes32), arg('i', t.int128)] },
    (s) => {
      const narrowed = s.args.x.toUint(t.uint8); // checked narrowing
      const widened = narrowed.toUint(t.uint256); // free widening
      const signed = s.args.i.toInt(t.int256);
      const crossed = s.args.i.toUint(t.uint128); // cross-sign, checked
      const addr1 = s.args.x.asAddress();
      const addr2 = s.args.w.asAddress();
      const asU = s.args.w.asUint256();
      const asB = s.args.x.asBytes32();
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
    { name: 'cells', args: [arg('x', t.uint256)] },
    (s) => {
      const c = s.let(t.uint256, 0n); // (type, literal) overload
      const d = s.let(s.args.x); // (Expr) overload — type inferred
      c.set(s.args.x);
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
    { name: 'arrs', args: [arg('n', t.uint256)] },
    (s) => {
      const out = s.newArray(t.uint256, s.args.n);
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
      { name: 'argarr', args: [arg('xs', t.array(t.address))] },
      (s) => s.return({ n: s.args.xs.length(), first: s.args.xs.at(0n) }),
      NO_LOC,
    );
    expect(serializeIr(script2.ir)).toMatchSnapshot();
    expect(() => validateIr(script2.ir)).not.toThrow();
    expect(script2.ir.returns.find((r) => r.name === 'first')?.type).toBe('address');
  });
});

// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

describe('s.if', () => {
  const script = evscript(
    { name: 'iffy', args: [arg('x', t.uint256)] },
    (s) => {
      const big = s.let(t.bool, false);
      s.if(
        s.args.x.gt(100n),
        () => {
          big.set(true);
        },
        () => {
          big.set(false);
        },
      );
      s.if(s.args.x.eq(0n), () => {
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
    { name: 'looped', args: [arg('n', t.uint256)] },
    (s) => {
      const total = s.let(t.uint256, 0n);
      const i = s.let(t.uint256, 0n);
      s.while(
        () => i.get().lt(s.args.n),
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
      { name: 'hdr', args: [arg('n', t.uint256)] },
      (s) => {
        const i = s.let(t.uint256, 0n);
        let snapshot: Expr<'uint256'> | undefined;
        s.while(
          () => {
            snapshot = i.get(); // recorded in the header
            return snapshot.lt(s.args.n);
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
    { name: 'fored', args: [arg('n', t.uint256)] },
    (s) => {
      const acc = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: s.args.n }, (i) => {
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
      { name: 'forcont', args: [arg('n', t.uint64)] },
      (s) => {
        const acc = s.let(t.uint64, 0n);
        s.for({ type: t.uint64, from: 0n, until: s.args.n, step: 2n }, (i, loop) => {
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
});

describe('s.select', () => {
  const script = evscript(
    { name: 'sel', args: [arg('c', t.bool), arg('a', t.uint256), arg('b', t.uint256)] },
    (s) =>
      s.return({
        picked: s.select(s.args.c, s.args.a, s.args.b),
        defaulted: s.select(s.args.c, s.args.a, 0n),
      }),
    NO_LOC,
  );

  test('IR snapshot (eager both sides)', () => {
    expect(serializeIr(script.ir)).toMatchSnapshot();
    expect(() => validateIr(script.ir)).not.toThrow();
  });

  test('literal condition folds to the chosen operand (no select stmt)', () => {
    const script2 = evscript(
      { name: 'self', args: [arg('a', t.uint256), arg('b', t.uint256)] },
      (s) => {
        const picked = s.select(true, s.args.a, s.args.b);
        const dropped = s.select(false, s.args.a, s.args.b);
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
    { name: 'calls', args: [arg('pool', t.address), arg('user', t.address)] },
    (s) => {
      const symbol = s.call({ address: s.args.pool, abi: erc20Abi, functionName: 'symbol' });
      const bal = s.call({
        address: s.args.pool,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [s.args.user],
        gas: 100_000n,
      });
      const slot0 = s.call({ address: s.args.pool, abi: poolAbi, functionName: 'slot0' });
      const dec = s.tryCall({ address: s.args.pool, abi: erc20Abi, functionName: 'decimals' });
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
      { name: 'voidcall', args: [arg('pool', t.address)] },
      (s) => {
        const nothing = s.call({ address: s.args.pool, abi: poolAbi, functionName: 'poke' });
        expect(nothing).toBeUndefined();
        const bal = s.call({
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
    expect(script.ir.values[symId]?.debugName).toBe('s.call(symbol)');
  });
});

// ---------------------------------------------------------------------------
// user functions
// ---------------------------------------------------------------------------

describe('s.fn', () => {
  const script = evscript(
    { name: 'fns', args: [arg('owner', t.address), arg('tokens', t.array(t.address))] },
    (s) => {
      const balOf = s.fn(
        'balOf',
        [arg('token', t.address), arg('who', t.address)] as const,
        (token, who) =>
          s.call({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
      );
      const a = balOf(s.args.tokens.at(0n), s.args.owner);
      const b = balOf(s.args.tokens.at(1n), s.args.owner);
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
      { name: 'fnshapes', args: [arg('x', t.uint256)] },
      (s) => {
        const pair = s.fn(
          'pair',
          [arg('a', t.uint256)] as const,
          (a) => [a.add(1n), a.eq(0n)] as const,
        );
        const noop = s.fn('noop', [] as const, () => {});
        const r = pair(s.args.x);
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
      { name: 'uncalled', args: [arg('x', t.uint256)] },
      (s) => {
        s.fn('unused', [arg('a', t.uint256)] as const, (a) => a.add(1n));
        return s.return({ x: s.args.x });
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
        const inc = s.fn('inc', [arg('a', t.uint8)] as const, (a) => a.add(1n));
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
      { name: 'mixed', args: [arg('x', t.uint256)] },
      (s) => {
        const live = s.args.x.add(1n); // bin stmt survives
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
      { name: 'reuse', args: [arg('x', t.uint256)] },
      (s) => {
        const doubled = s.args.x.mul(2n);
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
      { name: 'once', args: [arg('n', t.uint256)] },
      (s) => {
        const i = s.let(t.uint256, 0n);
        s.while(
          () => i.get().lt(s.args.n),
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
    const script = evscript({ name: 'located', args: [arg('x', t.uint256)] }, (s) =>
      s.return({ y: s.args.x.add(1n) }),
    );
    expect(script.ir.loc?.file).toMatch(/script\.test\.ts/);
    const bin = allStmts(script.ir).find((s) => s.k === 'bin');
    expect(bin?.loc?.file).toMatch(/script\.test\.ts/);
    expect(bin?.loc?.line).toBeGreaterThan(0);
  });

  test('locations: false yields null locs everywhere', () => {
    const script = evscript(
      { name: 'unlocated', args: [arg('x', t.uint256)] },
      (s) => s.return({ y: s.args.x.add(1n) }),
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
      { name: 'firstPool', args: [arg('a', t.address), arg('b', t.address)] },
      (s) => {
        const fees = s.lit(t.array(t.uint24), [100n, 500n, 3000n, 10000n]);
        const found = s.let(t.address, ZERO);
        const feeOut = s.let(t.uint24, 0n);
        const i = s.let(t.uint256, 0n);
        s.while(
          () => i.get().lt(fees.length()),
          (loop: LoopCtl) => {
            const fee = fees.at(i.get());
            const pool = s.call({
              address: FACTORY,
              abi: factoryAbi,
              functionName: 'getPool',
              args: [s.args.a, s.args.b, fee],
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
