/**
 * Typed zero values of composite slots on a real EVM (issue #71).
 *
 * The four repros from the issue, run deployless on anvil in both `optimize` modes: unset
 * `s.newArray` elements and omitted `s.tuple` members that are string/bytes/`T[]` or nested
 * tuples must read as the empty value / a fresh zeroed struct, never as whatever sits in the
 * scratch word at `0x00`.
 */

import { getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { publicClient } from '../harness/anvil.js';

const OWNER = '0x00000000000000000000000000000000000000aa';

// 1. the reference/builder.mdx example: fill a tuple[] in place via get(i)
const Position = t.struct({ liquidity: t.uint128, owner: t.address });
const positions = evscript({ name: 'positions', args: [t.address, t.uint256] }, (s, owner, n) => {
  const out = s.newArray(Position, n);
  s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
    const el = out.get(i);
    el.liquidity.set(i.toUint(t.uint128));
    el.owner.set(owner);
  });
  return s.return({ positions: out.expr() });
});

// 2. unset elements of a new string[]
const strings = evscript({ name: 'strings', args: [t.uint256] }, (s, n) =>
  s.return({ xs: s.newArray(t.string, n) }),
);

// 3. s.tuple with omitted string / uint256[] members
const S = t.struct({ n: t.uint256, s: t.string, xs: t.array(t.uint256) });
const omitted = evscript({ name: 'omitted', args: [t.uint256] }, (s, n) =>
  s.return({ v: s.tuple(S, { n }) }),
);

// 4. s.tuple with an omitted nested-struct member, then a scratch-space write
const Outer = t.struct({ inner: t.struct({ a: t.uint256 }), x: t.uint256 });
const nested = evscript({ name: 'nested', args: [t.uint256] }, (s, x) => {
  const o = s.tuple(Outer, { x });
  const h = s.keccak256(x, x);
  return s.return({ h, o });
});

describe.each([false, true])('composite zero values on anvil (optimize: %s)', (optimize) => {
  test('fill a tuple[] in place via get(i) (docs example)', async () => {
    const out = await publicClient.readContract({
      ...positions.compile({ optimize }).toViem(),
      functionName: 'positions',
      args: [OWNER, 3n],
    });
    const owner = getAddress(OWNER);
    expect(out.positions).toStrictEqual([
      { liquidity: 0n, owner },
      { liquidity: 1n, owner },
      { liquidity: 2n, owner },
    ]);
  });

  test('unset string[] elements are empty strings', async () => {
    const out = await publicClient.readContract({
      ...strings.compile({ optimize }).toViem(),
      functionName: 'strings',
      args: [2n],
    });
    expect(out.xs).toStrictEqual(['', '']);
  });

  test('omitted string / uint256[] members are empty', async () => {
    const out = await publicClient.readContract({
      ...omitted.compile({ optimize }).toViem(),
      functionName: 'omitted',
      args: [7n],
    });
    expect(out.v).toStrictEqual({ n: 7n, s: '', xs: [] });
  });

  test('an omitted nested struct is zeroed (and survives a scratch write)', async () => {
    const out = await publicClient.readContract({
      ...nested.compile({ optimize }).toViem(),
      functionName: 'nested',
      args: [9n],
    });
    expect(out.o).toStrictEqual({ inner: { a: 0n }, x: 9n });
  });
});
