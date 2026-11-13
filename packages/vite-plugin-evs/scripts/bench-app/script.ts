/**
 * The job every app of the benchmark does: the eight reads of the pool metadata example, four
 * of them on addresses read earlier. The same script as `apps/docs/scripts/bench.ts` times.
 *
 * A function, so the benchmark can record it more than once.
 */
import { erc20Abi } from 'viem';

import { evscript, t } from '@maxencerb/evs';

import { poolAbi } from './abi.ts';

export const recordPoolMeta = () =>
  evscript({ name: 'poolMeta', args: [t.address, t.address] }, (s, pool, holder) => {
    const token0 = s.read({ address: pool, abi: poolAbi, functionName: 'token0' });
    const token1 = s.read({ address: pool, abi: poolAbi, functionName: 'token1' });
    const fee = s.read({ address: pool, abi: poolAbi, functionName: 'fee' });
    const slot0 = s.read({ address: pool, abi: poolAbi, functionName: 'slot0' });
    const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
    const symbol1 = s.read({ address: token1, abi: erc20Abi, functionName: 'symbol' });
    const d = s.tryRead({ address: token0, abi: erc20Abi, functionName: 'decimals' });
    const decimals0 = s.select(d.success, d.value, 18);
    const balance0 = s.read({
      address: token0,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder],
    });
    const tick = slot0[1];
    return s.return({ token0, token1, fee, tick, symbol0, symbol1, decimals0, balance0 });
  });
