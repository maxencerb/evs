/**
 * The decode-work budget's call-site gate (`needsDecodeBudget`): which output shapes reserve and
 * initialise the budget word and charge it, and which compile without any of that machinery
 * because no payload can exhaust it (the overlap-attack semantics are pinned by the differential
 * suite in `differential/decode-bounds.test.ts`).
 */
import type { Abi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { evscript } from '../../builder/script.js';
import { compile } from '../../compile.js';
import { t, type Expr, type NamedType } from '../../core/types.js';
import { needsDecodeBudget } from './decode.js';

const out = (type: string, components?: readonly NamedType[]): NamedType =>
  components === undefined ? { name: '', type } : { name: '', type, components };
const words = (...types: readonly string[]): NamedType[] =>
  types.map((type, i) => ({ name: `m${i}`, type }));

/** Output lists whose only charge site is one array decoded once: never budgeted. */
const UNBUDGETED: readonly [string, readonly NamedType[]][] = [
  ['string[]', [out('string[]')]],
  ['bytes[]', [out('bytes[]')]],
  ['(uint256,address)[]', [out('tuple[]', words('uint256', 'address'))]],
  ['uint256[][]', [out('uint256[][]')]],
  ['uint256[2][]', [out('uint256[2][]')]],
  ['(uint256,string[]) (one array in a struct)', [out('tuple', words('uint256', 'string[]'))]],
  ['(uint64[]) (one narrow copy in a struct)', [out('tuple', words('uint64[]'))]],
  ['string[] next to words and strings', [out('uint256'), out('string[]'), out('string')]],
  // no charge site at all (unchanged)
  ['uint64[]', [out('uint64[]')]],
  ['(uint256,string)', [out('tuple', words('uint256', 'string'))]],
];

/** Output lists with a charge site that can repeat, or several sites: always budgeted. */
const BUDGETED: readonly [string, readonly NamedType[]][] = [
  ['uint64[][]', [out('uint64[][]')]],
  ['uint256[][][]', [out('uint256[][][]')]],
  ['(string,uint256)[] (dynamic struct elements)', [out('tuple[]', words('string', 'uint256'))]],
  ['(uint8[])[]', [out('tuple[]', words('uint8[]'))]],
  ['string[3][] (its string[3] elements re-decode)', [out('string[3][]')]],
  ['(string[],string[])', [out('tuple', words('string[]', 'string[]'))]],
  ['string[], string[] (two outputs)', [out('string[]'), out('string[]')]],
  ['string[], (uint64[])', [out('string[]'), out('tuple', words('uint64[]'))]],
];

describe('needsDecodeBudget', () => {
  test.each(UNBUDGETED)('%s: no budget', (_, outputs) => {
    expect(needsDecodeBudget(outputs)).toBe(false);
  });
  test.each(BUDGETED)('%s: budgeted', (_, outputs) => {
    expect(needsDecodeBudget(outputs)).toBe(true);
  });
});

type Verb = 'read' | 'tryRead' | 'simulate' | 'trySimulate';
const VERBS: readonly Verb[] = ['read', 'tryRead', 'simulate', 'trySimulate'];

/** Whether `f(address)`, one `verb` over `g() returns (outputs)`, initialises a decode budget. */
function initsDecodeBudget(outputs: readonly NamedType[], verb: Verb): boolean {
  const abi: Abi = [
    {
      type: 'function',
      name: 'g',
      stateMutability: verb === 'read' || verb === 'tryRead' ? 'view' : 'nonpayable',
      inputs: [],
      outputs: [...outputs],
    },
  ];
  type Loose = Record<
    Verb,
    (o: { address: Expr<'address'>; abi: Abi; functionName: 'g' }) => unknown
  >;
  const script = evscript({ name: 'f', args: [t.address] }, (s, target) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose verb surface over a run-time ABI
    (s as unknown as Loose)[verb]({ address: target, abi, functionName: 'g' });
    return s.return({ target });
  });
  return compile(script).sourceMap.segments.some((seg) => seg.note === 'decode budget slack');
}

describe('call sites initialise the budget only where needsDecodeBudget asks', () => {
  for (const verb of VERBS) {
    test(`${verb}: string[], bytes[] and (uint256,address)[] outputs carry no budget`, () => {
      for (const [, outputs] of UNBUDGETED.slice(0, 4)) {
        expect(initsDecodeBudget(outputs, verb)).toBe(false);
      }
    });
    test(`${verb}: uint64[][] and two string[] outputs keep it`, () => {
      expect(initsDecodeBudget([out('uint64[][]')], verb)).toBe(true);
      expect(initsDecodeBudget([out('string[]'), out('string[]')], verb)).toBe(true);
    });
  }
});
