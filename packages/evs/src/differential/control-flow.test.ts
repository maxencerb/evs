/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — control flow, dynamic values, memref equality.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import { decodeFunctionResult, encodeAbiParameters } from 'viem';
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

  test('literal indices: constant bound + offset, huge literals still panic 0x32', async () => {
    // a literal index below 2^32 compiles to a constant bound and offset; a larger one keeps
    // the runtime sequence (2^256 − 1 + 1 would wrap a folded bound to 0)
    const huge = [(1n << 32n) - 1n, 1n << 32n, (1n << 256n) - 1n];
    const reads = [0n, 2n, 3n, ...huge].map((k) =>
      evscript({ name: 'at', args: [t.array(t.uint256), t.uint256] }, (s, xs, n) => {
        const out = s.newArray(t.uint256, n);
        out.set(k, 42n);
        return s.return({ x: xs.at(k), out: out.expr() });
      }),
    );
    // n > xs.length in the 2nd row: `set(3n)` succeeds there, so `xs.at(3n)` itself must panic
    const rows = [
      [[7n, 8n, 9n], 3n],
      [[7n, 8n, 9n], 4n],
      [[7n, 8n, 9n, 10n], 4n],
      [[], 0n],
    ];
    const outcomes = await Promise.all(reads.map((script) => expectAgreement(script, rows)));
    // k = 3n (index 2): row 1 panics in `set`, row 2 in the read, row 3 reads 10
    expect(outcomes[2]?.[1]?.data).toBe(panicData(0x32n));
    expect(outcomes[2]?.[2]?.data).not.toBe(panicData(0x32n));
    // read-only scripts: every literal's read arm (constant and runtime) on its own
    const readOnly = [0n, 2n, 3n, ...huge].map((k) =>
      evscript({ name: 'atOnly', args: [t.array(t.uint256)] }, (s, xs) =>
        s.return({ x: xs.at(k) }),
      ),
    );
    const readOutcomes = await Promise.all(
      readOnly.map((script) =>
        expectAgreement(script, [[[7n, 8n, 9n]], [[7n, 8n, 9n, 10n]], [[]]]),
      ),
    );
    // out-of-bounds literal reads (k = 3 on a 3-element array, every huge k) panic 0x32
    expect(readOutcomes[2]?.[0]?.data).toBe(panicData(0x32n));
    for (const o of readOutcomes.slice(3)) for (const r of o) expect(r.data).toBe(panicData(0x32n));
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

describe('memref equality: a constant literal operand is hashed at record time', () => {
  // every flat literal shape, each compared twice: `x.eq(LIT)` (the literal's hash folded into a
  // bytes32 const) and the runtime spelling `s.keccak256(x).eq(s.keccak256(s.lit(type, LIT)))`
  // (the literal materialized and hashed by the script). Both must agree on every input.
  const STR = 'évs — a literal longer than one 32-byte word ✓';
  const BYTES: Hex = '0xDEADbeef00'; // mixed case: canonicalized like the materialized literal
  const I8 = [-1, 127, -128] as const; // narrow signed words: sign-extended
  const ADDR2 = ['0x00000000000000000000000000000000DeaDBeef', TOKA] as const; // static T[N]
  const B4 = ['0x01020304', '0xffffffff'] as const; // left-aligned words
  const FLAGS = [true, false] as const;
  const script = evscript(
    {
      name: 'litfold',
      args: [
        t.string,
        t.bytes,
        t.array(t.int8),
        t.array(t.address, 2),
        t.array(t.bytes4),
        t.array(t.bool),
      ],
    },
    (s, str, b, i8, a2, b4, flags) =>
      s.return({
        str: str.eq(STR),
        strRt: s.keccak256(str).eq(s.keccak256(s.lit(t.string, STR))),
        empty: s.neq('', str),
        emptyRt: s.keccak256(s.lit(t.string, '')).neq(s.keccak256(str)),
        bytes: b.eq(BYTES),
        bytesRt: s.keccak256(b).eq(s.keccak256(s.lit(t.bytes, BYTES))),
        i8: i8.eq(I8),
        i8Rt: s.keccak256(i8).eq(s.keccak256(s.lit(t.array(t.int8), I8))),
        a2: a2.eq(ADDR2),
        a2Rt: s.keccak256(a2).eq(s.keccak256(s.lit(t.array(t.address, 2), ADDR2))),
        b4: b4.neq(B4),
        b4Rt: s.keccak256(b4).neq(s.keccak256(s.lit(t.array(t.bytes4), B4))),
        flags: flags.eq(FLAGS),
        flagsRt: s.keccak256(flags).eq(s.keccak256(s.lit(t.array(t.bool), FLAGS))),
      }),
  );

  test('the folded operands record no keccak256 of their own', () => {
    const hashes = script.ir.body.filter((x) => x.k === 'keccak256');
    // 7 folded compares hash only their Expr side; 7 runtime compares hash both sides
    expect(hashes).toHaveLength(7 + 2 * 7);
  });

  for (const evmVersion of ['paris', 'cancun'] as const) {
    test(`folded and runtime hashes agree on equal and unequal inputs [${evmVersion}]`, async () => {
      const zeroAddr = `0x${'00'.repeat(20)}`;
      const argSets = [
        [STR, BYTES.toLowerCase(), I8.map(BigInt), ADDR2, B4, FLAGS], // all equal
        ['', '0x', [], [zeroAddr, zeroAddr], [], []], // all empty / zero
        [`${STR}!`, '0xdeadbeef', [-1n, 127n], [TOKA, ADDR2[0]], ['0x01020304'], [true, true]],
      ] as const;
      const outcomes = await expectAgreement(script, argSets, {}, evmVersion);
      const results = outcomes.map((o, i) => {
        expect(o.kind, `args #${i}: outcome`).toBe('return');
        return decodeFunctionResult({ abi: script.abi, functionName: 'litfold', data: o.data });
      });
      results.forEach((r, i) => {
        for (const key of ['str', 'empty', 'bytes', 'i8', 'a2', 'b4', 'flags'] as const) {
          expect(r[key], `args #${i}: ${key}`).toBe(r[`${key}Rt`]);
        }
      });
      // the all-equal inputs: every compare holds except the `b4` neq
      expect(results[0]).toMatchObject({ str: true, empty: true, bytes: true, i8: true });
      expect(results[0]).toMatchObject({ a2: true, b4: false, flags: true });
    });
  }
});

// ---------------------------------------------------------------------------
// counter loops under dominating guard facts (#97): codegen drops the step's overflow check and
// the element bounds check the loop guard proves (`codegen/lower/guards.ts`); the interpreter
// keeps both, so these pin the elision at the edges where it would matter
// ---------------------------------------------------------------------------

describe('counter loops: proven step and bounds checks (#97)', () => {
  const MAX256 = (1n << 256n) - 1n;

  test('a uint8 counter stepping onto max(uint8) exactly', async () => {
    const script = evscript({ name: 'u8edge', args: [t.uint8, t.uint8] }, (s, from, until) => {
      const count = s.let(t.uint256, 0n);
      const last = s.let(t.uint8, 0n);
      s.for({ type: t.uint8, from, until }, (i) => {
        count.set(count.get().add(1n));
        last.set(i);
      });
      return s.return({ count: count.get(), last: last.get() });
    });
    await expectAgreement(script, [
      [250n, 255n],
      [254n, 255n],
      [255n, 255n],
      [0n, 0n],
      [7n, 3n],
    ]);
  });

  test('a uint256 counter stepping onto 2^256 − 1 exactly', async () => {
    const script = evscript(
      { name: 'u256edge', args: [t.uint256, t.uint256] },
      (s, from, until) => {
        const count = s.let(t.uint256, 0n);
        const last = s.let(t.uint256, 0n);
        s.for({ from, until }, (i) => {
          count.set(count.get().add(1n));
          last.set(i);
        });
        return s.return({ count: count.get(), last: last.get() });
      },
    );
    await expectAgreement(script, [
      [MAX256 - 3n, MAX256],
      [MAX256 - 1n, MAX256],
      [MAX256, MAX256],
    ]);
  });

  test('int8 counters: from −128 with a break, and a short range ending at 127', async () => {
    const script = evscript(
      { name: 'i8edge', args: [t.int8, t.int8, t.uint8] },
      (s, from, until, stopAfter) => {
        const count = s.let(t.uint8, 0n);
        const last = s.let(t.int8, 0n);
        s.for({ type: t.int8, from, until }, (i, loop) => {
          s.if(count.get().eq(stopAfter), () => loop.break());
          count.set(count.get().add(1n));
          last.set(i);
        });
        return s.return({ count: count.get(), last: last.get() });
      },
    );
    await expectAgreement(script, [
      [-128n, 127n, 4n],
      [124n, 127n, 255n],
      [126n, 127n, 255n],
      [-2n, 2n, 255n],
      [127n, 127n, 255n],
    ]);
  });

  test('a step of 2 near max(uint8) still Panics 0x11 (not proven)', async () => {
    const script = evscript({ name: 'u8step2', args: [t.uint8] }, (s, from) => {
      const last = s.let(t.uint8, 0n);
      s.for({ type: t.uint8, from, until: 255n, step: 2n }, (i) => last.set(i));
      return s.return({ last: last.get() });
    });
    const outcomes = await expectAgreement(script, [[251n], [250n]]);
    expect(outcomes[0]).toMatchObject({ kind: 'return' }); // 251, 253, then 255 ends the loop
    expect(outcomes[1]).toEqual({ kind: 'revert', data: panicData(0x11n) }); // 254 + 2
  });

  test('forEach over an arg (empty included), a fixed-size array, and nested', async () => {
    const flat = evscript({ name: 'sumArr', args: [t.array(t.uint256)] }, (s, xs) => {
      const total = s.let(t.uint256, 0n);
      const idx = s.let(t.uint256, 0n);
      s.forEach(xs, (x, i) => {
        total.set(total.get().add(x));
        idx.set(idx.get().add(i));
      });
      return s.return({ total: total.get(), idx: idx.get() });
    });
    await expectAgreement(flat, [[[]], [[5n]], [[1n, 2n, 3n, 4n]], [[MAX256, 1n]]]);

    const fixed = evscript({ name: 'sumFixed', args: [t.array(t.uint64, 3)] }, (s, xs) => {
      const total = s.let(t.uint256, 0n);
      s.forEach(xs, (x) => total.set(total.get().add(x.toUint(t.uint256))));
      return s.return({ total: total.get() });
    });
    await expectAgreement(fixed, [[[0n, 0n, 0n]], [[1n, 2n, (1n << 64n) - 1n]]]);

    const nested = evscript({ name: 'sumGrid', args: [t.array(t.array(t.uint256))] }, (s, g) => {
      const total = s.let(t.uint256, 0n);
      s.forEach(g, (row, r) => {
        s.forEach(row, (x, c) => total.set(total.get().add(x.mul(r.add(1n)).add(c))));
      });
      return s.return({ total: total.get() });
    });
    await expectAgreement(nested, [[[]], [[[], [1n], [2n, 3n]]], [[[1n, 2n, 3n], [], [4n]]]]);
  });

  test('forEach over a call result (empty and non-empty)', async () => {
    const numsAbi = [
      {
        type: 'function',
        name: 'nums',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256[]' }],
      },
    ] as const;
    const script = evscript({ name: 'sumCall', args: [] }, (s) => {
      const xs = s.read({ address: TOKA, abi: numsAbi, functionName: 'nums', args: [] });
      const total = s.let(t.uint256, 0n);
      s.forEach(xs, (x) => total.set(total.get().add(x)));
      return s.return({ total: total.get(), n: xs.length() });
    });
    for (const nums of [[], [3n, 4n, 5n]]) {
      const data = encodeAbiParameters([{ type: 'uint256[]' }], [nums]);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await expectAgreement(script, [[]], { [TOKA]: { kind: 'return', data } });
    }
  });

  test('continue / break inside forEach and s.for: the step before continue still runs', async () => {
    const script = evscript(
      { name: 'ctlLoops', args: [t.array(t.uint256), t.uint256] },
      (s, xs, n) => {
        const kept = s.let(t.uint256, 0n);
        const seen = s.let(t.uint256, 0n);
        s.forEach(xs, (x, _i, loop) => {
          seen.set(seen.get().add(1n));
          s.if(x.mod(2n).eq(0n), () => loop.continue());
          s.if(x.gt(100n), () => loop.break());
          kept.set(kept.get().add(x));
        });
        const odd = s.let(t.uint256, 0n);
        s.for({ from: 0n, until: n }, (i, loop) => {
          s.if(i.mod(2n).eq(0n), () => loop.continue());
          s.if(i.gt(20n), () => loop.break());
          odd.set(odd.get().add(i));
        });
        return s.return({ kept: kept.get(), seen: seen.get(), odd: odd.get() });
      },
    );
    await expectAgreement(script, [
      [[], 0n],
      [[1n, 2n, 3n, 4n, 5n], 7n],
      [[2n, 4n, 101n, 7n], 30n],
      [[1n, 103n, 5n], 1n],
    ]);
  });

  test('the output-array pattern', async () => {
    const script = evscript({ name: 'squares', args: [t.uint256] }, (s, n) => {
      const out = s.newArray(t.uint256, n);
      s.for({ from: 0n, until: n }, (i) => out.set(i, i.mul(i)));
      return s.return({ out: out.expr() });
    });
    await expectAgreement(script, [[0n], [1n], [6n]]);
  });

  test('an if(i < arr.length) guard on both sides of the bound; the else read still Panics 0x32', async () => {
    const script = evscript(
      { name: 'guarded', args: [t.array(t.uint256), t.uint256, t.bool] },
      (s, xs, i, readElse) => {
        const r = s.let(t.uint256, 0n);
        s.if(
          i.lt(xs.length()),
          () => r.set(xs.at(i).add(1n)),
          () => s.if(readElse, () => r.set(xs.at(i))),
        );
        return s.return({ r: r.get() });
      },
    );
    const outcomes = await expectAgreement(script, [
      [[7n, 8n, 9n], 0n, false],
      [[7n, 8n, 9n], 2n, false],
      [[7n, 8n, 9n], 3n, false],
      [[7n, 8n, 9n], 3n, true],
      [[], 0n, true],
      [[7n], MAX256, true],
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual([
      'return',
      'return',
      'return',
      'revert',
      'revert',
      'revert',
    ]);
    expect(outcomes[3]?.data).toBe(panicData(0x32n));
  });
});
