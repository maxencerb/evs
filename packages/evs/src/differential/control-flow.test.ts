/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — control flow, dynamic values, memref equality.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import { decodeFunctionResult } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement, panicData, TOKA } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { t, type Hex } from '../core/types.js';

// ---------------------------------------------------------------------------
// 4. control flow
// ---------------------------------------------------------------------------

describe('control flow', () => {
  test('if/else with cells (checked mul/div inside branches)', async () => {
    const script = evscript({ name: 'health', args: [t.uint256, t.uint256] }, (s, debt, coll) => {
      const ratio = s.let(t.uint256, 0n);
      s.if(
        debt.gt(0n),
        () => ratio.set(coll.mul(10_000n).div(debt)),
        () => ratio.set(s.lit(t.uint256, 2n ** 255n)),
      );
      return s.return({ ratio: ratio.get(), healthy: ratio.get().gte(15_000n) });
    });
    await expectAgreement(script, [
      [0n, 5n],
      [100n, 200n],
      [3n, 1n],
      [1n, 1n << 250n], // mul overflow inside the then-branch → Panic 0x11
    ]);
  });

  test('while with break + continue + cells', async () => {
    const script = evscript({ name: 'loopy', args: [t.uint256] }, (s, n) => {
      const acc = s.let(t.uint256, 0n);
      const i = s.let(t.uint256, 0n);
      s.while(
        () => i.get().lt(n),
        (loop) => {
          const cur = i.get();
          i.set(cur.add(1n));
          s.if(cur.eq(3n), () => loop.continue());
          s.if(acc.get().gt(50n), () => loop.break());
          acc.set(acc.get().add(cur));
        },
      );
      return s.return({ acc: acc.get(), i: i.get() });
    });
    await expectAgreement(script, [[0n], [1n], [5n], [10n], [30n]]);
  });

  test('for over a runtime array arg, collecting into a MutArray', async () => {
    const script = evscript({ name: 'doubleAll', args: [t.array(t.uint64)] }, (s, xs) => {
      const n = xs.length();
      const out = s.newArray(t.uint256, n);
      s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
        out.set(i, xs.at(i).toUint('uint256').mul(2n));
      });
      return s.return({ out: out.expr(), n });
    });
    const max64 = (1n << 64n) - 1n;
    await expectAgreement(script, [[[]], [[1n, 2n, 3n]], [[max64, 0n, 5n]]]);
  });

  test('forEach over a runtime array arg with break/continue (issue #12)', async () => {
    const script = evscript({ name: 'sumSome', args: [t.array(t.uint256)] }, (s, xs) => {
      const out = s.newArray(t.uint256, xs.length());
      const total = s.let(t.uint256, 0n);
      const stopAt = s.let(t.uint256, 0n);
      s.forEach(xs, (x, i, loop) => {
        out.set(i, x.mul(2n)); // checked: Panic 0x11 when 2x overflows
        s.if(x.eq(7n), () => loop.continue()); // skipped from the total, still doubled
        s.if(x.gt(1000n), () => {
          stopAt.set(i);
          loop.break();
        });
        total.set(total.get().add(x));
      });
      return s.return({ out: out.expr(), total: total.get(), stopAt: stopAt.get() });
    });
    await expectAgreement(script, [
      [[]],
      [[1n, 2n, 3n]],
      [[1n, 7n, 3n]], // continue skips the 7
      [[1n, 2000n, 3n]], // break stops before the 3
      [[1n, (1n << 255n) + 1n]], // mul overflow inside the body → Panic 0x11
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. dynamic args / returns + literals (all three evm versions)
// ---------------------------------------------------------------------------

const echoScript = () =>
  evscript(
    { name: 'echoArgs', args: [t.string, t.bytes, t.array(t.int32), t.uint256] },
    (sb, s, b, xs, i) =>
      sb.return({
        s,
        b,
        xs,
        slen: s.length(),
        blen: b.length(),
        n: xs.length(),
        at: xs.at(i), // Panic 0x32 when out of bounds
      }),
  );

describe('dynamic values', () => {
  const LONG = 'a long string deliberately exceeding thirty-two bytes — memcpy territory ✓';

  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`echo string/bytes/int32[] round-trip [${evmVersion}]`, async () => {
      await expectAgreement(
        echoScript(),
        [
          ['hello', '0xdeadbeef', [-3n, 7n, 2147483647n], 1n],
          [LONG, `0x${'ab'.repeat(77)}`, [-2147483648n], 0n],
        ],
        {},
        evmVersion,
      );
    });
  }

  test('out-of-bounds index on a dynamic arg panics 0x32 on both sides', async () => {
    const outcomes = await expectAgreement(echoScript(), [
      ['x', '0x', [1n], 99n],
      ['', '0x', [], 0n],
    ]);
    expect(outcomes[0]?.data).toBe(panicData(0x32n));
    expect(outcomes[1]?.data).toBe(panicData(0x32n));
  });

  test('dynamic + word literals (data segments, CODECOPY materialization)', async () => {
    const script = evscript({ name: 'lits', args: [] }, (s) => {
      const fees = s.lit(t.array(t.uint24), [100n, 500n, 3000n, 10000n]);
      return s.return({
        fees,
        fee1: fees.at(1n),
        n: fees.length(),
        msg: s.lit(t.string, 'hello evs — ütf8 ✓'),
        raw: s.lit(t.bytes, '0x00ff'),
        w: s.lit(t.bytes32, `0x${'11'.repeat(32)}`),
        addr: s.lit(t.address, TOKA),
        flag: s.lit(t.bool, true),
        neg: s.lit(t.int64, -42n),
      });
    });
    await expectAgreement(script, [[]]);
  });
});

// ---------------------------------------------------------------------------
// 5b. memref equality — eq/neq on string/bytes/T[]/string[]/tuple (issue #38, hash equality)
// ---------------------------------------------------------------------------

describe('memref equality (#38): eq/neq lower to keccak256(a) == keccak256(b)', () => {
  const Pair = t.struct({ token: t.address, fee: t.uint24 });
  const script = evscript(
    {
      name: 'memeq',
      args: [
        t.string,
        t.string,
        t.bytes,
        t.bytes,
        t.array(t.uint256),
        t.array(t.uint256),
        'string[]',
        'string[]',
      ],
    },
    (s, sa, sb, ba, bb, ua, ub, ta, tb) => {
      const pair = s.tuple(Pair, { token: TOKA, fee: 500n });
      return s.return({
        sEq: sa.eq(sb),
        sNeq: s.neq(sa, sb),
        bEq: ba.eq(bb),
        bNeq: bb.neq(ba),
        uEq: ua.eq(ub),
        uNeq: s.neq(ua, ub),
        tEq: ta.eq(tb),
        tNeq: ta.neq(tb),
        // literal operands (record-time data consts / built literals)
        sLit: sa.eq('hello'),
        sEmpty: s.eq('', sa),
        uLit: ua.eq([1n, 2n]),
        tLit: ta.neq(['a', 'b']),
        pairLit: pair.expr().eq({ token: TOKA, fee: 500 }),
        pairOther: pair.expr().eq({ token: TOKA, fee: 3000 }),
      });
    },
  );

  const cases: readonly {
    label: string;
    args: readonly [string, string, Hex, Hex, bigint[], bigint[], string[], string[]];
    want: Record<string, boolean>;
  }[] = [
    {
      label: 'all equal (non-empty)',
      args: [
        'hello',
        'hello',
        '0xdeadbeef',
        '0xdeadbeef',
        [1n, 2n],
        [1n, 2n],
        ['a', 'b'],
        ['a', 'b'],
      ],
      want: {
        sEq: true,
        sNeq: false,
        bEq: true,
        bNeq: false,
        uEq: true,
        uNeq: false,
        tEq: true,
        tNeq: false,
        sLit: true,
        sEmpty: false,
        uLit: true,
        tLit: false,
      },
    },
    {
      label: 'all empty',
      args: ['', '', '0x', '0x', [], [], [], []],
      want: {
        sEq: true,
        sNeq: false,
        bEq: true,
        bNeq: false,
        uEq: true,
        uNeq: false,
        tEq: true,
        tNeq: false,
        sLit: false,
        sEmpty: true,
        uLit: false,
        tLit: true,
      },
    },
    {
      label: 'empty vs non-empty',
      args: ['', 'x', '0x', '0x00', [], [0n], [], ['']],
      want: {
        sEq: false,
        sNeq: true,
        bEq: false,
        bNeq: true,
        uEq: false,
        uNeq: true,
        tEq: false,
        tNeq: true,
        sLit: false,
        sEmpty: true,
        uLit: false,
        tLit: true,
      },
    },
    {
      label: 'differ only in length (prefix / trailing element)',
      args: [
        'hello',
        'hello!',
        '0xdeadbeef',
        '0xdeadbeef00',
        [1n, 2n],
        [1n, 2n, 0n],
        ['a', 'b'],
        ['a', 'b', ''],
      ],
      want: {
        sEq: false,
        sNeq: true,
        bEq: false,
        bNeq: true,
        uEq: false,
        uNeq: true,
        tEq: false,
        tNeq: true,
        sLit: true,
        sEmpty: false,
        uLit: true,
        tLit: false,
      },
    },
    {
      label: 'same length, differing content; string[] with the same concatenation is NOT equal',
      args: [
        'hellO',
        'hello',
        '0xdeadbeef',
        '0xdeadbeee',
        [1n, 2n],
        [2n, 1n],
        ['ab', ''],
        ['a', 'b'],
      ],
      want: {
        sEq: false,
        sNeq: true,
        bEq: false,
        bNeq: true,
        uEq: false,
        uNeq: true,
        tEq: false,
        tNeq: true,
        sLit: false,
        sEmpty: false,
        uLit: true,
        tLit: true,
      },
    },
    {
      label: 'long values (> 32 bytes) equal',
      args: [
        'a long string deliberately exceeding thirty-two bytes ✓',
        'a long string deliberately exceeding thirty-two bytes ✓',
        `0x${'ab'.repeat(77)}`,
        `0x${'ab'.repeat(77)}`,
        [1n, 2n, 3n, 4n, 5n],
        [1n, 2n, 3n, 4n, 5n],
        ['a', 'b', 'a long string deliberately exceeding thirty-two bytes ✓'],
        ['a', 'b', 'a long string deliberately exceeding thirty-two bytes ✓'],
      ],
      want: {
        sEq: true,
        sNeq: false,
        bEq: true,
        bNeq: false,
        uEq: true,
        uNeq: false,
        tEq: true,
        tNeq: false,
        sLit: false,
        sEmpty: false,
        uLit: false,
        tLit: true,
      },
    },
  ];

  for (const evmVersion of ['paris', 'cancun'] as const) {
    test(`interp and bytecode agree, and match the expected booleans [${evmVersion}]`, async () => {
      const outcomes = await expectAgreement(
        script,
        cases.map((c) => c.args),
        {},
        evmVersion,
      );
      cases.forEach((c, i) => {
        const o = outcomes[i];
        expect(o?.kind, `${c.label}: outcome`).toBe('return');
        const decoded = decodeFunctionResult({
          abi: script.abi,
          functionName: 'memeq',
          data: o?.data ?? '0x',
        });
        expect(decoded, `${c.label}: decoded booleans`).toMatchObject({
          ...c.want,
          pairLit: true,
          pairOther: false,
        });
      });
    });
  }
});
