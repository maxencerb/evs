/**
 * Shared codec subroutines on a real node (issue #95; the anvil mirror of
 * `src/differential/shared-codecs.test.ts`).
 *
 * A tuple or composite-array codec used at several sites is emitted once and called from each.
 * Against the solc 0.8.30 fixtures, in both execution modes:
 *
 * - `Shapes.echoGrid(Position[][])` chained through 4 sites (one shared array encoder, one shared
 *   nested-array decoder), and `Shapes.echoNames2(string[2])` through 3;
 * - `Composite.positions` (a static struct) and `Composite.getWithBytes` (a dynamic one) read at
 *   3 sites each, strict and try (two shared decoders, plus the two return-record encoders);
 * - `Malformed.echoRaw(bytes)` declared to return a struct: a malformed payload at site k of 3
 *   reverts `EvsDecodeError(site k)`, and a decode-work budget bomb at one of two sites fails that
 *   site alone, strict and try.
 */

import {
  type Abi,
  concat,
  getAddress,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
} from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t, type CompiledEvsScript } from '../../src/index.js';
import { Composite, Malformed, Shapes } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { word } from '../harness/fixtures.js';
import { callExpectRevert, deploy } from './helpers.js';

let shapes: `0x${string}`;
let composite: `0x${string}`;
let malformed: `0x${string}`;

beforeAll(async () => {
  shapes = await deploy(Shapes.abi, Shapes.bytecode);
  composite = await deploy(Composite.abi, Composite.bytecode);
  malformed = await deploy(Malformed.abi, Malformed.bytecode);
});

const addr = (n: bigint): `0x${string}` => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const position = (i: bigint) => ({
  nonce: i & ((1n << 96n) - 1n),
  operator: addr((i * 3n + 1n) & ((1n << 160n) - 1n)),
  liquidity: (i * 1000n + 7n) & ((1n << 128n) - 1n),
});
const grid = [[position(1n)], [position(2n), position(3n)], [], [position(4n)]];

/** The names of the shared bodies a program carries (`enc_<k>` / `dec_<k>`). */
const bodiesOf = (compiled: CompiledEvsScript): string[] =>
  compiled.sourceMap.labels.map((l) => l.name).filter((n) => /^(enc|dec)_\d+$/.test(n));

const W8_COMPONENTS = [
  { name: 'f0', type: 'uint64' },
  { name: 'f1', type: 'address' },
  { name: 'f2', type: 'int32' },
  { name: 'f3', type: 'uint64' },
  { name: 'f4', type: 'address' },
  { name: 'f5', type: 'int32' },
  { name: 'f6', type: 'uint64' },
  { name: 'f7', type: 'address' },
  { name: 'label', type: 'string' },
] as const;
const W8_VALUE = {
  f0: 1n,
  f1: addr(0xaan),
  f2: -2,
  f3: 3n,
  f4: addr(0xbbn),
  f5: 5,
  f6: 6n,
  f7: addr(0xccn),
  label: 'a label longer than one word, to give the tail a second word',
};

/** `echoRaw(bytes) returns (output)`: the payload comes back as the returndata. */
const echoAs = (output: object): Abi => [
  {
    type: 'function',
    name: 'echoRaw',
    stateMutability: 'view',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [output],
  } as Abi[number],
];

describe.each(['stateOverride', 'deployless'] as const)('shared codecs on anvil [%s]', (mode) => {
  function callParams(compiled: CompiledEvsScript, data: Hex) {
    if (mode === 'deployless') return { code: compiled.toViem().code, data };
    const p = compiled.toViem({ mode: 'stateOverride' });
    return { to: p.address, stateOverride: p.stateOverride, data };
  }

  async function run(compiled: CompiledEvsScript, args: readonly unknown[]): Promise<unknown> {
    const abi = compiled.abi as Abi;
    const functionName = (abi.find((x) => x.type === 'function') as { name: string }).name;
    const res = await publicClient.call(
      callParams(compiled, encodeFunctionData({ abi, functionName, args })),
    );
    return decodeFunctionResult({ abi, functionName, data: res.data ?? '0x' });
  }

  test('Position[][] chained through 4 echoGrid sites', async () => {
    const compiled = evscript(
      {
        name: 'grid4',
        args: [
          t.address,
          t.array(
            t.array(t.struct({ nonce: t.uint96, operator: t.address, liquidity: t.uint128 })),
          ),
        ],
      },
      (s: any, target: any, g: any) => {
        let last = g;
        for (let i = 0; i < 4; i++) {
          last = s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'echoGrid',
            args: [last],
          });
        }
        return s.return({ last });
      },
    ).compile() as unknown as CompiledEvsScript;
    expect(bodiesOf(compiled)).toEqual(['enc_0', 'dec_1']);
    expect(await run(compiled, [shapes, grid])).toEqual({ last: grid });
  });

  test('string[2] chained through 3 echoNames2 sites', async () => {
    const compiled = evscript(
      { name: 'names3', args: [t.address, 'string[2]'] },
      (s: any, target: any, ns: any) => {
        let last = ns;
        for (let i = 0; i < 3; i++) {
          last = s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'echoNames2',
            args: [last],
          });
        }
        return s.return({ last });
      },
    ).compile() as unknown as CompiledEvsScript;
    expect(bodiesOf(compiled)).toEqual(['enc_0', 'dec_1']);
    const names = ['', `a name that does not fit in one word ${'x'.repeat(20)}`];
    expect(await run(compiled, [shapes, names])).toEqual({ last: names });
  });

  test('struct getters read at 3 sites, strict and try (shared decoders and return encoders)', async () => {
    const compiled = evscript({ name: 'getters', args: [t.address] }, (s: any, target: any) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < 3; i++) {
        const verb = i === 1 ? 'tryRead' : 'read';
        const p = s[verb]({
          address: target,
          abi: Composite.abi,
          functionName: 'positions',
          args: [BigInt(i + 5)],
        });
        const w = s[verb]({ address: target, abi: Composite.abi, functionName: 'getWithBytes' });
        out[`p${i}`] = verb === 'tryRead' ? p.value : p;
        out[`w${i}`] = verb === 'tryRead' ? w.value : w;
      }
      return s.return(out);
    }).compile() as unknown as CompiledEvsScript;
    // the two decoders, and the two return-record encoders (each struct is returned 3 times)
    expect(bodiesOf(compiled)).toEqual(['dec_0', 'dec_1', 'enc_2', 'enc_3']);
    const direct = (id: bigint) =>
      publicClient.readContract({
        address: composite,
        abi: Composite.abi,
        functionName: 'positions',
        args: [id],
      });
    const withBytes = await publicClient.readContract({
      address: composite,
      abi: Composite.abi,
      functionName: 'getWithBytes',
    });
    expect(await run(compiled, [composite])).toEqual({
      p0: await direct(5n),
      w0: withBytes,
      p1: await direct(6n),
      w1: withBytes,
      p2: await direct(7n),
      w2: withBytes,
    });
  });

  test('a malformed payload at site k of 3 reverts EvsDecodeError(site k)', async () => {
    const abi = echoAs({ name: '', type: 'tuple', components: W8_COMPONENTS });
    const compiled = evscript(
      { name: 'sites3', args: [t.address, t.bytes, t.bytes, t.bytes] },
      (s: any, target: any, ...payloads: any[]) => {
        const out: Record<string, unknown> = {};
        payloads.forEach((p, i) => {
          out[`v${i}`] = s.read({ address: target, abi, functionName: 'echoRaw', args: [p] });
        });
        return s.return(out);
      },
    ).compile() as unknown as CompiledEvsScript;
    expect(bodiesOf(compiled)).toContain('dec_0');
    const good = encodeAbiParameters([{ type: 'tuple', components: W8_COMPONENTS }], [W8_VALUE]);
    const truncated: Hex = `0x${good.slice(2, -64)}`; // the label's last word cut off
    expect(await run(compiled, [malformed, good, good, good])).toEqual({
      v0: W8_VALUE,
      v1: W8_VALUE,
      v2: W8_VALUE,
    });
    const decodeSites = compiled.sourceMap.sites
      .filter((x) => x.kind === 'decode')
      .map((x) => x.id);
    for (const k of [0, 1, 2]) {
      const args = [malformed, good, good, good].map((a, i) => (i === k + 1 ? truncated : a));
      const raw = await callExpectRevert(
        callParams(
          compiled,
          encodeFunctionData({ abi: compiled.abi as Abi, functionName: 'sites3', args }),
        ),
      );
      expect(raw).toBe(concat(['0x20cf27b7', word(BigInt(decodeSites[k] ?? -1))]));
      expect(compiled.explainRevert(raw).site?.id).toBe(decodeSites[k]);
    }
  });

  test('a decode-work budget bomb at one of two shared sites fails that site alone', async () => {
    const abi = echoAs({ name: '', type: 'uint8[][]' });
    const compiled = evscript(
      { name: 'bomb', args: [t.address, t.bytes, t.bytes] },
      (s: any, target: any, p: any, q: any) => {
        const a = s.tryRead({ address: target, abi, functionName: 'echoRaw', args: [p] });
        const b = s.read({ address: target, abi, functionName: 'echoRaw', args: [q] });
        return s.return({ ok: a.success, n: a.value.length(), m: b.length() });
      },
    ).compile() as unknown as CompiledEvsScript;
    expect(bodiesOf(compiled)).toContain('dec_0');
    const rep = (n: number, x: bigint): bigint[] => Array.from({ length: n }, () => x);
    // N offsets at one inner [L][1 …]: re-materialized N times, past the budget for N = L = 600
    const overlap = (n: number, l: number): Hex =>
      concat(
        [0x20n, BigInt(n), ...rep(n, BigInt(32 * n)), BigInt(l), ...rep(l, 1n)].map((x) => word(x)),
      );
    const fine = overlap(40, 40);
    const bomb = overlap(600, 600);
    expect(await run(compiled, [malformed, fine, fine])).toEqual({ ok: true, n: 40n, m: 40n });
    expect(await run(compiled, [malformed, bomb, fine])).toEqual({ ok: false, n: 0n, m: 40n });
    const raw = await callExpectRevert(
      callParams(
        compiled,
        encodeFunctionData({
          abi: compiled.abi as Abi,
          functionName: 'bomb',
          args: [malformed, fine, bomb],
        }),
      ),
    );
    const strictSite = compiled.sourceMap.sites.find((x) => x.kind === 'decode')?.id;
    expect(compiled.explainRevert(raw).site?.id).toBe(strictSite);
  }, 30_000);
});
