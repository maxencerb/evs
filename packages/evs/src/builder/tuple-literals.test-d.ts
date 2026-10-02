/**
 * Tuple literal type tests: `s.tuple` inits, `Field.set` and call args follow abitype's (and
 * viem's) naming rule — a record keyed by member name only when EVERY member is named, a
 * positional array as soon as one member is unnamed — so the shapes the types accept are the
 * shapes the recorder accepts (`validation.test.ts`, "checklist: tuple literals"). Typecheck only.
 */
import { expectTypeOf, test } from 'vite-plus/test';

import { t, type Expr, type LitOf } from '../core/types.js';
import type { AllMembersNamed } from '../core/types/derive.js';
import { evscript, type Tuple, type TupleInit } from './script.js';

const MIXED = {
  name: 'q',
  type: 'tuple',
  components: [
    { name: 'amount', type: 'uint256' },
    { name: '', type: 'address' },
  ],
} as const;
const Mixed = t.fromAbiParameter(MIXED);
const Pair = t.struct({ token: t.address, fee: t.uint24 });
const ALICE = '0x00000000000000000000000000000000000000a1';

const takeAbi = [
  {
    type: 'function',
    name: 'take',
    stateMutability: 'view',
    inputs: [MIXED],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

test('the naming rule matches abitype', () => {
  expectTypeOf<AllMembersNamed<typeof Pair.components>>().toEqualTypeOf<true>();
  expectTypeOf<AllMembersNamed<typeof Mixed.components>>().toEqualTypeOf<false>();
  expectTypeOf<
    AllMembersNamed<readonly [{ name: 'a' }, { name?: undefined }]>
  >().toEqualTypeOf<false>();
  // widened names count as named, as in abitype
  expectTypeOf<AllMembersNamed<readonly { name: string }[]>>().toEqualTypeOf<true>();
  // the host literal (abitype) and the s.tuple init agree on the positional shape
  expectTypeOf<LitOf<typeof Mixed>>().toExtend<readonly unknown[]>();
  expectTypeOf<TupleInit<typeof Mixed>>().toExtend<readonly unknown[]>();
});

test('a partly named tuple takes a positional literal everywhere', () => {
  evscript({ name: 'mixed', args: [t.address] }, (s, who) => {
    const full = s.tuple(Mixed, [1n, who]);
    const partial = s.tuple(Mixed, [2n]);
    // @ts-expect-error — a record is not a literal of a partly named tuple
    s.tuple(Mixed, { amount: 1n });
    // a nested tuple literal follows the same rule (its members may be staged, see below)
    const outer = s.tuple(t.struct({ q: Mixed, tag: t.uint8 }), { q: [3n, ALICE], tag: 7 });
    outer.q.set([4n, ALICE]);
    // @ts-expect-error — the member is positional too
    outer.q.set({ amount: 4n });
    const ok = s.read({ address: who, abi: takeAbi, functionName: 'take', args: [[5n, ALICE]] });
    expectTypeOf(full).toEqualTypeOf<Tuple<typeof Mixed>>();
    expectTypeOf(ok).toEqualTypeOf<Expr<'bool'>>();
    return s.return({ full, partial, outer, ok });
  });
});

test('a fully named struct takes a record', () => {
  evscript({ name: 'named', args: [t.address] }, (s, who) => {
    const p = s.tuple(Pair, { token: who });
    expectTypeOf(p).toEqualTypeOf<Tuple<typeof Pair>>();
    // @ts-expect-error — a positional array is not a struct literal
    s.tuple(Pair, [who, 3000]);
    // @ts-expect-error — an unknown key (a typo) is an excess property
    s.tuple(Pair, { token: who, fe: 3000 });
    return s.return({ p });
  });
});

test('a spread Tuple handle is no init (its members are Field handles, not values)', () => {
  evscript({ name: 'spread', args: [Pair, t.uint24] }, (s, p, fee) => {
    // @ts-expect-error — `token` would be a Field; the runtime copy holds no member at all
    s.tuple(Pair, { ...p, fee });
    const v = s.tuple(Pair, { token: p.token.get(), fee });
    expectTypeOf(v).toEqualTypeOf<Tuple<typeof Pair>>();
    return s.return({ v });
  });
});

// the 0.3.0 field report: an `INonfungiblePositionManager.collect`-shaped struct param
const COLLECT = {
  name: 'params',
  type: 'tuple',
  components: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'amount0Max', type: 'uint128' },
    { name: 'amount1Max', type: 'uint128' },
  ],
} as const;
const Collect = t.fromAbiParameter(COLLECT);
const MAX_U128 = 2n ** 128n - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';
const collectAbi = [
  {
    type: 'function',
    name: 'collect',
    stateMutability: 'payable',
    inputs: [COLLECT],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'peek',
    stateMutability: 'view',
    inputs: [COLLECT],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'peekMany',
    stateMutability: 'view',
    inputs: [{ ...COLLECT, type: 'tuple[]' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nested',
    stateMutability: 'view',
    inputs: [
      {
        name: 'o',
        type: 'tuple',
        components: [
          { ...COLLECT, name: 'inner' },
          { ...MIXED, name: 'm' },
          { name: 'n', type: 'uint8' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

test('a struct call arg literal may hold staged members, as the recorder coerces it', () => {
  evscript({ name: 'staged', args: [t.uint256, t.address] }, (s, id, who) => {
    const args = [{ tokenId: id, recipient: ZERO, amount0Max: MAX_U128, amount1Max: 9n }] as const;
    // every verb shares the arg typing, and the result is typed from the resolved function
    const read = s.read({ address: who, abi: collectAbi, functionName: 'peek', args });
    expectTypeOf(read).toEqualTypeOf<Expr<'uint256'>>();
    const tried = s.tryRead({ address: who, abi: collectAbi, functionName: 'peek', args });
    expectTypeOf(tried.value).toEqualTypeOf<Expr<'uint256'>>();
    const call = s.call({ address: who, abi: collectAbi, functionName: 'collect', args });
    expectTypeOf(call[0]).toEqualTypeOf<Expr<'uint256'>>();
    const sim = s.trySimulate({
      address: who,
      abi: collectAbi,
      functionName: 'collect',
      args: [
        {
          tokenId: id,
          recipient: who,
          amount0Max: id.mod(MAX_U128).toUint('uint128'),
          amount1Max: 0,
        },
      ],
    });
    expectTypeOf(sim.value[0]).toEqualTypeOf<Expr<'uint256'>>();
    s.simulate({ address: who, abi: collectAbi, functionName: 'collect', args });
    s.tryCall({ address: who, abi: collectAbi, functionName: 'collect', args });
    // the literal and the s.tuple form are interchangeable
    s.read({
      address: who,
      abi: collectAbi,
      functionName: 'peek',
      args: [s.tuple(Collect, { tokenId: id, amount0Max: MAX_U128, amount1Max: 9n })],
    });
    return s.return({ read, call: call[0], sim: sim.value[1] });
  });
});

test('staged members reach nested structs, tuple[] elements and positional tuples', () => {
  evscript({ name: 'deep', args: [t.uint256, t.address] }, (s, id, who) => {
    const inner = { tokenId: id, recipient: who, amount0Max: 1n, amount1Max: 2n } as const;
    // a tuple[] literal: each element a staged literal or a Tuple handle
    const many = s.read({
      address: who,
      abi: collectAbi,
      functionName: 'peekMany',
      args: [[inner, s.tuple(Collect, { tokenId: 7n })]],
    });
    expectTypeOf(many).toEqualTypeOf<Expr<'uint256'>>();
    // a nested struct (record), a nested partly named tuple (positional), a word member
    const nested = s.read({
      address: who,
      abi: collectAbi,
      functionName: 'nested',
      args: [{ inner, m: [id, who], n: 3 }],
    });
    expectTypeOf(nested).toEqualTypeOf<Expr<'bool'>>();
    // the same nested literal is a valid s.tuple init / Field.set value
    const outer = s.tuple(t.struct({ q: Mixed, tag: t.uint8 }), { q: [id, who], tag: 7 });
    outer.q.set([id, ALICE]);
    s.tuple(t.struct({ c: Collect }), {}).c.set(inner);
    return s.return({ many, nested, outer });
  });
});

test('a staged member is still checked against its member type and the literal shape', () => {
  evscript({ name: 'checked', args: [t.uint256, t.address, t.uint128] }, (s, id, who, small) => {
    s.read({
      address: who,
      abi: collectAbi,
      functionName: 'peek',
      // @ts-expect-error — an Expr<'uint256'> is not a uint128 member (the recorder: TYPE_MISMATCH)
      args: [{ tokenId: id, recipient: who, amount0Max: id, amount1Max: 9n }],
    });
    const ok = s.read({
      address: who,
      abi: collectAbi,
      functionName: 'peek',
      args: [{ tokenId: id, recipient: who, amount0Max: small, amount1Max: small }],
    });
    expectTypeOf(ok).toEqualTypeOf<Expr<'uint256'>>();
    s.read({
      address: who,
      abi: collectAbi,
      functionName: 'peek',
      // @ts-expect-error — an address Expr is not a uint256 member
      args: [{ tokenId: who, recipient: who, amount0Max: 1n, amount1Max: 9n }],
    });
    s.read({
      address: who,
      abi: collectAbi,
      functionName: 'peek',
      // @ts-expect-error — a call arg literal names every member (s.tuple zero-fills omitted ones)
      args: [{ tokenId: id, recipient: who }],
    });
    const [inner, m] = [s.tuple(Collect, {}), { amount: id }];
    // one line: tsc and tsgolint report this error at different positions of the call
    // @ts-expect-error — the partly named member stays positional with staged values too
    s.read({ address: who, abi: collectAbi, functionName: 'nested', args: [{ inner, m, n: 3 }] });
    s.read({
      address: who,
      abi: collectAbi,
      functionName: 'peekMany',
      // @ts-expect-error — a tuple[] element is checked like a struct arg
      args: [[{ tokenId: who, recipient: who, amount0Max: 1n, amount1Max: 2n }]],
    });
    return s.return({ ok });
  });
});

// a fixed `tuple[N]` takes exactly N elements, staged or not (abitype's host arm already did for
// an all-constant literal; the staged arm keeps that check)
const PAIR = { ...COLLECT, name: 'pair', type: 'tuple[2]' } as const;
const PAIR_OF = {
  name: 'of',
  type: 'tuple',
  components: [PAIR, { name: 'n', type: 'uint8' }],
} as const;
const PairOf = t.fromAbiParameter(PAIR_OF);
const pairAbi = [
  {
    type: 'function',
    name: 'pair',
    stateMutability: 'view',
    inputs: [PAIR],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'pairOf',
    stateMutability: 'view',
    inputs: [PAIR_OF],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'pairs',
    stateMutability: 'view',
    inputs: [{ ...PAIR, type: 'tuple[2][]' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

test('a tuple[N] literal takes exactly N elements, wherever it appears', () => {
  evscript({ name: 'pairs', args: [t.uint256, t.address] }, (s, id, who) => {
    const lit = { tokenId: 1n, recipient: ZERO, amount0Max: 1n, amount1Max: 2n } as const;
    const staged = { tokenId: id, recipient: who, amount0Max: 1n, amount1Max: 2n } as const;
    const ok = s.read({ address: who, abi: pairAbi, functionName: 'pair', args: [[lit, staged]] });
    expectTypeOf(ok).toEqualTypeOf<Expr<'uint256'>>();
    // @ts-expect-error — three elements for a tuple[2] (constant elements)
    s.read({ address: who, abi: pairAbi, functionName: 'pair', args: [[lit, lit, lit]] });
    // @ts-expect-error — one element for a tuple[2]
    s.read({ address: who, abi: pairAbi, functionName: 'pair', args: [[lit]] });
    // @ts-expect-error — three elements for a tuple[2] (staged elements)
    s.read({ address: who, abi: pairAbi, functionName: 'pair', args: [[staged, staged, staged]] });
    // a nested tuple[2] member of a struct call arg
    s.read({
      address: who,
      abi: pairAbi,
      functionName: 'pairOf',
      args: [{ pair: [staged, lit], n: 1 }],
    });
    const three = { pair: [staged, lit, lit], n: 1 } as const;
    // one line: tsc and tsgolint report this error at different positions of the call
    // @ts-expect-error — the nested tuple[2] member has three elements
    s.read({ address: who, abi: pairAbi, functionName: 'pairOf', args: [three] });
    // a tuple[2][] row: the outer [] takes any count, each row exactly two
    s.read({
      address: who,
      abi: pairAbi,
      functionName: 'pairs',
      args: [
        [
          [lit, staged],
          [staged, lit],
          [lit, lit],
        ],
      ],
    });
    s.read({
      address: who,
      abi: pairAbi,
      functionName: 'pairs',
      // @ts-expect-error — a tuple[2] row has three elements
      args: [[[lit, staged, lit]]],
    });
    // s.tuple inits and Field.set
    const of = s.tuple(PairOf, { pair: [staged, lit] });
    // @ts-expect-error — an s.tuple init's tuple[2] member has three elements
    s.tuple(PairOf, { pair: [lit, lit, lit] });
    of.pair.set([lit, s.tuple(t.fromAbiParameter(COLLECT), { tokenId: id })]);
    // @ts-expect-error — Field.set of a tuple[2] member with one element
    of.pair.set([lit]);
    return s.return({ ok, of });
  });
});
