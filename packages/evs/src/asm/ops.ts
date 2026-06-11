/**
 * M4 `asm/ops.ts` — the opcode table for everything evs emits, plus the forbidden-byte set.
 *
 * Contract: docs/design/module-interfaces.md §M4 (frozen). Every entry is verified against
 * docs/research/evm-target.md §2 (hex code, stack in/out, fork gating). `since` is relative to
 * the compiler's fork floor (`paris`): everything older than paris is recorded as `'frontier'`
 * (universally available); `PUSH0` is `'shanghai'` (EIP-3855) and `MCOPY` is `'cancun'`
 * (EIP-5656).
 *
 * DUP/SWAP encode their stack *reach* through pops/pushes: `DUPn` requires `n` items
 * (pops n, pushes n+1 — net +1); `SWAPn` requires `n+1` items (pops n+1, pushes n+1 — net 0).
 * That convention lets the stack verifier check both underflow and the 16-item reach with the
 * same numbers.
 */

export type EvmVersion = 'paris' | 'shanghai' | 'cancun';

// prettier-ignore
type PushWidth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18
  | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32;
type StackReach = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

// prettier-ignore
export type Mnemonic = 'STOP' | 'ADD' | 'MUL' | 'SUB' | 'DIV' | 'SDIV' | 'MOD' | 'SMOD'
  | 'ADDMOD' | 'MULMOD' | 'EXP' | 'SIGNEXTEND' | 'LT' | 'GT' | 'SLT' | 'SGT' | 'EQ' | 'ISZERO'
  | 'AND' | 'OR' | 'XOR' | 'NOT' | 'BYTE' | 'SHL' | 'SHR' | 'SAR' | 'KECCAK256' | 'ADDRESS'
  | 'CALLER' | 'CALLVALUE' | 'CALLDATALOAD' | 'CALLDATASIZE' | 'CALLDATACOPY' | 'CODECOPY'
  | 'RETURNDATASIZE' | 'RETURNDATACOPY' | 'TIMESTAMP' | 'NUMBER' | 'CHAINID' | 'POP' | 'MLOAD'
  | 'MSTORE' | 'MSTORE8' | 'JUMP' | 'JUMPI' | 'PC' | 'MSIZE' | 'GAS' | 'JUMPDEST' | 'MCOPY'
  | 'PUSH0' | `PUSH${PushWidth}` | `DUP${StackReach}` | `SWAP${StackReach}`
  | 'STATICCALL' | 'RETURN' | 'REVERT' | 'INVALID';

export interface OpInfo {
  readonly code: number;
  readonly pops: number;
  readonly pushes: number;
  readonly since: EvmVersion | 'frontier';
}

/** Exactly evm-target §2 — codes, stack in/out, and fork gating for every emitted opcode. */
export const OPS: Readonly<Record<Mnemonic, OpInfo>> = Object.freeze({
  STOP: { code: 0x00, pops: 0, pushes: 0, since: 'frontier' },
  ADD: { code: 0x01, pops: 2, pushes: 1, since: 'frontier' },
  MUL: { code: 0x02, pops: 2, pushes: 1, since: 'frontier' },
  SUB: { code: 0x03, pops: 2, pushes: 1, since: 'frontier' },
  DIV: { code: 0x04, pops: 2, pushes: 1, since: 'frontier' },
  SDIV: { code: 0x05, pops: 2, pushes: 1, since: 'frontier' },
  MOD: { code: 0x06, pops: 2, pushes: 1, since: 'frontier' },
  SMOD: { code: 0x07, pops: 2, pushes: 1, since: 'frontier' },
  ADDMOD: { code: 0x08, pops: 3, pushes: 1, since: 'frontier' },
  MULMOD: { code: 0x09, pops: 3, pushes: 1, since: 'frontier' },
  EXP: { code: 0x0a, pops: 2, pushes: 1, since: 'frontier' },
  SIGNEXTEND: { code: 0x0b, pops: 2, pushes: 1, since: 'frontier' },
  LT: { code: 0x10, pops: 2, pushes: 1, since: 'frontier' },
  GT: { code: 0x11, pops: 2, pushes: 1, since: 'frontier' },
  SLT: { code: 0x12, pops: 2, pushes: 1, since: 'frontier' },
  SGT: { code: 0x13, pops: 2, pushes: 1, since: 'frontier' },
  EQ: { code: 0x14, pops: 2, pushes: 1, since: 'frontier' },
  ISZERO: { code: 0x15, pops: 1, pushes: 1, since: 'frontier' },
  AND: { code: 0x16, pops: 2, pushes: 1, since: 'frontier' },
  OR: { code: 0x17, pops: 2, pushes: 1, since: 'frontier' },
  XOR: { code: 0x18, pops: 2, pushes: 1, since: 'frontier' },
  NOT: { code: 0x19, pops: 1, pushes: 1, since: 'frontier' },
  BYTE: { code: 0x1a, pops: 2, pushes: 1, since: 'frontier' },
  SHL: { code: 0x1b, pops: 2, pushes: 1, since: 'frontier' },
  SHR: { code: 0x1c, pops: 2, pushes: 1, since: 'frontier' },
  SAR: { code: 0x1d, pops: 2, pushes: 1, since: 'frontier' },
  KECCAK256: { code: 0x20, pops: 2, pushes: 1, since: 'frontier' },
  ADDRESS: { code: 0x30, pops: 0, pushes: 1, since: 'frontier' },
  CALLER: { code: 0x33, pops: 0, pushes: 1, since: 'frontier' },
  CALLVALUE: { code: 0x34, pops: 0, pushes: 1, since: 'frontier' },
  CALLDATALOAD: { code: 0x35, pops: 1, pushes: 1, since: 'frontier' },
  CALLDATASIZE: { code: 0x36, pops: 0, pushes: 1, since: 'frontier' },
  CALLDATACOPY: { code: 0x37, pops: 3, pushes: 0, since: 'frontier' },
  CODECOPY: { code: 0x39, pops: 3, pushes: 0, since: 'frontier' },
  RETURNDATASIZE: { code: 0x3d, pops: 0, pushes: 1, since: 'frontier' },
  RETURNDATACOPY: { code: 0x3e, pops: 3, pushes: 0, since: 'frontier' },
  TIMESTAMP: { code: 0x42, pops: 0, pushes: 1, since: 'frontier' },
  NUMBER: { code: 0x43, pops: 0, pushes: 1, since: 'frontier' },
  CHAINID: { code: 0x46, pops: 0, pushes: 1, since: 'frontier' },
  POP: { code: 0x50, pops: 1, pushes: 0, since: 'frontier' },
  MLOAD: { code: 0x51, pops: 1, pushes: 1, since: 'frontier' },
  MSTORE: { code: 0x52, pops: 2, pushes: 0, since: 'frontier' },
  MSTORE8: { code: 0x53, pops: 2, pushes: 0, since: 'frontier' },
  JUMP: { code: 0x56, pops: 1, pushes: 0, since: 'frontier' },
  JUMPI: { code: 0x57, pops: 2, pushes: 0, since: 'frontier' },
  PC: { code: 0x58, pops: 0, pushes: 1, since: 'frontier' },
  MSIZE: { code: 0x59, pops: 0, pushes: 1, since: 'frontier' },
  GAS: { code: 0x5a, pops: 0, pushes: 1, since: 'frontier' },
  JUMPDEST: { code: 0x5b, pops: 0, pushes: 0, since: 'frontier' },
  MCOPY: { code: 0x5e, pops: 3, pushes: 0, since: 'cancun' },
  PUSH0: { code: 0x5f, pops: 0, pushes: 1, since: 'shanghai' },
  PUSH1: { code: 0x60, pops: 0, pushes: 1, since: 'frontier' },
  PUSH2: { code: 0x61, pops: 0, pushes: 1, since: 'frontier' },
  PUSH3: { code: 0x62, pops: 0, pushes: 1, since: 'frontier' },
  PUSH4: { code: 0x63, pops: 0, pushes: 1, since: 'frontier' },
  PUSH5: { code: 0x64, pops: 0, pushes: 1, since: 'frontier' },
  PUSH6: { code: 0x65, pops: 0, pushes: 1, since: 'frontier' },
  PUSH7: { code: 0x66, pops: 0, pushes: 1, since: 'frontier' },
  PUSH8: { code: 0x67, pops: 0, pushes: 1, since: 'frontier' },
  PUSH9: { code: 0x68, pops: 0, pushes: 1, since: 'frontier' },
  PUSH10: { code: 0x69, pops: 0, pushes: 1, since: 'frontier' },
  PUSH11: { code: 0x6a, pops: 0, pushes: 1, since: 'frontier' },
  PUSH12: { code: 0x6b, pops: 0, pushes: 1, since: 'frontier' },
  PUSH13: { code: 0x6c, pops: 0, pushes: 1, since: 'frontier' },
  PUSH14: { code: 0x6d, pops: 0, pushes: 1, since: 'frontier' },
  PUSH15: { code: 0x6e, pops: 0, pushes: 1, since: 'frontier' },
  PUSH16: { code: 0x6f, pops: 0, pushes: 1, since: 'frontier' },
  PUSH17: { code: 0x70, pops: 0, pushes: 1, since: 'frontier' },
  PUSH18: { code: 0x71, pops: 0, pushes: 1, since: 'frontier' },
  PUSH19: { code: 0x72, pops: 0, pushes: 1, since: 'frontier' },
  PUSH20: { code: 0x73, pops: 0, pushes: 1, since: 'frontier' },
  PUSH21: { code: 0x74, pops: 0, pushes: 1, since: 'frontier' },
  PUSH22: { code: 0x75, pops: 0, pushes: 1, since: 'frontier' },
  PUSH23: { code: 0x76, pops: 0, pushes: 1, since: 'frontier' },
  PUSH24: { code: 0x77, pops: 0, pushes: 1, since: 'frontier' },
  PUSH25: { code: 0x78, pops: 0, pushes: 1, since: 'frontier' },
  PUSH26: { code: 0x79, pops: 0, pushes: 1, since: 'frontier' },
  PUSH27: { code: 0x7a, pops: 0, pushes: 1, since: 'frontier' },
  PUSH28: { code: 0x7b, pops: 0, pushes: 1, since: 'frontier' },
  PUSH29: { code: 0x7c, pops: 0, pushes: 1, since: 'frontier' },
  PUSH30: { code: 0x7d, pops: 0, pushes: 1, since: 'frontier' },
  PUSH31: { code: 0x7e, pops: 0, pushes: 1, since: 'frontier' },
  PUSH32: { code: 0x7f, pops: 0, pushes: 1, since: 'frontier' },
  DUP1: { code: 0x80, pops: 1, pushes: 2, since: 'frontier' },
  DUP2: { code: 0x81, pops: 2, pushes: 3, since: 'frontier' },
  DUP3: { code: 0x82, pops: 3, pushes: 4, since: 'frontier' },
  DUP4: { code: 0x83, pops: 4, pushes: 5, since: 'frontier' },
  DUP5: { code: 0x84, pops: 5, pushes: 6, since: 'frontier' },
  DUP6: { code: 0x85, pops: 6, pushes: 7, since: 'frontier' },
  DUP7: { code: 0x86, pops: 7, pushes: 8, since: 'frontier' },
  DUP8: { code: 0x87, pops: 8, pushes: 9, since: 'frontier' },
  DUP9: { code: 0x88, pops: 9, pushes: 10, since: 'frontier' },
  DUP10: { code: 0x89, pops: 10, pushes: 11, since: 'frontier' },
  DUP11: { code: 0x8a, pops: 11, pushes: 12, since: 'frontier' },
  DUP12: { code: 0x8b, pops: 12, pushes: 13, since: 'frontier' },
  DUP13: { code: 0x8c, pops: 13, pushes: 14, since: 'frontier' },
  DUP14: { code: 0x8d, pops: 14, pushes: 15, since: 'frontier' },
  DUP15: { code: 0x8e, pops: 15, pushes: 16, since: 'frontier' },
  DUP16: { code: 0x8f, pops: 16, pushes: 17, since: 'frontier' },
  SWAP1: { code: 0x90, pops: 2, pushes: 2, since: 'frontier' },
  SWAP2: { code: 0x91, pops: 3, pushes: 3, since: 'frontier' },
  SWAP3: { code: 0x92, pops: 4, pushes: 4, since: 'frontier' },
  SWAP4: { code: 0x93, pops: 5, pushes: 5, since: 'frontier' },
  SWAP5: { code: 0x94, pops: 6, pushes: 6, since: 'frontier' },
  SWAP6: { code: 0x95, pops: 7, pushes: 7, since: 'frontier' },
  SWAP7: { code: 0x96, pops: 8, pushes: 8, since: 'frontier' },
  SWAP8: { code: 0x97, pops: 9, pushes: 9, since: 'frontier' },
  SWAP9: { code: 0x98, pops: 10, pushes: 10, since: 'frontier' },
  SWAP10: { code: 0x99, pops: 11, pushes: 11, since: 'frontier' },
  SWAP11: { code: 0x9a, pops: 12, pushes: 12, since: 'frontier' },
  SWAP12: { code: 0x9b, pops: 13, pushes: 13, since: 'frontier' },
  SWAP13: { code: 0x9c, pops: 14, pushes: 14, since: 'frontier' },
  SWAP14: { code: 0x9d, pops: 15, pushes: 15, since: 'frontier' },
  SWAP15: { code: 0x9e, pops: 16, pushes: 16, since: 'frontier' },
  SWAP16: { code: 0x9f, pops: 17, pushes: 17, since: 'frontier' },
  STATICCALL: { code: 0xfa, pops: 6, pushes: 1, since: 'frontier' },
  RETURN: { code: 0xf3, pops: 2, pushes: 0, since: 'frontier' },
  REVERT: { code: 0xfd, pops: 2, pushes: 0, since: 'frontier' },
  INVALID: { code: 0xfe, pops: 0, pushes: 0, since: 'frontier' },
} satisfies Record<Mnemonic, OpInfo>);

/**
 * Bytes that must never appear as opcodes in evs output (architecture §10 shape lint):
 * SLOAD, SSTORE, TLOAD, TSTORE, LOG0–LOG4, CREATE, CALL, CALLCODE, DELEGATECALL, CREATE2,
 * SELFDESTRUCT. Scripts are STATICCALL-clean by construction and never read their own storage
 * (SLOAD is allowed nowhere in v0).
 */
export const FORBIDDEN: ReadonlySet<number> = new Set([
  0x54, // SLOAD
  0x55, // SSTORE
  0x5c, // TLOAD
  0x5d, // TSTORE
  0xa0, // LOG0
  0xa1, // LOG1
  0xa2, // LOG2
  0xa3, // LOG3
  0xa4, // LOG4
  0xf0, // CREATE
  0xf1, // CALL
  0xf2, // CALLCODE
  0xf4, // DELEGATECALL
  0xf5, // CREATE2
  0xff, // SELFDESTRUCT
]);
