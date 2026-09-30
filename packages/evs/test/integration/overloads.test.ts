/**
 * Issue #4 — overloaded view/pure function resolution against a real solc contract on anvil.
 *
 * `Overloaded.sol` declares eight `get` overloads, each returning a different type. One script
 * calls them all by bare name (the args' types pick the overload), by canonical signature (the
 * escape hatch for literals that fit several), and — for the NONPAYABLE `get(bytes32)` — through
 * `s.call`, where the view overloads never compete. The script's results are compared with viem's
 * own overload-resolving `readContract` against the same deployment, so a wrongly resolved
 * overload (a different selector) shows up as a decode failure or a value mismatch.
 */

import { toFunctionSelector } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { evscript, t } from '../../src/index.js';
import { Overloaded } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy } from './helpers.js';

let target: `0x${string}`;

beforeAll(async () => {
  target = await deploy(Overloaded.abi, Overloaded.bytecode);
});

const abi = Overloaded.abi;
const BOB = '0x0000000000000000000000000000000000000b0b';
const HASH = '0x00000000000000000000000000000000000000000000000000000000000000ff';

const overloads = evscript(
  {
    name: 'overloads',
    args: [t.address, t.uint256, t.uint8, t.address, t.string],
  },
  (s, c, x, small, who, str) => {
    // resolved by the args' types
    const none = s.read({ address: c, abi, functionName: 'get' });
    const wide = s.read({ address: c, abi, functionName: 'get', args: [x] });
    const narrow = s.read({ address: c, abi, functionName: 'get', args: [small] });
    const nonZero = s.read({ address: c, abi, functionName: 'get', args: [who] });
    const len = s.read({ address: c, abi, functionName: 'get', args: [str] });
    const [sum, product] = s.read({ address: c, abi, functionName: 'get', args: [x, 4n] });
    const pos = s.read({
      address: c,
      abi,
      functionName: 'get',
      args: [{ id: 9n, owner: BOB }],
      struct: true,
    });
    const handle = s.tuple(t.struct({ id: t.uint256, owner: t.address }), { id: x, owner: who });
    const [echoId] = s.read({ address: c, abi, functionName: 'get', args: [handle] });
    // literals that fit several overloads: named by signature
    const bySigWide = s.read({ address: c, abi, functionName: 'get(uint256)', args: [5n] });
    const bySigNarrow = s.read({ address: c, abi, functionName: 'get(uint8)', args: [5] });
    // the nonpayable overload: only s.call / s.tryCall see it (a 0x literal is unambiguous there)
    const hash = s.call({ address: c, abi, functionName: 'get', args: [HASH] });
    const tried = s.tryRead({ address: c, abi, functionName: 'get', args: [small] });
    return s.return({
      none,
      wide,
      narrow,
      nonZero,
      len,
      sum,
      product,
      posId: pos.id.get(),
      posOwner: pos.owner.get(),
      echoId,
      bySigWide,
      bySigNarrow,
      hash,
      triedOk: tried.success,
      tried: tried.value,
    });
  },
);

const compiled = overloads.compile();

describe('overloaded view/pure functions (issue #4)', () => {
  test('every overload resolves to the one viem resolves, with its own return type', async () => {
    const x = 21n;
    const small = 5;
    const who = BOB;
    const str = 'hello';
    // viem resolves overloads first-match (numbers fit every uintN), so the reference reads
    // go through an ABI pruned to the one entry, by selector
    const read = async (sig: string, args: readonly unknown[]): Promise<unknown> =>
      publicClient.readContract({
        address: target,
        abi: abi.filter(
          (it) => it.type === 'function' && toFunctionSelector(it) === toFunctionSelector(sig),
        ),
        functionName: 'get',
        args,
      } as never);
    const expected = {
      none: await read('get()', []),
      wide: await read('get(uint256)', [x]),
      narrow: await read('get(uint8)', [small]),
      nonZero: await read('get(address)', [who]),
      len: await read('get(string)', [str]),
      pair: (await read('get(uint256,uint256)', [x, 4n])) as readonly [bigint, bigint],
      pos: (await read('get((uint256,address))', [{ id: 9n, owner: BOB }])) as readonly [
        bigint,
        string,
      ],
      echo: (await read('get((uint256,address))', [{ id: x, owner: who }])) as readonly [
        bigint,
        string,
      ],
    };
    // sanity: the contract's overloads really do differ
    expect(expected).toMatchObject({ none: 7n, wide: 42n, nonZero: true, len: 5n });
    expect(expected.narrow).toBe(`0x${(105).toString(16).padStart(64, '0')}`);

    for (const params of [compiled.toViem(), compiled.toViem({ mode: 'stateOverride' })]) {
      const out = await publicClient.readContract({
        ...params,
        functionName: 'overloads',
        args: [target, x, small, who, str],
      });
      expect(out).toStrictEqual({
        none: expected.none,
        wide: expected.wide,
        narrow: expected.narrow,
        nonZero: expected.nonZero,
        len: expected.len,
        sum: expected.pair[0],
        product: expected.pair[1],
        posId: expected.pos[0],
        posOwner: expected.pos[1],
        echoId: expected.echo[0],
        bySigWide: 10n,
        bySigNarrow: `0x${(105).toString(16).padStart(64, '0')}`,
        hash: HASH,
        triedOk: true,
        tried: expected.narrow,
      });
    }
  });
});
