/**
 * `abi/artifact.ts` — the literal-typed `ScriptAbi`, its runtime mirror, the evs error ABI,
 * selectors, and the recording-time literal encoders.
 *
 * `viem` is the sanctioned runtime peer here (selectors + ABI encoding of literals).
 *
 * Type-level design: the return record becomes ONE output of type `'tuple'` with fully-named
 * components, so viem infers an *object* — immune to the abitype `UnionToTuple`
 * interning-order instability. Script inputs map over the normalized arg SPEC tuple
 * (`readonly ArgSpec[]`, order-preserving by construction), labeling each input with its
 * user-provided name (`namedArg`, issue #9) or the positional `arg0`/`arg1`/… fallback for a
 * bare arg — the labels are positional, so they never touch `UnionToTuple`.
 */

import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  decodeAbiParameters,
  encodeAbiParameters,
  toFunctionSelector,
} from 'viem';

import type { ReturnValue, TypeOfReturn } from '../builder/script.js';
import { EvsTypeError } from '../core/errors.js';
import {
  abiParamToType,
  assertArrayDepth,
  bitsOf,
  IDENT_RE,
  identProblem,
  PROTO_RESERVED,
  isSigned,
  isTupleTag,
  isWordType,
  typeToAbiParam,
  type ArgSpec,
  type ArgsToInputs,
  type ArrayType,
  type DynType,
  type EvsErrorType,
  type EvsType,
  type Hex,
  type TupleType,
  type TypeToComponent,
  type UnionToTuple,
  type WordType,
} from '../core/types.js';
import type { PlainAbiFunction, PlainAbiParam } from '../ir/nodes.js';
import { layoutOf, layoutOfType } from './layout.js';

// ---------------------------------------------------------------------------
// error ABI
// ---------------------------------------------------------------------------

export const EVS_ERROR_ABI = [
  { type: 'error', name: 'EvsInvalidCalldata', inputs: [] },
  { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
] as const satisfies Abi;

// ---------------------------------------------------------------------------
// ScriptAbi — the literal type
// ---------------------------------------------------------------------------

// The return record's keys are ordered with `UnionToTuple` (core/types/derive.ts, the
// tail-recursive form, so a wide return record stays typed): the resulting tuple ORDER is
// interning-dependent and unstable, but SAFE here — viem infers an object from a fully-named
// single tuple output, and objects are order-insensitive.
// Each return key → an abitype component via {@link TypeToComponent}: a scalar/array member to
// `{ name, type }`, a tuple/struct member to `{ name, type: 'tuple'|…, components }` (so a tuple
// flows out as a named ABI tuple, not a raw {@link TupleType} object).
type MapComponents<keys, ret extends Record<string, ReturnValue>> = keys extends readonly unknown[]
  ? {
      readonly [i in keyof keys]: keys[i] extends keyof ret & string
        ? TypeToComponent<keys[i], TypeOfReturn<ret[keys[i]]>>
        : never;
    }
  : never;
// Non-literal `ret` (i.e. the default `Record<string, ReturnValue>` instantiation) widens to a plain
// readonly components array instead of collapsing to a `UnionToTuple<string>` 1-tuple — that
// collapse made the default-instantiated `ScriptAbi`/`EvsScript`/`CompiledEvsScript` reject
// every concrete multi-return script. A literal components tuple IS assignable to the readonly
// array form, so the default instantiation is now a proper supertype (pinned by type tests).
export type ReturnSpecToComponents<ret extends Record<string, ReturnValue>> =
  string extends keyof ret
    ? readonly { readonly name: string; readonly type: EvsType }[]
    : MapComponents<UnionToTuple<keyof ret>, ret>;

// `ArgName` / `ResolveArgName` / `ArgsToInputs` (the input-labeling machinery) moved to
// core/types.ts (issue #15 — `t.error` types its ABI inputs with them and core takes no
// non-abitype imports); re-exported here verbatim so this module's public surface is unchanged.
export type { ArgName, ArgsToInputs, ResolveArgName } from '../core/types.js';

/** The literal-typed error entries appended to {@link ScriptAbi} for the DECLARED errors
 *  (issue #15): each `t.error` value's `{ type: 'error', name, inputs }` shape, order-preserving
 *  (homomorphic). The wide default instantiation degrades to a plain readonly array, keeping the
 *  default-instantiation-supertype property. */
export type ErrorsToAbi<errs extends readonly EvsErrorType[]> = {
  readonly [i in keyof errs]: errs[i]['abi'];
};

export type ScriptAbi<
  name extends string,
  args extends readonly ArgSpec[],
  ret extends Record<string, ReturnValue>,
  // declared custom errors (issue #15) — appended AFTER the evs built-ins so the existing
  // [function, EvsInvalidCalldata, EvsDecodeError] prefix stays stable. Trailing param with a
  // wide default: pre-#15 instantiations `ScriptAbi<n, a, r>` keep compiling, and a concrete
  // errs tuple stays assignable to the default (the ...spread degrades to a readonly array).
  errs extends readonly EvsErrorType[] = readonly EvsErrorType[],
> = readonly [
  {
    readonly type: 'function';
    readonly name: name;
    readonly stateMutability: 'view';
    readonly inputs: ArgsToInputs<args>;
    readonly outputs: readonly [
      {
        readonly name: 'result';
        readonly type: 'tuple';
        readonly components: ReturnSpecToComponents<ret>; // UnionToTuple-based; order-unstable but
      }, //                                                  SAFE (object inference)
    ];
  },
  (typeof EVS_ERROR_ABI)[0],
  (typeof EVS_ERROR_ABI)[1],
  ...ErrorsToAbi<errs>,
];

// ---------------------------------------------------------------------------
// runtime mirror
// ---------------------------------------------------------------------------

/** Re-throws a `layout*` failure with `where` prepended, preserving the code. Tuple-aware: a
 *  {@link TupleType} descriptor validates through its component layouts (`layoutOfType`); a raw
 *  type string (which may be an arbitrary, possibly-invalid ABI string from an `AbiParameter`)
 *  stays on the existing string `layoutOf` path. */
function validateAbiType(type: TupleType | string, where: string): void {
  try {
    if (typeof type === 'string') layoutOf(type);
    else layoutOfType(type);
  } catch (e) {
    if (e instanceof EvsTypeError) {
      throw new EvsTypeError(e.code, `${where}: ${e.message}`);
    }
    throw e;
  }
}

/**
 * A tuple type's struct fields must carry non-empty identifier names (an empty/odd name collapses
 * viem's object inference to a positional array). Positional `t.tuple`
 * members (`name: ''`) are fine. Recurses through nested tuple components. `t.struct` already
 * enforces this at construction; `buildScriptAbi` re-checks so a hand-built (deserialized) type
 * cannot smuggle a degenerate struct through.
 */
function assertStructFieldNames(type: EvsType, where: string): void {
  if (typeof type === 'string') return;
  type.components.forEach((c, i) => {
    if (c.name !== '' && !IDENT_RE.test(c.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        c.name === '__proto__'
          ? `${where}: tuple field #${i} has an invalid name "__proto__": ${PROTO_RESERVED}`
          : `${where}: tuple field #${i} has an invalid name ${JSON.stringify(c.name)} (every named struct field must be a non-empty identifier or viem degrades the result to a positional array)`,
      );
    }
    if (c.components !== undefined) {
      assertStructFieldNames(abiParamToType(c), `${where} field "${c.name}"`);
    }
  });
}

/**
 * Runtime mirror of `ScriptAbi`: `[function, EvsInvalidCalldata, EvsDecodeError]`.
 *
 * `args` is the NORMALIZED arg list (`{ name, type }`): each input is labeled with its `name` —
 * a user-provided {@link namedArg} name, or the positional `arg{i}` fallback the recorder assigns to
 * a bare arg (issue #9) — and expanded via {@link typeToAbiParam} (a tuple type → `{ name, type:
 * 'tuple', components }`). Names must be non-empty identifiers and unique across inputs. `inputs`
 * order = `args` order; `components` order = `returns` insertion order (the runtime ABI array is the
 * encode/decode source of truth). Every arg/return type is validated through
 * the tuple-aware layout, and struct field names are re-checked.
 */
/** Declared-error names that would shadow the Solidity built-ins / the evs runtime errors,
 *  the built-in 'empty'/'unknown' decode arms, or the matchScriptError '_' default-arm key —
 *  rejected at declaration (`t.error`, core/types.ts) and re-checked here for hand-built
 *  inputs. */
const RESERVED_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Panic',
  'Error',
  'EvsDecodeError',
  'EvsInvalidCalldata',
  'empty',
  'unknown',
  '_',
]);

export function buildScriptAbi(
  name: string,
  args: readonly { name: string; type: EvsType }[],
  returns: readonly { name: string; type: EvsType }[],
  errors: readonly { name: string; inputs: readonly PlainAbiParam[] }[] = [],
): Abi {
  if (!IDENT_RE.test(name)) {
    throw new EvsTypeError(
      'ABI_SHAPE',
      `buildScriptAbi: invalid script name ${JSON.stringify(name)}: ${identProblem(name)}`,
    );
  }
  const seenArgs = new Set<string>();
  const inputs = args.map((a, i) => {
    if (!IDENT_RE.test(a.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `buildScriptAbi: argument #${i} has an invalid name ${JSON.stringify(a.name)}: ${identProblem(a.name)}`,
      );
    }
    if (seenArgs.has(a.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `buildScriptAbi: duplicate argument name ${JSON.stringify(a.name)}`,
      );
    }
    seenArgs.add(a.name);
    validateAbiType(a.type, `argument #${i} ("${a.name}")`);
    assertStructFieldNames(a.type, `argument #${i} ("${a.name}")`);
    return Object.freeze(typeToAbiParam(a.name, a.type));
  });
  // a zero-component result tuple ABI-encodes to 0 bytes → the runtime returns 0x, which viem
  // rejects as "returned no data" — hard error instead (s.return({}) is rejected upstream too).
  if (returns.length === 0) {
    throw new EvsTypeError(
      'ABI_SHAPE',
      `buildScriptAbi: script ${JSON.stringify(name)} needs at least one return component — an empty result tuple ABI-encodes to 0x, which viem rejects as "returned no data"`,
    );
  }
  const seenReturns = new Set<string>();
  const components = returns.map((r, i) => {
    // empty/invalid component names would silently degrade viem's object inference to a
    // positional array — hard error instead.
    if (!IDENT_RE.test(r.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        r.name === '__proto__'
          ? `buildScriptAbi: return component #${i} has an invalid name "__proto__": ${PROTO_RESERVED}`
          : `buildScriptAbi: return component #${i} has an invalid name ${JSON.stringify(r.name)} (every component must be a non-empty identifier or viem degrades the result object to a positional array)`,
      );
    }
    if (seenReturns.has(r.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `buildScriptAbi: duplicate return component name ${JSON.stringify(r.name)}`,
      );
    }
    seenReturns.add(r.name);
    validateAbiType(r.type, `return component "${r.name}"`);
    assertStructFieldNames(r.type, `return component "${r.name}"`);
    return Object.freeze(typeToAbiParam(r.name, r.type));
  });
  const fn: AbiFunction = Object.freeze({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: Object.freeze(inputs),
    outputs: Object.freeze([
      Object.freeze({ name: 'result', type: 'tuple', components: Object.freeze(components) }),
    ]),
  });
  // declared custom errors (issue #15): appended AFTER the built-ins (stable prefix). Every
  // input type is re-validated through the tuple-aware layout — a hand-built (deserialized)
  // error cannot smuggle a unsupported or degenerate-struct shape into the ABI.
  const seenErrors = new Set<string>();
  const errorEntries = errors.map((e) => {
    if (!IDENT_RE.test(e.name)) {
      throw new EvsTypeError(
        'ERROR_DECL',
        `buildScriptAbi: invalid error name ${JSON.stringify(e.name)}: ${identProblem(e.name)}`,
      );
    }
    if (RESERVED_ERROR_NAMES.has(e.name)) {
      throw new EvsTypeError('ERROR_DECL', `buildScriptAbi: error name "${e.name}" is reserved`);
    }
    if (seenErrors.has(e.name)) {
      throw new EvsTypeError('ERROR_DECL', `buildScriptAbi: duplicate error name "${e.name}"`);
    }
    seenErrors.add(e.name);
    const seenParams = new Set<string>();
    e.inputs.forEach((p, i) => {
      const where = `error "${e.name}" input #${i} ("${p.name}")`;
      if (!IDENT_RE.test(p.name)) {
        throw new EvsTypeError(
          'ERROR_DECL',
          `buildScriptAbi: ${where}: invalid input name (must be a non-empty identifier — the decode utilities key args by name)`,
        );
      }
      if (seenParams.has(p.name)) {
        throw new EvsTypeError(
          'ERROR_DECL',
          `buildScriptAbi: error "${e.name}" has a duplicate input name "${p.name}"`,
        );
      }
      seenParams.add(p.name);
      const ty = abiParamToType(p);
      validateAbiType(ty, where);
      assertStructFieldNames(ty, where);
    });
    return Object.freeze({ type: 'error', name: e.name, inputs: Object.freeze(e.inputs) });
  });
  // the script name must not also name an error of the artifact ABI (issue #63): viem's
  // getAbiItem would resolve the error entry, so encodeFunctionData/readContract fail with
  // "Function not found on ABI". Panic/Error are not ABI entries, so they stay usable.
  if (name === 'EvsDecodeError' || name === 'EvsInvalidCalldata' || seenErrors.has(name)) {
    throw new EvsTypeError(
      'ERROR_DECL',
      `buildScriptAbi: script name "${name}" collides with the error "${name}" in its ABI — viem would resolve the error entry instead of the function; rename the script or the error`,
    );
  }
  const abi: Abi = Object.freeze([fn, EVS_ERROR_ABI[0], EVS_ERROR_ABI[1], ...errorEntries]);
  return abi;
}

// ---------------------------------------------------------------------------
// selectors / plain functions
// ---------------------------------------------------------------------------

export function selectorOf(name: string, argTypes: readonly string[]): Hex {
  return toFunctionSelector(`${name}(${argTypes.join(',')})`);
}

/**
 * Canonical Solidity signature fragment of an {@link EvsType} (the form selectors are computed
 * over): a string type verbatim; a tuple → `(c1,c2,…)` with any array suffix, recursing through
 * components. Lets the dispatcher (`codegen/program.ts`) compute the script selector from the
 * normalized {@link EvsType} arg list, byte-identical to viem's selector over the tuple-expanded
 * `ScriptAbi` inputs.
 */
export function canonicalTypeSignature(ty: EvsType): string {
  if (typeof ty === 'string') return ty;
  const suffix = ty.type.slice('tuple'.length); // '' | '[]' | '[][]'
  const inner = ty.components.map((c) => canonicalTypeSignature(abiParamToType(c))).join(',');
  return `(${inner})${suffix}`;
}

/**
 * The 4-byte selector of a declared custom error (issue #15): keccak over the canonical
 * Solidity signature (`Name(t1,t2,…)`, tuples expanded), byte-identical to solc's. Computed
 * here — not on the `t.error` value — because core/ takes no viem import.
 */
export function errorSelectorOf(name: string, inputs: readonly PlainAbiParam[]): Hex {
  return selectorOf(
    name,
    inputs.map((c) => canonicalTypeSignature(abiParamToType(c))),
  );
}

/**
 * Decodes a custom error's argument payload (the revert data AFTER the 4-byte selector)
 * against its declared inputs into a name-keyed record (resolved names — `namedArg` or the
 * `arg{i}` fallback — are always non-empty and unique, enforced by `buildScriptAbi`).
 * Returns `null` on any structural mismatch (truncated/malformed payload) instead of throwing —
 * the callers (explainRevert / decodeScriptError) surface that as a diagnostic, not a crash.
 */
export function decodeErrorArgsRecord(
  inputs: readonly PlainAbiParam[],
  payload: Hex,
): Readonly<Record<string, unknown>> | null {
  if (inputs.length === 0) {
    return payload === '0x' ? Object.freeze({}) : null;
  }
  let decoded: readonly unknown[];
  try {
    // PlainAbiParam is structurally an AbiParameter (name + type + optional components)
    decoded = decodeAbiParameters(inputs, payload);
  } catch {
    return null;
  }
  // Object.fromEntries defines OWN keys: an input named `__proto__` (a hand-built ABI) stays a
  // member instead of replacing the record's prototype.
  return Object.freeze(
    Object.fromEntries(inputs.map((p, i) => [p.name === '' ? `arg${i}` : p.name, decoded[i]])),
  );
}

/**
 * The built-in error selectors every decode path recognizes: Solidity's `Panic(uint256)` and
 * `Error(string)`, plus the evs runtime errors.
 */
export const PANIC_SELECTOR = selectorOf('Panic', ['uint256']); // 0x4e487b71
export const ERROR_STRING_SELECTOR = selectorOf('Error', ['string']); // 0x08c379a0
export const EVS_DECODE_ERROR_SELECTOR = selectorOf('EvsDecodeError', ['uint256']);
export const EVS_INVALID_CALLDATA_SELECTOR = selectorOf('EvsInvalidCalldata', []);

/**
 * Solidity `Panic(uint256)` code meanings (shared by `explainRevert` and the client-side
 * `decodeScriptError`).
 */
export const PANIC_MEANINGS: Readonly<Record<string, string>> = Object.freeze({
  '0x00': 'generic compiler panic',
  '0x01': 'assertion failure (assert)',
  '0x11': 'arithmetic overflow or underflow',
  '0x12': 'division or modulo by zero',
  '0x21': 'invalid enum conversion',
  '0x22': 'corrupted storage byte array',
  '0x31': 'pop on an empty array',
  '0x32': 'array index out of bounds',
  '0x41': 'allocation too large (out of memory)',
  '0x51': 'call to a zero-initialized internal function',
});

/** A `Panic(uint256)` code as its `0x`-hex form (at least two digits) and its meaning. */
export function describePanic(code: bigint): { codeHex: string; meaning: string } {
  const codeHex = `0x${code.toString(16).padStart(2, '0')}`;
  return { codeHex, meaning: PANIC_MEANINGS[codeHex] ?? 'unknown panic code' };
}

/**
 * One `AbiParameter` → `PlainAbiParam`, recursing through tuple components so `s.call` accepts
 * struct/tuple inputs and outputs. Each (leaf or component) type is validated against the evs type vocabulary;
 * a tuple param carries its frozen, recursively-converted `components`.
 */
function abiParamToPlain(p: AbiParameter, where: string): PlainAbiParam {
  if (p.type.startsWith('tuple')) {
    // any tuple-array suffix chain is admitted (`tuple[]`, `tuple[2]`, `tuple[][]`, …) up to
    // MAX_ARRAY_DEPTH levels (deeper → UNSUPPORTED_V0); a malformed tag (`tuple[0]`,
    // `tuple(uint256)`) is ABI_SHAPE.
    assertArrayDepth(p.type, where);
    if (!isTupleTag(p.type)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `${where}: malformed tuple type ${JSON.stringify(p.type)} (expected 'tuple' followed by \`[]\`/\`[N]\` suffixes)`,
      );
    }
    const components = 'components' in p ? p.components : undefined;
    if (components === undefined || components.length === 0) {
      throw new EvsTypeError('ABI_SHAPE', `${where}: tuple type carries no \`components\``);
    }
    // recurse: each component validates its own (leaf or nested-tuple) type.
    return Object.freeze({
      name: p.name ?? '',
      type: p.type,
      components: Object.freeze(
        components.map((c, j) =>
          abiParamToPlain(
            c,
            `${where}.components[${j}] (${c.name !== undefined && c.name !== '' ? `"${c.name}"` : `#${j} unnamed`})`,
          ),
        ),
      ),
    });
  }
  validateAbiType(p.type, where);
  return Object.freeze({ name: p.name ?? '', type: p.type });
}

/**
 * `AbiFunction` → `PlainAbiFunction` (+ selector). Validates every input/output type against the
 * evs type vocabulary (recursing into tuple components), naming the offending parameter. The selector is
 * computed by viem from the whole `item` so tuple inputs expand to their canonical
 * `(t1,t2,…)` signature.
 */
export function toPlainAbiFunction(item: AbiFunction): PlainAbiFunction {
  const toPlain = (params: readonly AbiParameter[], kind: 'input' | 'output') =>
    Object.freeze(
      params.map((p, i): PlainAbiParam => {
        const label = p.name !== undefined && p.name !== '' ? `"${p.name}"` : `#${i} (unnamed)`;
        return abiParamToPlain(p, `function "${item.name}": ${kind} parameter ${label}`);
      }),
    );
  const inputs = toPlain(item.inputs, 'input');
  const outputs = toPlain(item.outputs, 'output');
  return Object.freeze({
    name: item.name,
    selector: toFunctionSelector(item),
    inputs,
    outputs,
  });
}

// ---------------------------------------------------------------------------
// literal encoders (recording-time trust boundary)
// ---------------------------------------------------------------------------

const HEX_BODY_RE = /^[0-9a-fA-F]*$/;

/** Hex literal rules: `0x`-prefixed, even-length, optionally an exact byte size. */
function coerceHexLiteral(type: string, value: unknown, exactBytes: number | null): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${type} literal must be a 0x-prefixed hex string, got ${describeValue(value)}`,
    );
  }
  const body = value.slice(2);
  if (!HEX_BODY_RE.test(body) || body.length % 2 !== 0) {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `${type} literal ${JSON.stringify(value)} is not valid even-length hex`,
    );
  }
  if (exactBytes !== null && body.length !== 2 * exactBytes) {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `${type} literal must be exactly ${exactBytes} bytes (${2 * exactBytes} hex chars), got ${body.length / 2} bytes`,
    );
  }
  // lowercase: checksum is NOT enforced (viem-permissive) and viem's encoder
  // rejects mixed-case non-checksummed addresses — bytes are case-insensitive anyway.
  return `0x${body.toLowerCase()}`;
}

function describeValue(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return 'an array';
  return String(value);
}

/** Numeric literal rules: safe-integer numbers or bigints, range-checked against N. */
function coerceNumericLiteral(type: WordType, value: unknown, where: string): bigint {
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new EvsTypeError(
        'LITERAL_RANGE',
        `${where}${type} literal ${String(value)} is not a safe integer (use a bigint for values beyond 2^53)`,
      );
    }
    v = BigInt(value);
  } else {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}${type} literal must be a number or bigint, got ${describeValue(value)}`,
    );
  }
  const bits = BigInt(bitsOf(type));
  const [min, max] = isSigned(type)
    ? [-(2n ** (bits - 1n)), 2n ** (bits - 1n) - 1n]
    : [0n, 2n ** bits - 1n];
  if (v < min || v > max) {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `${where}${type} literal ${v}n is out of range [${min}, ${max}]`,
    );
  }
  return v;
}

/** Validate + coerce one word literal into a value viem's encoder accepts canonically. */
function coerceWordLiteral(type: WordType, value: unknown, where = ''): bigint | boolean | Hex {
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${where}bool literal must be a boolean, got ${describeValue(value)}`,
      );
    }
    return value;
  }
  if (type === 'address') return coerceHexLiteral(`${where}address`, value, 20);
  if (type.startsWith('bytes')) {
    return coerceHexLiteral(`${where}${type}`, value, Number(type.slice('bytes'.length)));
  }
  return coerceNumericLiteral(type, value, where);
}

/**
 * Canonical 32-byte word (uintN zero-extended, intN sign-extended,
 * bool ∈ {0,1}, bytesN left-aligned, address zero-extended).
 */
export function encodeLiteralWord(type: WordType, value: unknown): Hex {
  if (!isWordType(type)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `encodeLiteralWord: ${JSON.stringify(type)} is not a word type`,
    );
  }
  const params: readonly AbiParameter[] = [{ type }];
  return encodeAbiParameters(params, [coerceWordLiteral(type, value)]);
}

/**
 * Pre-encoded memref payload `[len:32][payload…]`: strings/bytes are raw
 * bytes zero-padded to a word boundary; word-element arrays (dynamic `T[]` or fixed `T[N]`, whose
 * literal must have exactly N elements) are one canonical word per element. This is exactly the
 * ABI tail of the dynamic form of the type, i.e. viem's `encodeAbiParameters` output minus the
 * leading 32-byte head offset.
 */
export function encodeLiteralData(type: DynType | ArrayType, value: unknown): Hex {
  const layout = layoutOf(type); // throws on unsupported shapes
  let coerced: unknown;
  if (layout.kind === 'word') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `encodeLiteralData: ${JSON.stringify(type)} is a word type — use encodeLiteralWord`,
    );
  } else if (layout.kind === 'bytes') {
    if (layout.abi === 'string') {
      if (typeof value !== 'string') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `string literal must be a JS string, got ${describeValue(value)}`,
        );
      }
      coerced = value; // UTF-8 encoded by the ABI encoder
    } else {
      coerced = coerceHexLiteral('bytes', value, null);
    }
  } else if (layout.kind === 'array') {
    if (!Array.isArray(value)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${type} literal must be an array, got ${describeValue(value)}`,
      );
    }
    if (layout.elem.kind !== 'word') {
      // composite-element array literals (`tuple[]`, `T[][]`, `string[]`) have no FLAT data-segment
      // form — they are an array of pointers. The recorder builds them at record time via
      // `arrnew` + per-element construction (`coerceToId`/`s.lit`/`s.newArray`), so this flat-literal
      // path is never the construction route; only a hand-cast caller (e.g. an eager s.select branch
      // validation) reaches here.
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${type} literal: a composite-element array has no flat memref literal — build it via the recorder (s.newArray / an array literal arg or return)`,
      );
    }
    if (layout.length !== null && value.length !== layout.length) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${type} literal must have exactly ${layout.length} element(s), got ${value.length}`,
      );
    }
    const elemAbi = layout.elem.abi;
    coerced = value.map((el, i) => coerceWordLiteral(elemAbi, el, `${type}[${i}]: `));
  } else {
    // tuple: composite literals are built in the recorder (`tuplenew`), never here — the public
    // `encodeLiteralData` signature (`DynType | ArrayType`) already excludes tuples; this is the
    // runtime-defensive arm for a hand-cast caller.
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `encodeLiteralData: tuple type ${JSON.stringify(type)} has no flat memref literal — build it via the recorder`,
    );
  }
  // a fixed-size word array `T[N]` is encoded through its DYNAMIC twin `T[]`: the memref image is
  // `[len][w0…]` in both cases (the memory model is length-prefixed for `T[N]` too, len === N),
  // and only the dynamic form carries the `[len]` word on the wire.
  const wireType: string =
    layout.kind === 'array' && layout.length !== null ? `${layout.elem.abi}[]` : type;
  const params: readonly AbiParameter[] = [{ type: wireType }];
  const full = encodeAbiParameters(params, [coerced]);
  // single dynamic param ⇒ [head: offset 0x20][tail: len + payload]; the memref is the tail.
  return `0x${full.slice(2 + 64)}`;
}
