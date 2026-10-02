/**
 * `builder/expr/composites.ts` — the recorder layer for composite values: `s.tuple`, struct /
 * tuple field access, and mutable arrays (`s.newArray`, element get / set).
 */

import { canonicalTypeSignature } from '../../abi/artifact.js';
import { EvsTypeError, EvsInternalError } from '../../core/errors.js';
import {
  isTupleType,
  isEvsValueType,
  type EvsType,
  type TupleType,
  abiParamToType,
  type Expr,
  arrayTypeOf,
  MAX_FIXED_LENGTH,
} from '../../core/types.js';
import type { ValueId } from '../../ir/nodes.js';
import { RecorderCore } from './core.js';
import { makeTuple, FieldHandle, makeExpr, MutArrayImpl } from './handles.js';
import {
  describeHost,
  asLiteralIndex,
  assertLayout,
  assertTupleGates,
  tupleDebugTag,
} from './helpers.js';

/** Tuples, fields and mutable arrays (a `Recorder` layer). */
export abstract class RecorderComposites extends RecorderCore {
  // -- tuples / structs ---------------------------------------------------------------------

  /** `s.tuple(type, init?)`: allocate a flat block, MSTORE provided members (omitted/literal-0 →
   *  no init), return a Tuple handle. */
  tuple(type: unknown, init: unknown): object {
    this.assertOpen('s.tuple()');
    if (!isTupleType(type) || !isEvsValueType(type)) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.tuple(): type must be a t.struct/t.tuple descriptor (or readonly AbiParameter[]), got ${describeHost(type)}`,
      );
    }
    if (type.type !== 'tuple') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.tuple(): ${JSON.stringify(type.type)} is an ARRAY of tuples, not a tuple — build it with s.newArray(elemTuple, n) or pass a literal array where the value is expected`,
      );
    }
    // the size gates every other tuple entry point applies (at least one component at every
    // level, the array depth, the static size), so they fail here and not in the IR validator
    assertTupleGates(type, 's.tuple()');
    const id = this.buildTupleNew(type, init, 's.tuple()', `s.tuple(${tupleDebugTag(type)})`);
    return makeTuple(this.self, id, type);
  }

  /** Builds a fresh Field handle over member `index` of a tuple ValueId. */
  makeField(tupleId: ValueId, index: number, memberType: EvsType): object {
    return new FieldHandle(this.self, tupleId, index, memberType);
  }

  /** `Tuple.at(i)`: a positional Field handle. The index must be a recording-time literal (the
   *  flat layout has no runtime member indexing). */
  tupleAt(tupleId: ValueId, tt: TupleType, i: unknown, what: string): FieldHandle {
    this.assertOpen(what);
    this.checkVisible(tupleId, what);
    const index = asLiteralIndex(i, tt.components.length, what);
    const comp = tt.components[index];
    if (comp === undefined) {
      throw new EvsInternalError('INTERNAL', `tupleAt: component ${index} missing`);
    }
    return new FieldHandle(this.self, tupleId, index, abiParamToType(comp));
  }

  /** `Tuple.expr()`: the raw memref Expr (reference semantics — aliases the SAME ValueId). */
  tupleExpr(tupleId: ValueId, what: string): Expr {
    this.assertOpen(what);
    this.checkVisible(tupleId, what);
    return makeExpr(this.self, tupleId);
  }

  /** `Field.get()`: read a member — `field` stmt. A composite member follows the pointer to a
   *  fresh Tuple handle; a scalar member yields an Expr. */
  fieldGet(tupleId: ValueId, index: number, memberType: EvsType, what: string): Expr | object {
    this.assertOpen(what);
    this.checkVisible(tupleId, what);
    const out = this.newValue(memberType);
    this.appendStmt({ k: 'field', tuple: tupleId, index, out });
    // a tuple (NOT tuple-array) member → a Tuple handle; a composite array / scalar member → an Expr.
    return this.valueHandle(out, memberType);
  }

  /** `Field.set(v)`: write a member — `tupleset` stmt (`v` coerced to the member type). */
  fieldSet(
    tupleId: ValueId,
    index: number,
    memberType: EvsType,
    value: unknown,
    what: string,
  ): void {
    this.assertOpen(what);
    this.checkVisible(tupleId, what);
    const valId = this.coerceToId(value, memberType, what);
    this.appendStmt({ k: 'tupleset', tuple: tupleId, index, value: valId });
  }

  /** `s.newArray(elem, length)` → a dynamic `elem[]`; `s.newArray(elem, N, { fixed: true })` → a
   *  fixed-size `elem[N]` (N a literal, the block's length word is provably N). */
  newArray(elem: unknown, length: unknown, opts?: unknown): MutArrayImpl {
    this.assertOpen('s.newArray()');
    if (opts !== undefined && (typeof opts !== 'object' || opts === null || Array.isArray(opts))) {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.newArray(): options must be an object ({ fixed?: boolean }), got ${describeHost(opts)}`,
      );
    }
    const fixedOpt: unknown = opts === undefined ? undefined : (opts as { fixed?: unknown }).fixed;
    if (fixedOpt !== undefined && typeof fixedOpt !== 'boolean') {
      throw new EvsTypeError(
        'TYPE_MISMATCH',
        `s.newArray(): \`fixed\` must be a boolean, got ${describeHost(fixedOpt)}`,
      );
    }
    const elemType = this.newArrayElemType(elem);
    let fixed: number | null = null;
    if (fixedOpt === true) {
      // the length of a fixed-size array is part of its TYPE, so it must be a record-time literal
      const n = typeof length === 'bigint' ? Number(length) : length;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_FIXED_LENGTH) {
        throw new EvsTypeError(
          'TYPE_MISMATCH',
          `s.newArray(…, { fixed: true }): the length of a fixed-size array must be a literal positive integer below 2^32, got ${describeHost(length)}`,
        );
      }
      fixed = n;
    }
    const arrType = arrayTypeOf(elemType, fixed);
    assertLayout(arrType, 's.newArray()');
    const lenId = this.coerceToId(length, 'uint256', 's.newArray() length');
    const lenLit = this.litValues.get(lenId);
    if (lenLit !== undefined && lenLit > BigInt(MAX_FIXED_LENGTH)) {
      this.certainPanic('s.newArray()', `literal length ${lenLit} is ≥ 2^32`, 0x41);
    }
    // the compact Solidity type name (`(uint256,address)`, not the JSON of a struct type): the
    // LOOP_ALLOCATION diagnostic quotes this debugName
    const tag = canonicalTypeSignature(elemType);
    const arrId = this.newValue(arrType, `s.newArray(${tag})`);
    this.appendStmt({
      k: 'arrnew',
      elem: elemType,
      length: lenId,
      ...(fixed === null ? {} : { fixed }),
      out: arrId,
    });
    const lenOut = this.newValue('uint256', `s.newArray(${tag}).length`);
    this.appendStmt({ k: 'len', a: arrId, out: lenOut });
    return new MutArrayImpl(this.self, arrId, elemType, makeExpr(this.self, lenOut));
  }

  /** Validate an `s.newArray` element type: any value type — a word, `string`/`bytes`, a tuple
   *  descriptor (plain or a tuple array), or any array (dynamic/fixed). A tuple descriptor passes
   *  the canonicalizer's gates (`assertTupleGates`); the rest of the classification (malformed →
   *  TYPE_MISMATCH, nested deeper than MAX_ARRAY_DEPTH → UNSUPPORTED_V0) is delegated to the
   *  layout of the resulting array type (`assertLayout`). */
  private newArrayElemType(elem: unknown): EvsType {
    if (typeof elem === 'string') {
      // a non-StringType string still produces a string we can tag; the layout check on the
      // resulting array type rejects it with the shared TYPE_MISMATCH explanation.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- arbitrary string element; assertLayout rejects malformed ones.
      return elem as EvsType;
    }
    if (isTupleType(elem)) {
      assertTupleGates(elem, 's.newArray()');
      return elem;
    }
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `s.newArray(): element type must be a t.* type (a word, string/bytes, an array, or a t.struct/t.tuple), got ${describeHost(elem)}`,
    );
  }

  arrSet(arrId: ValueId, elem: EvsType, i: unknown, v: unknown, what: string): void {
    this.assertOpen(what);
    this.checkVisible(arrId, what);
    const iId = this.coerceToId(i, 'uint256', `${what} index`);
    const vId = this.coerceToId(v, elem, `${what} value`);
    this.appendStmt({ k: 'arrset', arr: arrId, i: iId, value: vId });
  }

  arrGet(arrId: ValueId, elem: EvsType, i: unknown, what: string): Expr | object {
    this.assertOpen(what);
    this.checkVisible(arrId, what);
    const iId = this.coerceToId(i, 'uint256', `${what} index`);
    const out = this.newValue(elem);
    this.appendStmt({ k: 'index', arr: arrId, i: iId, out });
    // a `tuple[]` element → a Tuple handle (same internals as a decoded tuple); else an Expr.
    return this.valueHandle(out, elem);
  }

  arrExpr(arrId: ValueId, what: string): Expr {
    this.assertOpen(what);
    this.checkVisible(arrId, what);
    return makeExpr(this.self, arrId); // aliases the SAME ValueId (reference semantics)
  }
}
