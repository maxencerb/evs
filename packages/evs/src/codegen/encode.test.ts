/* oxlint-disable vitest/expect-expect --
 * every matrix test asserts through the shared `expectCase` runner. */
/* oxlint-disable typescript/no-unsafe-type-assertion --
 * the matrix drives evscript/viem with runtime-built type lists, not literals — the casts are
 * the documented dynamic-corpus pattern (mirrors checked-math.test.ts / differential.test.ts). */
/**
 * Issue #17 differential suite — `s.encode` / `s.encodePacked` / `s.keccak256` vs the viem
 * oracle (testing.md §4.4). viem's `encodeAbiParameters`, `encodePacked`, and `keccak256` are
 * assumed faithful to Solidity; for every case the compiled bytecode's returndata (M10 harness)
 * must match them byte-for-byte, and `interpret(script.ir, …)` must agree with the bytecode on
 * the full returndata. The corpus sweeps every word width, dynamic types (incl. empty and
 * non-32-aligned lengths), word arrays, structs (flat / nested / dynamic members), composite
 * arrays (`string[]` / `uint256[][]` / `tuple[]`), and mixed multi-arg tuples that exercise the
 * head/tail offset math; packed-mode cases cover its unpadded-word + padded-array-element rules.
 * One case re-runs on every evmVersion (the pre-cancun `@memcpy` unaligned-copy path).
 * `s.keccak256` defaults to the STANDARD encoding (#24): every case checks
 * `keccak256(abi.encode(...))` (raw payload hash for a single bytes/string value), and packed
 * cases additionally pin the explicit `s.keccak256(s.encodePacked(...))` composition.
 */

import type { AbiParameter } from 'abitype';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  stringToHex,
} from 'viem';
import { describe, expect, test } from 'vitest';

import { execRuntime } from '../../test/harness/evm.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type EvsType, type Expr, type Hex } from '../core/types.js';
import { interpret, type MockChain } from '../ir/interp.js';

const deadChain: MockChain = {
  staticcall: () => {
    throw new Error('unexpected staticcall');
  },
};

interface EncodeCase {
  name: string;
  /** script arg types (the values arrive via calldata, exercising the full §8.1 path too). */
  types: readonly EvsType[];
  /** the same types as viem ABI params (for the encodeAbiParameters oracle). */
  params: readonly AbiParameter[];
  /** viem `encodePacked` type names — present iff the case is packed-encodable. */
  packedTypes?: readonly string[];
  values: readonly unknown[];
}

const ALL_BITS = Array.from({ length: 32 }, (_, i) => 8 * (i + 1));

function wordCases(): EncodeCase[] {
  const cases: EncodeCase[] = [];
  for (const bits of ALL_BITS) {
    const maxU = (1n << BigInt(bits)) - 1n;
    const minI = -(1n << BigInt(bits - 1));
    cases.push({
      name: `uint${bits} + int${bits} boundaries`,
      types: [`uint${bits}`, `int${bits}`, `int${bits}`] as EvsType[],
      params: [{ type: `uint${bits}` }, { type: `int${bits}` }, { type: `int${bits}` }],
      packedTypes: [`uint${bits}`, `int${bits}`, `int${bits}`],
      values: [maxU, minI, -1n],
    });
  }
  const bytesNCases = ALL_BITS.map((bits): EncodeCase => {
    const n = bits / 8;
    const hex: Hex = `0x${Array.from({ length: n }, (_, i) => ((i * 37 + n) % 256).toString(16).padStart(2, '0')).join('')}`;
    return {
      name: `bytes${n}`,
      types: [`bytes${n}`] as EvsType[],
      params: [{ type: `bytes${n}` }],
      packedTypes: [`bytes${n}`],
      values: [hex],
    };
  });
  return [
    ...cases,
    ...bytesNCases,
    {
      name: 'address + bool pair',
      types: ['address', 'bool', 'bool'],
      params: [{ type: 'address' }, { type: 'bool' }, { type: 'bool' }],
      packedTypes: ['address', 'bool', 'bool'],
      values: ['0x00000000000000000000000000000000deadbeef', true, false],
    },
  ];
}

const DYNAMIC_CASES: EncodeCase[] = [
  ...[0, 1, 31, 32, 33, 64, 95].map(
    (len): EncodeCase => ({
      name: `bytes of length ${len}`,
      types: ['bytes'],
      params: [{ type: 'bytes' }],
      packedTypes: ['bytes'],
      values: [`0x${'5a'.repeat(len)}`],
    }),
  ),
  {
    name: 'strings: empty / ascii / multibyte utf8',
    types: ['string', 'string', 'string'],
    params: [{ type: 'string' }, { type: 'string' }, { type: 'string' }],
    packedTypes: ['string', 'string', 'string'],
    values: ['', 'transfer(address,uint256)', 'héllo ✓ αβγ 🦄'],
  },
];

const ARRAY_CASES: EncodeCase[] = [
  {
    name: 'uint256[] empty + populated',
    types: ['uint256[]', 'uint256[]'],
    params: [{ type: 'uint256[]' }, { type: 'uint256[]' }],
    packedTypes: ['uint256[]', 'uint256[]'],
    values: [[], [1n, (1n << 256n) - 1n, 42n]],
  },
  {
    name: 'sub-word element arrays (uint8[], int16[], bytes3[], bool[], address[])',
    types: ['uint8[]', 'int16[]', 'bytes3[]', 'bool[]', 'address[]'],
    params: [
      { type: 'uint8[]' },
      { type: 'int16[]' },
      { type: 'bytes3[]' },
      { type: 'bool[]' },
      { type: 'address[]' },
    ],
    packedTypes: ['uint8[]', 'int16[]', 'bytes3[]', 'bool[]', 'address[]'],
    values: [
      [0n, 255n, 7n],
      [-1n, 32767n, -32768n],
      ['0xaabbcc', '0x010203'],
      [true, false, true],
      ['0x00000000000000000000000000000000deadbeef'],
    ],
  },
];

const pairComponents = [
  { name: 'token', type: 'address' },
  { name: 'fee', type: 'uint24' },
] as const;
const Pair = t.struct({ token: t.address, fee: t.uint24 });
const Order = t.struct({ id: t.uint256, label: t.string, amounts: t.array(t.uint128) });
const orderComponents = [
  { name: 'id', type: 'uint256' },
  { name: 'label', type: 'string' },
  { name: 'amounts', type: 'uint128[]' },
] as const;
const Nested = t.struct({ pair: Pair, order: Order, tag: t.bytes4 });
const nestedComponents = [
  { name: 'pair', type: 'tuple', components: pairComponents },
  { name: 'order', type: 'tuple', components: orderComponents },
  { name: 'tag', type: 'bytes4' },
] as const;

const COMPOSITE_CASES: EncodeCase[] = [
  {
    name: 'flat static struct',
    types: [Pair],
    params: [{ type: 'tuple', components: pairComponents }],
    values: [{ token: '0x00000000000000000000000000000000deadbeef', fee: 500n }],
  },
  {
    name: 'struct with dynamic members (string + uint128[])',
    types: [Order],
    params: [{ type: 'tuple', components: orderComponents }],
    values: [{ id: 7n, label: 'order #7', amounts: [1n, 2n, 3n] }],
  },
  {
    name: 'nested struct (static inner + dynamic inner + word)',
    types: [Nested],
    params: [{ type: 'tuple', components: nestedComponents }],
    values: [
      {
        pair: { token: '0x00000000000000000000000000000000deadbeef', fee: 3000n },
        order: { id: 1n, label: 'x', amounts: [] },
        tag: '0xdeadbeef',
      },
    ],
  },
  {
    name: 'composite arrays: string[] + uint256[][] + tuple[]',
    types: ['string[]', 'uint256[][]', t.array(Pair)],
    params: [
      { type: 'string[]' },
      { type: 'uint256[][]' },
      { type: 'tuple[]', components: pairComponents },
    ],
    values: [
      ['', 'one', 'twos'],
      [[], [1n, 2n], [3n]],
      [
        { token: '0x00000000000000000000000000000000deadbeef', fee: 500n },
        { token: '0x00000000000000000000000000000000cafebabe', fee: 10000n },
      ],
    ],
  },
  {
    name: 'mixed multi-arg head/tail offsets',
    types: ['uint8', 'string', 'bytes32', 'uint256[]', Pair, 'bytes'],
    params: [
      { type: 'uint8' },
      { type: 'string' },
      { type: 'bytes32' },
      { type: 'uint256[]' },
      { type: 'tuple', components: pairComponents },
      { type: 'bytes' },
    ],
    values: [
      9n,
      'mid-string',
      `0x${'11'.repeat(32)}`,
      [5n, 6n],
      { token: '0x00000000000000000000000000000000deadbeef', fee: 100n },
      '0x0102030405',
    ],
  },
];

const PACKED_MIX: EncodeCase = {
  name: 'packed mixed words + dynamics + arrays (unaligned cursor churn)',
  types: ['uint8', 'string', 'uint24', 'bytes', 'int64', 'uint16[]', 'bytes3', 'bool'],
  params: [
    { type: 'uint8' },
    { type: 'string' },
    { type: 'uint24' },
    { type: 'bytes' },
    { type: 'int64' },
    { type: 'uint16[]' },
    { type: 'bytes3' },
    { type: 'bool' },
  ],
  packedTypes: ['uint8', 'string', 'uint24', 'bytes', 'int64', 'uint16[]', 'bytes3', 'bool'],
  values: [0xffn, 'abc', 0xabcdefn, '0x00ff00ff00ff00', -3n, [1n, 2n, 65535n], '0x0a0b0c', true],
};

const CORPUS: EncodeCase[] = [
  ...wordCases(),
  ...DYNAMIC_CASES,
  ...ARRAY_CASES,
  ...COMPOSITE_CASES,
  PACKED_MIX,
];

// ---------------------------------------------------------------------------
// the runner — one script per case returning every applicable op's result
// ---------------------------------------------------------------------------

/** viem `encodePacked` takes numbers for sub-53-bit ints; bigints work for all — pass through. */
function buildCaseScript(c: EncodeCase) {
  return evscript(
    { name: 'encCase', args: c.types as [EvsType, ...EvsType[]] },
    (s, ...rawArgs) => {
      const args = rawArgs as unknown as [Expr, ...Expr[]];
      const rets: Record<string, Expr> = {
        e: s.encode(...args),
        // #24: the default IS the standard-encoding hash (single bytes/string → raw payload hash)
        h: s.keccak256(...args),
        // …and the explicit composition hashes the same bytes
        he: s.keccak256(s.encode(...args)),
      };
      if (c.packedTypes !== undefined) {
        rets['p'] = s.encodePacked(...args);
        rets['hp'] = s.keccak256(s.encodePacked(...args)); // the explicit packed hash (#24)
      }
      return s.return(rets);
    },
    { locations: false },
  );
}

async function expectCase(c: EncodeCase, evmVersion?: 'paris' | 'shanghai' | 'cancun') {
  const script = buildCaseScript(c);
  const compiled = compile(script, evmVersion === undefined ? {} : { evmVersion });
  const calldata = encodeFunctionData({
    abi: compiled.abi,
    functionName: 'encCase',
    args: c.values as never,
  });
  const res = await execRuntime(compiled.runtimeBytecode, calldata);
  expect(res.success, `${c.name}: script reverted with ${res.data}`).toBe(true);
  const out = decodeFunctionResult({
    abi: compiled.abi,
    functionName: 'encCase',
    data: res.data,
  }) as Record<string, Hex>;

  const expectedE = encodeAbiParameters(c.params as AbiParameter[], c.values as never);
  expect(out['e'], `${c.name}: abi encode`).toBe(expectedE);
  // #24: s.keccak256 defaults to keccak256(abi.encode(...)); a SINGLE bytes/string value is
  // hashed raw (Solidity's keccak256(bytes)), so those cases expect the payload hash instead.
  const singleRaw =
    c.types.length === 1 && (c.types[0] === 'bytes' || c.types[0] === 'string')
      ? c.types[0]
      : undefined;
  const expectedH =
    singleRaw === undefined
      ? keccak256(expectedE)
      : keccak256(
          singleRaw === 'bytes' ? (c.values[0] as Hex) : stringToHex(c.values[0] as string),
        );
  expect(out['h'], `${c.name}: keccak256 (standard default)`).toBe(expectedH);
  // the explicit composition always hashes the encoding bytes (even for one bytes/string value,
  // where s.encode wraps the payload in offset+length words first)
  expect(out['he'], `${c.name}: keccak256(abi encode)`).toBe(keccak256(expectedE));
  // packed cases carry `packedTypes`; on non-packed cases both sides are undefined, so the
  // comparison stays unconditional (lint: no-conditional-expect).
  const expectedP =
    c.packedTypes === undefined
      ? undefined
      : encodePacked(c.packedTypes as string[], c.values as never);
  expect(out['p'], `${c.name}: packed encode`).toBe(expectedP);
  expect(out['hp'], `${c.name}: keccak256(packed) — explicit composition`).toBe(
    expectedP === undefined ? undefined : keccak256(expectedP),
  );

  // interpreter ↔ bytecode agreement on the full returndata (testing.md §4.1 invariant)
  const interp = interpret(script.ir, c.values, deadChain);
  const interpData = interp.outcome.kind === 'return' ? interp.outcome.data : interp.outcome;
  expect(interpData, `${c.name}: interp/bytecode divergence`).toBe(res.data);
}

// ---------------------------------------------------------------------------
// the matrix
// ---------------------------------------------------------------------------

describe('encode/encodePacked/keccak256 vs the viem oracle (issue #17)', () => {
  test.each(CORPUS.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await expectCase(c);
  });

  test('the packed mix is byte-identical on every evmVersion (pre-cancun @memcpy path)', async () => {
    await Promise.all(
      (['paris', 'shanghai', 'cancun'] as const).flatMap((evmVersion) => [
        expectCase(PACKED_MIX, evmVersion),
        expectCase(COMPOSITE_CASES[4] as EncodeCase, evmVersion),
      ]),
    );
  });

  test('keccak256 of empty bytes is the canonical empty hash', async () => {
    const script = evscript(
      { name: 'emptyHash', args: [t.bytes] },
      (s, b) => s.return({ h: s.keccak256(b) }),
      { locations: false },
    );
    const compiled = compile(script);
    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'emptyHash',
      args: ['0x'],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata);
    expect(res.success).toBe(true);
    const out = decodeFunctionResult({
      abi: compiled.abi,
      functionName: 'emptyHash',
      data: res.data,
    }) as { h: Hex };
    expect(out.h).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });

  test('single-word keccak256 follows keccak256(abi.encode(x)) — width-independent (#24)', async () => {
    // every word hashes its FULL 32-byte standard encoding (a uint8 no longer hashes one byte);
    // the packed one-byte hash is the explicit s.keccak256(s.encodePacked(x)) composition
    const script = evscript(
      { name: 'wordHash', args: [t.uint8, t.uint256, t.bytes32] },
      (s, a, b, c) =>
        s.return({
          ha: s.keccak256(a),
          hb: s.keccak256(b),
          hc: s.keccak256(c),
          hap: s.keccak256(s.encodePacked(a)),
        }),
      { locations: false },
    );
    const compiled = compile(script);
    const word: Hex = `0x${'ab'.repeat(32)}`;
    const calldata = encodeFunctionData({
      abi: compiled.abi,
      functionName: 'wordHash',
      args: [7, 123n, word],
    });
    const res = await execRuntime(compiled.runtimeBytecode, calldata);
    expect(res.success).toBe(true);
    const out = decodeFunctionResult({
      abi: compiled.abi,
      functionName: 'wordHash',
      data: res.data,
    }) as { ha: Hex; hb: Hex; hc: Hex; hap: Hex };
    expect(out.ha).toBe(keccak256(encodeAbiParameters([{ type: 'uint8' }], [7])));
    expect(out.hb).toBe(keccak256(encodeAbiParameters([{ type: 'uint256' }], [123n])));
    expect(out.hc).toBe(keccak256(word)); // bytes32: abi.encode(x) IS the word
    expect(out.hap).toBe(keccak256('0x07')); // explicit packed: one byte
  });
});
