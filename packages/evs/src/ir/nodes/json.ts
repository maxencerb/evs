/**
 * `ir/nodes/json.ts` — versioned JSON-safe (de)serialization: `serializeIr` (stable JSON) and
 * `deserializeIr` (the structural shape + version check), plus `deepFreeze`.
 */
/* oxlint-disable unicorn/no-thenable --
 * the IR schema names the if-statement branch field `then`. */

import { isHexString } from '../../core/bytes.js';
import { EvsInternalError, EvsTypeError } from '../../core/errors.js';
import { type Hex, type EvsType, isEvsType, isTupleTag, type ArgType } from '../../core/types.js';
import {
  type ScriptIr,
  type ValueInfo,
  type ValueId,
  type FnIr,
  type ConstData,
  type PlainAbiParam,
  type PlainAbiError,
  type PlainAbiFunction,
  type Stmt,
  isBinOp,
  isUnOp,
  isModArithOp,
  isEnvOp,
} from './schema.js';

// ---------------------------------------------------------------------------
// serializeIr — stable JSON
// ---------------------------------------------------------------------------

/**
 * Stable JSON encoding of a `ScriptIr`: object keys are emitted sorted and `undefined`-valued
 * (optional) properties are omitted, so two structurally equal IRs serialize to the same
 * string regardless of property insertion order. Throws `EvsInternalError` if a non-JSON-safe
 * value (bigint, function, symbol, non-finite number) leaked into the IR.
 */
export function serializeIr(ir: ScriptIr): string {
  return stableStringify(ir, 'ir');
}

function stableStringify(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new EvsInternalError(
          'INTERNAL',
          `serializeIr: ${path} is a non-finite number and cannot be serialized`,
        );
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item: unknown, i) =>
          stableStringify(item === undefined ? null : item, `${path}[${i}]`),
        );
        return `[${items.join(',')}]`;
      }
      if (!isRecord(value)) break; // exotic object (should be unreachable)
      const parts: string[] = [];
      for (const key of Object.keys(value).toSorted()) {
        const member = value[key];
        if (member === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${stableStringify(member, `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      break;
  }
  throw new EvsInternalError(
    'INTERNAL',
    `serializeIr: ${path} holds a value of type ${typeof value} which is not JSON-serializable`,
  );
}

// ---------------------------------------------------------------------------
// deserializeIr — shape + version check
// ---------------------------------------------------------------------------

/**
 * Parses a `serializeIr` string back into a deep-frozen `ScriptIr`. Performs the full
 * structural shape + version check and throws `EvsTypeError` (with the offending JSON path in
 * the message) on any malformation. Semantic validity (op type table, scoping, …) is
 * `validateIr`'s job — `deserializeIr → validateIr` is the trust boundary for external IR.
 */
export function deserializeIr(json: string): ScriptIr {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new EvsTypeError(
      'TYPE_MISMATCH',
      `deserializeIr: input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const o = asRecord(raw, 'ir');
  const version: unknown = o['irVersion'];
  if (version !== 1) {
    fail('ir.irVersion', `unsupported ScriptIr version ${JSON.stringify(version)} (expected 1)`);
  }
  // `errors` is OPTIONAL (absent in pre-#15 IR and whenever no error is declared)
  const rawErrors: unknown = o['errors'];
  const errors =
    rawErrors === undefined
      ? undefined
      : asArray(rawErrors, 'ir.errors').map((e, i) => decodeAbiError(e, `ir.errors[${i}]`));
  const ir: ScriptIr = {
    irVersion: 1,
    name: asString(o['name'], 'ir.name'),
    args: asArray(o['args'], 'ir.args').map((a, i) => decodeArg(a, `ir.args[${i}]`)),
    values: asArray(o['values'], 'ir.values').map((v, i) => decodeInfo(v, `ir.values[${i}]`)),
    cells: asArray(o['cells'], 'ir.cells').map((c, i) => decodeInfo(c, `ir.cells[${i}]`)),
    fns: asArray(o['fns'], 'ir.fns').map((f, i) => decodeFn(f, `ir.fns[${i}]`)),
    body: decodeStmts(o['body'], 'ir.body'),
    returns: asArray(o['returns'], 'ir.returns').map((r, i) => decodeReturn(r, `ir.returns[${i}]`)),
    ...(errors === undefined ? {} : { errors }),
  };
  deepFreeze(ir);
  return ir;
}

function fail(path: string, msg: string): never {
  throw new EvsTypeError('TYPE_MISMATCH', `deserializeIr: ${path}: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) fail(path, `expected an object, got ${describe(v)}`);
  return v;
}

function asArray(v: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(v)) fail(path, `expected an array, got ${describe(v)}`);
  return v;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, `expected a string, got ${describe(v)}`);
  return v;
}

/** ValueId / CellId / FnId / SiteId — non-negative safe integers. */
function asId(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    fail(path, `expected a non-negative integer, got ${describe(v)}`);
  }
  return v;
}

function asHex(v: unknown, path: string): Hex {
  if (!isHexString(v)) fail(path, `expected an even-length 0x-hex string, got ${describe(v)}`);
  return v;
}

function asEvsType(v: unknown, path: string): EvsType {
  if (typeof v === 'string') {
    if (!isEvsType(v)) fail(path, `expected a valid EvsType string, got ${describe(v)}`);
    return v;
  }
  const o = asRecord(v, path);
  const type = asString(o['type'], `${path}.type`);
  if (isTupleTag(type)) {
    return {
      type,
      components: asArray(o['components'], `${path}.components`).map((c, i) =>
        decodeAbiParam(c, `${path}.components[${i}]`),
      ),
    };
  }
  return fail(
    `${path}.type`,
    `expected a tuple tag ('tuple' followed by \`[]\`/\`[N]\` suffixes), got ${describe(type)}`,
  );
}

function describe(v: unknown): string {
  switch (typeof v) {
    case 'undefined':
      return 'undefined';
    case 'function':
      return 'a function';
    case 'symbol':
      return 'a symbol';
    case 'bigint':
      return `${v}n`;
    default: {
      // object / array / string / number / boolean / null — all JSON-representable
      const json = JSON.stringify(v);
      return json === undefined ? 'undefined' : json;
    }
  }
}

function decodeArg(v: unknown, path: string): { name: string; type: ArgType } {
  const o = asRecord(v, path);
  return { name: asString(o['name'], `${path}.name`), type: asEvsType(o['type'], `${path}.type`) };
}

function decodeInfo(v: unknown, path: string): ValueInfo {
  const o = asRecord(v, path);
  const type = asEvsType(o['type'], `${path}.type`);
  const debugName: unknown = o['debugName'];
  if (debugName === undefined) return { type };
  return { type, debugName: asString(debugName, `${path}.debugName`) };
}

function decodeReturn(v: unknown, path: string): { name: string; type: EvsType; value: ValueId } {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], `${path}.name`),
    type: asEvsType(o['type'], `${path}.type`),
    value: asId(o['value'], `${path}.value`),
  };
}

function decodeFn(v: unknown, path: string): FnIr {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], `${path}.name`),
    params: asArray(o['params'], `${path}.params`).map((p, i) => {
      const po = asRecord(p, `${path}.params[${i}]`);
      return {
        name: asString(po['name'], `${path}.params[${i}].name`),
        type: asEvsType(po['type'], `${path}.params[${i}].type`),
        value: asId(po['value'], `${path}.params[${i}].value`),
      };
    }),
    results: asArray(o['results'], `${path}.results`).map((r, i) => {
      const ro = asRecord(r, `${path}.results[${i}]`);
      return { type: asEvsType(ro['type'], `${path}.results[${i}].type`) };
    }),
    body: decodeStmts(o['body'], `${path}.body`),
    resultValues: decodeIdArray(o['resultValues'], `${path}.resultValues`),
  };
}

function decodeIdArray(v: unknown, path: string): readonly ValueId[] {
  return asArray(v, path).map((id, i) => asId(id, `${path}[${i}]`));
}

function decodeConstData(v: unknown, path: string): ConstData {
  const o = asRecord(v, path);
  const kind: unknown = o['kind'];
  const hex = asHex(o['hex'], `${path}.hex`);
  if (kind === 'word') return { kind, hex };
  if (kind === 'data') return { kind, hex };
  return fail(`${path}.kind`, `expected 'word' | 'data', got ${describe(kind)}`);
}

function decodeAbiParam(v: unknown, path: string): PlainAbiParam {
  const o = asRecord(v, path);
  const name = asString(o['name'], `${path}.name`);
  const type = asString(o['type'], `${path}.type`);
  const components: unknown = o['components'];
  if (components === undefined) return { name, type };
  return {
    name,
    type,
    components: asArray(components, `${path}.components`).map((c, i) =>
      decodeAbiParam(c, `${path}.components[${i}]`),
    ),
  };
}

function decodeAbiError(v: unknown, path: string): PlainAbiError {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], `${path}.name`),
    selector: asHex(o['selector'], `${path}.selector`),
    inputs: asArray(o['inputs'], `${path}.inputs`).map((p, i) =>
      decodeAbiParam(p, `${path}.inputs[${i}]`),
    ),
  };
}

function decodeAbiFunction(v: unknown, path: string): PlainAbiFunction {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], `${path}.name`),
    selector: asHex(o['selector'], `${path}.selector`),
    inputs: asArray(o['inputs'], `${path}.inputs`).map((p, i) =>
      decodeAbiParam(p, `${path}.inputs[${i}]`),
    ),
    outputs: asArray(o['outputs'], `${path}.outputs`).map((p, i) =>
      decodeAbiParam(p, `${path}.outputs[${i}]`),
    ),
  };
}

function decodeStmts(v: unknown, path: string): readonly Stmt[] {
  return asArray(v, path).map((s, i) => decodeStmt(s, `${path}[${i}]`));
}

function decodeStmt(v: unknown, path: string): Stmt {
  const o = asRecord(v, path);
  const site = asId(o['site'], `${path}.site`);
  const k: unknown = o['k'];
  if (typeof k !== 'string') fail(`${path}.k`, `expected a statement kind, got ${describe(k)}`);
  switch (k) {
    case 'const':
      return {
        site,
        k,
        out: asId(o['out'], `${path}.out`),
        data: decodeConstData(o['data'], `${path}.data`),
        type: asEvsType(o['type'], `${path}.type`),
      };
    case 'bin': {
      const op = asString(o['op'], `${path}.op`);
      if (!isBinOp(op)) fail(`${path}.op`, `unknown bin op ${describe(op)}`);
      return {
        site,
        k,
        op,
        a: asId(o['a'], `${path}.a`),
        b: asId(o['b'], `${path}.b`),
        out: asId(o['out'], `${path}.out`),
      };
    }
    case 'un': {
      const op = asString(o['op'], `${path}.op`);
      if (!isUnOp(op)) fail(`${path}.op`, `unknown un op ${describe(op)}`);
      return { site, k, op, a: asId(o['a'], `${path}.a`), out: asId(o['out'], `${path}.out`) };
    }
    case 'modarith': {
      const op = asString(o['op'], `${path}.op`);
      if (!isModArithOp(op)) fail(`${path}.op`, `unknown modarith op ${describe(op)}`);
      return {
        site,
        k,
        op,
        a: asId(o['a'], `${path}.a`),
        b: asId(o['b'], `${path}.b`),
        n: asId(o['n'], `${path}.n`),
        out: asId(o['out'], `${path}.out`),
      };
    }
    case 'env': {
      const op = asString(o['op'], `${path}.op`);
      if (!isEnvOp(op)) fail(`${path}.op`, `unknown env op ${describe(op)}`);
      return { site, k, op, out: asId(o['out'], `${path}.out`) };
    }
    case 'convert':
      return { site, k, a: asId(o['a'], `${path}.a`), out: asId(o['out'], `${path}.out`) };
    case 'select':
      return {
        site,
        k,
        cond: asId(o['cond'], `${path}.cond`),
        a: asId(o['a'], `${path}.a`),
        b: asId(o['b'], `${path}.b`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'index':
      return {
        site,
        k,
        arr: asId(o['arr'], `${path}.arr`),
        i: asId(o['i'], `${path}.i`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'len':
      return { site, k, a: asId(o['a'], `${path}.a`), out: asId(o['out'], `${path}.out`) };
    case 'arrnew': {
      // `fixed` is OPTIONAL: absent → a dynamic `elem[]` (pre-#4 IR); present → `elem[N]`, N ≥ 1.
      const fixedRaw: unknown = o['fixed'];
      let fixed: number | undefined;
      if (fixedRaw !== undefined) {
        fixed = asId(fixedRaw, `${path}.fixed`);
        if (fixed === 0 || fixed > 0xffffffff) {
          fail(
            `${path}.fixed`,
            `expected a fixed array length in [1, 2^32), got ${describe(fixed)}`,
          );
        }
      }
      return {
        site,
        k,
        elem: asEvsType(o['elem'], `${path}.elem`),
        length: asId(o['length'], `${path}.length`),
        ...(fixed !== undefined ? { fixed } : {}),
        out: asId(o['out'], `${path}.out`),
      };
    }
    case 'arrset':
      return {
        site,
        k,
        arr: asId(o['arr'], `${path}.arr`),
        i: asId(o['i'], `${path}.i`),
        value: asId(o['value'], `${path}.value`),
      };
    case 'tuplenew':
      return {
        site,
        k,
        inits: asArray(o['inits'], `${path}.inits`).map((it, j) => {
          const io = asRecord(it, `${path}.inits[${j}]`);
          return {
            index: asId(io['index'], `${path}.inits[${j}].index`),
            value: asId(io['value'], `${path}.inits[${j}].value`),
          };
        }),
        out: asId(o['out'], `${path}.out`),
      };
    case 'field':
      return {
        site,
        k,
        tuple: asId(o['tuple'], `${path}.tuple`),
        index: asId(o['index'], `${path}.index`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'tupleset':
      return {
        site,
        k,
        tuple: asId(o['tuple'], `${path}.tuple`),
        index: asId(o['index'], `${path}.index`),
        value: asId(o['value'], `${path}.value`),
      };
    case 'encode': {
      const mode: unknown = o['mode'];
      if (mode !== 'abi' && mode !== 'packed') {
        fail(`${path}.mode`, `expected 'abi' | 'packed', got ${describe(mode)}`);
      }
      return {
        site,
        k,
        mode,
        args: decodeIdArray(o['args'], `${path}.args`),
        out: asId(o['out'], `${path}.out`),
      };
    }
    case 'keccak256':
      return { site, k, a: asId(o['a'], `${path}.a`), out: asId(o['out'], `${path}.out`) };
    case 'throw':
      return {
        site,
        k,
        error: asId(o['error'], `${path}.error`),
        args: decodeIdArray(o['args'], `${path}.args`),
      };
    case 'cellnew':
      return {
        site,
        k,
        cell: asId(o['cell'], `${path}.cell`),
        init: asId(o['init'], `${path}.init`),
      };
    case 'cellget':
      return {
        site,
        k,
        cell: asId(o['cell'], `${path}.cell`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'cellset':
      return {
        site,
        k,
        cell: asId(o['cell'], `${path}.cell`),
        value: asId(o['value'], `${path}.value`),
      };
    case 'call': {
      const mode: unknown = o['mode'];
      if (mode !== 'strict' && mode !== 'try') {
        fail(`${path}.mode`, `expected 'strict' | 'try', got ${describe(mode)}`);
      }
      // `kind` is OPTIONAL: absent → 'static' (pre-issue-#1 IR is STATICCALL-only).
      const kind: unknown = o['kind'];
      if (kind !== undefined && kind !== 'static' && kind !== 'call' && kind !== 'simulate') {
        fail(`${path}.kind`, `expected 'static' | 'call' | 'simulate', got ${describe(kind)}`);
      }
      const successOut: unknown = o['successOut'];
      const gas: unknown = o['gas'];
      // `revertReturns` is OPTIONAL (issue #35): absent → the ABI outputs are the decode schema.
      const revertReturns: unknown = o['revertReturns'];
      return {
        site,
        k,
        target: asId(o['target'], `${path}.target`),
        fnAbi: decodeAbiFunction(o['fnAbi'], `${path}.fnAbi`),
        args: decodeIdArray(o['args'], `${path}.args`),
        outs: decodeIdArray(o['outs'], `${path}.outs`),
        mode,
        ...(kind !== undefined && kind !== 'static' ? { kind } : {}),
        ...(successOut !== undefined ? { successOut: asId(successOut, `${path}.successOut`) } : {}),
        ...(gas !== undefined ? { gas: asId(gas, `${path}.gas`) } : {}),
        ...(revertReturns !== undefined
          ? {
              revertReturns: asArray(revertReturns, `${path}.revertReturns`).map((ty, i) =>
                asEvsType(ty, `${path}.revertReturns[${i}]`),
              ),
            }
          : {}),
      };
    }
    case 'fncall':
      return {
        site,
        k,
        fn: asId(o['fn'], `${path}.fn`),
        args: decodeIdArray(o['args'], `${path}.args`),
        outs: decodeIdArray(o['outs'], `${path}.outs`),
      };
    case 'if':
      return {
        site,
        k,
        cond: asId(o['cond'], `${path}.cond`),
        then: decodeStmts(o['then'], `${path}.then`),
        else: decodeStmts(o['else'], `${path}.else`),
      };
    case 'while':
      return {
        site,
        k,
        header: decodeStmts(o['header'], `${path}.header`),
        cond: asId(o['cond'], `${path}.cond`),
        body: decodeStmts(o['body'], `${path}.body`),
      };
    case 'break':
    case 'continue':
      return { site, k };
    default:
      return fail(`${path}.k`, `unknown statement kind ${describe(k)}`);
  }
}

/** Deep-freezes plain data (the recorded and the deserialized IR). */
export function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const member of Object.values(value)) deepFreeze(member);
}
