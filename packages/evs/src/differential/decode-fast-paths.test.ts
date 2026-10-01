/**
 * Differential suite — the decoder's cheaper lowerings (the 0.2.0 field-test efficiency review).
 *
 * - **u64 bound.** Every decoded offset / length is bounded `≤ 2^64−1` as `x >> 64 ≠ 0`
 *   (`PUSH1 64 SHR`, 3 bytes) instead of `2^64−1 < x` (`PUSH8 … LT`, 10 bytes). The shift result
 *   is not a boolean, so it only ever feeds a branch: pinned on the boundary values directly, then
 *   swept over every head / tail word of shapes that reach each bound site (call outputs on both
 *   decoder paths, tuple members, script args).
 * - **Fixed-size word arrays** (`uint256[N]`, `address[N]`, `uint8[N]`, …) decode with one bulk
 *   copy (`MCOPY` on cancun for a full-word element, else a fused copy-and-normalize loop)
 *   instead of the heap-frame element loop: values, dirty-bit normalization, truncated sources
 *   and the per-element gas, as args, outputs, struct members and array elements, on every fork.
 * - **Nested dynamic tuples.** A dynamic sub-tuple two levels below the nearest O(1) base reads
 *   its base from a heap tuple frame chained through scratch `0x20` instead of re-deriving it
 *   through every enclosing offset word: chains of nested structs, mixed with both array decoder
 *   paths, round-trip byte-exact; truncated and corrupted data fail the same way in the
 *   interpreter and the bytecode; and the code size grows linearly with the depth.
 * - **Decode-work budget** (#117) across both: overlapping offsets exhaust it at exactly the
 *   interpreter's threshold through fixed-word arrays (MCOPY and the copy loop) and framed
 *   sub-tuples, and canonical payloads past the slack still decode.
 *
 * interp == bytecode (plain and optimized) byte-for-byte, and == viem where viem decodes.
 */

/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion -- a loose
   corpus: ABIs, verb surfaces and values are built at run time from tables */
/* oxlint-disable vitest/expect-expect --
 * the call-output tests assert through the shared `expectCallAgreement` runner. */

import {
  type Abi,
  type AbiParameter,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
} from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import {
  expectAgreement,
  EVM_VERSIONS,
  fixtureOf,
  type AnyScript,
  type CalleeTable,
  type Outcome,
} from '../../test/harness/differential.js';
import { bytesToHex, execRuntime } from '../../test/harness/evm.js';
import { concatHex, word } from '../../test/harness/fixtures.js';
import { layoutOfType } from '../abi/layout.js';
import { assemble, AsmWriter } from '../asm/assembler.js';
import { evscript } from '../builder/script.js';
import { emitAboveU64 } from '../codegen/abi.js';
import { framesTuple } from '../codegen/abi/decode.js';
import { compile } from '../compile.js';
import { abiParamToType, t, type EvsType, type Expr } from '../core/types.js';

type Verb = 'read' | 'tryRead';
const VERBS: readonly Verb[] = ['read', 'tryRead'];

/** The loose verb surface the corpus drives (precise inference is pinned by the type tests). */
type LooseVerbs = Record<
  Verb,
  (opts: { address: Expr<'address'>; abi: Abi; functionName: 'g' }) => unknown
>;

const INVALID_CALLDATA = '0xf43fed56'; // EvsInvalidCalldata()
/** The u64 bound's edges and the extremes past it. */
const EDGES = [(1n << 64n) - 1n, 1n << 64n, 1n << 255n, (1n << 256n) - 1n] as const;

/** Deterministic lowercase callee addresses (the harness table keys must be lowercase). */
const addr = (n: number): Hex =>
  `0x7200000000000000000000000000000000${n.toString(16).padStart(6, '0')}`;

const wordsOf = (data: Hex): string[] => data.slice(2).match(/.{64}/g) ?? [];

/** viem encode over the loose corpus values. */
const encodeLoose = (params: readonly AbiParameter[], vals: readonly unknown[]): Hex =>
  encodeAbiParameters(params, vals as never);

/** `f(address)`: one `verb` call of `g() returns (output)`, the result returned as `v`. */
function callScript(output: AbiParameter, verb: Verb) {
  const abi: Abi = [
    { type: 'function', name: 'g', stateMutability: 'view', inputs: [], outputs: [output] },
  ];
  return evscript({ name: 'f', args: [t.address] }, (s, target) => {
    const r = (s as unknown as LooseVerbs)[verb]({ address: target, abi, functionName: 'g' });
    if (verb === 'tryRead') {
      const tr = r as { success: Expr<'bool'>; value: Expr };
      return s.return({ ok: tr.success, v: tr.value });
    }
    return s.return({ v: r as Expr });
  });
}

/** `y(a)`: returns its one argument. */
function argScript(type: EvsType) {
  return evscript({ name: 'y', args: [type] as never }, (s, a) => s.return({ a: a as never }));
}

const decodeOut = (script: AnyScript, o: Outcome | undefined): unknown => {
  if (o?.kind !== 'return') throw new Error(`expected a normal return, got ${o?.kind}: ${o?.data}`);
  return decodeFunctionResult({ abi: script.abi as Abi, functionName: script.name, data: o.data });
};

const jsonOf = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * Raw-calldata run of a compiled `argScript`, compared with viem's decode of the same bytes:
 * `'EvsInvalidCalldata'` (both reject), `'EvsInvalidCalldata (viem accepts)'`, `'accepted'` (both
 * accept and the script returns viem's decode), or a diagnostic for anything else.
 */
async function argVerdict(script: AnyScript, runtime: Hex, calldata: Hex): Promise<string> {
  const r = await execRuntime(runtime, calldata);
  if (r.gasUsed >= 25_000_000n) return `halt (gas ${r.gasUsed})`;
  let viemArgs: readonly unknown[] | undefined;
  try {
    viemArgs = decodeFunctionData({ abi: script.abi as Abi, data: calldata }).args;
  } catch {
    viemArgs = undefined;
  }
  if (!r.success) {
    if (r.data !== INVALID_CALLDATA) return `revert ${r.data}`;
    return viemArgs === undefined ? 'EvsInvalidCalldata' : 'EvsInvalidCalldata (viem accepts)';
  }
  if (viemArgs === undefined) return 'accepted (viem rejects)';
  const got = decodeOut(script, { kind: 'return', data: r.data });
  return jsonOf(got) === jsonOf({ a: viemArgs[0] })
    ? 'accepted'
    : `accepted (mismatch ${jsonOf(got)})`;
}

/**
 * A `verb` call of `g() returns (output)` against `good` and its variants (one callee per
 * payload): interp == bytecode on all of them, `good` decodes to `value`, and on a try verb no
 * variant reverts the script. Returns the agreed outcomes after `good`'s.
 */
async function expectCallAgreement(
  output: AbiParameter,
  verb: Verb,
  value: unknown,
  variants: readonly Hex[],
  evmVersion: (typeof EVM_VERSIONS)[number],
): Promise<Outcome[]> {
  const script = callScript(output, verb);
  const good = encodeLoose([output], [value]);
  const table: Record<string, CalleeTable[string]> = { [addr(0)]: { kind: 'return', data: good } };
  variants.forEach((data, i) => {
    table[addr(i + 1)] = { kind: 'return', data };
  });
  const targets = [addr(0), ...variants.map((_, i) => addr(i + 1))];
  const outcomes = await expectAgreement(
    script,
    targets.map((a) => [a]),
    table,
    evmVersion,
  );
  expect(decodeOut(script, outcomes[0])).toEqual(
    verb === 'tryRead' ? { ok: true, v: value } : { v: value },
  );
  const reverted = targets.filter((_, i) => outcomes[i]?.kind !== 'return');
  expect(verb === 'tryRead' ? reverted : [], 'a try verb never reverts the script').toEqual([]);
  return outcomes.slice(1);
}

/** Every word-granular truncation of `good` (word 1 … n−1). */
const truncations = (good: Hex): Hex[] =>
  wordsOf(good)
    .slice(1)
    .map((_, k) => `0x${good.slice(2, 2 + 64 * (k + 1))}` as Hex);

/** `good` with word `k` replaced by each of `values`, for every word `k`. */
const corruptions = (good: Hex, values: readonly bigint[]): Hex[] =>
  wordsOf(good).flatMap((_, k) =>
    values.map((v) => {
      const ws = wordsOf(good);
      ws[k] = word(v).slice(2);
      return `0x${ws.join('')}` as Hex;
    }),
  );

// ---------------------------------------------------------------------------
// the u64 bound: PUSH1 64 SHR
// ---------------------------------------------------------------------------

describe('the u64 offset / length bound (PUSH1 64 SHR)', () => {
  test('branches exactly when the word is above 2^64−1', async () => {
    const cases = [0n, 1n, (1n << 64n) - 1n, 1n << 64n, (1n << 64n) + 1n, 1n << 255n];
    for (const x of [...cases, (1n << 256n) - 1n]) {
      const w = new AsmWriter();
      const above = w.newLabel('above');
      w.push(x);
      emitAboveU64(w); // [x >> 64]
      w.pushLabel(above);
      w.op('JUMPI');
      w.push(0);
      w.push(0);
      w.op('RETURN');
      w.label(above, 0);
      w.push(0);
      w.push(0);
      w.op('REVERT');
      const runtime = bytesToHex(assemble(w.nodes(), { evmVersion: 'cancun' }).bytecode);
      // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
      const r = await execRuntime(runtime, '0x');
      expect(r.success, `x = ${x}`).toBe(x <= (1n << 64n) - 1n);
    }
  });

  test('no PUSH8 2^64−1 constant is left in decode-heavy output', () => {
    const script = callScript(
      {
        name: 'r',
        type: 'tuple',
        components: [
          { name: 's', type: 'string' },
          { name: 'grid', type: 'uint256[][]' },
          { name: 'deep', type: 'uint256[][][]' },
        ],
      },
      'tryRead',
    );
    expect(compile(script).runtimeBytecode).not.toContain('67ffffffffffffffff');
  });

  // shapes reaching every bound site: the static-call leaf (`string`, `uint256[]`), a tuple
  // output and its members, the stack path (`string[]` elements, `uint256[][]`), the heap path
  // (`uint256[][][]`, `string[2]`)
  const SWEEP: readonly { label: string; output: AbiParameter; value: unknown }[] = [
    { label: 'string', output: { name: 'r', type: 'string' }, value: 'hello, evs' },
    { label: 'uint256[]', output: { name: 'r', type: 'uint256[]' }, value: [1n, 2n, 3n] },
    { label: 'string[]', output: { name: 'r', type: 'string[]' }, value: ['a', 'bc'] },
    { label: 'uint256[][]', output: { name: 'r', type: 'uint256[][]' }, value: [[1n], [2n, 3n]] },
    {
      label: 'uint256[][][]',
      output: { name: 'r', type: 'uint256[][][]' },
      value: [[[1n], []], [[2n, 3n]]],
    },
    { label: 'string[2]', output: { name: 'r', type: 'string[2]' }, value: ['x', 'yz'] },
    {
      label: 'tuple(uint8[] a, string s, tuple(string t) inner)',
      output: {
        name: 'r',
        type: 'tuple',
        components: [
          { name: 'a', type: 'uint8[]' },
          { name: 's', type: 'string' },
          { name: 'inner', type: 'tuple', components: [{ name: 't', type: 'string' }] },
        ],
      },
      value: { a: [7, 8], s: 'm', inner: { t: 'n' } },
    },
  ];

  for (const shape of SWEEP) {
    for (const verb of VERBS) {
      test(`${shape.label} × ${verb}: every word at the bound edges agrees`, async () => {
        const good = encodeLoose([shape.output], [shape.value]);
        await expectCallAgreement(
          shape.output,
          verb,
          shape.value,
          corruptions(good, EDGES),
          'cancun',
        );
      }, 60_000);
    }
  }

  const ARGS: readonly { label: string; type: EvsType; value: unknown }[] = [
    { label: 'string', type: t.string, value: 'hello' },
    { label: 'uint256[]', type: t.array(t.uint256), value: [5n, 6n] },
    { label: 'uint256[][]', type: t.array(t.array(t.uint256)), value: [[1n, 2n], [3n]] },
    {
      label: 'struct(string s, uint256[] xs)',
      type: t.struct({ s: t.string, xs: t.array(t.uint256) }),
      value: { s: 'q', xs: [9n] },
    },
  ];
  for (const arg of ARGS) {
    test(`script arg ${arg.label}: every word at the bound edges is rejected or decoded like viem`, async () => {
      const script = argScript(arg.type);
      const { runtimeBytecode } = compile(script);
      const good = encodeFunctionData({
        abi: script.abi as Abi,
        functionName: 'y',
        args: [arg.value],
      });
      expect(await argVerdict(script, runtimeBytecode, good)).toBe('accepted');
      const selector = good.slice(0, 10) as Hex;
      for (const data of corruptions(`0x${good.slice(10)}`, EDGES)) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
        const verdict = await argVerdict(script, runtimeBytecode, concatHex(selector, data));
        expect(['EvsInvalidCalldata', 'EvsInvalidCalldata (viem accepts)', 'accepted']).toContain(
          verdict,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// fixed-size word arrays: one bulk copy
// ---------------------------------------------------------------------------

describe('fixed-size word arrays decode with one bulk copy', () => {
  const FIXED: readonly { type: string; value: unknown }[] = [
    { type: 'uint256[1]', value: [42n] },
    { type: 'uint256[5]', value: [1n, 2n, 3n, (1n << 256n) - 1n, 0n] },
    { type: 'int256[3]', value: [-1n, 0n, -(1n << 255n)] },
    { type: 'bytes32[2]', value: [`0x${'ab'.repeat(32)}`, `0x${'00'.repeat(31)}01`] },
    {
      type: 'address[3]',
      value: [
        getAddress('0x00000000000000000000000000000000000000aa'),
        getAddress('0xffffffffffffffffffffffffffffffffffffffff'),
        getAddress('0x0000000000000000000000000000000000000000'),
      ],
    },
    { type: 'uint8[4]', value: [0, 1, 128, 255] },
    { type: 'int16[3]', value: [-32768, -1, 32767] },
    { type: 'bool[3]', value: [true, false, true] },
    { type: 'bytes4[2]', value: ['0xdeadbeef', '0x00000001'] },
    {
      type: 'uint256[3][]',
      value: [
        [1n, 2n, 3n],
        [4n, 5n, 6n],
      ],
    },
    {
      type: 'uint8[2][3]',
      value: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    },
  ];

  for (const { type, value } of FIXED) {
    for (const evmVersion of EVM_VERSIONS) {
      test(`${type}: script arg, call output (strict + try) and struct member round-trip [${evmVersion}]`, async () => {
        const arg = argScript(type as EvsType);
        const [o] = await expectAgreement(arg, [[value]], {}, evmVersion);
        expect(decodeOut(arg, o)).toEqual({ a: value });

        const output: AbiParameter = { name: 'r', type };
        const good = encodeLoose([output], [value]);
        for (const verb of VERBS) {
          // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
          await expectCallAgreement(output, verb, value, truncations(good), evmVersion);
        }

        const member: AbiParameter = {
          name: 'r',
          type: 'tuple',
          components: [
            { name: 'f', type },
            { name: 's', type: 'string' },
          ],
        };
        await expectCallAgreement(member, 'tryRead', { f: value, s: 'tail' }, [], evmVersion);
      }, 60_000);
    }
  }

  test('narrow elements with dirty high bits are normalized like the interpreter [every fork]', async () => {
    const output: AbiParameter = { name: 'r', type: 'uint8[3]' };
    const dirty = concatHex(word((1n << 200n) | 5n), word((1n << 255n) | 0xffn), word(1n << 8n));
    for (const evmVersion of EVM_VERSIONS) {
      const script = callScript(output, 'read');
      // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
      const [o] = await expectAgreement(
        script,
        [[addr(1)]],
        { [addr(1)]: { kind: 'return', data: dirty } },
        evmVersion,
      );
      expect(decodeOut(script, o)).toEqual({ v: [5, 0xff, 0] });
    }
  });

  test('the per-element decode gas is a bulk copy, not the heap-frame loop', async () => {
    const gasOf = async (n: number, evmVersion: (typeof EVM_VERSIONS)[number]): Promise<bigint> => {
      const script = evscript({ name: 'at', args: [t.array(t.uint256, n), t.uint256] }, (s, a, i) =>
        s.return({ v: a.at(i) }),
      );
      const { runtimeBytecode, abi } = compile(script, { evmVersion });
      const xs = Array.from({ length: n }, (_, i) => BigInt(i + 1));
      const data = encodeFunctionData({ abi, functionName: 'at', args: [xs as never, 1n] });
      const r = await execRuntime(runtimeBytecode, data);
      expect(r.success).toBe(true);
      return r.gasUsed;
    };
    // the heap-frame element loop cost ~205 gas per element; MCOPY is ~3, the copy loop ~70
    // (the calldata snapshot and its memory expansion are in the measured slope too)
    const perElem = async (evmVersion: (typeof EVM_VERSIONS)[number]): Promise<bigint> =>
      ((await gasOf(64, evmVersion)) - (await gasOf(16, evmVersion))) / 48n;
    expect(await perElem('cancun')).toBeLessThan(20n);
    expect(await perElem('shanghai')).toBeLessThan(90n);
  });
});

// ---------------------------------------------------------------------------
// nested dynamic tuples: tuple frames
// ---------------------------------------------------------------------------

/** `L0 = (uint256 a, string s)`, `Lk = (uint256 a, string s, L(k−1) inner)`. */
function chain(d: number): { components: readonly AbiParameter[]; value: unknown } {
  const base = [
    { name: 'a', type: 'uint256' },
    { name: 's', type: 'string' },
  ] as const;
  if (d === 0) return { components: base, value: { a: 7n, s: 'leaf' } };
  const inner = chain(d - 1);
  return {
    components: [...base, { name: 'inner', type: 'tuple', components: inner.components }],
    value: { a: BigInt(d), s: 'n'.repeat(d), inner: inner.value },
  };
}

/** A shape mixing tuple frames with both array decoder paths: framed sub-tuples holding
 *  stack-path (`uint256[][]`) and fixed (`uint8[3]`) arrays, and a `tuple[]` whose elements reach
 *  a framed level of their own. */
const L0 = [
  { name: 't', type: 'string' },
  { name: 'g', type: 'uint256[][]' },
  { name: 'f', type: 'uint8[3]' },
] as const;
const MIXED: AbiParameter = {
  name: 'r',
  type: 'tuple',
  components: [
    { name: 'b', type: 'bytes' },
    {
      name: 'mid',
      type: 'tuple',
      components: [
        { name: 'a', type: 'uint256' },
        { name: 'inner', type: 'tuple', components: L0 },
        {
          name: 'list',
          type: 'tuple[]',
          components: [
            { name: 'u', type: 'string' },
            {
              name: 'x',
              type: 'tuple',
              components: [
                { name: 'v', type: 'string' },
                { name: 'deep', type: 'tuple', components: L0 },
              ],
            },
          ],
        },
      ],
    },
    { name: 'pair', type: 'uint256[2]' },
  ],
};
const l0 = (k: number): unknown => ({
  t: `t${k}`,
  g: [[BigInt(k)], [], [BigInt(k + 1), BigInt(k + 2)]],
  f: [k, k + 1, 255],
});
const MIXED_VALUE = {
  b: '0xc0ffee',
  mid: {
    a: 3n,
    inner: l0(1),
    list: [
      { u: 'first', x: { v: 'v1', deep: l0(2) } },
      { u: '', x: { v: 'v2', deep: l0(3) } },
    ],
  },
  pair: [10n, 20n],
};

describe('nested dynamic tuples read their base from a tuple frame', () => {
  for (const d of [1, 2, 3, 5]) {
    const { components, value } = chain(d);
    const output: AbiParameter = { name: 'r', type: 'tuple', components };
    for (const evmVersion of EVM_VERSIONS) {
      test(`depth ${d}: call output (strict + try) good / truncated / corrupted [${evmVersion}]`, async () => {
        const good = encodeLoose([output], [value]);
        const variants =
          evmVersion === 'cancun'
            ? [...truncations(good), ...corruptions(good, [(1n << 64n) - 1n, 1n << 64n, 0x20n])]
            : truncations(good);
        for (const verb of VERBS) {
          // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
          await expectCallAgreement(output, verb, value, variants, evmVersion);
        }
      }, 60_000);
    }

    test(`depth ${d}: script arg round-trips [every fork]`, async () => {
      const script = argScript(abiParamToType({ name: 'a', type: 'tuple', components } as never));
      for (const evmVersion of EVM_VERSIONS) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
        const [o] = await expectAgreement(script, [[value]], {}, evmVersion);
        expect(decodeOut(script, o)).toEqual({ a: value });
      }
    });
  }

  for (const evmVersion of EVM_VERSIONS) {
    test(`frames mixed with both array paths: call output good / truncated / corrupted [${evmVersion}]`, async () => {
      // the payload is long: shift every word (offsets then point at the wrong, in-bounds bytes)
      // on the try verb only, on cancun (the bound edges are swept above)
      const good = encodeLoose([MIXED], [MIXED_VALUE]);
      const corrupted = evmVersion === 'cancun' ? corruptions(good, [0x40n]) : [];
      await expectCallAgreement(MIXED, 'read', MIXED_VALUE, truncations(good), evmVersion);
      await expectCallAgreement(
        MIXED,
        'tryRead',
        MIXED_VALUE,
        [...truncations(good), ...corrupted],
        evmVersion,
      );
    }, 120_000);

    test(`frames mixed with both array paths: as an element of a fixed tuple[2] [${evmVersion}]`, async () => {
      const output: AbiParameter = {
        name: 'r',
        type: 'tuple[2]',
        components: (MIXED as { components: readonly AbiParameter[] }).components,
      };
      await expectCallAgreement(output, 'tryRead', [MIXED_VALUE, MIXED_VALUE], [], evmVersion);
    }, 60_000);
  }

  // A frame costs about two and a half re-derived base reads, so a sub-tuple read fewer than 3
  // times keeps the re-derivation (a lone `string` member: offset word + ptr).
  const tup = (...components: AbiParameter[]): AbiParameter =>
    ({ name: 'x', type: 'tuple', components }) as AbiParameter;
  const str = (name: string): AbiParameter => ({ name, type: 'string' });
  /** `(string s, (string t, (string u, …extra) c) b)`: `c` is the level that may get a frame. */
  const lean = (...extra: AbiParameter[]): AbiParameter =>
    ({
      name: 'r',
      type: 'tuple',
      components: [
        str('s'),
        { ...tup(str('t'), { ...tup(str('u'), ...extra), name: 'c' }), name: 'b' },
      ],
    }) as AbiParameter;
  const leanValue = { s: 'x', b: { t: 'y', c: { u: 'z' } } };

  test('a sub-tuple gets a frame only when its base is read at least 3 times', () => {
    const frames = (p: AbiParameter): boolean => {
      const l = layoutOfType(abiParamToType(p as never));
      if (l.kind !== 'tuple') throw new Error('not a tuple');
      return framesTuple(l);
    };
    const u = { name: 'n', type: 'uint256' } as const;
    expect(frames(tup(str('u')))).toBe(false); // 2
    expect(frames(tup({ name: 'b', type: 'bytes' }))).toBe(false); // 2
    expect(frames(tup({ name: 'w', type: 'uint256[]' }))).toBe(false); // 2
    expect(frames(tup(str('u'), u))).toBe(true); // 3
    expect(frames(tup(str('u'), str('v')))).toBe(true); // 4
    expect(frames(tup({ name: 'f', type: 'uint8[3]' }, str('u')))).toBe(true); // 2 + 2
    expect(frames(tup({ name: 'l', type: 'string[]' }))).toBe(true); // 2 + 2
    // a lone framed inner tuple: 2 reads; a lone unframed one: 2 + its own 2
    expect(frames(tup(tup(str('u'), u)))).toBe(false);
    expect(frames(tup(tup(str('u'))))).toBe(true);
    expect(frames({ name: 'r', type: 'tuple', components: chain(0).components })).toBe(true);
  });

  for (const evmVersion of EVM_VERSIONS) {
    test(`unframed lean sub-tuples: call output good / truncated / corrupted [${evmVersion}]`, async () => {
      const shapes: [AbiParameter, unknown][] = [
        [lean(), leanValue],
        [
          { ...lean(), type: 'tuple[]' } as AbiParameter,
          [leanValue, { s: '', b: { t: 'tt', c: { u: '' } } }],
        ],
        [tup(tup(tup(tup({ name: 'b', type: 'bytes' })))), { x: { x: { x: { b: '0xc0ffee' } } } }],
      ];
      for (const [output, value] of shapes) {
        const good = encodeLoose([output], [value]);
        const variants =
          evmVersion === 'cancun'
            ? [...truncations(good), ...corruptions(good, [(1n << 64n) - 1n, 0x20n])]
            : truncations(good);
        for (const verb of VERBS) {
          // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
          await expectCallAgreement(output, verb, value, variants, evmVersion);
        }
      }
    }, 60_000);
  }

  test('a lean sub-tuple decodes no dearer than before tuple frames existed', async () => {
    // Relative, and on the decode alone (the script returns only the top-level `s`, so the
    // encoder's cost of the extra member stays out of it, and unrelated codegen changes shift both
    // measures alike): the marginal gas of one more `uint256` member in `c`, `lean(x)` (framed: 3
    // base reads) minus `lean()` (unframed: 2), on cancun, was 63 when pinned. Framing the lean
    // `c` too (a frame that does not repay itself) made the lean decode 17 gas dearer, so the
    // margin 46; not framing `c` in `lean(x)` (re-deriving its base through every enclosing offset
    // word, as before tuple frames) made it 80. The window rejects both.
    const gasOf = async (output: AbiParameter, value: unknown): Promise<bigint> => {
      const abi: Abi = [
        { type: 'function', name: 'g', stateMutability: 'view', inputs: [], outputs: [output] },
      ];
      const script = evscript({ name: 'f', args: [t.address] }, (s, target) => {
        const r = (s as unknown as LooseVerbs).read({ address: target, abi, functionName: 'g' });
        return s.return({ s: (r as { s: { get: () => Expr } }).s.get() });
      });
      const { runtimeBytecode } = compile(script, { evmVersion: 'cancun' });
      const r = await execRuntime(
        runtimeBytecode,
        encodeFunctionData({ abi: script.abi as Abi, functionName: 'f', args: [addr(0)] }),
        fixtureOf({ [addr(0)]: { kind: 'return', data: encodeLoose([output], [value]) } }),
      );
      expect(r.success).toBe(true);
      return r.gasUsed;
    };
    const x = { name: 'x', type: 'uint256' } as const;
    const wider = { s: 'x', b: { t: 'y', c: { u: 'z', x: 5n } } };
    const margin = (await gasOf(lean(x), wider)) - (await gasOf(lean(), leanValue));
    expect(margin).toBeGreaterThan(54n); // framing the lean `c`: 46
    expect(margin).toBeLessThan(72n); // re-deriving the wider `c`: 80
  });

  test('code size grows linearly with the nesting depth', () => {
    // the call decodes the whole output; only its top-level word is returned, so the encoder's
    // own growth with the depth stays out of the measure
    const sizeOf = (d: number): number => {
      const abi: Abi = [
        {
          type: 'function',
          name: 'g',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ name: 'r', type: 'tuple', components: chain(d).components }],
        },
      ];
      const script = evscript({ name: 'f', args: [t.address] }, (s, target) => {
        const r = (s as unknown as LooseVerbs).read({ address: target, abi, functionName: 'g' });
        return s.return({ a: (r as { a: { get: () => Expr } }).a.get() });
      });
      return compile(script).runtimeBytecode.length / 2 - 1;
    };
    const sizes = [1, 2, 3, 4, 5, 6, 7].map((d) => sizeOf(d));
    const steps = sizes.slice(1).map((s, i) => s - (sizes[i] ?? 0));
    // re-deriving every base through the whole chain made each level ~30 bytes dearer than the
    // one above it; with tuple frames the step stays flat (it alternates between a re-derived
    // level and a framed one)
    const first = steps[0] ?? 0;
    for (const step of steps) expect(step).toBeLessThanOrEqual(first + 4);
  });
});

// ---------------------------------------------------------------------------
// the decode-work budget across the fast paths
// ---------------------------------------------------------------------------

describe('the decode-work budget holds on the fixed-word path and through tuple frames', () => {
  // A static `T[N]` has no charge of its own (the block that inlines it is charged its `32·N`
  // bytes), and a framed sub-tuple decodes through the same charged tuple decoder: overlapping
  // offsets must exhaust the budget exactly where the interpreter does, on every fork (MCOPY and
  // the copy loop alike), and canonical payloads larger than the slack must still decode.
  const DECODE_ERROR = '0x20cf27b7'; // EvsDecodeError(uint256)

  /** `f(address)`: one `verb` over `g() returns (output)`, returning only the array's length. */
  function lengthScript(output: AbiParameter, verb: Verb) {
    const abi: Abi = [
      { type: 'function', name: 'g', stateMutability: 'view', inputs: [], outputs: [output] },
    ];
    type Arr = { length: () => Expr<'uint256'> };
    return evscript({ name: 'f', args: [t.address] }, (s, target) => {
      const r = (s as unknown as LooseVerbs)[verb]({ address: target, abi, functionName: 'g' });
      if (verb === 'tryRead') {
        const tr = r as { success: Expr<'bool'>; value: Arr };
        return s.return({ ok: tr.success, n: tr.value.length() });
      }
      return s.return({ n: (r as Arr).length() });
    });
  }

  const verdictOf = (script: AnyScript, verb: Verb, o: Outcome | undefined): unknown =>
    o?.kind === 'return'
      ? decodeOut(script, o)
      : { kind: o?.kind, selector: o?.data.slice(0, 10), verb };
  const decoded = (verb: Verb, n: number): unknown =>
    verb === 'tryRead' ? { ok: true, n: BigInt(n) } : { n: BigInt(n) };
  const rejected = (verb: Verb): unknown =>
    verb === 'tryRead' ? { ok: false, n: 0n } : { kind: 'revert', selector: DECODE_ERROR, verb };

  const rep = (n: number, x: bigint): bigint[] => Array.from({ length: n }, () => x);
  const words = (...ws: readonly bigint[]): Hex => concatHex(...ws.map((x) => word(x)));
  /** `T[k][][]` whose N outer offsets all point at one inner `T[k][]` of L elements. */
  const overlapFixed = (n: number, l: number, k: number): Hex =>
    words(0x20n, BigInt(n), ...rep(n, BigInt(32 * n)), BigInt(l), ...rep(l * k, 1n));
  /** `tuple[]` whose N element offsets all point at one encoded element `elem` (`0x…`). */
  const overlapElems = (n: number, elem: Hex): Hex =>
    concatHex(words(0x20n, BigInt(n), ...rep(n, BigInt(32 * n))), elem);

  async function run(output: AbiParameter, verb: Verb, payloads: readonly Hex[], fork: string) {
    const script = lengthScript(output, verb);
    const table: Record<string, CalleeTable[string]> = {};
    payloads.forEach((data, k) => {
      table[addr(k + 1)] = { kind: 'return', data };
    });
    // expectAgreement also pins the gas (no halt): interp == bytecode, never out of gas
    const outcomes = await expectAgreement(
      script,
      payloads.map((_, k) => [addr(k + 1)]),
      table,
      fork as (typeof EVM_VERSIONS)[number],
    );
    return outcomes.map((o) => verdictOf(script, verb, o));
  }

  for (const elem of ['uint8', 'uint256'] as const) {
    const output = { name: 'r', type: `${elem}[64][][]` } as AbiParameter;
    for (const evmVersion of EVM_VERSIONS) {
      test(`${elem}[64][][]: the budget gives up at the same N with the fixed-word path [${evmVersion}]`, async () => {
        // one shared inner `T[64][]` of one element: charges 32 + 32N (outer) + N·(32 + 2048)
        // (each inner, its static `T[64]` element inlined) against 32(N + 67) + 32·8192: past it
        // from N = 128, the threshold the heap-loop decode had
        const ns = [126, 127, 128, 129];
        for (const verb of VERBS) {
          // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
          const got = await run(
            output,
            verb,
            ns.map((n) => overlapFixed(n, 1, 64)),
            evmVersion,
          );
          expect(got).toEqual(ns.map((n) => (n < 128 ? decoded(verb, n) : rejected(verb))));
        }
      }, 60_000);
    }
  }

  for (const evmVersion of EVM_VERSIONS) {
    test(`fixed-word arrays: heavy overlap fails cleanly, a canonical payload past the slack decodes [${evmVersion}]`, async () => {
      const output = { name: 'r', type: 'uint8[64][][]' } as AbiParameter;
      // 200 offsets at one 10-element inner array: ~4 MB of charged blocks from a 27 KB payload
      const canonical = encodeLoose([output], [[rep(160, 0n).map(() => rep(64, 255n))]]);
      for (const verb of VERBS) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
        const got = await run(output, verb, [overlapFixed(200, 10, 64), canonical], evmVersion);
        // 160 · 64 words: 320 KiB charged, over the 256 KiB slack, but within its own size
        expect(got).toEqual([rejected(verb), decoded(verb, 1)]);
      }
    }, 60_000);
  }

  for (const evmVersion of EVM_VERSIONS) {
    test(`tuple frames under a repeated budget: overlapping elements fail cleanly, distinct ones decode [${evmVersion}]`, async () => {
      // `chain(3)[]`: each element's head and its three nested heads (96 + 96 + 96 + 64 bytes, the
      // third level framed) are charged under 'repeated'. N offsets at one E-byte element charge
      // 32 + 32N + 352N against 32(N + 2) + E + 32·8192: past it from N = ⌊(262176 + E) / 352⌋ + 1
      // — the threshold is pinned on both sides, and 1000 offsets fail only if the framed levels
      // are charged too (without them, 192 bytes an element, 1000 would still decode)
      const output = {
        name: 'r',
        type: 'tuple[]',
        components: chain(3).components,
      } as AbiParameter;
      const one = encodeLoose([{ ...output, type: 'tuple' } as AbiParameter], [chain(3).value]);
      // the element block itself starts after its own offset word
      const elem = `0x${one.slice(2 + 64)}` as Hex;
      const canonical = encodeLoose([output], [rep(300, 0n).map(() => chain(3).value)]);
      const e = (elem.length - 2) / 2;
      const last = Math.floor((262_176 + e) / 352);
      for (const verb of VERBS) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: deterministic labels
        const got = await run(
          output,
          verb,
          [last, last + 1, 1000].map((n) => overlapElems(n, elem)).concat(canonical),
          evmVersion,
        );
        expect(got).toEqual([
          decoded(verb, last),
          rejected(verb),
          rejected(verb),
          decoded(verb, 300),
        ]);
      }
    }, 60_000);
  }
});
