/**
 * M2 `ir/nodes.ts` — the ScriptIr node inventory, versioned JSON-safe (de)serialization, and
 * statement-tree traversal.
 *
 * Contract: docs/design/module-interfaces.md §M2 (frozen) + architecture.md §4.
 *
 * The IR is a structured statement tree over flat value/cell/fn tables — plain JSON-safe data
 * (words as 0x-hex), versioned (`irVersion: 1`), frozen after recording. `deserializeIr`
 * performs the structural (shape + version) check only; `ir/validate.ts` is the semantic trust
 * boundary (`deserialize → validate` for external IR).
 */
/* oxlint-disable unicorn/no-thenable --
 * the frozen IR schema (module-interfaces.md §M2) names the if-statement branch field `then`. */

import { EvsInternalError, EvsTypeError, type SourceLoc } from '../core/errors.js';
import { isEvsType, type ArgType, type EvsType, type Hex } from '../core/types.js';

export type ValueId = number;
export type CellId = number;
export type FnId = number;
export type SiteId = number;

export interface ScriptIr {
  readonly irVersion: 1;
  readonly name: string;
  readonly args: readonly { name: string; type: ArgType }[];
  readonly values: readonly ValueInfo[]; // indexed by ValueId
  readonly cells: readonly CellInfo[]; // indexed by CellId
  readonly fns: readonly FnIr[]; // indexed by FnId, topologically recorded
  readonly body: readonly Stmt[];
  readonly returns: readonly { name: string; type: EvsType; value: ValueId }[];
  readonly loc: SourceLoc | null;
}

export interface ValueInfo {
  readonly type: EvsType;
  readonly loc: SourceLoc | null;
  readonly debugName?: string;
}

export interface CellInfo {
  readonly type: EvsType;
  readonly loc: SourceLoc | null;
  readonly debugName?: string;
}

export interface FnIr {
  readonly name: string;
  readonly params: readonly { name: string; type: EvsType; value: ValueId }[];
  readonly results: readonly { type: EvsType }[];
  readonly body: readonly Stmt[];
  readonly resultValues: readonly ValueId[];
  readonly loc: SourceLoc | null;
}

export type BinOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'lt'
  | 'gt'
  | 'lte'
  | 'gte'
  | 'eq'
  | 'neq'
  | 'and'
  | 'or'
  | 'bitand'
  | 'bitor'
  | 'bitxor'
  | 'shl'
  | 'shr';
export type UnOp = 'not' | 'bitnot' | 'iszero';
export type EnvOp = 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid';

export type ConstData =
  | { kind: 'word'; hex: Hex } // canonical 32-byte value
  | { kind: 'data'; hex: Hex }; // pre-encoded memref payload [len:32][payload…]

export interface PlainAbiParam {
  readonly name: string;
  readonly type: string;
  readonly components?: readonly PlainAbiParam[];
}

export interface PlainAbiFunction {
  readonly name: string;
  readonly selector: Hex;
  readonly inputs: readonly PlainAbiParam[];
  readonly outputs: readonly PlainAbiParam[];
}

export type Stmt = { readonly loc: SourceLoc | null; readonly site: SiteId } & (
  | { k: 'const'; out: ValueId; data: ConstData; type: EvsType }
  | { k: 'bin'; op: BinOp; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'un'; op: UnOp; a: ValueId; out: ValueId }
  | { k: 'env'; op: EnvOp; out: ValueId }
  | { k: 'convert'; a: ValueId; out: ValueId } // semantics from values[a].type → values[out].type
  | { k: 'select'; cond: ValueId; a: ValueId; b: ValueId; out: ValueId }
  | { k: 'index'; arr: ValueId; i: ValueId; out: ValueId }
  | { k: 'len'; a: ValueId; out: ValueId }
  | { k: 'arrnew'; elem: EvsType; length: ValueId; out: ValueId }
  | { k: 'arrset'; arr: ValueId; i: ValueId; value: ValueId }
  // composite (tuple/struct) construction + member access. The out/tuple ValueId's
  // `values[id].type` carries the {@link TupleType} (with components); these nodes hold only the
  // member index. A tuple is a memref to a packed `[field0…fieldN]` block (one word per member,
  // a nested pointer for dynamic/composite members) — architecture.md §5.
  | { k: 'tuplenew'; inits: readonly { index: number; value: ValueId }[]; out: ValueId }
  | { k: 'field'; tuple: ValueId; index: number; out: ValueId }
  | { k: 'tupleset'; tuple: ValueId; index: number; value: ValueId }
  | { k: 'cellnew'; cell: CellId; init: ValueId }
  | { k: 'cellget'; cell: CellId; out: ValueId }
  | { k: 'cellset'; cell: CellId; value: ValueId }
  | {
      k: 'call';
      target: ValueId;
      fnAbi: PlainAbiFunction;
      args: readonly ValueId[];
      outs: readonly ValueId[];
      mode: 'strict' | 'try';
      successOut?: ValueId;
      gas?: ValueId;
    }
  | { k: 'fncall'; fn: FnId; args: readonly ValueId[]; outs: readonly ValueId[] }
  | { k: 'if'; cond: ValueId; then: readonly Stmt[]; else: readonly Stmt[] }
  | { k: 'while'; header: readonly Stmt[]; cond: ValueId; body: readonly Stmt[] }
  | { k: 'break' }
  | { k: 'continue' }
);

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
  const ir: ScriptIr = {
    irVersion: 1,
    name: asString(o['name'], 'ir.name'),
    args: asArray(o['args'], 'ir.args').map((a, i) => decodeArg(a, `ir.args[${i}]`)),
    values: asArray(o['values'], 'ir.values').map((v, i) => decodeInfo(v, `ir.values[${i}]`)),
    cells: asArray(o['cells'], 'ir.cells').map((c, i) => decodeInfo(c, `ir.cells[${i}]`)),
    fns: asArray(o['fns'], 'ir.fns').map((f, i) => decodeFn(f, `ir.fns[${i}]`)),
    body: decodeStmts(o['body'], 'ir.body'),
    returns: asArray(o['returns'], 'ir.returns').map((r, i) => decodeReturn(r, `ir.returns[${i}]`)),
    loc: decodeLoc(o['loc'], 'ir.loc'),
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

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

function isHexString(v: unknown): v is Hex {
  return typeof v === 'string' && HEX_RE.test(v);
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
  if (type === 'tuple' || type === 'tuple[]' || type === 'tuple[][]') {
    return {
      type,
      components: asArray(o['components'], `${path}.components`).map((c, i) =>
        decodeAbiParam(c, `${path}.components[${i}]`),
      ),
    };
  }
  return fail(`${path}.type`, `expected a tuple tag ('tuple'|'tuple[]'|'tuple[][]'), got ${describe(type)}`);
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

/** `loc` fields accept `null` and treat an absent key as `null`. */
function decodeLoc(v: unknown, path: string): SourceLoc | null {
  if (v === null || v === undefined) return null;
  const o = asRecord(v, path);
  const line: unknown = o['line'];
  const column: unknown = o['column'];
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0) {
    fail(`${path}.line`, `expected a non-negative integer, got ${describe(line)}`);
  }
  if (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 0) {
    fail(`${path}.column`, `expected a non-negative integer, got ${describe(column)}`);
  }
  return { file: asString(o['file'], `${path}.file`), line, column };
}

function decodeArg(v: unknown, path: string): { name: string; type: ArgType } {
  const o = asRecord(v, path);
  return { name: asString(o['name'], `${path}.name`), type: asEvsType(o['type'], `${path}.type`) };
}

function decodeInfo(v: unknown, path: string): ValueInfo {
  const o = asRecord(v, path);
  const type = asEvsType(o['type'], `${path}.type`);
  const loc = decodeLoc(o['loc'], `${path}.loc`);
  const debugName: unknown = o['debugName'];
  if (debugName === undefined) return { type, loc };
  return { type, loc, debugName: asString(debugName, `${path}.debugName`) };
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
    loc: decodeLoc(o['loc'], `${path}.loc`),
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

const BIN_OPS: ReadonlySet<string> = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'lt',
  'gt',
  'lte',
  'gte',
  'eq',
  'neq',
  'and',
  'or',
  'bitand',
  'bitor',
  'bitxor',
  'shl',
  'shr',
] satisfies BinOp[]);
const UN_OPS: ReadonlySet<string> = new Set(['not', 'bitnot', 'iszero'] satisfies UnOp[]);
const ENV_OPS: ReadonlySet<string> = new Set([
  'address',
  'caller',
  'timestamp',
  'blocknumber',
  'chainid',
] satisfies EnvOp[]);

function isBinOp(s: string): s is BinOp {
  return BIN_OPS.has(s);
}
function isUnOp(s: string): s is UnOp {
  return UN_OPS.has(s);
}
function isEnvOp(s: string): s is EnvOp {
  return ENV_OPS.has(s);
}

function decodeStmts(v: unknown, path: string): readonly Stmt[] {
  return asArray(v, path).map((s, i) => decodeStmt(s, `${path}[${i}]`));
}

function decodeStmt(v: unknown, path: string): Stmt {
  const o = asRecord(v, path);
  const loc = decodeLoc(o['loc'], `${path}.loc`);
  const site = asId(o['site'], `${path}.site`);
  const k: unknown = o['k'];
  if (typeof k !== 'string') fail(`${path}.k`, `expected a statement kind, got ${describe(k)}`);
  switch (k) {
    case 'const':
      return {
        loc,
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
        loc,
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
      return { loc, site, k, op, a: asId(o['a'], `${path}.a`), out: asId(o['out'], `${path}.out`) };
    }
    case 'env': {
      const op = asString(o['op'], `${path}.op`);
      if (!isEnvOp(op)) fail(`${path}.op`, `unknown env op ${describe(op)}`);
      return { loc, site, k, op, out: asId(o['out'], `${path}.out`) };
    }
    case 'convert':
      return { loc, site, k, a: asId(o['a'], `${path}.a`), out: asId(o['out'], `${path}.out`) };
    case 'select':
      return {
        loc,
        site,
        k,
        cond: asId(o['cond'], `${path}.cond`),
        a: asId(o['a'], `${path}.a`),
        b: asId(o['b'], `${path}.b`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'index':
      return {
        loc,
        site,
        k,
        arr: asId(o['arr'], `${path}.arr`),
        i: asId(o['i'], `${path}.i`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'len':
      return { loc, site, k, a: asId(o['a'], `${path}.a`), out: asId(o['out'], `${path}.out`) };
    case 'arrnew':
      return {
        loc,
        site,
        k,
        elem: asEvsType(o['elem'], `${path}.elem`),
        length: asId(o['length'], `${path}.length`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'arrset':
      return {
        loc,
        site,
        k,
        arr: asId(o['arr'], `${path}.arr`),
        i: asId(o['i'], `${path}.i`),
        value: asId(o['value'], `${path}.value`),
      };
    case 'tuplenew':
      return {
        loc,
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
        loc,
        site,
        k,
        tuple: asId(o['tuple'], `${path}.tuple`),
        index: asId(o['index'], `${path}.index`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'tupleset':
      return {
        loc,
        site,
        k,
        tuple: asId(o['tuple'], `${path}.tuple`),
        index: asId(o['index'], `${path}.index`),
        value: asId(o['value'], `${path}.value`),
      };
    case 'cellnew':
      return {
        loc,
        site,
        k,
        cell: asId(o['cell'], `${path}.cell`),
        init: asId(o['init'], `${path}.init`),
      };
    case 'cellget':
      return {
        loc,
        site,
        k,
        cell: asId(o['cell'], `${path}.cell`),
        out: asId(o['out'], `${path}.out`),
      };
    case 'cellset':
      return {
        loc,
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
      const successOut: unknown = o['successOut'];
      const gas: unknown = o['gas'];
      return {
        loc,
        site,
        k,
        target: asId(o['target'], `${path}.target`),
        fnAbi: decodeAbiFunction(o['fnAbi'], `${path}.fnAbi`),
        args: decodeIdArray(o['args'], `${path}.args`),
        outs: decodeIdArray(o['outs'], `${path}.outs`),
        mode,
        ...(successOut !== undefined ? { successOut: asId(successOut, `${path}.successOut`) } : {}),
        ...(gas !== undefined ? { gas: asId(gas, `${path}.gas`) } : {}),
      };
    }
    case 'fncall':
      return {
        loc,
        site,
        k,
        fn: asId(o['fn'], `${path}.fn`),
        args: decodeIdArray(o['args'], `${path}.args`),
        outs: decodeIdArray(o['outs'], `${path}.outs`),
      };
    case 'if':
      return {
        loc,
        site,
        k,
        cond: asId(o['cond'], `${path}.cond`),
        then: decodeStmts(o['then'], `${path}.then`),
        else: decodeStmts(o['else'], `${path}.else`),
      };
    case 'while':
      return {
        loc,
        site,
        k,
        header: decodeStmts(o['header'], `${path}.header`),
        cond: asId(o['cond'], `${path}.cond`),
        body: decodeStmts(o['body'], `${path}.body`),
      };
    case 'break':
    case 'continue':
      return { loc, site, k };
    default:
      return fail(`${path}.k`, `unknown statement kind ${describe(k)}`);
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) deepFreeze(item);
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
}

// ---------------------------------------------------------------------------
// walkStmts — statement-tree traversal
// ---------------------------------------------------------------------------

/**
 * Depth-first, pre-order walk over a statement tree (a statement is visited before its child
 * blocks). `path` alternates statement indices and child-block ordinals so nested positions
 * are unambiguous: the statement at `stmts[2].then[1]` is visited with path `[2, 0, 1]`
 * (`if`: block 0 = `then`, block 1 = `else`; `while`: block 0 = `header`, block 1 = `body`).
 */
export function walkStmts(
  stmts: readonly Stmt[],
  visit: (s: Stmt, path: readonly number[]) => void,
): void {
  walk(stmts, [], visit);
}

function walk(
  stmts: readonly Stmt[],
  prefix: readonly number[],
  visit: (s: Stmt, path: readonly number[]) => void,
): void {
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (s === undefined) continue; // sparse arrays cannot occur in well-formed IR
    const path = [...prefix, i];
    visit(s, path);
    switch (s.k) {
      case 'if':
        walk(s.then, [...path, 0], visit);
        walk(s.else, [...path, 1], visit);
        break;
      case 'while':
        walk(s.header, [...path, 0], visit);
        walk(s.body, [...path, 1], visit);
        break;
      default:
        break;
    }
  }
}
