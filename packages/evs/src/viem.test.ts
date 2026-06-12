/**
 * M9 unit tests — `viem.ts`: init wrapper bytes goldens (cancun/shanghai/paris), wrapper
 * EXECUTION semantics on the harness (the wrapper RETURNs the runtime byte-exactly), the
 * silent-failure fence (field naming), and both toViem helper shapes.
 */

import { describe, expect, test } from 'vitest';

import { execRuntime } from '../test/harness/evm.js';
import { RUNTIME_42, RUNTIME_WHOAMI } from '../test/harness/fixtures.js';
import { EvsCompileError, EvsTypeError } from './core/errors.js';
import type { Hex } from './core/types.js';
import {
  DEFAULT_SCRIPT_ADDRESS,
  INIT_CODE_PREFIX_SHANGHAI,
  toCreationBytecode,
  toViemDeployless,
  toViemStateOverride,
} from './viem.js';

const ERC20ISH_ABI = [
  {
    type: 'function',
    name: 'main',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'result', type: 'tuple', components: [{ name: 'x', type: 'uint256' }] }],
  },
] as const;

describe('init wrapper bytes (golden — architecture §12)', () => {
  test('INIT_CODE_PREFIX_SHANGHAI is the 10-byte template with RRRR zeroed', () => {
    expect(INIT_CODE_PREFIX_SHANGHAI).toBe('0x61000080600a5f395ff3');
  });

  test('cancun/shanghai: 61 RRRR 80 600A 5F 39 5F F3 ++ runtime', () => {
    // RUNTIME_42 is 10 bytes → RRRR = 0x000a
    const expected: Hex = `0x61000a80600a5f395ff3${RUNTIME_42.slice(2)}`;
    expect(toCreationBytecode(RUNTIME_42, 'cancun')).toBe(expected);
    expect(toCreationBytecode(RUNTIME_42, 'shanghai')).toBe(expected);
  });

  test('paris: 5F → 3D (RETURNDATASIZE-as-zero)', () => {
    expect(toCreationBytecode(RUNTIME_42, 'paris')).toBe(
      `0x61000a80600a3d393df3${RUNTIME_42.slice(2)}`,
    );
  });

  test('RRRR is the big-endian runtime byte length', () => {
    const runtime: Hex = `0x${'00'.repeat(0x1234)}`;
    expect(toCreationBytecode(runtime, 'cancun').slice(0, 22)).toBe('0x61123480600a5f395ff3');
  });

  test('wrapper executes: running the init code RETURNs the runtime byte-exactly', async () => {
    // execRuntime plants the given bytes as code and CALLs them — an init frame's RETURN
    // payload is exactly what a creation eth_call would deploy/return.
    const cases = (['cancun', 'paris'] as const).flatMap((evmVersion) =>
      [RUNTIME_42, RUNTIME_WHOAMI].map((runtime) => ({ evmVersion, runtime })),
    );
    await Promise.all(
      cases.map(async ({ evmVersion, runtime }) => {
        const res = await execRuntime(toCreationBytecode(runtime, evmVersion), '0x');
        expect(res.success).toBe(true);
        expect(res.data).toBe(runtime);
      }),
    );
  });

  test('empty runtime round-trips through the zero-length template', async () => {
    expect(toCreationBytecode('0x', 'shanghai')).toBe(INIT_CODE_PREFIX_SHANGHAI);
    const res = await execRuntime(INIT_CODE_PREFIX_SHANGHAI, '0x');
    expect(res.success).toBe(true);
    expect(res.data).toBe('0x');
  });

  test('rejects malformed hex and PUSH2-range overflow', () => {
    expect(() => toCreationBytecode('0x123' as Hex, 'cancun')).toThrowError(EvsTypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => toCreationBytecode('nope' as Hex, 'cancun')).toThrowError(EvsTypeError);
    expect(() => toCreationBytecode(`0x${'00'.repeat(0x10000)}`, 'cancun')).toThrowError(
      EvsCompileError,
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => toCreationBytecode(RUNTIME_42, 'frontier' as 'paris')).toThrowError(
      EvsCompileError,
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime gate under test
    expect(() => toCreationBytecode(RUNTIME_42, 'frontier' as 'paris')).toThrowError(/evmVersion/);
  });
});

describe('toViem shapes (viem-integration §5)', () => {
  test('DEFAULT_SCRIPT_ADDRESS is the pinned vanity constant', () => {
    expect(DEFAULT_SCRIPT_ADDRESS).toBe('0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530');
  });

  test('deployless: { abi, code } with code = the INIT bytecode (never the runtime)', () => {
    const initBytecode = toCreationBytecode(RUNTIME_42, 'cancun');
    const shape = toViemDeployless({ abi: ERC20ISH_ABI, initBytecode });
    expect(shape).toEqual({ abi: ERC20ISH_ABI, code: initBytecode });
    // the silent-failure fence: no field of the shape carries raw runtime bytecode
    expect(Object.values(shape)).not.toContain(RUNTIME_42);
  });

  test('stateOverride: default address', () => {
    const shape = toViemStateOverride({ abi: ERC20ISH_ABI, runtimeBytecode: RUNTIME_42 });
    expect(shape).toEqual({
      abi: ERC20ISH_ABI,
      address: DEFAULT_SCRIPT_ADDRESS,
      stateOverride: [{ address: DEFAULT_SCRIPT_ADDRESS, code: RUNTIME_42 }],
    });
  });

  test('stateOverride: custom address flows into both the address and the override entry', () => {
    const address = '0x1000000000000000000000000000000000000001' as const;
    const shape = toViemStateOverride(
      { abi: ERC20ISH_ABI, runtimeBytecode: RUNTIME_42 },
      { address },
    );
    expect(shape.address).toBe(address);
    expect(shape.stateOverride).toEqual([{ address, code: RUNTIME_42 }]);
  });
});
