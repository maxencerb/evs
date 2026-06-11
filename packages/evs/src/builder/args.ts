/**
 * M5 `builder/args.ts` — re-exports the `arg()`/`t` wiring (module-interfaces §M5).
 *
 * The declarators themselves live in `core/types.ts` (single source of truth); this module
 * exists so the builder package-internally owns the user-facing args surface.
 */

export { arg, t } from '../core/types.js';
export type { ArgSpec, ArgType } from '../core/types.js';
