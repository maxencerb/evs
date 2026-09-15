/**
 * Type-shapes end-to-end integration (issue #4).
 *
 * Runs builder-compiled read scripts against a REAL solc-0.8.30 `Shapes` deployment on anvil —
 * the byte-exact differential oracle already proves codec parity against viem, this tier proves
 * the whole pipeline against solc's own encoder/decoder for the shapes that were gated before #4:
 *   - fixed-size arrays `T[N]` (word / struct / dynamic element, and both mixed nestings) as
 *     outputs, elements, call args and returns,
 *   - two-level tuple arrays `tuple[][]` (static and dynamic-member elements),
 *   - arrays nested deeper than one level (`uint256[][][]`, `string[][]`),
 *   - overloaded view functions resolved by arity and by arg type.
 *
 * Determinism: every expected value is re-derived from the same primitives the contract uses.
 */

import { getAddress } from 'viem';
import { beforeAll, describe, expect, expectTypeOf, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { Shapes } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy } from './helpers.js';

let shapes: `0x${string}`;

beforeAll(async () => {
  shapes = await deploy(Shapes.abi, Shapes.bytecode);
});

const addr = (n: bigint): `0x${string}` => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const position = (i: bigint) => ({
  nonce: i & ((1n << 96n) - 1n),
  operator: addr((i * 3n + 1n) & ((1n << 160n) - 1n)),
  liquidity: (i * 1000n + 7n) & ((1n << 128n) - 1n),
});
const positionsGrid = (rows: number) =>
  Array.from({ length: rows }, (_row, r) =>
    Array.from({ length: (r % 3) + 1 }, (_cell, k) => position(BigInt(r * 10 + k))),
  );
const cube = (n: number) =>
  Array.from({ length: n }, (_slab, s) =>
    Array.from({ length: (s % 2) + 1 }, (_row, r) =>
      Array.from({ length: (s + r) % 3 }, (_cell, k) => BigInt(s * 100 + r * 10 + k)),
    ),
  );
const nameGrid = (n: number) =>
  Array.from({ length: n }, (_row, r) => Array.from({ length: r % 3 }, (_cell, k) => `${r}-${k}`));

describe('fixed-size arrays T[N] against real solc', () => {
  test('read + element access + return: uint256[2], address[3], Position[2], string[2]', async () => {
    const script = evscript({ name: 'fixed', args: [t.address] }, (s, target) => {
      const pair = s.read({ address: target, abi: Shapes.abi, functionName: 'pair', args: [21n] });
      const addrs = s.read({
        address: target,
        abi: Shapes.abi,
        functionName: 'addrs3',
        args: [16n],
      });
      const ps = s.read({
        address: target,
        abi: Shapes.abi,
        functionName: 'positions2',
        args: [5n],
      });
      const names = s.read({
        address: target,
        abi: Shapes.abi,
        functionName: 'names2',
        args: [12n],
      });
      return s.return({
        pair,
        pair1: pair.at(1n),
        addrs,
        addr2: addrs.at(2n),
        ps,
        p1liq: ps.at(1n).liquidity.get(),
        names,
        name1: names.at(1n),
      });
    });
    const out = await publicClient.readContract({
      ...script.compile().toViem(),
      functionName: 'fixed',
      args: [shapes],
    });
    expect(out).toStrictEqual({
      pair: [21n, 42n],
      pair1: 42n,
      addrs: [addr(17n), addr(18n), addr(19n)],
      addr2: addr(19n),
      ps: [position(5n), position(6n)],
      p1liq: 6007n,
      names: ['12', '12-12'],
      name1: '12-12',
    });
    // the fixed length surfaces as a tuple in viem's inference
    expectTypeOf(out.pair).toEqualTypeOf<readonly [bigint, bigint]>();
    expectTypeOf(out.names).toEqualTypeOf<readonly [string, string]>();
  });

  test('mixed nestings: uint256[2][] and uint256[][2]', async () => {
    const script = evscript({ name: 'mixedNest', args: [t.address] }, (s, target) => {
      const pairs = s.read({ address: target, abi: Shapes.abi, functionName: 'pairs', args: [3n] });
      const cols = s.read({ address: target, abi: Shapes.abi, functionName: 'cols', args: [2n] });
      return s.return({
        pairs,
        p21: pairs.at(2n).at(1n),
        cols,
        c12: cols.at(1n).at(2n),
        sum: s.read({ address: target, abi: Shapes.abi, functionName: 'sumPairs', args: [pairs] }),
      });
    });
    const out = await publicClient.readContract({
      ...script.compile().toViem(),
      functionName: 'mixedNest',
      args: [shapes],
    });
    expect(out).toStrictEqual({
      pairs: [
        [0n, 0n],
        [1n, 10n],
        [2n, 20n],
      ],
      p21: 20n,
      cols: [
        [0n, 1n],
        [100n, 101n, 102n],
      ],
      c12: 102n,
      sum: 33n,
    });
  });

  test('fixed arrays as CALL ARGS (literal, decoded, constructed) and as script args', async () => {
    const script = evscript(
      { name: 'fixedArgs', args: [t.address, t.array(t.uint256, 2), 'string[2]'] },
      (s, target, p, ns) => {
        const built = s.newArray(t.uint256, 2, { fixed: true });
        built.set(0n, p.at(1n));
        built.set(1n, 100n);
        return s.return({
          sumLit: s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'sumPair',
            args: [[3n, 4n]],
          }),
          sumArg: s.read({ address: target, abi: Shapes.abi, functionName: 'sumPair', args: [p] }),
          sumBuilt: s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'sumPair',
            args: [built],
          }),
          echo: s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'echoPair',
            args: [[p.at(0n), 9n]],
          }),
          names: s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'echoNames2',
            args: [ns],
          }),
          p,
        });
      },
    );
    const out = await publicClient.readContract({
      ...script.compile().toViem(),
      functionName: 'fixedArgs',
      args: [shapes, [1n, 2n], ['a', 'bc']],
    });
    expect(out).toStrictEqual({
      sumLit: 7n,
      sumArg: 3n,
      sumBuilt: 102n,
      echo: [1n, 9n],
      names: ['a', 'bc'],
      p: [1n, 2n],
    });
  });
});

describe('tuple[][] and deeper nesting against real solc', () => {
  test('Position[][] read, forEach over rows, forwarded as a call arg, returned', async () => {
    const script = evscript({ name: 'grid', args: [t.address] }, (s, target) => {
      const grid = s.read({
        address: target,
        abi: Shapes.abi,
        functionName: 'positionsGrid',
        args: [4n],
      });
      const total = s.let(t.uint256, 0n);
      s.forEach(grid, (row) => {
        s.forEach(row, (cell) => {
          total.set(total.get().add(cell.liquidity.get().toUint(t.uint256)));
        });
      });
      const viaSolc = s.read({
        address: target,
        abi: Shapes.abi,
        functionName: 'sumGridLiquidity',
        args: [grid],
      });
      const echoed = s.read({
        address: target,
        abi: Shapes.abi,
        functionName: 'echoGrid',
        args: [grid],
      });
      return s.return({
        total: total.get(),
        viaSolc,
        echoed,
        first: grid.at(2n).at(1n).nonce.get(),
      });
    });
    const out = await publicClient.readContract({
      ...script.compile().toViem(),
      functionName: 'grid',
      args: [shapes],
    });
    const expected = positionsGrid(4);
    const sum = expected.flat().reduce((n, p) => n + p.liquidity, 0n);
    expect(out).toStrictEqual({ total: sum, viaSolc: sum, echoed: expected, first: 21n });
  });

  test('WithBytes[][] (dynamic-member element) read + return', async () => {
    const script = evscript({ name: 'wbGrid', args: [t.address] }, (s, target) => {
      const g = s.read({
        address: target,
        abi: Shapes.abi,
        functionName: 'withBytesGrid',
        args: [3n],
      });
      return s.return({ g, blobLen: g.at(1n).at(1n).data.get().length() });
    });
    const out = await publicClient.readContract({
      ...script.compile().toViem(),
      functionName: 'wbGrid',
      args: [shapes],
    });
    // cross-check against solc's own decode of the same call
    const direct = await publicClient.readContract({
      address: shapes,
      abi: Shapes.abi,
      functionName: 'withBytesGrid',
      args: [3n],
    });
    expect(out).toStrictEqual({ g: direct, blobLen: 2n });
  });

  test('uint256[][][] + string[][]: read, cells, call args, returns', async () => {
    const script = evscript(
      { name: 'deep', args: [t.address, 'uint256[][][]'] },
      (s, target, arg) => {
        const c = s.read({ address: target, abi: Shapes.abi, functionName: 'cube', args: [3n] });
        const ng = s.read({
          address: target,
          abi: Shapes.abi,
          functionName: 'nameGrid',
          args: [3n],
        });
        return s.return({
          c,
          c111: c.at(1n).at(1n).at(1n),
          sum: s.read({ address: target, abi: Shapes.abi, functionName: 'sumCube', args: [c] }),
          sumArg: s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'sumCube',
            args: [arg],
          }),
          ng,
          ng21: ng.at(2n).at(1n),
          ngEcho: s.read({
            address: target,
            abi: Shapes.abi,
            functionName: 'echoNameGrid',
            args: [[['x'], []]],
          }),
        });
      },
    );
    const out = await publicClient.readContract({
      ...script.compile().toViem(),
      functionName: 'deep',
      args: [shapes, [[[1n, 2n]], [[], [3n]]]],
    });
    expect(out).toStrictEqual({
      c: cube(3),
      c111: 111n,
      sum: 722n,
      sumArg: 6n,
      ng: nameGrid(3),
      ng21: '2-1',
      ngEcho: [['x'], []],
    });
  });
});

describe('overloaded views against real solc', () => {
  test('pick(uint256) / pick(uint256,uint256) / pick(string) by arity and arg type', async () => {
    const script = evscript({ name: 'pick', args: [t.address, t.uint256] }, (s, target, x) => {
      const one = s.read({ address: target, abi: Shapes.abi, functionName: 'pick', args: [x] });
      const two = s.read({ address: target, abi: Shapes.abi, functionName: 'pick', args: [x, 5n] });
      const str = s.read({ address: target, abi: Shapes.abi, functionName: 'pick', args: ['hi'] });
      // the chosen overload types the handle: uint256 outputs are numeric, the string one is not
      expectTypeOf(one).toEqualTypeOf<import('../../src/index.js').Expr<'uint256'>>();
      expectTypeOf(str).toEqualTypeOf<import('../../src/index.js').Expr<'string'>>();
      return s.return({ one, two, str, strLen: str.length() });
    });
    const out = await publicClient.readContract({
      ...script.compile().toViem(),
      functionName: 'pick',
      args: [shapes, 4n],
    });
    expect(out).toStrictEqual({ one: 5n, two: 20n, str: 'hi!', strLen: 3n });
  });
});
