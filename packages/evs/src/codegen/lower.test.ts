/**
 * M8 unit tests — `codegen/lower.ts` statement templates, executed on the M10 harness.
 *
 * - checked-op boundary matrix (architecture §6, NORMATIVE): for every width class,
 *   `{0, 1, max−1, max, min, −1}` operands × {add,sub,mul,div,mod} against a bigint
 *   reference of the spec table, asserting exact `Panic(code)` payloads — including the
 *   uint192 mul wrap-past-2^256 case (`2^191 × (2^65+1)`), `int256 −2^255 / −1`, the
 *   int256 mul sdiv-back blind spot (`−1 × −2^255`) and `intN minN / −1`;
 * - comparisons (signed vs unsigned), bool logic, bitwise + shift canonicalization;
 * - convert: free widening, checked narrowing, cross-signedness, asAddress, reinterprets;
 * - select / index / len / arrnew (zero-fill on dirtied scratch, Panic 0x41) / arrset;
 * - cells, if/while/break/continue, fncall (×2 no-aliasing, multi-result, nested);
 * - env ops; fork smoke (paris/shanghai pushes + @memcpy return path).
 */

import { encodeAbiParameters } from 'viem';
import { describe, expect, test } from 'vitest';

import {
  CALLER_ADDRESS,
  SCRIPT_ADDRESS,
  bytesToHex,
  execRuntime,
  type EvmFixture,
} from '../../test/harness/evm.js';
import { concatHex, returner, word } from '../../test/harness/fixtures.js';
import { selectorOf } from '../abi/artifact.js';
import { assemble } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { isEvsType, isWordType, type EvsType, type Hex, type WordType } from '../core/types.js';
import type {
  BinOp,
  CellId,
  FnId,
  PlainAbiFunction,
  ScriptIr,
  Stmt,
  UnOp,
  ValueId,
} from '../ir/nodes.js';
import { lowerProgram } from './program.js';

// ---------------------------------------------------------------------------
// tiny IR builder (mirrors the recorder's output shape; validateIr checks it)
// ---------------------------------------------------------------------------

const MASK256 = (1n << 256n) - 1n;

function wordHex(v: bigint): Hex {
  return `0x${(v & MASK256).toString(16).padStart(64, '0')}`;
}

/** A `Stmt` minus the bookkeeping the builder fills in (distributed over the union). */
type StmtBody = Stmt extends infer s ? (s extends Stmt ? Omit<s, 'loc' | 'site'> : never) : never;

class IrB {
  readonly name: string;
  readonly argsList: { name: string; type: EvsType }[];
  values: { type: EvsType; loc: null }[] = [];
  cells: { type: EvsType; loc: null }[] = [];
  fns: {
    name: string;
    params: { name: string; type: EvsType; value: ValueId }[];
    results: { type: EvsType }[];
    body: readonly Stmt[];
    resultValues: readonly ValueId[];
    loc: null;
  }[] = [];
  returnsList: { name: string; type: EvsType; value: ValueId }[] = [];
  private blocks: Stmt[][] = [[]];
  private nextSite = 0;

  constructor(name: string, args: readonly (readonly [string, EvsType])[] = []) {
    this.name = name;
    this.argsList = args.map(([n, t]) => ({ name: n, type: t }));
    for (const a of this.argsList) this.values.push({ type: a.type, loc: null });
  }

  val(type: EvsType): ValueId {
    this.values.push({ type, loc: null });
    return this.values.length - 1;
  }

  typeOf(v: ValueId): EvsType {
    const info = this.values[v];
    if (info === undefined) throw new Error(`IrB: unknown value ${v}`);
    return info.type;
  }

  private emit(body: StmtBody): void {
    const block = this.blocks[this.blocks.length - 1];
    if (block === undefined) throw new Error('IrB: no open block');
    block.push({ loc: null, site: this.nextSite++, ...body });
  }

  word(type: WordType, v: bigint): ValueId {
    const out = this.val(type);
    this.emit({ k: 'const', out, data: { kind: 'word', hex: wordHex(v) }, type });
    return out;
  }

  data(type: EvsType, hex: Hex): ValueId {
    const out = this.val(type);
    this.emit({ k: 'const', out, data: { kind: 'data', hex }, type });
    return out;
  }

  bin(op: BinOp, a: ValueId, b: ValueId): ValueId {
    const boolOut = ['lt', 'gt', 'lte', 'gte', 'eq', 'neq', 'and', 'or'].includes(op);
    const out = this.val(boolOut ? 'bool' : this.typeOf(a));
    this.emit({ k: 'bin', op, a, b, out });
    return out;
  }

  un(op: UnOp, a: ValueId): ValueId {
    const out = this.val(op === 'bitnot' ? this.typeOf(a) : 'bool');
    this.emit({ k: 'un', op, a, out });
    return out;
  }

  env(op: 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid'): ValueId {
    const out = this.val(op === 'address' || op === 'caller' ? 'address' : 'uint256');
    this.emit({ k: 'env', op, out });
    return out;
  }

  convert(a: ValueId, to: EvsType): ValueId {
    const out = this.val(to);
    this.emit({ k: 'convert', a, out });
    return out;
  }

  select(cond: ValueId, a: ValueId, b: ValueId): ValueId {
    const out = this.val(this.typeOf(a));
    this.emit({ k: 'select', cond, a, b, out });
    return out;
  }

  index(arr: ValueId, i: ValueId): ValueId {
    const t = this.typeOf(arr);
    const elem = t.endsWith('[]') ? t.slice(0, -2) : '';
    if (!isWordType(elem)) throw new Error(`IrB: index over non-array '${t}'`);
    const out = this.val(elem);
    this.emit({ k: 'index', arr, i, out });
    return out;
  }

  len(a: ValueId): ValueId {
    const out = this.val('uint256');
    this.emit({ k: 'len', a, out });
    return out;
  }

  arrnew(elem: WordType, length: ValueId): ValueId {
    const out = this.val(`${elem}[]`);
    this.emit({ k: 'arrnew', elem, length, out });
    return out;
  }

  arrset(arr: ValueId, i: ValueId, value: ValueId): void {
    this.emit({ k: 'arrset', arr, i, value });
  }

  cell(type: EvsType, init: ValueId): CellId {
    this.cells.push({ type, loc: null });
    const cell = this.cells.length - 1;
    this.emit({ k: 'cellnew', cell, init });
    return cell;
  }

  cellGet(cell: CellId): ValueId {
    const info = this.cells[cell];
    if (info === undefined) throw new Error(`IrB: unknown cell ${cell}`);
    const out = this.val(info.type);
    this.emit({ k: 'cellget', cell, out });
    return out;
  }

  cellSet(cell: CellId, value: ValueId): void {
    this.emit({ k: 'cellset', cell, value });
  }

  call(o: {
    target: ValueId;
    abi: PlainAbiFunction;
    args?: readonly ValueId[];
    mode?: 'strict' | 'try';
    gas?: ValueId;
  }): { outs: readonly ValueId[]; success: ValueId | null } {
    const mode = o.mode ?? 'strict';
    const outs = o.abi.outputs.map((p) => {
      if (!isEvsType(p.type)) throw new Error(`IrB: non-v0 output type '${p.type}'`);
      return this.val(p.type);
    });
    const success = mode === 'try' ? this.val('bool') : null;
    this.emit({
      k: 'call',
      target: o.target,
      fnAbi: o.abi,
      args: o.args ?? [],
      outs,
      mode,
      ...(success === null ? {} : { successOut: success }),
      ...(o.gas === undefined ? {} : { gas: o.gas }),
    });
    return { outs, success };
  }

  fn(
    name: string,
    params: readonly EvsType[],
    build: (...ids: ValueId[]) => readonly ValueId[],
  ): FnId {
    const paramVals = params.map((t) => this.val(t));
    this.blocks.push([]);
    const resultValues = build(...paramVals);
    const body = this.blocks.pop();
    if (body === undefined) throw new Error('IrB: fn block underflow');
    this.fns.push({
      name,
      params: params.map((type, i) => {
        const value = paramVals[i];
        if (value === undefined) throw new Error('IrB: missing param value');
        return { name: `p${i}`, type, value };
      }),
      results: resultValues.map((rv) => ({ type: this.typeOf(rv) })),
      body,
      resultValues: [...resultValues],
      loc: null,
    });
    return this.fns.length - 1;
  }

  fncall(fn: FnId, args: readonly ValueId[]): readonly ValueId[] {
    const f = this.fns[fn];
    if (f === undefined) throw new Error(`IrB: unknown fn ${fn}`);
    const outs = f.results.map((r) => this.val(r.type));
    this.emit({ k: 'fncall', fn, args, outs });
    return outs;
  }

  if(cond: ValueId, then: () => void, els?: () => void): void {
    this.blocks.push([]);
    then();
    const thenStmts = this.blocks.pop() ?? [];
    this.blocks.push([]);
    els?.();
    const elseStmts = this.blocks.pop() ?? [];
    // oxlint-disable-next-line unicorn/no-thenable -- the frozen IR schema names the field `then`
    this.emit({ k: 'if', cond, then: thenStmts, else: elseStmts });
  }

  while(header: () => ValueId, body: () => void): void {
    this.blocks.push([]);
    const cond = header();
    const headerStmts = this.blocks.pop() ?? [];
    this.blocks.push([]);
    body();
    const bodyStmts = this.blocks.pop() ?? [];
    this.emit({ k: 'while', header: headerStmts, cond, body: bodyStmts });
  }

  brk(): void {
    this.emit({ k: 'break' });
  }

  cont(): void {
    this.emit({ k: 'continue' });
  }

  ret(name: string, value: ValueId): void {
    this.returnsList.push({ name, type: this.typeOf(value), value });
  }

  build(): ScriptIr {
    const body = this.blocks[0];
    if (body === undefined || this.blocks.length !== 1) throw new Error('IrB: unbalanced blocks');
    return {
      irVersion: 1,
      name: this.name,
      args: this.argsList,
      values: this.values,
      cells: this.cells,
      fns: this.fns,
      body,
      returns: this.returnsList,
      loc: null,
    };
  }
}

// ---------------------------------------------------------------------------
// compile + run helpers
// ---------------------------------------------------------------------------

function compileIr(ir: ScriptIr, evmVersion: EvmVersion = 'cancun'): Hex {
  const lowered = lowerProgram(ir, { evmVersion, locations: true });
  const { bytecode } = assemble(lowered.nodes, { evmVersion });
  return bytesToHex(bytecode);
}

function calldataFor(ir: ScriptIr, args: readonly unknown[]): Hex {
  const types = ir.args.map((a) => a.type);
  const selector = selectorOf(ir.name, types);
  if (types.length === 0) return selector;
  const params: { type: string }[] = types.map((type) => ({ type }));
  return concatHex(selector, encodeAbiParameters(params, args));
}

async function run(
  ir: ScriptIr,
  args: readonly unknown[] = [],
  fixture?: EvmFixture,
  evmVersion: EvmVersion = 'cancun',
): Promise<{ success: boolean; data: Hex; gasUsed: bigint }> {
  return execRuntime(compileIr(ir, evmVersion), calldataFor(ir, args), fixture);
}

/** Expected returndata: the §8.2 single named tuple (byte-identical to viem's encoder). */
function tupleHex(
  components: readonly { name: string; type: string }[],
  values: Record<string, unknown>,
): Hex {
  return encodeAbiParameters([{ type: 'tuple', components }], [values]);
}

function panicHex(code: number): Hex {
  return concatHex('0x4e487b71', word(BigInt(code)));
}

function fnAbi(
  name: string,
  inputs: readonly EvsType[],
  outputs: readonly EvsType[],
): PlainAbiFunction {
  return {
    name,
    selector: selectorOf(name, inputs),
    inputs: inputs.map((type, i) => ({ name: `i${i}`, type })),
    outputs: outputs.map((type, i) => ({ name: `o${i}`, type })),
  };
}

const TARGET = '0x00000000000000000000000000000000000000aa' as const;

// ---------------------------------------------------------------------------
// checked arithmetic — boundary matrix (architecture §6)
// ---------------------------------------------------------------------------

interface WidthClass {
  type: EvsType;
  bits: number;
  signed: boolean;
}

const WIDTHS: readonly WidthClass[] = [
  { type: 'uint8', bits: 8, signed: false },
  { type: 'uint64', bits: 64, signed: false },
  { type: 'uint128', bits: 128, signed: false },
  { type: 'uint192', bits: 192, signed: false },
  { type: 'uint256', bits: 256, signed: false },
  { type: 'int8', bits: 8, signed: true },
  { type: 'int128', bits: 128, signed: true },
  { type: 'int200', bits: 200, signed: true },
  { type: 'int256', bits: 256, signed: true },
];

const ARITH_OPS = ['add', 'sub', 'mul', 'div', 'mod'] as const;
type ArithOp = (typeof ARITH_OPS)[number];

function rangeOf(c: WidthClass): { min: bigint; max: bigint } {
  return c.signed
    ? { min: -(1n << BigInt(c.bits - 1)), max: (1n << BigInt(c.bits - 1)) - 1n }
    : { min: 0n, max: (1n << BigInt(c.bits)) - 1n };
}

function operandsOf(c: WidthClass): readonly bigint[] {
  const { min, max } = rangeOf(c);
  return c.signed ? [min, -1n, 0n, 1n, max] : [0n, 1n, max - 1n, max];
}

/** bigint reference of the §6 checked-op table (solc ≥0.8 semantics). */
function refArith(op: ArithOp, c: WidthClass, a: bigint, b: bigint): bigint | number {
  const { min, max } = rangeOf(c);
  const check = (r: bigint): bigint | number => (r < min || r > max ? 0x11 : r);
  switch (op) {
    case 'add':
      return check(a + b);
    case 'sub':
      return check(a - b);
    case 'mul':
      return check(a * b);
    case 'div':
      return b === 0n ? 0x12 : check(a / b); // BigInt division truncates toward zero (SDIV)
    case 'mod':
      return b === 0n ? 0x12 : a % b; // BigInt % has the dividend's sign (SMOD)
    default:
      throw new Error(`unreachable op ${op satisfies never as string}`);
  }
}

function binScript(type: EvsType, op: ArithOp): ScriptIr {
  const b = new IrB('f', [
    ['a', type],
    ['b', type],
  ]);
  b.ret('r', b.bin(op, 0, 1));
  return b.build();
}

describe('checked arithmetic — boundary matrix', () => {
  for (const width of WIDTHS) {
    for (const op of ARITH_OPS) {
      test(`${op} ${width.type}`, async () => {
        const ir = binScript(width.type, op);
        const runtime = compileIr(ir);
        const operands = operandsOf(width);
        const pairs = operands.flatMap((a) => operands.map((b) => [a, b] as const));
        await Promise.all(
          pairs.map(async ([a, b]) => {
            const expected = refArith(op, width, a, b);
            const want =
              typeof expected === 'number'
                ? { success: false, data: panicHex(expected) }
                : {
                    success: true,
                    data: tupleHex([{ name: 'r', type: width.type }], { r: expected }),
                  };
            const res = await execRuntime(runtime, calldataFor(ir, [a, b]));
            const label = `${width.type}: ${a} ${op} ${b}`;
            expect({ label, success: res.success, data: res.data }).toEqual({ label, ...want });
          }),
        );
      }, 30_000);
    }
  }

  test('uint192 mul wrap-past-2^256 panics (2^191 × (2^65 + 1))', async () => {
    const ir = binScript('uint192', 'mul');
    const res = await run(ir, [1n << 191n, (1n << 65n) + 1n]);
    expect(res.success).toBe(false);
    expect(res.data).toBe(panicHex(0x11)); // a naive range check would wrongly accept 2^191
  });

  test('int256 mul sdiv-back blind spot: −1 × −2^255 panics', async () => {
    const ir = binScript('int256', 'mul');
    const res = await run(ir, [-1n, -(1n << 255n)]);
    expect(res.success).toBe(false);
    expect(res.data).toBe(panicHex(0x11));
  });

  test('int256 −2^255 / −1 panics (EVM SDIV silently wraps)', async () => {
    const ir = binScript('int256', 'div');
    const res = await run(ir, [-(1n << 255n), -1n]);
    expect(res.success).toBe(false);
    expect(res.data).toBe(panicHex(0x11));
  });

  test('intN minN / −1 panics uniformly (int8, int200)', async () => {
    const cases = [
      ['int8', -128n],
      ['int200', -(1n << 199n)],
    ] as const;
    await Promise.all(
      cases.map(async ([type, min]) => {
        const res = await run(binScript(type, 'div'), [min, -1n]);
        expect({ type, success: res.success, data: res.data }).toEqual({
          type,
          success: false,
          data: panicHex(0x11),
        });
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// comparisons, equality, bool logic
// ---------------------------------------------------------------------------

describe('comparisons and logic', () => {
  test('signed comparisons use SLT/SGT (int8)', async () => {
    const b = new IrB('cmp', [
      ['a', 'int8'],
      ['b', 'int8'],
    ]);
    b.ret('lt', b.bin('lt', 0, 1));
    b.ret('gt', b.bin('gt', 0, 1));
    b.ret('lte', b.bin('lte', 0, 1));
    b.ret('gte', b.bin('gte', 0, 1));
    const ir = b.build();
    const components = ['lt', 'gt', 'lte', 'gte'].map((name) => ({ name, type: 'bool' }));
    const cases: readonly [bigint, bigint, boolean, boolean, boolean, boolean][] = [
      [-1n, 1n, true, false, true, false], // unsigned LT would say 2^256−1 > 1
      [1n, 1n, false, false, true, true],
      [1n, -1n, false, true, false, true],
    ];
    await Promise.all(
      cases.map(async ([a, c, lt, gt, lte, gte]) => {
        const res = await run(ir, [a, c]);
        expect({ a, c, success: res.success, data: res.data }).toEqual({
          a,
          c,
          success: true,
          data: tupleHex(components, { lt, gt, lte, gte }),
        });
      }),
    );
  });

  test('unsigned comparisons use LT/GT (uint8)', async () => {
    const b = new IrB('cmp', [
      ['a', 'uint8'],
      ['b', 'uint8'],
    ]);
    b.ret('lt', b.bin('lt', 0, 1));
    const res = await run(b.build(), [3n, 200n]);
    expect(res.data).toBe(tupleHex([{ name: 'lt', type: 'bool' }], { lt: true }));
  });

  test('eq/neq on address words', async () => {
    const b = new IrB('eqa', [['a', 'address']]);
    const lit = b.word('address', BigInt(TARGET));
    b.ret('eq', b.bin('eq', 0, lit));
    b.ret('neq', b.bin('neq', 0, lit));
    const ir = b.build();
    const components = [
      { name: 'eq', type: 'bool' },
      { name: 'neq', type: 'bool' },
    ];
    expect((await run(ir, [TARGET])).data).toBe(tupleHex(components, { eq: true, neq: false }));
    expect((await run(ir, [CALLER_ADDRESS])).data).toBe(
      tupleHex(components, { eq: false, neq: true }),
    );
  });

  test('bool and/or/not are eager opcodes on canonical 0/1', async () => {
    const b = new IrB('boolops', [
      ['x', 'bool'],
      ['y', 'bool'],
    ]);
    b.ret('and', b.bin('and', 0, 1));
    b.ret('or', b.bin('or', 0, 1));
    b.ret('notx', b.un('not', 0));
    b.ret('zx', b.un('iszero', 0));
    const ir = b.build();
    const components = ['and', 'or', 'notx', 'zx'].map((name) => ({ name, type: 'bool' }));
    expect((await run(ir, [true, false])).data).toBe(
      tupleHex(components, { and: false, or: true, notx: false, zx: false }),
    );
    expect((await run(ir, [false, false])).data).toBe(
      tupleHex(components, { and: false, or: false, notx: true, zx: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// bitwise + shifts (canonical word invariant §5)
// ---------------------------------------------------------------------------

describe('bitwise and shifts', () => {
  test('uint8: and/or/xor/bitnot/shl/shr re-canonicalize', async () => {
    const b = new IrB('bits', [
      ['a', 'uint8'],
      ['b', 'uint8'],
    ]);
    const one = b.word('uint256', 1n);
    b.ret('and', b.bin('bitand', 0, 1));
    b.ret('or', b.bin('bitor', 0, 1));
    b.ret('xor', b.bin('bitxor', 0, 1));
    b.ret('inv', b.un('bitnot', 0));
    b.ret('shl', b.bin('shl', 0, one));
    b.ret('shr', b.bin('shr', 0, one));
    const ir = b.build();
    const components = ['and', 'or', 'xor', 'inv', 'shl', 'shr'].map((name) => ({
      name,
      type: 'uint8',
    }));
    const res = await run(ir, [0x81n, 0x0fn]);
    expect(res.success).toBe(true);
    expect(res.data).toBe(
      tupleHex(components, {
        and: 0x01n,
        or: 0x8fn,
        xor: 0x8en,
        inv: 0x7en, // NOT then mask — without the mask the high 248 bits stay dirty
        shl: 0x02n, // 0x81 << 1 = 0x102, masked to width (Solidity shifts are unchecked)
        shr: 0x40n,
      }),
    );
  });

  test('int8: bitnot preserves sign-extension; shr is SAR; shl re-sign-extends', async () => {
    const b = new IrB('ibits', [['a', 'int8']]);
    const one = b.word('uint256', 1n);
    b.ret('inv', b.un('bitnot', 0));
    b.ret('sar', b.bin('shr', 0, one));
    b.ret('shl', b.bin('shl', 0, one));
    const ir = b.build();
    const components = ['inv', 'sar', 'shl'].map((name) => ({ name, type: 'int8' }));
    expect((await run(ir, [-2n])).data).toBe(tupleHex(components, { inv: 1n, sar: -1n, shl: -4n }));
    // 64 << 1 = 128 = 0x80 → re-sign-extended to −128 (the canonical int8 image of 0x80)
    expect((await run(ir, [64n])).data).toBe(
      tupleHex(components, { inv: -65n, sar: 32n, shl: -128n }),
    );
  });

  test('bytes2: shr re-masks the left-aligned lane', async () => {
    const b = new IrB('b2', [['a', 'bytes2']]);
    const eight = b.word('uint256', 8n);
    b.ret('shr', b.bin('shr', 0, eight));
    b.ret('shl', b.bin('shl', 0, eight));
    b.ret('inv', b.un('bitnot', 0));
    const ir = b.build();
    const components = ['shr', 'shl', 'inv'].map((name) => ({ name, type: 'bytes2' }));
    const res = await run(ir, ['0xabcd']);
    expect(res.success).toBe(true);
    expect(res.data).toBe(tupleHex(components, { shr: '0x00ab', shl: '0xcd00', inv: '0x5432' }));
  });
});

// ---------------------------------------------------------------------------
// convert (§6: free widening / checked narrowing / cross-sign / asAddress / reinterpret)
// ---------------------------------------------------------------------------

describe('convert', () => {
  function convScript(from: EvsType, to: EvsType): ScriptIr {
    const b = new IrB('conv', [['x', from]]);
    b.ret('y', b.convert(0, to));
    return b.build();
  }

  /** Raw returndata of `convert(x)` — success bytes and panic payloads compare uniformly. */
  async function conv(from: EvsType, to: EvsType, x: unknown): Promise<Hex> {
    return (await run(convScript(from, to), [x])).data;
  }

  function ok(to: EvsType, y: unknown): Hex {
    return tupleHex([{ name: 'y', type: to }], { y });
  }

  test('checked unsigned narrowing (uint256 → uint8)', async () => {
    expect(await conv('uint256', 'uint8', 255n)).toBe(ok('uint8', 255n));
    expect(await conv('uint256', 'uint8', 256n)).toBe(panicHex(0x11));
  });

  test('checked signed narrowing (int16 → int8, fixpoint)', async () => {
    expect(await conv('int16', 'int8', 127n)).toBe(ok('int8', 127n));
    expect(await conv('int16', 'int8', 128n)).toBe(panicHex(0x11));
    expect(await conv('int16', 'int8', -128n)).toBe(ok('int8', -128n));
    expect(await conv('int16', 'int8', -129n)).toBe(panicHex(0x11));
  });

  test('free widening (uint8 → uint256, int8 → int16, uint8 → int16)', async () => {
    expect(await conv('uint8', 'uint256', 200n)).toBe(ok('uint256', 200n));
    expect(await conv('int8', 'int16', -1n)).toBe(ok('int16', -1n));
    expect(await conv('uint8', 'int16', 255n)).toBe(ok('int16', 255n)); // fits the sign bit
  });

  test('cross-signedness is logically range-checked', async () => {
    expect(await conv('int8', 'uint256', 1n)).toBe(ok('uint256', 1n));
    expect(await conv('int8', 'uint256', -1n)).toBe(panicHex(0x11)); // NOT a reinterpret
    expect(await conv('int8', 'uint8', -1n)).toBe(panicHex(0x11));
    expect(await conv('uint8', 'int8', 200n)).toBe(panicHex(0x11));
    expect(await conv('uint8', 'int8', 100n)).toBe(ok('int8', 100n));
    expect(await conv('uint256', 'int256', (1n << 255n) - 1n)).toBe(
      ok('int256', (1n << 255n) - 1n),
    );
    expect(await conv('uint256', 'int256', 1n << 255n)).toBe(panicHex(0x11));
  });

  test('asAddress checks the high 96 bits', async () => {
    expect(await conv('uint256', 'address', (1n << 160n) - 1n)).toBe(
      ok('address', '0xffffffffffffffffffffffffffffffffffffffff'),
    );
    expect(await conv('uint256', 'address', 1n << 160n)).toBe(panicHex(0x11));
    expect(await conv('bytes32', 'address', word(BigInt(TARGET)))).toBe(ok('address', TARGET));
  });

  test('uint256 ↔ bytes32 is a free reinterpret', async () => {
    const max = MASK256;
    expect(await conv('uint256', 'bytes32', max)).toBe(ok('bytes32', word(max)));
    expect(await conv('bytes32', 'uint256', word(max))).toBe(ok('uint256', max));
  });
});

// ---------------------------------------------------------------------------
// select / memrefs (index, len, arrnew, arrset)
// ---------------------------------------------------------------------------

describe('select and arrays', () => {
  test('select picks a or b from a runtime cond (eager operands)', async () => {
    const b = new IrB('sel', [['c', 'bool']]);
    const x = b.word('uint256', 11n);
    const y = b.word('uint256', 22n);
    b.ret('r', b.select(0, x, y));
    const ir = b.build();
    expect((await run(ir, [true])).data).toBe(
      tupleHex([{ name: 'r', type: 'uint256' }], { r: 11n }),
    );
    expect((await run(ir, [false])).data).toBe(
      tupleHex([{ name: 'r', type: 'uint256' }], { r: 22n }),
    );
  });

  test('index is bounds-checked (Panic 0x32); len reads the memref length', async () => {
    const b = new IrB('idx', [
      ['xs', 'uint256[]'],
      ['i', 'uint256'],
    ]);
    b.ret('n', b.len(0));
    b.ret('x', b.index(0, 1));
    const ir = b.build();
    const components = [
      { name: 'n', type: 'uint256' },
      { name: 'x', type: 'uint256' },
    ];
    expect((await run(ir, [[7n, 8n, 9n], 2n])).data).toBe(tupleHex(components, { n: 3n, x: 9n }));
    const oob = await run(ir, [[7n, 8n, 9n], 3n]);
    expect(oob.success).toBe(false);
    expect(oob.data).toBe(panicHex(0x32));
    const empty = await run(ir, [[], 0n]);
    expect(empty.success).toBe(false);
    expect(empty.data).toBe(panicHex(0x32));
  });

  test('arrnew + arrset + index round-trip; arrset is bounds-checked', async () => {
    const b = new IrB('arr', [
      ['n', 'uint256'],
      ['i', 'uint256'],
    ]);
    const arr = b.arrnew('uint256', 0);
    const v = b.word('uint256', 42n);
    b.arrset(arr, 1, v);
    b.ret('xs', arr);
    const ir = b.build();
    expect((await run(ir, [3n, 1n])).data).toBe(
      tupleHex([{ name: 'xs', type: 'uint256[]' }], { xs: [0n, 42n, 0n] }),
    );
    const oob = await run(ir, [3n, 3n]);
    expect(oob.success).toBe(false);
    expect(oob.data).toBe(panicHex(0x32));
  });

  test('arrnew length ≥ 2^32 → Panic 0x41', async () => {
    const b = new IrB('big', [['n', 'uint256']]);
    b.ret('xs', b.arrnew('uint8', 0));
    const ir = b.build();
    const res = await run(ir, [1n << 32n]);
    expect(res.success).toBe(false);
    expect(res.data).toBe(panicHex(0x41));
    const ok = await run(ir, [2n]);
    expect(ok.success).toBe(true);
  });

  test('arrnew zero-fills memory dirtied by transient call scratch (§5)', async () => {
    // The all-literal sub-call builds 100B of calldata at MLOAD(0x40) WITHOUT bumping the
    // free pointer; only 32B of returndata snapshot are allocated afterwards, leaving dirty
    // bytes right where arrnew claims its buffer. CALLDATACOPY-from-past-the-end must zero it.
    const abi = fnAbi('mix', ['uint256', 'uint256', 'uint256'], ['uint256']);
    const b = new IrB('zf');
    const target = b.word('address', BigInt(TARGET));
    const x = b.word('uint256', MASK256);
    const { outs } = b.call({ target, abi, args: [x, x, x] });
    const two = b.word('uint256', 2n);
    const arr = b.arrnew('uint256', two);
    b.ret('xs', arr);
    b.ret('y', outs[0] ?? 0);
    const ir = b.build();
    const fixture: EvmFixture = { contracts: { [TARGET]: returner(word(5n)) } };
    const res = await run(ir, [], fixture);
    expect(res.success).toBe(true);
    expect(res.data).toBe(
      tupleHex(
        [
          { name: 'xs', type: 'uint256[]' },
          { name: 'y', type: 'uint256' },
        ],
        { xs: [0n, 0n], y: 5n },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// control flow: cells, while, break/continue, if
// ---------------------------------------------------------------------------

describe('control flow', () => {
  /** §15.3: sum 0..n−1 with cells. */
  function sumScript(): ScriptIr {
    const b = new IrB('sum', [['n', 'uint256']]);
    const zero = b.word('uint256', 0n);
    const total = b.cell('uint256', zero);
    const i = b.cell('uint256', zero);
    b.while(
      () => b.bin('lt', b.cellGet(i), 0),
      () => {
        b.cellSet(total, b.bin('add', b.cellGet(total), b.cellGet(i)));
        b.cellSet(i, b.bin('add', b.cellGet(i), b.word('uint256', 1n)));
      },
    );
    b.ret('total', b.cellGet(total));
    return b.build();
  }

  test('while + cells: sum 0..n−1', async () => {
    const ir = sumScript();
    const c = [{ name: 'total', type: 'uint256' }];
    expect((await run(ir, [5n])).data).toBe(tupleHex(c, { total: 10n }));
    expect((await run(ir, [0n])).data).toBe(tupleHex(c, { total: 0n }));
    expect((await run(ir, [100n])).data).toBe(tupleHex(c, { total: 4950n }));
  });

  test('break exits the loop; continue jumps to the header', async () => {
    // sum even i in 0..n−1, but break entirely when i == 7
    const b = new IrB('bc', [['n', 'uint256']]);
    const zero = b.word('uint256', 0n);
    const total = b.cell('uint256', zero);
    const i = b.cell('uint256', zero);
    b.while(
      () => b.bin('lt', b.cellGet(i), 0),
      () => {
        const iv = b.cellGet(i);
        b.cellSet(i, b.bin('add', iv, b.word('uint256', 1n)));
        b.if(b.bin('eq', iv, b.word('uint256', 7n)), () => {
          b.brk();
        });
        const odd = b.bin('mod', iv, b.word('uint256', 2n));
        b.if(b.bin('eq', odd, b.word('uint256', 1n)), () => {
          b.cont();
        });
        b.cellSet(total, b.bin('add', b.cellGet(total), iv));
      },
    );
    b.ret('total', b.cellGet(total));
    const ir = b.build();
    const c = [{ name: 'total', type: 'uint256' }];
    // n=20: evens below the break at i==7 → 0+2+4+6 = 12
    expect((await run(ir, [20n])).data).toBe(tupleHex(c, { total: 12n }));
    // n=5: no break, evens 0+2+4 = 6
    expect((await run(ir, [5n])).data).toBe(tupleHex(c, { total: 6n }));
  });

  test('if/else takes exactly one branch', async () => {
    const b = new IrB('ife', [['c', 'bool']]);
    const out = b.cell('uint256', b.word('uint256', 0n));
    b.if(
      0,
      () => {
        b.cellSet(out, b.word('uint256', 1n));
      },
      () => {
        b.cellSet(out, b.word('uint256', 2n));
      },
    );
    b.ret('r', b.cellGet(out));
    const ir = b.build();
    const c = [{ name: 'r', type: 'uint256' }];
    expect((await run(ir, [true])).data).toBe(tupleHex(c, { r: 1n }));
    expect((await run(ir, [false])).data).toBe(tupleHex(c, { r: 2n }));
  });

  test('if without else', async () => {
    const b = new IrB('ifo', [['c', 'bool']]);
    const out = b.cell('uint256', b.word('uint256', 9n));
    b.if(0, () => {
      b.cellSet(out, b.word('uint256', 1n));
    });
    b.ret('r', b.cellGet(out));
    const ir = b.build();
    const c = [{ name: 'r', type: 'uint256' }];
    expect((await run(ir, [true])).data).toBe(tupleHex(c, { r: 1n }));
    expect((await run(ir, [false])).data).toBe(tupleHex(c, { r: 9n }));
  });
});

// ---------------------------------------------------------------------------
// fncall (architecture §9)
// ---------------------------------------------------------------------------

describe('fncall', () => {
  test('two calls never alias (per-callsite out slots)', async () => {
    const b = new IrB('fc', [
      ['x', 'uint256'],
      ['y', 'uint256'],
    ]);
    const inc = b.fn('inc', ['uint256'], (p) => [b.bin('add', p ?? 0, b.word('uint256', 1n))]);
    const r1 = b.fncall(inc, [0]);
    const r2 = b.fncall(inc, [1]);
    b.ret('a', r1[0] ?? 0);
    b.ret('b', r2[0] ?? 0);
    const ir = b.build();
    const c = [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'uint256' },
    ];
    expect((await run(ir, [10n, 20n])).data).toBe(tupleHex(c, { a: 11n, b: 21n }));
  });

  test('multi-result fn copies every result slot', async () => {
    const b = new IrB('swap2', [
      ['x', 'uint256'],
      ['y', 'uint256'],
    ]);
    const swap = b.fn('swap', ['uint256', 'uint256'], (p, q) => [q ?? 0, p ?? 0]);
    const rs = b.fncall(swap, [0, 1]);
    b.ret('a', rs[0] ?? 0);
    b.ret('b', rs[1] ?? 0);
    const c = [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'uint256' },
    ];
    expect((await run(b.build(), [1n, 2n])).data).toBe(tupleHex(c, { a: 2n, b: 1n }));
  });

  test('nested fncall (f calls g) works with spilled return addresses', async () => {
    const b = new IrB('nest', [['x', 'uint256']]);
    const g = b.fn('g', ['uint256'], (p) => [b.bin('mul', p ?? 0, b.word('uint256', 3n))]);
    const f = b.fn('f', ['uint256'], (p) => {
      const tripled = b.fncall(g, [p ?? 0]);
      return [b.bin('add', tripled[0] ?? 0, b.word('uint256', 1n))];
    });
    const out = b.fncall(f, [0]);
    b.ret('r', out[0] ?? 0);
    const c = [{ name: 'r', type: 'uint256' }];
    expect((await run(b.build(), [5n])).data).toBe(tupleHex(c, { r: 16n }));
  });

  test('fn panics propagate (checked op inside the subroutine)', async () => {
    const b = new IrB('fp', [['x', 'uint8']]);
    const inc = b.fn('inc8', ['uint8'], (p) => [b.bin('add', p ?? 0, b.word('uint8', 1n))]);
    const out = b.fncall(inc, [0]);
    b.ret('r', out[0] ?? 0);
    const ir = b.build();
    expect((await run(ir, [254n])).success).toBe(true);
    const res = await run(ir, [255n]);
    expect(res.success).toBe(false);
    expect(res.data).toBe(panicHex(0x11));
  });
});

// ---------------------------------------------------------------------------
// env ops
// ---------------------------------------------------------------------------

describe('env ops', () => {
  test('address/caller/timestamp/blocknumber/chainid', async () => {
    const b = new IrB('env');
    b.ret('self', b.env('address'));
    b.ret('caller', b.env('caller'));
    b.ret('ts', b.env('timestamp'));
    b.ret('bn', b.env('blocknumber'));
    b.ret('chain', b.env('chainid'));
    const res = await run(b.build());
    expect(res.success).toBe(true);
    expect(res.data).toBe(
      tupleHex(
        [
          { name: 'self', type: 'address' },
          { name: 'caller', type: 'address' },
          { name: 'ts', type: 'uint256' },
          { name: 'bn', type: 'uint256' },
          { name: 'chain', type: 'uint256' },
        ],
        {
          self: SCRIPT_ADDRESS,
          caller: CALLER_ADDRESS,
          ts: 0n, // harness default block
          bn: 0n,
          chain: 1n, // harness default Common (mainnet)
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// fork smoke (paris / shanghai lowering of the same templates)
// ---------------------------------------------------------------------------

describe('evmVersion lowering smoke', () => {
  test('sum loop byte-agrees across forks at the returndata level', async () => {
    const b = new IrB('sum', [['n', 'uint256']]);
    const zero = b.word('uint256', 0n);
    const total = b.cell('uint256', zero);
    const i = b.cell('uint256', zero);
    b.while(
      () => b.bin('lt', b.cellGet(i), 0),
      () => {
        b.cellSet(total, b.bin('add', b.cellGet(total), b.cellGet(i)));
        b.cellSet(i, b.bin('add', b.cellGet(i), b.word('uint256', 1n)));
      },
    );
    b.ret('total', b.cellGet(total));
    const ir = b.build();
    const expected = tupleHex([{ name: 'total', type: 'uint256' }], { total: 10n });
    await Promise.all(
      (['cancun', 'shanghai', 'paris'] as const).map(async (evmVersion) => {
        const res = await run(ir, [5n], undefined, evmVersion);
        expect({ evmVersion, success: res.success, data: res.data }).toEqual({
          evmVersion,
          success: true,
          data: expected,
        });
      }),
    );
  });

  test('dynamic string return exercises @memcpy pre-cancun', async () => {
    const hello = concatHex(word(5n), `0x${'68656c6c6f'.padEnd(64, '0')}`);
    const expected = tupleHex([{ name: 's', type: 'string' }], { s: 'hello' });
    await Promise.all(
      (['cancun', 'shanghai', 'paris'] as const).map(async (evmVersion) => {
        const b = new IrB('greet');
        b.ret('s', b.data('string', hello));
        const res = await run(b.build(), [], undefined, evmVersion);
        expect({ evmVersion, success: res.success, data: res.data }).toEqual({
          evmVersion,
          success: true,
          data: expected,
        });
      }),
    );
  });
});
