/**
 * Differential suite — type shapes (issue #4): fixed-size `T[N]`, `tuple[][]`, deeper nesting,
 * overload resolution; read (decode) + return (encode) + call-arg encode + construct + script args.
 *
 * One slice of the anti-miscompilation corpus: `interpret(script.ir)` must agree byte-for-byte
 * with the compiled bytecode on returndata and revert payloads, on the default output and its
 * `optimize: true` twin. Runner, callee table and fixture constants: `test/harness/differential.ts`.
 */

import type { Abi, AbiParameter, Address } from 'abitype';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
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
  type CalleeBehavior,
  type CalleeTable,
  type AnyScript,
  type Outcome,
} from '../../test/harness/differential.js';
import { evscript, type ScriptBuilder } from '../builder/script.js';
import { t, type Expr, type Hex } from '../core/types.js';

/** Asserts a `return` outcome and decodes it through the script's own ABI (type-shapes corpus). */
const decodeShapeOut = (script: AnyScript, o: Outcome | undefined): unknown => {
  expect(o?.kind).toBe('return');
  return decodeFunctionResult({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus: AnyScript erases the literal ABI
    abi: script.abi as Abi,
    functionName: script.name,
    data: o?.data ?? '0x',
  });
};

// ---------------------------------------------------------------------------
// 15. type shapes (issue #4): fixed-size `T[N]`, `tuple[][]`, deeper nesting, overloads —
//     read (decode) + return (encode) + call-arg encode + construct + script args, byte-exact
//     interp == compiled bytecode == viem on every fork.
// ---------------------------------------------------------------------------

const echoSink = (): CalleeBehavior => ({
  kind: 'bytecode',
  runtime: abiEchoMock(),
  respond: (calldata) => ({
    success: true,
    data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
  }),
});

describe('type shapes (issue #4)', () => {
  // loose builder handles for the corpus (precise inference is pinned by the type tests)
  type Word = Expr<'uint256'>;
  interface FieldLike {
    get(): ArrLike & Word;
  }
  interface ArrLike {
    length(): Word;
    at(i: bigint): ArrLike & Word;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose builder handle for the corpus
  const asArr = (v: unknown): ArrLike & Word => v as ArrLike & Word;
  const fld = (el: unknown, name: string): FieldLike =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime Tuple handle field access
    (el as Record<string, FieldLike>)[name]!;

  const posComponents = [
    { name: 'nonce', type: 'uint96' },
    { name: 'operator', type: 'address' },
    { name: 'liquidity', type: 'uint128' },
  ] as const;
  const withBytesComponents = [
    { name: 'id', type: 'uint256' },
    { name: 'blob', type: 'bytes' },
  ] as const;
  const Position = t.struct({ nonce: t.uint96, operator: t.address, liquidity: t.uint128 });
  const A1 = getAddress('0x00000000000000000000000000000000000000a1');
  const A2 = getAddress('0x00000000000000000000000000000000000000a2');
  const A3 = getAddress('0x00000000000000000000000000000000000000a3');
  interface Pos {
    readonly nonce: bigint;
    readonly operator: Address;
    readonly liquidity: bigint;
  }
  const P1: Pos = { nonce: 1n, operator: A1, liquidity: 111n };
  const P2: Pos = { nonce: 2n, operator: A2, liquidity: 222n };
  const P3: Pos = { nonce: 3n, operator: A3, liquidity: 333n };

  // one getter per shape, all on POOL via a selector-dispatch mock
  const shapesAbi = [
    {
      type: 'function',
      name: 'pair',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint256[2]' }],
    },
    {
      type: 'function',
      name: 'addrs3',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'address[3]' }],
    },
    {
      type: 'function',
      name: 'positions2',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'tuple[2]', components: posComponents }],
    },
    {
      type: 'function',
      name: 'names2',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'string[2]' }],
    },
    {
      type: 'function',
      name: 'pairs',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint256[2][]' }],
    },
    {
      type: 'function',
      name: 'cols',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint256[][2]' }],
    },
    {
      type: 'function',
      name: 'positionsGrid',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'tuple[][]', components: posComponents }],
    },
    {
      type: 'function',
      name: 'withBytesGrid',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'tuple[][]', components: withBytesComponents }],
    },
    {
      type: 'function',
      name: 'cube',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint256[][][]' }],
    },
    {
      type: 'function',
      name: 'nameGrid',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'string[][]' }],
    },
    {
      type: 'function',
      name: 'blobGrid',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'bytes[][]' }],
    },
    {
      type: 'function',
      name: 'mixed',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        { name: 'a', type: 'uint8' },
        { name: 'p', type: 'uint256[2]' },
        { name: 's', type: 'string' },
        { name: 'q', type: 'tuple[2]', components: withBytesComponents },
      ],
    },
  ] as const satisfies Abi;
  type Vals = {
    pair: readonly [bigint, bigint];
    addrs3: readonly [Address, Address, Address];
    positions2: readonly [Pos, Pos];
    names2: readonly [string, string];
    pairs: readonly (readonly [bigint, bigint])[];
    cols: readonly [readonly bigint[], readonly bigint[]];
    positionsGrid: readonly (readonly Pos[])[];
    withBytesGrid: readonly (readonly { id: bigint; blob: Hex }[])[];
    cube: readonly (readonly (readonly bigint[])[])[];
    nameGrid: readonly (readonly string[])[];
    blobGrid: readonly (readonly Hex[])[];
  };
  const V: Vals = {
    pair: [21n, 42n],
    addrs3: [A1, A2, A3],
    positions2: [P1, P2],
    names2: ['12', 'twelve-twelve-twelve-twelve-twelve!'],
    pairs: [
      [0n, 0n],
      [1n, 10n],
      [2n, 20n],
    ],
    cols: [
      [0n, 1n],
      [100n, 101n, 102n],
    ],
    positionsGrid: [[P1], [P2, P3], [], [P3, P1, P2]],
    withBytesGrid: [
      [{ id: 10n, blob: '0xdeadbeef' }],
      [
        { id: 20n, blob: '0x' },
        { id: 21n, blob: `0x${'ab'.repeat(33)}` },
      ],
    ],
    cube: [[[]], [[100n], [110n, 111n]], [[200n, 201n]]],
    nameGrid: [[], ['1-0'], ['2-0', 'a-much-longer-string-that-spans-two-words!!']],
    blobGrid: [['0x01'], [], ['0x', `0x${'cd'.repeat(40)}`]],
  };
  const MIXED = {
    a: 7n,
    p: [5n, 6n] as const,
    s: 'mid',
    q: [
      { id: 1n, blob: '0x0102' },
      { id: 2n, blob: '0x' },
    ] as const,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- V's keys are exactly Vals'
  const NAMES = Object.keys(V) as (keyof Vals)[];
  const outputsOf = (name: string): readonly AbiParameter[] => {
    const fn = shapesAbi.find((f) => f.name === name);
    if (fn === undefined) throw new Error(name);
    return fn.outputs;
  };
  const returndataOf = (name: keyof Vals): Hex => encodeAbiParameters(outputsOf(name), [V[name]]);
  const poolTable: CalleeTable = {
    [POOL]: {
      kind: 'dispatch',
      cases: [
        ...NAMES.map((name) => ({
          selector: toFunctionSelector(`${name}()`),
          kind: 'return' as const,
          data: returndataOf(name),
        })),
        {
          selector: toFunctionSelector('mixed()'),
          kind: 'return' as const,
          data: encodeAbiParameters(outputsOf('mixed'), [MIXED.a, MIXED.p, MIXED.s, MIXED.q]),
        },
      ],
    },
  };
  const read = (s: ScriptBuilder, functionName: string): ArrLike & Word =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus: the verb is called untyped
    asArr((s.read as (p: unknown) => unknown)({ address: POOL, abi: shapesAbi, functionName }));

  for (const evmVersion of EVM_VERSIONS) {
    // (r) READ + RETURN every shape whole: decode from returndata → re-encode → viem decodes it back
    test(`(r) read + return every shape whole == viem [${evmVersion}]`, async () => {
      const names = NAMES;
      const script = evscript({ name: 'readAll' }, (s) => {
        const out: Record<string, unknown> = {};
        for (const name of names) out[name] = read(s, name);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus
        return s.return(out as never);
      });
      const [o] = await expectAgreement(script, [[]], poolTable, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual(V);
    });

    // (e) ELEMENT reads: .length()/.at()/fields through every nesting level
    test(`(e) element reads through fixed, tuple[][], and deep arrays [${evmVersion}]`, async () => {
      const script = evscript({ name: 'elems' }, (s) => {
        const pair = read(s, 'pair');
        const addrs = read(s, 'addrs3');
        const ps2 = read(s, 'positions2');
        const names = read(s, 'names2');
        const pairs = read(s, 'pairs');
        const cols = read(s, 'cols');
        const grid = read(s, 'positionsGrid');
        const wb = read(s, 'withBytesGrid');
        const cube = read(s, 'cube');
        const ng = read(s, 'nameGrid');
        return s.return({
          pairLen: pair.length(),
          pair1: pair.at(1n),
          addr2: addrs.at(2n),
          p2liq: fld(ps2.at(1n), 'liquidity').get(),
          p1op: fld(ps2.at(0n), 'operator').get(),
          name1Len: names.at(1n).length(),
          name1: names.at(1n),
          pairsLen: pairs.length(),
          pairs21: pairs.at(2n).at(1n),
          colsLen: cols.length(),
          col1Len: cols.at(1n).length(),
          col12: cols.at(1n).at(2n),
          gridLen: grid.length(),
          row3Len: grid.at(3n).length(),
          g32nonce: fld(grid.at(3n).at(2n), 'nonce').get(),
          wb11blob: fld(wb.at(1n).at(1n), 'blob').get(),
          cube111: cube.at(1n).at(1n).at(1n),
          cube00Len: cube.at(0n).at(0n).length(),
          ng21: ng.at(2n).at(1n),
        });
      });
      const [o] = await expectAgreement(script, [[]], poolTable, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual({
        pairLen: 2n,
        pair1: 42n,
        addr2: A3,
        p2liq: 222n,
        p1op: A1,
        name1Len: BigInt(V.names2[1].length),
        name1: V.names2[1],
        pairsLen: 3n,
        pairs21: 20n,
        colsLen: 2n,
        col1Len: 3n,
        col12: 102n,
        gridLen: 4n,
        row3Len: 3n,
        g32nonce: 2n,
        wb11blob: `0x${'ab'.repeat(33)}`,
        cube111: 111n,
        cube00Len: 0n,
        ng21: V.nameGrid[2]![1],
      });
    });

    // (m) a MIXED multi-output read with static fixed arrays inlined in the head + struct: true
    test(`(m) mixed outputs: inlined static uint256[2] head + dynamic tuple[2] [${evmVersion}]`, async () => {
      const script = evscript({ name: 'mixed' }, (s) => {
        const r = s.read({ address: POOL, abi: shapesAbi, functionName: 'mixed', struct: true });
        return s.return({
          r,
          p1: asArr(r.p.get()).at(1n),
          q1id: fld(asArr(r.q.get()).at(1n), 'id').get(),
        });
      });
      const [o] = await expectAgreement(script, [[]], poolTable, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual({ r: { ...MIXED, a: 7 }, p1: 6n, q1id: 2n }); // uint8 → number (viem)
    });

    // (a) SCRIPT ARGS: every shape decoded from calldata, returned verbatim (calldata decode ↔ return
    //     encode); the expected value is what viem decodes back.
    test(`(a) every shape as a script arg round-trips [${evmVersion}]`, async () => {
      const argTypes = [
        'uint256[2]',
        'address[3]',
        t.array(Position, 2),
        'string[2]',
        'uint256[2][]',
        'uint256[][2]',
        t.array(t.array(Position)),
        t.array(t.array(t.struct({ id: t.uint256, blob: t.bytes }))),
        'uint256[][][]',
        'string[][]',
        'bytes[][]',
      ] as const;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus arg tuple
      const script = evscript({ name: 'echoAll', args: argTypes as never }, (s, ...args) => {
        const out: Record<string, unknown> = {};
        NAMES.forEach((name, i) => {
          out[name] = args[i];
        });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus
        return s.return(out as never);
      });
      const argValues = NAMES.map((name) => V[name]);
      const [o] = await expectAgreement(script, [argValues], {}, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual(V);
    });

    // (c) CALL ARGS: forward a decoded value of every shape into an echo sink → calldata == viem
    test(`(c) every shape as a call arg → calldata == viem [${evmVersion}]`, async () => {
      const names = NAMES;
      const sinkAbiFor = (name: keyof Vals) =>
        [
          {
            type: 'function',
            name: 'sink',
            stateMutability: 'view',
            inputs: [{ ...outputsOf(name)[0]!, name: 'v' }],
            outputs: [{ name: '', type: 'bytes' }],
          },
        ] as const satisfies Abi;
      const script = evscript({ name: 'fwdAll' }, (s) => {
        const out: Record<string, unknown> = {};
        for (const name of names) {
          out[name] = s.read({
            address: SINK,
            abi: sinkAbiFor(name),
            functionName: 'sink',
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus handle
            args: [read(s, name)] as never,
          });
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus
        return s.return(out as never);
      });
      const [o] = await expectAgreement(
        script,
        [[]],
        { ...poolTable, [SINK]: echoSink() },
        evmVersion,
      );
      const expected: Record<string, Hex> = {};
      for (const name of names) {
        expected[name] = encodeFunctionData({
          abi: sinkAbiFor(name),
          functionName: 'sink',
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- per-shape literal
          args: [V[name]] as never,
        });
      }
      expect(decodeShapeOut(script, o)).toEqual(expected);
    });

    // (l) LITERAL call args of every shape (built at record time) → calldata == viem
    test(`(l) literal call args of every shape → calldata == viem [${evmVersion}]`, async () => {
      const sinkAbi = [
        {
          type: 'function',
          name: 'sink',
          stateMutability: 'view',
          inputs: [
            { name: 'p', type: 'uint256[2]' },
            { name: 'ps', type: 'tuple[2]', components: posComponents },
            { name: 'g', type: 'tuple[][]', components: posComponents },
            { name: 'c', type: 'uint256[][][]' },
            { name: 'n', type: 'string[2]' },
            { name: 'x', type: 'uint256[][2]' },
          ],
          outputs: [{ name: '', type: 'bytes' }],
        },
      ] as const satisfies Abi;
      const args = [V.pair, V.positions2, V.positionsGrid, V.cube, V.names2, V.cols] as const;
      const script = evscript({ name: 'litArgs' }, (s) => {
        const echoed = s.read({ address: SINK, abi: sinkAbi, functionName: 'sink', args });
        return s.return({ echoed });
      });
      const [o] = await expectAgreement(script, [[]], { [SINK]: echoSink() }, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual({
        echoed: encodeFunctionData({ abi: sinkAbi, functionName: 'sink', args }),
      });
    });

    // (k) CONSTRUCT: s.newArray({ fixed: true }), nested newArray (tuple[][], uint256[2][]), mixed
    //     Expr/literal fixed literals, and UNSET composite slots (typed zero values) — returned.
    test(`(k) construct fixed / nested arrays with unset slots → typed zeros [${evmVersion}]`, async () => {
      const script = evscript({ name: 'build', args: [t.uint256] }, (s, x) => {
        const pair = s.newArray(t.uint256, 2, { fixed: true });
        pair.set(1n, x);
        const grid = s.newArray(t.array(Position), 3n); // tuple[][] — row 1 stays empty
        const row0 = s.newArray(Position, 1n);
        row0.get(0n).liquidity.set(x.toUint(t.uint128));
        grid.set(0n, row0);
        grid.set(2n, [P3, P1]);
        const pairs = s.newArray(t.array(t.uint256, 2), 2n); // uint256[2][] — slot 1 stays [0, 0]
        pairs.set(0n, [x, 7n]);
        const names = s.newArray(t.string, 2, { fixed: true }); // string[2] — slot 1 stays ''
        names.set(0n, 'hey');
        const lit2 = s.lit('uint256[2]', [1n, 2n]); // all-literal → data segment
        const cube = s.newArray('uint256[][]', 2n); // uint256[][][] — both slabs stay []
        const mixed = s.lit('uint256[2]', [x, 9n]); // an Expr element → built element-wise
        return s.return({ pair, grid, pairs, names, lit2, cube, mixed });
      });
      const [o] = await expectAgreement(script, [[5n]], {}, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual({
        pair: [0n, 5n],
        grid: [
          [{ nonce: 0n, operator: getAddress(`0x${'0'.repeat(40)}`), liquidity: 5n }],
          [],
          [P3, P1],
        ],
        pairs: [
          [5n, 7n],
          [0n, 0n],
        ],
        names: ['hey', ''],
        lit2: [1n, 2n],
        cube: [[], []],
        mixed: [5n, 9n],
      });
    });

    // (z) tryRead zeroing: a failed call yields typed zeros — `[0, 0]` for uint256[2], `['', '']`
    //     for string[2], `[]` for tuple[][] — on both sides; decode bounds on a truncated fixed array.
    test(`(z) tryRead zero values + truncated fixed-array returndata [${evmVersion}]`, async () => {
      const script = evscript({ name: 'zeros' }, (s) => {
        const p = s.tryRead({ address: DEAD, abi: shapesAbi, functionName: 'pair' });
        const n = s.tryRead({ address: DEAD, abi: shapesAbi, functionName: 'names2' });
        const g = s.tryRead({ address: DEAD, abi: shapesAbi, functionName: 'positionsGrid' });
        const short = s.tryRead({ address: POOL, abi: shapesAbi, functionName: 'pair' });
        const strict = s.read({ address: POOL, abi: shapesAbi, functionName: 'addrs3' });
        return s.return({
          ok: p.success.or(n.success).or(g.success),
          p: p.value,
          n: n.value,
          g: g.value,
          shortOk: short.success,
          shortV: short.value,
          strict,
        });
      });
      const truncated: CalleeTable = {
        [POOL]: {
          kind: 'dispatch',
          cases: [
            // pair() returns only ONE word for a uint256[2] → staticMinSize fails → zeroed
            {
              selector: toFunctionSelector('pair()'),
              kind: 'return',
              data: `0x${'1'.padStart(64, '0')}`,
            },
            {
              selector: toFunctionSelector('addrs3()'),
              kind: 'return',
              data: returndataOf('addrs3'),
            },
          ],
        },
      };
      const [o] = await expectAgreement(script, [[]], truncated, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual({
        ok: false,
        p: [0n, 0n],
        n: ['', ''],
        g: [],
        shortOk: false,
        shortV: [0n, 0n],
        strict: V.addrs3,
      });
      // strict read of the truncated pair → EvsDecodeError on both sides
      const strictScript = evscript({ name: 'strictShort' }, (s) => {
        const p = s.read({ address: POOL, abi: shapesAbi, functionName: 'pair' });
        return s.return({ p });
      });
      const [o2] = await expectAgreement(strictScript, [[]], truncated, evmVersion);
      expect(o2?.kind).toBe('revert');
      expect(o2?.data.slice(0, 10)).toBe(toFunctionSelector('EvsDecodeError(uint256)'));
    });

    // (o) OVERLOADS: pick(uint256) / pick(uint256,uint256) / pick(string) resolved by arity + type
    test(`(o) overloaded views resolve by arity and by arg type [${evmVersion}]`, async () => {
      const pickAbi = [
        {
          type: 'function',
          name: 'pick',
          stateMutability: 'view',
          inputs: [{ name: 'x', type: 'uint256' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
        {
          type: 'function',
          name: 'pick',
          stateMutability: 'view',
          inputs: [
            { name: 'x', type: 'uint256' },
            { name: 'y', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'uint256' }],
        },
        {
          type: 'function',
          name: 'pick',
          stateMutability: 'view',
          inputs: [{ name: 's', type: 'string' }],
          outputs: [{ name: '', type: 'string' }],
        },
      ] as const satisfies Abi;
      const table: CalleeTable = {
        [POOL]: {
          kind: 'dispatch',
          cases: [
            {
              selector: toFunctionSelector('pick(uint256)'),
              kind: 'return',
              data: encodeAbiParameters([{ type: 'uint256' }], [11n]),
            },
            {
              selector: toFunctionSelector('pick(uint256,uint256)'),
              kind: 'return',
              data: encodeAbiParameters([{ type: 'uint256' }], [22n]),
            },
            {
              selector: toFunctionSelector('pick(string)'),
              kind: 'return',
              data: encodeAbiParameters([{ type: 'string' }], ['hi!']),
            },
          ],
        },
      };
      const script = evscript({ name: 'ov', args: [t.uint256] }, (s, x) => {
        const one = s.read({ address: POOL, abi: pickAbi, functionName: 'pick', args: [x] });
        const two = s.read({ address: POOL, abi: pickAbi, functionName: 'pick', args: [x, 2n] });
        const str = s.read({ address: POOL, abi: pickAbi, functionName: 'pick', args: ['hi'] });
        return s.return({ one, two, str });
      });
      const [o] = await expectAgreement(script, [[4n]], table, evmVersion);
      expect(decodeShapeOut(script, o)).toEqual({ one: 11n, two: 22n, str: 'hi!' });
    });
  }
});
