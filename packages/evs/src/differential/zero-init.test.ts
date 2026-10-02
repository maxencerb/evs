/**
 * Differential suite — typed zero values of composite slots (issue #71).
 *
 * `s.newArray` elements that are never set and `s.tuple` members that are omitted must read as
 * their typed zero on the EVM exactly as in the interpreter's `zeroValue`: an empty
 * string/bytes/`T[]`, and a fresh zeroed block per nested tuple (never pointer `0x00`, the
 * scratch word). Every shape writes scratch (`s.keccak256`) between the allocation and the read,
 * so an aliased scratch pointer would surface as garbage. Also: all-zero and mostly-zero literals,
 * lowered as a zero-filled allocation instead of a data segment, read as their value over dirty
 * memory. Runner: `test/harness/differential.ts`.
 */

import { type Abi, decodeFunctionResult, encodeAbiParameters, getAddress } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  DEAD,
  EVM_VERSIONS,
  expectAgreement,
  POOL,
  USER,
} from '../../test/harness/differential.js';
import { concatHex, word } from '../../test/harness/fixtures.js';
import { evscript } from '../builder/script.js';
import { t } from '../core/types.js';

const Position = t.struct({ liquidity: t.uint128, owner: t.address });
const Inner = t.struct({ a: t.uint256, label: t.string });
const Rich = t.struct({
  n: t.uint256,
  s: t.string,
  b: t.bytes,
  xs: t.array(t.uint256),
  inner: Inner,
});

/** Decodes the single-case returndata of `script` with its own ABI. */
function decode(script: { abi: Abi; name: string }, data: `0x${string}` | undefined): unknown {
  return decodeFunctionResult({ abi: script.abi, functionName: script.name, data: data ?? '0x' });
}

const ZERO_INNER = { a: 0n, label: '' };
const ZERO_RICH = { n: 0n, s: '', b: '0x', xs: [], inner: ZERO_INNER };

describe.each(EVM_VERSIONS)('composite zero values (issue #71) [%s]', (evmVersion) => {
  // The reference/builder.mdx example, verbatim: fill a tuple[] in place via get(i).
  const positions = evscript({ name: 'positions', args: [t.address, t.uint256] }, (s, owner, n) => {
    const out = s.newArray(Position, n); // zero-filled tuple[n] (array of pointers)
    s.for({ type: t.uint256, from: 0n, until: n }, (i) => {
      const el = out.get(i); // Tuple handle into slot i
      el.liquidity.set(i.toUint(t.uint128));
      el.owner.set(owner);
    });
    return s.return({ positions: out.expr() }); // readonly { liquidity; owner }[]
  });

  test('docs example: fill a tuple[] in place via get(i)', async () => {
    const [, three] = await expectAgreement(
      positions,
      [
        [USER, 0n],
        [USER, 3n],
      ],
      {},
      evmVersion,
    );
    const owner = getAddress(USER);
    expect(decode(positions, three?.data)).toEqual({
      positions: [
        { liquidity: 0n, owner },
        { liquidity: 1n, owner },
        { liquidity: 2n, owner },
      ],
    });
  });

  test('unset tuple[] elements: read, field-set, no aliasing across elements', async () => {
    const script = evscript({ name: 'unsetTuples', args: [t.uint256] }, (s, x) => {
      const arr = s.newArray(Rich, 3n);
      const h = s.keccak256(x, x); // scratch write between allocation and reads
      const e0 = arr.get(0n);
      const before = e0.inner.get().a.get();
      const sLen = e0.s.get().length();
      const xsLen = e0.xs.get().length();
      arr.get(1n).n.set(x);
      arr.get(1n).inner.get().a.set(x);
      return s.return({
        h,
        before,
        sLen,
        xsLen,
        n0: e0.n.get(), // element 1's set must not leak into element 0
        a0: e0.inner.get().a.get(),
        n2: arr.get(2n).n.get(),
        a2: arr.get(2n).inner.get().a.get(),
        arr: arr.expr(),
      });
    });
    const [o] = await expectAgreement(script, [[7n]], {}, evmVersion);
    expect(decode(script, o?.data)).toMatchObject({
      before: 0n,
      sLen: 0n,
      xsLen: 0n,
      n0: 0n,
      a0: 0n,
      n2: 0n,
      a2: 0n,
      arr: [ZERO_RICH, { ...ZERO_RICH, n: 7n, inner: { a: 7n, label: '' } }, ZERO_RICH],
    });
  });

  test('unset string[] / bytes[] / uint256[][] elements are empty', async () => {
    const script = evscript({ name: 'unsetMemrefs', args: [t.uint256] }, (s, n) => {
      const strs = s.newArray(t.string, n);
      const bys = s.newArray(t.bytes, n);
      const arrs = s.newArray(t.array(t.uint256), n);
      const h = s.keccak256(n, n);
      return s.return({
        h,
        strLen: strs.get(0n).length(),
        bytesLen: bys.get(0n).length(),
        arrLen: arrs.get(0n).length(),
        strs: strs.expr(),
        bys: bys.expr(),
        arrs: arrs.expr(),
      });
    });
    const [o] = await expectAgreement(script, [[2n]], {}, evmVersion);
    expect(decode(script, o?.data)).toMatchObject({
      strLen: 0n,
      bytesLen: 0n,
      arrLen: 0n,
      strs: ['', ''],
      bys: ['0x', '0x'],
      arrs: [[], []],
    });
    // n = 0: the zeroing loop runs zero times
    const empty = evscript({ name: 'unsetMemrefsEmpty', args: [t.uint256] }, (s, n) =>
      s.return({ strs: s.newArray(t.string, n), tup: s.newArray(Rich, n) }),
    );
    await expectAgreement(empty, [[0n], [1n], [4n]], {}, evmVersion);
  });

  test('s.tuple: omitted string / bytes / array / nested struct members are zero', async () => {
    const script = evscript({ name: 'omitted', args: [t.uint256] }, (s, n) => {
      const v = s.tuple(Rich, { n });
      const w = s.tuple(Rich, { n });
      const h = s.keccak256(n, n);
      w.inner.get().a.set(n); // w's fresh nested block must not alias v's
      return s.return({
        h,
        sLen: v.s.get().length(),
        xsLen: v.xs.get().length(),
        innerA: v.inner.get().a.get(),
        labelLen: v.inner.get().label.get().length(),
        v: v.expr(),
        w: w.expr(),
      });
    });
    const [o] = await expectAgreement(script, [[7n]], {}, evmVersion);
    expect(decode(script, o?.data)).toMatchObject({
      sLen: 0n,
      xsLen: 0n,
      innerA: 0n,
      labelLen: 0n,
      v: { ...ZERO_RICH, n: 7n },
      w: { ...ZERO_RICH, n: 7n, inner: { a: 7n, label: '' } },
    });
  });

  test('s.tuple: the issue repros (omitted members, nested struct) and partial nested inits', async () => {
    const S = t.struct({ n: t.uint256, s: t.string, xs: t.array(t.uint256) });
    const Outer = t.struct({ inner: t.struct({ a: t.uint256 }), x: t.uint256 });
    const script = evscript({ name: 'repros', args: [t.uint256] }, (s, x) => {
      const v = s.tuple(S, { n: x });
      const o = s.tuple(Outer, { x });
      const p = s.tuple(Rich, { inner: s.tuple(Inner, { a: 0n }), n: 0n }); // literal-0 words
      const q = s.tuple(Rich); // no init at all
      const h = s.keccak256(x, x);
      return s.return({ h, v: v.expr(), o: o.expr(), p: p.expr(), q: q.expr() });
    });
    const [o] = await expectAgreement(script, [[9n]], {}, evmVersion);
    expect(decode(script, o?.data)).toMatchObject({
      v: { n: 9n, s: '', xs: [] },
      o: { inner: { a: 0n }, x: 9n },
      p: ZERO_RICH,
      q: ZERO_RICH,
    });
  });

  test('tryRead: a failed or malformed call zeroes tuple[] and dynamic struct outputs', async () => {
    const abi = [
      {
        type: 'function',
        name: 'rich',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'tuple', components: Rich.components }],
      },
      {
        type: 'function',
        name: 'list',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'tuple[]', components: Rich.components }],
      },
    ] as const satisfies Abi;
    const script = evscript({ name: 'tryZero', args: [] }, (s) => {
      const r = s.tryRead({ address: DEAD, abi, functionName: 'rich' });
      const l = s.tryRead({ address: POOL, abi, functionName: 'list' });
      const h = s.keccak256(r.success, l.success);
      return s.return({ h, ok: r.success, okL: l.success, r: r.value, l: l.value });
    });
    const zeroed = { ok: false, okL: false, r: ZERO_RICH, l: [] };
    // DEAD / POOL unmocked → empty returndata → malformed → zeroed
    const [o] = await expectAgreement(script, [[]], {}, evmVersion);
    expect(decode(script, o?.data)).toMatchObject(zeroed);
    // malformed deeper in the payload: the struct's head offset points past the end, and the
    // tuple[] element's offset points past the end (the try-mode decode-failure edges)
    const [bad] = await expectAgreement(
      script,
      [[]],
      {
        [DEAD]: { kind: 'return', data: concatHex(word(0x1000n)) },
        [POOL]: { kind: 'return', data: concatHex(word(32n), word(1n), word(0x1000n)) },
      },
      evmVersion,
    );
    expect(decode(script, bad?.data)).toMatchObject(zeroed);
    // success path through the same sites
    const rich = {
      n: 1n,
      s: 'hi',
      b: '0xbeef',
      xs: [2n, 3n],
      inner: { a: 4n, label: 'in' },
    } as const;
    const [good] = await expectAgreement(
      script,
      [[]],
      {
        [DEAD]: {
          kind: 'return',
          data: encodeAbiParameters([{ type: 'tuple', components: Rich.components }], [rich]),
        },
        [POOL]: {
          kind: 'return',
          data: encodeAbiParameters(
            [{ type: 'tuple[]', components: Rich.components }],
            [[rich, rich]],
          ),
        },
      },
      evmVersion,
    );
    expect(decode(script, good?.data)).toMatchObject({
      ok: true,
      okL: true,
      r: rich,
      l: [rich, rich],
    });
  });

  test('allocations over dirty memory: only blocks with an unwritten word slot are zero-filled', async () => {
    const garbageAbi = [
      {
        type: 'function',
        name: 'garbage',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          {
            name: '',
            type: 'tuple',
            components: [
              { name: 's', type: 'string' },
              { name: 'b', type: 'bytes' },
            ],
          },
        ],
      },
    ] as const satisfies Abi;
    const Memrefs = t.struct({
      s: t.string,
      b: t.bytes,
      xs: t.array(t.uint256),
      inner: t.struct({ label: t.string }),
    });
    const Mixed = t.struct({ n: t.uint256, s: t.string });
    const script = evscript({ name: 'dirtyAlloc', args: [t.uint256] }, (s, n) => {
      // the head offset 2^256−1 fails the decode, and the try rolls the free pointer back over
      // its all-ones returndata snapshot: every allocation below (the try's own zero value
      // first) starts on dirty memory
      const r = s.tryRead({ address: DEAD, abi: garbageAbi, functionName: 'garbage' });
      const all = s.tuple(Memrefs); // no word slot: no fill
      const part = s.tuple(Memrefs, { s: 'x' });
      const mixed = s.tuple(Mixed, { s: 'y' }); // omitted word member: fill kept
      const full = s.tuple(Mixed, { n, s: 'z' }); // every member provided: no fill
      const strs = s.newArray(t.string, n);
      const pairs = s.newArray(t.array(t.string, 2), n); // string[2] zeros per element
      const words = s.newArray(t.uint256, n); // word elements: fill kept
      const fixed = s.newArray(t.string, 2, { fixed: true });
      return s.return({
        ok: r.success,
        r: r.value,
        all,
        part,
        mixed,
        full,
        strs: strs.expr(),
        pairs: pairs.expr(),
        words: words.expr(),
        fixed: fixed.expr(),
      });
    });
    const ones = concatHex(...Array.from({ length: 96 }, () => word(-1n)));
    const [o] = await expectAgreement(
      script,
      [[3n]],
      { [DEAD]: { kind: 'return', data: ones } },
      evmVersion,
    );
    const zeroMemrefs = { s: '', b: '0x', xs: [], inner: { label: '' } };
    expect(decode(script, o?.data)).toEqual({
      ok: false,
      r: { s: '', b: '0x' },
      all: zeroMemrefs,
      part: { ...zeroMemrefs, s: 'x' },
      mixed: { n: 0n, s: 'y' },
      full: { n: 3n, s: 'z' },
      strs: ['', '', ''],
      pairs: [
        ['', ''],
        ['', ''],
        ['', ''],
      ],
      words: [0n, 0n, 0n],
      fixed: ['', ''],
    });
  });

  test('all-zero and mostly-zero literals: zero-filled over dirty memory, not data segments', async () => {
    const garbageAbi = [
      {
        type: 'function',
        name: 'garbage',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          {
            name: '',
            type: 'tuple',
            components: [
              { name: 's', type: 'string' },
              { name: 'b', type: 'bytes' },
            ],
          },
        ],
      },
    ] as const satisfies Abi;
    const zeros40 = Array.from({ length: 40 }, () => 0n);
    const sparse = Array.from({ length: 24 }, (_, i) =>
      i === 5 ? 2n ** 255n : i === 17 ? 9n : 0n,
    );
    const sparseBytes = `0xab${'00'.repeat(94)}cd` as const; // 96 bytes: two of four words nonzero
    const script = evscript({ name: 'zeroLits', args: [t.uint256] }, (s, i) => {
      // the head offset 2^256−1 fails the decode, and the try rolls the free pointer back over
      // its all-ones returndata snapshot: every literal below lands on dirty memory
      const r = s.tryRead({ address: DEAD, abi: garbageAbi, functionName: 'garbage' });
      const fixed = s.lit(t.array(t.uint256, 40), zeros40);
      const dyn = s.let(t.array(t.uint256), zeros40);
      const narrow = s.lit(t.array(t.int8), [0n, 0n, 0n, -1n]); // sign-extended −1: one word
      const table = s.lit(t.array(t.uint256), sparse);
      const empty = s.lit(t.bytes, '0x');
      const nul = s.lit(t.bytes, '0x000000');
      const blank = s.lit(t.string, '');
      const padded = s.lit(t.bytes, sparseBytes);
      const dense = s.lit(t.array(t.uint256), [0n, 5n, 6n]); // stays a data segment
      // a literal inside a loop is re-materialized each iteration on fresh memory
      const sum = s.let(t.uint256, 0n);
      s.for({ type: t.uint256, from: 0n, until: 3n }, () => {
        sum.set(sum.get().add(s.lit(t.array(t.uint256), sparse).at(i)));
      });
      return s.return({
        ok: r.success,
        at: fixed.at(i),
        fixed,
        dyn: dyn.get(),
        narrow,
        table,
        empty,
        nul,
        blank,
        padded,
        dense,
        sum: sum.get(),
      });
    });
    const ones = concatHex(...Array.from({ length: 96 }, () => word(-1n)));
    const table = { [DEAD]: { kind: 'return', data: ones } } as const;
    const [o, seventeen] = await expectAgreement(script, [[0n], [17n]], table, evmVersion);
    expect(decode(script, o?.data)).toEqual({
      ok: false,
      at: 0n,
      fixed: zeros40,
      dyn: zeros40,
      narrow: [0, 0, 0, -1],
      table: sparse,
      empty: '0x',
      nul: '0x000000',
      blank: '',
      padded: sparseBytes,
      dense: [0n, 5n, 6n],
      sum: 0n,
    });
    expect(decode(script, seventeen?.data)).toMatchObject({ at: 0n, sum: 27n });
  });
});
