/**
 * Address / fixed-bytes conversions and string/bytes byte access vs solc 0.8.30.
 *
 * Every EvsCastReference function is paired with the equivalent evs script and driven with the
 * same corpus on anvil (stateOverride `eth_call`s): the decoded results must be equal (an evs
 * script returns its named results as one struct, solc the bare values) and the revert payloads
 * BYTE-IDENTICAL where solc panics (`b[i]` out of range is `Panic(0x32)` on both sides). The one documented difference: a calldata slice out of range reverts without data in
 * solc, where evs `slice` reverts with `Panic(0x32)` — both must revert.
 */

import { decodeFunctionResult, encodeFunctionData, stringToHex, type Abi, type Hex } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t, type EvsType } from '../../src/index.js';
import { EvsCastReference } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, extractRevertData } from './helpers.js';

const PANIC_OOB: Hex = `0x4e487b71${(0x32).toString(16).padStart(64, '0')}`;

const ADDRS = [
  '0x0000000000000000000000000000000000000001',
  '0x7fffffffffffffffffffffffffffffffffffffff',
  '0xffffffffffffffffffffffffffffffffffffffff',
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
] as const;
const cross = <a, b>(xs: readonly a[], ys: readonly b[]): [a, b][] =>
  xs.flatMap((x) => ys.map((y): [a, b] => [x, y]));
const word = (hex: string): Hex => `0x${hex.padEnd(64, '0')}`;
const B4 = ['0x00000000', '0x00ffffff', '0xff000000', '0x12345678', '0xffffffff'] as const;
const B32 = [word(''), word('01'), word('0001'), `0x${'ff'.repeat(32)}`, word('ff')] as const;
const UINTS = [0n, 1n, 0x7fn, 0x80n, 0xffn] as const;
const BYTES: readonly Hex[] = [
  '0x',
  '0x01',
  '0x0102030405',
  `0x${Array.from({ length: 70 }, (_, k) => (k + 1).toString(16).padStart(2, '0')).join('')}`,
];
const STRINGS = ['', 'a', 'hello', 'vitalik.eth', 'x'.repeat(40)];
const SYMBOLS: readonly Hex[] = [
  stringToHex('MKR', { size: 32 }),
  stringToHex('SAI', { size: 32 }),
  word(''),
  `0x${'41'.repeat(32)}`,
  word('4100420000'),
  `0x${'00'.repeat(31)}41`,
];

interface Pair {
  /** EvsCastReference function name == the evs script name. */
  fn: string;
  args: readonly EvsType[];
  // the arg types are dynamic over the table: the callback is untyped on purpose
  body: (s: any, ...a: any[]) => unknown;
  corpus: readonly (readonly unknown[])[];
  /** solc reverts without data where evs panics (calldata slices). */
  slice?: boolean;
}

const order = (s: any, a: any, b: any) =>
  s.return({ lt: a.lt(b), lte: a.lte(b), gt: s.gt(a, b), gte: s.gte(a, b) });
const sliceRows = BYTES.flatMap((b) => {
  const n = BigInt((b.length - 2) / 2);
  return [
    [b, 0n, n],
    [b, 0n, 0n],
    [b, n > 1n ? 1n : 0n, n],
    [b, n, n],
    [b, 0n, n + 1n], // end past the length
    [b, n > 0n ? 1n : 0n, 0n], // start > end (when n > 0)
  ];
});

const PAIRS: Pair[] = [
  { fn: 'orderAddress', args: ['address', 'address'], body: order, corpus: cross(ADDRS, ADDRS) },
  { fn: 'orderBytes4', args: ['bytes4', 'bytes4'], body: order, corpus: cross(B4, B4) },
  { fn: 'orderBytes32', args: ['bytes32', 'bytes32'], body: order, corpus: cross(B32, B32) },
  {
    fn: 'sortTokens',
    args: ['address', 'address'],
    body: (s, a, b) => {
      const lt = a.lt(b);
      return s.return({ token0: s.select(lt, a, b), token1: s.select(lt, b, a) });
    },
    corpus: cross(ADDRS, ADDRS),
  },
  {
    fn: 'addressToUint160',
    args: ['address'],
    body: (s, a) => s.return({ r: a.asUint160() }),
    corpus: ADDRS.map((a) => [a]),
  },
  {
    fn: 'addressToUint256',
    args: ['address'],
    body: (s, a) => s.return({ r: a.asUint160().toUint(t.uint256) }),
    corpus: ADDRS.map((a) => [a]),
  },
  {
    fn: 'uint160ToAddress',
    args: ['uint160'],
    body: (s, u) => s.return({ r: u.asAddress() }),
    corpus: [[0n], [1n], [(1n << 160n) - 1n], [0xabcn << 100n]],
  },
  ...(
    [
      ['bytes1ToUint8', 'bytes1', ['0x00', '0x7f', '0x80', '0xff']],
      ['bytes4ToUint32', 'bytes4', B4],
      ['bytes20ToUint160', 'bytes20', ADDRS],
      ['bytes32ToUint256', 'bytes32', B32],
    ] as const
  ).map(([fn, ty, xs]): Pair => ({
    fn,
    args: [ty],
    body: (s, b) => s.return({ r: b.asUint() }),
    corpus: xs.map((x) => [x]),
  })),
  ...(
    [
      ['uint8ToBytes1', 'uint8', 8n],
      ['uint32ToBytes4', 'uint32', 32n],
      ['uint160ToBytes20', 'uint160', 160n],
      ['uint256ToBytes32', 'uint256', 256n],
    ] as const
  ).map(([fn, ty, bits]): Pair => ({
    fn,
    args: [ty],
    body: (s, u) => s.return({ r: u.asBytesN() }),
    corpus: [...UINTS, (1n << bits) - 1n, 0x0102n].filter((u) => u < 1n << bits).map((u) => [u]),
  })),
  {
    fn: 'byteAtBytes',
    args: ['bytes', 'uint256'],
    body: (s, b, i) => s.return({ r: b.byteAt(i) }),
    corpus: cross(BYTES, [0n, 1n, 4n, 5n, 69n, 70n]),
  },
  {
    fn: 'byteAtString',
    args: ['string', 'uint256'],
    body: (s, str, i) => s.return({ r: str.byteAt(i) }),
    corpus: cross(STRINGS, [0n, 1n, 10n, 11n, 39n]),
  },
  {
    fn: 'sliceBytes',
    args: ['bytes', 'uint256', 'uint256'],
    body: (s, b, start, end) => s.return({ r: b.slice(start, end) }),
    corpus: sliceRows,
    slice: true,
  },
  {
    fn: 'sliceBytesFrom',
    args: ['bytes', 'uint256'],
    body: (s, b, start) => s.return({ r: b.slice(start) }),
    corpus: cross(BYTES, [0n, 1n, 5n, 6n]),
    slice: true,
  },
  {
    fn: 'sliceString',
    args: ['string', 'uint256', 'uint256'],
    body: (s, str, start, end) => s.return({ r: str.slice(start, end) }),
    corpus: [
      ['hello', 1n, 4n],
      ['hello', 0n, 5n],
      ['hello', 5n, 5n],
      ['vitalik.eth', 0n, 7n],
      ['vitalik.eth', 8n, 11n],
      ['hello', 2n, 6n],
      ['hello', 3n, 2n],
    ],
    slice: true,
  },
  {
    fn: 'stringToBytes',
    args: ['string'],
    body: (s, str) => s.return({ r: str.asBytes() }),
    corpus: STRINGS.map((x) => [x]),
  },
  {
    fn: 'bytesToString',
    args: ['bytes'],
    body: (s, b) => s.return({ r: b.asString() }),
    corpus: BYTES.map((b) => [b]),
  },
  {
    fn: 'bytes32ToString',
    args: ['bytes32'],
    body: (s, b) => s.return({ r: b.asString() }),
    corpus: SYMBOLS.map((b) => [b]),
  },
  {
    fn: 'bytes4ToString',
    args: ['bytes4'],
    body: (s, b) => s.return({ r: b.asString() }),
    corpus: [...B4, '0x41004200', '0x00000041'].map((b) => [b]),
  },
];

let reference: Hex;

beforeAll(async () => {
  reference = await deploy(EvsCastReference.abi, EvsCastReference.bytecode);
});

/** eth_call → { ok, bytes } with the raw returndata or revert payload. */
async function rawCall(params: {
  to: Hex;
  data: Hex;
  stateOverride?: { address: Hex; code: Hex }[];
}): Promise<{ ok: boolean; bytes: Hex }> {
  try {
    const { data } = await publicClient.call(
      params.stateOverride === undefined
        ? { to: params.to, data: params.data }
        : { to: params.to, data: params.data, stateOverride: params.stateOverride },
    );
    return { ok: true, bytes: data ?? '0x' };
  } catch (err) {
    return { ok: false, bytes: extractRevertData(err) };
  }
}

describe('address / bytes conversions and byte access: evs vs solc 0.8.30 (EvsCastReference)', () => {
  test('every EvsCastReference function has an evs twin', () => {
    const fns = (EvsCastReference.abi as Abi).flatMap((e) =>
      e.type === 'function' ? [e.name] : [],
    );
    expect(PAIRS.map((p) => p.fn).toSorted()).toEqual(fns.toSorted());
  });

  test.each(PAIRS)('$fn', async (p) => {
    const script = evscript({ name: p.fn, args: p.args as ['uint256'] }, p.body as never);
    const compiled = script.compile();
    const overrideParams = compiled.toViem({ mode: 'stateOverride' });
    const rows = await Promise.all(
      p.corpus.map(async (args) => {
        const [solc, evs] = await Promise.all([
          rawCall({
            to: reference,
            data: encodeFunctionData({
              abi: EvsCastReference.abi as Abi,
              functionName: p.fn,
              args,
            }),
          }),
          rawCall({
            to: overrideParams.address,
            stateOverride: overrideParams.stateOverride,
            data: encodeFunctionData({ abi: compiled.abi as Abi, functionName: p.fn, args }),
          }),
        ]);
        return { args, solc, evs };
      }),
    );
    for (const { args, solc, evs } of rows) {
      const ctx = `${p.fn}(${args.map(String).join(', ')})`;
      expect(evs.ok, `${ctx}: success/revert disagreement (solc ok=${solc.ok})`).toBe(solc.ok);
      if (solc.ok) {
        // an evs script returns one struct (its named results); solc the bare values
        const solcValue: unknown = decodeFunctionResult({
          abi: EvsCastReference.abi as Abi,
          functionName: p.fn,
          data: solc.bytes,
        });
        const evsValue = decodeFunctionResult({
          abi: compiled.abi as Abi,
          functionName: p.fn,
          data: evs.bytes,
        }) as Record<string, unknown>;
        expect(Object.values(evsValue), `${ctx}: value mismatch`).toEqual(
          Array.isArray(solcValue) ? solcValue : [solcValue],
        );
      } else if (p.slice === true) {
        expect(evs.bytes, `${ctx}: evs slice bounds revert`).toBe(PANIC_OOB);
      } else {
        expect(evs.bytes, `${ctx}: Panic payload mismatch`).toBe(solc.bytes);
      }
    }
  });
});
