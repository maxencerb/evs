/**
 * Shared helpers for the anvil integration tier.
 *
 * One anvil per vitest worker, started by prool (`harness/anvil.ts`). Files in a worker
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
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { publicClient, rpcUrl, testClient } from '../harness/anvil.js';

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
    args: args,
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

export interface WriteParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** Sends a state-changing call from the deployer and waits for it to mine. */
export async function write(params: WriteParams): Promise<void> {
  const hash = await walletClient.writeContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
    account: deployer,
    chain: foundry,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** How many transactions / receipt lookups a batch helper keeps in flight at once. */
const BATCH_CONCURRENCY = 16;

/** Maps `items` through `task` with at most {@link BATCH_CONCURRENCY} in flight, keeping order. */
async function inChunks<T, R>(
  items: readonly T[],
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += BATCH_CONCURRENCY) {
    const chunk = items.slice(start, start + BATCH_CONCURRENCY);
    out.push(...(await Promise.all(chunk.map((item, k) => task(item, start + k)))));
  }
  return out;
}

/**
 * Sends one transaction per item from the deployer (`send(item, nonce)`, explicit nonce and gas so viem
 * skips the per-tx nonce fetch and gas estimate) and returns their receipts in order.
 *
 * Automine is switched OFF for the batch: every transaction lands in the pool first, then
 * `evm_mine` is called until the deployer's nonce has caught up. With automine on, anvil mines
 * each transaction as it arrives, and concurrent sends reach it out of nonce order; a transaction
 * whose predecessor is mid-block when it arrives gets parked as "queued" (future nonce) and is
 * never promoted once that block lands. Nothing else is sent, so its receipt never comes and the
 * `beforeAll` hook hangs until the 30 s hook timeout (the flagship CI flake). Mining explicitly
 * after all sends are in keeps the single round trip of sends (bounded to
 * {@link BATCH_CONCURRENCY} in flight, so one worker never floods its anvil) without
 * any mining racing the submissions. The mining loop is bounded, so a transaction that cannot be
 * included fails loudly instead of hanging.
 */
async function sendBatch<T>(
  items: readonly T[],
  send: (item: T, nonce: number) => Promise<Hex>,
): Promise<TransactionReceipt[]> {
  const count = items.length;
  if (count === 0) return [];
  const first = await publicClient.getTransactionCount({
    address: deployer.address,
    blockTag: 'pending',
  });
  await testClient.setAutomine(false);
  let hashes: Hex[];
  try {
    hashes = await inChunks(items, (item, i) => send(item, first + i));
    // Blocks fill by gas limit, so a large batch can take a few blocks; every mined block
    // includes at least one of ours, so `count` blocks is a hard upper bound.
    for (let mined = 0; ; mined++) {
      await testClient.mine({ blocks: 1 });
      const next = await publicClient.getTransactionCount({
        address: deployer.address,
        blockTag: 'latest',
      });
      if (next >= first + count) break;
      if (mined >= count) {
        throw new Error(`sendBatch: ${first + count - next} of ${count} transactions not mined`);
      }
    }
  } finally {
    await testClient.setAutomine(true);
  }
  return inChunks(hashes, (hash) => publicClient.getTransactionReceipt({ hash }));
}

/**
 * Bulk variant of `deploy` for large fixture corpora: one batch of sends and a few explicit
 * `evm_mine`s instead of 2N sequential round trips (on a loaded CI runner the sequential form ran
 * into the test timeout). See {@link sendBatch} for why automine is off during the batch.
 */
export async function deployMany(
  specs: readonly { abi: Abi; bytecode: Hex; args?: readonly unknown[] }[],
  gas = 3_000_000n,
): Promise<Address[]> {
  const receipts = await sendBatch(specs, (spec, nonce) =>
    walletClient.deployContract({
      abi: spec.abi,
      bytecode: spec.bytecode,
      args: spec.args ?? [],
      account: deployer,
      chain: foundry,
      nonce,
      gas,
    }),
  );
  return receipts.map((receipt) => {
    const address = receipt.contractAddress;
    if (address === null || address === undefined) {
      throw new Error(`deployMany: no contractAddress in receipt for ${receipt.transactionHash}`);
    }
    return getAddress(address);
  });
}

/** Bulk variant of `write`: same batched, explicitly mined send as {@link deployMany}. */
export async function writeMany(calls: readonly WriteParams[], gas = 500_000n): Promise<void> {
  await sendBatch(calls, (call, nonce) =>
    walletClient.writeContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      account: deployer,
      chain: foundry,
      nonce,
      gas,
    }),
  );
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
    const data = e.data;
    if (typeof data === 'string') return data.startsWith('0x');
    return (
      typeof data === 'object' && data !== null && 'data' in data && typeof data.data === 'string'
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

/** Deterministic LCG so corpora are stable across runs (seeded corpora only). */
export function lcg(seed: bigint): () => bigint {
  let state = seed & ((1n << 64n) - 1n);
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return state;
  };
}
