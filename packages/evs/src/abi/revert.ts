/**
 * `abi/revert.ts` — the revert-payload classifier shared by the artifact's `explainRevert`
 * (`compile.ts`) and the client-side `decodeScriptError` / `matchScriptError` (`viem.ts`), and
 * the per-ABI error selector table it matches against.
 *
 * Both callers must agree on what a payload IS (a panic, an `Error(string)`, which ABI error,
 * or nothing known); they only differ in how they present it. Keeping the byte-level decisions
 * here is what keeps them in lockstep (`revert.test.ts` feeds one payload corpus to both).
 *
 * Precedence, first match wins:
 *   empty (0 bytes) · short (1–3 bytes, no selector) · `Panic(uint256)` (exactly 36 bytes) ·
 *   `Error(string)` (a payload that decodes) · an ABI error entry by selector (args `null` when
 *   the payload does not decode against its inputs) · unknown selector.
 */

import { bytesToBigInt, hexToBytes } from '../core/bytes.js';
import type { Hex } from '../core/types.js';
import type { PlainAbiParam } from '../ir/nodes.js';
import {
  decodeErrorArgsRecord,
  ERROR_STRING_SELECTOR,
  errorSelectorOf,
  PANIC_SELECTOR,
} from './artifact.js';

/** One `{ type: 'error' }` entry of an ABI, normalized. */
export interface AbiErrorEntry {
  readonly name: string;
  readonly inputs: readonly PlainAbiParam[];
}

/** What a revert payload is, before any presentation. */
export type RevertClass =
  | { readonly kind: 'empty' }
  | { readonly kind: 'short' } // 1–3 bytes: too short to carry a selector
  | { readonly kind: 'panic'; readonly code: bigint }
  | { readonly kind: 'error-string'; readonly reason: string }
  | {
      readonly kind: 'abi-error';
      readonly selector: Hex;
      readonly entry: AbiErrorEntry;
      // `null`: the selector matched but the payload does not decode against the entry's inputs
      readonly args: Readonly<Record<string, unknown>> | null;
    }
  | { readonly kind: 'unknown'; readonly selector: Hex };

const ERROR_STRING_INPUTS: readonly PlainAbiParam[] = [{ name: 'reason', type: 'string' }];

/** Classifies `raw` (0x-prefixed, even-length hex — validated by the caller) against `table`. */
export function classifyRevert(raw: Hex, table: ReadonlyMap<Hex, AbiErrorEntry>): RevertClass {
  const bytes = hexToBytes(raw);
  if (bytes.length === 0) return { kind: 'empty' };
  if (bytes.length < 4) return { kind: 'short' };
  const selector: Hex = `0x${raw.slice(2, 10).toLowerCase()}`;
  const payload: Hex = `0x${raw.slice(10)}`;

  if (selector === PANIC_SELECTOR && bytes.length === 36) {
    return { kind: 'panic', code: bytesToBigInt(bytes, 4) };
  }
  if (selector === ERROR_STRING_SELECTOR) {
    const decoded = decodeErrorArgsRecord(ERROR_STRING_INPUTS, payload);
    const reason = decoded?.['reason'];
    if (typeof reason === 'string') return { kind: 'error-string', reason };
  }
  const entry = table.get(selector);
  if (entry !== undefined) {
    return {
      kind: 'abi-error',
      selector,
      entry,
      args: decodeErrorArgsRecord(entry.inputs, payload),
    };
  }
  return { kind: 'unknown', selector };
}

// ---------------------------------------------------------------------------
// the per-ABI error table
// ---------------------------------------------------------------------------

const TABLES = new WeakMap<object, ReadonlyMap<Hex, AbiErrorEntry>>();
const NO_ERRORS: ReadonlyMap<Hex, AbiErrorEntry> = new Map();

/**
 * The `selector → error entry` table of an (untrusted) ABI array: every well-formed
 * `{ type: 'error', name }` entry, first entry wins on a selector clash. Malformed entries are
 * skipped, never thrown on — decode helpers must not crash on a foreign ABI.
 *
 * Built once per FROZEN array (script ABIs are frozen by `buildScriptAbi`), so a decode costs a
 * map lookup instead of one keccak per error entry; a mutable array is rebuilt on every call so
 * a later edit is never served from a stale table.
 */
export function errorTableOf(abi: readonly unknown[]): ReadonlyMap<Hex, AbiErrorEntry> {
  if (!Array.isArray(abi)) return NO_ERRORS; // a JS caller's non-array "ABI" matches nothing
  const cached = TABLES.get(abi);
  if (cached !== undefined) return cached;
  const table = new Map<Hex, AbiErrorEntry>();
  const entries: readonly unknown[] = abi;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { type?: unknown; name?: unknown; inputs?: unknown };
    if (e.type !== 'error' || typeof e.name !== 'string') continue;
    const inputs = plainInputsOf(e.inputs);
    const selector = errorSelectorOf(e.name, inputs);
    if (!table.has(selector)) table.set(selector, { name: e.name, inputs });
  }
  if (Object.isFrozen(abi)) TABLES.set(abi, table);
  return table;
}

/** An ABI entry's `inputs`, normalized to `PlainAbiParam`s (anything but an array → none). */
function plainInputsOf(inputs: unknown): readonly PlainAbiParam[] {
  if (!Array.isArray(inputs)) return [];
  const list: readonly unknown[] = inputs;
  return list.map(toPlainParam);
}

/** One (untrusted) ABI parameter → a `PlainAbiParam` (`name` defaulted to '', recursive over
 *  `components`). A malformed entry degrades to an empty type string, which simply never
 *  matches a selector downstream. */
function toPlainParam(p: unknown): PlainAbiParam {
  if (typeof p !== 'object' || p === null) return { name: '', type: '' };
  const o = p as { name?: unknown; type?: unknown; components?: unknown };
  const name = typeof o.name === 'string' ? o.name : '';
  const type = typeof o.type === 'string' ? o.type : '';
  if (Array.isArray(o.components)) {
    const comps: readonly unknown[] = o.components;
    return { name, type, components: comps.map(toPlainParam) };
  }
  return { name, type };
}
