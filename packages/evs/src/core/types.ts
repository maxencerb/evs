/**
 * M1 `core/types.ts` — the type vocabulary, `Expr` brand, `arg()`/`t`, and runtime type
 * predicates/metadata (single source of truth for all modules).
 *
 * Contract: docs/design/module-interfaces.md §M1 (frozen) + api.md §2/§3.
 */

import { EvsStagingError, EvsTypeError, type SourceLoc } from './errors.js';
import { captureLoc } from './loc.js';

// re-exported per the module-interfaces conventions block ("`Address` is re-exported from
// `abitype`"); type-only — abitype is the only import core may take.
export type { Address } from 'abitype';

// ---------------------------------------------------------------------------
// type vocabulary
// ---------------------------------------------------------------------------

export type Hex = `0x${string}`;

// prettier-ignore
export type UintBits = 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64 | 72 | 80 | 88 | 96 | 104 | 112
  | 120 | 128 | 136 | 144 | 152 | 160 | 168 | 176 | 184 | 192 | 200 | 208 | 216 | 224 | 232
  | 240 | 248 | 256;
// prettier-ignore
export type BytesSize = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32;

export type UintType = `uint${UintBits}`;
export type IntType = `int${UintBits}`;
export type BytesNType = `bytes${BytesSize}`;
export type WordType = UintType | IntType | 'address' | 'bool' | BytesNType;
export type DynType = 'string' | 'bytes';
export type ArrayType = `${WordType}[]`;
export type EvsType = WordType | DynType | ArrayType;
export type ArgType = EvsType;
export type NumericType = UintType | IntType;
export type BitsType = UintType | BytesNType;

// ---------------------------------------------------------------------------
// Expr — the branded staged-value handle (api.md §3, verbatim)
// ---------------------------------------------------------------------------

export declare const exprBrand: unique symbol;

export interface Expr<t extends EvsType = EvsType> {
  readonly [exprBrand]: t; // nominal, covariant phantom
  readonly type: t; // runtime-readable type tag

  // arithmetic — checked (Panic 0x11 / 0x12); this-parameter restricts to numeric types
  add(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  sub(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  mul(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  div(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;
  mod(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<t>;

  // comparisons — LT/GT vs SLT/SGT chosen from the static type
  lt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gt(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  lte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  gte(this: Expr<t & NumericType>, rhs: IntoExpr<t>): Expr<'bool'>;
  eq(this: Expr<t & WordType>, rhs: IntoExpr<t>): Expr<'bool'>; // word types only (typed)
  neq(this: Expr<t & WordType>, rhs: IntoExpr<t>): Expr<'bool'>;

  // bool logic — eager, NOT short-circuiting (use s.if for conditional execution)
  and(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>;
  or(this: Expr<'bool'>, rhs: IntoExpr<'bool'>): Expr<'bool'>;
  not(this: Expr<'bool'>): Expr<'bool'>;

  // bitwise (result re-canonicalized to t's width)
  bitAnd(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitOr(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitXor(this: Expr<t & BitsType>, rhs: IntoExpr<t>): Expr<t>;
  bitNot(this: Expr<t & BitsType>): Expr<t>;
  shl(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>;
  shr(this: Expr<t & BitsType>, bits: IntoExpr<'uint256'>): Expr<t>; // SAR for intN via s.shr

  // conversions — widening free; NARROWING IS CHECKED (Panic 0x11 on out-of-range)
  toUint<const u extends UintType>(target: u): Expr<u>;
  toInt<const i extends IntType>(target: i): Expr<i>;
  asAddress(this: Expr<'uint256' | 'bytes32'>): Expr<'address'>; // checked: high 96 bits zero
  asUint256(this: Expr<'bytes32'>): Expr<'uint256'>; // free reinterpret
  asBytes32(this: Expr<'uint256'>): Expr<'bytes32'>; // free reinterpret

  // dynamic / array values (memrefs)
  length(this: Expr<DynType | ArrayType>): Expr<'uint256'>;
  at<elem extends WordType>(this: Expr<`${elem}[]`>, i: IntoExpr<'uint256'>): Expr<elem>;
  // bounds-checked → Panic 0x32
}

export type LitOf<t extends EvsType> = t extends NumericType
  ? bigint | number
  : t extends 'address'
    ? `0x${string}`
    : t extends 'bool'
      ? boolean
      : t extends BytesNType
        ? `0x${string}`
        : t extends 'string'
          ? string
          : t extends 'bytes'
            ? `0x${string}`
            : t extends `${infer e extends WordType}[]`
              ? readonly LitOf<e>[]
              : never;

export type IntoExpr<t extends EvsType> = Expr<t> | LitOf<t>;

// ---------------------------------------------------------------------------
// arg() declarators + the `t` type namespace (api.md §2)
// ---------------------------------------------------------------------------

export interface ArgSpec<name extends string = string, type extends ArgType = ArgType> {
  readonly name: name;
  readonly type: type;
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

export function arg<const name extends string, const type extends ArgType>(
  name: name,
  type: type,
): ArgSpec<name, type> {
  if (!IDENT_RE.test(name)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `invalid argument name ${JSON.stringify(name)}: must be a non-empty identifier matching /^[A-Za-z_]\\w*$/`,
      { loc: captureLoc() },
    );
  }
  assertEvsType(type, `argument "${name}"`);
  return Object.freeze({ name, type });
}

type TypeNamespace = { readonly [k in WordType | DynType]: k } & {
  array<const e extends WordType>(elem: e): `${e}[]`;
};

const UINT_BITS_LIST: readonly number[] = Array.from({ length: 32 }, (_, i) => 8 * (i + 1));
const BYTES_SIZE_LIST: readonly number[] = Array.from({ length: 32 }, (_, i) => i + 1);

function buildWordTypeSets(): {
  word: ReadonlySet<string>;
  numeric: ReadonlySet<string>;
  signed: ReadonlySet<string>;
  bits: ReadonlyMap<string, number>;
} {
  const word = new Set<string>(['address', 'bool']);
  const numeric = new Set<string>();
  const signed = new Set<string>();
  const bits = new Map<string, number>([
    ['address', 160],
    ['bool', 8], // canonical 0/1
  ]);
  for (const n of UINT_BITS_LIST) {
    word.add(`uint${n}`).add(`int${n}`);
    numeric.add(`uint${n}`).add(`int${n}`);
    signed.add(`int${n}`);
    bits.set(`uint${n}`, n);
    bits.set(`int${n}`, n);
  }
  for (const n of BYTES_SIZE_LIST) {
    word.add(`bytes${n}`);
    bits.set(`bytes${n}`, 8 * n);
  }
  return { word, numeric, signed, bits };
}

const SETS = buildWordTypeSets();

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
  array<const e extends WordType>(elem: e): `${e}[]` {
    if (!isWordType(elem)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `t.array(): element type ${JSON.stringify(elem)} is not a word type (uintN/intN/address/bool/bytesN)`,
        { loc: captureLoc() },
      );
    }
    return `${elem}[]`;
  },
} as const);

// ---------------------------------------------------------------------------
// runtime type predicates / metadata
// ---------------------------------------------------------------------------

export function isEvsType(s: string): s is EvsType {
  if (isWordType(s) || s === 'string' || s === 'bytes') return true;
  return s.endsWith('[]') && isWordType(s.slice(0, -2));
}

export function isWordType(s: string): s is WordType {
  return SETS.word.has(s);
}

export function isNumeric(s: EvsType): s is NumericType {
  return SETS.numeric.has(s);
}

/** `intN` → true; every other v0 type (incl. `intN[]`) → false. */
export function isSigned(s: EvsType): boolean {
  return SETS.signed.has(s);
}

/** address→160, bool→8 (canonical 0/1), bytesN→8N, uintN/intN→N. */
export function bitsOf(s: WordType): number {
  const bits = SETS.bits.get(s);
  if (bits === undefined) {
    throw new EvsTypeError('TYPE_MISMATCH', `bitsOf: ${JSON.stringify(s)} is not a word type`, {
      loc: captureLoc(),
    });
  }
  return bits;
}

/** string | bytes | T[] */
export function isDynamicType(s: EvsType): boolean {
  return s === 'string' || s === 'bytes' || s.endsWith('[]');
}

export function elemTypeOf(s: ArrayType): WordType {
  const elem: string = s.endsWith('[]') ? s.slice(0, -2) : '';
  if (!isWordType(elem)) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `elemTypeOf: ${JSON.stringify(s)} is not a v0 array type (\`T[]\` of a word type)`,
      { loc: captureLoc() },
    );
  }
  return elem;
}

// ---------------------------------------------------------------------------
// internal helpers (module-private to evs; not part of the frozen M1 surface)
// ---------------------------------------------------------------------------

/** Recognizably-Solidity types that are deliberately out of v0 get the UNSUPPORTED_V0 code. */
function looksDeferred(s: string): boolean {
  if (s === 'tuple' || s.startsWith('tuple')) return true; // tuples / tuple arrays
  if (/\[\d+\]$/.test(s)) return true; // fixed-size arrays T[N]
  if (s.endsWith('[]') && /\[\]|\[\d+\]/.test(s.slice(0, -2))) return true; // nested arrays
  if (s.endsWith('[]')) return true; // T[] of a non-word type (e.g. string[])
  return false;
}

/**
 * Eager type-string validation: throws `EvsTypeError` with the caller's loc, using
 * `UNSUPPORTED_V0` for valid-Solidity-but-deferred shapes and `TYPE_MISMATCH` otherwise.
 */
function assertEvsType(s: string, context: string): asserts s is EvsType {
  if (isEvsType(s)) return;
  if (looksDeferred(s)) {
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      `${context}: type ${JSON.stringify(s)} is not supported in evs v0 (tuples, fixed-size arrays \`T[N]\`, and nested/non-word arrays are deferred)`,
      { loc: captureLoc() },
    );
  }
  throw new EvsTypeError(
    'TYPE_MISMATCH',
    `${context}: unknown type ${JSON.stringify(s)} (expected uintN/intN/address/bool/bytesN, string, bytes, or T[] of a word type)`,
    { loc: captureLoc() },
  );
}

/**
 * @internal Staging-misuse traps shared by every handle implementation (architecture.md §3).
 *
 * Installs throwing `valueOf` / `toString` / `toJSON` / `Symbol.toPrimitive` on `target`
 * (each throws `EvsStagingError` citing both the misuse site and where the handle was
 * recorded), plus a NON-throwing `nodejs.util.inspect.custom` returning `describe()` —
 * printing is debugging, not misuse. The builder (M5) layers `Expr` methods on top.
 */
export function installStagingTraps(
  target: object,
  info: { describe(): string; recordedAt(): SourceLoc | null },
): void {
  const explode = (operation: string): never => {
    throw new EvsStagingError(
      'STAGING_MISUSE',
      `${operation} on a staged handle (${info.describe()}): evs handles are recorded program values, not host values — use the builder ops (s.add, .eq, s.if, …) instead`,
      {
        loc: captureLoc(),
        relatedLocs: [{ label: 'handle recorded at', loc: info.recordedAt() }],
      },
    );
  };
  const traps: PropertyDescriptorMap = {
    valueOf: { value: () => explode('valueOf()'), enumerable: false },
    toString: { value: () => explode('toString()'), enumerable: false },
    toJSON: { value: () => explode('toJSON() / JSON.stringify'), enumerable: false },
    [Symbol.toPrimitive]: {
      value: () => explode('primitive coercion (Symbol.toPrimitive)'),
      enumerable: false,
    },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      value: () => info.describe(),
      enumerable: false,
    },
  };
  Object.defineProperties(target, traps);
}
