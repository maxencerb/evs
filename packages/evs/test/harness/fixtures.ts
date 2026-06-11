/**
 * M10 `test/harness/fixtures.ts` — hand-assembled bytecode fixtures (testing.md §2).
 *
 * Seed corpus: the research fixtures from viem-integration Appendix A (`RUNTIME_42`,
 * `RUNTIME_WHOAMI`, `RUNTIME_STATICCALL`), plus programmable returner/reverter builders and
 * the attacker-shaped returners used by the M7 decode-bounds suite (huge head offsets, huge
 * lengths, off-by-one truncations, dirty high bits, empty returndata).
 *
 * All builders emit PUSH0 (Shanghai+); the harness EVM runs Prague, matching the pinned
 * anvil hardfork of the integration tier.
 */

import type { Address } from 'abitype';

import type { Hex } from '../../src/core/types.js';
import { hexToBytes } from './evm.js';

// ---------------------------------------------------------------------------
// research seed corpus (viem-integration App. A, byte-for-byte)
// ---------------------------------------------------------------------------

/**
 * Returns `uint256(42)`.
 *
 *   602a    PUSH1 0x2a
 *   6000    PUSH1 0
 *   52      MSTORE          ; mstore(0, 42)
 *   6020    PUSH1 0x20
 *   6000    PUSH1 0
 *   f3      RETURN          ; return(0, 32)
 */
export const RUNTIME_42: Hex = '0x602a60005260206000f3';

/**
 * Returns `(address(this), msg.sender)`.
 *
 *   30      ADDRESS
 *   6000    PUSH1 0
 *   52      MSTORE          ; mstore(0, address(this))
 *   33      CALLER
 *   6020    PUSH1 0x20
 *   52      MSTORE          ; mstore(32, msg.sender)
 *   6040    PUSH1 0x40
 *   6000    PUSH1 0
 *   f3      RETURN          ; return(0, 64)
 */
export const RUNTIME_WHOAMI: Hex = '0x306000523360205260406000f3';

/** Mainnet WETH — the STATICCALL target baked into `RUNTIME_STATICCALL`. */
export const WETH_ADDRESS: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/**
 * STATICCALLs `WETH.symbol()` and bubbles the returndata (plant a mock at `WETH_ADDRESS`
 * via `fixture.contracts` when running on the harness).
 *
 *   6395d89b41    PUSH4 0x95d89b41          ; selector("symbol()")
 *   60e0          PUSH1 0xe0
 *   1b            SHL
 *   6000          PUSH1 0
 *   52            MSTORE                    ; mstore(0, selector << 224)
 *   6000          PUSH1 0                   ; retLen
 *   6000          PUSH1 0                   ; retOff
 *   6004          PUSH1 4                   ; argLen
 *   6000          PUSH1 0                   ; argOff
 *   73c02a…56cc2  PUSH20 WETH
 *   5a            GAS
 *   fa            STATICCALL
 *   50            POP
 *   3d            RETURNDATASIZE
 *   6000          PUSH1 0
 *   6000          PUSH1 0
 *   3e            RETURNDATACOPY            ; returndatacopy(0, 0, returndatasize)
 *   3d            RETURNDATASIZE
 *   6000          PUSH1 0
 *   f3            RETURN                    ; return(0, returndatasize)
 */
export const RUNTIME_STATICCALL: Hex =
  '0x6395d89b4160e01b600052600060006004600073c02aaa39b223fe8d0a0e5c4f27ead9083c756cc25afa503d600060003e3d6000f3';

// ---------------------------------------------------------------------------
// utility runtimes
// ---------------------------------------------------------------------------

/**
 * Echoes its full calldata back (sub-call arg-encoding differential, testing.md §4.2).
 *
 *   36      CALLDATASIZE
 *   5f      PUSH0
 *   5f      PUSH0
 *   37      CALLDATACOPY    ; calldatacopy(0, 0, calldatasize)
 *   36      CALLDATASIZE
 *   5f      PUSH0
 *   f3      RETURN          ; return(0, calldatasize)
 */
export const RUNTIME_ECHO: Hex = '0x365f5f37365ff3';

/**
 * Spins forever — burns the entire gas limit (gas-limit-respected test).
 *
 *   5b      JUMPDEST        ; pc 0
 *   6000    PUSH1 0
 *   56      JUMP            ; goto 0
 */
export const RUNTIME_SPIN: Hex = '0x5b600056';

// ---------------------------------------------------------------------------
// programmable returner / reverter builders
// ---------------------------------------------------------------------------

/**
 * Runtime bytecode that RETURNs exactly `payload` for any calldata.
 *
 *   61 LLLL   PUSH2 len
 *   80        DUP1
 *   61 000b   PUSH2 11                ; payload offset (prefix is 11 bytes)
 *   5f        PUSH0
 *   39        CODECOPY                ; codecopy(0, 11, len)
 *   5f        PUSH0
 *   f3        RETURN                  ; return(0, len)
 *   <payload>
 */
export function returner(payload: Hex): Hex {
  return exitWithPayload(payload, 'f3');
}

/** Same shape as {@link returner} but ends in REVERT (`fd`) — programmable revert payload. */
export function reverter(payload: Hex): Hex {
  return exitWithPayload(payload, 'fd');
}

function exitWithPayload(payload: Hex, exitOp: 'f3' | 'fd'): Hex {
  const bytes = hexToBytes(payload); // validates the hex
  if (bytes.length > 0xffff) throw new Error('fixtures: payload exceeds PUSH2 range');
  const len = bytes.length.toString(16).padStart(4, '0');
  return `0x61${len}8061000b5f395f${exitOp}${payload.slice(2)}`;
}

// ---------------------------------------------------------------------------
// payload-building helpers
// ---------------------------------------------------------------------------

const U256_MASK = (1n << 256n) - 1n;

/** Canonical 32-byte big-endian word; negative values are two's-complement wrapped. */
export function word(value: bigint): Hex {
  return `0x${(value & U256_MASK).toString(16).padStart(64, '0')}`;
}

export function concatHex(...parts: readonly Hex[]): Hex {
  return `0x${parts.map((p) => p.slice(2)).join('')}`;
}

// ---------------------------------------------------------------------------
// attacker-shaped returners (decode-bounds suite seeds, testing.md §2)
// ---------------------------------------------------------------------------

/**
 * Canned malicious callees. Each one is a complete runtime for `fixture.contracts`; the
 * decode-bounds suite (M7) asserts the script reverts with `EvsDecodeError(site)` — never
 * an exceptional halt — when its STATICCALL target behaves like one of these.
 */
export const ATTACKER_RETURNERS = {
  /** returndatasize == 0 where a return value was promised. */
  empty: returner('0x'),
  /** single dynamic head whose offset points astronomically far (2^255). */
  hugeHeadOffset: returner(word(1n << 255n)),
  /** plausible head offset (32) but an absurd length word (2^200). */
  hugeLength: returner(concatHex(word(32n), word(1n << 200n))),
  /** claims 32 payload bytes at offset 32 but supplies only 31 (off-by-one tail). */
  offByOneTruncation: returner(concatHex(word(32n), word(32n), `0x${'ab'.repeat(31)}`)),
  /** word return with every bit set — dirty high bits for bool/uint8/address decoders. */
  dirtyHighBits: returner(word(-1n)),
  /** static word return truncated to 31 bytes. */
  shortWord: returner(`0x${'00'.repeat(30)}2a`),
} as const;
