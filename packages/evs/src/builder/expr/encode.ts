/**
 * `builder/expr/encode.ts` — the recorder layer for `s.encode` / `s.encodePacked` /
 * `s.keccak256` and the hashing behind memref equality.
 */

import { EvsTypeError } from '../../core/errors.js';
import { type Expr, isPackedEncodable, stringifyType } from '../../core/types.js';
import type { ValueId } from '../../ir/nodes.js';
import { RecorderComposites } from './composites.js';
import { makeExpr } from './handles.js';

/** ABI encoding and hashing (a `Recorder` layer). */
export abstract class RecorderEncode extends RecorderComposites {
  // -- ABI encoding + hashing (issue #17) ---------------------------------------------------

  /** `s.encode(...)` / `s.encodePacked(...)`: materialize the standard/packed ABI encoding of
   *  the staged values into a fresh `bytes` value. Handles only — literals go through `s.lit`. */
  encodeOp(mode: 'abi' | 'packed', values: readonly unknown[], what: string): Expr {
    this.assertOpen(what);
    const ids = this.encodeArgIds(mode, values, what);
    const out = this.newValue('bytes', `${what.slice(0, -2)}(…)`);
    this.appendStmt({ k: 'encode', mode, args: ids, out });
    return makeExpr(this.self, out);
  }

  /**
   * `s.keccak256(...)`: hash the STANDARD ABI encoding of the values — `keccak256(abi.encode(...))`
   * (issue #24; supersedes the #17 packed default) — so it accepts everything `s.encode` accepts,
   * structs included. A single `bytes`/`string` value is hashed directly (byte-identical to
   * Solidity's `keccak256(bytes)`, no copy), which is what makes the explicit compositions hash
   * their exact bytes: the non-standard packed hash is always `s.keccak256(s.encodePacked(…))`.
   */
  keccakOp(values: readonly unknown[], what: string): Expr {
    this.assertOpen(what);
    const ids = this.encodeArgIds('abi', values, what);
    return makeExpr(this.self, this.hashIds(ids, 's.keccak256(…)'));
  }

  /** The `s.keccak256` lowering over resolved ValueIds: a single `bytes`/`string` value is hashed
   *  directly, anything else through one standard `encode` stmt. Shared with memref equality. */
  protected hashIds(ids: readonly ValueId[], debugName: string): ValueId {
    let a: ValueId;
    const single = ids.length === 1 ? ids[0] : undefined;
    const singleType = single === undefined ? null : this.typeOfValue(single);
    if (single !== undefined && (singleType === 'bytes' || singleType === 'string')) {
      a = single;
    } else {
      a = this.newValue('bytes', `${debugName} encoded bytes`);
      this.appendStmt({ k: 'encode', mode: 'abi', args: ids, out: a });
    }
    const out = this.newValue('bytes32', debugName);
    this.appendStmt({ k: 'keccak256', a, out });
    return out;
  }

  /** Resolves the variadic encode/hash values to ValueIds: an Expr, a bare Tuple/MutArray
   *  handle (its memref, like `s.return`), never a raw literal; packed mode additionally
   *  enforces Solidity's `abi.encodePacked` type restrictions. */
  private encodeArgIds(
    mode: 'abi' | 'packed',
    values: readonly unknown[],
    what: string,
  ): ValueId[] {
    if (values.length === 0) {
      throw new EvsTypeError('TYPE_MISMATCH', `${what}: at least one value is required`);
    }
    return values.map((v, i) => {
      const valueWhat = `${what} value #${i}`;
      let id: ValueId;
      const bare = this.bareHandleId(v, valueWhat);
      if (bare !== null) {
        id = bare;
      } else {
        const c = this.classify(v, valueWhat);
        if (c.kind !== 'expr') {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${valueWhat}: must be an Expr, Tuple, or MutArray handle — type a literal with s.lit(type, value)`,
          );
        }
        id = c.id;
      }
      if (mode === 'packed') {
        const ty = this.typeOfValue(id);
        if (!isPackedEncodable(ty)) {
          throw new EvsTypeError(
            'TYPE_MISMATCH',
            `${valueWhat}: '${stringifyType(ty)}' cannot be packed-encoded — abi.encodePacked supports words, string/bytes, and word-element arrays only (structs, nested arrays, and string[]/bytes[] are rejected, matching solc); use s.encode() for standard ABI encoding`,
          );
        }
      }
      return id;
    });
  }
}
