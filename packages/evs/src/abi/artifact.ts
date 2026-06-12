/**
 * M3 `abi/artifact.ts` — the literal-typed `ScriptAbi`, its runtime mirror, the evs error ABI,
 * selectors, and the recording-time literal encoders.
 *
 * Contract: docs/design/module-interfaces.md §M3 (frozen) + architecture.md §11 (error ABI)
 * + api.md §3 (literal coercion rules). `viem` is the sanctioned runtime peer here (selectors
 * + ABI encoding of literals; module-interfaces preamble).
 *
 * Type-level design per docs/research/abitype-typing.md: the return record becomes ONE output
 * of type `'tuple'` with fully-named components, so viem infers an *object* — immune to the
 * §4.2 `UnionToTuple` interning-order instability. Script inputs map over the `ArgSpec` tuple
 * (order-preserving by construction).
 */

import type { Abi, AbiFunction, AbiParameter } from 'abitype';
import { encodeAbiParameters, toFunctionSelector } from 'viem';

import { EvsTypeError } from '../core/errors.js';
import { captureLoc } from '../core/loc.js';
import {
  bitsOf,
  isSigned,
  isWordType,
  type ArgSpec,
  type ArrayType,
  type DynType,
  type EvsType,
  type Expr,
  type Hex,
  type WordType,
} from '../core/types.js';
import type { PlainAbiFunction, PlainAbiParam } from '../ir/nodes.js';
import { layoutOf } from './layout.js';

// ---------------------------------------------------------------------------
// error ABI (architecture §11)
// ---------------------------------------------------------------------------

export const EVS_ERROR_ABI = [
  { type: 'error', name: 'EvsInvalidCalldata', inputs: [] },
  { type: 'error', name: 'EvsDecodeError', inputs: [{ name: 'site', type: 'uint256' }] },
] as const satisfies Abi;

// ---------------------------------------------------------------------------
// ScriptAbi — the literal type
// ---------------------------------------------------------------------------

// UnionToTuple machinery for the return-spec components (abitype-typing §4.2: the resulting
// tuple ORDER is interning-dependent and unstable, but SAFE here — viem infers an object from
// a fully-named single tuple output, and objects are order-insensitive).
type UnionToIntersection<u> = (u extends unknown ? (x: u) => void : never) extends (
  x: infer i,
) => void
  ? i
  : never;
type LastOf<u> =
  UnionToIntersection<u extends unknown ? () => u : never> extends () => infer r ? r : never;
type UnionToTuple<u> = [u] extends [never]
  ? []
  : [...UnionToTuple<Exclude<u, LastOf<u>>>, LastOf<u>];
type MapComponents<keys, ret extends Record<string, Expr>> = keys extends readonly unknown[]
  ? {
      readonly [i in keyof keys]: keys[i] extends keyof ret & string
        ? { readonly name: keys[i]; readonly type: ret[keys[i]]['type'] }
        : never;
    }
  : never;
// Non-literal `ret` (i.e. the default `Record<string, Expr>` instantiation) widens to a plain
// readonly components array instead of collapsing to a `UnionToTuple<string>` 1-tuple — that
// collapse made the default-instantiated `ScriptAbi`/`EvsScript`/`CompiledEvsScript` reject
// every concrete multi-return script. A literal components tuple IS assignable to the readonly
// array form, so the default instantiation is now a proper supertype (pinned by type tests).
export type ReturnSpecToComponents<ret extends Record<string, Expr>> = string extends keyof ret
  ? readonly { readonly name: string; readonly type: EvsType }[]
  : MapComponents<UnionToTuple<keyof ret>, ret>;

export type ScriptAbi<
  name extends string,
  args extends readonly ArgSpec[],
  ret extends Record<string, Expr>,
> = readonly [
  {
    readonly type: 'function';
    readonly name: name;
    readonly stateMutability: 'view';
    readonly inputs: {
      readonly [i in keyof args]: {
        readonly name: args[i]['name'];
        readonly type: args[i]['type'];
      };
    };
    readonly outputs: readonly [
      {
        readonly name: 'result';
        readonly type: 'tuple';
        readonly components: ReturnSpecToComponents<ret>; // UnionToTuple-based; order-unstable but
      }, //                                                  SAFE (object inference) — abitype §4.2
    ];
  },
  (typeof EVS_ERROR_ABI)[0],
  (typeof EVS_ERROR_ABI)[1],
];

// ---------------------------------------------------------------------------
// runtime mirror
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_]\w*$/;

/** Re-throws a `layoutOf` failure with `where` prepended, preserving the code. */
function validateV0Type(type: string, where: string): void {
  try {
    layoutOf(type);
  } catch (e) {
    if (e instanceof EvsTypeError) {
      throw new EvsTypeError(e.code, `${where}: ${e.message}`, { loc: captureLoc() });
    }
    throw e;
  }
}

/**
 * Runtime mirror of `ScriptAbi`: `[function, EvsInvalidCalldata, EvsDecodeError]`.
 * inputs order = `args` tuple order; components order = `returns` insertion order (the
 * runtime ABI array is the encode/decode source of truth — abitype-typing §4.2).
 */
export function buildScriptAbi(
  name: string,
  args: readonly ArgSpec[],
  returns: readonly { name: string; type: EvsType }[],
): Abi {
  if (!IDENT_RE.test(name)) {
    throw new EvsTypeError(
      'ABI_SHAPE',
      `buildScriptAbi: invalid script name ${JSON.stringify(name)} (must match /^[A-Za-z_]\\w*$/)`,
      { loc: captureLoc() },
    );
  }
  const seenArgs = new Set<string>();
  const inputs = args.map((a, i) => {
    if (!IDENT_RE.test(a.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `buildScriptAbi: argument #${i} has an invalid name ${JSON.stringify(a.name)}`,
        { loc: captureLoc() },
      );
    }
    if (seenArgs.has(a.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `buildScriptAbi: duplicate argument name ${JSON.stringify(a.name)}`,
        { loc: captureLoc() },
      );
    }
    seenArgs.add(a.name);
    validateV0Type(a.type, `argument "${a.name}"`);
    return Object.freeze({ name: a.name, type: a.type });
  });
  const seenReturns = new Set<string>();
  const components = returns.map((r, i) => {
    // empty/invalid component names would silently degrade viem's object inference to a
    // positional array (abitype-typing §4.3) — hard error instead.
    if (!IDENT_RE.test(r.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `buildScriptAbi: return component #${i} has an invalid name ${JSON.stringify(r.name)} (every component must be a non-empty identifier or viem degrades the result object to a positional array)`,
        { loc: captureLoc() },
      );
    }
    if (seenReturns.has(r.name)) {
      throw new EvsTypeError(
        'ABI_SHAPE',
        `buildScriptAbi: duplicate return component name ${JSON.stringify(r.name)}`,
        { loc: captureLoc() },
      );
    }
    seenReturns.add(r.name);
    validateV0Type(r.type, `return component "${r.name}"`);
    return Object.freeze({ name: r.name, type: r.type });
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
  const abi: Abi = Object.freeze([fn, EVS_ERROR_ABI[0], EVS_ERROR_ABI[1]]);
  return abi;
}

// ---------------------------------------------------------------------------
// selectors / plain functions
// ---------------------------------------------------------------------------

export function selectorOf(name: string, argTypes: readonly string[]): Hex {
  return toFunctionSelector(`${name}(${argTypes.join(',')})`);
}

/**
 * `AbiFunction` → `PlainAbiFunction` (+ selector via `selectorOf`). Validates every
 * input/output type against the v0 set, naming the offending parameter.
 */
export function toPlainAbiFunction(item: AbiFunction): PlainAbiFunction {
  const toPlain = (params: readonly AbiParameter[], kind: 'input' | 'output') =>
    Object.freeze(
      params.map((p, i): PlainAbiParam => {
        const label = p.name !== undefined && p.name !== '' ? `"${p.name}"` : `#${i} (unnamed)`;
        validateV0Type(p.type, `function "${item.name}": ${kind} parameter ${label}`);
        return Object.freeze({ name: p.name ?? '', type: p.type });
      }),
    );
  const inputs = toPlain(item.inputs, 'input');
  const outputs = toPlain(item.outputs, 'output');
  return Object.freeze({
    name: item.name,
    selector: selectorOf(
      item.name,
      item.inputs.map((p) => p.type),
    ),
    inputs,
    outputs,
  });
}

// ---------------------------------------------------------------------------
// literal encoders (recording-time trust boundary — architecture §5)
// ---------------------------------------------------------------------------

const HEX_BODY_RE = /^[0-9a-fA-F]*$/;

/** api.md §3 hex rules: `0x`-prefixed, even-length, optionally an exact byte size. */
function coerceHexLiteral(type: string, value: unknown, exactBytes: number | null): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${type} literal must be a 0x-prefixed hex string, got ${describeValue(value)}`,
      { loc: captureLoc() },
    );
  }
  const body = value.slice(2);
  if (!HEX_BODY_RE.test(body) || body.length % 2 !== 0) {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `${type} literal ${JSON.stringify(value)} is not valid even-length hex`,
      { loc: captureLoc() },
    );
  }
  if (exactBytes !== null && body.length !== 2 * exactBytes) {
    throw new EvsTypeError(
      'LITERAL_RANGE',
      `${type} literal must be exactly ${exactBytes} bytes (${2 * exactBytes} hex chars), got ${body.length / 2} bytes`,
      { loc: captureLoc() },
    );
  }
  // lowercase: checksum is NOT enforced (api.md §3, viem-permissive) and viem's encoder
  // rejects mixed-case non-checksummed addresses — bytes are case-insensitive anyway.
  return `0x${body.toLowerCase()}`;
}

function describeValue(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return 'an array';
  return String(value);
}

/** api.md §3 numeric rules: safe-integer numbers or bigints, range-checked against N. */
function coerceNumericLiteral(type: WordType, value: unknown, where: string): bigint {
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new EvsTypeError(
        'LITERAL_RANGE',
        `${where}${type} literal ${String(value)} is not a safe integer (use a bigint for values beyond 2^53)`,
        { loc: captureLoc() },
      );
    }
    v = BigInt(value);
  } else {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `${where}${type} literal must be a number or bigint, got ${describeValue(value)}`,
      { loc: captureLoc() },
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
      { loc: captureLoc() },
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
        { loc: captureLoc() },
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
 * Canonical 32-byte word (architecture §5: uintN zero-extended, intN sign-extended,
 * bool ∈ {0,1}, bytesN left-aligned, address zero-extended).
 */
export function encodeLiteralWord(type: WordType, value: unknown): Hex {
  if (!isWordType(type)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `encodeLiteralWord: ${JSON.stringify(type)} is not a word type`,
      { loc: captureLoc() },
    );
  }
  const params: readonly AbiParameter[] = [{ type }];
  return encodeAbiParameters(params, [coerceWordLiteral(type, value)]);
}

/**
 * Pre-encoded memref payload `[len:32][payload…]` (architecture §5): strings/bytes are raw
 * bytes zero-padded to a word boundary; arrays are one canonical word per element. This is
 * exactly the ABI tail of the type, i.e. viem's `encodeAbiParameters` output minus the
 * leading 32-byte head offset.
 */
export function encodeLiteralData(type: DynType | ArrayType, value: unknown): Hex {
  const layout = layoutOf(type); // throws on non-v0 shapes
  let coerced: unknown;
  if (layout.kind === 'word') {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `encodeLiteralData: ${JSON.stringify(type)} is a word type — use encodeLiteralWord`,
      { loc: captureLoc() },
    );
  } else if (layout.kind === 'bytes') {
    if (layout.abi === 'string') {
      if (typeof value !== 'string') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `string literal must be a JS string, got ${describeValue(value)}`,
          { loc: captureLoc() },
        );
      }
      coerced = value; // UTF-8 encoded by the ABI encoder
    } else {
      coerced = coerceHexLiteral('bytes', value, null);
    }
  } else {
    if (!Array.isArray(value)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${type} literal must be an array, got ${describeValue(value)}`,
        { loc: captureLoc() },
      );
    }
    coerced = value.map((el, i) => coerceWordLiteral(layout.elem.abi, el, `${type}[${i}]: `));
  }
  const params: readonly AbiParameter[] = [{ type }];
  const full = encodeAbiParameters(params, [coerced]);
  // single dynamic param ⇒ [head: offset 0x20][tail: len + payload]; the memref is the tail.
  return `0x${full.slice(2 + 64)}`;
}
