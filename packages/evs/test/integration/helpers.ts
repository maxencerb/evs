/**
 * Shared helpers for the anvil integration tier (testing.md §3).
 *
 * One anvil per vitest worker via the prool proxy (`harness/anvil.ts`). Files in a worker
 * run serially, so per-file deployments never race nonces.
 */

import {
  BaseError,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { publicClient, rpcUrl } from '../harness/anvil.js';

/** anvil's well-known funded account #0 (mnemonic `test test … junk`). */
export const DEPLOYER_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const deployer = privateKeyToAccount(DEPLOYER_KEY);

export const walletClient: WalletClient = createWalletClient({
  account: deployer,
  chain: foundry,
  transport: http(rpcUrl),
});

/** Deploys a contract from generated foundry artifacts and returns its address. */
export async function deploy(
  abi: Abi,
  bytecode: Hex,
  args: readonly unknown[] = [],
): Promise<Address> {
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    // viem types constructor args from the abi generic; the generated artifacts are
    // passed through `Abi` here on purpose (one helper for every fixture contract).
    args: args as never,
    account: deployer,
    chain: foundry,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress;
  if (address === null || address === undefined) {
    throw new Error(`deploy: no contractAddress in receipt for ${hash}`);
  }
  return getAddress(address); // anvil receipts are lowercase; readContract returns checksummed
}

/** Sends a state-changing call from the deployer and waits for it to mine. */
export async function write(params: {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}): Promise<void> {
  const hash = await walletClient.writeContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args as never,
    account: deployer,
    chain: foundry,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Extracts the raw revert payload from a viem eth_call error tree.
 * Returns '0x' for empty reverts. Throws if `err` is not a revert-shaped error.
 */
export function extractRevertData(err: unknown): Hex {
  if (!(err instanceof BaseError)) {
    throw new Error(`extractRevertData: not a viem BaseError: ${String(err)}`);
  }
  // The payload's home differs by action: RawContractError for contract actions,
  // RpcRequestError.data for plain `call()` (anvil returns JSON-RPC error code 3).
  const carrier = err.walk((e) => {
    if (typeof e !== 'object' || e === null || !('data' in e)) return false;
    const data = (e as { data: unknown }).data;
    if (typeof data === 'string') return data.startsWith('0x');
    return (
      typeof data === 'object' &&
      data !== null &&
      'data' in data &&
      typeof (data as { data: unknown }).data === 'string'
    );
  });
  if (carrier === null) return '0x'; // empty revert: no data anywhere in the chain
  const data = (carrier as unknown as { data: Hex | { data: Hex } }).data;
  return typeof data === 'string' ? data : data.data;
}

/** Runs an eth_call expected to revert; returns the raw revert payload. */
export async function callExpectRevert(params: {
  to?: Address;
  code?: Hex;
  data: Hex;
  stateOverride?: { address: Address; code: Hex }[];
}): Promise<Hex> {
  try {
    await publicClient.call(
      params.code === undefined
        ? {
            to: params.to,
            data: params.data,
            ...(params.stateOverride === undefined ? {} : { stateOverride: params.stateOverride }),
          }
        : { code: params.code, data: params.data },
    );
  } catch (err) {
    return extractRevertData(err);
  }
  throw new Error('callExpectRevert: call unexpectedly succeeded');
}

/** Deterministic LCG so corpora are stable across runs (testing.md: seeded corpora only). */
export function lcg(seed: bigint): () => bigint {
  let state = seed & ((1n << 64n) - 1n);
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return state;
  };
}
