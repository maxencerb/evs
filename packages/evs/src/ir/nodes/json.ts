/**
 * `ir/nodes/json.ts` — versioned JSON-safe (de)serialization: `serializeIr` (stable JSON) and
 * `deserializeIr` (the structural shape + version check), plus `deepFreeze`.
 */
/* oxlint-disable unicorn/no-thenable --
 * the IR schema names the if-statement branch field `then`. */

import { isHexString } from '../../core/bytes.js';
import { EvsInternalError, EvsTypeError } from '../../core/errors.js';
import {
  type Hex,
  type EvsType,
  isStringType,
  isTupleTag,
  type ArgType,
} from '../../core/types.js';
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
  isAccountOp,
  blockDepthMessage,
  MAX_BLOCK_DEPTH,
  MAX_TUPLE_DEPTH,
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
 * the message) on any malformation: `TYPE_MISMATCH`, or `UNSUPPORTED_V0` for a document whose
 * blocks nest deeper than {@link MAX_BLOCK_DEPTH} or whose types nest tuples deeper than
 * {@link MAX_TUPLE_DEPTH} (the decoders recurse once per level, so the two bounds are what keeps
 * a hostile document from overflowing the host stack). Semantic validity (op type table,
 * scoping, …) is `validateIr`'s job — `deserializeIr → validateIr` is the trust boundary for
 * external IR.
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
  const path = ROOT;
  const o = asRecord(raw, path);
  const version: unknown = o['irVersion'];
  if (version !== 1) {
    fail(
      at(path, 'irVersion'),
      `unsupported ScriptIr version ${JSON.stringify(version)} (expected 1)`,
    );
  }
  // `errors` is OPTIONAL (absent in pre-#15 IR and whenever no error is declared)
  const rawErrors: unknown = o['errors'];
  const errors =
    rawErrors === undefined ? undefined : mapArray(rawErrors, at(path, 'errors'), decodeAbiError);
  const ir: ScriptIr = {
    irVersion: 1,
    name: asString(o['name'], at(path, 'name')),
    args: mapArray(o['args'], at(path, 'args'), decodeArg),
    values: mapArray(o['values'], at(path, 'values'), decodeInfo),
    cells: mapArray(o['cells'], at(path, 'cells'), decodeInfo),
    fns: mapArray(o['fns'], at(path, 'fns'), decodeFn),
    body: decodeStmts(o['body'], at(path, 'body'), 0),
    returns: mapArray(o['returns'], at(path, 'returns'), decodeReturn),
    ...(errors === undefined ? {} : { errors }),
  };
  deepFreeze(ir);
  return ir;
}

/**
 * A position in the document: a linked list from a node up to the root, turned into a JSON path
 * only when a check fails. A node costs one small object whatever its depth, where one path
 * string per node costs the length of the path, on every node of a well-formed document.
 */
interface Path {
  readonly parent: Path | null;
  /** an object key, or an array index */
  readonly key: string | number;
}

const ROOT: Path = { parent: null, key: 'ir' };

function at(parent: Path, key: string | number): Path {
  return { parent, key };
}

/** How many leading and trailing segments {@link renderPath} keeps of an elided path. */
const ELIDED_HEAD = 6;
const ELIDED_TAIL = 4;

/**
 * `ir.body[2].then[0].cond`. With `elide`, a long path keeps its first and last segments around
 * a count of the ones left out: the path to a block nested past the limit is hundreds of segments
 * that all read the same.
 */
function renderPath(path: Path, opts?: { elide: boolean }): string {
  const segments: string[] = [];
  for (let p: Path | null = path; p !== null; p = p.parent) {
    segments.push(
      typeof p.key === 'number' ? `[${p.key}]` : p.parent === null ? p.key : `.${p.key}`,
    );
  }
  segments.reverse();
  if (opts?.elide !== true || segments.length <= ELIDED_HEAD + ELIDED_TAIL) {
    return segments.join('');
  }
  const omitted = segments.length - ELIDED_HEAD - ELIDED_TAIL;
  return `${segments.slice(0, ELIDED_HEAD).join('')} … (${omitted} more) … ${segments.slice(-ELIDED_TAIL).join('')}`;
}

function fail(path: Path, msg: string): never {
  throw new EvsTypeError('TYPE_MISMATCH', `deserializeIr: ${renderPath(path)}: ${msg}`);
}

/** Decodes each element of the array at `path`. */
function mapArray<T>(v: unknown, path: Path, decode: (item: unknown, path: Path) => T): T[] {
  return asArray(v, path).map((item, i) => decode(item, at(path, i)));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown, path: Path): Record<string, unknown> {
  if (!isRecord(v)) fail(path, `expected an object, got ${describe(v)}`);
  return v;
}

function asArray(v: unknown, path: Path): readonly unknown[] {
  if (!Array.isArray(v)) fail(path, `expected an array, got ${describe(v)}`);
  return v;
}

function asString(v: unknown, path: Path): string {
  if (typeof v !== 'string') fail(path, `expected a string, got ${describe(v)}`);
  return v;
}

/** ValueId / CellId / FnId / SiteId — non-negative safe integers. */
function asId(v: unknown, path: Path): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    fail(path, `expected a non-negative integer, got ${describe(v)}`);
  }
  return v;
}

function asHex(v: unknown, path: Path): Hex {
  if (!isHexString(v)) fail(path, `expected an even-length 0x-hex string, got ${describe(v)}`);
  return v;
}

function asEvsType(v: unknown, path: Path): EvsType {
  if (typeof v === 'string') {
    if (!isStringType(v)) fail(path, `expected a valid EvsType string, got ${describe(v)}`);
    return v;
  }
  const o = asRecord(v, path);
  const type = asString(o['type'], at(path, 'type'));
  if (isTupleTag(type)) {
    return { type, components: decodeComponents(o['components'], at(path, 'components'), 1) };
  }
  return fail(
    at(path, 'type'),
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

function decodeArg(v: unknown, path: Path): { name: string; type: ArgType } {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], at(path, 'name')),
    type: asEvsType(o['type'], at(path, 'type')),
  };
}

function decodeInfo(v: unknown, path: Path): ValueInfo {
  const o = asRecord(v, path);
  const type = asEvsType(o['type'], at(path, 'type'));
  const debugName: unknown = o['debugName'];
  if (debugName === undefined) return { type };
  return { type, debugName: asString(debugName, at(path, 'debugName')) };
}

function decodeReturn(v: unknown, path: Path): { name: string; type: EvsType; value: ValueId } {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], at(path, 'name')),
    type: asEvsType(o['type'], at(path, 'type')),
    value: asId(o['value'], at(path, 'value')),
  };
}

function decodeFn(v: unknown, path: Path): FnIr {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], at(path, 'name')),
    params: mapArray(o['params'], at(path, 'params'), (p, pPath) => {
      const po = asRecord(p, pPath);
      return {
        name: asString(po['name'], at(pPath, 'name')),
        type: asEvsType(po['type'], at(pPath, 'type')),
        value: asId(po['value'], at(pPath, 'value')),
      };
    }),
    results: mapArray(o['results'], at(path, 'results'), (r, rPath) => {
      const ro = asRecord(r, rPath);
      return { type: asEvsType(ro['type'], at(rPath, 'type')) };
    }),
    body: decodeStmts(o['body'], at(path, 'body'), 0),
    resultValues: decodeIdArray(o['resultValues'], at(path, 'resultValues')),
  };
}

function decodeIdArray(v: unknown, path: Path): readonly ValueId[] {
  return mapArray(v, path, asId);
}

function decodeConstData(v: unknown, path: Path): ConstData {
  const o = asRecord(v, path);
  const kind: unknown = o['kind'];
  const hex = asHex(o['hex'], at(path, 'hex'));
  if (kind === 'word') return { kind, hex };
  if (kind === 'data') return { kind, hex };
  return fail(at(path, 'kind'), `expected 'word' | 'data', got ${describe(kind)}`);
}

/** An ABI param sitting inside `depth` tuple levels (0 for a top-level input or output). */
function decodeAbiParam(v: unknown, path: Path, depth: number): PlainAbiParam {
  const o = asRecord(v, path);
  const name = asString(o['name'], at(path, 'name'));
  const type = asString(o['type'], at(path, 'type'));
  const components: unknown = o['components'];
  if (components === undefined) return { name, type };
  return {
    name,
    type,
    components: decodeComponents(components, at(path, 'components'), depth + 1),
  };
}

/** The members of a tuple that is itself the `depth`-th tuple level of its type (1 = outermost). */
function decodeComponents(v: unknown, path: Path, depth: number): PlainAbiParam[] {
  if (depth > MAX_TUPLE_DEPTH) {
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      `deserializeIr: ${renderPath(path, { elide: true })}: the type nests tuples more than ${MAX_TUPLE_DEPTH} levels deep — flatten the type of the script that produced this IR`,
    );
  }
  // a plain loop: this function and `decodeAbiParam` are the only frames a tuple level costs
  const items = asArray(v, path);
  const components: PlainAbiParam[] = [];
  for (let i = 0; i < items.length; i++) {
    components.push(decodeAbiParam(items[i], at(path, i), depth));
  }
  return components;
}

/** A top-level ABI param list (the inputs or outputs of a function, the inputs of an error). */
function decodeAbiParams(v: unknown, path: Path): PlainAbiParam[] {
  return mapArray(v, path, (p, pPath) => decodeAbiParam(p, pPath, 0));
}

function decodeAbiError(v: unknown, path: Path): PlainAbiError {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], at(path, 'name')),
    selector: asHex(o['selector'], at(path, 'selector')),
    inputs: decodeAbiParams(o['inputs'], at(path, 'inputs')),
  };
}

function decodeAbiFunction(v: unknown, path: Path): PlainAbiFunction {
  const o = asRecord(v, path);
  return {
    name: asString(o['name'], at(path, 'name')),
    selector: asHex(o['selector'], at(path, 'selector')),
    inputs: decodeAbiParams(o['inputs'], at(path, 'inputs')),
    outputs: decodeAbiParams(o['outputs'], at(path, 'outputs')),
  };
}

/** A block whose statements sit inside `depth` `if` / `while` statements (0 for a body). */
function decodeStmts(v: unknown, path: Path, depth: number): readonly Stmt[] {
  // a plain loop: this function and `decodeStmt` are the only frames a block level costs
  const items = asArray(v, path);
  const stmts: Stmt[] = [];
  for (let i = 0; i < items.length; i++) stmts.push(decodeStmt(items[i], at(path, i), depth));
  return stmts;
}

/** Rejects the `if` / `while` at `path`, itself inside `depth` blocks, when its own blocks
 *  would sit past {@link MAX_BLOCK_DEPTH}; returns the depth of those blocks. */
function enterBlock(path: Path, depth: number): number {
  if (depth >= MAX_BLOCK_DEPTH) {
    throw new EvsTypeError(
      'UNSUPPORTED_V0',
      blockDepthMessage(`deserializeIr: ${renderPath(path, { elide: true })}`),
    );
  }
  return depth + 1;
}

/**
 * Every statement kind. `satisfies Record<Stmt['k'], true>` makes a kind added to the schema
 * but missing here a compile error, and {@link isStmtKind} narrows the untrusted `k` to
 * `Stmt['k']`, so `decodeStmt`'s switch is checked for exhaustiveness too.
 */
const STMT_KINDS = {
  const: true,
  bin: true,
  un: true,
  modarith: true,
  env: true,
  account: true,
  convert: true,
  select: true,
  index: true,
  len: true,
  slice: true,
  arrnew: true,
  arrset: true,
  tuplenew: true,
  field: true,
  tupleset: true,
  encode: true,
  keccak256: true,
  throw: true,
  cellnew: true,
  cellget: true,
  cellset: true,
  call: true,
  fncall: true,
  if: true,
  while: true,
  break: true,
  continue: true,
} as const satisfies Record<Stmt['k'], true>;

function isStmtKind(k: string): k is Stmt['k'] {
  return Object.hasOwn(STMT_KINDS, k);
}

function decodeStmt(v: unknown, path: Path, depth: number): Stmt {
  const o = asRecord(v, path);
  const site = asId(o['site'], at(path, 'site'));
  const k: unknown = o['k'];
  if (typeof k !== 'string') fail(at(path, 'k'), `expected a statement kind, got ${describe(k)}`);
  if (!isStmtKind(k)) fail(at(path, 'k'), `unknown statement kind ${describe(k)}`);
  switch (k) {
    case 'const':
      return {
        site,
        k,
        out: asId(o['out'], at(path, 'out')),
        data: decodeConstData(o['data'], at(path, 'data')),
        type: asEvsType(o['type'], at(path, 'type')),
      };
    case 'bin': {
      const op = asString(o['op'], at(path, 'op'));
      if (!isBinOp(op)) fail(at(path, 'op'), `unknown bin op ${describe(op)}`);
      return {
        site,
        k,
        op,
        a: asId(o['a'], at(path, 'a')),
        b: asId(o['b'], at(path, 'b')),
        out: asId(o['out'], at(path, 'out')),
      };
    }
    case 'un': {
      const op = asString(o['op'], at(path, 'op'));
      if (!isUnOp(op)) fail(at(path, 'op'), `unknown un op ${describe(op)}`);
      return { site, k, op, a: asId(o['a'], at(path, 'a')), out: asId(o['out'], at(path, 'out')) };
    }
    case 'modarith': {
      const op = asString(o['op'], at(path, 'op'));
      if (!isModArithOp(op)) fail(at(path, 'op'), `unknown modarith op ${describe(op)}`);
      return {
        site,
        k,
        op,
        a: asId(o['a'], at(path, 'a')),
        b: asId(o['b'], at(path, 'b')),
        n: asId(o['n'], at(path, 'n')),
        out: asId(o['out'], at(path, 'out')),
      };
    }
    case 'env': {
      const op = asString(o['op'], at(path, 'op'));
      if (!isEnvOp(op)) fail(at(path, 'op'), `unknown env op ${describe(op)}`);
      return { site, k, op, out: asId(o['out'], at(path, 'out')) };
    }
    case 'account': {
      const op = asString(o['op'], at(path, 'op'));
      if (!isAccountOp(op)) fail(at(path, 'op'), `unknown account op ${describe(op)}`);
      return { site, k, op, a: asId(o['a'], at(path, 'a')), out: asId(o['out'], at(path, 'out')) };
    }
    case 'convert': {
      // `wrap` is OPTIONAL: absent → the checked conversion (IR recorded before it existed)
      const wrap: unknown = o['wrap'];
      if (wrap !== undefined && wrap !== true) {
        fail(at(path, 'wrap'), `expected true or absent, got ${describe(wrap)}`);
      }
      return {
        site,
        k,
        a: asId(o['a'], at(path, 'a')),
        out: asId(o['out'], at(path, 'out')),
        ...(wrap === true ? { wrap } : {}),
      };
    }
    case 'select':
      return {
        site,
        k,
        cond: asId(o['cond'], at(path, 'cond')),
        a: asId(o['a'], at(path, 'a')),
        b: asId(o['b'], at(path, 'b')),
        out: asId(o['out'], at(path, 'out')),
      };
    case 'index':
      return {
        site,
        k,
        arr: asId(o['arr'], at(path, 'arr')),
        i: asId(o['i'], at(path, 'i')),
        out: asId(o['out'], at(path, 'out')),
      };
    case 'len':
      return { site, k, a: asId(o['a'], at(path, 'a')), out: asId(o['out'], at(path, 'out')) };
    case 'slice':
      return {
        site,
        k,
        a: asId(o['a'], at(path, 'a')),
        start: asId(o['start'], at(path, 'start')),
        end: asId(o['end'], at(path, 'end')),
        out: asId(o['out'], at(path, 'out')),
      };
    case 'arrnew': {
      // `fixed` is OPTIONAL: absent → a dynamic `elem[]` (pre-#4 IR); present → `elem[N]`, N ≥ 1.
      const fixedRaw: unknown = o['fixed'];
      let fixed: number | undefined;
      if (fixedRaw !== undefined) {
        fixed = asId(fixedRaw, at(path, 'fixed'));
        if (fixed === 0 || fixed > 0xffffffff) {
          fail(
            at(path, 'fixed'),
            `expected a fixed array length in [1, 2^32), got ${describe(fixed)}`,
          );
        }
      }
      return {
        site,
        k,
        elem: asEvsType(o['elem'], at(path, 'elem')),
        length: asId(o['length'], at(path, 'length')),
        ...(fixed !== undefined ? { fixed } : {}),
        out: asId(o['out'], at(path, 'out')),
      };
    }
    case 'arrset':
      return {
        site,
        k,
        arr: asId(o['arr'], at(path, 'arr')),
        i: asId(o['i'], at(path, 'i')),
        value: asId(o['value'], at(path, 'value')),
      };
    case 'tuplenew':
      return {
        site,
        k,
        inits: mapArray(o['inits'], at(path, 'inits'), (it, iPath) => {
          const io = asRecord(it, iPath);
          return {
            index: asId(io['index'], at(iPath, 'index')),
            value: asId(io['value'], at(iPath, 'value')),
          };
        }),
        out: asId(o['out'], at(path, 'out')),
      };
    case 'field':
      return {
        site,
        k,
        tuple: asId(o['tuple'], at(path, 'tuple')),
        index: asId(o['index'], at(path, 'index')),
        out: asId(o['out'], at(path, 'out')),
      };
    case 'tupleset':
      return {
        site,
        k,
        tuple: asId(o['tuple'], at(path, 'tuple')),
        index: asId(o['index'], at(path, 'index')),
        value: asId(o['value'], at(path, 'value')),
      };
    case 'encode': {
      const mode: unknown = o['mode'];
      if (mode !== 'abi' && mode !== 'packed') {
        fail(at(path, 'mode'), `expected 'abi' | 'packed', got ${describe(mode)}`);
      }
      return {
        site,
        k,
        mode,
        args: decodeIdArray(o['args'], at(path, 'args')),
        out: asId(o['out'], at(path, 'out')),
      };
    }
    case 'keccak256':
      return { site, k, a: asId(o['a'], at(path, 'a')), out: asId(o['out'], at(path, 'out')) };
    case 'throw':
      return {
        site,
        k,
        error: asId(o['error'], at(path, 'error')),
        args: decodeIdArray(o['args'], at(path, 'args')),
      };
    case 'cellnew':
      return {
        site,
        k,
        cell: asId(o['cell'], at(path, 'cell')),
        init: asId(o['init'], at(path, 'init')),
      };
    case 'cellget':
      return {
        site,
        k,
        cell: asId(o['cell'], at(path, 'cell')),
        out: asId(o['out'], at(path, 'out')),
      };
    case 'cellset':
      return {
        site,
        k,
        cell: asId(o['cell'], at(path, 'cell')),
        value: asId(o['value'], at(path, 'value')),
      };
    case 'call': {
      const mode: unknown = o['mode'];
      if (mode !== 'strict' && mode !== 'try') {
        fail(at(path, 'mode'), `expected 'strict' | 'try', got ${describe(mode)}`);
      }
      // `kind` is OPTIONAL: absent → 'static' (pre-issue-#1 IR is STATICCALL-only).
      const kind: unknown = o['kind'];
      if (kind !== undefined && kind !== 'static' && kind !== 'call' && kind !== 'simulate') {
        fail(at(path, 'kind'), `expected 'static' | 'call' | 'simulate', got ${describe(kind)}`);
      }
      const successOut: unknown = o['successOut'];
      const gas: unknown = o['gas'];
      const value: unknown = o['value'];
      // `revertReturns` is OPTIONAL (issue #35): absent → the ABI outputs are the decode schema.
      const revertReturns: unknown = o['revertReturns'];
      return {
        site,
        k,
        target: asId(o['target'], at(path, 'target')),
        fnAbi: decodeAbiFunction(o['fnAbi'], at(path, 'fnAbi')),
        args: decodeIdArray(o['args'], at(path, 'args')),
        outs: decodeIdArray(o['outs'], at(path, 'outs')),
        mode,
        ...(kind !== undefined && kind !== 'static' ? { kind } : {}),
        ...(successOut !== undefined
          ? { successOut: asId(successOut, at(path, 'successOut')) }
          : {}),
        ...(gas !== undefined ? { gas: asId(gas, at(path, 'gas')) } : {}),
        ...(value !== undefined ? { value: asId(value, at(path, 'value')) } : {}),
        ...(revertReturns !== undefined
          ? { revertReturns: mapArray(revertReturns, at(path, 'revertReturns'), asEvsType) }
          : {}),
      };
    }
    case 'fncall':
      return {
        site,
        k,
        fn: asId(o['fn'], at(path, 'fn')),
        args: decodeIdArray(o['args'], at(path, 'args')),
        outs: decodeIdArray(o['outs'], at(path, 'outs')),
      };
    case 'if': {
      const inner = enterBlock(path, depth);
      return {
        site,
        k,
        cond: asId(o['cond'], at(path, 'cond')),
        then: decodeStmts(o['then'], at(path, 'then'), inner),
        else: decodeStmts(o['else'], at(path, 'else'), inner),
      };
    }
    case 'while': {
      const inner = enterBlock(path, depth);
      return {
        site,
        k,
        header: decodeStmts(o['header'], at(path, 'header'), inner),
        cond: asId(o['cond'], at(path, 'cond')),
        body: decodeStmts(o['body'], at(path, 'body'), inner),
      };
    }
    case 'break':
    case 'continue':
      return { site, k };
    default: {
      // unreachable: isStmtKind rejected every other string above. A distinct error class and
      // message, so a test of that guard cannot pass through here by accident.
      const unknown: never = k; // a compile error here means a statement kind has no decoder
      throw new EvsInternalError(
        'INTERNAL',
        `deserializeIr: ${renderPath(at(path, 'k'))}: statement kind ${describe(unknown)} passed isStmtKind but has no decoder`,
      );
    }
  }
}

/** Deep-freezes plain data (the recorded and the deserialized IR). */
export function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const member of Object.values(value)) deepFreeze(member);
}
