/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — calls, decode bounds, revert bubbling, tryCall.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { Reverter } from '../../test/generated/index.js';
import {
  expectAgreement,
  ERROR_ABI,
  panicData,
  TOKA,
  TOKB,
  POOL,
  REVERTER,
  ECHO,
  DEAD,
  USER,
  erc20ishAbi,
  sel,
  abiEchoMock,
  fixtureOf,
  type CalleeTable,
} from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { concatHex, word } from '../../test/harness/fixtures.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type Hex } from '../core/types.js';

// ---------------------------------------------------------------------------
// 6. calls with mocks
// ---------------------------------------------------------------------------

describe('calls', () => {
  test('word outputs are normalized, never reverted (dirty high bits)', async () => {
    const script = evscript({ name: 'norm', args: [] }, (s) => {
      const d = s.read({ address: TOKA, abi: erc20ishAbi, functionName: 'decimals' });
      const f = s.read({ address: TOKB, abi: erc20ishAbi, functionName: 'flag' });
      const tk = s.read({ address: POOL, abi: erc20ishAbi, functionName: 'tick' });
      return s.return({ d, f, tk });
    });
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: word(-1n) }, // uint8 ← 0xff…ff → 255
      [TOKB]: { kind: 'return', data: word((1n << 128n) | 2n) }, // bool ← nonzero → true
      [POOL]: { kind: 'return', data: word((0xabcn << 64n) | 0xfffff6n) }, // int24 ← …fffff6 → −10
    };
    const [o] = await expectAgreement(script, [[]], table);
    const decoded = decodeFunctionResult({
      abi: script.abi,
      functionName: 'norm',
      data: o?.data ?? '0x',
    });
    expect(decoded).toEqual({ d: 255, f: true, tk: -10 });
  });

  test('tryRead: an out-of-range word still reports success, normalized (unlike viem)', async () => {
    // the documented contract (guides/calls, "Success is not a range check"): success only means
    // the returndata had a decodable shape — a uint8 word of 300 reads as 44, success = true
    const script = evscript({ name: 'tryNorm', args: [] }, (s) => {
      const d = s.tryRead({ address: TOKA, abi: erc20ishAbi, functionName: 'decimals' });
      const f = s.tryRead({ address: TOKB, abi: erc20ishAbi, functionName: 'flag' });
      const tk = s.tryRead({ address: POOL, abi: erc20ishAbi, functionName: 'tick' });
      return s.return({
        dOk: d.success,
        d: d.value,
        fOk: f.success,
        f: f.value,
        tkOk: tk.success,
        tk: tk.value,
      });
    });
    const dirty = { decimals: word(300n), flag: word(2n), tick: word(0x1fffff6n) };
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: dirty.decimals }, // uint8 ← 300 → masked to 44
      [TOKB]: { kind: 'return', data: dirty.flag }, // bool ← 2 → true
      [POOL]: { kind: 'return', data: dirty.tick }, // int24 ← 0x1fffff6 → sign-extended to −10
    };
    const [o] = await expectAgreement(script, [[]], table);
    expect(
      decodeFunctionResult({ abi: script.abi, functionName: 'tryNorm', data: o?.data ?? '0x' }),
    ).toEqual({ dOk: true, d: 44, fOk: true, f: true, tkOk: true, tk: -10 });

    // viem's decoder does not normalize these words: uintN/intN come back unmasked and a bool
    // word other than 0/1 throws — the docs must not call evs's behaviour "like viem"
    const viemDecode = (functionName: 'decimals' | 'flag' | 'tick', data: Hex): unknown =>
      decodeFunctionResult({ abi: erc20ishAbi, functionName, data });
    expect(viemDecode('decimals', dirty.decimals)).toBe(300);
    expect(viemDecode('tick', dirty.tick)).toBe(0x1fffff6);
    expect(() => viemDecode('flag', dirty.flag)).toThrow(/not a valid boolean/);
  });

  test('multi-output static call destructures into a tuple', async () => {
    const script = evscript({ name: 'multi', args: [] }, (s) => {
      const [a, b, c] = s.read({ address: TOKA, abi: erc20ishAbi, functionName: 'multi' });
      return s.return({ a, b, c });
    });
    const payload = concatHex(word(1n << 159n), word((1n << 200n) | 0xfffff6n), word(7n));
    await expectAgreement(script, [[]], { [TOKA]: { kind: 'return', data: payload } });
  });

  test('dynamic outputs decode in place (string, uint256[]), with a gas cap', async () => {
    const script = evscript({ name: 'dyn', args: [] }, (s) => {
      const symbol = s.read({
        address: TOKA,
        abi: erc20ishAbi,
        functionName: 'symbol',
        gas: 200_000n,
      });
      const list = s.read({ address: TOKB, abi: erc20ishAbi, functionName: 'list' });
      return s.return({ symbol, list, len: list.length(), first: list.at(0n) });
    });
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: encodeAbiParameters([{ type: 'string' }], ['PEPE']) },
      [TOKB]: {
        kind: 'return',
        data: encodeAbiParameters([{ type: 'uint256[]' }], [[7n, 8n, 9n]]),
      },
    };
    await expectAgreement(script, [[]], table);
  });

  test('sub-call calldata is byte-exact: echoed back, ABI-wrapped, and returned', async () => {
    // the callee returns abi.encode(bytes(calldata)) — ANY divergence between the
    // interpreter's and the compiler's sub-call calldata (selector, heads, dynamic tail,
    // padding) shows up as a byte mismatch of the final returndata.
    const script = evscript({ name: 'mixer', args: [t.uint256, t.bytes] }, (s, v, payload) => {
      const out = s.read({
        address: ECHO,
        abi: erc20ishAbi,
        functionName: 'mix',
        args: [v, TOKA, payload], // Expr + literal + dynamic Expr
      });
      return s.return({ out, len: out.length() });
    });
    const table: CalleeTable = {
      [ECHO]: {
        kind: 'bytecode',
        runtime: abiEchoMock(),
        respond: (calldata) => ({
          success: true,
          data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
        }),
      },
    };
    await expectAgreement(
      script,
      [
        [42n, '0x'],
        [0n, `0x${'cd'.repeat(33)}`],
      ],
      table,
    );
  });

  test('plain word call with an arg through the raw echo mock', async () => {
    const script = evscript({ name: 'echoCall', args: [t.address] }, (s, who) => {
      const r = s.read({
        address: ECHO,
        abi: erc20ishAbi,
        functionName: 'balanceOf',
        args: [who],
      });
      return s.return({ r });
    });
    const [o] = await expectAgreement(script, [[USER]], { [ECHO]: { kind: 'echo' } });
    expect(o?.kind).toBe('return');
  });

  test('strict call to an unmocked (code-less) address → EvsDecodeError, not a halt', async () => {
    const script = evscript({ name: 'ghost', args: [] }, (s) => {
      const d = s.read({ address: DEAD, abi: erc20ishAbi, functionName: 'decimals' });
      return s.return({ d });
    });
    const [o] = await expectAgreement(script, [[]]);
    expect(o?.kind).toBe('revert');
    expect(o?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. decode bounds (attacker-shaped returndata) — strict mode
// ---------------------------------------------------------------------------

describe('decode bounds', () => {
  const ATTACKER_PAYLOADS: Readonly<Record<string, Hex>> = {
    empty: '0x',
    hugeHeadOffset: word(1n << 255n),
    hugeLength: concatHex(word(32n), word(1n << 200n)),
    offByOneTruncation: concatHex(word(32n), word(32n), `0x${'ab'.repeat(31)}`),
    dirtyHighBits: word(-1n), // a 2^256−1 head offset for a dynamic output
    shortWord: `0x${'00'.repeat(30)}2a`, // 31 bytes < the 32-byte head floor
  };

  for (const [name, payload] of Object.entries(ATTACKER_PAYLOADS)) {
    test(`strict symbol() against '${name}' returndata → EvsDecodeError(site) on both sides`, async () => {
      const script = evscript({ name: 'attacked', args: [] }, (s) => {
        const symbol = s.read({ address: TOKA, abi: erc20ishAbi, functionName: 'symbol' });
        return s.return({ symbol });
      });
      const [o] = await expectAgreement(script, [[]], {
        [TOKA]: { kind: 'return', data: payload },
      });
      expect(o?.kind).toBe('revert');
      expect(o?.data.startsWith(sel('EvsDecodeError(uint256)'))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 8. revert bubbling — the REAL solc Reverter artifact vs ABI-encoded expectations
// ---------------------------------------------------------------------------

describe('revert bubbling (Reverter.sol, byte-exact)', () => {
  const RESPONSES: Readonly<Record<string, { success: boolean; data: Hex }>> = {
    [sel('revertErrorString()')]: {
      success: false,
      data: encodeErrorResult({
        abi: ERROR_ABI,
        errorName: 'Error',
        args: ['Reverter: error string'],
      }),
    },
    [sel('revertRequire()')]: {
      success: false,
      data: encodeErrorResult({
        abi: ERROR_ABI,
        errorName: 'Error',
        args: ['Reverter: require failed'],
      }),
    },
    [sel('panicAssert()')]: { success: false, data: panicData(0x01n) },
    [sel('panicOverflow()')]: { success: false, data: panicData(0x11n) },
    [sel('panicDivZero()')]: { success: false, data: panicData(0x12n) },
    [sel('panicArrayOob()')]: { success: false, data: panicData(0x32n) },
    [sel('revertCustomError()')]: {
      success: false,
      data: encodeErrorResult({
        abi: Reverter.abi,
        errorName: 'DetailedError',
        args: [42n, '0x000000000000000000000000000000000000beef'],
      }),
    },
    [sel('revertCustomErrorNoArgs()')]: {
      success: false,
      data: encodeErrorResult({ abi: Reverter.abi, errorName: 'PlainError', args: [] }),
    },
    [sel('revertEmpty()')]: { success: false, data: '0x' },
  };
  const table: CalleeTable = {
    [REVERTER]: {
      kind: 'bytecode',
      runtime: Reverter.deployedBytecode,
      respond: (calldata) =>
        RESPONSES[calldata.slice(0, 10).toLowerCase()] ?? { success: false, data: '0x' },
    },
  };
  const FNS = [
    'revertErrorString',
    'revertRequire',
    'panicAssert',
    'panicOverflow',
    'panicDivZero',
    'panicArrayOob',
    'revertCustomError',
    'revertCustomErrorNoArgs',
    'revertEmpty',
  ] as const;

  for (const fn of FNS) {
    test(`${fn} bubbles verbatim through a strict call`, async () => {
      const script = evscript({ name: 'bubble', args: [] }, (s) => {
        const x = s.read({ address: REVERTER, abi: Reverter.abi, functionName: fn });
        return s.return({ x });
      });
      const [o] = await expectAgreement(script, [[]], table);
      expect(o?.kind).toBe('revert');
      expect(o?.data).toBe(RESPONSES[sel(`${fn}()`)]?.data);
    });
  }
});

// ---------------------------------------------------------------------------
// 9. tryCall zeroing
// ---------------------------------------------------------------------------

const tryScript = () =>
  evscript({ name: 'trying', args: [] }, (s) => {
    const d = s.tryRead({ address: TOKA, abi: erc20ishAbi, functionName: 'decimals' });
    const sym = s.tryRead({ address: TOKB, abi: erc20ishAbi, functionName: 'symbol' });
    const list = s.tryRead({ address: DEAD, abi: erc20ishAbi, functionName: 'list' });
    return s.return({
      ok1: d.success,
      v1: d.value,
      ok2: sym.success,
      v2: sym.value,
      ok3: list.success,
      v3: list.value,
      picked: s.select(d.success, d.value, 18),
    });
  });

describe('tryCall', () => {
  test('failure / malformed / unmocked → success=false, zeroed values', async () => {
    const table: CalleeTable = {
      [TOKA]: { kind: 'revert', data: panicData(0x01n) }, // call failure
      [TOKB]: { kind: 'return', data: concatHex(word(32n), word(1n << 200n)) }, // malformed
      // DEAD unmocked: empty returndata < head floor → malformed → zeroed
    };
    const [o] = await expectAgreement(tryScript(), [[]], table);
    const decoded = decodeFunctionResult({
      abi: tryScript().abi,
      functionName: 'trying',
      data: o?.data ?? '0x',
    });
    expect(decoded).toEqual({
      ok1: false,
      v1: 0,
      ok2: false,
      v2: '',
      ok3: false,
      v3: [],
      picked: 18,
    });
  });

  test('success path: values flow through', async () => {
    const table: CalleeTable = {
      [TOKA]: { kind: 'return', data: word(9n) },
      [TOKB]: { kind: 'return', data: encodeAbiParameters([{ type: 'string' }], ['OK']) },
      [DEAD]: { kind: 'return', data: encodeAbiParameters([{ type: 'uint256[]' }], [[5n]]) },
    };
    await expectAgreement(tryScript(), [[]], table);
  });
});

// ---------------------------------------------------------------------------
// 10. calls in loops: word-only outputs read a transient snapshot (no memory growth)
// ---------------------------------------------------------------------------

describe('calls in loops', () => {
  // `n` reads per call; the marginal gas of the n → n+100 and n+100 → n+200 steps must be
  // identical when an iteration leaves memory untouched, and grows (quadratic memory expansion)
  // when every iteration keeps a fresh returndata snapshot.
  const loopOf = (fn: 'multi' | 'symbol') =>
    evscript({ name: 'loop', args: [t.uint256] }, (s, n) => {
      const acc = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n }, () => {
        if (fn === 'multi') {
          const [a, b] = s.read({ address: TOKA, abi: erc20ishAbi, functionName: 'multi' });
          const tried = s.tryRead({ address: TOKA, abi: erc20ishAbi, functionName: 'decimals' });
          acc.set(acc.get().add(a.toUint(t.uint256)).add(b.toUint(t.uint256).mod(7n)));
          acc.set(acc.get().add(tried.value.toUint(t.uint256)));
        } else {
          const sym = s.read({ address: TOKB, abi: erc20ishAbi, functionName: 'symbol' });
          acc.set(acc.get().add(sym.length()));
        }
      });
      return s.return({ acc: acc.get() });
    });
  const table: CalleeTable = {
    [TOKA]: { kind: 'return', data: concatHex(word(3n), word(5n), word(1n)) },
    [TOKB]: { kind: 'return', data: encodeAbiParameters([{ type: 'string' }], ['OK']) },
  };
  const secondDifference = async (fn: 'multi' | 'symbol'): Promise<bigint> => {
    const runtime = compile(loopOf(fn)).runtimeBytecode;
    const gasAt = async (n: bigint): Promise<bigint> => {
      const data = encodeFunctionData({ abi: loopOf(fn).abi, functionName: 'loop', args: [n] });
      const res = await execRuntime(runtime, data, fixtureOf(table));
      expect(res.success, `loop(${n})`).toBe(true);
      return res.gasUsed;
    };
    const [g0, g1, g2] = [await gasAt(10n), await gasAt(110n), await gasAt(210n)];
    return g2 - g1 - (g1 - g0);
  };

  test('word-only reads (strict + try) agree with the interpreter', async () => {
    await expectAgreement(loopOf('multi'), [[0n], [1n], [5n]], table);
    await expectAgreement(loopOf('symbol'), [[0n], [3n]], table);
  });

  test('a word-only read costs the same on every iteration: memory does not grow', async () => {
    expect(await secondDifference('multi')).toBe(0n);
  });

  test('a memref-output read keeps its snapshot: memory grows every iteration', async () => {
    expect(await secondDifference('symbol')).toBeGreaterThan(0n);
  });
});
