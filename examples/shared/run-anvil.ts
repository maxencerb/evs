/**
 * Tiny anvil launcher shared by the examples: spawns a throwaway anvil on a free port,
 * hands the caller funded clients + a deploy helper, and always tears down.
 *
 * Examples run against this so they work offline with zero configuration:
 *   bun examples/pool-meta/index.ts
 */

import { Instance } from 'prool';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const ANVIL_KEY0: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export interface ExampleChain {
  client: PublicClient;
  account: ReturnType<typeof privateKeyToAccount>;
  deploy(abi: Abi, bytecode: Hex, args?: readonly unknown[]): Promise<Address>;
  write(params: {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<void>;
  stop(): Promise<void>;
}

export async function startAnvil(): Promise<ExampleChain> {
  const port = 9000 + Math.floor(Math.random() * 500);
  const anvil = Instance.anvil({ port, hardfork: 'Prague' });
  await anvil.start();

  const account = privateKeyToAccount(ANVIL_KEY0);
  const transport = http(`http://127.0.0.1:${port}`);
  const client = createPublicClient({ chain: foundry, transport });
  const wallet = createWalletClient({ account, chain: foundry, transport });

  return {
    client,
    account,
    async deploy(abi, bytecode, args = []) {
      const hash = await wallet.deployContract({
        abi,
        bytecode,
        args,
        account,
        chain: foundry,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
        throw new Error('deploy failed: no contract address');
      }
      return receipt.contractAddress;
    },
    async write({ address, abi, functionName, args }) {
      const hash = await wallet.writeContract({
        address,
        abi,
        functionName,
        args,
        account,
        chain: foundry,
      });
      await client.waitForTransactionReceipt({ hash });
    },
    async stop() {
      await anvil.stop();
    },
  };
}
