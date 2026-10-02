/**
 * Unit tests — shared tails (`codegen/tails.ts`): panic tail payloads byte-exact per solc's
 * `Panic(uint256)` encoding, the `EvsInvalidCalldata()` / `EvsDecodeError(site)` reverts, and
 * the pre-cancun `@memcpy` subroutine driven through `emitMemCopy`, and tail elision (only
 * referenced tails are emitted — issue #73), including the rounding-specialized `@muldiv`.
 *
 * Everything assembles with full verification (jumpdests, stack heights, shapes) and runs on
 * the in-process EVM harness (test/harness/evm.ts).
 */

import { encodeErrorResult, encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { bytesToHex, execRuntime } from '../../test/harness/evm.js';
import { selectorOf } from '../abi/artifact.js';
import { AsmWriter, assemble } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type Hex } from '../core/types.js';
import { emitMemCopy, type SharedTails } from './abi.js';
import { createSharedTails, emitDecodeFailStub, emitSharedTails } from './tails.js';

const FORKS: readonly EvmVersion[] = ['paris', 'shanghai', 'cancun'];

const word = (v: bigint): Hex => `0x${(v & ((1n << 256n) - 1n)).toString(16).padStart(64, '0')}`;
const concat = (...parts: readonly Hex[]): Hex => `0x${parts.map((p) => p.slice(2)).join('')}`;

/** A runtime that immediately jumps into the chosen shared tail. */
function tailRuntime(
  pick: Exclude<keyof SharedTails, 'memcpy' | 'mulDiv'>,
  evmVersion: EvmVersion,
): Hex {
  const w = new AsmWriter();
  const tails = createSharedTails(w, { evmVersion });
  w.pushLabel(tails[pick]);
  w.op('JUMP');
  emitSharedTails(w, tails);
  return bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode);
}

describe('panic tails', () => {
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

describe('EvsInvalidCalldata tail', () => {
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
      emitSharedTails(w, tails);
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
    emitSharedTails(w, tails);
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
  emitSharedTails(w, tails);
  return bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode);
}

describe('memcpy lowering', () => {
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

  test('pre-cancun word loop copies ceil32(len) bytes for every length up to 3 words', async () => {
    const pattern = ['11', '22', '33'].map((b) => b.repeat(32));
    const runs = (['paris', 'shanghai'] as const).flatMap((evmVersion) =>
      Array.from({ length: 97 }, (_, len) => ({ evmVersion, len })),
    );
    const results = await Promise.all(
      runs.map(({ evmVersion, len }) => execRuntime(copyRuntime(len, evmVersion), '0x')),
    );
    results.forEach((res, i) => {
      const words = Math.ceil((runs[i]?.len ?? 0) / 32);
      expect(res.success).toBe(true);
      expect(res.data).toBe(
        `0x${pattern.slice(0, words).join('')}${'00'.repeat(32 * (3 - words))}`,
      );
    });
  });

  test('pre-cancun word loop costs 67 gas per word (one shared byte offset)', async () => {
    // every copy lands inside the region RETURN expands anyway, so the gas difference between
    // n and n−1 words (0 words included: the setup is shared) is exactly one loop iteration.
    // paris only: the runtime's own `PUSH len` is then PUSH1 for every length (shanghai would
    // push a 0 length with the cheaper PUSH0); the loop itself is the same on both forks.
    const gas = await Promise.all(
      [0, 32, 64, 96].map(
        async (len) => (await execRuntime(copyRuntime(len, 'paris'), '0x')).gasUsed,
      ),
    );
    expect(gas.slice(1).map((g, i) => g - (gas[i] ?? 0n))).toEqual([67n, 67n, 67n]);
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
    emitSharedTails(w, tails);
    const res = await execRuntime(bytesToHex(assemble(w.nodes(), { evmVersion }).bytecode), '0x');
    expect(res.success).toBe(true);
    expect(res.data).toBe(`0x${'ab'.repeat(32)}`);
  });
});

// ---------------------------------------------------------------------------
// tail elision (issue #73): only referenced tails are emitted
// ---------------------------------------------------------------------------

const ALL_TAILS = [
  'panic_overflow',
  'panic_divzero',
  'panic_bounds',
  'panic_alloc',
  'panic',
  'decode_revert',
  'badcd',
  'memcpy',
] as const;
type TailName = (typeof ALL_TAILS)[number];

/** The shared-tail labels placed in a compiled script's runtime. */
function placedTails(art: { disassemble(): { format(): string } }): Set<TailName> {
  const lines = art.disassemble().format().split('\n');
  return new Set(ALL_TAILS.filter((name) => lines.includes(`@${name}:`)));
}

const addScript = () =>
  evscript({ name: 'add', args: [t.uint256, t.uint256] }, (s, a, b) => s.return({ sum: a.add(b) }));

describe('tail elision (issue #73)', () => {
  test('emitSharedTails emits nothing when no tail is referenced', () => {
    for (const evmVersion of FORKS) {
      const w = new AsmWriter();
      expect(emitSharedTails(w, createSharedTails(w, { evmVersion }))).toBeNull();
      expect(w.nodes()).toEqual([]);
    }
  });

  test('emitSharedTails emits only the referenced stub + the @panic core', () => {
    const w = new AsmWriter();
    const tails = createSharedTails(w, { evmVersion: 'cancun' });
    w.pushLabel(tails.panicBounds);
    w.op('JUMP');
    expect(emitSharedTails(w, tails)).toBe(tails.panicBounds); // the first tail placed
    const names = w
      .nodes()
      .flatMap((n) => (n.k === 'label' && n.name !== undefined ? [n.name] : []));
    expect(names).toEqual(['panic_bounds', 'panic']);
  });

  test('@muldiv is emitted only with a rounding, in that rounding, before @panic_overflow', () => {
    const tailNames = (rounding: 'floor' | 'up' | 'mixed' | null) => {
      const w = new AsmWriter();
      const tails = createSharedTails(w, { evmVersion: 'cancun' });
      w.pushLabel(tails.mulDiv);
      w.op('JUMP');
      expect(emitSharedTails(w, tails, rounding)).toBe(tails.mulDiv);
      return w.nodes().flatMap((n) => (n.k === 'label' && n.name !== undefined ? [n.name] : []));
    };
    // only the mixed subroutine tests a rounding flag (its exit label)
    expect(tailNames('floor')).toEqual([
      'muldiv',
      'muldiv_full',
      'muldiv_done',
      'panic_overflow',
      'panic',
    ]);
    expect(tailNames('up')).toEqual([
      'muldiv',
      'muldiv_full',
      'muldiv_done',
      'panic_overflow',
      'panic',
    ]);
    expect(tailNames('mixed')).toEqual([
      'muldiv',
      'muldiv_full',
      'muldiv_done',
      'muldiv_exit',
      'panic_overflow',
      'panic',
    ]);
    // the sites' calling convention depends on the rounding: a referenced @muldiv without one
    // is a lowering bug, not a default
    expect(() => tailNames(null)).toThrow(/@muldiv is referenced but no rounding was given/);
  });

  for (const optimize of [false, true]) {
    test(`add: only @panic_overflow + @panic + @badcd are emitted (optimize: ${optimize})`, () => {
      for (const evmVersion of FORKS) {
        expect(placedTails(compile(addScript(), { evmVersion, optimize }))).toEqual(
          new Set(['panic_overflow', 'panic', 'badcd']),
        );
      }
    });
  }

  test('add: overflow still reverts Panic(0x11) and explainRevert works without the other tails', async () => {
    const art = compile(addScript());
    const calldata = encodeFunctionData({
      abi: art.abi,
      functionName: 'add',
      args: [maxUint256, 1n],
    });
    const res = await execRuntime(art.runtimeBytecode, calldata);
    expect(res.success).toBe(false);
    const panic = art.explainRevert(res.data);
    expect(panic.kind).toBe('panic');
    expect(panic.panicCode).toBe(0x11n);
    // a payload whose tail is absent from this script still explains (bubbled-callee wording)
    const divzero = art.explainRevert(
      encodeErrorResult({
        abi: [{ type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }],
        errorName: 'Panic',
        args: [0x12n],
      }),
    );
    expect(divzero.kind).toBe('panic');
    expect(divzero.candidateSites).toEqual([]);
    const decode = art.explainRevert(
      encodeErrorResult({
        abi: [
          { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
        ],
        errorName: 'EvsDecodeError',
        args: [0n],
      }),
    );
    expect(decode.kind).toBe('evs-decode');
    // and a bad-calldata call still hits the (referenced) @badcd tail
    const bad = await execRuntime(art.runtimeBytecode, '0x01');
    expect(bad.data).toBe(selectorOf('EvsInvalidCalldata', []));
  });

  test('a tail-free script (no checked arithmetic) carries no panic tails at all', () => {
    const id = evscript({ name: 'id', args: [t.address] }, (s, a) => s.return({ a }));
    expect(placedTails(compile(id))).toEqual(new Set(['badcd']));
  });

  test('each tail is emitted once something references it', async () => {
    const div = evscript({ name: 'div', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ q: a.div(b) }),
    );
    expect(placedTails(compile(div))).toContain('panic_divzero');
    expect(placedTails(compile(div))).toContain('panic');
    const divArt = compile(div);
    const res = await execRuntime(
      divArt.runtimeBytecode,
      encodeFunctionData({ abi: divArt.abi, functionName: 'div', args: [1n, 0n] }),
    );
    expect(res.success).toBe(false);
    expect(res.data).toBe(concat('0x4e487b71', word(0x12n)));

    const at = evscript({ name: 'at', args: [t.array(t.uint256), t.uint256] }, (s, xs, i) =>
      s.return({ x: xs.at(i) }),
    );
    expect(placedTails(compile(at))).toContain('panic_bounds');

    const alloc = evscript({ name: 'alloc', args: [t.uint256] }, (s, n) => {
      const out = s.newArray(t.uint256, n);
      return s.return({ out: out.expr() });
    });
    expect(placedTails(compile(alloc))).toContain('panic_alloc');

    // strict s.read → per-site @dfail stub → @decode_revert; pre-cancun string copy → @memcpy
    const sym = evscript({ name: 'sym', args: [t.address] }, (s, token) =>
      s.return({ symbol: s.read({ address: token, abi: erc20Abi, functionName: 'symbol' }) }),
    );
    expect(placedTails(compile(sym))).toContain('decode_revert');
    expect(placedTails(compile(sym, { evmVersion: 'shanghai' }))).toContain('memcpy');
    expect(placedTails(compile(sym, { evmVersion: 'cancun' }))).not.toContain('memcpy');
    // … and a script without memory copies drops @memcpy even pre-cancun
    expect(placedTails(compile(addScript(), { evmVersion: 'paris' }))).not.toContain('memcpy');
  });
});
