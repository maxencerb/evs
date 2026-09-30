/**
 * `core/types/args.ts` — the `namedArg()` declarator, args-input normalization (shared by
 * `evscript` args, `s.fn` params and `t.error` params), and the `t.error` declaration types.
 */

import { EvsTypeError } from '../errors.js';
import type { TypeToComponent } from './derive.js';
import { assertEvsType, isEvsValueType, describeTypeInput } from './predicates.js';
import type { ArgType, EvsType } from './vocabulary.js';

// ---------------------------------------------------------------------------
// namedArg() declarator + the `t` type namespace
// ---------------------------------------------------------------------------

export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name;
  readonly type: type;
}

/** A Solidity-style identifier (arg / param / field / error names). */
export const IDENT_RE = /^[A-Za-z_]\w*$/;

/**
 * Names a **top-level** arg/param so the name surfaces in the resulting type (issue #9): in a
 * script's `args`, the viem `args` tuple element is labeled (`[token: …]`); in an `s.fn`'s params,
 * the callback parameter is labeled (`(token) => …`). The `type` bound is {@link EvsType} — the
 * full parameter-type vocabulary (widened by #25 from `StringType`): words, `string`/`bytes`,
 * arrays, and composite `t.struct`/`t.tuple` descriptors (a named struct arg arrives as a `Tuple`
 * handle, exactly like a bare one — in a script's `args` and in an `s.fn`'s params alike). Nested
 * composite fields are named via `t.struct` and keep their behaviour. A bare (unnamed) top-level
 * arg keeps the positional `arg{i}` fallback name.
 */
export function namedArg<const name extends string, const type extends EvsType>(
  name: name,
  type: type,
): ArgSpec<name, type> {
  if (!IDENT_RE.test(name)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `invalid argument name ${JSON.stringify(name)}: must be a non-empty identifier matching /^[A-Za-z_]\\w*$/`,
    );
  }
  if (typeof type === 'string') {
    assertEvsType(type, `argument "${name}"`);
  } else if (!isEvsValueType(type)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `argument "${name}": expected a type (use the \`t\` namespace), got ${describeTypeInput(type)}`,
    );
  }
  return Object.freeze({ name, type });
}

// ---------------------------------------------------------------------------
// args-input normalization (shared by `evscript` args, `s.fn` params, `t.error` params)
// ---------------------------------------------------------------------------
// These lived in builder/script.ts until issue #15; they are pure core/ material (EvsType +
// ArgSpec only) and `t.error` needs them, so they moved here. script.ts re-exports them
// verbatim — the builder's public surface is unchanged.

/**
 * One top-level arg/param declarator (issue #9): a bare `t.*` type, or a
 * {@link namedArg}-produced {@link ArgSpec} that labels the arg.
 */
export type ArgInput = EvsType | ArgSpec;

/**
 * Args/params input: a single {@link ArgInput} (a bare type or a {@link namedArg}), or a `readonly`
 * list of them (mixing named and bare). A lone declarator is sugar for a one-element list
 * (`args: t.uint256` ≡ `args: [t.uint256]`; `args: namedArg('x', t.uint256)` ≡ `args:
 * [namedArg('x', t.uint256)]`) — shared by `evscript` args, `s.fn` params, and `t.error` params.
 */
export type ArgsInput = ArgInput | readonly ArgInput[];

/** One declarator → its normalized {@link ArgSpec}: a {@link namedArg} keeps its spec; a bare type
 *  becomes an unnamed spec (`name: ''`) — the positional `arg{i}` fallback name is applied
 *  downstream (`ResolveArgName` / the recorder). */
export type ToArgSpec<d> = d extends ArgSpec ? d : d extends EvsType ? ArgSpec<'', d> : never;

/** Normalizes {@link ArgsInput} to the canonical `readonly ArgSpec[]` (lone declarator → one-tuple;
 *  homomorphic over a list so order/positions are preserved). */
export type NormalizeArgs<a extends ArgsInput> = a extends readonly ArgInput[]
  ? { readonly [i in keyof a]: ToArgSpec<a[i]> }
  : readonly [ToArgSpec<a>];

// The positional fallback name for arg position `i`: `arg{i}` for a concrete tuple index (a
// numeric-string key), but a plain `string` for the open `number` index of the default
// `readonly ArgSpec[]` instantiation — so `arg0`/`arg1` literals stay assignable to it (vs.
// collapsing to `never`, which would reject every concrete script).
export type ArgName<i> = i extends `${number}` ? `arg${i}` : string;

// The surfaced name of an arg at position `i`: its user-provided {@link namedArg} name, or the
// positional `arg{i}` fallback when the arg was passed bare (an empty sentinel name). issue #9.
export type ResolveArgName<name extends string, i> = name extends '' ? ArgName<i> : name;

// A normalized ArgSpec tuple → labeled abitype input components: each entry is labeled with its
// user name (`namedArg`) or the positional `arg0`/`arg1`/… fallback, and a tuple arg expands to
// `{ name, type: 'tuple', components }` via {@link TypeToComponent}. A purely HOMOMORPHIC mapped
// type — order/labels preserved structurally (no `UnionToTuple`), and no conditional over `args`
// itself, so `args` stays a COVARIANT type parameter. (Moved from abi/artifact.ts — issue #15 —
// which re-exports it; `t.error` uses it for the literal error-ABI inputs.)
export type ArgsToInputs<args extends readonly ArgSpec[]> = {
  readonly [i in keyof args]: TypeToComponent<ResolveArgName<args[i]['name'], i>, args[i]['type']>;
};

// ---------------------------------------------------------------------------
// custom error declarations — `t.error` (issue #15)
// ---------------------------------------------------------------------------

/** The literal `{ type: 'error', name, inputs }` ABI entry carried by an {@link EvsErrorType}
 *  (spreadable into any viem ABI; appended to the script ABI by `buildScriptAbi`). */
export interface EvsErrorAbiEntry<
  name extends string = string,
  params extends readonly ArgSpec[] = readonly ArgSpec[],
> {
  readonly type: 'error';
  readonly name: name;
  readonly inputs: ArgsToInputs<params>;
}

/**
 * A declared custom error (issue #15): a module-level value created by {@link t.error},
 * declared on a script def (`errors: [...]`) and thrown with `s.throw`. Carries the normalized
 * param specs and the literal ABI entry; the 4-byte selector is derived downstream
 * (`selectorOf` in abi/artifact.ts — core stays viem-free), byte-identical to Solidity's over
 * the canonical signature.
 */
export interface EvsErrorType<
  name extends string = string,
  params extends readonly ArgSpec[] = readonly ArgSpec[],
> {
  readonly kind: 'error'; // runtime discriminant (an EvsType is a string or TupleType)
  readonly name: name;
  readonly params: params; // normalized ArgSpecs (namedArg names or '' sentinels)
  readonly abi: EvsErrorAbiEntry<name, params>;
}
