/**
 * `codegen/codecs.ts` — @internal shared codec subroutines (issue #95): a tuple or composite-array
 * codec that several call sites of one program repeat is emitted once, as a checked subroutine
 * among the tails, and each site calls it instead of inlining it.
 *
 * - `planCodecs` decides, per compile, which uses share a body (the census and the cost model).
 * - `CodecShare` is the `CodecHook` (`abi/shared.ts`) the ABI emitters call at each use: it emits
 *   the call of a planned use and leaves every other use to its inline emitter.
 *
 * An empty plan (nothing pays) builds no `CodecShare`, so the program is byte-identical to the
 * inline lowering. CONTRIBUTING.md's "Shared codecs" design note has the conventions.
 */

import type { TypeLayout } from '../abi/layout.js';
import type { EvmVersion } from '../asm/ops.js';
import { EvsInternalError } from '../core/errors.js';
import type { ScriptIr } from '../ir/nodes.js';
import type { EncodeMemberKind } from './codec-keys.js';

// ---------------------------------------------------------------------------
// drift: a planner / emitter disagreement
// ---------------------------------------------------------------------------

/**
 * @internal The census and the emitters disagree on a planned codec (a use count, or whether a
 * decoder body can fail). Never wrong code: emission never shares an unplanned use, and the
 * mismatch is caught before the program is returned. `compile()` catches exactly this class and
 * lowers again with sharing off, so a lowering path the census does not know only costs the
 * saving. Under {@link setCodecPlanStrict} (the test setup) `lowerProgram` reports it as an
 * `INTERNAL` error instead.
 */
export class CodecPlanDrift extends Error {
  constructor(message: string) {
    super(`codegen/codecs: ${message}`);
    this.name = 'CodecPlanDrift';
  }
}

let strictPlan = false;

/** @internal Test setup only: report a {@link CodecPlanDrift} as an `INTERNAL` error instead of
 *  falling back to the inline lowering, so every test exercises the census against the emitters. */
export function setCodecPlanStrict(on: boolean): void {
  strictPlan = on;
}

/** @internal Whether {@link setCodecPlanStrict} is on. */
export function codecPlanStrict(): boolean {
  return strictPlan;
}

/** The error a drift becomes: `INTERNAL` under the strict test setup, else a {@link CodecPlanDrift}. */
export function driftError(message: string): Error {
  return strictPlan
    ? new EvsInternalError('INTERNAL', `codegen/codecs: ${message}`)
    : new CodecPlanDrift(message);
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

/** What one shared body does. */
export type CodecUnit =
  | { readonly dir: 'enc'; readonly kind: EncodeMemberKind; readonly layout: TypeLayout }
  | {
      readonly dir: 'dec';
      readonly region: 'ret';
      readonly layout: TypeLayout;
      readonly headOffset: number;
      readonly budget: 'off' | 'once';
    }
  | {
      readonly dir: 'dec';
      readonly region: 'sim';
      readonly layout: Extract<TypeLayout, { kind: 'tuple' }>;
      readonly budget: 'off' | 'once';
    };

/** One shared key: its body, and the uses that call it. */
export interface PlannedKey {
  readonly key: string;
  readonly unit: CodecUnit;
  /** Planned calls per statement site id (`RETURNS_SITE` for the return encode). */
  readonly groups: ReadonlyMap<number, number>;
  /** A decoder body that can fail (its sites then check the returned pointer). */
  readonly canFail: boolean;
}

export interface CodecPlan {
  readonly keys: ReadonlyMap<string, PlannedKey>;
  /** Codec register words reserved after the static frame: `RET`, then `BASE`, then `SRC`. */
  readonly words: number;
}

export const EMPTY_CODEC_PLAN: CodecPlan = { keys: new Map(), words: 0 };

/** Decides which codec uses of `ir` share a body. */
export function planCodecs(
  _ir: ScriptIr,
  _opts: { readonly evmVersion: EvmVersion; readonly frameEnd: number; readonly optimize: boolean },
): CodecPlan {
  return EMPTY_CODEC_PLAN;
}
