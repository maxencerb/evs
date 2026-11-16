import { parseAbi } from 'viem';

/**
 * An ABI from viem's `parseAbi` is typed like the same ABI written `as const`. The two differ in
 * one way: `parseAbi` leaves the `name` key out of an unnamed tuple member, where a hand-written
 * ABI has `name: ''`.
 */
import { evscript, t, type Expr } from '@maxencerb/evs';

import { expectType, type Same } from './assert.js';

const parsed = parseAbi([
  'function pair(address who) view returns ((uint256, address))',
  'function position(address who) view returns ((address token, uint256 amount))',
]);

const literal = [
  {
    type: 'function',
    name: 'pair',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: '', type: 'uint256' },
          { name: '', type: 'address' },
        ],
      },
    ],
  },
] as const;

const Position = t.struct({ token: t.address, amount: t.uint256 });

export const tupleOutputs = evscript({ name: 'tupleOutputs', args: [t.address] }, (s, who) => {
  // a tuple with unnamed members: positional, read with `.at(i)`
  const fromParsed = s.read({ address: who, abi: parsed, functionName: 'pair', args: [who] });
  const fromLiteral = s.read({ address: who, abi: literal, functionName: 'pair', args: [who] });
  expectType<Same<typeof fromParsed, typeof fromLiteral>>();
  const member = fromParsed.at(0).get();
  expectType<Same<typeof member, Expr<'uint256'> | Expr<'address'>>>();

  // a tuple with named members is the struct written by hand
  const position = s.read({ address: who, abi: parsed, functionName: 'position', args: [who] });
  const amountOf = s.fn('amountOf', [Position], (p) => p.amount.get());
  expectType<Same<ReturnType<typeof position.amount.get>, Expr<'uint256'>>>();

  return s.return({ pair: fromParsed, amount: amountOf(position) });
});
