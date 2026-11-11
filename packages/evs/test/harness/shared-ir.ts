/**
 * Test harness — hand-built IR whose one statement object occurs at two places in the tree,
 * the shape `ir/dce.ts` supports and the guard-facts analysis (`codegen/lower/guards.ts`) must
 * not prove from one guarded occurrence.
 */

import { evscript } from '../../src/builder/script.js';
import { t } from '../../src/core/types.js';
import type { ScriptIr, Stmt } from '../../src/ir/nodes.js';
import { validateIr } from '../../src/ir/validate.js';

/**
 * Hand-built IR that places ONE statement object at two places: `out = newArray(2)`, then
 * `if (i < out.length) { S }` followed by `S` again (the same object). `nested` makes `S` an
 * `if (flag) { out[i] = 7 }`, so the shared `if` walks its `arrset` under different facts.
 * An `arrset` (or an `if` of one) defines no value, so `validateIr` accepts the sharing.
 */
export function sharedStatementIr(nested: boolean): {
  readonly name: string;
  readonly ir: ScriptIr;
  readonly abi: readonly unknown[];
} {
  const rec = evscript({ name: 'shared', args: [t.uint256, t.bool] }, (s, i, flag) => {
    const v = s.lit(t.uint256, 7n); // recorded before the guard: both occurrences see it
    const out = s.newArray(t.uint256, 2n);
    const canary = s.newArray(t.uint256, 2n); // sits right after `out` in memory
    s.if(i.lt(out.expr().length()), () => {
      if (nested) s.if(flag, () => out.set(i, v));
      else out.set(i, v);
    });
    return s.return({ out: out.expr(), canary: canary.expr() });
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a plain JSON copy of the IR
  const ir = JSON.parse(JSON.stringify(rec.ir)) as { body: Stmt[] } & ScriptIr;
  const at = ir.body.findIndex((st) => st.k === 'if');
  const guard = ir.body[at];
  if (guard?.k !== 'if') throw new Error('no guard if');
  const shared = guard.then.find((st) => st.k === (nested ? 'if' : 'arrset'));
  if (shared === undefined) throw new Error('no shared statement');
  ir.body.splice(at + 1, 0, shared);
  validateIr(ir);
  return { name: 'shared', ir, abi: rec.abi };
}
