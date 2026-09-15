/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — user functions, composite fn params, the flagship script.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import { decodeFunctionResult, encodeAbiParameters, encodeErrorResult, getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  expectAgreement,
  ERROR_ABI,
  panicData,
  TOKA,
  TOKB,
  POOL,
  DEAD,
  USER,
  erc20ishAbi,
  sel,
  type CalleeTable,
} from '../../test/harness/differential.js';
import { concatHex, word } from '../../test/harness/fixtures.js';
import { evscript } from '../builder/script.js';
import { namedArg, t } from '../core/types.js';

// ---------------------------------------------------------------------------
// 10. user functions (fncall — no aliasing, calls inside bodies)
// ---------------------------------------------------------------------------

describe('user functions', () => {
  test('fn called twice + multi-result fn (no aliasing); panics propagate through fns', async () => {
    const script = evscript({ name: 'fns', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const double = s.fn('double', [namedArg('x', t.uint256)] as const, (x) => x.add(x));
      const da = double(a);
      const db = double(b);
      const pair = s.fn(
        'pair',
        [namedArg('x', t.uint256), namedArg('y', t.uint256)] as const,
        (x, y) => [x.add(y), x.mul(y)] as const,
      );
      const [sum, prod] = pair(da, db);
      return s.return({ da, db, sum, prod });
    });
    await expectAgreement(script, [
      [2n, 3n],
      [0n, 0n],
      [1n << 255n, 1n], // overflow inside `double` → Panic 0x11
    ]);
  });

  test('fn body records sub-calls (E5 portfolio shape)', async () => {
    const script = evscript(
      { name: 'portfolio', args: [t.address, t.array(t.address)] },
      (s, owner, tokens) => {
        const balOf = s.fn(
          'balOf',
          [namedArg('token', t.address), namedArg('who', t.address)] as const,
          (token, who) =>
            s.read({ address: token, abi: erc20ishAbi, functionName: 'balanceOf', args: [who] }),
        );
        const n = tokens.length();
        const out = s.newArray(t.uint256, n);
        s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
          out.set(i, balOf(tokens.at(i), owner));
        });
        return s.return({ balances: out.expr() });
      },
    );
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: word(111n) },
      [TOKB]: { kind: 'return', data: word(222n) },
    };
    await expectAgreement(
      script,
      [
        [USER, [TOKA, TOKB]],
        [USER, []],
      ],
      table,
    );
  });
});

describe('user functions — composite params (issue #37)', () => {
  const Pair = t.struct({ token: t.address, fee: t.uint24 });
  const Inner = t.struct({ a: t.uint8, b: t.uint256 });
  const Outer = t.struct({ inner: Inner, name: t.string, ids: t.array(t.uint256) });

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`fn takes a struct and returns a member; a script-arg struct passes straight through [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'fnStruct', args: [namedArg('pair', Pair), t.uint24] },
        (s, pair, fee) => {
          const feeOf = s.fn('feeOf', [namedArg('p', Pair)] as const, (p) => p.fee.get());
          const tokenOf = s.fn('tokenOf', Pair, (p) => p.token.get());
          // (a) the script-arg Tuple handle passed by reference (no copy — the same memref);
          // (b) a struct built in the script; (c) a literal object built at the call site;
          // (d) a struct fn RESULT flowing into a struct fn PARAM (Tuple in, Tuple out).
          const built = s.tuple(Pair, { token: TOKB, fee });
          const echo = s.fn('echo', Pair, (p) => p);
          return s.return({
            argFee: feeOf(pair),
            argToken: tokenOf(pair),
            builtFee: feeOf(built),
            litFee: feeOf({ token: TOKA, fee: 500 }),
            echoedToken: tokenOf(echo(pair)),
            echoed: echo(pair),
          });
        },
      );
      const pairA = { token: getAddress(TOKA), fee: 3000 } as const;
      const pairZ = { token: getAddress(DEAD), fee: 0 } as const;
      const [o] = await expectAgreement(
        script,
        [
          [pairA, 100],
          [pairZ, (1 << 24) - 1],
        ],
        {},
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'fnStruct',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        argFee: 3000,
        argToken: pairA.token,
        builtFee: 100,
        litFee: 500,
        echoedToken: pairA.token,
        echoed: pairA,
      });
    });

    test(`fn takes a struct with dynamic members (string, uint256[]) and a nested tuple [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'fnNested', args: [namedArg('outer', Outer), t.uint256] },
        (s, outer, i) => {
          const summary = s.fn(
            'summary',
            [namedArg('o', Outer), namedArg('idx', t.uint256)] as const,
            (o, idx) => {
              const inner = o.inner.get();
              const ids = o.ids.get();
              // (a, b) through the nested Tuple; the string member; the array member's length
              // and a bounds-checked element read (Panic 0x32 on both sides when out of range).
              return [
                inner.a.get(),
                inner.b.get(),
                o.name.get(),
                ids.length(),
                ids.at(idx),
                inner,
              ] as const;
            },
          );
          const [a, b, name, nIds, idAt, inner] = summary(outer, i);
          // the nested Tuple returned by the fn flows into ANOTHER fn's struct param.
          const bOf = s.fn('bOf', Inner, (p) => p.b.get());
          return s.return({ a, b, name, nIds, idAt, bAgain: bOf(inner) });
        },
      );
      const OUTER = {
        inner: { a: 7, b: (1n << 200n) | 5n },
        name: 'evs — composite fn params',
        ids: [11n, 22n, 33n],
      } as const;
      const EMPTY = { inner: { a: 0, b: 0n }, name: '', ids: [] } as const;
      const [o, , oob] = await expectAgreement(
        script,
        [
          [OUTER, 2n],
          [OUTER, 0n],
          [EMPTY, 0n], // ids.at(0) on an empty array → Panic 0x32, agreed on both sides
        ],
        {},
        evmVersion,
      );
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'fnNested',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({
        a: OUTER.inner.a,
        b: OUTER.inner.b,
        name: OUTER.name,
        nIds: 3n,
        idAt: 33n,
        bAgain: OUTER.inner.b,
      });
      expect(oob).toEqual({ kind: 'revert', data: panicData(0x32n) });
    });
  }
});

// ---------------------------------------------------------------------------
// 11. flagship corpus — E1 poolMeta and E2 balances, all three evm versions
// ---------------------------------------------------------------------------

const poolMeta = () =>
  evscript({ name: 'poolMeta', args: [t.address, t.address] }, (s, pool, user) => {
    const token0 = s.read({ address: pool, abi: erc20ishAbi, functionName: 'token0' });
    const token1 = s.read({ address: pool, abi: erc20ishAbi, functionName: 'token1' });
    const slot0 = s.read({ address: pool, abi: erc20ishAbi, functionName: 'slot0' });
    const symbol0 = s.read({ address: token0, abi: erc20ishAbi, functionName: 'symbol' });
    const symbol1 = s.read({ address: token1, abi: erc20ishAbi, functionName: 'symbol' });
    const dec = s.tryRead({ address: token0, abi: erc20ishAbi, functionName: 'decimals' });
    const decimals0 = s.select(dec.success, dec.value, 18);
    const bal0 = s.read({
      address: token0,
      abi: erc20ishAbi,
      functionName: 'balanceOf',
      args: [user],
    });
    return s.return({ token0, token1, symbol0, symbol1, tick: slot0[1], decimals0, bal0 });
  });

describe('flagship', () => {
  const poolTable: CalleeTable = {
    [POOL]: {
      kind: 'dispatch',
      cases: [
        { selector: sel('token0()'), kind: 'return', data: word(BigInt(TOKA)) },
        { selector: sel('token1()'), kind: 'return', data: word(BigInt(TOKB)) },
        {
          selector: sel('slot0()'),
          kind: 'return',
          data: concatHex(word(1n << 96n), word(-887272n)),
        },
      ],
    },
    [TOKA]: {
      kind: 'dispatch',
      cases: [
        {
          selector: sel('symbol()'),
          kind: 'return',
          data: encodeAbiParameters([{ type: 'string' }], ['WETH']),
        },
        {
          selector: sel('decimals()'),
          kind: 'revert',
          data: encodeErrorResult({ abi: ERROR_ABI, errorName: 'Error', args: ['nope'] }),
        },
        { selector: sel('balanceOf(address)'), kind: 'return', data: word(123_456n) },
      ],
    },
    [TOKB]: {
      kind: 'dispatch',
      cases: [
        {
          selector: sel('symbol()'),
          kind: 'return',
          data: encodeAbiParameters([{ type: 'string' }], ['USDC']),
        },
      ],
    },
  };

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`E1 poolMeta — data flows between calls [${evmVersion}]`, async () => {
      const script = poolMeta();
      const [o] = await expectAgreement(script, [[POOL, USER]], poolTable, evmVersion);
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'poolMeta',
        data: o?.data ?? '0x',
      });
      expect(decoded).toMatchObject({
        symbol0: 'WETH',
        symbol1: 'USDC',
        tick: -887272,
        decimals0: 18, // tryCall failed → default
        bal0: 123_456n,
      });
    });
  }

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`E2 balances — loop + tryCall + MutArray output [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'balances', args: [t.array(t.address), t.address] },
        (s, tokens, owner) => {
          const n = tokens.length();
          const out = s.newArray(t.uint256, n);
          s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
            const token = tokens.at(i);
            const r = s.tryRead({
              address: token,
              abi: erc20ishAbi,
              functionName: 'balanceOf',
              args: [owner],
            });
            out.set(i, s.select(r.success, r.value, 0n));
          });
          return s.return({ balances: out.expr() });
        },
      );
      const table: CalleeTable = {
        [TOKA]: { kind: 'return', data: word(11n) },
        [TOKB]: { kind: 'return', data: word(22n) },
        // DEAD stays unmocked → tryCall yields success=false → 0
      };
      const [o] = await expectAgreement(script, [[[TOKA, DEAD, TOKB], USER]], table, evmVersion);
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'balances',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ balances: [11n, 0n, 22n] });
    });
  }
});
