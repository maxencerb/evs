/**
 * M9 `viem.ts` — the init-code wrapper and the two `toViem()` shapes
 * (architecture §12, docs/research/viem-integration.md §1/§2/§5).
 *
 * - viem's deployless `code` parameter expects CREATION bytecode — passing runtime bytecode
 *   fails SILENTLY (viem-integration §1.3, empirically verified). The artifact therefore only
 *   ever exposes creation bytecode under a key named `code`; the raw fields are named
 *   `runtimeBytecode` / `initBytecode` deliberately.
 * - The locked 10-byte wrapper is `61 RRRR 80 600A 5F 39 5F F3` (RRRR = runtime length,
 *   big-endian PUSH2 immediate). The paris variant swaps `5F` (PUSH0) for `3D`
 *   (RETURNDATASIZE — zero at the start of an init frame):
 *
 *     61 RRRR   PUSH2 len        [len]
 *     80        DUP1             [len, len]
 *     60 0A     PUSH1 0x0A       [10, len, len]
 *     5F        PUSH0            [0, 10, len, len]
 *     39        CODECOPY         [len]            ; mem[0..len) = code[10..10+len)
 *     5F        PUSH0            [0, len]
 *     F3        RETURN                            ; return mem[0..len) — the runtime
 *
 * - State-override mode takes runtime bytecode directly at a deterministic address;
 *   `DEFAULT_SCRIPT_ADDRESS` is the last 20 bytes of keccak256("evs.script") — no
 *   code/storage/balance on any major chain (viem-integration §5.1).
 */

import type { Abi, Address } from 'abitype';
import type { StateOverride } from 'viem';

import type { EvmVersion } from './asm/ops.js';
import { EvsCompileError, EvsTypeError } from './core/errors.js';
import type { Hex } from './core/types.js';

// ---------------------------------------------------------------------------
// init wrapper (architecture §10/§12 — the locked 10-byte builder)
// ---------------------------------------------------------------------------

/** EIP-170 keeps runtimes ≤ 24,576, far below the PUSH2 immediate ceiling. */
const PUSH2_MAX = 0xffff;

const EVM_VERSIONS: ReadonlySet<string> = new Set(['paris', 'shanghai', 'cancun']);

function assertEvmVersion(evmVersion: string): void {
  if (!EVM_VERSIONS.has(evmVersion)) {
    throw new EvsCompileError(
      'EVM_VERSION',
      `unknown evmVersion ${JSON.stringify(evmVersion)} — expected 'paris', 'shanghai' or 'cancun'`,
    );
  }
}

const HEX_BYTES_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

function runtimeByteLength(runtime: Hex, where: string): number {
  if (typeof runtime !== 'string' || !HEX_BYTES_RE.test(runtime)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}: runtime bytecode must be 0x-prefixed even-length hex`,
    );
  }
  return (runtime.length - 2) / 2;
}

/** The 10-byte wrapper for a given runtime length (`61 RRRR 80 600A 5F 39 5F F3`). */
function initWrapper(runtimeLength: number, evmVersion: EvmVersion): Hex {
  const zero = evmVersion === 'paris' ? '3d' : '5f';
  const len = runtimeLength.toString(16).padStart(4, '0');
  return `0x61${len}80600a${zero}39${zero}f3`;
}

/**
 * The shanghai/cancun wrapper template, `61 RRRR 80 600A 5F 39 5F F3`, with the PUSH2 runtime
 * length `RRRR` (bytes 1–2) zeroed — `toCreationBytecode` patches the real length in. Exposed
 * for golden tests and inspection; prepending it verbatim only round-trips a 0-byte runtime.
 */
export const INIT_CODE_PREFIX_SHANGHAI: Hex = initWrapper(0, 'shanghai');

/**
 * `initBytecode = wrapper(len) ++ runtime` (architecture §12). The wrapper CODECOPYs
 * everything after itself and RETURNs it as the deployed code, so a creation-frame `eth_call`
 * (viem deployless `code` mode) executes the runtime unchanged.
 */
export function toCreationBytecode(runtime: Hex, evmVersion: EvmVersion): Hex {
  assertEvmVersion(evmVersion);
  const length = runtimeByteLength(runtime, 'toCreationBytecode');
  if (length > PUSH2_MAX) {
    throw new EvsCompileError(
      'COMPILE_LIMIT',
      `toCreationBytecode: runtime is ${length} bytes — beyond the PUSH2 length immediate ` +
        `(${PUSH2_MAX}) and far beyond the EIP-170 limit of 24576`,
    );
  }
  const wrapper = initWrapper(length, evmVersion);
  return `0x${wrapper.slice(2)}${runtime.slice(2)}`;
}

// ---------------------------------------------------------------------------
// toViem shapes (viem-integration §5)
// ---------------------------------------------------------------------------

/**
 * Default script address for state-override mode: last 20 bytes of keccak256("evs.script").
 * No code/storage/balance on any major chain; replaceable per call.
 */
export const DEFAULT_SCRIPT_ADDRESS: Address = '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530';

/**
 * Deployless mode — maximum RPC compatibility: a plain 2-parameter `eth_call` with `to`
 * omitted. Spread the result into `readContract` (`code` must be CREATION bytecode — this is
 * why the input field is named `initBytecode`).
 */
export function toViemDeployless<const abi extends Abi>(s: {
  abi: abi;
  initBytecode: Hex;
}): { abi: abi; code: Hex } {
  return { abi: s.abi, code: s.initBytecode };
}

/**
 * State-override mode — deterministic `address(this)`, controllable `msg.sender` (via the
 * `account` call parameter). Spread the result into `readContract`; requires a provider
 * supporting the third `eth_call` parameter.
 */
export function toViemStateOverride<const abi extends Abi>(
  s: { abi: abi; runtimeBytecode: Hex },
  opts?: { address?: Address },
): { abi: abi; address: Address; stateOverride: StateOverride } {
  const address = opts?.address ?? DEFAULT_SCRIPT_ADDRESS;
  return {
    abi: s.abi,
    address,
    stateOverride: [{ address, code: s.runtimeBytecode }],
  };
}
