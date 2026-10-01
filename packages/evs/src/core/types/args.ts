/**
 * `core/types/args.ts` — the `namedArg()` declarator, args-input normalization (shared by
 * `evscript` args, `s.fn` params and `t.error` params), and the `t.error` declaration types.
 */

import { EvsTypeError, type EvsErrorCode } from '../errors.js';
import type { TypeToComponent } from './derive.js';
import { assertEvsType, isEvsValueType, isTupleType, describeRejectedType } from './predicates.js';
import type { ArgType, EvsType, TupleType } from './vocabulary.js';

// ---------------------------------------------------------------------------
// namedArg() declarator + the `t` type namespace
// ---------------------------------------------------------------------------

export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name;
  readonly type: type;
}

/**
 * A Solidity-style identifier (arg / param / field / error / return names), except `__proto__`:
 * every such name becomes an object key somewhere (viem's decoded results, the `Tuple` field
 * accessors, the decoded error args), and assigning `__proto__` on a plain object replaces its
 * prototype instead of creating the key, so the member would silently vanish. Third-party ABI
 * component names are only checked where they enter the script's own ABI (`buildScriptAbi`);
 * elsewhere a handle reads such a member through `.at(i)`.
 */
export const IDENT_RE = /^(?!__proto__$)[A-Za-z_]\w*$/;

/** Why `__proto__` is refused as a name, in the words every rejection message uses. */
export const PROTO_RESERVED =
  "`__proto__` is reserved: assigning it on a JavaScript object (viem's decoded result included) replaces the object's prototype instead of storing the value, so the value would be lost";

/**
 * The plain-language reason `name` fails {@link IDENT_RE}: {@link PROTO_RESERVED} for
 * `__proto__` (an identifier, just a reserved one), else the identifier rule itself.
 */
export function identProblem(name: unknown): string {
  return name === '__proto__'
    ? PROTO_RESERVED
    : 'must be a non-empty identifier matching /^[A-Za-z_]\\w*$/';
}

/**
 * Whether a name-keyed record (a `t.struct` spec, an `s.return` record) is a plain object whose
 * keys `Object.entries` sees in full. A literal `{ __proto__: x }` key never becomes an entry: an
 * object or `null` value replaces the record's prototype, so the prototype must be a root
 * prototype (`Object.prototype`, of any realm). A primitive value (`{ __proto__: t.uint256 }`) is
 * dropped by JavaScript without a trace at runtime; the `NoProtoKey` type guard covers that case.
 */
export function hasPlainPrototype(o: object): boolean {
  const proto: unknown = Object.getPrototypeOf(o);
  return proto !== null && Object.getPrototypeOf(proto) === null;
}

/**
 * Type-level guard for the name-keyed records of `t.struct` and `s.return`: `unknown` (a no-op in
 * a `rec & …` parameter) unless the record has a literal `__proto__` key; then a required,
 * self-describing property, so the call fails to typecheck with a message naming the reason. A
 * `__proto__` key in an object literal is not a member at runtime (it sets the prototype or, for
 * a primitive value such as `t.uint256`, is dropped), so without this guard the type would carry
 * a component the runtime never sees. A widened `Record<string, …>` passes.
 */
export type NoProtoKey<rec> = string extends keyof rec
  ? unknown
  : '__proto__' extends keyof rec
    ? {
        readonly '`__proto__` is reserved: an object-literal `__proto__` key sets the prototype instead of declaring a member, so the value would be lost — rename it': never;
      }
    : unknown;

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
      `invalid argument name ${JSON.stringify(name)}: ${identProblem(name)}`,
    );
  }
  if (typeof type === 'string') {
    assertEvsType(type, `argument "${name}"`);
  } else if (!isEvsValueType(type)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `argument "${name}": expected a type (use the \`t\` namespace), got ${describeRejectedType(type)}`,
    );
  }
  return Object.freeze({ name, type });
}

// ---------------------------------------------------------------------------
// args-input normalization (shared by `evscript` args, `s.fn` params, `t.error` params)
// ---------------------------------------------------------------------------
// The type-level normalization (`NormalizeArgs`) and its runtime mirror (`normalizeArgsInput`)
// live side by side so the declarator rules cannot drift between the types and the three
// declaring sites.

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

/** One declarator → its normalized {@link ArgSpec}: a tuple descriptor that carries its own
 *  `name` (an ABI parameter such as `abi[0].inputs[0]`) is named by it, like a scalar ABI
 *  parameter (which already matches `ArgSpec`); a {@link namedArg} keeps its spec; any other bare
 *  type becomes an unnamed spec (`name: ''`) — the positional `arg{i}` fallback name is applied
 *  downstream (`ResolveArgName` / {@link normalizeArgsInput}). The tuple arm comes FIRST, as in
 *  {@link isArgSpecValue}: a struct-array parameter (`{ name, type: 'tuple[]', components }`)
 *  also matches `ArgSpec`, because `'tuple[]'` fits `ArrayType`'s catch-all pattern, and would
 *  otherwise be read as a string array of `tuple` (element `never`). A real `ArgSpec` over a
 *  tuple has an object `type`, so it never matches the tuple arm. */
export type ToArgSpec<d> = d extends TupleType & { readonly name: infer name extends string }
  ? ArgSpec<name, { readonly type: d['type']; readonly components: d['components'] }>
  : d extends ArgSpec
    ? d
    : d extends EvsType
      ? ArgSpec<'', d>
      : never;

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

/**
 * A {@link namedArg}-shaped {@link ArgSpec} value: a plain object carrying a string `name` and a
 * `type`. A bare type is a string or a {@link TupleType} object; a tuple descriptor may carry a
 * `name` of its own (an ABI parameter `{ name, type: 'tuple', components }`), so it is excluded
 * here and stays a type — an `ArgSpec` over a tuple has an OBJECT `type`, never the tag string.
 */
export function isArgSpecValue(v: unknown): v is { readonly name: string; readonly type: unknown } {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || isTupleType(v)) return false;
  return typeof (v as { name?: unknown }).name === 'string' && 'type' in v;
}

/** Where a declarator list is normalized: the message prefix (`evscript "quote"`, `s.fn("f")`,
 *  `t.error("Bad")`), what one entry is called, and the code for a bad or duplicate name. */
export interface ArgsSite {
  readonly owner: string;
  readonly noun: 'arg' | 'param';
  readonly nameCode: EvsErrorCode;
}

/** One normalized declarator: its declared `name` (`''` for a bare type, the sentinel the types
 *  use too), its `label` (`name`, or the positional `arg{i}` fallback) and its validated type. */
export interface NormalizedArg {
  readonly name: string;
  readonly label: string;
  readonly type: EvsType;
}

/**
 * The runtime mirror of {@link NormalizeArgs}, shared by `evscript` args, `s.fn` params and
 * `t.error` params so the three surfaces classify declarators identically: `undefined` → none, a
 * lone declarator → a one-element list; each entry is an {@link ArgSpec} value (its name must be
 * an identifier, or `''` for the positional fallback) or a bare type — a tuple descriptor that
 * carries a `name` (an ABI parameter) is named by it and reduced to `{ type, components }`.
 * Labels must be unique (`site.nameCode`); a type outside the vocabulary is `TYPE_MISMATCH`
 * (`UNSUPPORTED_V0` for over-deep arrays).
 */
export function normalizeArgsInput(input: unknown, site: ArgsSite): NormalizedArg[] {
  let decls: readonly unknown[];
  if (input === undefined) decls = [];
  else if (Array.isArray(input)) decls = input;
  else decls = [input];
  const seen = new Set<string>();
  return decls.map((d, i): NormalizedArg => {
    let name: string;
    let type: unknown;
    if (isArgSpecValue(d)) {
      ({ name, type } = d);
    } else if (isTupleType(d) && 'name' in d && typeof d.name === 'string') {
      name = d.name;
      type = isEvsValueType(d) ? Object.freeze({ type: d.type, components: d.components }) : d;
    } else {
      name = '';
      type = d;
    }
    const at = `${site.owner} ${site.noun} #${i}`;
    if (name !== '' && !IDENT_RE.test(name)) {
      throw new EvsTypeError(
        site.nameCode,
        `${at}: invalid ${site.noun} name ${JSON.stringify(name)}: ${identProblem(name)}`,
      );
    }
    const ctx = name === '' ? at : `${at} ("${name}")`;
    if (typeof type === 'string') {
      assertEvsType(type, ctx);
    } else if (!isEvsValueType(type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${ctx}: expected a type (use the \`t\` namespace) or namedArg(...), got ${describeRejectedType(type)}`,
      );
    }
    const label = name === '' ? `arg${i}` : name;
    if (seen.has(label)) {
      throw new EvsTypeError(
        site.nameCode,
        `${site.owner}: duplicate ${site.noun} name "${label}"`,
      );
    }
    seen.add(label);
    return { name, label, type };
  });
}

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
 * (`selectorOf` in abi/artifact.ts — core takes no runtime code from viem, only types),
 * byte-identical to Solidity's over the canonical signature.
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
