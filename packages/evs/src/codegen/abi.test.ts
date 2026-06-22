/**
 * M7 unit tests — `codegen/abi.ts`: calldata decode + return encode, differential against
 * viem `encodeAbiParameters` / `decodeFunctionResult` (testing.md §4.2), the malformed /
 * attacker-shaped calldata matrix (→ `EvsInvalidCalldata()`, never an exceptional halt), the
 * dirty-word normalization rules (architecture §8.1), and the pre-cancun memcpy path.
 *
 * Test scripts are "echo" programs: prologue → `emitCalldataDecode` into frame slots →
 * `emitReturnEncode` of the same slots → shared tails. Both ABI directions are exercised in
 * one execution and the RETURN bytes must equal viem's encoding of the same value record.
 */

import { decodeFunctionResult, encodeAbiParameters } from 'viem';
import { describe, expect, test } from 'vitest';

import { bytesToHex, execRuntime, DEFAULT_GAS_LIMIT } from '../../test/harness/evm.js';
import { buildScriptAbi, canonicalTypeSignature, selectorOf } from '../abi/artifact.js';
import { AsmWriter, assemble } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { isDynamicType, typeToAbiParam, type EvsType, type Hex } from '../core/types.js';
import { emitCalldataDecode, emitReturnEncode, type SlotRef } from './abi.js';
import { createSharedTails, emitSharedTails } from './tails.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Arbitrary selector — the decoder never inspects it (the dispatcher does, M8). */
const SELECTOR: Hex = '0x01020304';
const FRAME_BASE = 0x80;
const INVALID_CALLDATA: Hex = selectorOf('EvsInvalidCalldata', []);

const U256_MASK = (1n << 256n) - 1n;
const word = (v: bigint): Hex => `0x${(v & U256_MASK).toString(16).padStart(64, '0')}`;
const concat = (...parts: readonly Hex[]): Hex => `0x${parts.map((p) => p.slice(2)).join('')}`;

function isDyn(type: EvsType): boolean {
  return isDynamicType(type);
}

/** prologue → decode(args) → return-encode(args) → tails. */
function echoRuntime(types: readonly EvsType[], evmVersion: EvmVersion): Hex {
  const w = new AsmWriter();
  const frameEnd = FRAME_BASE + 32 * Math.max(types.length, 1);
  w.push(frameEnd);
  w.push(0x40);
  w.op('MSTORE');
  const tails = createSharedTails(w, { evmVersion });
  const refs: SlotRef[] = types.map((type, i) => ({ slot: FRAME_BASE + 32 * i, type }));
  emitCalldataDecode(w, refs, tails, { evmVersion });
  emitReturnEncode(
    w,
    refs.map((ref, i) => ({ name: `v${i}`, ref })),
    tails,
    { evmVersion },
  );
  emitSharedTails(w, tails, { evmVersion });
  return bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode);
}

function callDataFor(types: readonly EvsType[], values: readonly unknown[]): Hex {
  return concat(
    SELECTOR,
    encodeAbiParameters(
      types.map((type, i) => typeToAbiParam(`a${i}`, type)),
      values,
    ),
  );
}

function expectedReturn(types: readonly EvsType[], values: readonly unknown[]): Hex {
  const obj = Object.fromEntries(values.map((v, i) => [`v${i}`, v]));
  return encodeAbiParameters(
    [{ type: 'tuple', components: types.map((type, i) => ({ name: `v${i}`, type })) }],
    [obj],
  );
}

// ---------------------------------------------------------------------------
// the echo case matrix (testing.md §4.2 — byte equality against viem)
// ---------------------------------------------------------------------------

interface EchoCase {
  name: string;
  types: readonly EvsType[];
  values: readonly unknown[];
}

const ADDR_A = '0x00000000000000000000000000000000000000aa';
const ADDR_B = '0xffffffffffffffffffffffffffffffffffffffff';

const ECHO_CASES: readonly EchoCase[] = [
  { name: 'uint256 zero', types: ['uint256'], values: [0n] },
  { name: 'uint256 max', types: ['uint256'], values: [(1n << 256n) - 1n] },
  {
    name: 'uint8 + bool + address',
    types: ['uint8', 'bool', 'address'],
    values: [255n, true, ADDR_A],
  },
  { name: 'int8 / int256 boundaries', types: ['int8', 'int256'], values: [-128n, -(1n << 255n)] },
  { name: 'int24 negative', types: ['int24'], values: [-1n] },
  {
    name: 'bytes4 + bytes32',
    types: ['bytes4', 'bytes32'],
    values: ['0xdeadbeef', `0x${'ab'.repeat(32)}`],
  },
  { name: 'empty string', types: ['string'], values: [''] },
  { name: 'short string', types: ['string'], values: ['hello evs'] },
  { name: 'long string (multi-word tail)', types: ['string'], values: ['a'.repeat(101)] },
  { name: 'empty bytes', types: ['bytes'], values: ['0x'] },
  { name: 'bytes len 1', types: ['bytes'], values: ['0xff'] },
  { name: 'bytes len 31', types: ['bytes'], values: [`0x${'11'.repeat(31)}`] },
  { name: 'bytes len 32', types: ['bytes'], values: [`0x${'22'.repeat(32)}`] },
  { name: 'bytes len 33', types: ['bytes'], values: [`0x${'33'.repeat(33)}`] },
  { name: 'uint256[] empty', types: ['uint256[]'], values: [[]] },
  { name: 'uint256[] three', types: ['uint256[]'], values: [[1n, 2n, (1n << 256n) - 1n]] },
  { name: 'bool[] mixed', types: ['bool[]'], values: [[true, false, true]] },
  { name: 'int16[] negatives', types: ['int16[]'], values: [[-1n, -32768n, 42n]] },
  { name: 'address[] pair', types: ['address[]'], values: [[ADDR_A, ADDR_B]] },
  {
    name: 'word after dynamic',
    types: ['string', 'uint64'],
    values: ['tail-then-word', 0xdeadbeefn],
  },
  {
    name: 'mixed static/dynamic interleaved',
    types: ['uint8', 'string', 'address[]', 'bytes32', 'bytes'],
    values: [7n, 'pool', [ADDR_A], `0x${'cd'.repeat(32)}`, '0x010203'],
  },
];

describe('calldata decode → return encode echo, differential vs viem (cancun)', () => {
  for (const c of ECHO_CASES) {
    test(`case: ${c.name}`, async () => {
      const runtime = echoRuntime(c.types, 'cancun');
      const res = await execRuntime(runtime, callDataFor(c.types, c.values));
      expect(res.success).toBe(true);
      expect(res.data).toBe(expectedReturn(c.types, c.values));
    });
  }

  test('output decodes through viem decodeFunctionResult as the named object', async () => {
    const types: readonly EvsType[] = ['uint8', 'string', 'uint256[]'];
    const values = [9n, 'abc', [4n, 5n]] as const;
    const res = await execRuntime(echoRuntime(types, 'cancun'), callDataFor(types, values));
    expect(res.success).toBe(true);
    const abi = buildScriptAbi(
      'echo',
      [...types],
      types.map((type, i) => ({ name: `v${i}`, type })),
    );
    const decoded = decodeFunctionResult({ abi, functionName: 'echo', data: res.data });
    expect(decoded).toEqual({ v0: 9, v1: 'abc', v2: [4n, 5n] });
  });
});

describe('memcpy path parity — the same dynamic echoes on paris and shanghai', () => {
  const DYN_CASES = ECHO_CASES.filter((c) => c.types.some(isDyn));
  for (const evmVersion of ['paris', 'shanghai'] as const) {
    for (const c of DYN_CASES) {
      test(`${c.name} (${evmVersion})`, async () => {
        const res = await execRuntime(
          echoRuntime(c.types, evmVersion),
          callDataFor(c.types, c.values),
        );
        expect(res.success).toBe(true);
        expect(res.data).toBe(expectedReturn(c.types, c.values));
      });
    }
  }
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng: () => number, maxExclusive: number): number =>
  Math.floor(rng() * maxExclusive);
const randBig = (rng: () => number, bits: number): bigint => {
  let v = 0n;
  for (let got = 0; got < bits; got += 16) v = (v << 16n) | BigInt(randInt(rng, 0x10000));
  return v & ((1n << BigInt(bits)) - 1n);
};
const randHexBytes = (rng: () => number, len: number): Hex => {
  let s = '';
  for (let i = 0; i < len; i++) s += randInt(rng, 256).toString(16).padStart(2, '0');
  return `0x${s}`;
};
const randAscii = (rng: () => number, len: number): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 _-';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randInt(rng, alphabet.length)];
  return s;
};

describe('fuzzed echo matrix (seeded, differential vs viem)', () => {
  const GENS: readonly { type: EvsType; gen: (rng: () => number) => unknown }[] = [
    { type: 'uint8', gen: (r) => randBig(r, 8) },
    { type: 'uint64', gen: (r) => randBig(r, 64) },
    { type: 'uint256', gen: (r) => randBig(r, 256) },
    { type: 'int8', gen: (r) => randBig(r, 8) - 128n },
    { type: 'int256', gen: (r) => randBig(r, 255) - (1n << 254n) },
    { type: 'address', gen: (r) => randHexBytes(r, 20) },
    { type: 'bool', gen: (r) => r() < 0.5 },
    { type: 'bytes8', gen: (r) => randHexBytes(r, 8) },
    { type: 'bytes32', gen: (r) => randHexBytes(r, 32) },
    { type: 'string', gen: (r) => randAscii(r, randInt(r, 61)) },
    { type: 'bytes', gen: (r) => randHexBytes(r, randInt(r, 71)) },
    {
      type: 'uint256[]',
      gen: (r) => Array.from({ length: randInt(r, 5) }, () => randBig(r, 256)),
    },
    {
      type: 'int32[]',
      gen: (r) => Array.from({ length: randInt(r, 5) }, () => randBig(r, 32) - (1n << 31n)),
    },
    { type: 'bool[]', gen: (r) => Array.from({ length: randInt(r, 5) }, () => r() < 0.5) },
    {
      type: 'address[]',
      gen: (r) => Array.from({ length: randInt(r, 4) }, () => randHexBytes(r, 20)),
    },
  ];

  function fuzzCase(rng: () => number): EchoCase {
    const count = 1 + randInt(rng, 4);
    const picks = Array.from({ length: count }, () => {
      const g = GENS[randInt(rng, GENS.length)];
      if (g === undefined) throw new Error('unreachable');
      return g;
    });
    return {
      name: picks.map((p) => canonicalTypeSignature(p.type)).join(','),
      types: picks.map((p) => p.type),
      values: picks.map((p) => p.gen(rng)),
    };
  }

  const rng = mulberry32(0xe5e5);
  for (let i = 0; i < 24; i++) {
    const c = fuzzCase(rng);
    const evmVersion: EvmVersion = i % 3 === 0 ? 'paris' : 'cancun';
    test(`#${i} [${c.name}] (${evmVersion})`, async () => {
      const res = await execRuntime(
        echoRuntime(c.types, evmVersion),
        callDataFor(c.types, c.values),
      );
      expect(res.success).toBe(true);
      expect(res.data).toBe(expectedReturn(c.types, c.values));
    });
  }
});

// ---------------------------------------------------------------------------
// dirty-word normalization (normalize-don't-revert — architecture §8.1)
// ---------------------------------------------------------------------------

describe('dirty calldata words normalize instead of reverting', () => {
  interface DirtyCase {
    name: string;
    type: EvsType;
    rawWord: Hex;
    normalized: unknown;
  }
  const DIRTY: readonly DirtyCase[] = [
    { name: 'uint8 high bits dropped', type: 'uint8', rawWord: word(-1n), normalized: 255n },
    { name: 'bool 2 → true', type: 'bool', rawWord: word(2n), normalized: true },
    {
      name: 'bool dirty high bits, zero low → true',
      type: 'bool',
      rawWord: word(1n << 200n),
      normalized: true,
    },
    { name: 'int8 low byte sign-extends', type: 'int8', rawWord: word(0x80n), normalized: -128n },
    { name: 'address top 96 bits masked', type: 'address', rawWord: word(-1n), normalized: ADDR_B },
    {
      name: 'bytes4 dirty low bits masked',
      type: 'bytes4',
      rawWord: word(-1n & U256_MASK),
      normalized: '0xffffffff',
    },
    { name: 'uint64 masked', type: 'uint64', rawWord: word((1n << 64n) | 5n), normalized: 5n },
  ];
  for (const c of DIRTY) {
    test(`case: ${c.name}`, async () => {
      const res = await execRuntime(echoRuntime([c.type], 'cancun'), concat(SELECTOR, c.rawWord));
      expect(res.success).toBe(true);
      expect(res.data).toBe(expectedReturn([c.type], [c.normalized]));
    });
  }

  test('array elements normalize eagerly (bool[] with element word 5)', async () => {
    // bool[] = [5, 0] hand-encoded with a dirty element
    const calldata = concat(SELECTOR, word(32n), word(2n), word(5n), word(0n));
    const res = await execRuntime(echoRuntime(['bool[]'], 'cancun'), calldata);
    expect(res.success).toBe(true);
    expect(res.data).toBe(expectedReturn(['bool[]'], [[true, false]]));
  });

  test('int16[] dirty elements sign-extend eagerly', async () => {
    const calldata = concat(SELECTOR, word(32n), word(1n), word(0x8000n)); // low 16 bits = -32768
    const res = await execRuntime(echoRuntime(['int16[]'], 'cancun'), calldata);
    expect(res.success).toBe(true);
    expect(res.data).toBe(expectedReturn(['int16[]'], [[-32768n]]));
  });
});

// ---------------------------------------------------------------------------
// malformed / attacker-shaped calldata → EvsInvalidCalldata (never a halt)
// ---------------------------------------------------------------------------

describe('malformed calldata reverts EvsInvalidCalldata() — architecture §8.1', () => {
  interface BadCase {
    name: string;
    types: readonly EvsType[];
    calldata: Hex;
  }
  const BAD: readonly BadCase[] = [
    { name: 'empty calldata', types: ['uint256'], calldata: '0x' },
    { name: 'selector only, word arg missing', types: ['uint256'], calldata: SELECTOR },
    {
      name: 'two args, one word short',
      types: ['uint256', 'uint256'],
      calldata: concat(SELECTOR, word(1n)),
    },
    { name: 'selector only, zero args still needs 4 bytes', types: [], calldata: '0x0102' },
    { name: 'dynamic head missing', types: ['string'], calldata: SELECTOR },
    {
      name: 'huge head offset (2^255)',
      types: ['string'],
      calldata: concat(SELECTOR, word(1n << 255n)),
    },
    {
      name: 'offset just over the 2^64 guard',
      types: ['bytes'],
      calldata: concat(SELECTOR, word(1n << 64n)),
    },
    {
      name: 'offset points past calldata (no length word)',
      types: ['bytes'],
      calldata: concat(SELECTOR, word(32n)),
    },
    {
      name: 'huge length (2^200)',
      types: ['bytes'],
      calldata: concat(SELECTOR, word(32n), word(1n << 200n)),
    },
    {
      name: 'length just over the 2^64 guard',
      types: ['bytes'],
      calldata: concat(SELECTOR, word(32n), word(1n << 64n)),
    },
    {
      name: 'off-by-one truncated tail (31 of 32 bytes)',
      types: ['bytes'],
      calldata: concat(SELECTOR, word(32n), word(32n), `0x${'ab'.repeat(31)}`),
    },
    {
      name: 'array claims 4 elements, supplies 3',
      types: ['uint256[]'],
      calldata: concat(SELECTOR, word(32n), word(4n), word(1n), word(2n), word(3n)),
    },
    {
      name: 'array length 2^64 (alloc-bomb shape)',
      types: ['uint8[]'],
      calldata: concat(SELECTOR, word(32n), word(1n << 64n)),
    },
  ];
  for (const c of BAD) {
    test(`case: ${c.name}`, async () => {
      const res = await execRuntime(echoRuntime(c.types, 'cancun'), c.calldata);
      expect(res.success).toBe(false);
      expect(res.data).toBe(INVALID_CALLDATA); // the named error, never garbage
      expect(res.gasUsed).toBeLessThan(DEFAULT_GAS_LIMIT / 100n); // no all-gas halt
    });
  }

  test('boundary acceptance: exactly enough calldata succeeds', async () => {
    // bytes len 32 with a byte-exact (unpadded would be invalid ABI, but padded-minimal) tail
    const payload: Hex = `0x${'ab'.repeat(32)}`;
    const calldata = concat(SELECTOR, word(32n), word(32n), payload);
    const res = await execRuntime(echoRuntime(['bytes'], 'cancun'), calldata);
    expect(res.success).toBe(true);
    expect(res.data).toBe(expectedReturn(['bytes'], [payload]));
  });

  test('boundary acceptance: byte-exact unpadded tail (len 5, cds = 73)', async () => {
    // CALLDATACOPY zero-pads reads past the end — the checks guard correctness, not halts
    const calldata = concat(SELECTOR, word(32n), word(5n), '0x68656c6c6f');
    const res = await execRuntime(echoRuntime(['bytes'], 'cancun'), calldata);
    expect(res.success).toBe(true);
    expect(res.data).toBe(expectedReturn(['bytes'], ['0x68656c6c6f']));
  });

  test('array boundary: exactly 4 supplied elements succeed', async () => {
    const calldata = concat(SELECTOR, word(32n), word(4n), word(1n), word(2n), word(3n), word(4n));
    const res = await execRuntime(echoRuntime(['uint256[]'], 'cancun'), calldata);
    expect(res.success).toBe(true);
    expect(res.data).toBe(expectedReturn(['uint256[]'], [[1n, 2n, 3n, 4n]]));
  });

  test('trailing extra calldata is tolerated (permissive like solc/viem)', async () => {
    const calldata = concat(callDataFor(['uint256'], [42n]), '0xdeadbeef');
    const res = await execRuntime(echoRuntime(['uint256'], 'cancun'), calldata);
    expect(res.success).toBe(true);
    expect(res.data).toBe(expectedReturn(['uint256'], [42n]));
  });
});

// ---------------------------------------------------------------------------
// return encode in isolation (hand-built memrefs, zero-slot memrefs)
// ---------------------------------------------------------------------------

describe('return encode from hand-built state', () => {
  for (const evmVersion of ['paris', 'shanghai', 'cancun'] as const) {
    test(`string memref + word (${evmVersion})`, async () => {
      const w = new AsmWriter();
      // frame: slot 0x80 = string memref, slot 0xa0 = uint16; heap from 0xc0
      w.push(0xc0);
      w.push(0x40);
      w.op('MSTORE');
      const tails = createSharedTails(w, { evmVersion });
      // memref "abc" at 0xc0: [len=3]["abc" padded]; freePtr → 0x100
      w.push(3n);
      w.push(0xc0);
      w.op('MSTORE');
      w.push(BigInt(`0x616263${'00'.repeat(29)}`));
      w.push(0xe0);
      w.op('MSTORE');
      w.push(0x100);
      w.push(0x40);
      w.op('MSTORE');
      w.push(0xc0);
      w.push(0x80);
      w.op('MSTORE'); // slot[0x80] = ptr
      w.push(0x2an);
      w.push(0xa0);
      w.op('MSTORE'); // slot[0xa0] = 42
      emitReturnEncode(
        w,
        [
          { name: 's', ref: { slot: 0x80, type: 'string' } },
          { name: 'n', ref: { slot: 0xa0, type: 'uint16' } },
        ],
        tails,
        { evmVersion },
      );
      emitSharedTails(w, tails, { evmVersion });
      const res = await execRuntime(bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode), '0x');
      expect(res.success).toBe(true);
      expect(res.data).toBe(
        encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 's', type: 'string' },
                { name: 'n', type: 'uint16' },
              ],
            },
          ],
          [{ s: 'abc', n: 42 }],
        ),
      );
    });
  }

  test('memref pointing at the zero slot encodes as empty (tryCall zeroing contract)', async () => {
    const w = new AsmWriter();
    w.push(0xc0);
    w.push(0x40);
    w.op('MSTORE');
    const tails = createSharedTails(w, { evmVersion: 'cancun' });
    w.push(0x60);
    w.push(0x80);
    w.op('MSTORE'); // slot[0x80] = 0x60 (zero slot)
    w.push(0x60);
    w.push(0xa0);
    w.op('MSTORE'); // slot[0xa0] = 0x60
    emitReturnEncode(
      w,
      [
        { name: 's', ref: { slot: 0x80, type: 'string' } },
        { name: 'arr', ref: { slot: 0xa0, type: 'uint256[]' } },
      ],
      tails,
      { evmVersion: 'cancun' },
    );
    emitSharedTails(w, tails, { evmVersion: 'cancun' });
    const res = await execRuntime(
      bytesToHex(assemble(w.nodes(), { evmVersion: 'cancun' }).bytecode),
      '0x',
    );
    expect(res.success).toBe(true);
    expect(res.data).toBe(
      encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 's', type: 'string' },
              { name: 'arr', type: 'uint256[]' },
            ],
          },
        ],
        [{ s: '', arr: [] }],
      ),
    );
  });

  test('zero components return an empty tuple', async () => {
    const w = new AsmWriter();
    w.push(0x80);
    w.push(0x40);
    w.op('MSTORE');
    const tails = createSharedTails(w, { evmVersion: 'cancun' });
    emitReturnEncode(w, [], tails, { evmVersion: 'cancun' });
    emitSharedTails(w, tails, { evmVersion: 'cancun' });
    const res = await execRuntime(
      bytesToHex(assemble(w.nodes(), { evmVersion: 'cancun' }).bytecode),
      '0x',
    );
    expect(res.success).toBe(true);
    expect(res.data).toBe('0x');
  });
});
