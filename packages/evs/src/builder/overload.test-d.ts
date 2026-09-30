/**
 * Overload resolution type tests (issue #4): an overloaded `functionName` is resolved by the
 * `args`' types (the `ExtractAbiFunctionForArgs` approach viem ships), the result is typed from
 * the chosen overload, args fitting several overloads fail to compile, a canonical signature
 * (`'get(uint256)'`) names one overload exactly, and overloads outside the verb's mutability
 * bucket never compete. Typecheck only.
 */
import { expectTypeOf, test } from 'vite-plus/test';

import { t, type Expr } from '../core/types.js';
import { evscript, type ResolveOverload, type SubcallFunctionName, type Tuple } from './script.js';

const ovAbi = [
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'pure',
    inputs: [{ name: 'id', type: 'uint8' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'owner', type: 'address' },
        ],
      },
    ],
    outputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'address' },
    ],
  },
  // nonpayable overloads: compete only under s.call / s.simulate
  {
    type: 'function',
    name: 'get',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'h', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    type: 'function',
    name: 'solo',
    stateMutability: 'view',
    inputs: [{ name: 'x', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ALICE = '0x00000000000000000000000000000000000000a1';
const HASH = '0x00000000000000000000000000000000000000000000000000000000000000ff';

test('the args select the overload and type the result', () => {
  evscript(
    { name: 'resolve', args: [t.address, t.uint256, t.uint8, t.address] },
    (s, target, id, small, who) => {
      const none = s.read({ address: target, abi: ovAbi, functionName: 'get' });
      expectTypeOf(none).toEqualTypeOf<Expr<'uint256'>>();
      const empty = s.read({ address: target, abi: ovAbi, functionName: 'get', args: [] });
      expectTypeOf(empty).toEqualTypeOf<Expr<'uint256'>>();

      // typed handles pick uint256 vs uint8 vs address
      const byId = s.read({ address: target, abi: ovAbi, functionName: 'get', args: [id] });
      expectTypeOf(byId).toEqualTypeOf<Expr<'string'>>();
      const bySmall = s.read({ address: target, abi: ovAbi, functionName: 'get', args: [small] });
      expectTypeOf(bySmall).toEqualTypeOf<Expr<'bytes32'>>();
      const byWho = s.read({ address: target, abi: ovAbi, functionName: 'get', args: [who] });
      expectTypeOf(byWho).toEqualTypeOf<Expr<'bool'>>();

      // a hex literal only fits the address overload (no bytesN/string overload competes)
      const byLit = s.read({ address: target, abi: ovAbi, functionName: 'get', args: [ALICE] });
      expectTypeOf(byLit).toEqualTypeOf<Expr<'bool'>>();

      // a struct literal / Tuple handle selects the tuple overload; [many] outputs
      const byStruct = s.read({
        address: target,
        abi: ovAbi,
        functionName: 'get',
        args: [{ id: 1n, owner: ALICE }],
      });
      expectTypeOf(byStruct).toEqualTypeOf<readonly [Expr<'uint256'>, Expr<'address'>]>();
      const p = s.tuple(t.struct({ id: t.uint256, owner: t.address }), { id, owner: who });
      const byTuple = s.read({
        address: target,
        abi: ovAbi,
        functionName: 'get',
        args: [p],
        struct: true,
      });
      expectTypeOf(byTuple.a.get()).toEqualTypeOf<Expr<'uint256'>>();

      // try variant
      const tr = s.tryRead({ address: target, abi: ovAbi, functionName: 'get', args: [who] });
      expectTypeOf(tr.value).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(tr.success).toEqualTypeOf<Expr<'bool'>>();
      return s.return({ none, byId, bySmall, byWho, byLit });
    },
  );
});

test('a signature functionName names one overload exactly', () => {
  evscript({ name: 'sig', args: [t.address] }, (s, target) => {
    // `1n` alone would be ambiguous (uint256 vs uint8) — the signature settles it
    const wide = s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get(uint256)',
      args: [1n],
    });
    expectTypeOf(wide).toEqualTypeOf<Expr<'string'>>();
    const narrow = s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get(uint8)',
      args: [1],
    });
    expectTypeOf(narrow).toEqualTypeOf<Expr<'bytes32'>>();
    const tup = s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get((uint256,address))',
      args: [{ id: 1n, owner: ALICE }],
      struct: true,
    });
    expectTypeOf(tup).toEqualTypeOf<
      Tuple<{
        readonly type: 'tuple';
        readonly components: readonly [
          { readonly name: 'a'; readonly type: 'uint256' },
          { readonly name: 'b'; readonly type: 'address' },
        ];
      }>
    >();
    // the signature's own args are checked against that overload only
    s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get(uint256)',
      // @ts-expect-error — an address is not a uint256
      args: [ALICE],
    });
    // a non-overloaded name also accepts its signature
    const solo = s.read({ address: target, abi: ovAbi, functionName: 'solo(uint256)', args: [2n] });
    expectTypeOf(solo).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ wide, narrow });
  });

  // the signatures join the functionName autocomplete, filtered by the bucket
  expectTypeOf<
    'get(uint256)' | 'get(uint8)' | 'get(address)' | 'get((uint256,address))' | 'get()'
  >().toMatchTypeOf<SubcallFunctionName<typeof ovAbi, 'view' | 'pure'>>();
  expectTypeOf<'get(bytes32)' | 'get(uint256,uint256)'>().toMatchTypeOf<
    SubcallFunctionName<typeof ovAbi, 'nonpayable' | 'payable'>
  >();
  // ...and a view/pure overload's signature is not callable under s.call / s.simulate
  expectTypeOf<'get()'>().not.toMatchTypeOf<
    SubcallFunctionName<typeof ovAbi, 'nonpayable' | 'payable'>
  >();
  expectTypeOf<'get(uint8)'>().not.toMatchTypeOf<
    SubcallFunctionName<typeof ovAbi, 'nonpayable' | 'payable'>
  >();
});

test('args fitting several overloads do not compile', () => {
  evscript({ name: 'ambiguous', args: [t.address] }, (s, target) => {
    s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get',
      // @ts-expect-error — a bigint literal fits both get(uint256) and get(uint8)
      args: [1n],
    });
    s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get',
      // @ts-expect-error — a number literal fits both get(uint256) and get(uint8)
      args: [1],
    });
    // a typed literal settles it
    const lit = s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get',
      args: [s.lit(t.uint8, 1)],
    });
    expectTypeOf(lit).toEqualTypeOf<Expr<'bytes32'>>();
    return s.return({ lit });
  });

  // the resolution helper itself: both numeric overloads survive a bigint literal
  expectTypeOf<
    ResolveOverload<typeof ovAbi, 'get', 'view' | 'pure', readonly [1n]>['inputs'][0]['type']
  >().toEqualTypeOf<'uint256' | 'uint8'>();
});

test('mutability filtering: other-bucket overloads never compete', () => {
  evscript({ name: 'muts', args: [t.address, t.uint256] }, (s, target, id) => {
    // a 0x string fits get(address) (view) and get(bytes32) (nonpayable): one per bucket
    const r = s.read({ address: target, abi: ovAbi, functionName: 'get', args: [ALICE] });
    expectTypeOf(r).toEqualTypeOf<Expr<'bool'>>();
    const w = s.call({ address: target, abi: ovAbi, functionName: 'get', args: [HASH] });
    expectTypeOf(w).toEqualTypeOf<Expr<'address'>>();
    const sim = s.simulate({ address: target, abi: ovAbi, functionName: 'get', args: [1n, 2n] });
    expectTypeOf(sim).toEqualTypeOf<Expr<'int256'>>();
    const tc = s.tryCall({ address: target, abi: ovAbi, functionName: 'get', args: [id, id] });
    expectTypeOf(tc.value).toEqualTypeOf<Expr<'int256'>>();
    // the nonpayable (uint256,uint256) overload is not an s.read candidate
    s.read({
      address: target,
      abi: ovAbi,
      functionName: 'get',
      // @ts-expect-error — no view/pure get takes (uint256, uint256)
      args: [id, id],
    });
    return s.return({ w, r });
  });
});

test('t.fromOutputs names an overload by signature', () => {
  expectTypeOf(t.fromOutputs(ovAbi, 'get(uint256)')).toEqualTypeOf<'string'>();
  expectTypeOf(t.fromOutputs(ovAbi, 'get(uint8)')).toEqualTypeOf<'bytes32'>();
  expectTypeOf(t.fromOutputs(ovAbi, 'get((uint256,address))')).toEqualTypeOf<{
    readonly type: 'tuple';
    readonly components: readonly [
      { readonly name: 'a'; readonly type: 'uint256' },
      { readonly name: 'b'; readonly type: 'address' },
    ];
  }>();
});
