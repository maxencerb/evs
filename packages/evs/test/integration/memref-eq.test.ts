/**
 * `eq` / `neq` on memref types vs solc — the on-chain differential (issue #38).
 *
 * evs lowers memref equality to hash equality (`keccak256(a) == keccak256(b)`); the solc
 * 0.8.30 oracles in EvsReference spell the same idiom by hand — `keccak256(bytes(a))` for
 * string/bytes, `keccak256(abi.encode(a))` for arrays and structs. Every corpus row is driven
 * through both over eth_call (evs in the default deployless `toViem()` mode) and the decoded
 * booleans must agree. The corpus pins the edge cases the hash rewrite must not blur: empty
 * values, values differing only in length, same-length different content, and a `string[]`
 * whose concatenation matches but whose elements do not (the packed-vs-standard trap).
 */

import type { Abi } from 'viem';
import { beforeAll, describe, expect, test } from 'vite-plus/test';

import { compile, evscript, t, type EvsType, type Expr } from '../../src/index.js';
import { EvsReference } from '../generated/index.js';
import { publicClient } from '../harness/anvil.js';
import { deploy } from './helpers.js';

const Pair = t.struct({ token: t.address, fee: t.uint24 });

const beef = '0x00000000000000000000000000000000deadbeef';
const cafe = '0x00000000000000000000000000000000cafebabe';
const LONG = 'a long string deliberately exceeding thirty-two bytes — memcpy territory ✓';

interface Case {
  fn: string;
  op: 'eq' | 'neq';
  type: EvsType;
  corpus: readonly (readonly [unknown, unknown])[];
}

const STRINGS: Case['corpus'] = [
  ['', ''],
  ['', 'x'],
  ['hello', 'hello'],
  ['hello', 'hello!'],
  ['hellO', 'hello'],
  ['exactly-32-bytes-of-ascii-here!!', 'exactly-32-bytes-of-ascii-here!!'],
  ['exactly-32-bytes-of-ascii-here!!', 'exactly-32-bytes-of-ascii-here!'],
  [LONG, LONG],
  [LONG, `${LONG} `],
];

const BYTES: Case['corpus'] = [
  ['0x', '0x'],
  ['0x', '0x00'],
  ['0x00', '0x0000'],
  ['0xdeadbeef', '0xdeadbeef'],
  ['0xdeadbeef', '0xdeadbeee'],
  [`0x${'ab'.repeat(32)}`, `0x${'ab'.repeat(32)}`],
  [`0x${'ab'.repeat(32)}`, `0x${'ab'.repeat(33)}`],
  [`0x${'5a'.repeat(95)}`, `0x${'5a'.repeat(95)}`],
];

const UINTS: Case['corpus'] = [
  [[], []],
  [[], [0n]],
  [[0n], [0n, 0n]],
  [
    [1n, 2n],
    [1n, 2n],
  ],
  [
    [1n, 2n],
    [2n, 1n],
  ],
  [
    [(1n << 256n) - 1n, 7n],
    [(1n << 256n) - 1n, 7n],
  ],
  [
    [1n, 2n, 3n],
    [1n, 2n],
  ],
];

const STRING_ARRAYS: Case['corpus'] = [
  [[], []],
  [[], ['']],
  [[''], ['', '']],
  [
    ['a', 'b'],
    ['a', 'b'],
  ],
  [
    ['ab', ''],
    ['a', 'b'],
  ], // same concatenation, different elements → NOT equal
  [['ab'], ['a', 'b']],
  [
    ['one', LONG],
    ['one', LONG],
  ],
  [
    ['one', LONG],
    ['one', `${LONG}!`],
  ],
];

const CASES: readonly Case[] = [
  { fn: 'eqString', op: 'eq', type: t.string, corpus: STRINGS },
  { fn: 'neqString', op: 'neq', type: t.string, corpus: STRINGS },
  { fn: 'eqBytes', op: 'eq', type: t.bytes, corpus: BYTES },
  { fn: 'neqBytes', op: 'neq', type: t.bytes, corpus: BYTES },
  { fn: 'eqUintArray', op: 'eq', type: t.array(t.uint256), corpus: UINTS },
  { fn: 'neqUintArray', op: 'neq', type: t.array(t.uint256), corpus: UINTS },
  { fn: 'eqStringArray', op: 'eq', type: 'string[]', corpus: STRING_ARRAYS },
  { fn: 'neqStringArray', op: 'neq', type: 'string[]', corpus: STRING_ARRAYS },
  {
    fn: 'eqPair',
    op: 'eq',
    type: Pair,
    corpus: [
      [
        { token: beef, fee: 500n },
        { token: beef, fee: 500n },
      ],
      [
        { token: beef, fee: 500n },
        { token: cafe, fee: 500n },
      ],
      [
        { token: beef, fee: 500n },
        { token: beef, fee: 3000n },
      ],
    ],
  },
];

/** A struct arg arrives as a Tuple handle (issue #25) — compare its memref Expr. */
function asExpr(v: unknown): Expr {
  const h = v as { expr?: () => Expr };
  return typeof h.expr === 'function' ? h.expr() : (v as Expr);
}

function buildScript(c: Case) {
  return evscript({ name: c.fn, args: [c.type, c.type] }, (s, ...rawArgs) => {
    const [a, b] = [asExpr(rawArgs[0]), asExpr(rawArgs[1])];
    // both spellings per case: the method form and the free-function form record the same IR
    const r = c.op === 'eq' ? a.eq(b) : s.neq(a, b);
    return s.return({ r });
  });
}

let reference: `0x${string}`;

beforeAll(async () => {
  reference = await deploy(EvsReference.abi, EvsReference.bytecode);
});

describe('memref eq/neq: evs hash equality vs solc 0.8.30 keccak idiom (EvsReference)', () => {
  test.each(CASES.map((c) => [c.fn, c] as const))('%s', async (_name, c) => {
    const compiled = compile(buildScript(c));
    const deployless = compiled.toViem();

    for (const values of c.corpus) {
      const solc = await publicClient.readContract({
        address: reference,
        abi: EvsReference.abi as Abi,
        functionName: c.fn,
        args: values as never,
      });
      const evs = (await publicClient.readContract({
        ...deployless,
        functionName: c.fn,
        args: values as never,
      })) as { r: unknown };
      const label = `${c.fn}(${JSON.stringify(values, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))})`;
      expect(typeof solc, `${label}: solc oracle returns a bool`).toBe('boolean');
      expect(evs.r, `${label}: evs vs solc`).toBe(solc);
    }
  });
});
