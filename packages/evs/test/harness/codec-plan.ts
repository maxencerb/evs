/**
 * The codec planner against its exhaustive reference (`src/codegen/codecs.ts`): the compile-time
 * shortcuts `planCodecs` takes (the candidate scan's early exit, the per-mode measurements, the
 * early reject, the lazy registers and peephole) must never change a decision. Unit-tier helper.
 */

import type { EvmVersion } from '../../src/asm/ops.js';
import {
  mayUseCodec,
  planCodecs,
  returnsMayUseCodec,
  type CodecPlan,
} from '../../src/codegen/codecs.js';
import { layoutFrames } from '../../src/codegen/frame.js';
import { eliminateDeadCode } from '../../src/ir/dce.js';
import { walkStmts, type ScriptIr } from '../../src/ir/nodes.js';

/** A plan as plain data, key order included. */
export function planData(plan: CodecPlan): unknown {
  return {
    words: plan.words,
    keys: [...plan.keys].map(([key, k]) => [key, k.canFail, [...k.groups]]),
  };
}

/**
 * The plan `lowerProgram` takes for `ir` (recorded, before DCE) and the exhaustive reference
 * plan, both as {@link planData}. When the candidate scan finds nothing, the fast plan is the
 * empty one `lowerProgram` uses without planning.
 */
export function plannerAgainstReference(
  ir: ScriptIr,
  evmVersion: EvmVersion,
  optimize: boolean,
): { readonly fast: unknown; readonly reference: unknown; readonly candidates: boolean } {
  const dced = eliminateDeadCode(ir);
  let candidates = returnsMayUseCodec(dced);
  const scan = (stmts: ScriptIr['body']): void =>
    walkStmts(stmts, (s) => {
      candidates ||= mayUseCodec(dced, s);
    });
  scan(dced.body);
  for (const fn of dced.fns) scan(fn.body);
  const opts = {
    evmVersion,
    optimize,
    frameEnd: layoutFrames(dced, { optimize }).frameEnd,
    measureFrameEnd: () => layoutFrames(dced, { optimize: false }).frameEnd,
  };
  return {
    fast: planData(planCodecs(dced, { ...opts, candidates })),
    reference: planData(planCodecs(dced, { ...opts, exhaustive: true })),
    candidates,
  };
}
