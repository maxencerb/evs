// STUB — replaced by module agent
// Signatures copied faithfully from docs/design/module-interfaces.md §M9 (frozen).
import type { Abi, Address } from 'abitype';
import type { StateOverride } from 'viem';

import type { EvmVersion } from './asm/ops.js';
import type { Hex } from './core/types.js';

export declare const INIT_CODE_PREFIX_SHANGHAI: Hex; // computed: 0x61 RRRR 80 600A 5F 39 5F F3 builder
export declare function toCreationBytecode(runtime: Hex, evmVersion: EvmVersion): Hex;
export declare const DEFAULT_SCRIPT_ADDRESS: Address; // 0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530

export declare function toViemDeployless<const abi extends Abi>(s: {
  abi: abi;
  initBytecode: Hex;
}): { abi: abi; code: Hex };

export declare function toViemStateOverride<const abi extends Abi>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts?: { address?: Address },
): { abi: abi; address: Address; stateOverride: StateOverride };
