/**
 * Unit tests — `codegen/memory.ts`: the `emitAlloc` bump allocator (constant and on-stack sizes,
 * with and without the zero-fill, over deliberately dirtied memory) and which typed zero values
 * still zero-fill their block. A block whose every word the emitter writes itself (all-memref
 * tuple members, memref fixed-array slots) carries no CALLDATACOPY; one with a word slot keeps it.
 *
 * Runtimes assemble with full verification and run on the in-process EVM harness
 * (test/harness/evm.ts).
 */

import { describe, expect, test } from 'vite-plus/test';

import { bytesToHex, execRuntime } from '../../test/harness/evm.js';
import { AsmWriter, assemble } from '../asm/assembler.js';
import { t, type EvsType, type Hex } from '../core/types.js';
import { FREE_PTR, emitAlloc, emitZeroValue } from './memory.js';

const BASE = 0x200;
const ONES = 'ff'.repeat(32);

/**
 * Sets the free pointer to `BASE`, dirties the 4 words above it with `2^256 − 1`, runs
 * `emitAlloc`, and returns `mem[0..0x40) = [ptr, freePtr]` followed by `mem[BASE..BASE+0x80)`.
 */
async function allocOverDirt(size: number | 'onStack', bytes: number, zeroFill: boolean) {
  const w = new AsmWriter();
  w.push(BASE);
  w.push(FREE_PTR);
  w.op('MSTORE');
  for (let i = 0; i < 4; i++) {
    w.push(0);
    w.op('NOT');
    w.push(BASE + 32 * i);
    w.op('MSTORE');
  }
  if (size === 'onStack') w.push(bytes); // [size]
  emitAlloc(w, size, { zeroFill }); // [ptr]
  w.push(0);
  w.op('MSTORE'); // mem[0] = ptr
  w.push(FREE_PTR);
  w.op('MLOAD');
  w.push(0x20);
  w.op('MSTORE'); // mem[0x20] = freePtr
  // copy mem[BASE..BASE+0x80) to 0x40 so the returndata is one contiguous range
  for (let i = 0; i < 4; i++) {
    w.push(BASE + 32 * i);
    w.op('MLOAD');
    w.push(0x40 + 32 * i);
    w.op('MSTORE');
  }
  w.push(0xc0);
  w.push(0);
  w.op('RETURN');
  const res = await execRuntime(
    bytesToHex(assemble(w.nodes(), { evmVersion: 'cancun' }).bytecode),
    '0x',
  );
  expect(res.success).toBe(true);
  const words = res.data.slice(2).match(/.{64}/g) ?? [];
  return {
    ptr: BigInt(`0x${words[0]}`),
    freePtr: BigInt(`0x${words[1]}`),
    block: words.slice(2),
  };
}

describe('emitAlloc', () => {
  for (const size of [64, 'onStack'] as const) {
    test(`${size === 'onStack' ? 'on-stack' : 'constant'} size: bumps the free pointer, zero-fills on request`, async () => {
      const filled = await allocOverDirt(size, 64, true);
      expect(filled.ptr).toBe(BigInt(BASE));
      expect(filled.freePtr).toBe(BigInt(BASE + 64));
      // exactly [ptr, ptr+64) is zeroed; the dirty word past the block is untouched
      expect(filled.block).toEqual(['0'.repeat(64), '0'.repeat(64), ONES, ONES]);

      const raw = await allocOverDirt(size, 64, false);
      expect(raw.ptr).toBe(BigInt(BASE));
      expect(raw.freePtr).toBe(BigInt(BASE + 64));
      expect(raw.block).toEqual([ONES, ONES, ONES, ONES]);
    });
  }
});

/** CALLDATACOPY ops (the zero-fill) in the code `emitZeroValue(type)` emits. */
function zeroFills(type: EvsType): number {
  const w = new AsmWriter();
  emitZeroValue(w, type, 0);
  return w.nodes().filter((n) => n.k === 'op' && n.op === 'CALLDATACOPY').length;
}

describe('typed zero values zero-fill only blocks with a word slot', () => {
  const cases: readonly [label: string, type: EvsType, fills: number][] = [
    ['word', 'uint256', 0],
    ['string (the zero slot)', 'string', 0],
    ['tuple(uint256,address)', t.struct({ a: t.uint256, b: t.address }), 1],
    ['tuple(uint256,string)', t.struct({ a: t.uint256, s: t.string }), 1],
    [
      'tuple(string,bytes,uint256[])',
      t.struct({ s: t.string, b: t.bytes, xs: t.array(t.uint256) }),
      0,
    ],
    ['tuple(tuple(string))', t.struct({ inner: t.struct({ s: t.string }) }), 0],
    ['tuple(tuple(uint8))', t.struct({ inner: t.struct({ x: t.uint8 }) }), 1],
    ['uint256[3]', t.array(t.uint256, 3), 1],
    ['string[2]', t.array(t.string, 2), 0],
    ['tuple(uint8)[2]', t.array(t.struct({ x: t.uint8 }), 2), 1],
  ];
  for (const [label, type, fills] of cases) {
    test(`${label}: ${fills} zero-fill(s)`, () => {
      expect(zeroFills(type)).toBe(fills);
    });
  }
});

/** Words above the free pointer {@link zeroWordsOverDirt} dirties with `2^256 − 1`. */
const DIRT_WORDS = 16;

/**
 * Sets the free pointer to `BASE`, dirties the memory above it, runs `emitZeroValue(type)` and
 * returns the `words` raw memory words starting at the zero value's pointer.
 */
async function zeroWordsOverDirt(type: EvsType, words: number): Promise<Hex[]> {
  const w = new AsmWriter();
  w.push(BASE);
  w.push(FREE_PTR);
  w.op('MSTORE');
  for (let i = 0; i < DIRT_WORDS; i++) {
    w.push(0);
    w.op('NOT');
    w.push(BASE + 32 * i);
    w.op('MSTORE');
  }
  emitZeroValue(w, type, 0); // [ptr]
  for (let i = 0; i < words; i++) {
    w.op('DUP1');
    if (i > 0) {
      w.push(32 * i);
      w.op('ADD');
    }
    w.op('MLOAD');
    w.push(32 * i);
    w.op('MSTORE');
  }
  w.op('POP');
  w.push(32 * words);
  w.push(0);
  w.op('RETURN');
  const res = await execRuntime(
    bytesToHex(assemble(w.nodes(), { evmVersion: 'cancun' }).bytecode),
    '0x',
  );
  expect(res.success).toBe(true);
  return (res.data.slice(2).match(/.{64}/g) ?? []).map((x): Hex => `0x${x}`);
}

describe('typed zero values over dirty memory', () => {
  const ZERO_SLOT: Hex = `0x${'0'.repeat(62)}60`;
  const at = (v: number): Hex => `0x${v.toString(16).padStart(64, '0')}`;

  test('an all-memref tuple: every slot points at the zero slot (no fill needed)', async () => {
    const type = t.struct({ s: t.string, b: t.bytes, xs: t.array(t.uint256) });
    expect(await zeroWordsOverDirt(type, 3)).toEqual([ZERO_SLOT, ZERO_SLOT, ZERO_SLOT]);
  });

  test('a mixed tuple: the word member is zero-filled, the memref member is the zero slot', async () => {
    const type = t.struct({ a: t.uint256, s: t.string });
    expect(await zeroWordsOverDirt(type, 2)).toEqual([at(0), ZERO_SLOT]);
  });

  test('string[2]: length 2, both slots the zero slot (no fill needed)', async () => {
    expect(await zeroWordsOverDirt(t.array(t.string, 2), 3)).toEqual([at(2), ZERO_SLOT, ZERO_SLOT]);
  });

  test('uint256[2]: length 2, both slots zero-filled', async () => {
    expect(await zeroWordsOverDirt(t.array(t.uint256, 2), 3)).toEqual([at(2), at(0), at(0)]);
  });

  test('tuple(string)[2]: each slot a fresh block past the array, pointing at the zero slot', async () => {
    // [len][slot0][slot1] at BASE, then the two one-word element blocks (allocated by the
    // fill loop, which walks the slots down: slot1 gets the first block)
    expect(await zeroWordsOverDirt(t.array(t.struct({ s: t.string }), 2), 5)).toEqual([
      at(2),
      at(BASE + 128),
      at(BASE + 96),
      ZERO_SLOT,
      ZERO_SLOT,
    ]);
  });
});
