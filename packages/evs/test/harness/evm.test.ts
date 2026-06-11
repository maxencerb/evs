/**
 * M10 self-tests (module-interfaces §M10): RUNTIME_42 fixture, mock STATICCALL target,
 * gas limit respected — plus byte-exact checks for the three handwritten snippets
 * (PUSH/ADD/RETURN, STATICCALL to a mock, REVERT with payload) and the attacker-shaped
 * returner builders.
 */

import { encodeAbiParameters } from 'viem';
import { describe, expect, test } from 'vitest';

import { CALLER_ADDRESS, DEFAULT_GAS_LIMIT, execRuntime, SCRIPT_ADDRESS } from './evm.js';
import {
  ATTACKER_RETURNERS,
  concatHex,
  returner,
  reverter,
  RUNTIME_42,
  RUNTIME_ECHO,
  RUNTIME_SPIN,
  RUNTIME_STATICCALL,
  RUNTIME_WHOAMI,
  WETH_ADDRESS,
  word,
} from './fixtures.js';

describe('execRuntime — handwritten snippets', () => {
  test('PUSH/ADD/RETURN: 1 + 42 returns uint256(43), byte-exact', async () => {
    // 6001      PUSH1 1
    // 602a      PUSH1 0x2a
    // 01        ADD
    // 6000      PUSH1 0
    // 52        MSTORE          ; mstore(0, 43)
    // 6020      PUSH1 0x20
    // 6000      PUSH1 0
    // f3        RETURN          ; return(0, 32)
    const result = await execRuntime('0x6001602a0160005260206000f3', '0x');
    expect(result.success).toBe(true);
    expect(result.data).toBe(word(43n));
    expect(result.gasUsed).toBeGreaterThan(0n);
    expect(result.gasUsed).toBeLessThan(30_000n);
  });

  test('STATICCALL to a mock target bubbles its returndata byte-exactly', async () => {
    // differential payload: viem's own encoding of ("WETH") as (string)
    const symbolPayload = encodeAbiParameters([{ type: 'string' }], ['WETH']);
    const result = await execRuntime(RUNTIME_STATICCALL, '0x', {
      contracts: { [WETH_ADDRESS]: returner(symbolPayload) },
    });
    expect(result.success).toBe(true);
    expect(result.data).toBe(symbolPayload);
  });

  test('REVERT with payload: success=false, byte-exact payload, no all-gas burn', async () => {
    const result = await execRuntime(reverter('0xdeadbeef'), '0x');
    expect(result.success).toBe(false);
    expect(result.data).toBe('0xdeadbeef');
    // a clean REVERT refunds remaining gas — nowhere near the 30M limit
    expect(result.gasUsed).toBeLessThan(DEFAULT_GAS_LIMIT / 100n);
  });
});

describe('execRuntime — research seed corpus', () => {
  test('RUNTIME_42 returns uint256(42)', async () => {
    const result = await execRuntime(RUNTIME_42, '0x');
    expect(result.success).toBe(true);
    expect(result.data).toBe(word(42n));
  });

  test('RUNTIME_WHOAMI sees the planted script address and the fixed caller', async () => {
    const result = await execRuntime(RUNTIME_WHOAMI, '0x');
    expect(result.success).toBe(true);
    expect(result.data).toBe(concatHex(word(BigInt(SCRIPT_ADDRESS)), word(BigInt(CALLER_ADDRESS))));
  });

  test('RUNTIME_ECHO round-trips calldata byte-exactly', async () => {
    const calldata = concatHex('0x95d89b41', word(7n), word(-1n));
    const result = await execRuntime(RUNTIME_ECHO, calldata);
    expect(result.success).toBe(true);
    expect(result.data).toBe(calldata);
  });
});

describe('execRuntime — gas accounting', () => {
  test('gas limit is respected: a spinner burns exactly the fixture limit and fails', async () => {
    const result = await execRuntime(RUNTIME_SPIN, '0x', { gasLimit: 100_000n });
    expect(result.success).toBe(false);
    expect(result.data).toBe('0x');
    expect(result.gasUsed).toBe(100_000n);
  });

  test('default gas limit is 30M (spinner without fixture burns exactly 30M)', async () => {
    const result = await execRuntime(RUNTIME_SPIN, '0x');
    expect(result.success).toBe(false);
    expect(result.gasUsed).toBe(DEFAULT_GAS_LIMIT);
  });
});

describe('programmable returner fixtures', () => {
  test('returner() returns an arbitrary long payload byte-exactly (PUSH2-length path)', async () => {
    const payload = `0x${'0123456789abcdef'.repeat(64)}` as const; // 512 bytes
    const result = await execRuntime(returner(payload), '0x');
    expect(result.success).toBe(true);
    expect(result.data).toBe(payload);
  });

  test('attacker-shaped returners produce the exact malicious shapes', async () => {
    const cases: readonly [keyof typeof ATTACKER_RETURNERS, `0x${string}`][] = [
      ['empty', '0x'],
      ['hugeHeadOffset', word(1n << 255n)],
      ['hugeLength', concatHex(word(32n), word(1n << 200n))],
      ['offByOneTruncation', concatHex(word(32n), word(32n), `0x${'ab'.repeat(31)}`)],
      ['dirtyHighBits', word(-1n)],
      ['shortWord', `0x${'00'.repeat(30)}2a`],
    ];
    const results = await Promise.all(
      cases.map(
        async ([name, expected]) =>
          [name, expected, await execRuntime(ATTACKER_RETURNERS[name], '0x')] as const,
      ),
    );
    for (const [, expected, result] of results) {
      expect(result.success).toBe(true);
      expect(result.data).toBe(expected);
    }
  });

  test('a reverting STATICCALL target leaves the outer call in control', async () => {
    // the seed STATICCALL fixture POPs the failure flag and bubbles returndata via RETURN,
    // so the outer call still *succeeds* while carrying the callee's revert payload
    const result = await execRuntime(RUNTIME_STATICCALL, '0x', {
      contracts: { [WETH_ADDRESS]: reverter('0x08c379a0') },
    });
    expect(result.success).toBe(true);
    expect(result.data).toBe('0x08c379a0');
  });
});
