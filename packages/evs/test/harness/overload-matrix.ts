/**
 * The overload-resolution lockstep matrix: ONE table of (overload set, args) cases, each with the
 * outcome both resolvers must reach — the canonical signature of the chosen overload,
 * `'ambiguous'` (the args fit several) or `'none'` (the args fit none of several same-arity
 * overloads). The type-level resolver (`ResolveOverload`, builder/script/calls.ts) is asserted
 * against it in `src/builder/overload-lockstep.test-d.ts`, the recorder (`resolveOverload` /
 * `argFits`, builder/expr/calls.ts) in `src/builder/overload-lockstep.test.ts`; both read the
 * same `expect`, so a case passing on both sides means the two resolvers agree on it.
 *
 * Every overloaded function is a `view` named `f`, so each case is `s.read({ abi, functionName:
 * 'f', args })`. The handles come from the script builder (`s.lit`, `s.newArray`, `s.tuple`), so
 * `overloadCases` runs inside a script body.
 */
import type { Abi } from 'abitype';
import { parseAbi } from 'viem';

import type { ScriptBuilder } from '../../src/builder/script.js';
import { t, type Expr } from '../../src/core/types.js';

type Out = 'bool' | 'address' | 'uint8' | 'uint256' | 'string';

/** Builds a view function `f(inputs) returns (out)` ABI entry. */
function fn<const inputs extends readonly unknown[], const o extends Out>(inputs: inputs, out: o) {
  return {
    type: 'function',
    name: 'f',
    stateMutability: 'view',
    inputs,
    outputs: [{ name: '', type: out }],
  } as const;
}

const A = { name: 'a', type: 'uint256' } as const;
const A_ADDR = { name: 'a', type: 'address' } as const;

export const abis = {
  // #7/#9: a scalar vs a fixed-size array of it
  scalarVsFixed: [
    fn([{ name: 'x', type: 'uint256' }], 'uint8'),
    fn([{ name: 'x', type: 'uint256[2]' }], 'address'),
  ],
  // #7: dynamic vs fixed, and two fixed lengths
  dynVsFixed: [
    fn([{ name: 'x', type: 'uint256[]' }], 'bool'),
    fn([{ name: 'x', type: 'uint256[2]' }], 'address'),
  ],
  fixedVsFixed: [
    fn([{ name: 'x', type: 'uint256[3]' }], 'bool'),
    fn([{ name: 'x', type: 'uint256[2]' }], 'address'),
  ],
  // #9: bytes32 vs bytes32[2] (a 0x literal is not an array)
  bytesVsFixed: [
    fn([{ name: 'x', type: 'bytes32' }], 'uint8'),
    fn([{ name: 'x', type: 'bytes32[2]' }], 'address'),
  ],
  // #6: a struct array vs a scalar array of the same arity
  structArrVsScalarArr: [
    fn([{ name: 'x', type: 'tuple[]', components: [A] }], 'string'),
    fn([{ name: 'x', type: 'uint256[]' }], 'uint256'),
  ],
  // #13: tuple[] overloads differing only by component type
  tupleArrByComponent: [
    fn([{ name: 'x', type: 'tuple[]', components: [A] }], 'uint256'),
    fn([{ name: 'x', type: 'tuple[]', components: [A_ADDR] }], 'uint8'),
  ],
  // #8: tuple[N] vs a scalar
  tupleFixedVsScalar: [
    fn([{ name: 'x', type: 'tuple[2]', components: [A] }], 'bool'),
    fn([{ name: 'x', type: 'uint256' }], 'address'),
  ],
  // #8/#9: tuple[][] vs bool
  tupleNestedVsBool: [
    fn([{ name: 'x', type: 'tuple[][]', components: [A] }], 'address'),
    fn([{ name: 'x', type: 'bool' }], 'uint8'),
  ],
  // tuple[2][] vs tuple[][2] (the fixed length sits at a different depth)
  tupleFixedDepth: [
    fn([{ name: 'x', type: 'tuple[2][]', components: [A] }], 'bool'),
    fn([{ name: 'x', type: 'tuple[][2]', components: [A] }], 'address'),
  ],
  // #8: a scalar array vs a scalar (literals holding Exprs, MutArray handles)
  scalarArrVsScalar: [
    fn([{ name: 'x', type: 'uint256[]' }], 'bool'),
    fn([{ name: 'x', type: 'address' }], 'address'),
  ],
  // #8: MutArray args to scalar-array overloads differing by element type
  scalarArrByElem: [
    fn([{ name: 'x', type: 'uint256[]' }], 'bool'),
    fn([{ name: 'x', type: 'address[]' }], 'address'),
  ],
  // the fixed length at different depths of a two-level chain
  nestedFixedDepth: [
    fn([{ name: 'x', type: 'uint256[2][]' }], 'bool'),
    fn([{ name: 'x', type: 'uint256[][2]' }], 'address'),
  ],
  // depth 3 vs depth 4
  depth4: [
    fn([{ name: 'x', type: 'uint256[][][][]' }], 'bool'),
    fn([{ name: 'x', type: 'uint256[][][]' }], 'uint8'),
  ],
  // a MutArray of arrays (`uint256[][]`) vs its element type
  arrOfArr: [
    fn([{ name: 'x', type: 'uint256[][]' }], 'bool'),
    fn([{ name: 'x', type: 'uint256[]' }], 'address'),
  ],
  // plain tuples: a positional pair in either order; a struct by member type
  positionalTuple: [
    fn(
      [
        {
          name: 'x',
          type: 'tuple',
          components: [
            { name: '', type: 'uint256' },
            { name: '', type: 'address' },
          ],
        },
      ],
      'bool',
    ),
    fn(
      [
        {
          name: 'x',
          type: 'tuple',
          components: [
            { name: '', type: 'address' },
            { name: '', type: 'uint256' },
          ],
        },
      ],
      'uint8',
    ),
  ],
  structByMemberType: [
    fn([{ name: 'x', type: 'tuple', components: [A] }], 'bool'),
    fn([{ name: 'x', type: 'tuple', components: [A_ADDR] }], 'uint8'),
  ],
  // a tuple only partly named: positional (abitype's rule — one unnamed member is enough)
  mixedTuple: [
    fn([{ name: 'x', type: 'tuple', components: [A, { name: '', type: 'address' }] }], 'bool'),
    fn(
      [{ name: 'x', type: 'tuple', components: [A_ADDR, { name: '', type: 'uint256' }] }],
      'uint8',
    ),
  ],
  // the same sets as viem's `parseAbi` emits them: an unnamed member carries NO `name` key (an
  // absent name is unnamed, exactly like `''`), at the top level and nested in a named struct
  mixedTupleParsed: parseAbi([
    'function f((uint256 a, address) x) view returns (bool)',
    'function f((address a, uint256) x) view returns (uint8)',
  ]),
  nestedMixedParsed: parseAbi([
    'function f(((uint256 a, address) s) x) view returns (bool)',
    'function f(((address a, uint256) s) x) view returns (uint8)',
  ]),
} as const satisfies Record<string, Abi>;

/** The first overload's mixed tuple `(uint256 a, address)`, as an evs type (for a Tuple handle). */
const MIXED = t.fromAbiParameter(abis.mixedTuple[0].inputs[0]);
/** The same tuple from the `parseAbi` set (its unnamed member has no `name` key). */
const MIXED_PARSED = t.fromAbiParameter(abis.mixedTupleParsed[0].inputs[0]);

export const ALICE = '0x00000000000000000000000000000000000000a1';
export const HASH = '0x00000000000000000000000000000000000000000000000000000000000000ff';

/** The case table. `x` is a script arg (`Expr<'uint256'>`). */
export function overloadCases(s: ScriptBuilder, x: Expr<'uint256'>) {
  const S = t.struct({ a: t.uint256 });
  const SA = t.struct({ a: t.address });
  return [
    // -- scalar vs T[N] ------------------------------------------------------------------------
    { name: 'scalar literal vs T[N]', abi: abis.scalarVsFixed, args: [5n], expect: 'f(uint256)' },
    {
      name: 'N-literal vs scalar',
      abi: abis.scalarVsFixed,
      args: [[1n, 2n]],
      expect: 'f(uint256[2])',
    },
    {
      name: 'wrong-length literal vs scalar + T[N]',
      abi: abis.scalarVsFixed,
      args: [[1n, 2n, 3n]],
      expect: 'none',
    },
    {
      name: 'T[N] Expr vs scalar',
      abi: abis.scalarVsFixed,
      args: [s.lit(t.array(t.uint256, 2), [1n, 2n])],
      expect: 'f(uint256[2])',
    },
    // -- T[] vs T[N], T[N] vs T[M] --------------------------------------------------------------
    {
      name: '3-literal vs T[] + T[2]',
      abi: abis.dynVsFixed,
      args: [[1n, 2n, 3n]],
      expect: 'f(uint256[])',
    },
    {
      name: '2-literal vs T[] + T[2]',
      abi: abis.dynVsFixed,
      args: [[1n, 2n]],
      expect: 'ambiguous',
    },
    {
      name: 'T[2] Expr vs T[] + T[2]',
      abi: abis.dynVsFixed,
      args: [s.lit(t.array(t.uint256, 2), [1n, 2n])],
      expect: 'f(uint256[2])',
    },
    {
      name: 'T[] Expr vs T[] + T[2]',
      abi: abis.dynVsFixed,
      args: [s.lit(t.array(t.uint256), [1n, 2n])],
      expect: 'f(uint256[])',
    },
    {
      name: 'dynamic MutArray vs T[] + T[2]',
      abi: abis.dynVsFixed,
      args: [s.newArray(t.uint256, 2n)],
      expect: 'f(uint256[])',
    },
    {
      name: 'fixed MutArray vs T[] + T[2]',
      abi: abis.dynVsFixed,
      args: [s.newArray(t.uint256, 2, { fixed: true })],
      expect: 'f(uint256[2])',
    },
    {
      name: '2-literal vs T[3] + T[2]',
      abi: abis.fixedVsFixed,
      args: [[1n, 2n]],
      expect: 'f(uint256[2])',
    },
    {
      name: '3-literal vs T[3] + T[2]',
      abi: abis.fixedVsFixed,
      args: [[1n, 2n, 3n]],
      expect: 'f(uint256[3])',
    },
    {
      name: 'fixed MutArray of the wrong length vs T[3] + T[2]',
      abi: abis.fixedVsFixed,
      args: [s.newArray(t.uint256, 4, { fixed: true })],
      expect: 'none',
    },
    // -- bytes32 vs bytes32[2] ------------------------------------------------------------------
    {
      name: '0x literal vs bytes32[2]',
      abi: abis.bytesVsFixed,
      args: [HASH],
      expect: 'f(bytes32)',
    },
    {
      name: '0x pair vs bytes32',
      abi: abis.bytesVsFixed,
      args: [[HASH, HASH]],
      expect: 'f(bytes32[2])',
    },
    // -- struct[] vs scalar[] (finding 6: the silent mistype) ----------------------------------
    {
      name: 'uint256 MutArray vs S[] + uint256[]',
      abi: abis.structArrVsScalarArr,
      args: [s.newArray(t.uint256, 2n)],
      expect: 'f(uint256[])',
    },
    {
      name: 'struct MutArray vs S[] + uint256[]',
      abi: abis.structArrVsScalarArr,
      args: [s.newArray(S, 2n)],
      expect: 'f((uint256)[])',
    },
    {
      name: 'struct-array Expr vs S[] + uint256[]',
      abi: abis.structArrVsScalarArr,
      args: [s.newArray(S, 2n).expr()],
      expect: 'f((uint256)[])',
    },
    {
      name: 'record-array literal vs S[] + uint256[]',
      abi: abis.structArrVsScalarArr,
      args: [[{ a: 1n }]],
      expect: 'f((uint256)[])',
    },
    {
      name: 'number-array literal vs S[] + uint256[]',
      abi: abis.structArrVsScalarArr,
      args: [[1n, x]],
      expect: 'f(uint256[])',
    },
    {
      name: 'empty array literal vs S[] + uint256[]',
      abi: abis.structArrVsScalarArr,
      args: [[]],
      expect: 'ambiguous',
    },
    // -- tuple[] by component type (finding 13) -------------------------------------------------
    {
      name: '{a: uint256} MutArray vs (uint256)[] + (address)[]',
      abi: abis.tupleArrByComponent,
      args: [s.newArray(S, 2n)],
      expect: 'f((uint256)[])',
    },
    {
      name: '{a: address} MutArray vs (uint256)[] + (address)[]',
      abi: abis.tupleArrByComponent,
      args: [s.newArray(SA, 2n)],
      expect: 'f((address)[])',
    },
    {
      name: '{a: address} literal vs (uint256)[] + (address)[]',
      abi: abis.tupleArrByComponent,
      args: [[{ a: ALICE }]],
      expect: 'f((address)[])',
    },
    {
      name: 'fixed struct MutArray vs (uint256)[] + (address)[]',
      abi: abis.tupleArrByComponent,
      args: [s.newArray(S, 2, { fixed: true })],
      expect: 'none',
    },
    // -- tuple[N] vs scalar (finding 8) ---------------------------------------------------------
    {
      name: 'tuple[2] Expr vs tuple[2] + uint256',
      abi: abis.tupleFixedVsScalar,
      args: [s.newArray(S, 2, { fixed: true }).expr()],
      expect: 'f((uint256)[2])',
    },
    {
      name: 'tuple[2] MutArray vs tuple[2] + uint256',
      abi: abis.tupleFixedVsScalar,
      args: [s.newArray(S, 2, { fixed: true })],
      expect: 'f((uint256)[2])',
    },
    {
      name: 'tuple[2] literal vs tuple[2] + uint256',
      abi: abis.tupleFixedVsScalar,
      args: [[{ a: 1n }, { a: x }]],
      expect: 'f((uint256)[2])',
    },
    {
      name: 'scalar vs tuple[2] + uint256',
      abi: abis.tupleFixedVsScalar,
      args: [x],
      expect: 'f(uint256)',
    },
    {
      name: 'tuple[] Expr (dynamic) vs tuple[2] + uint256',
      abi: abis.tupleFixedVsScalar,
      args: [s.newArray(S, 2n).expr()],
      expect: 'none',
    },
    // -- tuple[][] ------------------------------------------------------------------------------
    {
      name: 'tuple[][] Expr vs tuple[][] + bool',
      abi: abis.tupleNestedVsBool,
      args: [s.newArray(t.array(S), 1n).expr()],
      expect: 'f((uint256)[][])',
    },
    {
      name: 'tuple[][] MutArray vs tuple[][] + bool',
      abi: abis.tupleNestedVsBool,
      args: [s.newArray(t.array(S), 1n)],
      expect: 'f((uint256)[][])',
    },
    {
      name: 'tuple[][] literal vs tuple[][] + bool',
      abi: abis.tupleNestedVsBool,
      args: [[[{ a: 1n }], []]],
      expect: 'f((uint256)[][])',
    },
    {
      name: 'bool vs tuple[][] + bool',
      abi: abis.tupleNestedVsBool,
      args: [true],
      expect: 'f(bool)',
    },
    {
      name: 'tuple[2][] literal vs tuple[2][] + tuple[][2]',
      abi: abis.tupleFixedDepth,
      args: [[[{ a: 1n }, { a: 2n }]]],
      expect: 'f((uint256)[2][])',
    },
    {
      name: 'tuple[][2] literal vs tuple[2][] + tuple[][2]',
      abi: abis.tupleFixedDepth,
      args: [[[{ a: 1n }], []]],
      expect: 'f((uint256)[][2])',
    },
    {
      name: 'tuple[2][2] literal vs tuple[2][] + tuple[][2]',
      abi: abis.tupleFixedDepth,
      args: [
        [
          [{ a: 1n }, { a: 2n }],
          [{ a: 3n }, { a: 4n }],
        ],
      ],
      expect: 'ambiguous',
    },
    {
      name: 'tuple[2][] MutArray vs tuple[2][] + tuple[][2]',
      abi: abis.tupleFixedDepth,
      args: [s.newArray(t.array(S, 2), 1n)],
      expect: 'f((uint256)[2][])',
    },
    // -- scalar arrays: Expr-bearing literals, MutArrays (finding 8) ---------------------------
    {
      name: 'literal holding an Expr vs uint256[] + address',
      abi: abis.scalarArrVsScalar,
      args: [[x, 2n]],
      expect: 'f(uint256[])',
    },
    {
      name: 'MutArray vs uint256[] + address',
      abi: abis.scalarArrVsScalar,
      args: [s.newArray(t.uint256, 2n)],
      expect: 'f(uint256[])',
    },
    {
      name: 'address vs uint256[] + address',
      abi: abis.scalarArrVsScalar,
      args: [ALICE],
      expect: 'f(address)',
    },
    {
      name: 'uint256 MutArray vs uint256[] + address[]',
      abi: abis.scalarArrByElem,
      args: [s.newArray(t.uint256, 2n)],
      expect: 'f(uint256[])',
    },
    {
      name: 'address MutArray vs uint256[] + address[]',
      abi: abis.scalarArrByElem,
      args: [s.newArray(t.address, 2n)],
      expect: 'f(address[])',
    },
    {
      name: 'uint8 MutArray vs uint256[] + address[]',
      abi: abis.scalarArrByElem,
      args: [s.newArray(t.uint8, 2n)],
      expect: 'none',
    },
    // -- nested scalar chains, fixed at different depths, depth 4 ------------------------------
    {
      name: '[[a, b]] vs uint256[2][] + uint256[][2]',
      abi: abis.nestedFixedDepth,
      args: [[[1n, 2n]]],
      expect: 'f(uint256[2][])',
    },
    {
      name: '[[a], [b, c]] vs uint256[2][] + uint256[][2]',
      abi: abis.nestedFixedDepth,
      args: [[[1n], [2n, x]]],
      expect: 'f(uint256[][2])',
    },
    {
      name: '[[a, b], [c, d]] vs uint256[2][] + uint256[][2]',
      abi: abis.nestedFixedDepth,
      args: [
        [
          [1n, 2n],
          [3n, 4n],
        ],
      ],
      expect: 'ambiguous',
    },
    {
      name: 'uint256[][2] Expr vs uint256[2][] + uint256[][2]',
      abi: abis.nestedFixedDepth,
      args: [s.lit(t.array(t.array(t.uint256), 2), [[1n], []])],
      expect: 'f(uint256[][2])',
    },
    {
      name: 'uint256[2] MutArray (a uint256[2][]) vs uint256[2][] + uint256[][2]',
      abi: abis.nestedFixedDepth,
      args: [s.newArray(t.array(t.uint256, 2), 1n)],
      expect: 'f(uint256[2][])',
    },
    {
      name: 'depth-4 literal vs depth 4 + depth 3',
      abi: abis.depth4,
      args: [[[[[1n, x]]]]],
      expect: 'f(uint256[][][][])',
    },
    {
      name: 'depth-3 literal vs depth 4 + depth 3',
      abi: abis.depth4,
      args: [[[[1n]]]],
      expect: 'f(uint256[][][])',
    },
    {
      name: 'depth-4 Expr vs depth 4 + depth 3',
      abi: abis.depth4,
      args: [s.newArray(t.array(t.array(t.array(t.uint256))), 1n).expr()],
      expect: 'f(uint256[][][][])',
    },
    {
      name: 'uint256[] MutArray vs uint256[][] + uint256[]',
      abi: abis.arrOfArr,
      args: [s.newArray(t.array(t.uint256), 1n)],
      expect: 'f(uint256[][])',
    },
    // -- plain tuples ---------------------------------------------------------------------------
    {
      name: 'positional literal vs (uint256,address) + (address,uint256)',
      abi: abis.positionalTuple,
      args: [[1n, ALICE]],
      expect: 'f((uint256,address))',
    },
    {
      name: 'positional Tuple handle vs (uint256,address) + (address,uint256)',
      abi: abis.positionalTuple,
      args: [s.tuple(t.tuple(t.address, t.uint256), [ALICE, x])],
      expect: 'f((address,uint256))',
    },
    {
      name: '{a: uint256} Tuple handle vs (uint256 a) + (address a)',
      abi: abis.structByMemberType,
      args: [s.tuple(S, { a: x })],
      expect: 'f((uint256))',
    },
    {
      name: '{a: address} record vs (uint256 a) + (address a)',
      abi: abis.structByMemberType,
      args: [{ a: ALICE }],
      expect: 'f((address))',
    },
    // -- partly named tuples (abitype's positional rule) ----------------------------------------
    {
      name: 'positional [uint256, address] vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTuple,
      args: [[1n, ALICE]],
      expect: 'f((uint256,address))',
    },
    {
      name: 'positional [address, uint256] vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTuple,
      args: [[ALICE, x]],
      expect: 'f((address,uint256))',
    },
    {
      name: '{a} record vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTuple,
      args: [{ a: 1n }],
      expect: 'none',
    },
    {
      name: 'mixed Tuple handle vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTuple,
      args: [s.tuple(MIXED, [x, ALICE])],
      expect: 'f((uint256,address))',
    },
    // -- the same, from parseAbi (an unnamed member has no `name` key) ---------------------------
    {
      name: 'parseAbi: positional [uint256, address] vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTupleParsed,
      args: [[1n, ALICE]],
      expect: 'f((uint256,address))',
    },
    {
      name: 'parseAbi: positional [address, uint256] vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTupleParsed,
      args: [[ALICE, x]],
      expect: 'f((address,uint256))',
    },
    {
      name: 'parseAbi: {a} record vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTupleParsed,
      args: [{ a: 1n }],
      expect: 'none',
    },
    {
      name: 'parseAbi: mixed Tuple handle vs (uint256 a, address) + (address a, uint256)',
      abi: abis.mixedTupleParsed,
      args: [s.tuple(MIXED_PARSED, [x, ALICE])],
      expect: 'f((uint256,address))',
    },
    {
      name: 'parseAbi: {s: [uint256, address]} vs nested (uint256 a, address) + (address a, uint256)',
      abi: abis.nestedMixedParsed,
      args: [{ s: [x, ALICE] }],
      expect: 'f(((uint256,address)))',
    },
    {
      name: 'parseAbi: {s: {a}} vs nested (uint256 a, address) + (address a, uint256)',
      abi: abis.nestedMixedParsed,
      args: [{ s: { a: ALICE } }],
      expect: 'none',
    },
  ] as const;
}

export type OverloadCases = ReturnType<typeof overloadCases>;
