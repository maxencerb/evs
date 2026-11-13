/**
 * A build-time module: the plugin runs this file in Node during the build and puts what it
 * exports into the bundle. The browser gets the bytecode and the ABI of `poolTokens`, and
 * neither this source nor the compiler.
 */

import { erc20Abi, parseAbi } from 'viem';

import { evscript, t } from '@maxencerb/evs';

const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

/** A pool's two tokens and their symbols: four reads, one `eth_call`. */
export const poolTokens = evscript({ name: 'poolTokens', args: [t.address] }, (s, pool) => {
  const token0 = s.read({ address: pool, abi: poolAbi, functionName: 'token0' });
  const token1 = s.read({ address: pool, abi: poolAbi, functionName: 'token1' });
  const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
  const symbol1 = s.read({ address: token1, abi: erc20Abi, functionName: 'symbol' });
  return s.return({ token0, token1, symbol0, symbol1 });
})
  .compile({ optimize: true })
  .toPrecompiled();
