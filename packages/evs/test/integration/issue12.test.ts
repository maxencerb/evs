/**
 * Issue #12 — loop ergonomics, end-to-end on anvil against real MockERC20 deployments:
 *   - `s.forEach(array, (elem, i, loop) => …)` over a word array (collect + aggregate);
 *   - `s.forEach` over a `tuple[]` arg — the body receives a named Tuple element — with break;
 *   - `s.for({ from, until })` with the defaulted uint256 counter (no `type` field).
 */

import { getAddress } from 'viem';
import { beforeAll, describe, expect, expectTypeOf, test } from 'vitest';

import { evscript, t } from '../../src/index.js';
import { MockERC20 } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy, deployer, write } from './helpers.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const STRANGER = '0x00000000000000000000000000000000deadbeef';

const HOLDER = getAddress(deployer.address);
const BALANCES = [111n, 222n, 333n] as const;

let tokens: `0x${string}`[] = [];

beforeAll(async () => {
  tokens = [];
  for (const [i, amount] of BALANCES.entries()) {
    const address = await deploy(MockERC20.abi, MockERC20.bytecode, [`Token ${i}`, `TK${i}`, 18]);
    await write({ address, abi: MockERC20.abi, functionName: 'mint', args: [HOLDER, amount] });
    tokens.push(address);
  }
});

// forEach over a word array: collect each balance AND aggregate the total in one pass, then
// recompute the total from the collected array with a type-less `s.for` range (issue #12).
const holdings = evscript(
  { name: 'holdings', args: [t.array(t.address), t.address] },
  (s, tokenList, owner) => {
    const out = s.newArray(t.uint256, tokenList.length());
    const total = s.let(t.uint256, 0n);
    s.forEach(tokenList, (token, i) => {
      const bal = s.read({
        address: token,
        abi: MockERC20.abi,
        functionName: 'balanceOf',
        args: [owner],
      });
      out.set(i, bal);
      total.set(total.get().add(bal));
    });
    const check = s.let(t.uint256, 0n);
    s.for({ from: 0n, until: out.length }, (i) => {
      check.set(check.get().add(out.get(i)));
    });
    return s.return({ balances: out, total: total.get(), check: check.get() });
  },
);

// forEach over a tuple[] arg: the body receives a named Tuple element; break stops the scan.
const Query = t.struct({ token: t.address, owner: t.address });
const firstFunded = evscript({ name: 'firstFunded', args: [t.array(Query)] }, (s, queries) => {
  const found = s.let(t.address, ZERO);
  const foundIndex = s.let(t.uint256, 0n);
  s.forEach(queries, (q, i, loop) => {
    const bal = s.read({
      address: q.token.get(),
      abi: MockERC20.abi,
      functionName: 'balanceOf',
      args: [q.owner.get()],
    });
    s.if(bal.gt(0n), () => {
      found.set(q.token.get());
      foundIndex.set(i);
      loop.break();
    });
  });
  return s.return({ found: found.get(), foundIndex: foundIndex.get() });
});

describe('loop ergonomics: s.forEach + defaulted s.for (issue #12)', () => {
  const compiledHoldings = holdings.compile();
  const compiledFirstFunded = firstFunded.compile();

  test('forEach collects and aggregates; the defaulted for recomputes the same total', async () => {
    const out = await publicClient.readContract({
      ...compiledHoldings.toViem(),
      functionName: 'holdings',
      args: [tokens, HOLDER],
    });
    const sum = BALANCES.reduce((a, b) => a + b, 0n);
    expect(out).toStrictEqual({ balances: [...BALANCES], total: sum, check: sum });
    expectTypeOf(out).toEqualTypeOf<{
      balances: readonly bigint[];
      total: bigint;
      check: bigint;
    }>();
  });

  test('an empty array records zero iterations', async () => {
    const out = await publicClient.readContract({
      ...compiledHoldings.toViem(),
      functionName: 'holdings',
      args: [[], HOLDER],
    });
    expect(out).toStrictEqual({ balances: [], total: 0n, check: 0n });
  });

  test('forEach over a tuple[] arg reads named fields; break stops at the first hit', async () => {
    const out = await publicClient.readContract({
      ...compiledFirstFunded.toViem(),
      functionName: 'firstFunded',
      args: [
        [
          { token: tokens[0]!, owner: STRANGER }, // zero balance — skipped
          { token: tokens[1]!, owner: HOLDER }, // funded — break here
          { token: tokens[2]!, owner: HOLDER }, // never scanned
        ],
      ],
    });
    expect(out).toStrictEqual({ found: getAddress(tokens[1]!), foundIndex: 1n });
  });

  test('no query matches → the cells keep their zero defaults', async () => {
    const out = await publicClient.readContract({
      ...compiledFirstFunded.toViem(),
      functionName: 'firstFunded',
      args: [[{ token: tokens[0]!, owner: STRANGER }]],
    });
    expect(out).toStrictEqual({ found: ZERO, foundIndex: 0n });
  });
});
