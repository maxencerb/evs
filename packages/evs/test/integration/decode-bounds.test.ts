/**
 * Decode bounds on a real node (the anvil mirror of `src/differential/decode-bounds.test.ts`).
 *
 * `Malformed.echoRaw(bytes)` returns its argument verbatim as the returndata, so each case
 * declares `echoRaw` with the output shape it needs and hands it the crafted payload:
 *
 * - a huge in-range length word (2^20 … 2^64−1) under stack-path and heap-path shapes: strict
 *   reads revert `EvsDecodeError(site)`, try reads return `success = false` + the zero value —
 *   never an out-of-gas halt;
 * - nested dynamic structs whose head is cut short: rejected like any malformed returndata;
 * - two outputs sharing bytes (aliased tails): each decodes as if it were alone;
 * - N element offsets at one inner array (overlapping offsets, ~38 KB of returndata that used to
 *   cost ~290M gas to decode): a full-word `uint256[][]` aliases its inner arrays and decodes,
 *   copied or re-decoded shapes (narrow copies, wide structs, fixed-size `T[N]` blocks) exhaust
 *   the decode-work budget and fail cleanly, inside the default gas cap;
 * - script args with a huge length word: `EvsInvalidCalldata`.
 *
 * Both execution modes (state override and deployless).
 */

import {
  type Abi,
  type AbiParameter,
  concat,
  decodeFunctionResult,
  encodeFunctionData,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t, type CompiledEvsScript, type EvsType, type Expr } from '../../src/index.js';
import { Malformed } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { word } from '../harness/fixtures.js';
import { callExpectRevert, deploy } from './helpers.js';

const words = (...ws: readonly bigint[]): Hex => concat(ws.map((x) => word(x)));

let malformed: `0x${string}`;
beforeAll(async () => {
  malformed = await deploy(Malformed.abi, Malformed.bytecode);
});

function echoAbi(outputs: readonly AbiParameter[]): Abi {
  return [
    {
      type: 'function',
      name: 'echoRaw',
      stateMutability: 'view',
      inputs: [{ name: 'data', type: 'bytes' }],
      outputs: [...outputs],
    },
  ];
}

type LooseRead = (opts: {
  address: Expr<'address'>;
  abi: Abi;
  functionName: 'echoRaw';
  args: readonly [Expr<'bytes'>];
}) => unknown;

/** Several outputs come back as a JS array of handles: return them as `v0, v1, …`. */
const fields = (v: unknown): Record<string, Expr> =>
  Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [`v${i}`, x as Expr])) : { v: v as Expr };

function scripts(outputs: readonly AbiParameter[]) {
  const abi = echoAbi(outputs);
  const strict = evscript({ name: 'strict', args: [t.address, t.bytes] }, (s, target, payload) => {
    const v = (s.read as unknown as LooseRead)({
      address: target,
      abi,
      functionName: 'echoRaw',
      args: [payload],
    });
    return s.return(fields(v));
  }).compile() as unknown as CompiledEvsScript;
  const attempt = evscript(
    { name: 'attempt', args: [t.address, t.bytes] },
    (s, target, payload) => {
      const r = (s.tryRead as unknown as LooseRead)({
        address: target,
        abi,
        functionName: 'echoRaw',
        args: [payload],
      });
      const tr = r as { success: Expr<'bool'>; value: unknown };
      return s.return({ ok: tr.success, ...fields(tr.value) });
    },
  ).compile() as unknown as CompiledEvsScript;
  return { strict, attempt };
}

describe.each(['stateOverride', 'deployless'] as const)('decode bounds on anvil [%s]', (mode) => {
  function callParams(compiled: { toViem: CompiledEvsScript['toViem'] }, data: Hex) {
    if (mode === 'deployless') return { code: compiled.toViem().code, data };
    const p = compiled.toViem({ mode: 'stateOverride' });
    return { to: p.address, stateOverride: p.stateOverride, data };
  }

  async function expectStrictDecodeError(compiled: CompiledEvsScript, payload: Hex): Promise<void> {
    const raw = await callExpectRevert(
      callParams(
        compiled,
        encodeFunctionData({
          abi: compiled.abi as Abi,
          functionName: 'strict',
          args: [malformed, payload],
        }),
      ),
    );
    expect(compiled.explainRevert(raw).kind).toBe('evs-decode');
  }

  async function run(compiled: CompiledEvsScript, fn: string, payload: Hex): Promise<unknown> {
    const abi = compiled.abi as Abi;
    const res = await publicClient.call(
      callParams(
        compiled,
        encodeFunctionData({ abi, functionName: fn, args: [malformed, payload] }),
      ),
    );
    return decodeFunctionResult({ abi, functionName: fn, data: res.data ?? '0x' });
  }

  const LENGTH_SHAPES: readonly [string, AbiParameter, unknown][] = [
    ['string[] (stack path)', { name: 'r', type: 'string[]' }, []],
    ['uint256[][] (stack path)', { name: 'r', type: 'uint256[][]' }, []],
    ['uint256[2][] (heap path)', { name: 'r', type: 'uint256[2][]' }, []],
    ['uint256[][][] (heap path)', { name: 'r', type: 'uint256[][][]' }, []],
    ['uint256[][2] (heap path)', { name: 'r', type: 'uint256[][2]' }, [[], []]],
  ];
  const HUGE = [1n << 20n, 1n << 32n, (1n << 64n) - 1n];

  test.each(LENGTH_SHAPES)('%s: huge in-range length word fails cleanly', async (_, out, zero) => {
    const { strict, attempt } = scripts([out]);
    for (const h of HUGE) {
      const payload = words(0x20n, h, 0x20n, 1n);
      await expectStrictDecodeError(strict, payload);
      expect(await run(attempt, 'attempt', payload)).toEqual({ ok: false, v: zero });
    }
  });

  const ABS = [
    { name: 'a', type: 'uint256' },
    { name: 'b', type: 'uint256' },
    { name: 's', type: 'string' },
  ] as const;
  const SHORT_HEADS: readonly [string, AbiParameter, Hex, unknown][] = [
    [
      'tuple(a,b,s)',
      { name: 'r', type: 'tuple', components: ABS },
      words(0x20n, 0n),
      { a: 0n, b: 0n, s: '' },
    ],
    [
      'tuple(a,b,s)[]',
      { name: 'r', type: 'tuple[]', components: ABS },
      words(0x20n, 1n, 0x20n, 0n),
      [],
    ],
    [
      'tuple(x, tuple(a,b,s))',
      {
        name: 'r',
        type: 'tuple',
        components: [
          { name: 'x', type: 'uint256' },
          { name: 'inner', type: 'tuple', components: ABS },
        ],
      },
      words(0x20n, 9n, 0x40n, 0n),
      { x: 0n, inner: { a: 0n, b: 0n, s: '' } },
    ],
  ];

  test.each(SHORT_HEADS)(
    '%s with a short nested head is rejected',
    async (_, out, payload, zero) => {
      const { strict, attempt } = scripts([out]);
      await expectStrictDecodeError(strict, payload);
      expect(await run(attempt, 'attempt', payload)).toEqual({ ok: false, v: zero });
    },
  );

  test('aliased tails: (uint8[] a, uint256[] b) sharing one tail decode independently', async () => {
    const { strict, attempt } = scripts([
      { name: 'a', type: 'uint8[]' },
      { name: 'b', type: 'uint256[]' },
    ]);
    const payload = words(0x40n, 0x40n, 1n, 0x1ffn);
    expect(await run(strict, 'strict', payload)).toEqual({ v0: [255], v1: [511n] });
    expect(await run(attempt, 'attempt', payload)).toEqual({ ok: true, v0: [255], v1: [511n] });
  });

  /** Like {@link scripts}, but returning only the decoded array's length (`n`). */
  function lengthScripts(output: AbiParameter) {
    const abi = echoAbi([output]);
    type Arr = { length: () => Expr<'uint256'> };
    const strict = evscript(
      { name: 'strict', args: [t.address, t.bytes] },
      (s, target, payload) => {
        const v = (s.read as unknown as LooseRead)({
          address: target,
          abi,
          functionName: 'echoRaw',
          args: [payload],
        });
        return s.return({ n: (v as Arr).length() });
      },
    ).compile() as unknown as CompiledEvsScript;
    const attempt = evscript(
      { name: 'attempt', args: [t.address, t.bytes] },
      (s, target, payload) => {
        const r = (s.tryRead as unknown as LooseRead)({
          address: target,
          abi,
          functionName: 'echoRaw',
          args: [payload],
        });
        const tr = r as { success: Expr<'bool'>; value: Arr };
        return s.return({ ok: tr.success, n: tr.value.length() });
      },
    ).compile() as unknown as CompiledEvsScript;
    return { strict, attempt };
  }

  const rep = (n: number, x: bigint): bigint[] => Array.from({ length: n }, () => x);
  const N = 600;
  const OVERLAPS: readonly [string, AbiParameter, Hex, boolean][] = [
    [
      'uint256[][] (inner arrays aliased: decodes)',
      { name: 'r', type: 'uint256[][]' },
      words(0x20n, BigInt(N), ...rep(N, BigInt(32 * N)), BigInt(N), ...rep(N, 1n)),
      true,
    ],
    [
      'uint8[][] (copies: over budget)',
      { name: 'r', type: 'uint8[][]' },
      words(0x20n, BigInt(N), ...rep(N, BigInt(32 * N)), BigInt(N), ...rep(N, 1n)),
      false,
    ],
    [
      '(uint8[] a)[] (copies: over budget)',
      { name: 'r', type: 'tuple[]', components: [{ name: 'a', type: 'uint8[]' }] },
      words(0x20n, BigInt(N), ...rep(N, BigInt(32 * N)), 0x20n, BigInt(N), ...rep(N, 1n)),
      false,
    ],
    [
      '(uint256 ×100, string)[] (wide struct re-decoded: over budget)',
      {
        name: 'r',
        type: 'tuple[]',
        components: [
          ...rep(100, 0n).map((_, i) => ({ name: `a${i}`, type: 'uint256' })),
          { name: 's', type: 'string' },
        ],
      },
      words(0x20n, BigInt(N), ...rep(N, BigInt(32 * N)), ...rep(100, 1n), 32n * 101n, 0n),
      false,
    ],
    [
      'uint256[100][][] (fixed-size blocks re-decoded: over budget)',
      { name: 'r', type: 'uint256[100][][]' },
      // L=5 inner elements keep the payload (35 KB) under deployless mode's 48 KiB initcode cap
      words(0x20n, BigInt(N), ...rep(N, BigInt(32 * N)), 5n, ...rep(500, 1n)),
      false,
    ],
  ];

  test.each(OVERLAPS)('overlapping offsets, N=600: %s', async (_, out, payload, decodes) => {
    const { strict, attempt } = lengthScripts(out);
    if (decodes) {
      expect(await run(strict, 'strict', payload)).toEqual({ n: BigInt(N) });
      expect(await run(attempt, 'attempt', payload)).toEqual({ ok: true, n: BigInt(N) });
    } else {
      await expectStrictDecodeError(strict, payload);
      expect(await run(attempt, 'attempt', payload)).toEqual({ ok: false, n: 0n });
    }
  });

  const ARG_TYPES: readonly [string, EvsType][] = [
    ['string[] (stack path)', 'string[]'],
    ['uint256[2][] (heap path)', 'uint256[2][]'],
    ['uint256[][][] (heap path)', 'uint256[][][]'],
  ];
  test.each(ARG_TYPES)(
    'script arg %s with a huge length word → EvsInvalidCalldata',
    async (_, type) => {
      const compiled = evscript({ name: 'y', args: [type] as never }, (s, a) =>
        s.return({ n: (a as unknown as { length: () => Expr<'uint256'> }).length() }),
      ).compile();
      const fn = (compiled.abi as Abi).find((x) => x.type === 'function');
      const selector = toFunctionSelector(fn as never);
      for (const h of HUGE) {
        const raw = await callExpectRevert(
          callParams(compiled, concat([selector, words(0x20n, h)])),
        );
        expect(raw).toBe('0xf43fed56');
      }
    },
  );
});
