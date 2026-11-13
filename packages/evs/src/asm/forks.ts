/**
 * `asm/forks.ts` — the supported forks and their order.
 *
 * Apart from the opcode table (`asm/ops.ts`, which re-exports everything here) on purpose: the
 * compiler-free runtime entry (`runtime.ts`) checks an `evmVersion` and builds the init wrapper
 * with these facts alone, and a client bundle that imported them from the table's module would
 * keep the whole frozen table. It has no imports, so anything can use it.
 */

/** Every supported `evmVersion`, oldest first (the order `forkAtLeast` ranks by). */
export const EVM_VERSIONS = ['paris', 'shanghai', 'cancun'] as const;

export type EvmVersion = (typeof EVM_VERSIONS)[number];

/** Narrows an unchecked string (a JS caller's option) to a supported fork. */
export function isEvmVersion(value: string): value is EvmVersion {
  return (EVM_VERSIONS as readonly string[]).includes(value);
}

/**
 * Whether `evmVersion` includes everything introduced at `since`. `'frontier'` stands for any
 * fork older than the `paris` floor, so it is always available.
 */
export function forkAtLeast(evmVersion: EvmVersion, since: EvmVersion | 'frontier'): boolean {
  return since === 'frontier' || EVM_VERSIONS.indexOf(evmVersion) >= EVM_VERSIONS.indexOf(since);
}

/**
 * The fork that introduced `PUSH0` (EIP-3855): the `since` of its `OPS` entry, named here so the
 * init wrapper (`viem.ts`) gates on it without a reference to the opcode table.
 */
export const PUSH0_FORK: EvmVersion = 'shanghai';
