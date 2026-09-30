/**
 * `core/signature.ts` — canonical ABI function signatures (`name(type,…)`), the overload
 * disambiguation key shared by the calling verbs (`s.read`/`s.call`/…) and `t.fromOutputs`
 * (issue #4). A `functionName` that contains `(` is a signature reference: it selects exactly one
 * ABI entry, bypassing argument-based overload resolution.
 *
 * The canonical form is the one Solidity hashes into a selector: no parameter names, no spaces,
 * tuples expanded to their component list (`(uint256,address)[]`), full type names (`uint256`,
 * never the `uint` alias). Type-level ({@link AbiFunctionSignature}) and runtime
 * ({@link functionSignature}) forms agree character-for-character.
 */
import type { AbiParameter } from 'abitype';

/** One ABI parameter → its canonical type string (a `tuple…` expands to `(c1,c2)…`). */
export type AbiParameterSignature<p extends AbiParameter> = p extends {
  readonly type: `tuple${infer suffix}`;
  readonly components: infer comps extends readonly AbiParameter[];
}
  ? `(${AbiParametersSignature<comps>})${suffix}`
  : p['type'];

/** A parameter list → its comma-joined canonical types. */
export type AbiParametersSignature<ps extends readonly AbiParameter[]> = ps extends readonly [
  infer head extends AbiParameter,
  ...infer rest extends readonly AbiParameter[],
]
  ? rest extends readonly []
    ? AbiParameterSignature<head>
    : `${AbiParameterSignature<head>},${AbiParametersSignature<rest>}`
  : ps extends readonly []
    ? ''
    : string; // a non-literal parameter list (widened ABI) → any signature

/** An ABI function entry → its canonical signature, e.g. `'balanceOf(address)'`. Distributes over
 *  a union of entries (one signature per overload). */
export type AbiFunctionSignature<f> = f extends {
  readonly name: infer name extends string;
  readonly inputs: infer inputs extends readonly AbiParameter[];
}
  ? `${name}(${AbiParametersSignature<inputs>})`
  : never;

/** The function-name part of a `functionName` reference (`'get(uint256)'` → `'get'`). */
export type SignatureName<ref extends string> = ref extends `${infer name}(${string}` ? name : ref;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Runtime mirror of {@link AbiParameterSignature}. Malformed entries degrade to their raw `type`
 *  (the caller validates the chosen entry separately). */
export function parameterSignature(p: unknown): string {
  if (!isRecord(p)) return '?';
  const type = typeof p['type'] === 'string' ? p['type'] : '?';
  if (type.startsWith('tuple') && Array.isArray(p['components'])) {
    const comps: readonly unknown[] = p['components'];
    return `(${comps.map(parameterSignature).join(',')})${type.slice('tuple'.length)}`;
  }
  return type;
}

/** Runtime mirror of {@link AbiFunctionSignature}: `name(type,…)` for an ABI function entry. */
export function functionSignature(fn: Record<string, unknown>): string {
  const name = typeof fn['name'] === 'string' ? fn['name'] : '?';
  const inputs: readonly unknown[] = Array.isArray(fn['inputs']) ? fn['inputs'] : [];
  return `${name}(${inputs.map(parameterSignature).join(',')})`;
}

/** Whether a `functionName` is a signature reference (`'get(uint256)'`) rather than a bare name. */
export function isSignatureRef(ref: string): boolean {
  return ref.includes('(');
}

/** A signature reference with whitespace stripped (`'get(uint256, address)'` is accepted). */
export function normalizeSignatureRef(ref: string): string {
  return ref.replace(/\s+/g, '');
}

/** The name part of a (normalized) reference: everything before the first `(`. */
export function signatureRefName(ref: string): string {
  const i = ref.indexOf('(');
  return i === -1 ? ref : ref.slice(0, i);
}

/**
 * The `type: 'function'` entries of `abi` a reference names: a bare name → every entry of that
 * name (all overloads); a signature → the entries whose canonical signature matches (normally one).
 */
export function functionsByRef(
  abi: readonly unknown[],
  ref: string,
): { readonly entries: Record<string, unknown>[]; readonly bySignature: boolean } {
  const bySignature = isSignatureRef(ref);
  const sig = bySignature ? normalizeSignatureRef(ref) : ref;
  const name = signatureRefName(sig);
  const entries = abi.filter(
    (it): it is Record<string, unknown> =>
      isRecord(it) &&
      it['type'] === 'function' &&
      it['name'] === name &&
      (!bySignature || functionSignature(it) === sig),
  );
  return { entries, bySignature };
}
