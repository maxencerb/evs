/**
 * The build-time module most tests build: three scripts that need no deployed contract (a
 * named export each, and the default export), next to plain-data exports.
 */

import { evscript, namedArg, t } from '@maxencerb/evs';

import { MIN } from './limits.ts';

const TooSmall = t.error('TooSmall', [namedArg('value', t.uint256)]);

/** Sums an array argument. */
export const sum = evscript({ name: 'sum', args: [t.array(t.uint256)] }, (s, values) => {
  const total = s.let(t.uint256, 0n);
  s.forEach(values, (value) => {
    total.set(total.get().add(value));
  });
  return s.return({ total: total.get() });
})
  .compile({ optimize: true })
  .toPrecompiled();

/** Returns its argument, or reverts with `TooSmall` under `MIN`. */
export const atLeast = evscript(
  { name: 'atLeast', args: [t.uint256], errors: [TooSmall] },
  (s, value) => {
    s.if(value.lt(MIN), () => {
      s.throw(TooSmall, { value });
    });
    return s.return({ value });
  },
)
  .compile()
  .toPrecompiled();

/** Reads the execution environment, compiled for another EVM version than the default. */
export default evscript({ name: 'chain' }, (s) =>
  s.return({ chainId: s.env('chainid'), blockNumber: s.env('blocknumber') }),
)
  .compile({ evmVersion: 'paris' })
  .toPrecompiled();

export const MIN_VALUE = MIN;

export const settings = {
  label: 'pool "A"',
  chains: [1, 10, 8453],
  fees: { low: 500n, high: 10_000n },
  optional: { missing: undefined, nothing: null, enabled: true },
};
