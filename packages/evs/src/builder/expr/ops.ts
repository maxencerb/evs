/**
 * `builder/expr/ops.ts` — the recorder layer for operators: arithmetic / comparison / logic / bit
 * ops with constant folding and domain checks, `addmod` / `mulmod`, `not` / `bitNot`, conversions,
 * `length` / `at`, `env` and `select`.
 */

import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import {
  type Expr,
  type EvsType,
  typesEqual,
  isNumeric,
  stringifyType,
  isWordType,
  isSigned,
  type Hex,
  isBitsOperand,
  bitsOf,
  type WordType,
  isArrayValueType,
  isLengthType,
  elemTypeOf,
} from '../../core/types.js';
import { isEnvOp, type BinOp, type ModArithOp, type ValueId } from '../../ir/nodes.js';
import { RecorderEncode } from './encode.js';
import { makeExpr } from './handles.js';
import {
  describeHost,
  CMP_OPS,
  foldBin,
  type Operand,
  NUMERIC_OPS,
  BITS_OPS,
  fromUnsignedN,
  toUnsignedN,
  rangeOf,
} from './helpers.js';

/** Operators, conversions, indexing, env and select (a `Recorder` layer). */
export abstract class RecorderOps extends RecorderEncode {
  env(kind: unknown): Expr {
    this.assertOpen('s.env()');
    if (typeof kind !== 'string' || !isEnvOp(kind)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.env(): unknown kind ${describeHost(kind)} (expected 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid')`,
      );
    }
    const op = kind;
    const outType: EvsType = op === 'address' || op === 'caller' ? 'address' : 'uint256';
    const out = this.newValue(outType, `s.env(${op})`);
    this.appendStmt({ k: 'env', op, out });
    return makeExpr(this.self, out);
  }

  // -- ops ----------------------------------------------------------------------------------

  bin(op: BinOp, a: unknown, b: unknown, what: string): Expr {
    this.assertOpen(what);
    const isShift = op === 'shl' || op === 'shr';
    const isPow = op === 'pow';
    const isEquality = op === 'eq' || op === 'neq';
    const ca = this.classifyOperand(a, `${what} left operand`, isEquality);
    const cb = this.classifyOperand(
      b,
      `${what} ${isShift ? 'shift amount' : isPow ? 'exponent' : 'right operand'}`,
      isEquality,
    );

    // infer the operation type from the Expr operand(s)
    let ty: EvsType;
    if (isShift || isPow) {
      if (ca.kind !== 'expr') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: the ${isPow ? 'base' : 'shifted operand'} must be an Expr — type a literal with s.lit(type, value)`,
        );
      }
      ty = ca.type;
    } else if (ca.kind === 'expr' && cb.kind === 'expr') {
      if (!typesEqual(ca.type, cb.type)) {
        let suggest = '';
        if (isNumeric(ca.type) && isNumeric(cb.type)) {
          suggest = ` — make the widths match explicitly with .toUint('…') / .toInt('…')`;
        }
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operand types differ (Expr<'${stringifyType(ca.type)}'> vs Expr<'${stringifyType(cb.type)}'>)${suggest}`,
        );
      }
      ty = ca.type;
    } else if (ca.kind === 'expr') {
      ty = ca.type;
    } else if (cb.kind === 'expr') {
      ty = cb.type;
    } else {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: at least one operand must be an Expr — type a literal with s.lit(type, value)`,
      );
    }

    // memref equality (issue #38): `a.eq(b)` on string/bytes/T[]/tuple values is HASH equality —
    // rewritten at record time to `keccak256(a) == keccak256(b)` with s.keccak256's lowering.
    if (isEquality && !isWordType(ty)) return this.memrefEquality(op, a, b, ty, what);

    this.checkBinDomain(op, ty, what);
    // shift amounts are uint256; a pow exponent is any uintN (solc: an unsigned exponent)
    const bTy: EvsType = isShift ? 'uint256' : isPow ? this.exponentType(cb, what) : ty;
    const resultTy: EvsType = CMP_OPS.has(op) || op === 'and' || op === 'or' ? 'bool' : ty;

    // resolve operands to (id, logical) pairs without materializing raw literals yet
    const ra = this.resolveOperand(ca, ty, `${what} left operand`);
    const rb = this.resolveOperand(cb, bTy, `${what} right operand`);

    // all-literal fold — domain checks established ty/resultTy are word types
    if (ra.logical !== null && rb.logical !== null && isWordType(ty) && isWordType(resultTy)) {
      const f = foldBin(op, ty, ra.logical, rb.logical);
      if (!f.ok) this.certainPanic(what, f.reason, f.panic);
      return makeExpr(this.self, this.wordConst(resultTy, f.value));
    }

    const ia = ra.id ?? this.materializeWord(ty, ra);
    const ib = rb.id ?? this.materializeWord(bTy, rb);
    const out = this.newValue(resultTy);
    this.appendStmt({ k: 'bin', op, a: ia, b: ib, out });
    return makeExpr(this.self, out);
  }

  /** The exponent type of `pow`: an unsigned `Expr`'s own type, else (a literal) `uint256`. */
  private exponentType(c: Operand, what: string): EvsType {
    if (c.kind !== 'expr') return 'uint256';
    if (!isNumeric(c.type) || isSigned(c.type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: the exponent must be an unsigned Expr<'uintN'> (or a non-negative literal), got Expr<'${stringifyType(c.type)}'>`,
      );
    }
    return c.type;
  }

  /**
   * `addmod` / `mulmod` (issue #10): `(a op b) % n` at full precision over uint256 — every operand
   * is coerced to `uint256` (an `Expr<'uint256'>` or a literal). All-literal operands fold (a
   * literal zero modulus is a CERTAIN_PANIC); otherwise the zero-modulus guard is emitted unless
   * the modulus is a nonzero literal (codegen's constant-divisor elision).
   */
  modArithOp(op: ModArithOp, a: unknown, b: unknown, n: unknown, what: string): Expr {
    this.assertOpen(what);
    const names = ['left operand', 'right operand', 'modulus'] as const;
    const resolved = [a, b, n].map((v, i) =>
      this.resolveOperand(
        this.classify(v, `${what} ${names[i]}`),
        'uint256',
        `${what} ${names[i]}`,
      ),
    );
    const [ra, rb, rn] = resolved;
    if (ra === undefined || rb === undefined || rn === undefined) {
      throw new EvsInternalError('INTERNAL', `${what}: operand resolution lost an operand`);
    }
    if (ra.logical !== null && rb.logical !== null && rn.logical !== null) {
      if (rn.logical === 0n) {
        this.certainPanic(what, `${op}(${ra.logical}, ${rb.logical}, 0) takes modulo zero`, 0x12);
      }
      const r = (op === 'addmod' ? ra.logical + rb.logical : ra.logical * rb.logical) % rn.logical;
      return makeExpr(this.self, this.wordConst('uint256', r));
    }
    const ia = ra.id ?? this.materializeWord('uint256', ra);
    const ib = rb.id ?? this.materializeWord('uint256', rb);
    const iN = rn.id ?? this.materializeWord('uint256', rn);
    const out = this.newValue('uint256');
    this.appendStmt({ k: 'modarith', op, a: ia, b: ib, n: iN, out });
    return makeExpr(this.self, out);
  }

  /** `bin` operand classification. Equality additionally accepts a bare Tuple/MutArray handle as
   *  its memref (like `s.encode` / `s.return`); every other op keeps classify()'s "use .expr()"
   *  steer for those handles. */
  private classifyOperand(v: unknown, what: string, acceptBareHandles: boolean): Operand {
    if (acceptBareHandles) {
      const bare = this.bareHandleId(v, what);
      if (bare !== null) return { kind: 'expr', id: bare, type: this.typeOfValue(bare) };
    }
    return this.classify(v, what);
  }

  /**
   * `eq`/`neq` on memref operands (issue #38): hash equality. Both sides are coerced to exactly
   * `ty` (an Expr, a bare handle, or a host literal — `IntoExpr` rules), each is hashed the way
   * `s.keccak256(v)` hashes a single value (`string`/`bytes` directly → byte equality; arrays and
   * tuples through their standard ABI encoding → element-wise equality, never the ambiguous packed
   * form), and the two `bytes32` words are compared. No new IR node: the recorded stmts are exactly
   * `s.keccak256(a).eq(s.keccak256(b))`.
   */
  private memrefEquality(
    op: 'eq' | 'neq',
    a: unknown,
    b: unknown,
    ty: EvsType,
    what: string,
  ): Expr {
    // left-to-right, hash-as-you-go: the stmt order is exactly what the explicit spelling records
    // (a literal operand's const lands between the two hashes, as `s.lit` in the rhs would).
    const ha = this.hashIds(
      [this.coerceToId(a, ty, `${what} left operand`)],
      `${what} left operand hash`,
    );
    const hb = this.hashIds(
      [this.coerceToId(b, ty, `${what} right operand`)],
      `${what} right operand hash`,
    );
    const out = this.newValue('bool');
    this.appendStmt({ k: 'bin', op, a: ha, b: hb, out });
    return makeExpr(this.self, out);
  }

  private materializeWord(ty: EvsType, r: { hex: Hex | null; logical: bigint | null }): ValueId {
    if (r.logical === null || !isWordType(ty)) {
      throw new EvsInternalError(
        'INTERNAL',
        `cannot materialize operand of type '${stringifyType(ty)}'`,
      );
    }
    return this.wordConst(ty, r.logical, r.hex ?? undefined);
  }

  private resolveOperand(
    c: Operand,
    ty: EvsType,
    what: string,
  ): { id: ValueId | null; logical: bigint | null; hex: Hex | null } {
    if (c.kind === 'expr') {
      if (!typesEqual(c.type, ty)) this.typeMismatch(what, ty, c.type);
      return { id: c.id, logical: this.litValues.get(c.id) ?? null, hex: null };
    }
    if (!isWordType(ty)) {
      // unreachable through bin (domains are word types); defensive
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: '${stringifyType(ty)}' operands must be Exprs`,
      );
    }
    const { hex, logical } = this.wordLiteral(ty, c.value);
    return { id: null, logical, hex };
  }

  private checkBinDomain(op: BinOp, ty: EvsType, what: string): void {
    if (NUMERIC_OPS.has(op)) {
      if (!isNumeric(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operands must be numeric (uintN/intN), got '${stringifyType(ty)}'`,
        );
      }
      return;
    }
    if (op === 'eq' || op === 'neq') {
      // memref operands never reach here — `bin` rewrites them to hash equality (issue #38)
      if (!isWordType(ty)) {
        throw new EvsInternalError(
          'INTERNAL',
          `${what}: memref ('${stringifyType(ty)}') equality must be lowered to hash equality`,
        );
      }
      return;
    }
    if (op === 'and' || op === 'or') {
      if (ty !== 'bool') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operands must be Expr<'bool'>, got '${stringifyType(ty)}'`,
        );
      }
      return;
    }
    if (BITS_OPS.has(op)) {
      if (!isBitsOperand(ty)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: operands must be uintN/bytesN (bit-width types), got '${stringifyType(ty)}'`,
        );
      }
      return;
    }
    throw new EvsInternalError('INTERNAL', `unknown bin op '${op}'`);
  }

  notOp(a: unknown, what: string): Expr {
    this.assertOpen(what);
    const c = this.classify(a, what);
    if (c.kind === 'raw') {
      const { logical } = this.wordLiteral('bool', c.value);
      return makeExpr(this.self, this.wordConst('bool', 1n - logical));
    }
    if (c.type !== 'bool') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: operand must be Expr<'bool'>, got '${stringifyType(c.type)}'`,
      );
    }
    const lit = this.litValues.get(c.id);
    if (lit !== undefined) return makeExpr(this.self, this.wordConst('bool', 1n - lit));
    const out = this.newValue('bool');
    this.appendStmt({ k: 'un', op: 'not', a: c.id, out });
    return makeExpr(this.self, out);
  }

  bitNotOp(a: unknown, what: string): Expr {
    this.assertOpen(what);
    const c = this.classify(a, what);
    if (c.kind !== 'expr') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: operand must be an Expr — type a literal with s.lit(type, value)`,
      );
    }
    if (!isBitsOperand(c.type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: operand must be uintN/bytesN (bit-width types), got '${stringifyType(c.type)}'`,
      );
    }
    const ty = c.type;
    const lit = this.litValues.get(c.id);
    if (lit !== undefined) {
      const mask = (1n << BigInt(bitsOf(ty))) - 1n;
      const folded = fromUnsignedN(ty, ~toUnsignedN(ty, lit) & mask);
      return makeExpr(this.self, this.wordConst(ty, folded));
    }
    const out = this.newValue(ty);
    this.appendStmt({ k: 'un', op: 'bitnot', a: c.id, out });
    return makeExpr(this.self, out);
  }

  convertOp(
    kind: 'toUint' | 'toInt' | 'asAddress' | 'asUint256' | 'asBytes32',
    a: unknown,
    target: unknown,
    what: string,
  ): Expr {
    this.assertOpen(what);
    const c = this.classify(a, what);
    if (c.kind !== 'expr') {
      throw new EvsTypeError('TYPE_MISMATCH', `${what}: the converted operand must be an Expr`);
    }
    const from = c.type;
    let to: WordType;
    if (kind === 'toUint' || kind === 'toInt') {
      const prefix = kind === 'toUint' ? 'uint' : 'int';
      if (
        typeof target !== 'string' ||
        !target.startsWith(prefix) ||
        !isWordType(target) ||
        !isNumeric(target)
      ) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: target must be a ${prefix}N type, got ${describeHost(target)}`,
        );
      }
      if (!isNumeric(from)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: cannot convert from '${stringifyType(from)}' — the source must be numeric (uintN/intN)`,
        );
      }
      to = target;
    } else if (kind === 'asAddress') {
      if (from !== 'uint256' && from !== 'bytes32') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: only Expr<'uint256'> / Expr<'bytes32'> convert to address, got '${stringifyType(from)}'`,
        );
      }
      to = 'address';
    } else if (kind === 'asUint256') {
      if (from !== 'bytes32') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: only Expr<'bytes32'> reinterprets as uint256, got '${stringifyType(from)}'`,
        );
      }
      to = 'uint256';
    } else {
      if (from !== 'uint256') {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `${what}: only Expr<'uint256'> reinterprets as bytes32, got '${stringifyType(from)}'`,
        );
      }
      to = 'bytes32';
    }
    const lit = this.litValues.get(c.id);
    if (lit !== undefined) {
      const [min, max] = rangeOf(to);
      if (lit < min || lit > max) {
        this.certainPanic(what, `${lit} does not fit '${to}'`, 0x11);
      }
      return makeExpr(this.self, this.wordConst(to, lit));
    }
    const out = this.newValue(to);
    this.appendStmt({ k: 'convert', a: c.id, out });
    return makeExpr(this.self, out);
  }

  lenOp(a: unknown, what: string): Expr {
    this.assertOpen(what);
    const c = this.classify(a, what);
    // the IR verifier's `len` domain: a plain tuple is a memref but has no length
    if (c.kind !== 'expr' || !isLengthType(c.type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: .length() requires an Expr of string/bytes/T[], got ${c.kind === 'expr' ? `'${stringifyType(c.type)}'` : describeHost(a)}`,
      );
    }
    return makeExpr(this.self, this.lenId(c.id));
  }

  /** The shared `len` tail of `.length()` and `s.forEach`'s `until` snapshot — one recording
   *  path, so the documented forEach-vs-manual IR equivalence holds by construction. */
  protected lenId(a: ValueId, debugName?: string): ValueId {
    const out = this.newValue('uint256', debugName);
    this.appendStmt({ k: 'len', a, out });
    return out;
  }

  atOp(a: unknown, i: unknown, what: string): Expr | object {
    this.assertOpen(what);
    const c = this.classify(a, what);
    if (c.kind !== 'expr' || !isArrayValueType(c.type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `${what}: .at(i) requires an Expr of a T[] array type, got ${c.kind === 'expr' ? `'${stringifyType(c.type)}'` : describeHost(a)}`,
      );
    }
    const iId = this.coerceToId(i, 'uint256', `${what} index`);
    return this.indexElem(c.id, elemTypeOf(c.type), iId);
  }

  /** The shared bounds-checked `index` tail of `.at(i)` and `s.forEach`'s element load — one
   *  recording path (see `lenId`). A composite element yields its handle: a `tuple[]` element →
   *  a `Tuple` handle bound to the `index` out ValueId (same `TUPLE_INTERNALS` as a decoded
   *  tuple); a `T[][]`/`string[]` element → an Expr (whose `.at`/`.length` keep working
   *  recursively); a word element → an Expr. */
  protected indexElem(arr: ValueId, elem: EvsType, i: ValueId, debugName?: string): Expr | object {
    const out = this.newValue(elem, debugName);
    this.appendStmt({ k: 'index', arr, i, out });
    return this.valueHandle(out, elem);
  }

  select(cond: unknown, a: unknown, b: unknown): Expr {
    this.assertOpen('s.select()');
    const ca = this.classify(a, 's.select() first branch');
    const cb = this.classify(b, 's.select() second branch');
    let ty: EvsType;
    if (ca.kind === 'expr' && cb.kind === 'expr') {
      if (!typesEqual(ca.type, cb.type)) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.select(): branch types differ (Expr<'${stringifyType(ca.type)}'> vs Expr<'${stringifyType(cb.type)}'>)`,
        );
      }
      ty = ca.type;
    } else if (ca.kind === 'expr') {
      ty = ca.type;
    } else if (cb.kind === 'expr') {
      ty = cb.type;
    } else {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.select(): at least one branch must be an Expr — type a literal with s.lit(type, value)`,
      );
    }
    // literal condition folds: both branches are already-computed values,
    // so picking one is exact — the chosen operand is aliased (or interned, for a literal).
    const cc = this.classify(cond, 's.select() condition');
    let condLit: bigint | null = null;
    if (cc.kind === 'raw') {
      condLit = this.wordLiteral('bool', cc.value).logical;
    } else if (cc.type !== 'bool') {
      this.typeMismatch('s.select() condition', 'bool', cc.type);
    } else {
      condLit = this.litValues.get(cc.id) ?? null;
    }
    if (condLit !== null) {
      const chosen = condLit === 1n ? ca : cb;
      const dropped = condLit === 1n ? cb : ca;
      if (dropped.kind === 'raw') this.checkDroppedBranch(ty, dropped.value); // eager validation
      if (chosen.kind === 'expr') return makeExpr(this.self, chosen.id);
      return makeExpr(this.self, this.coerceToId(chosen.value, ty, 's.select() branch'));
    }
    const condId = cc.kind === 'expr' ? cc.id : this.coerceToId(cond, 'bool', 's.select()');
    const ia = ca.kind === 'expr' ? ca.id : this.coerceToId(ca.value, ty, 's.select() branch');
    const ib = cb.kind === 'expr' ? cb.id : this.coerceToId(cb.value, ty, 's.select() branch');
    const out = this.newValue(ty);
    this.appendStmt({ k: 'select', cond: condId, a: ia, b: ib, out });
    return makeExpr(this.self, out);
  }

  /** Validates the literal branch a folded condition drops, under exactly the rules the runtime
   *  path applies to it — so `s.select(true, a, b)` accepts the same `b` as `s.select(flag, a, b)`.
   *  A word literal is range-checked without interning. Any other literal (string/bytes, an array
   *  — composite elements or staged handles included — or a struct) goes through `coerceToId`
   *  itself and its value is left unused: the dead const / construction is dropped by
   *  `eliminateDeadCode` before codegen, so the bytecode is the chosen branch's alone. */
  private checkDroppedBranch(ty: EvsType, value: unknown): void {
    if (isWordType(ty)) {
      this.wordLiteral(ty, value);
      return;
    }
    this.coerceToId(value, ty, 's.select() branch');
  }
}
