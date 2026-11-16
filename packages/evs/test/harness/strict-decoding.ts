/**
 * The strict-decoding corpus, shared by the differential suite
 * (`src/differential/strict-decoding.test.ts`, in-process EVM) and the anvil one
 * (`test/integration/strict-decoding.test.ts`): shapes that put a narrow word at every position a
 * decoder reads one, each with a clean payload and one payload per narrow word pushed out of
 * range for its type.
 *
 * The same bytes are decoded three ways in those suites: as a call's returndata, as a script's
 * arguments, and by solc 0.8.30 (`StrictDecodeReference`), which must agree with evs on each.
 */

/* oxlint-disable typescript/no-unsafe-type-assertion -- a loose corpus: the values of a shape are
   typed by its outputs at run time only */

import { type AbiParameter, encodeAbiParameters, type Hex } from 'viem';

import { concatHex, word } from './fixtures.js';

const wordsOf = (data: Hex): Hex[] =>
  (data.slice(2).match(/.{64}/g) ?? []).map((w): Hex => `0x${w}`);

// The narrow words: a clean value no other field of a shape uses, and the same value pushed out
// of range.

const OWNER = '0x00000000000000000000000000000000000abcd1';
const OTHER = '0x0000000000000000000000000000000000000007';
const TOP = 1n << 255n;

export interface Narrow {
  /** The clean word, as it stands in the encoded payload. */
  readonly clean: Hex;
  /** The words it is replaced with, each out of range for the field's type. */
  readonly dirty: readonly Hex[];
}

const N = {
  bool: { clean: word(1n), dirty: [word(2n), word(TOP | 1n)] },
  address: { clean: word(BigInt(OWNER)), dirty: [word((1n << 160n) | BigInt(OWNER))] },
  uint8: { clean: word(255n), dirty: [word(256n), word(TOP | 255n)] },
  int8: { clean: word(-128n), dirty: [word(0x80n), word(0x1ffn)] },
  bytes4: { clean: word(0x11223344n << 224n), dirty: [word((0x11223344n << 224n) | 1n)] },
  int24: { clean: word(-9n), dirty: [word(0xfffff7n)] },
  bytes2: { clean: word(0xbeefn << 240n), dirty: [word((0xbeefn << 240n) | (1n << 239n))] },
  int16: { clean: word(-2n), dirty: [word(0xfffen)] },
  uint16: { clean: word(0xfff0n), dirty: [word(0x1fff0n)] },
} as const satisfies Record<string, Narrow>;

const REC = [
  { name: 'owner', type: 'address' },
  { name: 'kind', type: 'uint8' },
  { name: 'live', type: 'bool' },
  { name: 'tick', type: 'int24' },
  { name: 'tag', type: 'bytes2' },
  { name: 'n', type: 'uint256' },
] as const;
const REC_VALUE = { owner: OWNER, kind: 255, live: true, tick: -9, tag: '0xbeef', n: 77n };
const REC_NARROW = [N.address, N.uint8, N.bool, N.int24, N.bytes2];

const NAMED = [
  { name: 'kind', type: 'uint8' },
  { name: 'name', type: 'string' },
] as const;

export interface StrictShape {
  readonly label: string;
  readonly outputs: readonly AbiParameter[];
  /** One value per output. */
  readonly values: readonly unknown[];
  /** The narrow words of the encoded payload: each must occur in it exactly once. */
  readonly narrow: readonly Narrow[];
  /** `StrictDecodeReference`'s function decoding this shape as returndata, and as arguments. */
  readonly solc?: { readonly ret: string; readonly arg: string };
}

export const STRICT_SHAPES: readonly StrictShape[] = [
  {
    label: 'one word (uint8)',
    outputs: [{ name: 'a', type: 'uint8' }],
    values: [255],
    narrow: [N.uint8],
  },
  {
    label: 'a run of words (bool, address, uint8, int8, bytes4)',
    outputs: [
      { name: 'a', type: 'bool' },
      { name: 'b', type: 'address' },
      { name: 'c', type: 'uint8' },
      { name: 'd', type: 'int8' },
      { name: 'e', type: 'bytes4' },
    ],
    values: [true, OWNER, 255, -128, '0x11223344'],
    narrow: [N.bool, N.address, N.uint8, N.int8, N.bytes4],
    solc: { ret: 'words', arg: 'argWords' },
  },
  {
    label: 'words around a string (uint16, uint256, string, bool, int16)',
    outputs: [
      { name: 'a', type: 'uint16' },
      { name: 'b', type: 'uint256' },
      { name: 's', type: 'string' },
      { name: 'c', type: 'bool' },
      { name: 'd', type: 'int16' },
    ],
    values: [0xfff0, (1n << 256n) - 1n, 'evs', true, -2],
    narrow: [N.uint16, N.bool, N.int16],
  },
  {
    label: 'static struct',
    outputs: [{ name: 'r', type: 'tuple', components: REC }],
    values: [REC_VALUE],
    narrow: REC_NARROW,
    solc: { ret: 'rec', arg: 'argRec' },
  },
  {
    label: 'dynamic struct (uint8, string)',
    outputs: [{ name: 'r', type: 'tuple', components: NAMED }],
    values: [{ kind: 255, name: 'evs' }],
    narrow: [N.uint8],
    solc: { ret: 'named', arg: 'argNamed' },
  },
  {
    label: 'uint8[]',
    outputs: [{ name: 'r', type: 'uint8[]' }],
    values: [[255]],
    narrow: [N.uint8],
    solc: { ret: 'kinds', arg: 'argKinds' },
  },
  {
    label: 'int16[3]',
    outputs: [{ name: 'r', type: 'int16[3]' }],
    values: [[7, -2, 9]],
    narrow: [N.int16],
    solc: { ret: 'ticks', arg: 'argTicks' },
  },
  {
    label: 'static struct array',
    outputs: [{ name: 'r', type: 'tuple[]', components: REC }],
    // two elements, so the length word is not the `true` of the first one
    values: [[REC_VALUE, { owner: OTHER, kind: 3, live: false, tick: 4, tag: '0x0001', n: 8n }]],
    narrow: REC_NARROW,
    solc: { ret: 'recs', arg: 'argRecs' },
  },
  {
    label: 'bool[][]',
    outputs: [{ name: 'r', type: 'bool[][]' }],
    // the lengths are 2, so the one `true` is the payload's only word 1
    values: [
      [
        [false, false],
        [false, true],
      ],
    ],
    narrow: [N.bool],
    solc: { ret: 'grid', arg: 'argGrid' },
  },
  {
    label: 'address[2][] (heap-frame path)',
    outputs: [{ name: 'r', type: 'address[2][]' }],
    values: [[[OTHER, OWNER]]],
    narrow: [N.address],
  },
  {
    label: 'int16[][][] (heap-frame over the stack path)',
    outputs: [{ name: 'r', type: 'int16[][][]' }],
    values: [[[[7, 9], [-2]]]],
    narrow: [N.int16],
  },
  {
    label: 'struct holding a narrow array and a word after it',
    outputs: [
      {
        name: 'r',
        type: 'tuple',
        components: [
          { name: 'xs', type: 'uint8[]' },
          { name: 'tag', type: 'bytes2' },
        ],
      },
    ],
    values: [{ xs: [7, 255], tag: '0xbeef' }],
    narrow: [N.uint8, N.bytes2],
  },
  {
    label: 'struct nested three deep (a framed inner struct)',
    outputs: [
      {
        name: 'r',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          {
            name: 'mid',
            type: 'tuple',
            components: [
              { name: 'note', type: 'string' },
              {
                name: 'leaf',
                type: 'tuple',
                components: [
                  { name: 'label', type: 'string' },
                  { name: 'live', type: 'bool' },
                  { name: 'tick', type: 'int24' },
                  { name: 'owner', type: 'address' },
                ],
              },
            ],
          },
        ],
      },
    ],
    values: [
      { id: 5n, mid: { note: 'nn', leaf: { label: 'lbl', live: true, tick: -9, owner: OWNER } } },
    ],
    narrow: [N.bool, N.int24, N.address],
  },
];

/** The clean payload of a shape, and one `[label, payload]` per dirty word. */
export function payloadsOf(shape: StrictShape): {
  clean: Hex;
  dirty: readonly (readonly [string, Hex])[];
} {
  const clean = encodeAbiParameters(shape.outputs, shape.values as never);
  const ws = wordsOf(clean);
  const dirty = shape.narrow.flatMap((n) => {
    const at = ws.flatMap((w, i) => (w === n.clean ? [i] : []));
    if (at.length !== 1) {
      throw new Error(`${shape.label}: clean word ${n.clean} occurs ${at.length} times`);
    }
    return n.dirty.map(
      (bad) =>
        [
          `word #${at[0]} = ${bad}`,
          concatHex(...ws.map((w, i) => (i === at[0] ? bad : w))),
        ] as const,
    );
  });
  return { clean, dirty };
}
