/**
 * `builder/expr.ts` — the module-private recording engine.
 *
 * A barrel over `builder/expr/`: the handle classes (`handles.ts`), the shared helpers
 * (`helpers.ts`), and `Recorder`, built as a chain of layers, each extending the previous one:
 * `core.ts` (value / scope bookkeeping, visibility, literal coercion, cells) → `composites.ts`
 * (tuples, struct fields, mutable arrays) → `encode.ts` (`s.encode` / `s.keccak256`) → `ops.ts`
 * (arithmetic / compare / bit ops, conversions, `select`) → `control.ts` (`s.throw`, `if` /
 * loops) → `calls.ts` (the call verbs and overload resolution) → `recorder.ts` (`s.fn`,
 * `s.return`, `finish`).
 *
 * Implements the builder's recording invariants (value semantics, scope rule, staging traps,
 * constant folding). This file has no public exports of its own — the public surface lives in
 * `builder/script.ts`; everything here is internal to the builder module.
 *
 * Key mechanisms:
 * - Handle internals live in module-private WeakMaps keyed by the handle object
 *   (`{ owner: Recorder; id }`) — unforgeable; lookup miss / owner mismatch →
 *   `EvsScopeError(FOREIGN_HANDLE)` naming both scripts.
 * - Staging traps (`valueOf`/`toString`/`toJSON`/`Symbol.toPrimitive` throw; node inspect is
 *   non-throwing) are installed once on the `Expr` / `Tuple` handle prototypes via core's
 *   `installStagingTraps`.
 * - Scope stack: main → (if-then | if-else | while-header → while-body | fn-body). A value is
 *   usable iff its defining scope is on the current stack; the while body is a child of the
 *   header scope; `s.fn` bodies push an isolated stack (params only — no outer capture).
 * - All-literal pure ops (`bin`/`un`/`convert`/`select` with a literal condition) fold at
 *   recording; folds that would certainly Panic throw `EvsTypeError(CERTAIN_PANIC)` with the
 *   documented escape hatch (route one operand through a cell).
 */

export { assertV0Type } from './expr/helpers.js';
export type { RecErrorDecl } from './expr/core.js';
export { Recorder } from './expr/recorder.js';
