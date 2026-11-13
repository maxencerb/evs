import { createClient, http } from 'viem';
import { readContract } from 'viem/actions';
import { mainnet } from 'viem/chains';

import { decodeScriptError } from '@maxencerb/evs/runtime';

import { poolTokens } from './pool.evs.ts';

const USDC_WETH = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'; // Uniswap v3, 0.05 %

const client = createClient({ chain: mainnet, transport: http() });
const out = document.querySelector('#out');
if (out === null) throw new Error('index.html has no #out element');

try {
  // the result is typed from the script, as it is without the plugin
  const { token0, token1, symbol0, symbol1 } = await readContract(client, {
    ...poolTokens.toViem(),
    functionName: 'poolTokens',
    args: [USDC_WETH],
  });
  out.textContent = `${symbol0} (${token0})\n${symbol1} (${token1})`;
} catch (error) {
  // decoding a revert needs the ABI alone, which the precompiled script carries
  const reverted = decodeScriptError(poolTokens, error);
  out.textContent =
    reverted === undefined ? String(error) : `the script reverted: ${reverted.name}`;
}
