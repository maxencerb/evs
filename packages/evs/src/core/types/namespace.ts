/**
 * `core/types/namespace.ts` — the `t` type namespace: its overloaded type (`TypeNamespace`), the
 * frozen runtime object, and the runtime constructors behind `t.struct` / `t.tuple` / `t.array`,
 * `t.fromOutputs`, `t.fromAbiParameter` and `t.error`.
 */

import type { Abi, AbiParameter } from 'abitype';

import { EvsTypeError } from '../errors.js';
import { functionsByRef, functionSignature } from '../signature.js';
import { type ArgsInput, type EvsErrorType, type NormalizeArgs, IDENT_RE } from './args.js';
import type {
  TupleArrayOf,
  StructTypeOf,
  TupleTypeOf,
  FromAbiOutputs,
  AbiParamToEvsType,
} from './derive.js';
import {
  assertEvsType,
  isTupleType,
  describeTypeInput,
  assertArrayDepth,
  tupleArrayTag,
  MAX_FIXED_LENGTH,
  abiParamToType,
  isEvsValueType,
  typeToAbiParam,
} from './predicates.js';
import type {
  WordType,
  DynType,
  StringType,
  TupleType,
  EvsType,
  NamedType,
  ArrayType,
} from './vocabulary.js';

type TypeNamespace = { readonly [k in WordType | DynType]: k } & {
  // `t.array(elem)` → a dynamic `elem[]`; `t.array(elem, n)` → a fixed-size `elem[n]` (n ≥ 1,
  // a literal number). Both nest to any depth (`t.array(t.array(t.uint256, 2))` → `uint256[2][]`).
  array<const e extends StringType>(elem: e): `${e}[]`;
  array<const e extends StringType, const n extends number>(elem: e, length: n): `${e}[${n}]`;
  array<const e extends TupleType>(elem: e): TupleArrayOf<e>;
  array<const e extends TupleType, const n extends number>(elem: e, length: n): TupleArrayOf<e, n>;
  struct<const spec extends Record<string, EvsType>>(spec: spec): StructTypeOf<spec>;
  tuple<const items extends readonly EvsType[]>(...items: items): TupleTypeOf<items>;
  // declare a custom error (issue #15): params take the same shorthand as `evscript` args /
  // `s.fn` params — a bare `t.*` type, a single `namedArg(...)`, or a `readonly` list mixing
  // named and bare (bare params get the positional `arg{i}` fallback name).
  error<const name extends string, const params extends ArgsInput = readonly []>(
    name: name,
    params?: params,
  ): EvsErrorType<name, NormalizeArgs<params>>;
  // derive a `t.*` type from an ABI function's outputs / a single ABI parameter (issue #5 ask #4):
  fromOutputs<const abi extends Abi | readonly unknown[], const name extends string>(
    abi: abi,
    name: name,
  ): FromAbiOutputs<abi, name>;
  fromAbiParameter<const p extends AbiParameter>(param: p): AbiParamToEvsType<p>;
};

// frozen namespace: the overloaded method types are the authority; the impls are intentionally
// `unknown`-typed and validate at runtime (double-cast through `unknown`).
/* oxlint-disable typescript/no-unsafe-type-assertion */
export const t: TypeNamespace = Object.freeze({
  address: 'address',
  bool: 'bool',
  uint8: 'uint8',
  uint16: 'uint16',
  uint24: 'uint24',
  uint32: 'uint32',
  uint40: 'uint40',
  uint48: 'uint48',
  uint56: 'uint56',
  uint64: 'uint64',
  uint72: 'uint72',
  uint80: 'uint80',
  uint88: 'uint88',
  uint96: 'uint96',
  uint104: 'uint104',
  uint112: 'uint112',
  uint120: 'uint120',
  uint128: 'uint128',
  uint136: 'uint136',
  uint144: 'uint144',
  uint152: 'uint152',
  uint160: 'uint160',
  uint168: 'uint168',
  uint176: 'uint176',
  uint184: 'uint184',
  uint192: 'uint192',
  uint200: 'uint200',
  uint208: 'uint208',
  uint216: 'uint216',
  uint224: 'uint224',
  uint232: 'uint232',
  uint240: 'uint240',
  uint248: 'uint248',
  uint256: 'uint256',
  int8: 'int8',
  int16: 'int16',
  int24: 'int24',
  int32: 'int32',
  int40: 'int40',
  int48: 'int48',
  int56: 'int56',
  int64: 'int64',
  int72: 'int72',
  int80: 'int80',
  int88: 'int88',
  int96: 'int96',
  int104: 'int104',
  int112: 'int112',
  int120: 'int120',
  int128: 'int128',
  int136: 'int136',
  int144: 'int144',
  int152: 'int152',
  int160: 'int160',
  int168: 'int168',
  int176: 'int176',
  int184: 'int184',
  int192: 'int192',
  int200: 'int200',
  int208: 'int208',
  int216: 'int216',
  int224: 'int224',
  int232: 'int232',
  int240: 'int240',
  int248: 'int248',
  int256: 'int256',
  bytes1: 'bytes1',
  bytes2: 'bytes2',
  bytes3: 'bytes3',
  bytes4: 'bytes4',
  bytes5: 'bytes5',
  bytes6: 'bytes6',
  bytes7: 'bytes7',
  bytes8: 'bytes8',
  bytes9: 'bytes9',
  bytes10: 'bytes10',
  bytes11: 'bytes11',
  bytes12: 'bytes12',
  bytes13: 'bytes13',
  bytes14: 'bytes14',
  bytes15: 'bytes15',
  bytes16: 'bytes16',
  bytes17: 'bytes17',
  bytes18: 'bytes18',
  bytes19: 'bytes19',
  bytes20: 'bytes20',
  bytes21: 'bytes21',
  bytes22: 'bytes22',
  bytes23: 'bytes23',
  bytes24: 'bytes24',
  bytes25: 'bytes25',
  bytes26: 'bytes26',
  bytes27: 'bytes27',
  bytes28: 'bytes28',
  bytes29: 'bytes29',
  bytes30: 'bytes30',
  bytes31: 'bytes31',
  bytes32: 'bytes32',
  string: 'string',
  bytes: 'bytes',
  array(elem: unknown, length?: unknown): unknown {
    return arrayTypeRT(elem, length);
  },
  struct(spec: unknown): unknown {
    return structTypeRT(spec);
  },
  tuple(...items: unknown[]): unknown {
    return tupleTypeRT(items);
  },
  error(name: unknown, params?: unknown): unknown {
    return errorTypeRT(name, params);
  },
  fromOutputs(abi: unknown, name: unknown): unknown {
    return fromOutputsRT(abi, name);
  },
  fromAbiParameter(param: unknown): unknown {
    return fromAbiParameterRT(param);
  },
} as const) as unknown as TypeNamespace;
/* oxlint-enable typescript/no-unsafe-type-assertion */

// ---------------------------------------------------------------------------
// `t.struct` / `t.tuple` / `t.array` runtime constructors
// ---------------------------------------------------------------------------

/** A user-supplied member/element type → a canonical {@link NamedType} component. Accepts a
 *  type string, a {@link TupleType}, or a raw `readonly AbiParameter[]` (interpreted as a tuple's
 *  components). */
function toComponentRT(name: string, ty: unknown, ctx: string): NamedType {
  if (typeof ty === 'string') {
    assertEvsType(ty, ctx);
    return Object.freeze({ name, type: ty });
  }
  if (isTupleType(ty)) {
    return Object.freeze({
      name,
      type: ty.type,
      components: normalizeComponents(ty.components, ctx),
    });
  }
  if (Array.isArray(ty)) {
    return Object.freeze({ name, type: 'tuple', components: componentsFromAbi(ty, ctx) });
  }
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `${ctx}: expected a type (use the \`t\` namespace), got ${describeTypeInput(ty)}`,
  );
}

function normalizeComponents(components: readonly NamedType[], ctx: string): readonly NamedType[] {
  return Object.freeze(
    components.map((c) =>
      c.components === undefined
        ? toComponentRT(c.name, c.type, ctx)
        : Object.freeze({
            name: c.name,
            type: c.type,
            components: normalizeComponents(c.components, ctx),
          }),
    ),
  );
}

/** Validate + canonicalize a raw `readonly AbiParameter[]` into tuple components. */
function componentsFromAbi(params: readonly unknown[], ctx: string): readonly NamedType[] {
  if (params.length === 0) {
    throw new EvsTypeError('TYPE_MISMATCH', `${ctx}: a tuple must have at least one component`);
  }
  return Object.freeze(
    params.map((p, i) => {
      if (typeof p !== 'object' || p === null) {
        throw new EvsTypeError('TYPE_MISMATCH', `${ctx}: component #${i} is not an ABI parameter`);
      }
      const o = p as { name?: unknown; type?: unknown; components?: unknown };
      const name = typeof o.name === 'string' ? o.name : '';
      if (typeof o.type !== 'string') {
        throw new EvsTypeError('TYPE_MISMATCH', `${ctx}: component #${i} has no \`type\``);
      }
      if (o.type.startsWith('tuple')) {
        if (!Array.isArray(o.components)) {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${ctx}: tuple component #${i} ("${name}") has no \`components\``,
          );
        }
        return Object.freeze({
          name,
          type: o.type,
          components: componentsFromAbi(o.components, ctx),
        });
      }
      assertEvsType(o.type, `${ctx} component #${i}`);
      return Object.freeze({ name, type: o.type });
    }),
  );
}

function structTypeRT(spec: unknown): TupleType {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `t.struct(): expected a record of { field: type }, got ${describeTypeInput(spec)}`,
    );
  }
  const entries = Object.entries(spec);
  if (entries.length === 0) {
    throw new EvsTypeError('TYPE_MISMATCH', `t.struct(): a struct must have at least one field`);
  }
  const components = entries.map(([name, ty]) => {
    if (!IDENT_RE.test(name)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `t.struct(): field name ${JSON.stringify(name)} must be a non-empty identifier (an empty/odd name would collapse the struct to a positional array on the viem side)`,
      );
    }
    return toComponentRT(name, ty, `t.struct() field "${name}"`);
  });
  return Object.freeze({ type: 'tuple', components: Object.freeze(components) });
}

function tupleTypeRT(items: readonly unknown[]): TupleType {
  if (items.length === 0) {
    throw new EvsTypeError('TYPE_MISMATCH', `t.tuple(): a tuple must have at least one member`);
  }
  const components = items.map((ty, i) => toComponentRT('', ty, `t.tuple() member #${i}`));
  return Object.freeze({ type: 'tuple', components: Object.freeze(components) });
}

/** `t.array(elem)` → `elem[]`; `t.array(elem, n)` → `elem[n]`. The suffix string is validated
 *  through the same parser every other entry point uses (`isEvsType`/`isTupleTag`), so the
 *  runtime and type-level vocabularies agree by construction; nesting is capped at
 *  {@link MAX_ARRAY_DEPTH} (`UNSUPPORTED_V0` beyond). */
function arrayTypeRT(elem: unknown, length: unknown): EvsType {
  const suffix = arraySuffixRT(length, 't.array()');
  if (typeof elem === 'string') {
    assertEvsType(elem, 't.array() element');
    const type: ArrayType = `${elem}${suffix}`;
    assertArrayDepth(type, 't.array()');
    return type;
  }
  const fixed = suffix === '[]' ? null : Number(suffix.slice(1, -1));
  if (isTupleType(elem)) {
    const type = tupleArrayTag(elem.type, fixed);
    assertArrayDepth(type, 't.array()');
    return Object.freeze({
      type,
      components: normalizeComponents(elem.components, 't.array()'),
    });
  }
  if (Array.isArray(elem)) {
    return Object.freeze({
      type: tupleArrayTag('tuple', fixed),
      components: componentsFromAbi(elem, 't.array()'),
    });
  }
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `t.array(): element type ${describeTypeInput(elem)} is not a type (use the \`t\` namespace)`,
  );
}

/** The `[]` / `[n]` suffix for an optional fixed length: `undefined` → dynamic; otherwise a
 *  positive safe integer below 2^32 (the allocation cap) → fixed. */
function arraySuffixRT(length: unknown, ctx: string): '[]' | `[${number}]` {
  if (length === undefined) return '[]';
  const n = typeof length === 'bigint' ? Number(length) : length;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_FIXED_LENGTH) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${ctx}: a fixed array length must be a positive integer below 2^32, got ${describeTypeInput(length)}`,
    );
  }
  return `[${n}]`;
}

/** A non-null, non-array object — narrows `unknown` to a property-indexable record. */
function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `t.fromOutputs(abi, name)` runtime: locate the single function `name` selects — a bare name, or a
 * canonical signature `'get(uint256)'` for an overloaded function (issue #4; there are no args to
 * resolve overloads by, so an overloaded bare name is an `ABI_SHAPE` ambiguity listing the
 * signatures) — validate + canonicalize its outputs through {@link componentsFromAbi},
 * and return a SINGLE output's {@link EvsType} directly or wrap MANY outputs in a `tuple`
 * {@link TupleType} (named, in ABI order). The result flows wherever a `t.struct`/`t.tuple` type
 * does and round-trips with a `s.read({…, struct: true})` decode of the same function.
 */
function fromOutputsRT(abi: unknown, name: unknown): EvsType {
  if (typeof name !== 'string') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `t.fromOutputs(): functionName must be a string, got ${describeTypeInput(name)}`,
    );
  }
  if (!Array.isArray(abi)) {
    throw new EvsTypeError('ABI_SHAPE', `t.fromOutputs("${name}"): abi must be an ABI array`);
  }
  // `Array.isArray` narrows `abi` to `any[]`; re-widen to `unknown[]` so member access is guarded.
  const entries: readonly unknown[] = abi;
  const { entries: found, bySignature } = functionsByRef(entries, name);
  // identical entries (an ABI listing the same function twice) are one function
  const fns = [...new Map(found.map((f) => [functionSignature(f), f] as const)).values()];
  if (fns.length === 0) {
    const what = bySignature ? `with signature "${name}"` : `named "${name}"`;
    throw new EvsTypeError(
      'ABI_SHAPE',
      `t.fromOutputs("${name}"): the provided ABI has no function ${what}`,
    );
  }
  if (fns.length > 1) {
    throw new EvsTypeError(
      'ABI_SHAPE',
      `t.fromOutputs("${name}"): function "${name}" is overloaded (${fns.map(functionSignature).join(', ')}) — name one by its signature, e.g. t.fromOutputs(abi, "${functionSignature(fns[0] ?? {})}")`,
    );
  }
  const outputs = fns[0]?.outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new EvsTypeError(
      'ABI_SHAPE',
      `t.fromOutputs("${name}"): function "${name}" has no outputs to derive a type from`,
    );
  }
  const components = componentsFromAbi(outputs, `t.fromOutputs("${name}")`);
  const single = components[0];
  if (components.length === 1 && single !== undefined) return abiParamToType(single);
  return Object.freeze({ type: 'tuple', components });
}

// ---------------------------------------------------------------------------
// `t.error` runtime (issue #15)
// ---------------------------------------------------------------------------

/** Names a user error may not take, because they already name an arm of the client-side
 *  switch: Panic/Error (Solidity built-ins) and EvsDecodeError/EvsInvalidCalldata (the evs
 *  runtime) have their own selectors and decode arms; 'empty'/'unknown' are the built-in
 *  decode arms for an empty revert and an unrecognized selector; '_' is the matchScriptError
 *  default-arm key. Sharing a `name` discriminant with any of them would route those reverts
 *  to the declared handler. Mirrored in `buildScriptAbi` (abi/artifact.ts). */
const RESERVED_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Panic',
  'Error',
  'EvsDecodeError',
  'EvsInvalidCalldata',
  'empty',
  'unknown',
  '_',
]);

/**
 * A {@link namedArg}-produced {@link ArgSpec} value: a plain object carrying a string `name` (a bare
 * type is a string; a bare composite type is a {@link TupleType} object, which has no `name`). Used
 * to distinguish a named declarator from a bare one when normalizing `evscript` args / `s.fn` params
 * / `t.error` params.
 */
export function isArgSpecValue(v: unknown): v is { readonly name: string; readonly type: unknown } {
  return isRecordObject(v) && typeof (v as { name?: unknown }).name === 'string' && 'type' in v;
}

function errorTypeRT(name: unknown, paramsIn: unknown): EvsErrorType {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new EvsTypeError(
      'ERROR_DECL',
      `t.error(): error name must be a non-empty identifier, got ${describeTypeInput(name)}`,
    );
  }
  if (RESERVED_ERROR_NAMES.has(name)) {
    throw new EvsTypeError(
      'ERROR_DECL',
      `t.error("${name}"): the name is reserved (Panic/Error are Solidity built-ins; EvsDecodeError/EvsInvalidCalldata belong to the evs runtime; empty/unknown are built-in decode arms; _ is the matchScriptError default arm) — pick another name`,
    );
  }
  let decls: readonly unknown[];
  if (paramsIn === undefined) {
    decls = [];
  } else if (Array.isArray(paramsIn)) {
    decls = paramsIn;
  } else {
    decls = [paramsIn];
  }
  const params = decls.map((d, i): { name: string; type: EvsType } => {
    const ctx = `t.error("${name}") param #${i}`;
    if (isArgSpecValue(d)) {
      if (d.name !== '' && !IDENT_RE.test(d.name)) {
        throw new EvsTypeError(
          'ERROR_DECL',
          `${ctx}: invalid param name ${JSON.stringify(d.name)} (must be a non-empty identifier)`,
        );
      }
      const ty: unknown = d.type;
      if (typeof ty === 'string') {
        assertEvsType(ty, `${ctx} ("${d.name}")`);
        return { name: d.name, type: ty };
      }
      if (!isEvsValueType(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${ctx} ("${d.name}"): expected a type (use the \`t\` namespace), got ${describeTypeInput(ty)}`,
        );
      }
      return { name: d.name, type: ty };
    }
    if (typeof d === 'string') {
      assertEvsType(d, ctx);
      return { name: '', type: d };
    }
    if (isTupleType(d) && isEvsValueType(d)) return { name: '', type: d };
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${ctx}: expected a type or namedArg(...), got ${describeTypeInput(d)}`,
    );
  });
  // resolved (arg{i}-fallback) input names must be unique — the decode utilities key args by name
  const seen = new Set<string>();
  const inputs = params.map((p, i) => {
    const resolved = p.name === '' ? `arg${i}` : p.name;
    if (seen.has(resolved)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `t.error("${name}"): duplicate param name "${resolved}"`,
      );
    }
    seen.add(resolved);
    return typeToAbiParam(resolved, p.type);
  });
  const abi = Object.freeze({
    type: 'error',
    name,
    inputs: Object.freeze(inputs),
  });
  const specs = Object.freeze(params.map((p) => Object.freeze(p)));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the literal type is the overload's authority; the runtime shape is built to match
  return Object.freeze({ kind: 'error', name, params: specs, abi }) as unknown as EvsErrorType;
}

/**
 * `t.fromAbiParameter(param)` runtime: validate + canonicalize one ABI parameter and return its
 * {@link EvsType} (a {@link TupleType} for a `tuple…` param, else the scalar/array string).
 */
function fromAbiParameterRT(param: unknown): EvsType {
  const components = componentsFromAbi([param], 't.fromAbiParameter()');
  const single = components[0];
  if (single === undefined) {
    throw new EvsTypeError('ABI_SHAPE', `t.fromAbiParameter(): missing parameter`);
  }
  return abiParamToType(single);
}
