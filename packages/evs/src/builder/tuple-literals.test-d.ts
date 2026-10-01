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
    // a nested tuple literal holds host values (abitype's primitive type)
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
