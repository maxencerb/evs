/* oxlint-disable vitest/expect-expect --
 * the rejection tests assert through their `@ts-expect-error` lines, which the rule cannot see. */
/**
 * Call value type tests: `value` (the wei a CALL sends) is accepted by `s.call` / `s.tryCall` /
 * `s.simulate` / `s.trySimulate` for a `payable` function only — never by `s.read` /
 * `s.tryRead`, never for a `nonpayable` target, and for an overloaded name it follows the
 * overload the args resolve to. A widened ABI accepts it (the recorder checks at run time).
 * Typecheck only.
 */
import type { Abi } from 'abitype';
import { expectTypeOf, test } from 'vite-plus/test';

import { t, type Expr } from '../core/types.js';
import { evscript, type CallValue } from './script.js';

const lidoAbi = [
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'payable',
    inputs: [{ name: 'referral', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getPooledEthByShares',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'stake',
    stateMutability: 'payable',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'stake',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const ZERO = '0x0000000000000000000000000000000000000000';

test('value is accepted on the four CALL verbs for a payable function', () => {
  evscript({ name: 'pay', args: [t.address, t.uint256] }, (s, lido, amount) => {
    const p = { address: lido, abi: lidoAbi, functionName: 'submit', args: [ZERO] } as const;
    const a = s.call({ ...p, value: amount });
    const b = s.simulate({ ...p, value: 10n ** 18n });
    const c = s.tryCall({ ...p, value: s.add(amount, 1n) });
    const d = s.trySimulate({ ...p, value: 1 });
    // the result types are unchanged by `value`
    expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(b).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(c.value).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(d.success).toEqualTypeOf<Expr<'bool'>>();
    return s.return({ a, b, c: c.value, d: d.value });
  });
});

test('value is rejected for a nonpayable function', () => {
  evscript({ name: 'pay', args: [t.address] }, (s, lido) => {
    const p = { address: lido, abi: lidoAbi, functionName: 'deposit', args: [1n] } as const;
    // @ts-expect-error — deposit is nonpayable: it would revert on any ETH sent
    s.call({ ...p, value: 1n });
    // @ts-expect-error — same under s.simulate
    s.simulate({ ...p, value: 1n });
    // @ts-expect-error — and the try verbs
    s.trySimulate({ ...p, value: 1n });
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('value is rejected by s.read / s.tryRead (STATICCALL sends no ETH)', () => {
  evscript({ name: 'pay', args: [t.address] }, (s, lido) => {
    const p = {
      address: lido,
      abi: lidoAbi,
      functionName: 'getPooledEthByShares',
      args: [1n],
    } as const;
    // @ts-expect-error — a view function under s.read
    s.read({ ...p, value: 1n });
    // @ts-expect-error — and s.tryRead
    s.tryRead({ ...p, value: 1n });
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('value must be a uint256 (a literal or an Expr<uint256>)', () => {
  evscript({ name: 'pay', args: [t.address, t.uint8] }, (s, lido, small) => {
    const p = { address: lido, abi: lidoAbi, functionName: 'submit', args: [ZERO] } as const;
    // @ts-expect-error — an Expr<'uint8'> is not a uint256 (convert it with .toUint(256))
    s.call({ ...p, value: small });
    const b = s.call({ ...p, value: small.toUint('uint256') });
    expectTypeOf(b).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ b });
  });
});

test('value follows overload resolution: the payable stake() takes it, stake(uint256) does not', () => {
  evscript({ name: 'pay', args: [t.address, t.uint256] }, (s, lido, amount) => {
    const a = s.call({ address: lido, abi: lidoAbi, functionName: 'stake', value: amount });
    s.call({
      address: lido,
      abi: lidoAbi,
      functionName: 'stake',
      args: [amount],
      // @ts-expect-error — the overload these args resolve to is nonpayable
      value: amount,
    });
    return s.return({ a });
  });
  expectTypeOf<
    CallValue<typeof lidoAbi, 'stake', 'payable' | 'nonpayable', readonly []>
  >().toEqualTypeOf<CallValue<typeof lidoAbi, 'submit', 'payable' | 'nonpayable'>>();
});

test('a widened ABI accepts value (checked at recording time instead)', () => {
  const wide: Abi = lidoAbi;
  evscript({ name: 'pay', args: [t.address, t.uint256] }, (s, lido, amount) => {
    s.call({ address: lido, abi: wide, functionName: 'submit', args: [ZERO], value: amount });
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('unknown params stay excess-property errors on a typed call', () => {
  evscript({ name: 'pay', args: [t.address] }, (s, lido) => {
    s.call({
      address: lido,
      abi: lidoAbi,
      functionName: 'submit',
      args: [ZERO],
      // @ts-expect-error — not a param (the recorder rejects it too, for untyped callers)
      valu: 1n,
    });
    return s.return({ ok: s.lit(t.bool, true) });
  });
});
