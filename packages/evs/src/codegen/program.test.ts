/**
 * M8 unit tests — `codegen/program.ts` (`lowerProgram`) + disassembly goldens for the
 * architecture §15 worked examples.
 *
 * - dispatcher goldens (full annotated listing of a minimal script) + `EvsInvalidCalldata`
 *   behavior (short calldata, wrong selector, truncated args, malformed dynamic args);
 * - worked-example goldens: §15.1 checked ADD, §15.2 `symbol()` decode, §15.3 while loop —
 *   lowered as verified fragments over the doc's exact frame slots;
 * - call statements end-to-end: strict success / byte-exact revert bubbling /
 *   `EvsDecodeError(site)` on attacker returndata (gas sanity — no all-gas halt) / tryCall
 *   zeroing / gas cap;
 * - data segments: placed last behind INVALID, content-deduplicated;
 * - diagnostics: LOOP_ALLOCATION (call-with-outputs / arrnew / dynamic literal in a loop)
 *   and LARGE_FRAME; sites table; labelNames; locations:false stripping; determinism;
 *   sourceMap segment coverage; uncalled fns dropped.
 */

import { encodeAbiParameters } from 'viem';
import { describe, expect, test } from 'vitest';

import { bytesToHex, execRuntime, type EvmFixture } from '../../test/harness/evm.js';
import {
  ATTACKER_RETURNERS,
  concatHex,
  returner,
  reverter,
  word,
} from '../../test/harness/fixtures.js';
import { selectorOf } from '../abi/artifact.js';
import { AsmWriter, assemble, type LabelId } from '../asm/assembler.js';
import { disassemble } from '../asm/disasm.js';
import type { EvmVersion } from '../asm/ops.js';
import type { SourceLoc } from '../core/errors.js';
import { isEvsType, isWordType, type EvsType, type Hex, type WordType } from '../core/types.js';
import type {
  BinOp,
  CellId,
  FnId,
  PlainAbiFunction,
  ScriptIr,
  Stmt,
  ValueId,
} from '../ir/nodes.js';
import type { FrameLayout } from './frame.js';
import { lowerInternals, lowerStmts, type LowerCtx } from './lower.js';
import { lowerProgram } from './program.js';
import { createSharedTails, emitDecodeFailStub, emitSharedTails } from './tails.js';

// ---------------------------------------------------------------------------
// tiny IR builder (same shape as in lower.test.ts, plus per-stmt locs)
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
  loc: SourceLoc | null = null; // applied to subsequently emitted stmts
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
    block.push({ loc: this.loc, site: this.nextSite++, ...body });
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

  convert(a: ValueId, to: EvsType): ValueId {
    const out = this.val(to);
    this.emit({ k: 'convert', a, out });
    return out;
  }

  env(op: 'address' | 'caller' | 'timestamp' | 'blocknumber' | 'chainid'): ValueId {
    const out = this.val(op === 'address' || op === 'caller' ? 'address' : 'uint256');
    this.emit({ k: 'env', op, out });
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

  arrnew(elem: WordType, length: ValueId): ValueId {
    const out = this.val(`${elem}[]`);
    this.emit({ k: 'arrnew', elem, length, out });
    return out;
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
  }): { outs: readonly ValueId[]; success: ValueId | null; site: number } {
    const mode = o.mode ?? 'strict';
    const outs = o.abi.outputs.map((p) => {
      if (!isEvsType(p.type)) throw new Error(`IrB: non-v0 output type '${p.type}'`);
      return this.val(p.type);
    });
    const success = mode === 'try' ? this.val('bool') : null;
    const site = this.nextSite;
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
    return { outs, success, site };
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

  while(header: () => ValueId, body: () => void): void {
    this.blocks.push([]);
    const cond = header();
    const headerStmts = this.blocks.pop() ?? [];
    this.blocks.push([]);
    body();
    const bodyStmts = this.blocks.pop() ?? [];
    this.emit({ k: 'while', header: headerStmts, cond, body: bodyStmts });
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
// helpers
// ---------------------------------------------------------------------------

function compileIr(
  ir: ScriptIr,
  opts?: { evmVersion?: EvmVersion; locations?: boolean },
): {
  runtime: Hex;
  lowered: ReturnType<typeof lowerProgram>;
  sourceMap: import('../asm/sourcemap.js').SourceMap;
} {
  const evmVersion = opts?.evmVersion ?? 'cancun';
  const lowered = lowerProgram(ir, { evmVersion, locations: opts?.locations ?? true });
  const { bytecode, sourceMap } = assemble(lowered.nodes, { evmVersion });
  return { runtime: bytesToHex(bytecode), lowered, sourceMap };
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
): Promise<{ success: boolean; data: Hex; gasUsed: bigint }> {
  return execRuntime(compileIr(ir).runtime, calldataFor(ir, args), fixture);
}

function tupleHex(
  components: readonly { name: string; type: string }[],
  values: Record<string, unknown>,
): Hex {
  return encodeAbiParameters([{ type: 'tuple', components }], [values]);
}

const INVALID_CALLDATA: Hex = selectorOf('EvsInvalidCalldata', []);
const DECODE_ERROR_SELECTOR: Hex = selectorOf('EvsDecodeError', ['uint256']);

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

/** ABI-encoded `string` returndata (what a real `symbol()` returns). */
function encodedString(s: string): Hex {
  return encodeAbiParameters([{ type: 'string' }], [s]);
}

// ---------------------------------------------------------------------------
// fragments — worked-example goldens over the doc's exact frame slots
// ---------------------------------------------------------------------------

interface FragmentSpec {
  values: readonly EvsType[];
  slots: ReadonlyMap<ValueId, number | null>;
  cellSlots?: readonly number[];
  cellTypes?: readonly EvsType[];
  body: readonly Stmt[];
  pre?: (w: AsmWriter) => void;
  evmVersion?: EvmVersion;
}

/** Lowers `body` over a hand-pinned frame, terminates with STOP, assembles (verified), and
 * returns the annotated listing up to the STOP — the §15 worked-example shape. */
function fragmentListing(spec: FragmentSpec): string {
  const evmVersion = spec.evmVersion ?? 'cancun';
  const w = new AsmWriter();
  const tails = createSharedTails(w, { evmVersion });
  const maxSlot = Math.max(
    0x60,
    ...[...spec.slots.values()].filter((s): s is number => s !== null),
    ...(spec.cellSlots ?? []),
  );
  const frame: FrameLayout = {
    slotOfValue(v: ValueId): number | null {
      const slot = spec.slots.get(v);
      if (slot === undefined) throw new Error(`fragment: no slot pinned for value ${v}`);
      return slot;
    },
    slotOfCell(c: CellId): number {
      const slot = spec.cellSlots?.[c];
      if (slot === undefined) throw new Error(`fragment: no slot pinned for cell ${c}`);
      return slot;
    },
    fnRegion(): { params: readonly number[]; results: readonly number[] } {
      throw new Error('fragment: no fns');
    },
    frameEnd: maxSlot + 32,
  };
  const ir: ScriptIr = {
    irVersion: 1,
    name: 'fragment',
    args: [],
    values: spec.values.map((type) => ({ type, loc: null })),
    cells: (spec.cellTypes ?? []).map((type) => ({ type, loc: null })),
    fns: [],
    body: spec.body,
    returns: [],
    loc: null,
  };
  const segments: { label: LabelId; bytes: Uint8Array }[] = [];
  const ctx: LowerCtx = {
    ir,
    frame,
    tails,
    opts: { evmVersion },
    loop: null,
    fnBaseline: 0,
    dataSeg: (bytes) => {
      const label = w.newLabel(`data_${segments.length}`);
      segments.push({ label, bytes });
      return label;
    },
    siteOf: (s) => s.site,
  };
  spec.pre?.(w);
  lowerStmts(w, spec.body, ctx);
  w.op('STOP');
  for (const stub of lowerInternals(ctx).dfailStubs) {
    emitDecodeFailStub(w, stub.label, stub.site, tails);
  }
  emitSharedTails(w, tails, { evmVersion });
  for (const seg of segments) {
    w.dataLabel(seg.label);
    w.data(seg.bytes);
  }
  const { bytecode, sourceMap } = assemble(w.nodes(), { evmVersion });
  const dis = disassemble(bytesToHex(bytecode), sourceMap);
  const stopAt = dis.lines.findIndex((l) => l.mnemonic === 'STOP');
  return dis
    .format()
    .split('\n')
    .slice(0, stopAt + 1)
    .join('\n');
}

let fragSite = 100;
function st(body: StmtBody, site?: number): Stmt {
  return { loc: null, site: site ?? fragSite++, ...body };
}

// ---------------------------------------------------------------------------
// worked-example goldens (architecture §15)
// ---------------------------------------------------------------------------

describe('worked-example goldens (architecture §15)', () => {
  test('§15.1 checked ADD (uint256): a→0x80, b→0xA0, c→0xC0', () => {
    const listing = fragmentListing({
      values: ['uint256', 'uint256', 'uint256'],
      slots: new Map([
        [0, 0x80],
        [1, 0xa0],
        [2, 0xc0],
      ]),
      body: [st({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 }, 1)],
    });
    expect(listing).toMatchInlineSnapshot(`
      "0x0000  60a0        PUSH1 0xa0  ; checked add uint256
      0x0002  51          MLOAD
      0x0003  6080        PUSH1 0x80
      0x0005  51          MLOAD
      0x0006  81          DUP2
      0x0007  01          ADD
      0x0008  80          DUP1
      0x0009  91          SWAP2
      0x000a  11          GT
      0x000b  610013      PUSH2 0x0013 → @panic_overflow
      0x000e  57          JUMPI
      0x000f  60c0        PUSH1 0xc0
      0x0011  52          MSTORE
      0x0012  00          STOP"
    `);
  });

  test('§15.2 STATICCALL symbol() → dynamic string: token0→0x80, symbol0→0xA0, site 7', () => {
    const listing = fragmentListing({
      values: ['address', 'string'],
      slots: new Map([
        [0, 0x80],
        [1, 0xa0],
      ]),
      body: [
        st(
          {
            k: 'call',
            target: 0,
            fnAbi: fnAbi('symbol', [], ['string']),
            args: [],
            outs: [1],
            mode: 'strict',
          },
          7,
        ),
      ],
      pre: (w) => {
        // prologue + token0 preload (the §15.2 listing assumes both)
        w.push(0xc0, { note: 'frameEnd' });
        w.push(0x40);
        w.op('MSTORE');
        w.push(BigInt(TARGET));
        w.push(0x80);
        w.op('MSTORE', { note: 'token0' });
      },
    });
    expect(listing).toMatchInlineSnapshot(`
      "0x0000  60c0        PUSH1 0xc0  ; frameEnd
      0x0002  6040        PUSH1 0x40
      0x0004  52          MSTORE
      0x0005  60aa        PUSH1 0xaa
      0x0007  6080        PUSH1 0x80
      0x0009  52          MSTORE  ; token0
      0x000a  6395d89b41  PUSH4 0x95d89b41  ; const calldata
      0x000f  60e0        PUSH1 0xe0
      0x0011  1b          SHL
      0x0012  6040        PUSH1 0x40
      0x0014  51          MLOAD
      0x0015  52          MSTORE
      0x0016  6040        PUSH1 0x40
      0x0018  51          MLOAD
      0x0019  5f          PUSH0
      0x001a  5f          PUSH0
      0x001b  6004        PUSH1 0x04
      0x001d  83          DUP4
      0x001e  6080        PUSH1 0x80
      0x0020  51          MLOAD  ; target
      0x0021  5a          GAS
      0x0022  fa          STATICCALL  ; strict call symbol (site 7)
      0x0023  61002e      PUSH2 0x002e → @call_ok_7
      0x0026  57          JUMPI
      0x0027  3d          RETURNDATASIZE
      0x0028  5f          PUSH0
      0x0029  5f          PUSH0
      0x002a  3e          RETURNDATACOPY
      0x002b  3d          RETURNDATASIZE
      0x002c  5f          PUSH0
      0x002d  fd          REVERT  ; bubble callee revert
      @call_ok_7:
      0x002e  5b          JUMPDEST  ; @call_ok_7
      0x002f  3d          RETURNDATASIZE
      0x0030  6020        PUSH1 0x20  ; staticMinSize 32
      0x0032  11          GT
      0x0033  610088      PUSH2 0x0088 → @dfail_7
      0x0036  57          JUMPI
      0x0037  3d          RETURNDATASIZE
      0x0038  5f          PUSH0
      0x0039  82          DUP3
      0x003a  3e          RETURNDATACOPY
      0x003b  3d          RETURNDATASIZE
      0x003c  601f        PUSH1 0x1f
      0x003e  01          ADD
      0x003f  601f        PUSH1 0x1f
      0x0041  19          NOT
      0x0042  16          AND
      0x0043  81          DUP2
      0x0044  01          ADD
      0x0045  6040        PUSH1 0x40
      0x0047  52          MSTORE
      0x0048  80          DUP1
      0x0049  51          MLOAD
      0x004a  67ffffffffffffffff  PUSH8 0xffffffffffffffff
      0x0053  81          DUP2
      0x0054  11          GT
      0x0055  610088      PUSH2 0x0088 → @dfail_7
      0x0058  57          JUMPI
      0x0059  80          DUP1
      0x005a  6020        PUSH1 0x20
      0x005c  01          ADD
      0x005d  3d          RETURNDATASIZE
      0x005e  10          LT
      0x005f  610088      PUSH2 0x0088 → @dfail_7
      0x0062  57          JUMPI
      0x0063  81          DUP2
      0x0064  01          ADD
      0x0065  80          DUP1
      0x0066  51          MLOAD
      0x0067  67ffffffffffffffff  PUSH8 0xffffffffffffffff
      0x0070  81          DUP2
      0x0071  11          GT
      0x0072  610088      PUSH2 0x0088 → @dfail_7
      0x0075  57          JUMPI
      0x0076  81          DUP2
      0x0077  6020        PUSH1 0x20
      0x0079  01          ADD
      0x007a  01          ADD
      0x007b  3d          RETURNDATASIZE
      0x007c  83          DUP4
      0x007d  01          ADD
      0x007e  10          LT
      0x007f  610088      PUSH2 0x0088 → @dfail_7
      0x0082  57          JUMPI
      0x0083  60a0        PUSH1 0xa0
      0x0085  52          MSTORE  ; out #0 string (memref aliases snapshot)
      0x0086  50          POP"
    `);
  });

  test('§15.3 while loop with cells: n→0x80, total→0xA0, i→0xC0, v1…v7→0xE0…0x1A0', () => {
    // value table: 0=n, 1..7=v1..v7, 8=const 0 (folded), 9=const 1 (folded)
    const slots = new Map<ValueId, number | null>([
      [0, 0x80],
      [1, 0xe0],
      [2, 0x100],
      [3, 0x120],
      [4, 0x140],
      [5, 0x160],
      [6, 0x180],
      [7, 0x1a0],
      [8, null],
      [9, null],
    ]);
    const listing = fragmentListing({
      values: [
        'uint256', // n
        'uint256', // v1 = i
        'bool', // v2 = v1 < n
        'uint256', // v3 = total
        'uint256', // v4 = i
        'uint256', // v5 = v3 + v4
        'uint256', // v6 = i
        'uint256', // v7 = v6 + 1
        'uint256', // const 0
        'uint256', // const 1
      ],
      slots,
      cellTypes: ['uint256', 'uint256'],
      cellSlots: [0xa0, 0xc0],
      body: [
        st({ k: 'const', out: 8, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint256' }),
        st({ k: 'cellnew', cell: 0, init: 8 }),
        st({ k: 'cellnew', cell: 1, init: 8 }),
        st(
          {
            k: 'while',
            header: [
              st({ k: 'cellget', cell: 1, out: 1 }),
              st({ k: 'bin', op: 'lt', a: 1, b: 0, out: 2 }),
            ],
            cond: 2,
            body: [
              st({ k: 'cellget', cell: 0, out: 3 }),
              st({ k: 'cellget', cell: 1, out: 4 }),
              st({ k: 'bin', op: 'add', a: 3, b: 4, out: 5 }),
              st({ k: 'cellset', cell: 0, value: 5 }),
              st({ k: 'cellget', cell: 1, out: 6 }),
              st({
                k: 'const',
                out: 9,
                data: { kind: 'word', hex: wordHex(1n) },
                type: 'uint256',
              }),
              st({ k: 'bin', op: 'add', a: 6, b: 9, out: 7 }),
              st({ k: 'cellset', cell: 1, value: 7 }),
            ],
          },
          1,
        ),
      ],
    });
    expect(listing).toMatchInlineSnapshot(`
      "0x0000  5f          PUSH0  ; cell 0 ←
      0x0001  60a0        PUSH1 0xa0
      0x0003  52          MSTORE
      0x0004  5f          PUSH0  ; cell 1 ←
      0x0005  60c0        PUSH1 0xc0
      0x0007  52          MSTORE
      @while_1:
      0x0008  5b          JUMPDEST  ; @while_1
      0x0009  60c0        PUSH1 0xc0  ; cell 1 →
      0x000b  51          MLOAD
      0x000c  60e0        PUSH1 0xe0
      0x000e  52          MSTORE
      0x000f  6080        PUSH1 0x80  ; lt uint256
      0x0011  51          MLOAD
      0x0012  60e0        PUSH1 0xe0
      0x0014  51          MLOAD
      0x0015  10          LT
      0x0016  610100      PUSH2 0x0100
      0x0019  52          MSTORE
      0x001a  610100      PUSH2 0x0100  ; while cond
      0x001d  51          MLOAD
      0x001e  15          ISZERO
      0x001f  610072      PUSH2 0x0072 → @endwhile_1
      0x0022  57          JUMPI
      0x0023  60a0        PUSH1 0xa0  ; cell 0 →
      0x0025  51          MLOAD
      0x0026  610120      PUSH2 0x0120
      0x0029  52          MSTORE
      0x002a  60c0        PUSH1 0xc0  ; cell 1 →
      0x002c  51          MLOAD
      0x002d  610140      PUSH2 0x0140
      0x0030  52          MSTORE
      0x0031  610140      PUSH2 0x0140  ; checked add uint256
      0x0034  51          MLOAD
      0x0035  610120      PUSH2 0x0120
      0x0038  51          MLOAD
      0x0039  81          DUP2
      0x003a  01          ADD
      0x003b  80          DUP1
      0x003c  91          SWAP2
      0x003d  11          GT
      0x003e  610074      PUSH2 0x0074 → @panic_overflow
      0x0041  57          JUMPI
      0x0042  610160      PUSH2 0x0160
      0x0045  52          MSTORE
      0x0046  610160      PUSH2 0x0160  ; cell 0 ←
      0x0049  51          MLOAD
      0x004a  60a0        PUSH1 0xa0
      0x004c  52          MSTORE
      0x004d  60c0        PUSH1 0xc0  ; cell 1 →
      0x004f  51          MLOAD
      0x0050  610180      PUSH2 0x0180
      0x0053  52          MSTORE
      0x0054  6001        PUSH1 0x01  ; checked add uint256
      0x0056  610180      PUSH2 0x0180
      0x0059  51          MLOAD
      0x005a  81          DUP2
      0x005b  01          ADD
      0x005c  80          DUP1
      0x005d  91          SWAP2
      0x005e  11          GT
      0x005f  610074      PUSH2 0x0074 → @panic_overflow
      0x0062  57          JUMPI
      0x0063  6101a0      PUSH2 0x01a0
      0x0066  52          MSTORE
      0x0067  6101a0      PUSH2 0x01a0  ; cell 1 ←
      0x006a  51          MLOAD
      0x006b  60c0        PUSH1 0xc0
      0x006d  52          MSTORE
      0x006e  610008      PUSH2 0x0008 → @while_1
      0x0071  56          JUMP
      @endwhile_1:"
    `);
  });
});

// ---------------------------------------------------------------------------
// dispatcher (architecture §11)
// ---------------------------------------------------------------------------

function echoIr(): ScriptIr {
  const b = new IrB('echo', [['x', 'uint256']]);
  b.ret('x', 0);
  return b.build();
}

describe('dispatcher', () => {
  test('golden: full annotated listing of echo(uint256)', () => {
    const { runtime, sourceMap } = compileIr(echoIr());
    expect(disassemble(runtime, sourceMap).format()).toMatchInlineSnapshot(`
      "0x0000  60a0        PUSH1 0xa0  ; frameEnd
      0x0002  6040        PUSH1 0x40
      0x0004  52          MSTORE  ; free-ptr init
      0x0005  6004        PUSH1 0x04
      0x0007  36          CALLDATASIZE
      0x0008  10          LT
      0x0009  610088      PUSH2 0x0088 → @badcd
      0x000c  57          JUMPI
      0x000d  5f          PUSH0
      0x000e  35          CALLDATALOAD
      0x000f  60e0        PUSH1 0xe0
      0x0011  1c          SHR
      0x0012  636279e43c  PUSH4 0x6279e43c  ; selector echo(uint256)
      0x0017  14          EQ
      0x0018  610020      PUSH2 0x0020 → @main
      0x001b  57          JUMPI
      0x001c  610088      PUSH2 0x0088 → @badcd
      0x001f  56          JUMP
      @main:
      0x0020  5b          JUMPDEST  ; @main
      0x0021  6024        PUSH1 0x24  ; calldata floor 36
      0x0023  36          CALLDATASIZE
      0x0024  10          LT
      0x0025  610088      PUSH2 0x0088 → @badcd
      0x0028  57          JUMPI
      0x0029  6004        PUSH1 0x04  ; arg #0 head
      0x002b  35          CALLDATALOAD
      0x002c  6080        PUSH1 0x80
      0x002e  52          MSTORE
      0x002f  6040        PUSH1 0x40
      0x0031  51          MLOAD  ; return buffer
      0x0032  6020        PUSH1 0x20 → @main
      0x0034  01          ADD
      0x0035  5f          PUSH0
      0x0036  52          MSTORE
      0x0037  6080        PUSH1 0x80
      0x0039  51          MLOAD  ; head x
      0x003a  6040        PUSH1 0x40
      0x003c  51          MLOAD
      0x003d  52          MSTORE
      0x003e  5f          PUSH0
      0x003f  51          MLOAD
      0x0040  6040        PUSH1 0x40
      0x0042  51          MLOAD
      0x0043  80          DUP1
      0x0044  91          SWAP2
      0x0045  03          SUB
      0x0046  90          SWAP1
      0x0047  f3          RETURN  ; return tuple
      @panic_overflow:
      0x0048  5b          JUMPDEST  ; @panic_overflow
      0x0049  6011        PUSH1 0x11  ; panic code 0x11
      0x004b  610064      PUSH2 0x0064 → @panic
      0x004e  56          JUMP
      @panic_divzero:
      0x004f  5b          JUMPDEST  ; @panic_divzero
      0x0050  6012        PUSH1 0x12  ; panic code 0x12
      0x0052  610064      PUSH2 0x0064 → @panic
      0x0055  56          JUMP
      @panic_bounds:
      0x0056  5b          JUMPDEST  ; @panic_bounds
      0x0057  6032        PUSH1 0x32  ; panic code 0x32
      0x0059  610064      PUSH2 0x0064 → @panic
      0x005c  56          JUMP
      @panic_alloc:
      0x005d  5b          JUMPDEST  ; @panic_alloc
      0x005e  6041        PUSH1 0x41  ; panic code 0x41
      0x0060  610064      PUSH2 0x0064 → @panic
      0x0063  56          JUMP
      @panic:
      0x0064  5b          JUMPDEST  ; @panic
      0x0065  634e487b71  PUSH4 0x4e487b71  ; selector 0x4e487b71
      0x006a  60e0        PUSH1 0xe0
      0x006c  1b          SHL
      0x006d  5f          PUSH0
      0x006e  52          MSTORE
      0x006f  6004        PUSH1 0x04
      0x0071  52          MSTORE
      0x0072  6024        PUSH1 0x24
      0x0074  5f          PUSH0
      0x0075  fd          REVERT  ; Panic(code)
      @decode_revert:
      0x0076  5b          JUMPDEST  ; @decode_revert
      0x0077  6320cf27b7  PUSH4 0x20cf27b7  ; selector 0x20cf27b7
      0x007c  60e0        PUSH1 0xe0
      0x007e  1b          SHL
      0x007f  5f          PUSH0
      0x0080  52          MSTORE
      0x0081  6004        PUSH1 0x04
      0x0083  52          MSTORE
      0x0084  6024        PUSH1 0x24
      0x0086  5f          PUSH0
      0x0087  fd          REVERT  ; EvsDecodeError(site)
      @badcd:
      0x0088  5b          JUMPDEST  ; @badcd
      0x0089  63f43fed56  PUSH4 0xf43fed56  ; selector 0xf43fed56
      0x008e  60e0        PUSH1 0xe0
      0x0090  1b          SHL
      0x0091  5f          PUSH0
      0x0092  52          MSTORE
      0x0093  6004        PUSH1 0x04
      0x0095  5f          PUSH0
      0x0096  fd          REVERT  ; EvsInvalidCalldata()"
    `);
  });

  test('round-trips its argument', async () => {
    const res = await run(echoIr(), [123n]);
    expect(res.success).toBe(true);
    expect(res.data).toBe(tupleHex([{ name: 'x', type: 'uint256' }], { x: 123n }));
  });

  test('calldata shorter than 4 bytes → EvsInvalidCalldata()', async () => {
    const { runtime } = compileIr(echoIr());
    const res = await execRuntime(runtime, '0x95d8');
    expect(res.success).toBe(false);
    expect(res.data).toBe(INVALID_CALLDATA);
  });

  test('wrong selector → EvsInvalidCalldata()', async () => {
    const { runtime } = compileIr(echoIr());
    const res = await execRuntime(runtime, concatHex('0xdeadbeef', word(1n)));
    expect(res.success).toBe(false);
    expect(res.data).toBe(INVALID_CALLDATA);
  });

  test('truncated args (selector + 31 bytes) → EvsInvalidCalldata()', async () => {
    const ir = echoIr();
    const { runtime } = compileIr(ir);
    const good = calldataFor(ir, [5n]);
    const res = await execRuntime(runtime, `0x${good.slice(2, good.length - 2)}`);
    expect(res.success).toBe(false);
    expect(res.data).toBe(INVALID_CALLDATA);
  });
});

// ---------------------------------------------------------------------------
// dynamic script args (architecture §8.1)
// ---------------------------------------------------------------------------

describe('dynamic script args', () => {
  function dynIr(): ScriptIr {
    const b = new IrB('dyn', [
      ['s', 'string'],
      ['xs', 'uint8[]'],
      ['bs', 'bytes'],
      ['w', 'uint256'],
    ]);
    b.ret('s', 0);
    b.ret('xs', 1);
    b.ret('bs', 2);
    b.ret('w', 3);
    return b.build();
  }

  test('string / T[] / bytes args round-trip byte-exactly', async () => {
    const ir = dynIr();
    const args = ['hello evs', [1n, 2n, 255n], '0xdeadbeefc0ffee', 42n] as const;
    const res = await run(ir, args);
    expect(res.success).toBe(true);
    expect(res.data).toBe(
      tupleHex(
        [
          { name: 's', type: 'string' },
          { name: 'xs', type: 'uint8[]' },
          { name: 'bs', type: 'bytes' },
          { name: 'w', type: 'uint256' },
        ],
        { s: args[0], xs: args[1], bs: args[2], w: args[3] },
      ),
    );
  });

  test('attacker-shaped calldata → EvsInvalidCalldata (huge offset / huge length / truncated tail)', async () => {
    const b = new IrB('one', [['s', 'string']]);
    b.ret('s', 0);
    const ir = b.build();
    const { runtime } = compileIr(ir);
    const selector = selectorOf('one', ['string']);
    const cases: readonly Hex[] = [
      concatHex(selector, word(1n << 200n)), // head offset astronomically far
      concatHex(selector, word(32n), word(1n << 200n)), // absurd length word
      concatHex(selector, word(32n), word(64n), word(0n)), // tail extends past calldatasize
    ];
    await Promise.all(
      cases.map(async (calldata) => {
        const res = await execRuntime(runtime, calldata);
        expect({ calldata, success: res.success, data: res.data }).toEqual({
          calldata,
          success: false,
          data: INVALID_CALLDATA,
        });
        expect(res.gasUsed).toBeLessThan(100_000n); // structured revert, not a halt
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// call statements end-to-end through lowerProgram
// ---------------------------------------------------------------------------

describe('calls through lowerProgram', () => {
  function symbolIr(): { ir: ScriptIr; site: number } {
    const b = new IrB('symbolOf', [['token', 'address']]);
    const { outs, site } = b.call({ target: 0, abi: fnAbi('symbol', [], ['string']) });
    b.ret('symbol', outs[0] ?? 0);
    return { ir: b.build(), site };
  }

  test('strict call: success path decodes the string in place', async () => {
    const { ir } = symbolIr();
    const fixture: EvmFixture = { contracts: { [TARGET]: returner(encodedString('WETH')) } };
    const res = await run(ir, [TARGET], fixture);
    expect(res.success).toBe(true);
    expect(res.data).toBe(tupleHex([{ name: 'symbol', type: 'string' }], { symbol: 'WETH' }));
  });

  test('strict call: callee revert bubbles verbatim', async () => {
    const { ir } = symbolIr();
    const fixture: EvmFixture = { contracts: { [TARGET]: reverter('0xdeadbeef') } };
    const res = await run(ir, [TARGET], fixture);
    expect(res.success).toBe(false);
    expect(res.data).toBe('0xdeadbeef');
  });

  test('strict call: attacker returndata → EvsDecodeError(site), never an all-gas halt', async () => {
    const { ir, site } = symbolIr();
    const expected = concatHex(DECODE_ERROR_SELECTOR, word(BigInt(site)));
    const cases = Object.entries(ATTACKER_RETURNERS).filter(
      ([name]) => name !== 'dirtyHighBits' && name !== 'shortWord', // word-decode fixtures
    );
    await Promise.all(
      cases.map(async ([name, runtime]) => {
        const res = await run(ir, [TARGET], { contracts: { [TARGET]: runtime } });
        expect({ name, success: res.success, data: res.data }).toEqual({
          name,
          success: false,
          data: expected,
        });
        expect(res.gasUsed).toBeLessThan(100_000n);
      }),
    );
  });

  test('word outputs normalize dirty high bits instead of reverting', async () => {
    const b = new IrB('dec', [['token', 'address']]);
    const { outs } = b.call({ target: 0, abi: fnAbi('decimals', [], ['uint8']) });
    b.ret('d', outs[0] ?? 0);
    const ir = b.build();
    const fixture: EvmFixture = {
      contracts: { [TARGET]: ATTACKER_RETURNERS.dirtyHighBits },
    };
    const res = await run(ir, [TARGET], fixture);
    expect(res.success).toBe(true);
    expect(res.data).toBe(tupleHex([{ name: 'd', type: 'uint8' }], { d: 255n }));
  });

  test('tryCall: failure zeroes the outputs (word → 0, memref → empty)', async () => {
    const b = new IrB('try2', [['token', 'address']]);
    const dec = b.call({ target: 0, abi: fnAbi('decimals', [], ['uint8']), mode: 'try' });
    const sym = b.call({ target: 0, abi: fnAbi('symbol', [], ['string']), mode: 'try' });
    b.ret('ok1', dec.success ?? 0);
    b.ret('d', dec.outs[0] ?? 0);
    b.ret('ok2', sym.success ?? 0);
    b.ret('s', sym.outs[0] ?? 0);
    const ir = b.build();
    const components = [
      { name: 'ok1', type: 'bool' },
      { name: 'd', type: 'uint8' },
      { name: 'ok2', type: 'bool' },
      { name: 's', type: 'string' },
    ];
    // no code at TARGET + empty returndata where a value was promised → both zeroed
    const empty = await run(ir, [TARGET], { contracts: { [TARGET]: ATTACKER_RETURNERS.empty } });
    expect(empty.success).toBe(true);
    expect(empty.data).toBe(tupleHex(components, { ok1: false, d: 0n, ok2: false, s: '' }));
    // working callee → both succeed
    const good = await run(ir, [TARGET], {
      contracts: { [TARGET]: returner(word(18n)) },
    });
    // decimals() sees 18; symbol() decodes word(18) as a head offset of 18 → structural fail
    expect(good.success).toBe(true);
    expect(good.data).toBe(tupleHex(components, { ok1: true, d: 18n, ok2: false, s: '' }));
  });

  test('gas cap operand is honored (literal cap, call still succeeds)', async () => {
    const b = new IrB('cap', [['token', 'address']]);
    const gas = b.word('uint256', 200_000n);
    const { outs } = b.call({ target: 0, abi: fnAbi('decimals', [], ['uint8']), gas });
    b.ret('d', outs[0] ?? 0);
    const res = await run(b.build(), [TARGET], { contracts: { [TARGET]: returner(word(6n)) } });
    expect(res.success).toBe(true);
    expect(res.data).toBe(tupleHex([{ name: 'd', type: 'uint8' }], { d: 6n }));
  });
});

// ---------------------------------------------------------------------------
// data segments
// ---------------------------------------------------------------------------

describe('data segments', () => {
  test('dynamic literals materialize via CODECOPY; identical blobs deduplicate', async () => {
    const hello = concatHex(word(5n), `0x${'68656c6c6f'.padEnd(64, '0')}`);
    const b = new IrB('lits');
    const s1 = b.data('string', hello);
    const s2 = b.data('string', hello); // identical content — one data segment
    const fees = b.data(
      'uint24[]',
      concatHex(word(4n), word(100n), word(500n), word(3000n), word(10000n)),
    );
    b.ret('a', s1);
    b.ret('b', s2);
    b.ret('fees', fees);
    const ir = b.build();
    const { runtime, lowered } = compileIr(ir);
    const dataLabels = [...lowered.labelNames.values()].filter((n) => n.startsWith('data_'));
    expect(dataLabels).toEqual(['data_0', 'data_1']); // deduped: 2 blobs for 3 literals
    const res = await execRuntime(runtime, calldataFor(ir, []));
    expect(res.success).toBe(true);
    expect(res.data).toBe(
      tupleHex(
        [
          { name: 'a', type: 'string' },
          { name: 'b', type: 'string' },
          { name: 'fees', type: 'uint24[]' },
        ],
        { a: 'hello', b: 'hello', fees: [100n, 500n, 3000n, 10000n] },
      ),
    );
  });

  test('data nodes are last in the node stream (assemble plants the INVALID guard)', () => {
    const b = new IrB('lit');
    b.ret('s', b.data('string', concatHex(word(2n), `0x${'6869'.padEnd(64, '0')}`)));
    const { nodes } = lowerProgram(b.build(), { evmVersion: 'cancun', locations: true });
    const firstData = nodes.findIndex((n) => n.k === 'data' || n.k === 'dataLabel');
    expect(firstData).toBeGreaterThan(0);
    for (const node of nodes.slice(firstData)) {
      expect(['data', 'dataLabel']).toContain(node.k);
    }
  });
});

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

describe('diagnostics', () => {
  test('LOOP_ALLOCATION: call-with-outputs, arrnew, dynamic literal inside a while', () => {
    const b = new IrB('loopy', [['n', 'uint256']]);
    const zero = b.word('uint256', 0n);
    const i = b.cell('uint256', zero);
    const target = b.word('address', BigInt(TARGET));
    b.while(
      () => b.bin('lt', b.cellGet(i), 0),
      () => {
        b.call({ target, abi: fnAbi('decimals', [], ['uint8']) }); // outputs → flagged
        b.arrnew('uint256', b.cellGet(i)); // flagged
        b.data('string', concatHex(word(2n), `0x${'6869'.padEnd(64, '0')}`)); // flagged
        b.call({ target, abi: fnAbi('poke', [], []) }); // NO outputs → not flagged
        b.cellSet(i, b.bin('add', b.cellGet(i), b.word('uint256', 1n)));
      },
    );
    b.ret('n', 0);
    const { diagnostics } = lowerProgram(b.build(), { evmVersion: 'cancun', locations: true });
    const loopAllocs = diagnostics.filter((d) => d.code === 'LOOP_ALLOCATION');
    expect(loopAllocs).toHaveLength(3);
    for (const d of loopAllocs) expect(d.severity).toBe('warning');
  });

  test('no LOOP_ALLOCATION outside loops', () => {
    const b = new IrB('flat', [['n', 'uint256']]);
    b.arrnew('uint256', 0);
    b.ret('n', 0);
    const { diagnostics } = lowerProgram(b.build(), { evmVersion: 'cancun', locations: true });
    expect(diagnostics.filter((d) => d.code === 'LOOP_ALLOCATION')).toHaveLength(0);
  });

  test('LARGE_FRAME fires past the slot budget', () => {
    const b = new IrB('huge', [['n', 'uint256']]);
    const c = b.cell('uint256', 0);
    for (let i = 0; i < 1100; i++) b.cellGet(c);
    b.ret('n', 0);
    const { diagnostics, frameEnd } = lowerProgram(b.build(), {
      evmVersion: 'cancun',
      locations: true,
    });
    expect(frameEnd).toBeGreaterThan(0x8000);
    expect(diagnostics.some((d) => d.code === 'LARGE_FRAME')).toBe(true);
  });

  test('LOOP_ALLOCATION: a fncall in a loop whose callee (transitively) allocates is flagged', () => {
    const b = new IrB('fnloop', [['n', 'uint256']]);
    // leaf fn allocates (arrnew); middle fn only calls leaf — both transitively allocate
    const leaf = b.fn('leaf', ['uint256'], (p) => {
      const arr = b.arrnew('uint256', p ?? 0);
      return [b.bin('add', b.index(arr, b.word('uint256', 0n)), p ?? 0)];
    });
    const mid = b.fn('mid', ['uint256'], (p) => [...b.fncall(leaf, [p ?? 0])]);
    // a pure fn must NOT be flagged
    const pure = b.fn('pure', ['uint256'], (p) => [b.bin('add', p ?? 0, b.word('uint256', 1n))]);
    const zero = b.word('uint256', 0n);
    const i = b.cell('uint256', zero);
    b.while(
      () => b.bin('lt', b.cellGet(i), 0),
      () => {
        b.fncall(mid, [b.cellGet(i)]); // flagged: callee transitively allocates
        b.fncall(pure, [b.cellGet(i)]); // NOT flagged
        b.cellSet(i, b.bin('add', b.cellGet(i), b.word('uint256', 1n)));
      },
    );
    b.ret('n', 0);
    const { diagnostics } = lowerProgram(b.build(), { evmVersion: 'cancun', locations: true });
    const loopAllocs = diagnostics.filter((d) => d.code === 'LOOP_ALLOCATION');
    expect(loopAllocs.some((d) => d.message.includes('fn "mid"'))).toBe(true);
    expect(loopAllocs.some((d) => d.message.includes('fn "pure"'))).toBe(false);
  });

  test('fncall to an allocating fn outside any loop is not flagged', () => {
    const b = new IrB('fnflat', [['n', 'uint256']]);
    const leaf = b.fn('leaf', ['uint256'], (p) => {
      b.arrnew('uint256', p ?? 0);
      return [p ?? 0];
    });
    b.fncall(leaf, [0]);
    b.ret('n', 0);
    const { diagnostics } = lowerProgram(b.build(), { evmVersion: 'cancun', locations: true });
    expect(diagnostics.filter((d) => d.code === 'LOOP_ALLOCATION')).toHaveLength(0);
  });

  test('ENV_FRAME_DEPENDENT: env caller/address are flagged; block-context env ops are not', () => {
    const b = new IrB('envy', [['n', 'uint256']]);
    const caller = b.env('caller');
    const self = b.env('address');
    b.env('timestamp');
    b.env('blocknumber');
    b.env('chainid');
    void caller;
    void self;
    b.ret('n', 0);
    const { diagnostics } = lowerProgram(b.build(), { evmVersion: 'cancun', locations: true });
    const envDiags = diagnostics.filter((d) => d.code === 'ENV_FRAME_DEPENDENT');
    expect(envDiags).toHaveLength(2);
    expect(envDiags.some((d) => d.message.includes("s.env('caller')"))).toBe(true);
    expect(envDiags.some((d) => d.message.includes("s.env('address')"))).toBe(true);
    expect(envDiags.every((d) => d.severity === 'warning')).toBe(true);
    expect(envDiags.every((d) => d.message.includes('deployless'))).toBe(true);

    const blockCtx = new IrB('blocky', [['n', 'uint256']]);
    blockCtx.env('timestamp');
    blockCtx.env('chainid');
    blockCtx.ret('n', 0);
    const blockDiags = lowerProgram(blockCtx.build(), {
      evmVersion: 'cancun',
      locations: true,
    }).diagnostics;
    expect(blockDiags.filter((d) => d.code === 'ENV_FRAME_DEPENDENT')).toHaveLength(0);
  });

  test('ENV_FRAME_DEPENDENT: flagged inside emitted fn bodies, not in dropped fns', () => {
    const b = new IrB('envfn', [['n', 'uint256']]);
    const called = b.fn('whoami', ['uint256'], () => [b.env('caller')]);
    const dropped = b.fn('ghost', ['uint256'], () => [b.env('address')]);
    void dropped;
    b.fncall(called, [0]);
    b.ret('n', 0);
    const { diagnostics } = lowerProgram(b.build(), { evmVersion: 'cancun', locations: true });
    const envDiags = diagnostics.filter((d) => d.code === 'ENV_FRAME_DEPENDENT');
    expect(envDiags).toHaveLength(1);
    expect(envDiags[0]?.message).toContain("s.env('caller')");
  });
});

// ---------------------------------------------------------------------------
// sites, labelNames, locations, determinism, coverage, uncalled fns
// ---------------------------------------------------------------------------

describe('LowerResult metadata', () => {
  const LOC: SourceLoc = { file: 'pools.ts', line: 9, column: 18 };

  function richIr(): { ir: ScriptIr; callSite: number; trySite: number } {
    const b = new IrB('rich', [
      ['token', 'address'],
      ['xs', 'uint256[]'],
    ]);
    b.loc = LOC;
    const strict = b.call({ target: 0, abi: fnAbi('symbol', [], ['string']) });
    const tryC = b.call({ target: 0, abi: fnAbi('decimals', [], ['uint8']), mode: 'try' });
    const one = b.word('uint256', 1n);
    const sum = b.bin('add', b.index(1, one), one);
    // fn bodies are isolated — the literal must be recorded inside the fn block
    const inc = b.fn('inc', ['uint256'], (p) => [b.bin('add', p ?? 0, b.word('uint256', 1n))]);
    const ghost = b.fn('ghost', ['uint256'], (p) => [p ?? 0]);
    void ghost;
    const out = b.fncall(inc, [sum]);
    b.ret('symbol', strict.outs[0] ?? 0);
    b.ret('ok', tryC.success ?? 0);
    b.ret('r', out[0] ?? 0);
    return { ir: b.build(), callSite: strict.site, trySite: tryC.site };
  }

  test('sites: strict call → decode, try call → call, checked ops → panic', () => {
    const { ir, callSite, trySite } = richIr();
    const { sites } = lowerProgram(ir, { evmVersion: 'cancun', locations: true });
    const byId = new Map(sites.map((s) => [s.id, s]));
    expect(byId.get(callSite)?.kind).toBe('decode');
    expect(byId.get(callSite)?.detail).toContain('symbol');
    expect(byId.get(callSite)?.loc).toEqual(LOC);
    expect(byId.get(trySite)?.kind).toBe('call');
    expect(sites.some((s) => s.kind === 'panic' && s.detail.includes('add'))).toBe(true);
    expect(sites.some((s) => s.kind === 'panic' && s.detail.includes('0x32'))).toBe(true);
    const ids = sites.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('labelNames: main, tails, fn entries; uncalled fns are dropped', () => {
    const { ir } = richIr();
    const { labelNames } = lowerProgram(ir, { evmVersion: 'cancun', locations: true });
    const names = [...labelNames.values()];
    expect(names).toContain('main');
    expect(names).toContain('panic_overflow');
    expect(names).toContain('badcd');
    expect(names).toContain('decode_revert');
    expect(names).toContain('fn_inc');
    expect(names).not.toContain('fn_ghost');
    expect(names.some((n) => n.startsWith('dfail_'))).toBe(true);
  });

  test('locations: false strips locs from nodes, sites and diagnostics', () => {
    const { ir } = richIr();
    const { nodes, sites } = lowerProgram(ir, { evmVersion: 'cancun', locations: false });
    const nodesWithLoc = nodes.filter((n) => 'loc' in n && n.loc !== undefined && n.loc !== null);
    expect(nodesWithLoc).toEqual([]);
    const sitesWithLoc = sites.filter((s) => s.loc !== null);
    expect(sitesWithLoc).toEqual([]);
  });

  test('locations: true forwards stmt locs into nodes', () => {
    const { ir } = richIr();
    const { nodes } = lowerProgram(ir, { evmVersion: 'cancun', locations: true });
    expect(nodes.some((n) => 'loc' in n && n.loc !== undefined && n.loc !== null)).toBe(true);
  });

  test('lowering is deterministic (identical bytecode twice)', () => {
    const { ir } = richIr();
    const a = compileIr(ir).runtime;
    const b = compileIr(ir).runtime;
    expect(a).toBe(b);
  });

  test('sourceMap segments cover every byte', () => {
    const { ir } = richIr();
    const { runtime, sourceMap } = compileIr(ir);
    const total = sourceMap.segments.reduce((acc, s) => acc + s.len, 0);
    expect(total).toBe((runtime.length - 2) / 2);
    // sorted + non-overlapping: each segment starts where the previous one ended
    let pc = 0;
    const gaps = sourceMap.segments.filter((seg) => {
      const misplaced = seg.pc !== pc;
      pc = seg.pc + seg.len;
      return misplaced;
    });
    expect(gaps).toEqual([]);
  });

  test('frameEnd in the result matches the prologue immediate', () => {
    const ir = echoIr();
    const { frameEnd, nodes } = lowerProgram(ir, { evmVersion: 'cancun', locations: true });
    expect(nodes[0]).toMatchObject({ k: 'push', value: BigInt(frameEnd) });
  });
});
