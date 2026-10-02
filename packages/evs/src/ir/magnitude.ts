/**
 * `ir/magnitude.ts` — an upper bound, in bits, on the magnitude of every value of a script.
 *
 * `magnitudeBits(ir)(v)` is a `b` such that a `uintN` value is always below `2^b` and an `intN`
 * value is always in `[-2^b, 2^b)`; a memref (tuple, fixed array) is bounded by its leading
 * leaf, the word its static encoding starts with. `deployless.ts` uses it to tell a leading
 * `uint256`/`int256` that can start with byte `0xEF` (a hash, an id, a bit pattern) from an
 * amount or a count that cannot.
 *
 * One flow-insensitive fixpoint over the whole statement tree, fn bodies included: every value
 * is defined once, so its bound is the join of what its defining statement can produce; cells
 * join their init and every `set`, fn params join their call sites' args, and loops need no
 * special case (the fixpoint runs until nothing grows; bits are capped at the type's width).
 *
 *   sources   a word literal: its own bit length; `s.env('chainid' | 'blocknumber' |
 *             'timestamp')`, lengths: 64 bits; `s.balance`: 128; `s.codeSize`: 32 — what nodes
 *             and gas allow in practice, not what the opcode could return. Everything evs cannot
 *             see into is the full width of its type: script args, call outputs, array elements,
 *             members other than the leading one, `bytesN` reinterpreted as an integer.
 *   ops       checked arithmetic grows the bound as the result can (`mul`: the operands' bits
 *             added; `div` by a literal, `shr` by a literal, `mod`, `bitAnd`: shrink it); a
 *             wrapping op, `bitNot`, a signed bitwise op or a shift by a non-literal amount is
 *             the full width. Numeric conversions keep the bound (narrowing is checked).
 *   sums      addition gets one rule, so that counters and running sums stay bounded in a
 *             loop: a chain of additions over operands below `2^b` is below `n·2^b` after `n`
 *             additions, and the gas of one call allows fewer than 2^64 of them, so a sum is
 *             bounded by `b + 64` bits (`sum: true`). Adding two sums (`x + x`, a doubling)
 *             starts a new chain from their bounds, so a value that grows geometrically in a
 *             loop reaches the full width.
 *   memory    a tuple/array member write is joined into every value of that type whose
 *             leading leaf it can reach (aliases always share their type), so a `tupleset` or
 *             `arrset` through any alias is accounted for.
 */

import { canonicalTypeSignature } from '../abi/artifact.js';
import {
  abiParamToType,
  bitsOf,
  elemTypeOf,
  isArrayValueType,
  isNumeric,
  isSigned,
  isWordType,
  type EvsType,
  type Hex,
} from '../core/types.js';
import { walkStmts, type CellId, type ScriptIr, type Stmt, type ValueId } from './nodes.js';

/** `bits`, plus 64 more when the value is a chain of additions (see the module header). */
interface Bound {
  readonly bits: number;
  readonly sum: boolean;
}

/** How many additions one call can execute, in bits: gas makes 2^64 a generous ceiling. */
const SUM_SLACK = 64;
const ZERO: Bound = { bits: 0, sum: false };
const FULL: Bound = { bits: 256, sum: false }; // capped to the value's own width on update

const bits = (n: number): Bound => ({ bits: n, sum: false });

/** The magnitude bound, in bits, of every value of `ir` (see the module header). */
export function magnitudeBits(ir: ScriptIr): (value: ValueId) => number {
  const analysis = new MagnitudeAnalysis(ir);
  analysis.run();
  return (value) => analysis.effective(value);
}

class MagnitudeAnalysis {
  private readonly values = new Map<ValueId, Bound>();
  private readonly cells = new Map<CellId, Bound>();
  /** leading-member writes, by the canonical signature of the tuple/array type written into */
  private readonly writes = new Map<string, Bound>();
  /** word literals, read by the ops whose bound depends on a literal operand */
  private readonly literals = new Map<ValueId, bigint>();
  private changed = false;

  constructor(private readonly ir: ScriptIr) {
    const collect = (s: Stmt): void => {
      if (s.k === 'const' && s.data.kind === 'word') this.literals.set(s.out, BigInt(s.data.hex));
    };
    walkStmts(ir.body, collect);
    for (const fn of ir.fns) walkStmts(fn.body, collect);
  }

  run(): void {
    this.ir.args.forEach((_, i) => this.define(i, FULL));
    const visit = (s: Stmt): void => this.visit(s);
    do {
      this.changed = false;
      walkStmts(this.ir.body, visit);
      for (const fn of this.ir.fns) walkStmts(fn.body, visit);
    } while (this.changed);
  }

  /** The value's bound in bits, its sum slack included, capped at its type's width. */
  effective(value: ValueId): number {
    return this.capped(this.read(value), widthOf(this.typeOf(value)));
  }

  private visit(s: Stmt): void {
    switch (s.k) {
      case 'const': // a memref literal (string, bytes, array) is not looked into
        return this.define(
          s.out,
          s.data.kind === 'word' ? bits(literalBits(s.type, s.data.hex)) : FULL,
        );
      case 'env':
        return this.define(s.out, s.op === 'address' || s.op === 'caller' ? FULL : bits(64));
      case 'account':
        return this.define(
          s.out,
          s.op === 'balance' ? bits(128) : s.op === 'codesize' ? bits(32) : FULL,
        );
      case 'len':
        return this.define(s.out, bits(64));
      case 'convert': {
        const numeric = isNumeric(this.typeOf(s.a)) && isNumeric(this.typeOf(s.out));
        return this.define(s.out, numeric ? this.read(s.a) : FULL);
      }
      case 'bin':
        return this.define(s.out, this.binary(s));
      case 'modarith': {
        const product = this.effective(s.a) + this.effective(s.b);
        const isMod = s.op === 'addmod' || s.op === 'mulmod';
        return this.define(s.out, bits(isMod ? this.effective(s.n) : product));
      }
      case 'select':
        return this.define(s.out, join(this.read(s.a), this.read(s.b)));
      case 'arrnew': // zero-filled
        return this.define(s.out, ZERO);
      case 'tuplenew': {
        const leading = s.inits.find((init) => init.index === 0);
        return this.define(s.out, leading === undefined ? ZERO : this.read(leading.value));
      }
      case 'field': // member 0 IS the tuple's leading leaf; the others are not tracked
        return this.define(s.out, s.index === 0 ? this.read(s.tuple) : FULL);
      case 'tupleset':
        if (s.index === 0) this.write(this.typeOf(s.tuple), this.read(s.value));
        return;
      case 'arrset': // any index may be 0
        return this.write(this.typeOf(s.arr), this.read(s.value));
      case 'cellnew':
        return this.joinCell(s.cell, this.read(s.init));
      case 'cellset':
        return this.joinCell(s.cell, this.read(s.value));
      case 'cellget':
        return this.define(s.out, this.cells.get(s.cell) ?? ZERO);
      case 'fncall': {
        const fn = this.ir.fns[s.fn];
        if (fn === undefined) return;
        s.args.forEach((arg, i) => {
          const param = fn.params[i];
          if (param !== undefined) this.define(param.value, this.read(arg));
        });
        s.outs.forEach((out, i) => {
          const result = fn.resultValues[i];
          this.define(out, result === undefined ? FULL : this.read(result));
        });
        return;
      }
      case 'un': // bitNot: any pattern; not / iszero: a bool
      case 'index':
      case 'slice':
      case 'encode':
      case 'keccak256':
        return this.define(s.out, FULL);
      case 'call':
        for (const out of s.outs) this.define(out, FULL);
        if (s.successOut !== undefined) this.define(s.successOut, FULL);
        return;
      default: // throw, if, while, break, continue: nothing defined (blocks are walked)
        return;
    }
  }

  private binary(s: Extract<Stmt, { k: 'bin' }>): Bound {
    const type = this.typeOf(s.out);
    if (!isNumeric(type)) return FULL; // a comparison or a bool op: a bool
    const signed = isSigned(type);
    const width = widthOf(type);
    const a = this.read(s.a);
    const b = this.read(s.b);
    const ea = this.capped(a, width);
    const eb = this.capped(b, width);
    const literal = this.literals.get(s.b);
    switch (s.op) {
      case 'add':
      case 'wrapadd': // wraps only past the width, which the bound then reaches
        return sum(a, b, width);
      case 'sub': // checked: a uint difference is at most `a`
        return signed ? sum(a, b, width) : a;
      case 'wrapsub': // a uint difference below zero wraps to the top of the range
        return signed ? sum(a, b, width) : FULL;
      case 'mul':
      case 'wrapmul':
        return bits(ea + eb + (signed ? 1 : 0));
      case 'div': // checked: |a / b| ≤ |a|
        return !signed && literal !== undefined && literal > 0n ? shrink(a, log2(literal)) : a;
      case 'mod':
        return bits(Math.min(ea, eb));
      case 'pow': {
        if (!signed && ea <= 1) return bits(1); // 0 or 1 to any power
        if (literal === undefined) return FULL;
        // |x| < 2^ea (uint) or ≤ 2^ea (int), so |x^e| < 2^(ea·e) or ≤ 2^(ea·e); x^0 is 1
        return bits(Math.max(1, ea * Number(literal) + (signed ? 1 : 0)));
      }
      case 'bitand':
        return signed ? FULL : bits(Math.min(ea, eb));
      case 'bitor':
      case 'bitxor':
        return signed ? FULL : bits(Math.max(ea, eb));
      case 'shl':
        return signed || literal === undefined ? FULL : bits(ea + Number(literal));
      case 'shr': // SHR, or SAR on an intN: both divide the magnitude
        return literal === undefined ? a : shrink(a, Number(literal > 256n ? 256n : literal));
      default:
        return FULL;
    }
  }

  /** A value's bound: its own, joined with every leading-member write a memref can see. */
  private read(value: ValueId): Bound {
    let bound = this.values.get(value) ?? ZERO;
    for (const container of leadingContainers(this.typeOf(value))) {
      bound = join(bound, this.writes.get(canonicalTypeSignature(container)) ?? ZERO);
    }
    return bound;
  }

  private define(value: ValueId, bound: Bound): void {
    this.grow(this.values, value, bound, widthOf(this.typeOf(value)));
  }

  private joinCell(cell: CellId, bound: Bound): void {
    this.grow(this.cells, cell, bound, widthOf(this.ir.cells[cell]?.type ?? 'uint256'));
  }

  private write(container: EvsType, bound: Bound): void {
    this.grow(this.writes, canonicalTypeSignature(container), bound, widthOf(container));
  }

  /** Joins `bound` (capped at `width`) into `map[key]`, noting whether anything grew. */
  private grow<K>(map: Map<K, Bound>, key: K, bound: Bound, width: number): void {
    const old = map.get(key) ?? ZERO;
    const next = join(old, { bits: Math.min(bound.bits, width), sum: bound.sum });
    if (next.bits === old.bits && next.sum === old.sum) return;
    map.set(key, next);
    this.changed = true;
  }

  private capped(bound: Bound, width: number): number {
    return Math.min(width, bound.bits + (bound.sum ? SUM_SLACK : 0));
  }

  private typeOf(value: ValueId): EvsType {
    return this.ir.values[value]?.type ?? 'uint256';
  }
}

/** The bits a value of `type` can need at most: `N` for a `uintN`, `N − 1` for an `intN` (its
 *  range is `[-2^(N−1), 2^(N−1))`), the leading leaf's for a memref; 256 for anything else. */
function widthOf(type: EvsType): number {
  const leaf = leadingLeaf(type);
  if (!isWordType(leaf)) return 256;
  if (isNumeric(leaf)) return isSigned(leaf) ? bitsOf(leaf) - 1 : bitsOf(leaf);
  return leaf === 'bool' ? 1 : leaf === 'address' ? 160 : 256;
}

/** The tuple and array types on the way from `type` to its leading leaf, outermost first. */
function leadingContainers(type: EvsType): EvsType[] {
  const containers: EvsType[] = [];
  for (let current: EvsType | undefined = type; current !== undefined;) {
    const inner = leadingMember(current);
    if (inner !== undefined) containers.push(current);
    current = inner;
  }
  return containers;
}

function leadingLeaf(type: EvsType): EvsType {
  let current = type;
  for (let inner = leadingMember(current); inner !== undefined; inner = leadingMember(current)) {
    current = inner;
  }
  return current;
}

/** Member 0 of a tuple, element 0 of an array; `undefined` for a word, string or bytes. */
function leadingMember(type: EvsType): EvsType | undefined {
  if (typeof type === 'object' && type.type === 'tuple') {
    const member = type.components[0];
    return member === undefined ? undefined : abiParamToType(member);
  }
  return isArrayValueType(type) ? elemTypeOf(type) : undefined;
}

/** The bits of a literal word: its value's, or for a negative intN, those of `-v − 1`. */
function literalBits(type: EvsType, hex: Hex): number {
  const word = BigInt(hex);
  if (!isNumeric(type)) return 256;
  const negative = isSigned(type) && word >> 255n === 1n;
  return bitLength(negative ? (1n << 256n) - word - 1n : word);
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

function log2(n: bigint): number {
  return bitLength(n) - 1;
}

function join(a: Bound, b: Bound): Bound {
  return { bits: Math.max(a.bits, b.bits), sum: a.sum || b.sum };
}

/** `a + b` (or a signed `a − b`) as one more link of an addition chain (see the header). */
function sum(a: Bound, b: Bound, width: number): Bound {
  if (!a.sum || !b.sum) return { bits: Math.max(a.bits, b.bits), sum: true };
  const slack = (x: Bound): number => Math.min(width, x.bits + SUM_SLACK);
  return { bits: Math.max(slack(a), slack(b)), sum: true };
}

function shrink(a: Bound, by: number): Bound {
  return { bits: Math.max(0, a.bits - by), sum: a.sum };
}
