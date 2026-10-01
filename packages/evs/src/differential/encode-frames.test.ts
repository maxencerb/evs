/* oxlint-disable typescript/no-unsafe-type-assertion --
 * the corpus drives evscript/viem with runtime-built struct types and loose values, not
 * literals — the casts are the documented dynamic-corpus pattern (see deep-shapes.test.ts). */
/**
 * Differential suite — the ABI encoder's encode frames.
 *
 * The encoder keeps its state in frames reserved below the output buffer. An array loop caches
 * the element pointer (`elem`) and a tuple element's base (`base`) in its frame once per
 * iteration; dynamic tuples nested three or more levels below their root (the top-level block or
 * an array element) keep their own base and source pointer in a frame of their own, while the
 * first two levels re-derive them from the parent. This slice drives every one of those paths —
 * cached and uncached element pointers, frameless and framed tuple levels, framed levels inside
 * array elements inside framed levels — through all four encode entry points (the return
 * encoder, `s.encode`, a call's calldata, a simulate's wrapped payload) on every fork, and
 * checks the bytes against viem and the interpreter. A last test pins the encode cost of one
 * more nesting level as flat (it used to grow with the depth).
 */

import type { Abi, AbiParameter } from 'abitype';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  expectAgreement,
  SINK,
  EVM_VERSIONS,
  abiEchoMock,
  type AnyScript,
  type CalleeTable,
} from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { layoutOfType } from '../abi/layout.js';
import { evscript } from '../builder/script.js';
import { encodeFramesOf } from '../codegen/abi.js';
import { compile } from '../compile.js';
import { t, type EvsType, type Hex, type TupleType } from '../core/types.js';

/** A dynamic struct chain `d` levels deep below the value itself (`d = 0`: a flat struct). */
function nested(d: number): TupleType {
  if (d === 0) return t.struct({ leaf: t.uint64, name: t.string });
  return t.struct({ a: t.uint128, s: t.string, xs: t.array(t.uint8), inner: nested(d - 1) });
}
function nestedValue(d: number): unknown {
  if (d === 0) return { leaf: 7n, name: `leaf-${'n'.repeat(d + 40)}` };
  return { a: BigInt(d), s: `level-${d}`, xs: [1, 2, 3], inner: nestedValue(d - 1) };
}

// wide tuple elements (multi-member: the element pointer and base are cached per iteration)
const Wide = t.struct({
  f0: t.uint64,
  f1: t.bool,
  f2: t.int32,
  f3: t.bytes32,
  f4: t.uint16,
  label: t.string,
});
const wide = (i: number): unknown => ({
  f0: BigInt(i),
  f1: i % 2 === 0,
  f2: 5 - 3 * i,
  f3: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  f4: i * 3,
  label: i === 1 ? '' : `row ${i}${'.'.repeat(i * 9)}`,
});
const StaticWide = t.struct({ f0: t.uint64, f1: t.int32, f2: t.bool, f3: t.uint16 });
const staticWide = (i: number): unknown => ({ f0: BigInt(i), f1: 1 - 2 * i, f2: i > 1, f3: i });

// single-member elements (the element pointer is read once: no cache)
const OneWord = t.struct({ x: t.uint256 });
const OneString = t.struct({ s: t.string });
const Wrapped = t.struct({ inner: OneString });

const P = t.struct({ x: t.uint16, y: t.uint8 });
const Row = t.struct({ id: t.uint32, ps: t.array(P), tag: t.string });

// framed tuple levels inside array elements inside framed tuple levels
const Deep = t.struct({ tag: t.string, rows: t.array(nested(3)), tail: nested(2) });
const DeepHolder = t.struct({ k: t.uint8, deep: t.struct({ s: t.string, d: Deep }) });
const deepHolder = {
  k: 9,
  deep: {
    s: 'outer',
    d: {
      tag: 'deep',
      rows: [nestedValue(3), nestedValue(1 + 2)],
      tail: nestedValue(2),
    },
  },
};

interface Shape {
  name: string;
  type: EvsType;
  values: readonly unknown[];
}

const SHAPES: readonly Shape[] = [
  ...[1, 2, 3, 4, 6].map((d): Shape => ({
    name: `nested${d}`,
    type: nested(d),
    values: [nestedValue(d)],
  })),
  { name: 'wide[]', type: t.array(Wide), values: [[0, 1, 2, 3].map(wide), []] },
  { name: 'staticWide[]', type: t.array(StaticWide), values: [[0, 1, 2].map(staticWide)] },
  {
    name: 'staticWide[2][]',
    type: t.array(t.array(StaticWide, 2)),
    values: [[[0, 1].map(staticWide), [2, 3].map(staticWide)]],
  },
  { name: 'oneWord[]', type: t.array(OneWord), values: [[{ x: 1n }, { x: 2n ** 256n - 1n }]] },
  { name: 'oneString[]', type: t.array(OneString), values: [[{ s: '' }, { s: 'x'.repeat(33) }]] },
  {
    name: 'wrapped[]',
    type: t.array(Wrapped),
    values: [[{ inner: { s: 'a' } }, { inner: { s: '' } }]],
  },
  { name: 'nested4[]', type: t.array(nested(4)), values: [[nestedValue(4), nestedValue(4)]] },
  {
    name: 'row[]',
    type: t.array(Row),
    values: [
      [0, 1, 2, 3].map((i) => ({
        id: i,
        ps: Array.from({ length: i }, (_, j) => ({ x: j, y: i })),
        tag: `t${i}`,
      })),
    ],
  },
  { name: 'deepHolder', type: DeepHolder, values: [deepHolder] },
  { name: 'string[]', type: t.array(t.string), values: [['a', 'bb'.repeat(20), '']] },
  { name: 'uint8[][]', type: t.array(t.array(t.uint8)), values: [[[1, 2], [], [3, 4, 5]]] },
  {
    name: 'p[2]',
    type: t.array(P, 2),
    values: [
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    ],
  },
];

/** The ABI params of a compiled script's function (the shape's viem-side description). */
function paramsOf(script: AnyScript, side: 'inputs' | 'outputs'): readonly AbiParameter[] {
  const fn = (script.abi as Abi).find((e) => e.type === 'function' && e.name === script.name);
  if (fn?.type !== 'function') throw new Error(`no function ${script.name} in the script ABI`);
  return fn[side];
}

describe('encode frames: every encode entry point round-trips == viem', () => {
  const table: CalleeTable = {
    [SINK]: {
      kind: 'bytecode',
      runtime: abiEchoMock(),
      respond: (calldata) => ({
        success: true,
        data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
      }),
    },
  };

  for (const evmVersion of EVM_VERSIONS) {
    for (const shape of SHAPES) {
      test(`${shape.name}: return, s.encode, call args, simulate payload [${evmVersion}]`, async () => {
        // the sink's two entry points take the shape and echo their calldata back as `bytes`
        const param = paramsOf(
          evscript({ name: 'probe', args: [shape.type] as never }, (s, x) =>
            s.return({ x } as never),
          ),
          'inputs',
        )[0];
        if (param === undefined) throw new Error('probe script has no input');
        const sinkAbi = [
          {
            type: 'function',
            name: 'sink',
            stateMutability: 'view',
            inputs: [param],
            outputs: [{ name: '', type: 'bytes' }],
          },
          {
            type: 'function',
            name: 'sinkWrite',
            stateMutability: 'nonpayable',
            inputs: [param],
            outputs: [{ name: '', type: 'bytes' }],
          },
        ] as const satisfies Abi;
        const script = evscript({ name: 'encodeFrames', args: [shape.type] as never }, (s, x) =>
          s.return({
            x,
            enc: s.encode(x),
            viaRead: s.read({
              address: SINK,
              abi: sinkAbi as Abi,
              functionName: 'sink',
              args: [x],
            } as never),
            viaSimulate: s.simulate({
              address: SINK,
              abi: sinkAbi as Abi,
              functionName: 'sinkWrite',
              args: [x],
            } as never),
          } as never),
        );
        const outcomes = await expectAgreement(
          script,
          shape.values.map((v) => [v]),
          table,
          evmVersion,
        );
        outcomes.forEach((o, k) => {
          const value = shape.values[k];
          expect(o.kind).toBe('return');
          expect(
            decodeFunctionResult({
              abi: script.abi,
              functionName: script.name,
              data: o.data,
            }),
          ).toEqual({
            x: value,
            enc: encodeAbiParameters([param], [value]),
            viaRead: encodeFunctionData({
              abi: sinkAbi,
              functionName: 'sink',
              args: [value] as never,
            }),
            viaSimulate: encodeFunctionData({
              abi: sinkAbi,
              functionName: 'sinkWrite',
              args: [value] as never,
            }),
          });
        });
      });
    }
  }
});

describe('encode frames: reservation', () => {
  // `encodeFramesOf` sizes the region reserved below the output buffer: too few frames and the
  // deepest level would write below it, over memory the encode may still read.
  const cases: readonly (readonly [string, EvsType, number])[] = [
    ['a word / string / word array', t.array(t.uint256), 0],
    ['two dynamic struct levels (re-derived from the root)', nested(1), 0],
    ['a third level keeps its base in a frame', nested(2), 1],
    ['and every level past it', nested(4), 3],
    ['a tuple[] (the element base lives in the array frame)', t.array(OneString), 1],
    ['two struct levels below an element (re-derived from it)', t.array(nested(2)), 1],
    ['a third level below an element', t.array(nested(3)), 2],
    ['string[][]', t.array(t.array(t.string)), 2],
    ['framed levels in elements in framed levels', DeepHolder, 4],
  ];
  for (const [what, type, frames] of cases) {
    test(`${what}: ${frames} frame(s)`, () => {
      expect(encodeFramesOf(layoutOfType(type))).toBe(frames);
    });
  }
});

describe('encode frames: gas', () => {
  /** Gas of returning `x` minus gas of returning a constant: the same calldata decode, so the
   *  difference is the return encoder alone. */
  async function encodeGas(type: EvsType, value: unknown): Promise<bigint> {
    const echo = compile(
      evscript({ name: 'f', args: [type] as never }, (s, x) => s.return({ x } as never)),
    );
    const constant = compile(
      evscript({ name: 'f', args: [type] as never }, (s) => s.return({ y: s.lit(t.uint256, 1n) })),
    );
    const calldata: Hex = encodeFunctionData({
      abi: echo.abi,
      functionName: 'f',
      args: [value] as never,
    });
    const [withEncode, without] = await Promise.all([
      execRuntime(echo.runtimeBytecode, calldata),
      execRuntime(constant.runtimeBytecode, calldata),
    ]);
    expect(withEncode.success && without.success).toBe(true);
    return withEncode.gasUsed - without.gasUsed;
  }

  test('one more dynamic struct level costs the same at any depth (no walk back to the root)', async () => {
    const gas: bigint[] = [];
    for (let d = 2; d <= 7; d++) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: one depth at a time
      gas.push(await encodeGas(nested(d), nestedValue(d)));
    }
    const steps = gas.slice(1).map((g, k) => g - (gas[k] ?? 0n));
    // each level adds the same template; only memory expansion makes the step creep up. Before
    // the per-level frames the step grew by ~150 gas per level (quadratic in the depth).
    const spread =
      steps.reduce((m, s) => (s > m ? s : m), 0n) -
      steps.reduce((m, s) => (s < m ? s : m), steps[0] ?? 0n);
    expect(spread, `per-level encode gas ${steps.join(', ')}`).toBeLessThan(40n);
  });

  test('tuple[] elements: one element pointer load per iteration, not one per member', async () => {
    const rows = (n: number): unknown[] => Array.from({ length: n }, (_, i) => wide(i));
    const perElement =
      ((await encodeGas(t.array(Wide), rows(21))) - (await encodeGas(t.array(Wide), rows(1)))) /
      20n;
    // 0.2.0 spent ~1470 gas per `Wide` element: each member re-derived MLOAD(arrPtr + 32 + 32·i)
    // and the element base D + MLOAD(D + 32·i) from the frame. Cached once per iteration, ~810.
    expect(perElement, `gas per element ${perElement}`).toBeLessThan(900n);
  });
});
