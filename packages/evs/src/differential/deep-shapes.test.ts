/**
 * Differential suite — deep and mixed array nesting (issues #4 / #52).
 *
 * The array decoder picks a lowering per array level: the stack fast path for the one- and
 * two-level shapes (`T[]`, `T[][]`, `tuple[]`, `string[]`/`bytes[]`) and the heap-frame path for
 * everything else (any `T[N]`, `uint256[][][]`, `string[][]`, `tuple[][]`, …). The two share the
 * scratch word `0x20`, so this slice drives them through each other in every order and at the
 * nesting ceiling (`MAX_ARRAY_DEPTH` = 4): heap levels over stack levels, stack-decoded `tuple[]`
 * whose members are heap-decoded, and all of it inside tuple members, call outputs (strict and
 * try), call args and script args — byte-exact interp == compiled bytecode == viem on every fork.
 * It also pins the typed zero values of the new shapes (`s.newArray` slots, omitted `s.tuple`
 * members, the try-mode zero block).
 */

import {
  type Abi,
  type AbiParameter,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  toFunctionSelector,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  expectAgreement,
  POOL,
  DEAD,
  SINK,
  EVM_VERSIONS,
  abiEchoMock,
  type AnyScript,
  type CalleeBehavior,
  type CalleeTable,
  type Outcome,
} from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { t, type Hex } from '../core/types.js';

const decodeOut = (script: AnyScript, o: Outcome | undefined): unknown => {
  expect(o?.kind).toBe('return');
  return decodeFunctionResult({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus: AnyScript erases the literal ABI
    abi: script.abi as Abi,
    functionName: script.name,
    data: o?.data ?? '0x',
  });
};

/** viem encode over the loose corpus values (the literal tuple types are too deep to infer). */
const encodeLoose = (params: readonly AbiParameter[], vals: readonly unknown[]): Hex =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus values
  encodeAbiParameters(params, vals as never);

const echoSink = (): CalleeBehavior => ({
  kind: 'bytecode',
  runtime: abiEchoMock(),
  respond: (calldata) => ({
    success: true,
    data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
  }),
});

describe('deep and mixed array nesting (issues #4 / #52)', () => {
  // A struct whose members exercise both decoder paths: `grid`/`names` are stack fast-path
  // shapes, `fixed`/`tags`/`deep` heap-frame shapes.
  const memberComponents = [
    { name: 'a', type: 'uint8' },
    { name: 'grid', type: 'uint256[][]' },
    { name: 'names', type: 'string[]' },
    { name: 'fixed', type: 'uint256[2]' },
    { name: 'tags', type: 'string[2]' },
    { name: 'deep', type: 'uint256[][][]' },
  ] as const;
  const Mixed = t.struct({
    a: t.uint8,
    grid: 'uint256[][]',
    names: 'string[]',
    fixed: 'uint256[2]',
    tags: 'string[2]',
    deep: 'uint256[][][]',
  });
  const Cell = t.struct({ x: t.uint8, s: t.string });
  const cellComponents = [
    { name: 'x', type: 'uint8' },
    { name: 's', type: 'string' },
  ] as const;

  const m0 = {
    a: 1,
    grid: [[1n, 2n], [], [3n]],
    names: ['x', ''],
    fixed: [4n, 5n],
    tags: ['t0', `long-${'z'.repeat(40)}`],
    deep: [[[6n]], [], [[], [7n, 8n]]],
  } as const;
  const m1 = {
    a: 255,
    grid: [],
    names: [],
    fixed: [0n, 2n ** 256n - 1n],
    tags: ['', ''],
    deep: [],
  } as const;
  const V = {
    // four levels — the ceiling: two heap levels over the stack-decoded `uint256[][]`
    d4: [[[[1n, 2n]], []], [], [[[3n], [], [4n, 5n, 6n]]]],
    // `tuple[]` (stack) whose members are heap-decoded
    mixedArr: [m0, m1],
    // `tuple[][2]`: a heap level over stack-decoded `tuple[]` rows over heap members
    mixedGrid: [[m1], [m0, m1]],
    // four levels over a dynamic tuple: `tuple[][][][2]`
    cells4: [[[[{ x: 1, s: 'a' }]], [[], [{ x: 2, s: '' }]]], []],
    // heap `string[2][]` over heap `string[2]`
    strPairs: [
      ['a', 'b'],
      ['', `c${'d'.repeat(33)}`],
    ],
    // `bytes[][2]`
    blobs: [['0x01', '0x'], [`0x${'ef'.repeat(40)}`]],
  } as const;
  const shapeParams = [
    { name: 'd4', type: 'uint256[][][][]' },
    { name: 'mixedArr', type: 'tuple[]', components: memberComponents },
    { name: 'mixedGrid', type: 'tuple[][2]', components: memberComponents },
    { name: 'cells4', type: 'tuple[][][][2]', components: cellComponents },
    { name: 'strPairs', type: 'string[2][]' },
    { name: 'blobs', type: 'bytes[][2]' },
  ] as const satisfies readonly AbiParameter[];
  const argTypes = [
    'uint256[][][][]',
    t.array(Mixed),
    t.array(t.array(Mixed), 2),
    t.array(t.array(t.array(t.array(Cell))), 2),
    'string[2][]',
    'bytes[][2]',
  ] as const;
  const values: readonly unknown[] = [V.d4, V.mixedArr, V.mixedGrid, V.cells4, V.strPairs, V.blobs];

  const getterAbi = [
    {
      type: 'function',
      name: 'all',
      stateMutability: 'view',
      inputs: [],
      outputs: shapeParams,
    },
    {
      type: 'function',
      name: 'wrapped',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: 'w', type: 'tuple', components: shapeParams }],
    },
  ] as const satisfies Abi;
  const expectedObject = Object.fromEntries(shapeParams.map((p, i) => [p.name, values[i]]));
  const allData = encodeLoose(shapeParams, values);
  const poolTable: CalleeTable = {
    [POOL]: {
      kind: 'dispatch',
      cases: [
        { selector: toFunctionSelector('all()'), kind: 'return', data: allData },
        {
          selector: toFunctionSelector('wrapped()'),
          kind: 'return',
          data: encodeLoose(getterAbi[1].outputs, [expectedObject]),
        },
      ],
    },
  };

  for (const evmVersion of EVM_VERSIONS) {
    test(`script args at the nesting ceiling round-trip [${evmVersion}]`, async () => {
      const script = evscript(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus arg tuple
        { name: 'deepArgs', args: argTypes as never },
        (s, ...args) =>
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus
          s.return(Object.fromEntries(shapeParams.map((p, i) => [p.name, args[i]])) as never),
      );
      const [o] = await expectAgreement(script, [values], {}, evmVersion);
      expect(decodeOut(script, o)).toEqual(expectedObject);
    });

    test(`struct-wrapped script arg (every shape as a tuple member) [${evmVersion}]`, async () => {
      const Wrapped = t.fromOutputs(getterAbi, 'wrapped');
      const script = evscript({ name: 'wrappedArg', args: [Wrapped] }, (s, w) => s.return({ w }));
      const [o] = await expectAgreement(script, [[expectedObject]], {}, evmVersion);
      expect(decodeOut(script, o)).toEqual({ w: expectedObject });
    });

    test(`call outputs: strict multi-output decode [${evmVersion}]`, async () => {
      const script = evscript({ name: 'deepRead' }, (s) =>
        s.return({
          all: s.read({ address: POOL, abi: getterAbi, functionName: 'all', struct: true }),
        }),
      );
      const [o] = await expectAgreement(script, [[]], poolTable, evmVersion);
      expect(decodeOut(script, o)).toEqual({ all: expectedObject });
    });

    test(`call outputs: try decode of a struct-wrapped output, success and failure [${evmVersion}]`, async () => {
      const script = evscript({ name: 'deepTry', args: [t.address] }, (s, address) => {
        const tried = s.tryRead({ address, abi: getterAbi, functionName: 'wrapped' });
        return s.return({ ok: tried.success, w: tried.value });
      });
      const [hit, miss] = await expectAgreement(script, [[POOL], [DEAD]], poolTable, evmVersion);
      expect(decodeOut(script, hit)).toEqual({ ok: true, w: expectedObject });
      expect(decodeOut(script, miss)).toEqual({
        ok: false,
        w: {
          d4: [],
          mixedArr: [],
          mixedGrid: [[], []],
          cells4: [[], []],
          strPairs: [],
          blobs: [[], []],
        },
      });
    });

    test(`decoded values forwarded as call args → calldata == viem [${evmVersion}]`, async () => {
      const sinkAbi = [
        {
          type: 'function',
          name: 'sink',
          stateMutability: 'view',
          inputs: shapeParams,
          outputs: [{ name: '', type: 'bytes' }],
        },
      ] as const satisfies Abi;
      const script = evscript({ name: 'deepFwd' }, (s) => {
        const [d4, mixedArr, mixedGrid, cells4, strPairs, blobs] = s.read({
          address: POOL,
          abi: getterAbi,
          functionName: 'all',
        });
        const echoed = s.read({
          address: SINK,
          abi: sinkAbi,
          functionName: 'sink',
          args: [d4, mixedArr, mixedGrid, cells4, strPairs, blobs],
        });
        return s.return({ echoed });
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        { ...poolTable, [SINK]: echoSink() },
        evmVersion,
      );
      expect(decodeOut(script, o)).toEqual({
        echoed: encodeFunctionData({
          abi: sinkAbi,
          functionName: 'sink',
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus values
          args: values as never,
        }),
      });
    });

    test(`element reads cross every decoder boundary [${evmVersion}]`, async () => {
      const script = evscript({ name: 'deepAt' }, (s) => {
        const [d4, mixedArr, mixedGrid, cells4] = s.read({
          address: POOL,
          abi: getterAbi,
          functionName: 'all',
        });
        const m = mixedGrid.at(1n).at(0n);
        return s.return({
          d4cell: d4.at(2n).at(0n).at(2n).at(1n),
          d4len: d4.at(0n).length(),
          deep: mixedArr.at(0n).deep.get().at(2n).at(1n).at(0n),
          tag: m.tags.get().at(1n),
          grid: m.grid.get().at(0n).at(1n),
          name: cells4.at(0n).at(1n).at(1n).at(0n).s.get(),
        });
      });
      const [o] = await expectAgreement(script, [[]], poolTable, evmVersion);
      expect(decodeOut(script, o)).toEqual({
        d4cell: 5n,
        d4len: 2n,
        deep: 7n,
        tag: m0.tags[1],
        grid: 2n,
        name: '',
      });
    });

    test(`encode / encodePacked / hash equality over the new shapes == viem [${evmVersion}]`, async () => {
      const script = evscript(
        { name: 'enc', args: ['uint256[2]', 'string[2]', 'uint256[][][]', 'uint256[2]'] },
        (s, pair, names, cube, other) =>
          s.return({
            abi: s.encode(pair, names, cube),
            packed: s.encodePacked(pair, other),
            same: pair.eq(other),
            namesEq: names.eq(s.lit('string[2]', ['a', 'b'])),
            hash: s.keccak256(cube),
          }),
      );
      const pair = [1n, 2n] as const;
      const names = ['a', 'b'] as const;
      const cube = V.d4[0];
      const [o] = await expectAgreement(
        script,
        [
          [pair, names, cube, pair],
          [pair, names, cube, [1n, 3n]],
        ],
        {},
        evmVersion,
      );
      expect(decodeOut(script, o)).toEqual({
        abi: encodeAbiParameters(
          [{ type: 'uint256[2]' }, { type: 'string[2]' }, { type: 'uint256[][][]' }],
          [pair, names, cube],
        ),
        packed: encodePacked(['uint256[2]', 'uint256[2]'], [pair, pair]),
        same: true,
        namesEq: true,
        hash: keccak256(encodeAbiParameters([{ type: 'uint256[][][]' }], [cube])),
      });
    });

    test(`typed zeros of the new shapes (newArray slots, s.tuple members, try zero block) [${evmVersion}]`, async () => {
      const Holder = t.struct({
        p: 'uint256[2]',
        n: 'string[3]',
        g: t.array(Cell, 2),
        d: 'uint256[][2]',
        k: t.uint8,
      });
      const zeroAbi = [
        {
          type: 'function',
          name: 'z',
          stateMutability: 'view',
          inputs: [],
          outputs: [
            { name: 'p', type: 'string[2][2]' },
            { name: 'q', type: 'tuple[2]', components: cellComponents },
            { name: 'r', type: 'uint256[][2]' },
          ],
        },
      ] as const satisfies Abi;
      const script = evscript({ name: 'zeros', args: [t.uint8] }, (s, k) => {
        const pairs = s.newArray(t.array(t.string, 2), 2n); // string[2][] — both slots unset
        pairs.set(1n, ['set', '']);
        const cells = s.newArray(t.array(Cell, 2), 1n); // tuple[2][] — unset
        const holder = s.tuple(Holder, { k });
        const failed = s.tryRead({ address: DEAD, abi: zeroAbi, functionName: 'z' });
        const [zp, zq, zr] = failed.value;
        return s.return({ pairs, cells, holder, zp, zq, zr });
      });
      const [o] = await expectAgreement(script, [[9]], {}, evmVersion);
      const zc = { x: 0, s: '' };
      expect(decodeOut(script, o)).toEqual({
        pairs: [
          ['', ''],
          ['set', ''],
        ],
        cells: [[zc, zc]],
        holder: { p: [0n, 0n], n: ['', '', ''], g: [zc, zc], d: [[], []], k: 9 },
        zp: [
          ['', ''],
          ['', ''],
        ],
        zq: [zc, zc],
        zr: [[], []],
      });
    });
  }
});
