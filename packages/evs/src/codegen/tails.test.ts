/**
 * M7 unit tests — shared tails (`codegen/tails.ts`): panic tail payloads byte-exact per
 * evm-target §5, the `EvsInvalidCalldata()` / `EvsDecodeError(site)` reverts (architecture
 * §11/§15.0), and the pre-cancun `@memcpy` subroutine driven through `emitMemCopy`.
 *
 * Everything assembles with full verification (jumpdests, stack heights, shapes) and runs on
 * the M10 in-process EVM harness.
 */

import { describe, expect, test } from 'vitest';

import { bytesToHex, execRuntime } from '../../test/harness/evm.js';
import { selectorOf } from '../abi/artifact.js';
import { AsmWriter, assemble } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import type { Hex } from '../core/types.js';
import { emitMemCopy, type SharedTails } from './abi.js';
import { createSharedTails, emitDecodeFailStub, emitSharedTails } from './tails.js';

const FORKS: readonly EvmVersion[] = ['paris', 'shanghai', 'cancun'];

const word = (v: bigint): Hex => `0x${(v & ((1n << 256n) - 1n)).toString(16).padStart(64, '0')}`;
const concat = (...parts: readonly Hex[]): Hex => `0x${parts.map((p) => p.slice(2)).join('')}`;

/** A runtime that immediately jumps into the chosen shared tail. */
function tailRuntime(pick: Exclude<keyof SharedTails, 'memcpy'>, evmVersion: EvmVersion): Hex {
  const w = new AsmWriter();
  const tails = createSharedTails(w, { evmVersion });
  w.pushLabel(tails[pick]);
  w.op('JUMP');
  emitSharedTails(w, tails, { evmVersion });
  return bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode);
}

describe('panic tails (architecture §15.0)', () => {
  const PANIC_SELECTOR: Hex = '0x4e487b71';
  const CASES = [
    ['panicOverflow', 0x11n],
    ['panicDivZero', 0x12n],
    ['panicBounds', 0x32n],
    ['panicAlloc', 0x41n],
  ] as const;

  for (const evmVersion of FORKS) {
    for (const [pick, code] of CASES) {
      test(`${pick} reverts Panic(0x${code.toString(16)}) on ${evmVersion}`, async () => {
        const res = await execRuntime(tailRuntime(pick, evmVersion), '0x');
        expect(res.success).toBe(false);
        expect(res.data).toBe(concat(PANIC_SELECTOR, word(code)));
        expect(res.data.length).toBe(2 + 2 * 36); // 36-byte payload exactly
      });
    }
  }
});

describe('EvsInvalidCalldata tail (architecture §11)', () => {
  for (const evmVersion of FORKS) {
    test(`reverts with the bare 4-byte selector on ${evmVersion}`, async () => {
      const res = await execRuntime(tailRuntime('invalidCalldata', evmVersion), '0x');
      expect(res.success).toBe(false);
      expect(res.data).toBe(selectorOf('EvsInvalidCalldata', []));
    });
  }
});

describe('decode-fail stubs → EvsDecodeError(site) tail', () => {
  for (const evmVersion of FORKS) {
    test(`site id round-trips through @dfail → @decode_revert on ${evmVersion}`, async () => {
      const w = new AsmWriter();
      const tails = createSharedTails(w, { evmVersion });
      const dfail = w.newLabel('dfail_test');
      w.pushLabel(dfail);
      w.op('JUMP');
      emitDecodeFailStub(w, dfail, 1234, tails);
      emitSharedTails(w, tails, { evmVersion });
      const runtime = bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode);

      const res = await execRuntime(runtime, '0x');
      expect(res.success).toBe(false);
      expect(res.data).toBe(concat(selectorOf('EvsDecodeError', ['uint256']), word(1234n)));
    });
  }

  test('stub entered with caller garbage on the stack still reverts cleanly', async () => {
    // strict-mode dfail edges arrive at arbitrary heights — the 'any' class in action
    const evmVersion: EvmVersion = 'cancun';
    const w = new AsmWriter();
    const tails = createSharedTails(w, { evmVersion });
    const dfail = w.newLabel('dfail_test');
    w.push(0xdead);
    w.push(0xbeef);
    w.push(0x42); // three garbage items
    w.pushLabel(dfail);
    w.op('JUMP');
    emitDecodeFailStub(w, dfail, 7, tails);
    emitSharedTails(w, tails, { evmVersion });
    const runtime = bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode);

    const res = await execRuntime(runtime, '0x');
    expect(res.success).toBe(false);
    expect(res.data).toBe(concat(selectorOf('EvsDecodeError', ['uint256']), word(7n)));
  });
});

/** Copies `len` bytes from three pattern words at 0x80 to 0x100, returns mem[0x100..0x160). */
function copyRuntime(len: number, evmVersion: EvmVersion): Hex {
  const w = new AsmWriter();
  w.push(0x200);
  w.push(0x40);
  w.op('MSTORE');
  const tails = createSharedTails(w, { evmVersion });
  w.push(BigInt(`0x${'11'.repeat(32)}`));
  w.push(0x80);
  w.op('MSTORE');
  w.push(BigInt(`0x${'22'.repeat(32)}`));
  w.push(0xa0);
  w.op('MSTORE');
  w.push(BigInt(`0x${'33'.repeat(32)}`));
  w.push(0xc0);
  w.op('MSTORE');
  w.push(len); // [len]
  w.push(0x80); // [src, len]
  w.push(0x100); // [dst, src, len]
  emitMemCopy(w, tails, { evmVersion });
  w.push(0x60); // size 96
  w.push(0x100); // offset
  w.op('RETURN');
  emitSharedTails(w, tails, { evmVersion });
  return bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode);
}

describe('memcpy lowering (architecture §10)', () => {
  test('createSharedTails allocates @memcpy only before cancun', () => {
    const w = new AsmWriter();
    expect(createSharedTails(w, { evmVersion: 'cancun' }).memcpy).toBeNull();
    expect(createSharedTails(w, { evmVersion: 'shanghai' }).memcpy).not.toBeNull();
    expect(createSharedTails(w, { evmVersion: 'paris' }).memcpy).not.toBeNull();
  });

  test('pre-cancun word loop copies whole words (documented over-copy)', async () => {
    const results = await Promise.all(
      (['paris', 'shanghai'] as const).map((evmVersion) =>
        execRuntime(copyRuntime(65, evmVersion), '0x'),
      ),
    );
    for (const res of results) {
      expect(res.success).toBe(true);
      // 65 bytes requested → 96 copied (3 words)
      expect(res.data).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}${'33'.repeat(32)}`);
    }
  });

  test('cancun MCOPY copies byte-exact', async () => {
    const res = await execRuntime(copyRuntime(65, 'cancun'), '0x');
    expect(res.success).toBe(true);
    expect(res.data).toBe(`0x${'11'.repeat(32)}${'22'.repeat(32)}33${'00'.repeat(31)}`);
  });

  test('zero-length copy is a no-op on every fork', async () => {
    const results = await Promise.all(
      FORKS.map((evmVersion) => execRuntime(copyRuntime(0, evmVersion), '0x')),
    );
    for (const res of results) {
      expect(res.success).toBe(true);
      expect(res.data).toBe(`0x${'00'.repeat(96)}`);
    }
  });

  test('two call sites share one subroutine (return labels are per-site)', async () => {
    const evmVersion: EvmVersion = 'shanghai';
    const w = new AsmWriter();
    w.push(0x200);
    w.push(0x40);
    w.op('MSTORE');
    const tails = createSharedTails(w, { evmVersion });
    w.push(BigInt(`0x${'ab'.repeat(32)}`));
    w.push(0x80);
    w.op('MSTORE');
    // copy 0x80 → 0x100, then 0x100 → 0x140
    w.push(32);
    w.push(0x80);
    w.push(0x100);
    emitMemCopy(w, tails, { evmVersion });
    w.push(32);
    w.push(0x100);
    w.push(0x140);
    emitMemCopy(w, tails, { evmVersion });
    w.push(0x20);
    w.push(0x140);
    w.op('RETURN');
    emitSharedTails(w, tails, { evmVersion });
    const res = await execRuntime(bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode), '0x');
    expect(res.success).toBe(true);
    expect(res.data).toBe(`0x${'ab'.repeat(32)}`);
  });
});
