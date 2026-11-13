/**
 * The app without evs: the same eight reads as two multicalls, the second on the addresses the
 * first returns.
 */
import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';

import { poolAbi } from './abi.ts';

const client = createPublicClient({ chain: mainnet, transport: http() });

export async function readPool(pool: Address, holder: Address) {
  const [token0, token1, fee, slot0] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: pool, abi: poolAbi, functionName: 'token0' },
      { address: pool, abi: poolAbi, functionName: 'token1' },
      { address: pool, abi: poolAbi, functionName: 'fee' },
      { address: pool, abi: poolAbi, functionName: 'slot0' },
    ],
  });
  const [symbol0, symbol1, decimals, balance0] = await client.multicall({
    contracts: [
      { address: token0, abi: erc20Abi, functionName: 'symbol' },
      { address: token1, abi: erc20Abi, functionName: 'symbol' },
      { address: token0, abi: erc20Abi, functionName: 'decimals' },
      { address: token0, abi: erc20Abi, functionName: 'balanceOf', args: [holder] },
    ],
  });
  if (symbol0.status === 'failure') throw symbol0.error;
  if (symbol1.status === 'failure') throw symbol1.error;
  if (balance0.status === 'failure') throw balance0.error;
  return {
    token0,
    token1,
    fee,
    tick: slot0[1],
    symbol0: symbol0.result,
    symbol1: symbol1.result,
    decimals0: decimals.status === 'success' ? decimals.result : 18,
    balance0: balance0.result,
  };
}
