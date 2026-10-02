/* oxlint-disable vitest/expect-expect --
 * every test asserts through the shared `expectAgreement` runner. */
/**
 * Differential suite — address / fixed-bytes conversions and string/bytes access: `address`
 * and `bytesN` ordering, `asUint160` / `asAddress` from `uint160`, same-width `asUint` /
 * `asBytesN`, `string ↔ bytes`, `bytesN → string` (trailing zero bytes trimmed), `byteAt` and
 * `slice` (both `MCOPY` and the pre-cancun `@memcpy` copy).
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. The decoded values are also pinned against an independent host-side
 * computation (viem), so the two legs cannot agree on a wrong answer.
 */

import {
  type Abi,
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  hexToString,
  stringToHex,
  type Hex,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  chainOf,
  expectAgreement,
  panicData,
  type AnyScript,
} from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { namedArg, t } from '../core/types.js';
import { interpret } from '../ir/interp.js';

/** Decodes the (agreed) interpreter returndata of `script(args)` through the script's ABI. */
function decoded(script: AnyScript, args: readonly unknown[]): unknown {
  const { outcome } = interpret(script.ir, args, chainOf({}));
  expect(outcome.kind).toBe('return');
  return decodeFunctionResult({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an evscript ABI is a viem Abi
    abi: script.abi as Abi,
    functionName: script.name,
    data: outcome.data,
  });
}

// ---------------------------------------------------------------------------
// 1. ordering on address and bytesN (unsigned word comparisons)
// ---------------------------------------------------------------------------

const ADDR_LO = '0x0000000000000000000000000000000000000001';
const ADDR_MID = '0x7fffffffffffffffffffffffffffffffffffffff';
const ADDR_HI = '0xffffffffffffffffffffffffffffffffffffffff';

describe('ordering on address / bytesN', () => {
  test('address: lt/gt/lte/gte + the token-sort idiom', async () => {
    const script = evscript({ name: 'order', args: [t.address, t.address] }, (s, a, b) => {
      const lt = a.lt(b);
      return s.return({
        lt,
        gt: a.gt(b),
        lte: s.lte(a, b),
        gte: s.gte(a, b),
        token0: s.select(lt, a, b),
        token1: s.select(lt, b, a),
        belowMid: a.lt(ADDR_MID), // literal right operand
      });
    });
    const pairs = [
      [ADDR_LO, ADDR_HI],
      [ADDR_HI, ADDR_LO],
      [ADDR_MID, ADDR_MID],
      [ADDR_HI, ADDR_MID],
    ];
    await expectAgreement(script, pairs);
    expect(decoded(script, [ADDR_HI, ADDR_LO])).toEqual({
      lt: false,
      gt: true,
      lte: false,
      gte: true,
      token0: ADDR_LO,
      token1: getAddress(ADDR_HI),
      belowMid: false,
    });
  });

  test('bytes4 / bytes32: lexicographic (unsigned word) order', async () => {
    const script = evscript(
      { name: 'orderBytes', args: [t.bytes4, t.bytes4, t.bytes32, t.bytes32] },
      (s, a, b, c, d) =>
        s.return({
          ab: a.lt(b),
          ba: s.gt(a, b),
          cd: c.lte(d),
          dc: d.gte(c),
          lit: a.lt('0x80000000'),
        }),
    );
    const w = (hex: string): Hex => `0x${hex.padEnd(64, '0')}`;
    await expectAgreement(script, [
      ['0x00000001', '0x01000000', w('01'), w('0001')],
      ['0xff000000', '0x00ffffff', w('ff'), w('ff')],
      ['0x12345678', '0x12345678', w('00'), w('01')],
    ]);
    // 0xff000000 sorts after 0x00ffffff: bytes compare by their first byte, like Solidity
    expect(decoded(script, ['0xff000000', '0x00ffffff', w('ff'), w('ff')])).toEqual({
      ab: false,
      ba: true,
      cd: true,
      dc: true,
      lit: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. word conversions: address ↔ uint160, same-width bytesN ↔ uintN
// ---------------------------------------------------------------------------

describe('address ↔ uint160', () => {
  test('free in both directions; widening through toUint', async () => {
    const script = evscript({ name: 'addrU160', args: [t.address, t.uint160] }, (s, a, u) =>
      s.return({
        asU: a.asUint160(),
        wide: a.asUint160().toUint(t.uint256),
        asA: u.asAddress(),
        roundTrip: a.asUint160().asAddress(),
        next: u.add(1n).asAddress(), // checked add on uint160 (Panic 0x11 at max)
      }),
    );
    const max160 = (1n << 160n) - 1n;
    const outcomes = await expectAgreement(script, [
      [ADDR_LO, 0n],
      [ADDR_HI, max160 - 1n],
      [ADDR_MID, max160], // u + 1 overflows uint160
    ]);
    expect(outcomes[2]?.data).toBe(panicData(0x11n));
    expect(decoded(script, [ADDR_HI, 5n])).toEqual({
      asU: max160,
      wide: max160,
      asA: '0x0000000000000000000000000000000000000005',
      roundTrip: getAddress(ADDR_HI),
      next: '0x0000000000000000000000000000000000000006',
    });
  });
});

describe("Solidity's address(bytes20) / bytes20(address), through uint160", () => {
  test('b20.asUint().asAddress() and a.asUint160().asBytesN() round-trip', async () => {
    const script = evscript({ name: 'addrB20', args: [t.address, t.bytes20] }, (s, a, b20) =>
      s.return({
        toB20: a.asUint160().asBytesN(),
        toAddr: b20.asUint().asAddress(),
        roundTrip: a.asUint160().asBytesN().asUint().asAddress().eq(a),
      }),
    );
    const rows: [Hex, Hex][] = [
      [ADDR_HI, ADDR_LO],
      [ADDR_LO, ADDR_MID],
      [ADDR_MID, ADDR_HI],
    ];
    await expectAgreement(script, rows);
    for (const [a, b20] of rows) {
      expect(decoded(script, [a, b20])).toEqual({
        toB20: a.toLowerCase(), // a bytes20 decodes as plain hex (not checksummed)
        toAddr: getAddress(b20),
        roundTrip: true,
      });
    }
  });
});

describe('asAddress keeps its check next to the lane conversions', () => {
  // bytes32 → address stays the checked asAddress (high 96 bits zero), never a lane shift
  test('bytes32 / uint256 / uint160 → address', async () => {
    const script = evscript(
      { name: 'toAddr', args: [t.bytes32, t.uint256, t.uint160] },
      (s, w, u, n) =>
        s.return({ fromWord: w.asAddress(), fromU256: u.asAddress(), fromU160: n.asAddress() }),
    );
    const low: Hex = `0x${'00'.repeat(12)}${'ab'.repeat(20)}`;
    const outcomes = await expectAgreement(script, [
      [low, 1n, 2n],
      [`0x01${'00'.repeat(31)}`, 1n, 2n], // bytes32 high bits set → Panic 0x11
      [low, 1n << 160n, 2n], // uint256 high bits set → Panic 0x11
    ]);
    expect(outcomes[1]?.data).toBe(panicData(0x11n));
    expect(outcomes[2]?.data).toBe(panicData(0x11n));
  });
});

describe('same-width bytesN ↔ uintN', () => {
  test('asUint / asBytesN at 1, 4, 20 and 32 bytes', async () => {
    const script = evscript(
      { name: 'bytesUint', args: [t.bytes1, t.bytes4, t.bytes20, t.bytes32, t.uint32] },
      (s, b1, b4, b20, b32, u32) =>
        s.return({
          u8: b1.asUint(),
          u32: b4.asUint(),
          u160: b20.asUint(),
          u256: b32.asUint(),
          b4: u32.asBytesN(),
          back: b4.asUint().asBytesN(),
          b20: b20.asUint().asBytesN(),
          // asBytesN of a computed value keeps the lane canonical (the shr/bitAnd below re-read it)
          hi: u32.asBytesN().shr(8n),
        }),
    );
    const rows = [
      ['0xab', '0x12345678', ADDR_HI, `0x${'f1'.repeat(32)}`, 0x12345678n],
      ['0x00', '0x00000000', ADDR_LO, `0x${'00'.repeat(31)}01`, 0n],
      ['0xff', '0xffffffff', ADDR_MID, `0x80${'00'.repeat(31)}`, 0xffffffffn],
    ];
    await expectAgreement(script, rows);
    expect(decoded(script, rows[0] ?? [])).toEqual({
      u8: 0xab,
      u32: 0x12345678,
      u160: (1n << 160n) - 1n,
      u256: BigInt(`0x${'f1'.repeat(32)}`),
      b4: '0x12345678',
      back: '0x12345678',
      b20: ADDR_HI, // a bytes20 decodes as plain hex (not checksummed)
      hi: '0x00123456',
    });
  });

  test('literal operands fold at recording (no convert statement)', async () => {
    const script = evscript({ name: 'foldCasts', args: [] }, (s) =>
      s.return({
        u: s.lit(t.bytes4, '0xdeadbeef').asUint(),
        b: s.lit(t.uint16, 0xbeefn).asBytesN(),
        a: s.lit(t.uint160, 1n).asAddress(),
        n: s.lit(t.address, ADDR_HI).asUint160(),
      }),
    );
    expect(script.ir.body.some((st) => st.k === 'convert')).toBe(false);
    await expectAgreement(script, [[]]);
    expect(decoded(script, [])).toEqual({
      u: 0xdeadbeef,
      b: '0xbeef',
      a: '0x0000000000000000000000000000000000000001',
      n: (1n << 160n) - 1n,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. string ↔ bytes, bytesN → string
// ---------------------------------------------------------------------------

describe('string ↔ bytes and bytesN → string', () => {
  test('string ↔ bytes is a free reinterpret of the same bytes', async () => {
    const script = evscript({ name: 'strBytes', args: [t.string, t.bytes] }, (s, str, raw) =>
      s.return({
        asBytes: str.asBytes(),
        asString: raw.asString(),
        same: str.asBytes().eq(raw),
        hash: s.keccak256(str.asBytes()).eq(s.keccak256(str)),
      }),
    );
    await expectAgreement(script, [
      ['', '0x'],
      ['hello', stringToHex('hello')],
      ['x'.repeat(33), '0x0102'],
    ]);
  });

  // the legacy-token fallback (MKR / SAI `symbol()` returns bytes32): trailing zero bytes are
  // trimmed like viem's `hexToString(x, { size })`, interior zero bytes are kept, and an
  // all-zero word is the empty string (where viem's trim keeps a lone '\0')
  const B32: readonly Hex[] = [
    stringToHex('MKR', { size: 32 }),
    stringToHex('Maker', { size: 32 }),
    `0x${'00'.repeat(32)}`, // all zero → ''
    `0x${'41'.repeat(32)}`, // no padding at all → 32 bytes
    `0x4100420000${'00'.repeat(27)}`, // interior NUL kept: 'A\0B'
    `0x00${'00'.repeat(30)}41`, // only the last byte set
    stringToHex('déjà', { size: 32 }), // multi-byte UTF-8
  ];

  /** The host-side oracle: the byte length up to the last nonzero byte. */
  function trimmedLength(word: Hex): number {
    const bytes = hexToBytes(word);
    let n = bytes.length;
    while (n > 0 && bytes[n - 1] === 0) n--;
    return n;
  }

  /** The host-side oracle: drop the trailing zero bytes, decode the rest as UTF-8. */
  function trimmedString(word: Hex): string {
    return hexToString(bytesToHex(hexToBytes(word).subarray(0, trimmedLength(word))));
  }

  test('bytes32 / bytes4 / bytes1 → string trims the trailing zero bytes', async () => {
    const script = evscript(
      { name: 'symbolOf', args: [t.bytes32, t.bytes4, t.bytes1] },
      (s, b32, b4, b1) => s.return({ s32: b32.asString(), s4: b4.asString(), s1: b1.asString() }),
    );
    const prefix = (b: Hex, n: number): Hex => `0x${b.slice(2, 2 + 2 * n)}`;
    const rows = B32.map((b): [Hex, Hex, Hex] => [b, prefix(b, 4), prefix(b, 1)]);
    await expectAgreement(script, rows);
    for (const [b32, b4, b1] of rows) {
      expect(decoded(script, [b32, b4, b1])).toEqual({
        s32: trimmedString(b32),
        s4: trimmedString(b4),
        s1: trimmedString(b1),
      });
    }
  });

  test('the converted string is a canonical memref: encode, eq and select over it', async () => {
    const script = evscript(
      { name: 'symbolFallback', args: [t.bool, t.string, t.bytes32] },
      (s, ok, sym, raw) => {
        const name = s.select(ok, sym, raw.asString());
        return s.return({
          name,
          isMkr: name.eq('MKR'),
          packed: s.encodePacked(name, raw.asString()),
          abi: s.encode(raw.asString()),
        });
      },
    );
    await expectAgreement(
      script,
      B32.flatMap((b) => [
        [true, 'USDC', b],
        [false, 'USDC', b],
      ]),
    );
  });

  /** `n` nonzero bytes (cycling through values that set every bit position) then zero padding. */
  function wordOfLength(
    n: number,
    fill = (i: number): number => [0x01, 0x80, 0xff, 0x10][i % 4] ?? 1,
  ): Hex {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < n; i++) bytes[i] = fill(i);
    return bytesToHex(bytes);
  }

  /** Every trimmed length 0..32, a lone set bit at every byte and bit offset, embedded zeros. */
  const EDGE_WORDS: readonly Hex[] = [
    ...Array.from({ length: 33 }, (_, n) => wordOfLength(n)),
    ...Array.from({ length: 32 }, (_, i) => {
      const bytes = new Uint8Array(32);
      bytes[i] = 1 << (i % 8); // a single set bit, at every byte and every bit offset
      return bytesToHex(bytes);
    }),
    ...[1, 2, 4, 8, 16, 32, 64, 128].map((v) => wordOfLength(32, () => v)), // full, one bit each
    `0x00${'ff'.repeat(31)}`, // leading zero byte, the rest set
    `0x${'00ff'.repeat(16)}`, // alternating: the last byte is the last nonzero one
    `0x${'ff00'.repeat(16)}`, // alternating: one trailing zero byte
    `0x01${'00'.repeat(30)}01`, // only the two ends set
    `0x01${'00'.repeat(30)}80`, // … the last one by its top bit
  ];

  test('bytes32 → string: every trimmed length, bit offset and embedded-zero shape', async () => {
    const script = evscript({ name: 'edgeSymbol', args: [t.bytes32] }, (s, b) =>
      s.return({ sym: b.asString(), len: b.asString().length() }),
    );
    await expectAgreement(
      script,
      EDGE_WORDS.map((b) => [b]),
    );
    for (const b of EDGE_WORDS) {
      expect(decoded(script, [b])).toEqual({
        sym: trimmedString(b),
        len: BigInt(trimmedLength(b)),
      });
    }
  });

  test('every bytesN width trims inside its own lane', async () => {
    for (let n = 1; n <= 32; n++) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- n ∈ 1..32 names a bytesN key
      const type = t[`bytes${n}` as 'bytes32'];
      const script = evscript({ name: `lane${n}`, args: [type] }, (s, b) =>
        s.return({ sym: b.asString() }),
      );
      const rows = [0, 1, n - 1, n]
        .filter((k, i, all) => k >= 0 && all.indexOf(k) === i)
        .map((k): [Hex] => [`0x${wordOfLength(k).slice(2, 2 + 2 * n)}`]);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: one width at a time
      await expectAgreement(script, rows);
    }
  });

  test('the trim costs the same gas at every trimmed length (no per-byte loop)', async () => {
    const script = compile(
      evscript({ name: 'symLen', args: [t.bytes32] }, (s, b) =>
        s.return({ len: b.asString().length() }),
      ),
    );
    const gasOf = async (b: Hex): Promise<bigint> => {
      const calldata = encodeFunctionData({ abi: script.abi, functionName: 'symLen', args: [b] });
      const res = await execRuntime(script.runtimeBytecode, calldata);
      expect(res.success).toBe(true);
      return res.gasUsed;
    };
    const gas = await Promise.all(EDGE_WORDS.map(gasOf));
    const min = gas.reduce((m, g) => (g < m ? g : m));
    const max = gas.reduce((m, g) => (g > m ? g : m));
    // 0.3.0 scanned down from byte 32 one byte per iteration: ~67 gas per trailing zero byte,
    // 2,248 gas for an all-zero word. The branch-free trailing-zero count is flat.
    expect(max - min, `asString gas ${min}..${max}`).toBe(0n);
  });

  test('pre-cancun targets agree too', async () => {
    const script = evscript({ name: 'symbolOld', args: [t.bytes32] }, (s, b) =>
      s.return({ sym: b.asString() }),
    );
    for (const evm of ['paris', 'shanghai'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await expectAgreement(
        script,
        B32.map((b) => [b]),
        {},
        evm,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. byteAt / slice on string and bytes
// ---------------------------------------------------------------------------

describe('byteAt', () => {
  test('bounds-checked bytes1 reads on string and bytes', async () => {
    const script = evscript(
      { name: 'byteAt', args: [t.string, t.bytes, t.uint256] },
      (s, str, raw, i) =>
        s.return({
          c: str.byteAt(i),
          b: raw.byteAt(i),
          code: raw.byteAt(i).asUint(), // uint8(b[i])
          first: str.byteAt(0n), // Panic 0x32 on an empty string
        }),
    );
    const long = `0x${Array.from({ length: 70 }, (_, k) => (k + 1).toString(16).padStart(2, '0')).join('')}`;
    const outcomes = await expectAgreement(script, [
      ['abc', '0x010203', 0n],
      ['abc', '0x010203', 2n],
      ['abc', '0x010203', 3n], // out of range
      ['abcdef', '0x01', 1n], // in range for the string, not for the bytes
      ['', '0x01', 0n], // `first` panics
      ['x'.repeat(70), long, 69n], // a byte in the third payload word
      ['abc', '0x010203', (1n << 256n) - 1n],
    ]);
    expect(outcomes[2]?.data).toBe(panicData(0x32n));
    expect(outcomes[3]?.data).toBe(panicData(0x32n));
    expect(decoded(script, ['x'.repeat(70), long, 69n])).toEqual({
      c: '0x78',
      b: '0x46',
      code: 0x46,
      first: '0x78',
    });
  });
});

describe('slice', () => {
  const PAYLOAD: Hex = bytesToHex(Uint8Array.from({ length: 100 }, (_, k) => (k * 7 + 3) % 256));

  function sliceScript(name: string) {
    return evscript(
      { name, args: [t.bytes, t.string, t.uint256, t.uint256] },
      (s, raw, str, start, end) =>
        s.return({
          b: raw.slice(start, end),
          tail: raw.slice(start), // end defaults to the length
          str: str.slice(start, end),
          // the copy is a canonical memref: re-hashing / re-encoding / comparing it agrees
          hash: s.keccak256(raw.slice(start, end)),
          packed: s.encodePacked(raw.slice(start, end), str.slice(start, end)),
          same: raw.slice(start, end).eq(raw.slice(start, end)),
          n: raw.slice(start, end).length(),
        }),
    );
  }

  const ROWS: (readonly unknown[])[] = [
    [PAYLOAD, 'x'.repeat(100), 0n, 100n], // the whole value
    [PAYLOAD, 'y'.repeat(100), 4n, 36n], // drop a selector, keep one word
    [PAYLOAD, 'z'.repeat(100), 31n, 33n], // straddles a word boundary
    [PAYLOAD, 'w'.repeat(100), 50n, 50n], // empty
    [PAYLOAD, 'v'.repeat(100), 100n, 100n], // empty at the end
    [PAYLOAD, 'u'.repeat(100), 3n, 101n], // end past the length → Panic 0x32
    [PAYLOAD, 't'.repeat(100), 10n, 9n], // start > end → Panic 0x32
    ['0x', '', 0n, 0n],
    [PAYLOAD, 's'.repeat(100), (1n << 256n) - 1n, (1n << 256n) - 1n],
  ];

  test('cancun (MCOPY)', async () => {
    const outcomes = await expectAgreement(sliceScript('sliceCancun'), ROWS);
    expect(outcomes[5]?.data).toBe(panicData(0x32n));
    expect(outcomes[6]?.data).toBe(panicData(0x32n));
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3);
    expect(decoded(sliceScript('sliceCancun'), [PAYLOAD, text, 4n, 36n])).toMatchObject({
      b: bytesToHex(hexToBytes(PAYLOAD).slice(4, 36)),
      tail: bytesToHex(hexToBytes(PAYLOAD).slice(4)),
      str: text.slice(4, 36),
      same: true,
      n: 32n,
    });
  });

  test('paris / shanghai (@memcpy word loop)', async () => {
    for (const evm of ['paris', 'shanghai'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await expectAgreement(sliceScript(`slice_${evm}`), ROWS, {}, evm);
    }
  });

  test('slices inside a loop and an s.fn agree (a fresh copy per iteration)', async () => {
    const script = evscript({ name: 'labels', args: [t.string] }, (s, name) => {
      // split a dotted name into its labels' hashes (the ENS namehash input)
      const firstByte = s.fn('firstByte', [namedArg('label', t.string)] as const, (label) =>
        label.slice(0n, 1n),
      );
      const hashes = s.newArray(t.bytes32, 4n);
      const count = s.let(t.uint256, 0n);
      const start = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: name.length() }, (i) => {
        s.if(name.byteAt(i).eq('0x2e'), () => {
          hashes.set(count.get(), s.keccak256(name.slice(start.get(), i)));
          count.set(count.get().add(1n));
          start.set(i.add(1n));
        });
      });
      hashes.set(count.get(), s.keccak256(name.slice(start.get())));
      return s.return({
        hashes: hashes.expr(),
        labels: count.get().add(1n),
        first: firstByte(name),
      });
    });
    await expectAgreement(script, [['vitalik.eth'], ['a.b.c'], ['x'], ['sub.vitalik.eth']]);
  });
});
