/**
 * Differential suite — tuple literal shapes: partly named tuples and own-property members.
 *
 * A tuple with any unnamed member takes a positional literal (abitype's and viem's rule), in
 * every position: `s.tuple`, a nested member, `Field.set`, a `tuple[]` literal element and a
 * sub-call arg. viem is the oracle (the expected return value and the sub-call calldata, echoed
 * back by `abiEchoMock`); `expectAgreement` closes interpreter == bytecode on top. A struct
 * member named like an `Object.prototype` method that the literal omits zero-fills like any
 * other omitted member. Runner: `test/harness/differential.ts`.
 */

import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  abiEchoMock,
  EVM_VERSIONS,
  expectAgreement,
  SINK,
  USER,
  type CalleeTable,
} from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import { namedArg, t } from '../core/types.js';

/** `(uint256 amount, address)` — a real-world-shaped output tuple, one member unnamed. */
const MIXED = {
  name: 'q',
  type: 'tuple',
  components: [
    { name: 'amount', type: 'uint256' },
    { name: '', type: 'address' },
  ],
} as const;
const Mixed = t.fromAbiParameter(MIXED);
const Outer = t.struct({ q: Mixed, tag: t.uint8 });

const takeAbi = [
  {
    type: 'function',
    name: 'take',
    stateMutability: 'view',
    inputs: [MIXED, { ...MIXED, name: 'qs', type: 'tuple[]' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const;

const echoTable: CalleeTable = {
  [SINK]: {
    kind: 'bytecode',
    runtime: abiEchoMock(),
    respond: (calldata) => ({
      success: true,
      data: encodeAbiParameters([{ type: 'bytes' }], [calldata]),
    }),
  },
};

describe.each(EVM_VERSIONS)('tuple literal shapes [%s]', (evmVersion) => {
  test('a partly named tuple is built from positional literals everywhere', async () => {
    const script = evscript(
      { name: 'mixedLits', args: [namedArg('p', Mixed), t.uint256, t.address] },
      (s, p, n, who) => {
        // top-level s.tuple members may be Exprs; nested tuple literals are host values (abitype)
        const q = s.tuple(Mixed, [n, who]);
        const outer = s.tuple(Outer, { q: [43n, USER], tag: 7 });
        const set = s.tuple(Outer, {});
        set.q.set([5n, USER]);
        const list = s.tuple(t.struct({ items: t.array(Mixed) }), {
          items: [
            [1n, USER],
            [2n, USER],
          ],
        });
        return s.return({ q, outer, set, list, same: p.expr().eq([42n, USER]) });
      },
    );
    const who = getAddress(USER);
    const [o] = await expectAgreement(script, [[[42n, USER], 42n, USER]], {}, evmVersion);
    expect(o?.kind).toBe('return');
    expect(
      decodeFunctionResult({ abi: script.abi, functionName: script.name, data: o?.data ?? '0x' }),
    ).toEqual({
      q: [42n, who],
      outer: { q: [43n, who], tag: 7 },
      set: { q: [5n, who], tag: 0 },
      list: {
        items: [
          [1n, who],
          [2n, who],
        ],
      },
      same: true,
    });
  });

  test('a partly named tuple call arg encodes like viem', async () => {
    const script = evscript({ name: 'mixedArg' }, (s) => {
      const echoed = s.read({
        address: SINK,
        abi: takeAbi,
        functionName: 'take',
        args: [[9n, USER], [[1n, USER]]], // tuple literal members are host values (abitype)
      });
      return s.return({ echoed });
    });
    const [o] = await expectAgreement(script, [[]], echoTable, evmVersion);
    expect(o?.kind).toBe('return');
    expect(
      decodeFunctionResult({ abi: script.abi, functionName: script.name, data: o?.data ?? '0x' }),
    ).toEqual({
      echoed: encodeFunctionData({
        abi: takeAbi,
        functionName: 'take',
        args: [[9n, USER], [[1n, USER]]],
      }),
    });
  });

  test('omitted members named like Object.prototype methods zero-fill', async () => {
    const Odd = t.struct({ toString: t.uint256, constructor: t.address, x: t.uint256 });
    const script = evscript({ name: 'oddInit', args: [t.uint256] }, (s, x) =>
      // TS checks an omitted `toString` against Object's own method, so this init is reachable
      // from untyped callers only
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately untyped init
      s.return({ o: s.tuple(Odd, { x } as never) }),
    );
    const [o] = await expectAgreement(script, [[3n]], {}, evmVersion);
    expect(
      decodeFunctionResult({ abi: script.abi, functionName: script.name, data: o?.data ?? '0x' }),
    ).toEqual({
      o: { toString: 0n, constructor: '0x0000000000000000000000000000000000000000', x: 3n },
    });
  });
});
