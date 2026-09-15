/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — issue #5 ergonomics, custom errors, revertReturns, simulate follow-ups, frame allocator stress.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import type { Abi } from 'abitype';
import { decodeFunctionResult, encodeAbiParameters } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { MockQuoter } from '../../test/generated/index.js';
import {
  expectAgreement,
  panicData,
  TOKA,
  TOKB,
  POOL,
  REVERTER,
  USER,
  sel,
  EVM_VERSIONS,
  type CalleeTable,
} from '../../test/harness/differential.js';
import { concatHex, word } from '../../test/harness/fixtures.js';
import { evscript } from '../builder/script.js';
import { namedArg, t, type Hex } from '../core/types.js';

// ---------------------------------------------------------------------------
// 13. issue #5 ergonomics — struct: true multi-output decode + composite s.fn returns
// ---------------------------------------------------------------------------

// `bare` returns the MutArray directly (#5); otherwise via `.expr()` — must be byte-identical IR.
function fillScript(bare: boolean) {
  return evscript({ name: 'fill', args: [t.uint256] }, (s, n) => {
    const xs = s.newArray(t.uint256, n);
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      xs.set(i, i.mul(2n));
    });
    return s.return({ xs: bare ? xs : xs.expr() });
  });
}

describe('issue #5 ergonomics', () => {
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
  ] as const satisfies Abi;
  const erc20 = [
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
  ] as const satisfies Abi;

  const PRICE = 1n << 96n;
  const TICK = -887_272; // int24 ≤ 48 bits → abitype/viem types it as `number`
  const slot0Data = encodeAbiParameters(
    [{ type: 'uint160' }, { type: 'int24' }, { type: 'bool' }],
    [PRICE, TICK, true],
  );
  const poolTable: CalleeTable = {
    [POOL]: {
      kind: 'dispatch',
      cases: [{ selector: sel('slot0()'), kind: 'return', data: slot0Data }],
    },
  };
  const tokTable: CalleeTable = {
    [TOKA]: {
      kind: 'dispatch',
      cases: [
        {
          selector: sel('symbol()'),
          kind: 'return',
          data: encodeAbiParameters([{ type: 'string' }], ['WETH']),
        },
        { selector: sel('decimals()'), kind: 'return', data: word(18n) },
      ],
    },
  };

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`s.read({ struct: true }) decodes named outputs into one struct [${evmVersion}]`, async () => {
      const script = evscript({ name: 'slot0Struct', args: [t.address] }, (s, pool) => {
        const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0', struct: true });
        return s.return({ slot0 });
      });
      const [o] = await expectAgreement(script, [[POOL]], poolTable, evmVersion);
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'slot0Struct',
        data: o?.data ?? '0x',
      });
      // viem infers an object from the named struct output — same field names + ABI order.
      expect(decoded).toEqual({
        slot0: { sqrtPriceX96: PRICE, tick: TICK, unlocked: true },
      });
    });

    test(`an s.fn returns a struct directly; the caller decodes it [${evmVersion}]`, async () => {
      const TokenMeta = t.struct({ symbol: t.string, decimals: t.uint8 });
      const script = evscript({ name: 'tokMeta', args: [t.address] }, (s, token) => {
        const getMeta = s.fn('getMeta', [namedArg('tok', t.address)] as const, (tok) =>
          s.tuple(TokenMeta, {
            symbol: s.read({ address: tok, abi: erc20, functionName: 'symbol' }),
            decimals: s.read({ address: tok, abi: erc20, functionName: 'decimals' }),
          }),
        );
        return s.return({ meta: getMeta(token) });
      });
      const [o] = await expectAgreement(script, [[TOKA]], tokTable, evmVersion);
      expect(o?.kind).toBe('return');
      const decoded = decodeFunctionResult({
        abi: script.abi,
        functionName: 'tokMeta',
        data: o?.data ?? '0x',
      });
      expect(decoded).toEqual({ meta: { symbol: 'WETH', decimals: 18 } });
    });

    test(`a bare MutArray return is byte-identical to .expr() on-chain [${evmVersion}]`, async () => {
      const [bare] = await expectAgreement(fillScript(true), [[4n]], {}, evmVersion);
      const [viaExpr] = await expectAgreement(fillScript(false), [[4n]], {}, evmVersion);
      expect(bare?.data).toBe(viaExpr?.data);
      const decoded = decodeFunctionResult({
        abi: fillScript(true).abi,
        functionName: 'fill',
        data: bare?.data ?? '0x',
      });
      expect(decoded).toEqual({ xs: [0n, 2n, 4n, 6n] });
    });
  }
});

// ---------------------------------------------------------------------------
// 14. custom errors — s.throw revert payloads (issue #15)
// ---------------------------------------------------------------------------

describe('custom errors (issue #15)', () => {
  const NoBalance = t.error('NoBalance', [
    namedArg('balance', t.uint256),
    namedArg('who', t.address),
  ]);
  const NotOwner = t.error('NotOwner');
  const Tagged = t.error('Tagged', [
    namedArg('note', t.string),
    namedArg('xs', t.array(t.uint256)),
  ]);

  function guardScript() {
    return evscript(
      {
        name: 'guard',
        args: [namedArg('x', t.uint256), namedArg('who', t.address)],
        errors: [NoBalance, NotOwner],
      },
      (s, x, who) => {
        s.if(x.lt(10n), () => {
          s.throw(NoBalance, { balance: x, who });
        });
        s.if(x.eq(999n), () => {
          s.throw(NotOwner);
        });
        return s.return({ doubled: x.mul(2n) });
      },
    );
  }

  const WHO = '0xb000000000000000000000000000000000000002' as const;

  for (const evmVersion of EVM_VERSIONS) {
    test(`throw payloads agree byte-for-byte (with-args / zero-arg / success) [${evmVersion}]`, async () => {
      const outcomes = await expectAgreement(
        guardScript(),
        [
          [5n, WHO], // NoBalance(5, WHO)
          [0n, WHO], // NoBalance(0, WHO)
          [999n, WHO], // NotOwner()
          [21n, WHO], // success
        ],
        {},
        evmVersion,
      );
      expect(outcomes[0]?.kind).toBe('revert');
      expect(outcomes[2]?.kind).toBe('revert');
      expect(outcomes[2]?.data.length).toBe(2 + 8); // bare selector
      expect(outcomes[3]?.kind).toBe('return');
    });

    test(`dynamic error args (string + uint256[]) agree [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'dynErr', args: [namedArg('n', t.uint256)], errors: [Tagged] },
        (s, n) => {
          const xs = s.newArray(t.uint256, n);
          s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
            xs.set(i, i.mul(3n));
          });
          s.if(n.gt(0n), () => {
            s.throw(Tagged, { note: s.lit(t.string, 'boom'), xs });
          });
          return s.return({ n });
        },
      );
      const outcomes = await expectAgreement(script, [[3n], [0n]], {}, evmVersion);
      expect(outcomes[0]?.kind).toBe('revert');
      expect(outcomes[1]?.kind).toBe('return');
    });

    test(`a throw inside an s.fn body agrees [${evmVersion}]`, async () => {
      const Boom = t.error('Boom', [namedArg('x', t.uint256)]);
      const script = evscript({ name: 'fnThrow', args: [t.uint256], errors: [Boom] }, (s, x) => {
        const check = s.fn('check', t.uint256, (v) => {
          s.if(s.gt(v, 100n), () => {
            s.throw(Boom, { x: v });
          });
          return s.add(v, 1n);
        });
        return s.return({ out: check(x) });
      });
      const outcomes = await expectAgreement(script, [[500n], [1n]], {}, evmVersion);
      expect(outcomes[0]?.kind).toBe('revert');
      expect(outcomes[1]?.kind).toBe('return');
    });
  }
});

// ---------------------------------------------------------------------------
// revertReturns (issue #35) — s.call / s.tryCall decode the REVERT payload as the result
// ---------------------------------------------------------------------------

describe('revertReturns (issue #35)', () => {
  const QUOTER = '0xf100000000000000000000000000000000000001';
  const quoterV1Abi = [
    {
      type: 'function',
      name: 'quoteExactInput',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'amountIn', type: 'uint256' }],
      outputs: [], // QuoterV1 declares none — the amount arrives in the revert data
    },
    {
      type: 'function',
      name: 'quoteMany',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: [{ name: 'ignored', type: 'bool' }], // ignored under revertReturns
    },
  ] as const;

  const strictScript = () =>
    evscript({ name: 'rrStrict', args: [t.uint256] }, (s, amountIn) => {
      const amountOut = s.call({
        address: QUOTER,
        abi: quoterV1Abi,
        functionName: 'quoteExactInput',
        args: [amountIn],
        revertReturns: [t.uint256],
      });
      return s.return({ amountOut });
    });

  const tryScript = () =>
    evscript({ name: 'rrTry', args: [t.uint256] }, (s, amountIn) => {
      const r = s.tryCall({
        address: QUOTER,
        abi: quoterV1Abi,
        functionName: 'quoteExactInput',
        args: [amountIn],
        revertReturns: [t.uint256],
      });
      return s.return({
        ok: r.success,
        amountOut: r.value,
        picked: s.select(r.success, r.value, 1n),
      });
    });

  test('strict: the revert payload IS the result', async () => {
    const [o] = await expectAgreement(strictScript(), [[100n]], {
      [QUOTER]: { kind: 'revert', data: word(150n) },
    });
    expect(o?.kind).toBe('return');
    expect(o?.data).toBe(encodeAbiParameters([{ type: 'uint256' }], [150n]));
  });

  test('strict: a normal return is the failure → EvsDecodeError(site), never bubbled', async () => {
    for (const data of ['0x', word(150n)] as const) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const [o] = await expectAgreement(strictScript(), [[100n]], {
        [QUOTER]: { kind: 'return', data },
      });
      expect(o?.kind).toBe('revert');
      expect(o?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
    }
    // an unmocked (code-less) target: the CALL succeeds with empty returndata → the same failure
    const [ghost] = await expectAgreement(strictScript(), [[100n]]);
    expect(ghost?.kind).toBe('revert');
    expect(ghost?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
  });

  test('strict: a short revert payload trips the staticMinSize guard (same as returndata)', async () => {
    const [o] = await expectAgreement(strictScript(), [[100n]], {
      [QUOTER]: { kind: 'revert', data: '0xdeadbeef' },
    });
    expect(o?.kind).toBe('revert');
    expect(o?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
  });

  test('try: revert → success + value; return / malformed / unmocked → success=false, zero', async () => {
    const decodeOut = (data: Hex | undefined) =>
      decodeFunctionResult({ abi: tryScript().abi, functionName: 'rrTry', data: data ?? '0x' });
    const [ok] = await expectAgreement(tryScript(), [[100n]], {
      [QUOTER]: { kind: 'revert', data: word(150n) },
    });
    expect(decodeOut(ok?.data)).toEqual({ ok: true, amountOut: 150n, picked: 150n });

    const [ret] = await expectAgreement(tryScript(), [[100n]], {
      [QUOTER]: { kind: 'return', data: word(150n) },
    });
    expect(decodeOut(ret?.data)).toEqual({ ok: false, amountOut: 0n, picked: 1n });

    const [bad] = await expectAgreement(tryScript(), [[100n]], {
      [QUOTER]: { kind: 'revert', data: '0x08c379a0' },
    });
    expect(decodeOut(bad?.data)).toEqual({ ok: false, amountOut: 0n, picked: 1n });

    const [ghost] = await expectAgreement(tryScript(), [[100n]]);
    expect(decodeOut(ghost?.data)).toEqual({ ok: false, amountOut: 0n, picked: 1n });
  });

  test('dynamic + struct revert outputs decode with the full bounds sequence', async () => {
    const Quote = t.struct({ amount: t.uint256, ok: t.bool });
    const script = evscript({ name: 'rrMany', args: [] }, (s) => {
      const [n, str, list, q] = s.call({
        address: QUOTER,
        abi: quoterV1Abi,
        functionName: 'quoteMany',
        revertReturns: [t.uint256, t.string, t.array(t.uint8), Quote],
      });
      return s.return({
        n,
        str,
        list,
        len: list.length(),
        amount: q.amount.get(),
        okq: q.ok.get(),
      });
    });
    const payload = encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'string' },
        { type: 'uint8[]' },
        {
          type: 'tuple',
          components: [
            { name: 'amount', type: 'uint256' },
            { name: 'ok', type: 'bool' },
          ],
        },
      ],
      [7n, 'PEPE', [1, 2, 3], { amount: 99n, ok: true }],
    );
    const [o] = await expectAgreement(script, [[]], {
      [QUOTER]: { kind: 'revert', data: payload },
    });
    expect(
      decodeFunctionResult({ abi: script.abi, functionName: 'rrMany', data: o?.data ?? '0x' }),
    ).toEqual({ n: 7n, str: 'PEPE', list: [1, 2, 3], len: 3n, amount: 99n, okq: true });

    // attacker-shaped revert payload: a string offset past 2^64 → decode failure, not a halt
    const evil = concatHex(word(7n), word(1n << 64n), word(0x80n), word(0xa0n));
    const [e] = await expectAgreement(script, [[]], { [QUOTER]: { kind: 'revert', data: evil } });
    expect(e?.kind).toBe('revert');
    expect(e?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
  });

  test('the real MockQuoter artifact: quoteExactInputReverting (QuoterV1) vs quoteExactInput (V2)', async () => {
    // Both legs see the SAME solc bytecode: the EVM leg runs it (a real CALL frame — the quoter
    // writes storage before reverting), the interpreter leg gets the independently computed reply.
    const table: CalleeTable = {
      [QUOTER]: {
        kind: 'bytecode',
        runtime: MockQuoter.deployedBytecode,
        respond: (calldata) => {
          const amountIn = BigInt(`0x${calldata.slice(10, 74)}`);
          const out = word((amountIn * 3n) / 2n);
          const selector = calldata.slice(0, 10).toLowerCase();
          if (selector === sel('quoteExactInputReverting(uint256)'))
            return { success: false, data: out };
          if (selector === sel('quoteExactInput(uint256)')) return { success: true, data: out };
          return { success: false, data: '0x' };
        },
      },
    };
    const script = evscript({ name: 'quoter', args: [t.uint256] }, (s, amountIn) => {
      // V1: the quote arrives via revert data
      const v1 = s.call({
        address: QUOTER,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInputReverting',
        args: [amountIn],
        revertReturns: [t.uint256],
      });
      // V1 through tryCall
      const v1try = s.tryCall({
        address: QUOTER,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInputReverting',
        args: [amountIn],
        revertReturns: [t.uint256],
      });
      // V2 (returns normally) under revertReturns: the normal return is the FAILURE
      const v2asV1 = s.tryCall({
        address: QUOTER,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInput',
        args: [amountIn],
        revertReturns: [t.uint256],
      });
      // V2 read the normal way, for reference
      const v2 = s.call({
        address: QUOTER,
        abi: MockQuoter.abi,
        functionName: 'quoteExactInput',
        args: [amountIn],
      });
      return s.return({
        v1,
        ok1: v1try.success,
        v1b: v1try.value,
        okV2asV1: v2asV1.success,
        v2asV1: v2asV1.value,
        v2,
      });
    });
    const [o] = await expectAgreement(script, [[100n]], table);
    expect(
      decodeFunctionResult({ abi: script.abi, functionName: 'quoter', data: o?.data ?? '0x' }),
    ).toEqual({ v1: 150n, ok1: true, v1b: 150n, okV2asV1: false, v2asV1: 0n, v2: 150n });
  });
});

// ---------------------------------------------------------------------------
// simulate follow-ups (issue #36): simulate inside s.fn bodies, chained simulates, gas caps —
// interpreter and trampoline bytecode must agree byte-for-byte on both forks (the wrapper
// payload memcpy takes the MCOPY path on cancun and the `@memcpy` loop on paris).
// ---------------------------------------------------------------------------

describe('simulate follow-ups (issue #36)', () => {
  const vaultAbi = [
    {
      type: 'function',
      name: 'deposit',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'amount', type: 'uint256' }],
      outputs: [{ name: 'shares', type: 'uint256' }],
    },
    {
      type: 'function',
      name: 'label',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'note', type: 'string' }],
      outputs: [
        { name: 'shares', type: 'uint256' },
        { name: 'echo', type: 'string' },
      ],
    },
  ] as const satisfies Abi;

  for (const evmVersion of ['cancun', 'paris'] as const) {
    test(`simulate inside an s.fn (called twice) + a simulate fed by a simulate [${evmVersion}]`, async () => {
      const script = evscript({ name: 'nestedSim', args: [t.uint256] }, (s, amount) => {
        const preview = s.fn('preview', [t.uint256], (a) =>
          s.simulate({ address: TOKA, abi: vaultAbi, functionName: 'deposit', args: [a] }),
        );
        const first = preview(amount);
        const second = preview(first);
        const [shares, echo] = s.simulate({
          address: TOKB,
          abi: vaultAbi,
          functionName: 'label',
          args: [s.lit(t.string, 'dry-run')],
        });
        const third = s.simulate({
          address: TOKA,
          abi: vaultAbi,
          functionName: 'deposit',
          args: [s.add(s.add(first, second), shares)],
        });
        return s.return({ first, second, third, echo });
      });
      const table: CalleeTable = {
        [TOKA]: { kind: 'return', data: word(200n) },
        [TOKB]: {
          kind: 'return',
          data: encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [5n, 'dry-run']),
        },
      };
      const [o] = await expectAgreement(script, [[100n]], table, evmVersion);
      expect(
        decodeFunctionResult({ abi: script.abi, functionName: 'nestedSim', data: o?.data ?? '0x' }),
      ).toEqual({ first: 200n, second: 200n, third: 200n, echo: 'dry-run' });
    });

    test(`trySimulate with a gas cap: revert → false, success → value; strict bubbles [${evmVersion}]`, async () => {
      const script = evscript({ name: 'cappedSim', args: [t.uint256], errors: [] }, (s, cap) => {
        const bad = s.trySimulate({
          address: REVERTER,
          abi: vaultAbi,
          functionName: 'deposit',
          args: [1n],
          gas: cap,
        });
        const good = s.trySimulate({
          address: TOKA,
          abi: vaultAbi,
          functionName: 'deposit',
          args: [2n],
          gas: 150_000n,
        });
        const strict = s.simulate({
          address: TOKA,
          abi: vaultAbi,
          functionName: 'deposit',
          args: [good.value],
          gas: cap,
        });
        return s.return({
          badOk: bad.success,
          bad: bad.value,
          goodOk: good.success,
          good: good.value,
          strict,
        });
      });
      const table: CalleeTable = {
        [REVERTER]: { kind: 'revert', data: panicData(0x11n) },
        [TOKA]: { kind: 'return', data: word(9n) },
      };
      const [o] = await expectAgreement(script, [[100_000n]], table, evmVersion);
      expect(
        decodeFunctionResult({ abi: script.abi, functionName: 'cappedSim', data: o?.data ?? '0x' }),
      ).toEqual({ badOk: false, bad: 0n, goodOk: true, good: 9n, strict: 9n });

      // strict + reverting target: the simulated write's revert bubbles verbatim through the hop
      const bubbling = evscript({ name: 'bubbleSim', args: [] }, (s) => {
        const shares = s.simulate({
          address: REVERTER,
          abi: vaultAbi,
          functionName: 'deposit',
          args: [1n],
          gas: 100_000n,
        });
        return s.return({ shares });
      });
      const [r] = await expectAgreement(bubbling, [[]], table, evmVersion);
      expect(r).toEqual({ kind: 'revert', data: panicData(0x11n) });
    });
  }
});

// ---------------------------------------------------------------------------
// frame allocator stress (issue #41) — shapes where the optimized twin reuses slots: straight
// chains, values crossing loop back-edges, nested loops, exclusive if-branches, fn calls with
// live caller temporaries, encode/keccak memref temporaries. Any wrong reuse shows up here as
// a payload mismatch against the interpreter.
// ---------------------------------------------------------------------------

describe('frame allocator stress (issue #41)', () => {
  test('long straight-line chain of temporaries; one early temporary kept live to the end', async () => {
    const script = evscript({ name: 'chain', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const first = s.add(a, b); // live across the whole chain
      let x = first;
      for (let i = 0; i < 40; i++) {
        x = s.add(s.mul(x, 3n), s.lit(t.uint256, BigInt(i)));
      }
      const y = s.select(x.gt(first), x, first);
      return s.return({ x, y, first, sum: s.add(y, first) });
    });
    await expectAgreement(script, [
      [0n, 0n],
      [1n, 2n],
      [1n << 100n, 5n],
      [1n << 200n, 1n], // ×3 forty times overflows → Panic 0x11 mid-chain
    ]);
  });

  test('values defined before a loop and read inside stay live across every iteration', async () => {
    const script = evscript({ name: 'carried', args: [t.uint256, t.uint256] }, (s, n, a) => {
      const base = s.mul(a, 2n); // read in the body every iteration
      const step = s.add(a, 1n); // read late in the body, after the body's own temporaries
      const acc = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n }, (i) => {
        const t1 = s.mul(i, 3n);
        const t2 = s.add(t1, base);
        acc.set(acc.get().add(t2));
        const t3 = s.add(acc.get(), step);
        acc.set(t3);
        const t4 = s.mul(t3, 1n);
        acc.set(t4);
      });
      return s.return({ acc: acc.get(), base, step });
    });
    await expectAgreement(script, [
      [0n, 5n],
      [3n, 7n],
      [10n, 1n],
      [4n, 1n << 254n], // acc overflows on the second iteration → Panic 0x11
    ]);
  });

  test('while: value from before the loop read after a continue; temporaries around break', async () => {
    const script = evscript({ name: 'loopreuse', args: [t.uint256, t.uint256] }, (s, n, k) => {
      const bound = s.mul(k, 2n); // read only after the `continue` check
      const i = s.let(t.uint256, 0n);
      const acc = s.let(t.uint256, 0n);
      s.while(
        () => i.get().lt(n),
        (loop) => {
          const cur = i.get();
          i.set(cur.add(1n));
          const t1 = s.mul(cur, 7n);
          s.if(t1.eq(14n), () => loop.continue());
          const t2 = s.add(t1, bound);
          s.if(t2.gt(100n), () => loop.break());
          acc.set(acc.get().add(t2));
          const last = s.add(cur, bound);
          acc.set(acc.get().add(last));
        },
      );
      return s.return({ acc: acc.get(), i: i.get(), bound });
    });
    await expectAgreement(script, [
      [0n, 1n],
      [3n, 1n],
      [10n, 3n],
      [40n, 0n],
    ]);
  });

  test('nested loops: temporaries crossing both back-edges', async () => {
    const script = evscript({ name: 'nested', args: [t.uint256, t.uint256] }, (s, n, m) => {
      const outerK = s.add(n, m); // defined before both loops, read in the inner body
      const acc = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n }, (i) => {
        const oi = s.mul(i, 10n); // read in the inner loop and after it
        s.for({ from: 0n, until: m }, (j) => {
          const t1 = s.add(oi, j);
          const t2 = s.add(t1, outerK);
          acc.set(acc.get().add(t2));
        });
        acc.set(acc.get().add(oi));
        const after = s.mul(oi, 2n);
        acc.set(acc.get().add(after));
      });
      return s.return({ acc: acc.get(), outerK });
    });
    await expectAgreement(script, [
      [0n, 0n],
      [1n, 1n],
      [3n, 4n],
      [5n, 0n],
    ]);
  });

  test('if branches: exclusive-branch temporaries; values live through and past the if', async () => {
    const script = evscript({ name: 'branchy', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const p = s.add(a, 1n);
      const q = s.mul(b, 2n);
      const r = s.let(t.uint256, 0n);
      s.if(
        a.gt(b),
        () => {
          const t1 = s.add(p, q);
          const t2 = s.mul(t1, 2n);
          const t3 = s.sub(t2, p);
          r.set(t3);
        },
        () => {
          const u1 = s.mul(q, 3n);
          const u2 = s.add(u1, q);
          r.set(u2);
        },
      );
      const afterP = s.add(p, r.get()); // p still live after the if
      s.if(afterP.gt(10n), () => {
        r.set(s.add(r.get(), q)); // q read only inside this then-branch
      });
      const tail = s.add(r.get(), afterP);
      return s.return({ r: r.get(), tail });
    });
    await expectAgreement(script, [
      [0n, 0n],
      [5n, 2n],
      [2n, 5n],
      [1n << 255n, 1n], // then-branch: t2 = 2·t1 overflows → Panic 0x11
    ]);
  });

  test('fn calls interleaved with live caller temporaries; fn bodies with their own chains', async () => {
    const script = evscript({ name: 'fnmix', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const chain3 = s.fn('chain3', [namedArg('x', t.uint256)] as const, (x) => {
        const c1 = x.add(x);
        const c2 = c1.mul(3n);
        const c3 = c2.sub(x);
        return c3;
      });
      const t1 = s.mul(a, 3n); // live across both calls
      const d1 = chain3(a);
      const t2 = s.add(t1, d1); // live across the second call
      const d2 = chain3(b);
      const t3 = s.add(t2, d2);
      const d3 = chain3(t3);
      return s.return({ t1, t2, t3, d1, d2, d3 });
    });
    await expectAgreement(script, [
      [0n, 0n],
      [1n, 2n],
      [7n, 11n],
      [1n << 250n, 1n], // c2 = 3·(2x) overflows → Panic 0x11 inside the fn
    ]);
  });

  test('encode / keccak256 temporaries (memref pointers in reused slots)', async () => {
    const script = evscript({ name: 'hashes', args: [t.uint256, t.address] }, (s, a, who) => {
      const e1 = s.encode(a, who);
      const h1 = s.keccak256(e1);
      const e2 = s.encodePacked(h1, a);
      const h2 = s.keccak256(e2);
      const e3 = s.encode(h1, h2, a);
      const h3 = s.keccak256(e3);
      const n1 = e1.length(); // e1 read again after later temporaries
      const n2 = s.add(n1, e2.length());
      return s.return({ h1, h2, h3, n2, e3 });
    });
    await expectAgreement(script, [
      [0n, TOKA],
      [123_456_789n, USER],
    ]);
  });
});
