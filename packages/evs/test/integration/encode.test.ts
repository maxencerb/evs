/**
 * testing.md §4.4: `s.encode` / `s.encodePacked` / `s.keccak256` vs solc — the on-chain
 * differential (issue #17).
 *
 * For every EvsReference encode/hash function, the deployed solc 0.8.30 contract and the
 * equivalent evs script are driven with the same corpus over eth_call; the decoded results
 * must be BYTE-IDENTICAL. The evs side runs in the default deployless `toViem()` mode, so the
 * whole calldata-decode → encode/hash → return-encode pipeline is exercised end to end.
 * Covers both the pre-encoded path (`hashBytes` — hash a bytes value directly) and the
 * raw-args paths (`hashPacked` — keccak256 over packed args; `hashEncoded` —
 * `s.keccak256(s.encode(...))`).
 */

import type { Abi } from 'viem';
import { beforeAll, describe, expect, test } from 'vitest';

import { compile, evscript, t, type EvsType, type Expr } from '../../src/index.js';
import { EvsReference } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy } from './helpers.js';

const Pair = t.struct({ token: t.address, fee: t.uint24 });
const Order = t.struct({ id: t.uint256, label: t.string, amounts: t.array(t.uint128) });

const beef = '0x00000000000000000000000000000000deadbeef';
const cafe = '0x00000000000000000000000000000000cafebabe';

type Op = 'encode' | 'encodePacked' | 'keccak256' | 'keccakOfEncode';

interface Case {
  fn: string;
  op: Op;
  args: readonly EvsType[];
  corpus: readonly (readonly unknown[])[];
}

const CASES: readonly Case[] = [
  {
    fn: 'encodeWords',
    op: 'encode',
    args: [t.uint8, t.int64, t.address, t.bool, t.bytes32],
    corpus: [
      [0n, 0n, beef, false, `0x${'00'.repeat(32)}`],
      [255n, -1n, cafe, true, `0x${'ff'.repeat(32)}`],
      [7n, -(1n << 63n), beef, true, `0x12${'00'.repeat(31)}`],
    ],
  },
  {
    fn: 'encodeDyn',
    op: 'encode',
    args: [t.string, t.bytes, t.array(t.uint256)],
    corpus: [
      ['', '0x', []],
      ['hello evs ✓', `0x${'ab'.repeat(33)}`, [1n, (1n << 256n) - 1n]],
      ['exactly-32-bytes-of-ascii-here!!', `0x${'cd'.repeat(32)}`, [0n]],
    ],
  },
  {
    fn: 'encodeStruct',
    op: 'encode',
    args: [Pair, Order],
    corpus: [
      [
        { token: beef, fee: 500n },
        { id: 7n, label: 'order #7', amounts: [1n, 2n, 3n] },
      ],
      [
        { token: cafe, fee: 0n },
        { id: 0n, label: '', amounts: [] },
      ],
    ],
  },
  {
    fn: 'encodeComposite',
    op: 'encode',
    args: ['string[]', 'uint256[][]', t.array(Pair)],
    corpus: [
      [[], [], []],
      [
        ['', 'one', 'twos'],
        [[], [1n, 2n], [3n]],
        [
          { token: beef, fee: 500n },
          { token: cafe, fee: 10000n },
        ],
      ],
    ],
  },
  {
    fn: 'packedWords',
    op: 'encodePacked',
    args: [t.uint8, t.int64, t.address, t.bool, t.bytes3],
    corpus: [
      [0n, 0n, beef, false, '0x000000'],
      [255n, -1n, cafe, true, '0xffffff'],
      [1n, -(1n << 63n), beef, true, '0x0a0b0c'],
    ],
  },
  {
    fn: 'packedDyn',
    op: 'encodePacked',
    args: [t.string, t.bytes, t.array(t.uint16)],
    corpus: [
      ['', '0x', []],
      ['héllo αβ', '0x00ff00ff00', [1n, 65535n, 256n]],
    ],
  },
  {
    fn: 'hashBytes',
    op: 'keccak256',
    args: [t.bytes],
    corpus: [['0x'], ['0x01'], [`0x${'5a'.repeat(95)}`]],
  },
  {
    fn: 'hashPacked',
    op: 'keccak256',
    args: [t.uint8, t.uint256, t.string],
    corpus: [
      [0n, 0n, ''],
      [255n, (1n << 256n) - 1n, 'transfer(address,uint256)'],
    ],
  },
  {
    fn: 'hashEncoded',
    op: 'keccakOfEncode',
    args: [t.uint256, t.string],
    corpus: [
      [0n, ''],
      [42n, 'héllo ✓'],
    ],
  },
];

function buildScript(c: Case) {
  return evscript({ name: c.fn, args: c.args as [EvsType, ...EvsType[]] }, (s, ...rawArgs) => {
    const args = rawArgs as unknown as [Expr, ...Expr[]];
    const r =
      c.op === 'encode'
        ? s.encode(...args)
        : c.op === 'encodePacked'
          ? s.encodePacked(...args)
          : c.op === 'keccak256'
            ? s.keccak256(...args)
            : s.keccak256(s.encode(...args));
    return s.return({ r });
  });
}

let reference: `0x${string}`;

beforeAll(async () => {
  reference = await deploy(EvsReference.abi, EvsReference.bytecode);
});

describe('encode/encodePacked/keccak256: evs vs solc 0.8.30 (EvsReference)', () => {
  test.each(CASES.map((c) => [c.fn, c] as const))('%s', async (_name, c) => {
    const compiled = compile(buildScript(c));
    const deployless = compiled.toViem();

    for (const values of c.corpus) {
      const solc = await publicClient.readContract({
        address: reference,
        abi: EvsReference.abi as Abi,
        functionName: c.fn,
        args: values as never,
      });
      const evs = (await publicClient.readContract({
        ...deployless,
        functionName: c.fn,
        args: values as never,
      })) as { r: unknown };
      expect(
        evs.r,
        `${c.fn}(${JSON.stringify(values, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))})`,
      ).toBe(solc);
    }
  });
});
