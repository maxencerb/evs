/**
 * Test harness — hand-built IR whose `bytes` / `string` const literal is passed as a call
 * argument with its `[len][payload…]` image stopped at the declared length, padded part of the
 * way, or fully padded (the builder's own shape). `validateIr` accepts all three (the padding
 * past `len` is zero); codegen must encode them identically.
 */

import { evscript } from '../../src/builder/script.js';
import { t } from '../../src/core/types.js';
import type { ScriptIr, Stmt } from '../../src/ir/nodes.js';
import { validateIr } from '../../src/ir/validate.js';
import { SINK } from './differential.js';

export type LiteralPadding = 'exact' | 'partial' | 'full';
/** `flat`: the calldata template; `recursive`: a tuple arg routes the site to the recursive encoder. */
export type CallArgPath = 'flat' | 'recursive';

const takeAbi = (kind: 'bytes' | 'string') =>
  [
    {
      type: 'function',
      name: 'flat',
      stateMutability: 'view',
      inputs: [
        { name: 'v', type: 'uint256' },
        { name: 'd', type: kind },
      ],
      outputs: [{ name: '', type: 'bytes' }],
    },
    {
      type: 'function',
      name: 'recursive',
      stateMutability: 'view',
      inputs: [
        { name: 'v', type: 'uint256' },
        { name: 'd', type: kind },
        {
          name: 'p',
          type: 'tuple',
          components: [
            { name: 'a', type: 'uint256' },
            { name: 'b', type: 'uint256' },
          ],
        },
      ],
      outputs: [{ name: '', type: 'bytes' }],
    },
  ] as const;

/** 3 payload bytes: `0xaabbcc` / `'abc'`. */
const PAYLOAD = { bytes: 'aabbcc', string: '616263' } as const;

/** Re-pads the image `hex` (`[len][payload…]`) to `padding`. */
function repad(hex: string, padding: LiteralPadding): `0x${string}` {
  const len = Number(BigInt(`0x${hex.slice(2, 66)}`));
  const payload = hex.slice(66, 66 + 2 * len);
  const tail = { exact: '', partial: '00'.repeat(5), full: hex.slice(66 + 2 * len) }[padding];
  return `0x${hex.slice(2, 66)}${payload}${tail}`;
}

/** The script `(v) => s.read(SINK.<path>(v, <literal>[, (1, 2)]))`, its literal re-padded. */
export function dataLiteralArgIr(
  kind: 'bytes' | 'string',
  path: CallArgPath,
  padding: LiteralPadding,
): { readonly name: string; readonly ir: ScriptIr; readonly abi: readonly unknown[] } {
  const abi = takeAbi(kind);
  const rec = evscript({ name: 'lit', args: [t.uint256] }, (s, v) => {
    const lit = kind === 'bytes' ? s.lit(t.bytes, `0x${PAYLOAD.bytes}`) : s.lit(t.string, 'abc');
    const out =
      path === 'flat'
        ? s.read({ address: SINK, abi, functionName: 'flat', args: [v, lit] })
        : s.read({
            address: SINK,
            abi,
            functionName: 'recursive',
            args: [v, lit, { a: 1n, b: 2n }],
          });
    return s.return({ out });
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a plain JSON copy of the IR
  const ir = JSON.parse(JSON.stringify(rec.ir)) as { body: Stmt[] } & ScriptIr;
  const lits = ir.body.filter((st) => st.k === 'const' && st.type === kind);
  if (lits.length !== 1) throw new Error(`expected one ${kind} const, got ${lits.length}`);
  const [c] = lits;
  if (c?.k !== 'const' || c.data.kind !== 'data') throw new Error('no data literal');
  if (!c.data.hex.slice(66).startsWith(PAYLOAD[kind])) throw new Error('unexpected payload');
  c.data = { kind: 'data', hex: repad(c.data.hex, padding) };
  validateIr(ir);
  return { name: 'lit', ir, abi: rec.abi };
}
