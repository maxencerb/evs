/**
 * M10 `test/harness/evm.ts` — in-process EVM execution harness (unit tier).
 *
 * Contract: docs/design/module-interfaces.md §M10 (frozen `execRuntime` signature) +
 * docs/design/testing.md §2. Runs compiled script runtime bytecode on `@ethereumjs/evm`
 * (v10, catalog-pinned): the runtime is planted at a fixed SCRIPT address, fixture mocks
 * are planted at their own addresses (STATICCALL targets), and the call is executed with
 * `evm.runCall`. Default gas limit: 30,000,000 (anvil parity worst case, evm-target §4).
 *
 * Resolved v10 API names (design open risk, resolved against the installed 10.1.2):
 * - `createEVM(opts?)` async constructor (`@ethereumjs/evm` `constructors.ts`); defaults to
 *   `new Common({ chain: Mainnet })` (default hardfork **Prague** — matches the pinned anvil
 *   hardfork of the integration tier) and a `SimpleStateManager`.
 * - code planting: `evm.stateManager.putCode(address, bytes)` (`StateManagerInterface`).
 * - execution: `evm.runCall(EVMRunCallOpts)` → `EVMResult` with `execResult: ExecResult`
 *   (`returnValue: Uint8Array`, `executionGasUsed: bigint`, `exceptionError?: EVMError`).
 *   A REVERT surfaces as `exceptionError.error === 'revert'` with the payload in
 *   `returnValue`; any other `exceptionError` (e.g. INVALID) has an empty `returnValue`.
 * - `@ethereumjs/util`'s `Address` class is NOT re-exported by `@ethereumjs/evm` and the
 *   util package is not a direct dependency, so a minimal structurally-identical local
 *   class (`EthAddress`) is used; `SimpleStateManager` keys state by `address.toString()`
 *   (lowercase hex), which `EthAddress.toString()` matches.
 */

import { createEVM } from '@ethereumjs/evm';
import type { Address } from 'abitype';

import type { Hex } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// fixed addresses
// ---------------------------------------------------------------------------

/** Where `execRuntime` plants the script runtime (mirrors `DEFAULT_SCRIPT_ADDRESS`, M9). */
export const SCRIPT_ADDRESS: Address = '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530';

/** Deterministic non-zero `msg.sender` / `tx.origin` of the top-level call. */
export const CALLER_ADDRESS: Address = '0x1000000000000000000000000000000000000001';

/** Default gas limit: 30M — anvil's eth_call default, the parity worst case (evm §4). */
export const DEFAULT_GAS_LIMIT = 30_000_000n;

// ---------------------------------------------------------------------------
// frozen interface (module-interfaces §M10)
// ---------------------------------------------------------------------------

export interface EvmFixture {
  contracts?: Record<Address, Hex>;
  gasLimit?: bigint;
}

export async function execRuntime(
  runtime: Hex,
  calldata: Hex,
  fixture?: EvmFixture,
): Promise<{ success: boolean; data: Hex; gasUsed: bigint }> {
  const evm = await createEVM();

  await evm.stateManager.putCode(toEthAddress(SCRIPT_ADDRESS), hexToBytes(runtime));
  await Promise.all(
    Object.entries(fixture?.contracts ?? {}).map(([address, code]) =>
      evm.stateManager.putCode(toEthAddress(address), hexToBytes(code)),
    ),
  );

  const caller = toEthAddress(CALLER_ADDRESS);
  const result = await evm.runCall({
    caller,
    origin: caller,
    to: toEthAddress(SCRIPT_ADDRESS),
    data: hexToBytes(calldata),
    gasLimit: fixture?.gasLimit ?? DEFAULT_GAS_LIMIT,
  });

  const { exceptionError, returnValue, executionGasUsed } = result.execResult;
  return {
    success: exceptionError === undefined,
    data: bytesToHex(returnValue),
    gasUsed: executionGasUsed,
  };
}

// ---------------------------------------------------------------------------
// hex helpers (shared with fixtures.ts)
// ---------------------------------------------------------------------------

export function hexToBytes(hex: Hex): Uint8Array {
  const s = hex.slice(2);
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    throw new Error(`harness: invalid hex string ${hex}`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `0x${s}`;
}

// ---------------------------------------------------------------------------
// minimal Address implementation (structurally identical to @ethereumjs/util's)
// ---------------------------------------------------------------------------

class EthAddress {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (bytes.length !== 20) throw new Error('harness: address must be 20 bytes');
    this.bytes = bytes;
  }

  equals(address: EthAddress): boolean {
    if (this.bytes.length !== address.bytes.length) return false;
    for (let i = 0; i < this.bytes.length; i++) {
      if (this.bytes[i] !== address.bytes[i]) return false;
    }
    return true;
  }

  isZero(): boolean {
    return this.bytes.every((b) => b === 0);
  }

  isPrecompileOrSystemAddress(): boolean {
    // EIP-1352 range: 0x0000…0000 – 0x0000…ffff
    for (let i = 0; i < 18; i++) {
      if (this.bytes[i] !== 0) return false;
    }
    return true;
  }

  toString(): Hex {
    return bytesToHex(this.bytes);
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

function isAddressHex(s: string): s is Hex {
  return /^0x[0-9a-f]{40}$/.test(s);
}

function toEthAddress(address: string): EthAddress {
  const lower = address.toLowerCase();
  if (!isAddressHex(lower)) {
    throw new Error(`harness: invalid address ${address}`);
  }
  return new EthAddress(hexToBytes(lower));
}
