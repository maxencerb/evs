/**
 * Differential suite — try verbs over outputs with dynamic leaves inside composites (issue #67).
 *
 * `s.tryRead` / `s.tryCall` / `s.trySimulate` against `string[]`, `bytes[]`, `uint256[][]`,
 * `tuple[]` with a dynamic member, and structs with `string`/`bytes` (and `string[]`) members.
 * These shapes used to fail to compile (asm verifier stack-height mismatch): the try-mode decode
 * failure router was handed one live stack item too many at two sites. Every case must now compile,
 * and at runtime agree byte-for-byte with the reference interpreter on:
 *
 * - good returndata → `success = true` and the decoded value (== viem's decode);
 * - a callee revert, empty returndata, and every word-granular truncation → `success = false` and
 *   the zero value (the script keeps running and returns normally);
 * - a one-byte truncation and each head/tail word corrupted to 2^64 → agreement only (some of those
 *   still decode, e.g. a corrupted element word of a `uint256[][]`).
 *
 * One slice of the anti-miscompilation corpus. Runner, callee table and fixture constants:
 * `test/harness/differential.ts`.
 */

import type { Abi, AbiParameter } from 'abitype';
import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, type Hex } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement, type CalleeTable } from '../../test/harness/differential.js';
import { word } from '../../test/harness/fixtures.js';
import { evscript } from '../builder/script.js';
import { compile } from '../compile.js';
import { t, type Expr } from '../core/types.js';

type Verb = 'read' | 'call' | 'simulate' | 'tryRead' | 'tryCall' | 'trySimulate';
const TRY_VERBS = ['tryRead', 'tryCall', 'trySimulate'] as const;
const ALL_VERBS: readonly Verb[] = ['read', 'call', 'simulate', ...TRY_VERBS];

/** The loose verb surface the corpus drives (precise inference is pinned by the type tests). */
type TryResult = { success: Expr<'bool'>; value: Expr };
type LooseVerbs = Record<
  Verb,
  (opts: { address: Expr<'address'>; abi: Abi; functionName: 'g' }) => unknown
>;

interface Shape {
  readonly label: string;
  readonly output: AbiParameter;
  readonly value: unknown;
  /** viem's decode of the zero value (what a failed try yields). */
  readonly zero: unknown;
}

const SHAPES: readonly Shape[] = [
  {
    label: 'string[]',
    output: { name: 'r', type: 'string[]' },
    value: ['alpha', '', 'a-much-longer-string-spanning-two-words!!', 'z'],
    zero: [],
  },
  {
    label: 'bytes[]',
    output: { name: 'r', type: 'bytes[]' },
    value: ['0xdeadbeef', '0x', `0x${'ab'.repeat(40)}`, '0x01'],
    zero: [],
  },
  {
    label: 'uint256[][]',
    output: { name: 'r', type: 'uint256[][]' },
    value: [[1n, 2n], [], [3n], [4n, 5n, 6n]],
    zero: [],
  },
  {
    label: 'tuple(uint256,string)[]',
    output: {
      name: 'r',
      type: 'tuple[]',
      components: [
        { name: 'id', type: 'uint256' },
        { name: 'name', type: 'string' },
      ],
    },
    value: [
      { id: 7n, name: 'seven' },
      { id: 8n, name: '' },
      { id: 9n, name: 'nine-is-a-slightly-longer-name-over-32-bytes' },
    ],
    zero: [],
  },
  {
    label: 'tuple(uint256,bytes)',
    output: {
      name: 'r',
      type: 'tuple',
      components: [
        { name: 'id', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
    },
    value: { id: 42n, data: '0xc0ffee' },
    zero: { id: 0n, data: '0x' },
  },
  {
    label: 'tuple(string)',
    output: { name: 'r', type: 'tuple', components: [{ name: 's', type: 'string' }] },
    value: { s: 'hello' },
    zero: { s: '' },
  },
  {
    label: 'tuple(string,uint256,bytes,string[])',
    output: {
      name: 'r',
      type: 'tuple',
      components: [
        { name: 'name', type: 'string' },
        { name: 'id', type: 'uint256' },
        { name: 'blob', type: 'bytes' },
        { name: 'tags', type: 'string[]' },
      ],
    },
    value: { name: 'n', id: 3n, blob: `0x${'cd'.repeat(33)}`, tags: ['x', 'yy'] },
    zero: { name: '', id: 0n, blob: '0x', tags: [] },
  },
];

const mutabilityOf = (verb: Verb): 'view' | 'nonpayable' =>
  verb === 'read' || verb === 'tryRead' ? 'view' : 'nonpayable';

function abiFor(shape: Shape, verb: Verb): Abi {
  return [
    {
      type: 'function',
      name: 'g',
      stateMutability: mutabilityOf(verb),
      inputs: [],
      outputs: [shape.output],
    },
  ];
}

function scriptFor(shape: Shape, verb: Verb) {
  const abi = abiFor(shape, verb);
  return evscript({ name: 'f', args: [t.address] }, (s, target) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose corpus verb surface
    const loose = s as unknown as LooseVerbs;
    const r = loose[verb]({ address: target, abi, functionName: 'g' });
    if (verb === 'read' || verb === 'call' || verb === 'simulate') {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- strict verbs yield the value
      return s.return({ v: r as Expr });
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- try verbs yield { success, value }
    const tr = r as TryResult;
    return s.return({ ok: tr.success, v: tr.value });
  });
}

/** Deterministic lowercase callee addresses (the harness table keys must be lowercase). */
const addr = (n: number): Hex =>
  `0x7000000000000000000000000000000000${n.toString(16).padStart(6, '0')}`;

describe('try verbs over dynamic leaves inside composites — compile matrix (issue #67)', () => {
  for (const shape of SHAPES) {
    for (const verb of ALL_VERBS) {
      for (const optimize of [false, true]) {
        test(`${shape.label} × ${verb}${optimize ? ' (optimize)' : ''} compiles`, () => {
          for (const evmVersion of ['paris', 'cancun'] as const) {
            expect(() => compile(scriptFor(shape, verb), { evmVersion, optimize })).not.toThrow();
          }
        });
      }
    }
  }
});

describe('try verbs over dynamic leaves inside composites — runtime (issue #67)', () => {
  for (const shape of SHAPES) {
    const good = encodeAbiParameters([shape.output], [shape.value]);
    const expected = decodeAbiParameters([shape.output], good)[0];
    const nWords = (good.length - 2) / 64;

    // callee table: good / revert / empty / every word-granular truncation / 1-byte truncation /
    // each word corrupted to 2^64 (offsets past the u64 bound, absurd lengths, …)
    const GOOD = addr(1);
    const REVERT = addr(2);
    const EMPTY = addr(3);
    const table: Record<string, CalleeTable[string]> = {
      [GOOD]: { kind: 'return', data: good },
      [REVERT]: { kind: 'revert', data: good }, // a revert carrying well-formed data is still a failure
      [EMPTY]: { kind: 'return', data: '0x' },
    };
    const failing: Hex[] = [REVERT, EMPTY];
    const agreementOnly: Hex[] = [];
    for (let k = 1; k < nWords; k++) {
      const a = addr(0x100 + k);
      table[a] = { kind: 'return', data: `0x${good.slice(2, 2 + 64 * k)}` };
      failing.push(a);
    }
    {
      const a = addr(0x200);
      table[a] = { kind: 'return', data: `0x${good.slice(2, -2)}` };
      agreementOnly.push(a);
    }
    for (let k = 0; k < nWords; k++) {
      const a = addr(0x300 + k);
      const words = good.slice(2).match(/.{64}/g) ?? [];
      words[k] = word(1n << 64n).slice(2);
      table[a] = { kind: 'return', data: `0x${words.join('')}` };
      agreementOnly.push(a);
    }

    for (const verb of TRY_VERBS) {
      for (const evmVersion of ['paris', 'cancun'] as const) {
        test(`${shape.label} × ${verb} [${evmVersion}]: good / revert / empty / truncated / corrupted`, async () => {
          // sanity: viem round-trips the fixture value
          expect(expected).toEqual(shape.value);
          const script = scriptFor(shape, verb);
          const targets = [GOOD, ...failing, ...agreementOnly];
          const outcomes = await expectAgreement(
            script,
            targets.map((a) => [a]),
            table,
            evmVersion,
          );
          const decodeAt = (i: number): unknown => {
            const o = outcomes[i];
            expect(o?.kind, `${targets[i]}: the try verb never reverts the script`).toBe('return');
            return decodeFunctionResult({
              abi: script.abi,
              functionName: 'f',
              data: o?.data ?? '0x',
            });
          };
          expect(decodeAt(0)).toEqual({ ok: true, v: expected });
          for (let i = 1; i <= failing.length; i++) {
            expect(decodeAt(i), `${targets[i]}: success=false + zero value`).toEqual({
              ok: false,
              v: shape.zero,
            });
          }
          for (let i = failing.length + 1; i < targets.length; i++) decodeAt(i);
        });
      }
    }
  }
});
