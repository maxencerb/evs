/* oxlint-disable unicorn/no-thenable --
 * the frozen IR schema (module-interfaces.md §M2) names the if-statement branch field `then`. */
/* oxlint-disable vitest/expect-expect --
 * several revert-path tests assert exclusively through the expectPanic() helper, which wraps
 * the expect(...).toEqual(...) pair on the outcome. */
/**
 * M6 unit tests — golden runs over hand-built IRs covering every stmt kind; revert paths
 * (Panic codes per width class incl. `int256 −2^255 / −1` and the uint192 MUL wrap-back);
 * decode-fail site ids; tryCall zeroing; maxSteps guard; byte-exact ABI agreement with viem.
 */
import { encodeAbiParameters, encodeFunctionData, toFunctionSelector } from 'viem';
import { describe, expect, test } from 'vitest';

import { EvsCompileError, EvsTypeError, type SourceLoc } from '../core/errors.js';
import type { EvsType, Hex, NumericType, WordType } from '../core/types.js';
import { interpret, type InterpResult, type MockChain } from './interp.js';
import type { BinOp, PlainAbiFunction, ScriptIr, Stmt, UnOp, ValueInfo } from './nodes.js';

// ---------------------------------------------------------------------------
// fixture builders (style shared with validate.test.ts)
// ---------------------------------------------------------------------------

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const LOC: SourceLoc = { file: '/home/dev/app/pools.ts', line: 9, column: 18 };

function mk(body: DistOmit<Stmt, 'loc' | 'site'>, site = 0): Stmt {
  return { loc: LOC, site, ...body } as Stmt;
}

function vi(type: EvsType, debugName?: string): ValueInfo {
  return debugName === undefined ? { type, loc: null } : { type, loc: LOC, debugName };
}

function ir(p: Partial<ScriptIr>): ScriptIr {
  return {
    irVersion: 1,
    name: 'fixture',
    args: [],
    values: [],
    cells: [],
    fns: [],
    body: [],
    returns: [],
    loc: null,
    ...p,
  };
}

function wordHex(n: bigint): Hex {
  const w = n < 0n ? n + (1n << 256n) : n;
  return `0x${w.toString(16).padStart(64, '0')}`;
}

/** [len:32][payload zero-padded to a 32-byte boundary] memref hex for string/bytes consts. */
function dataHex(payload: string): Hex {
  const len = payload.length / 2;
  const padded = payload.padEnd(Math.ceil(len / 32) * 64, '0');
  return `0x${BigInt(len).toString(16).padStart(64, '0')}${padded}`;
}

/** [len:32][one canonical word per element] memref hex for array consts. */
function arrayDataHex(words: readonly bigint[]): Hex {
  let s = BigInt(words.length).toString(16).padStart(64, '0');
  for (const w of words) s += wordHex(w).slice(2);
  return `0x${s}`;
}

function fnAbi(
  name: string,
  inputs: readonly { name: string; type: string }[],
  outputs: readonly { name: string; type: string }[],
): PlainAbiFunction {
  return {
    name,
    selector: toFunctionSelector(`${name}(${inputs.map((i) => i.type).join(',')})`),
    inputs,
    outputs,
  };
}

// ---------------------------------------------------------------------------
// chains + outcome helpers
// ---------------------------------------------------------------------------

const deadChain: MockChain = {
  staticcall: () => {
    throw new Error('unexpected staticcall');
  },
};

interface RecordingChain extends MockChain {
  readonly calls: { to: Hex; data: Hex }[];
}

function chainOf(handler: (to: Hex, data: Hex) => { success: boolean; data: Hex }): RecordingChain {
  const calls: { to: Hex; data: Hex }[] = [];
  return {
    calls,
    staticcall(req) {
      calls.push(req);
      return handler(req.to, req.data);
    },
  };
}

function retOf(res: InterpResult): Record<string, unknown> {
  if (res.outcome.kind !== 'return') {
    throw new Error(`expected a return outcome, got revert ${res.outcome.data}`);
  }
  return res.outcome.values;
}

function returnData(res: InterpResult): Hex {
  if (res.outcome.kind !== 'return') {
    throw new Error(`expected a return outcome, got revert ${res.outcome.data}`);
  }
  return res.outcome.data;
}

function revertData(res: InterpResult): Hex {
  if (res.outcome.kind !== 'revert') throw new Error('expected a revert outcome');
  return res.outcome.data;
}

const PANIC_SEL = '4e487b71';
function panicHex(code: number): Hex {
  return `0x${PANIC_SEL}${BigInt(code).toString(16).padStart(64, '0')}`;
}

const DECODE_SEL = '20cf27b7'; // selectorOf('EvsDecodeError', ['uint256']) — pinned in M3 tests
function decodeErrHex(site: number): Hex {
  return `0x${DECODE_SEL}${BigInt(site).toString(16).padStart(64, '0')}`;
}

function expectPanic(res: InterpResult, code: number): void {
  expect(res.outcome).toEqual({ kind: 'revert', data: panicHex(code) });
}

/** result value normalized to bigint (viem decodes N ≤ 48 bit ints as JS numbers). */
function asBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  throw new Error(`expected a numeric result, got ${typeof v}`);
}

// ---------------------------------------------------------------------------
// single-op script runners
// ---------------------------------------------------------------------------

/** `r = a <op> b` over two script args of `type` (shift amounts are uint256 — own runner). */
function runBin(
  type: WordType,
  op: BinOp,
  a: unknown,
  b: unknown,
  outType: EvsType = boolOut(op) ? 'bool' : type,
): InterpResult {
  const script = ir({
    name: 'bin',
    args: [
      { name: 'a', type },
      { name: 'b', type },
    ],
    values: [vi(type, 'a'), vi(type, 'b'), vi(outType)],
    body: [mk({ k: 'bin', op, a: 0, b: 1, out: 2 })],
    returns: [{ name: 'r', type: outType, value: 2 }],
  });
  return interpret(script, [a, b], deadChain);
}

function boolOut(op: BinOp): boolean {
  return ['lt', 'gt', 'lte', 'gte', 'eq', 'neq', 'and', 'or'].includes(op);
}

function runShift(type: WordType, op: 'shl' | 'shr', a: unknown, bits: bigint): InterpResult {
  const script = ir({
    name: 'shift',
    args: [
      { name: 'a', type },
      { name: 'bits', type: 'uint256' },
    ],
    values: [vi(type, 'a'), vi('uint256', 'bits'), vi(type)],
    body: [mk({ k: 'bin', op, a: 0, b: 1, out: 2 })],
    returns: [{ name: 'r', type, value: 2 }],
  });
  return interpret(script, [a, bits], deadChain);
}

function runUn(type: WordType, op: UnOp, a: unknown): InterpResult {
  const outType: EvsType = op === 'bitnot' ? type : 'bool';
  const script = ir({
    name: 'un',
    args: [{ name: 'a', type }],
    values: [vi(type, 'a'), vi(outType)],
    body: [mk({ k: 'un', op, a: 0, out: 1 })],
    returns: [{ name: 'r', type: outType, value: 1 }],
  });
  return interpret(script, [a], deadChain);
}

function runConvert(from: WordType, to: WordType, a: unknown): InterpResult {
  const script = ir({
    name: 'conv',
    args: [{ name: 'a', type: from }],
    values: [vi(from, 'a'), vi(to)],
    body: [mk({ k: 'convert', a: 0, out: 1 })],
    returns: [{ name: 'r', type: to, value: 1 }],
  });
  return interpret(script, [a], deadChain);
}

// ---------------------------------------------------------------------------
// const + return encoding (every const shape; §8.2 byte-exactness vs viem)
// ---------------------------------------------------------------------------

describe('const + return encoding', () => {
  test('word const round-trips and the all-static tuple encodes inline (no 0x20 prefix)', () => {
    const script = ir({
      name: 'consts',
      values: [vi('uint256'), vi('bool'), vi('address'), vi('int24'), vi('bytes4')],
      body: [
        mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(42n) }, type: 'uint256' }),
        mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(1n) }, type: 'bool' }),
        mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(0xabcn) }, type: 'address' }),
        mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(-5n) }, type: 'int24' }),
        mk({
          k: 'const',
          out: 4,
          data: { kind: 'word', hex: `0xdeadbeef${'0'.repeat(56)}` },
          type: 'bytes4',
        }),
      ],
      returns: [
        { name: 'n', type: 'uint256', value: 0 },
        { name: 'f', type: 'bool', value: 1 },
        { name: 'who', type: 'address', value: 2 },
        { name: 'tick', type: 'int24', value: 3 },
        { name: 'tag', type: 'bytes4', value: 4 },
      ],
    });
    const res = interpret(script, [], deadChain);
    const expected = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'n', type: 'uint256' },
            { name: 'f', type: 'bool' },
            { name: 'who', type: 'address' },
            { name: 'tick', type: 'int24' },
            { name: 'tag', type: 'bytes4' },
          ],
        },
      ],
      [
        {
          n: 42n,
          f: true,
          who: '0x0000000000000000000000000000000000000abc',
          tick: -5,
          tag: '0xdeadbeef',
        },
      ],
    );
    expect(returnData(res)).toBe(expected);
    expect(returnData(res).startsWith(`0x${wordHex(42n).slice(2)}`)).toBe(true); // no 0x20 prefix
    expect(retOf(res)).toEqual({
      n: 42n,
      f: true,
      who: '0x0000000000000000000000000000000000000aBc',
      tick: -5,
      tag: '0xdeadbeef',
    });
  });

  test('data consts (string/bytes/array) + dynamic tuple gets the top-level 0x20 offset', () => {
    const script = ir({
      name: 'dyn',
      values: [vi('string'), vi('bytes'), vi('uint24[]'), vi('uint256')],
      body: [
        mk({ k: 'const', out: 0, data: { kind: 'data', hex: dataHex('616263') }, type: 'string' }),
        mk({ k: 'const', out: 1, data: { kind: 'data', hex: dataHex('deadbeef') }, type: 'bytes' }),
        mk({
          k: 'const',
          out: 2,
          data: { kind: 'data', hex: arrayDataHex([100n, 500n, 3000n]) },
          type: 'uint24[]',
        }),
        mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(7n) }, type: 'uint256' }),
      ],
      returns: [
        { name: 's', type: 'string', value: 0 },
        { name: 'b', type: 'bytes', value: 1 },
        { name: 'fees', type: 'uint24[]', value: 2 },
        { name: 'n', type: 'uint256', value: 3 },
      ],
    });
    const res = interpret(script, [], deadChain);
    const expected = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 's', type: 'string' },
            { name: 'b', type: 'bytes' },
            { name: 'fees', type: 'uint24[]' },
            { name: 'n', type: 'uint256' },
          ],
        },
      ],
      [{ s: 'abc', b: '0xdeadbeef', fees: [100, 500, 3000], n: 7n }],
    );
    expect(returnData(res)).toBe(expected);
    expect(returnData(res).slice(2, 66)).toBe(wordHex(0x20n).slice(2)); // dynamic tuple prefix
    expect(retOf(res)).toEqual({ s: 'abc', b: '0xdeadbeef', fees: [100, 500, 3000], n: 7n });
  });

  test('empty string and empty array encode as a bare zero length word', () => {
    const script = ir({
      name: 'empty',
      values: [vi('string'), vi('address[]')],
      body: [
        mk({ k: 'const', out: 0, data: { kind: 'data', hex: dataHex('') }, type: 'string' }),
        mk({
          k: 'const',
          out: 1,
          data: { kind: 'data', hex: arrayDataHex([]) },
          type: 'address[]',
        }),
      ],
      returns: [
        { name: 's', type: 'string', value: 0 },
        { name: 'a', type: 'address[]', value: 1 },
      ],
    });
    const res = interpret(script, [], deadChain);
    const expected = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 's', type: 'string' },
            { name: 'a', type: 'address[]' },
          ],
        },
      ],
      [{ s: '', a: [] }],
    );
    expect(returnData(res)).toBe(expected);
    expect(retOf(res)).toEqual({ s: '', a: [] });
  });
});

// ---------------------------------------------------------------------------
// args binding + coercion
// ---------------------------------------------------------------------------

describe('script args', () => {
  test('every arg kind echoes back byte-exactly', () => {
    const script = ir({
      name: 'echo',
      args: [
        { name: 'n', type: 'uint256' },
        { name: 'i', type: 'int8' },
        { name: 'f', type: 'bool' },
        { name: 'who', type: 'address' },
        { name: 'tag', type: 'bytes4' },
        { name: 'blob', type: 'bytes' },
        { name: 's', type: 'string' },
        { name: 'arr', type: 'int16[]' },
      ],
      values: [
        vi('uint256'),
        vi('int8'),
        vi('bool'),
        vi('address'),
        vi('bytes4'),
        vi('bytes'),
        vi('string'),
        vi('int16[]'),
      ],
      returns: [
        { name: 'n', type: 'uint256', value: 0 },
        { name: 'i', type: 'int8', value: 1 },
        { name: 'f', type: 'bool', value: 2 },
        { name: 'who', type: 'address', value: 3 },
        { name: 'tag', type: 'bytes4', value: 4 },
        { name: 'blob', type: 'bytes', value: 5 },
        { name: 's', type: 'string', value: 6 },
        { name: 'arr', type: 'int16[]', value: 7 },
      ],
    });
    const res = interpret(
      script,
      [
        2n ** 200n,
        -7,
        true,
        '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530',
        '0xCAFEBABE',
        '0x00ff',
        'héllo',
        [-1n, 300],
      ],
      deadChain,
    );
    const expected = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'n', type: 'uint256' },
            { name: 'i', type: 'int8' },
            { name: 'f', type: 'bool' },
            { name: 'who', type: 'address' },
            { name: 'tag', type: 'bytes4' },
            { name: 'blob', type: 'bytes' },
            { name: 's', type: 'string' },
            { name: 'arr', type: 'int16[]' },
          ],
        },
      ],
      [
        {
          n: 2n ** 200n,
          i: -7,
          f: true,
          who: '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530',
          tag: '0xcafebabe',
          blob: '0x00ff',
          s: 'héllo',
          arr: [-1, 300],
        },
      ],
    );
    expect(returnData(res)).toBe(expected);
    expect(retOf(res)).toEqual({
      n: 2n ** 200n,
      i: -7,
      f: true,
      who: '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530',
      tag: '0xcafebabe',
      blob: '0x00ff',
      s: 'héllo',
      arr: [-1, 300],
    });
  });

  const u8 = ir({
    name: 'one',
    args: [{ name: 'x', type: 'uint8' }],
    values: [vi('uint8')],
    returns: [{ name: 'r', type: 'uint8', value: 0 }],
  });

  test('arity mismatch → EvsTypeError', () => {
    expect(() => interpret(u8, [], deadChain)).toThrowError(EvsTypeError);
    expect(() => interpret(u8, [1n, 2n], deadChain)).toThrowError(/takes 1 argument/);
  });

  test('out-of-range / wrong-kind values → EvsTypeError', () => {
    expect(() => interpret(u8, [256n], deadChain)).toThrowError(/out of range/);
    expect(() => interpret(u8, [-1n], deadChain)).toThrowError(/out of range/);
    expect(() => interpret(u8, [1.5], deadChain)).toThrowError(EvsTypeError);
    expect(() => interpret(u8, ['5'], deadChain)).toThrowError(EvsTypeError);

    const addr = ir({
      name: 'addr',
      args: [{ name: 'x', type: 'address' }],
      values: [vi('address')],
      returns: [{ name: 'r', type: 'address', value: 0 }],
    });
    expect(() => interpret(addr, ['0x1234'], deadChain)).toThrowError(/exactly 20 bytes/);
    expect(() => interpret(addr, ['not hex'], deadChain)).toThrowError(EvsTypeError);

    const flag = ir({
      name: 'flag',
      args: [{ name: 'x', type: 'bool' }],
      values: [vi('bool')],
      returns: [{ name: 'r', type: 'bool', value: 0 }],
    });
    expect(() => interpret(flag, [1], deadChain)).toThrowError(/expected a boolean/);

    const arr = ir({
      name: 'arr',
      args: [{ name: 'x', type: 'uint8[]' }],
      values: [vi('uint8[]')],
      returns: [{ name: 'r', type: 'uint8[]', value: 0 }],
    });
    expect(() => interpret(arr, [[300n]], deadChain)).toThrowError(/\(uint8\[\]\)\[0\]/);
    expect(() => interpret(arr, ['nope'], deadChain)).toThrowError(/expected an array/);
  });
});

// ---------------------------------------------------------------------------
// checked arithmetic — the §6 boundary matrix
// ---------------------------------------------------------------------------

const U256_MAX = 2n ** 256n - 1n;
const I256_MAX = 2n ** 255n - 1n;
const I256_MIN = -(2n ** 255n);

describe('checked add', () => {
  test('uint256', () => {
    expect(asBig(retOf(runBin('uint256', 'add', U256_MAX, 0n)).r)).toBe(U256_MAX);
    expectPanic(runBin('uint256', 'add', U256_MAX, 1n), 0x11);
    expectPanic(runBin('uint256', 'add', 1n, U256_MAX), 0x11);
  });
  test('uint8', () => {
    expect(asBig(retOf(runBin('uint8', 'add', 254n, 1n)).r)).toBe(255n);
    expectPanic(runBin('uint8', 'add', 255n, 1n), 0x11);
  });
  test('int256', () => {
    expect(asBig(retOf(runBin('int256', 'add', -1n, -1n)).r)).toBe(-2n);
    expectPanic(runBin('int256', 'add', I256_MAX, 1n), 0x11);
    expectPanic(runBin('int256', 'add', I256_MIN, -1n), 0x11);
  });
  test('int8', () => {
    expect(asBig(retOf(runBin('int8', 'add', -128n, 127n)).r)).toBe(-1n);
    expectPanic(runBin('int8', 'add', 127n, 1n), 0x11);
    expectPanic(runBin('int8', 'add', -128n, -1n), 0x11);
  });
});

describe('checked sub', () => {
  test('uint256 / uint64', () => {
    expect(asBig(retOf(runBin('uint256', 'sub', 1n, 1n)).r)).toBe(0n);
    expectPanic(runBin('uint256', 'sub', 0n, 1n), 0x11);
    expectPanic(runBin('uint64', 'sub', 0n, 1n), 0x11);
  });
  test('int256 / int8', () => {
    expect(asBig(retOf(runBin('int256', 'sub', I256_MIN, 0n)).r)).toBe(I256_MIN);
    expectPanic(runBin('int256', 'sub', I256_MIN, 1n), 0x11);
    expectPanic(runBin('int256', 'sub', I256_MAX, -1n), 0x11);
    expectPanic(runBin('int8', 'sub', -128n, 1n), 0x11);
    expect(asBig(retOf(runBin('int8', 'sub', -127n, 1n)).r)).toBe(-128n);
  });
});

describe('checked mul (width-dependent rule)', () => {
  test('uint256 — div-back', () => {
    expect(asBig(retOf(runBin('uint256', 'mul', 2n ** 128n, 2n ** 128n - 1n)).r)).toBe(
      2n ** 256n - 2n ** 128n,
    );
    expectPanic(runBin('uint256', 'mul', 2n ** 128n, 2n ** 128n), 0x11);
    expect(asBig(retOf(runBin('uint256', 'mul', 0n, U256_MAX)).r)).toBe(0n);
  });
  test('uint8 (N ≤ 128 — range check alone is sound)', () => {
    expect(asBig(retOf(runBin('uint8', 'mul', 15n, 17n)).r)).toBe(255n);
    expectPanic(runBin('uint8', 'mul', 16n, 16n), 0x11);
  });
  test('uint128 boundary', () => {
    expect(asBig(retOf(runBin('uint128', 'mul', 2n ** 64n - 1n, 2n ** 64n + 1n)).r)).toBe(
      2n ** 128n - 1n,
    );
    expectPanic(runBin('uint128', 'mul', 2n ** 64n, 2n ** 64n), 0x11);
  });
  test('uint192 — the 256-bit wrap-back case needs BOTH checks', () => {
    // 2^191 × (2^65 + 1) ≡ 2^191 (mod 2^256): a wrapped-result range check alone would pass
    expectPanic(runBin('uint192', 'mul', 2n ** 191n, 2n ** 65n + 1n), 0x11);
    expect(asBig(retOf(runBin('uint192', 'mul', 2n ** 95n, 2n ** 96n)).r)).toBe(2n ** 191n);
  });
  test('int256 — sdiv-back plus the lone −1 × −2^255 case', () => {
    expectPanic(runBin('int256', 'mul', -1n, I256_MIN), 0x11);
    expectPanic(runBin('int256', 'mul', I256_MIN, -1n), 0x11);
    expect(asBig(retOf(runBin('int256', 'mul', I256_MIN, 1n)).r)).toBe(I256_MIN);
    expect(asBig(retOf(runBin('int256', 'mul', 2n ** 127n, 2n ** 127n)).r)).toBe(2n ** 254n);
    expectPanic(runBin('int256', 'mul', 2n ** 128n, 2n ** 127n), 0x11);
  });
  test('int8 (N ≤ 128 — fixpoint alone)', () => {
    expectPanic(runBin('int8', 'mul', -128n, -1n), 0x11);
    expect(asBig(retOf(runBin('int8', 'mul', -64n, 2n)).r)).toBe(-128n);
  });
  test('int200 (128 < N < 256 — int256 check then fixpoint)', () => {
    expectPanic(runBin('int200', 'mul', 2n ** 100n, 2n ** 100n), 0x11); // fits int256, not int200
    expect(asBig(retOf(runBin('int200', 'mul', -(2n ** 100n), 2n ** 99n)).r)).toBe(-(2n ** 199n));
  });
});

describe('checked div / mod', () => {
  test('division by zero → Panic 0x12 for every type', () => {
    expectPanic(runBin('uint256', 'div', 1n, 0n), 0x12);
    expectPanic(runBin('uint8', 'div', 0n, 0n), 0x12);
    expectPanic(runBin('int256', 'div', -1n, 0n), 0x12);
    expectPanic(runBin('uint256', 'mod', 1n, 0n), 0x12);
    expectPanic(runBin('int8', 'mod', -1n, 0n), 0x12);
  });
  test('int256 −2^255 / −1 → Panic 0x11 (EVM SDIV silently wraps)', () => {
    expectPanic(runBin('int256', 'div', I256_MIN, -1n), 0x11);
    expect(asBig(retOf(runBin('int256', 'div', I256_MIN, 1n)).r)).toBe(I256_MIN);
  });
  test('intN minN / −1 → Panic 0x11 uniformly', () => {
    expectPanic(runBin('int8', 'div', -128n, -1n), 0x11);
    expectPanic(runBin('int200', 'div', -(2n ** 199n), -1n), 0x11);
  });
  test('SDIV/SMOD truncate toward zero, remainder follows the dividend', () => {
    expect(asBig(retOf(runBin('int256', 'div', -7n, 2n)).r)).toBe(-3n);
    expect(asBig(retOf(runBin('int256', 'div', 7n, -2n)).r)).toBe(-3n);
    expect(asBig(retOf(runBin('int256', 'mod', -7n, 3n)).r)).toBe(-1n);
    expect(asBig(retOf(runBin('int256', 'mod', 7n, -3n)).r)).toBe(1n);
    expect(asBig(retOf(runBin('int256', 'mod', I256_MIN, -1n)).r)).toBe(0n); // no panic
    expect(asBig(retOf(runBin('uint256', 'div', 7n, 2n)).r)).toBe(3n);
    expect(asBig(retOf(runBin('uint256', 'mod', 7n, 3n)).r)).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// comparisons, bool logic, bitwise, shifts, un ops
// ---------------------------------------------------------------------------

describe('comparisons — signedness from the static type', () => {
  test('unsigned LT/GT', () => {
    expect(retOf(runBin('uint256', 'gt', U256_MAX, 1n)).r).toBe(true);
    expect(retOf(runBin('uint256', 'lt', U256_MAX, 1n)).r).toBe(false);
  });
  test('signed SLT/SGT (−1 sits below 1, not above)', () => {
    expect(retOf(runBin('int256', 'lt', -1n, 1n)).r).toBe(true);
    expect(retOf(runBin('int8', 'gt', -1n, 1n)).r).toBe(false);
  });
  test('lte/gte are ISZERO(GT/LT)', () => {
    expect(retOf(runBin('uint8', 'lte', 5n, 5n)).r).toBe(true);
    expect(retOf(runBin('uint8', 'gte', 5n, 6n)).r).toBe(false);
    expect(retOf(runBin('int8', 'gte', -5n, -5n)).r).toBe(true);
  });
  test('eq/neq on word types', () => {
    expect(retOf(runBin('address', 'eq', '0x' + 'aa'.repeat(20), '0x' + 'aa'.repeat(20))).r).toBe(
      true,
    );
    expect(
      retOf(runBin('bytes32', 'neq', `0x${'00'.repeat(31)}01`, `0x${'00'.repeat(32)}`)).r,
    ).toBe(true);
    expect(retOf(runBin('bool', 'eq', true, false)).r).toBe(false);
  });
});

describe('bool logic (eager) + un ops', () => {
  test('and/or/not/iszero', () => {
    expect(retOf(runBin('bool', 'and', true, false)).r).toBe(false);
    expect(retOf(runBin('bool', 'and', true, true)).r).toBe(true);
    expect(retOf(runBin('bool', 'or', false, true)).r).toBe(true);
    expect(retOf(runUn('bool', 'not', true)).r).toBe(false);
    expect(retOf(runUn('bool', 'not', false)).r).toBe(true);
    expect(retOf(runUn('uint256', 'iszero', 0n)).r).toBe(true);
    expect(retOf(runUn('uint256', 'iszero', 5n)).r).toBe(false);
  });
});

describe('bitwise — results re-canonicalized to width', () => {
  test('and/or/xor', () => {
    expect(asBig(retOf(runBin('uint8', 'bitand', 0xf0n, 0x0fn)).r)).toBe(0n);
    expect(asBig(retOf(runBin('uint8', 'bitor', 0xf0n, 0x0fn)).r)).toBe(0xffn);
    expect(asBig(retOf(runBin('int8', 'bitxor', -1n, 1n)).r)).toBe(-2n);
    expect(retOf(runBin('bytes4', 'bitand', '0xffffffff', '0x00ff00ff')).r).toBe('0x00ff00ff');
  });
  test('bitnot', () => {
    expect(asBig(retOf(runUn('uint8', 'bitnot', 0x0fn)).r)).toBe(0xf0n);
    expect(asBig(retOf(runUn('int8', 'bitnot', 0n)).r)).toBe(-1n);
    expect(asBig(retOf(runUn('uint256', 'bitnot', 0n)).r)).toBe(U256_MAX);
    expect(retOf(runUn('bytes4', 'bitnot', '0x00000000')).r).toBe('0xffffffff');
  });
  test('shl masks to width (unchecked, solc semantics)', () => {
    expect(asBig(retOf(runShift('uint8', 'shl', 0x80n, 1n)).r)).toBe(0n);
    expect(asBig(retOf(runShift('uint8', 'shl', 1n, 7n)).r)).toBe(0x80n);
    expect(asBig(retOf(runShift('uint256', 'shl', 1n, 255n)).r)).toBe(2n ** 255n);
    expect(asBig(retOf(runShift('uint256', 'shl', 1n, 256n)).r)).toBe(0n);
    expect(asBig(retOf(runShift('int8', 'shl', 0x40n, 1n)).r)).toBe(-128n); // re-sign-extended
    expect(retOf(runShift('bytes2', 'shl', '0x00ff', 8n)).r).toBe('0xff00');
    expect(retOf(runShift('bytes1', 'shl', '0xff', 4n)).r).toBe('0xf0');
  });
  test('shr is SHR for uintN/bytesN, SAR for intN', () => {
    expect(asBig(retOf(runShift('uint8', 'shr', 0x80n, 7n)).r)).toBe(1n);
    expect(retOf(runShift('bytes2', 'shr', '0xff00', 8n)).r).toBe('0x00ff');
    expect(retOf(runShift('bytes1', 'shr', '0xff', 4n)).r).toBe('0x0f');
    expect(asBig(retOf(runShift('int8', 'shr', -128n, 1n)).r)).toBe(-64n);
    expect(asBig(retOf(runShift('int256', 'shr', -1n, 200n)).r)).toBe(-1n);
    expect(asBig(retOf(runShift('int256', 'shr', -2n, 300n)).r)).toBe(-1n); // SAR ≥256, negative
    expect(asBig(retOf(runShift('int256', 'shr', 64n, 1n)).r)).toBe(32n);
    expect(asBig(retOf(runShift('uint256', 'shr', U256_MAX, 256n)).r)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// conversions
// ---------------------------------------------------------------------------

describe('convert', () => {
  test('widening is free, sign-preserving', () => {
    expect(asBig(retOf(runConvert('uint8', 'uint256', 255n)).r)).toBe(255n);
    expect(asBig(retOf(runConvert('int8', 'int256', -1n)).r)).toBe(-1n);
  });
  test('narrowing is checked → Panic 0x11', () => {
    expect(asBig(retOf(runConvert('uint256', 'uint8', 255n)).r)).toBe(255n);
    expectPanic(runConvert('uint256', 'uint8', 256n), 0x11);
    expect(asBig(retOf(runConvert('int256', 'int8', -128n)).r)).toBe(-128n);
    expectPanic(runConvert('int256', 'int8', -129n), 0x11);
    expectPanic(runConvert('int256', 'int8', 128n), 0x11);
  });
  test('cross-signedness is range-checked', () => {
    expectPanic(runConvert('int8', 'uint8', -1n), 0x11);
    expectPanic(runConvert('uint8', 'int8', 200n), 0x11);
    expect(asBig(retOf(runConvert('uint8', 'int8', 100n)).r)).toBe(100n);
    expect(asBig(retOf(runConvert('int8', 'uint256', 5n)).r)).toBe(5n);
  });
  test('uint256 ↔ bytes32 free reinterpret', () => {
    expect(retOf(runConvert('uint256', 'bytes32', U256_MAX)).r).toBe(`0x${'ff'.repeat(32)}`);
    expect(asBig(retOf(runConvert('bytes32', 'uint256', `0x${'00'.repeat(31)}2a`)).r)).toBe(42n);
  });
  test('asAddress checks the high 96 bits', () => {
    expect(retOf(runConvert('uint256', 'address', 5n)).r).toBe(
      '0x0000000000000000000000000000000000000005',
    );
    expectPanic(runConvert('uint256', 'address', 2n ** 160n), 0x11);
    expectPanic(runConvert('bytes32', 'address', `0x01${'00'.repeat(31)}`), 0x11);
    expect(
      retOf(runConvert('bytes32', 'address', `0x${'00'.repeat(12)}${'aa'.repeat(20)}`)).r,
    ).toBe('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa');
  });
});

// ---------------------------------------------------------------------------
// env ops (harness-pinned constants)
// ---------------------------------------------------------------------------

test('env ops return the unit-harness environment', () => {
  const script = ir({
    name: 'env',
    values: [vi('address'), vi('address'), vi('uint256'), vi('uint256'), vi('uint256')],
    body: [
      mk({ k: 'env', op: 'address', out: 0 }),
      mk({ k: 'env', op: 'caller', out: 1 }),
      mk({ k: 'env', op: 'timestamp', out: 2 }),
      mk({ k: 'env', op: 'blocknumber', out: 3 }),
      mk({ k: 'env', op: 'chainid', out: 4 }),
    ],
    returns: [
      { name: 'self', type: 'address', value: 0 },
      { name: 'caller', type: 'address', value: 1 },
      { name: 'ts', type: 'uint256', value: 2 },
      { name: 'bn', type: 'uint256', value: 3 },
      { name: 'chain', type: 'uint256', value: 4 },
    ],
  });
  expect(retOf(interpret(script, [], deadChain))).toEqual({
    self: '0xcD360FfAC9818c4396Aa6F4807EBfA72C4B3f530',
    caller: '0x1000000000000000000000000000000000000001',
    ts: 0n,
    bn: 0n,
    chain: 1n,
  });
});

describe('env overrides (opts.env — frame-dependent caller/address modeling)', () => {
  const envScript = ir({
    name: 'env',
    values: [vi('address'), vi('address'), vi('uint256'), vi('uint256'), vi('uint256')],
    body: [
      mk({ k: 'env', op: 'address', out: 0 }),
      mk({ k: 'env', op: 'caller', out: 1 }),
      mk({ k: 'env', op: 'timestamp', out: 2 }),
      mk({ k: 'env', op: 'blocknumber', out: 3 }),
      mk({ k: 'env', op: 'chainid', out: 4 }),
    ],
    returns: [
      { name: 'self', type: 'address', value: 0 },
      { name: 'caller', type: 'address', value: 1 },
      { name: 'ts', type: 'uint256', value: 2 },
      { name: 'bn', type: 'uint256', value: 3 },
      { name: 'chain', type: 'uint256', value: 4 },
    ],
  });

  test('every env op is overridable; omitted fields keep the defaults', () => {
    const out = retOf(
      interpret(envScript, [], deadChain, {
        env: {
          address: '0x659b375d76a8e9a2c68da8818022d6561aa60845',
          caller: '0x2222222222222222222222222222222222222222',
          chainid: 31_337n,
        },
      }),
    );
    expect(out).toEqual({
      self: '0x659B375D76a8E9a2c68Da8818022D6561aA60845',
      caller: '0x2222222222222222222222222222222222222222',
      ts: 0n, // default kept
      bn: 0n, // default kept
      chain: 31_337n,
    });
    const numeric = retOf(
      interpret(envScript, [], deadChain, { env: { timestamp: 1_700_000_000n, blocknumber: 2n } }),
    );
    expect(numeric).toMatchObject({ ts: 1_700_000_000n, bn: 2n });
  });

  test('malformed overrides throw EvsTypeError (host-side, never a chain outcome)', () => {
    expect(() => interpret(envScript, [], deadChain, { env: { caller: '0x1234' } })).toThrowError(
      EvsTypeError,
    );
    expect(() => interpret(envScript, [], deadChain, { env: { chainid: -1n } })).toThrowError(
      EvsTypeError,
    );
    expect(() =>
      interpret(envScript, [], deadChain, { env: { timestamp: 1n << 256n } }),
    ).toThrowError(EvsTypeError);
  });
});

// ---------------------------------------------------------------------------
// select / index / len / arrnew / arrset / cells
// ---------------------------------------------------------------------------

describe('select', () => {
  function runSelect(cond: boolean): Record<string, unknown> {
    const script = ir({
      name: 'sel',
      args: [{ name: 'c', type: 'bool' }],
      values: [
        vi('bool'),
        vi('uint256'),
        vi('uint256'),
        vi('uint256'),
        vi('string'),
        vi('string'),
        vi('string'),
      ],
      body: [
        mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(10n) }, type: 'uint256' }),
        mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(20n) }, type: 'uint256' }),
        mk({ k: 'select', cond: 0, a: 1, b: 2, out: 3 }),
        mk({ k: 'const', out: 4, data: { kind: 'data', hex: dataHex('6161') }, type: 'string' }),
        mk({ k: 'const', out: 5, data: { kind: 'data', hex: dataHex('6262') }, type: 'string' }),
        mk({ k: 'select', cond: 0, a: 4, b: 5, out: 6 }),
      ],
      returns: [
        { name: 'n', type: 'uint256', value: 3 },
        { name: 's', type: 'string', value: 6 },
      ],
    });
    return retOf(interpret(script, [cond], deadChain));
  }
  test('eager value select over words and memrefs', () => {
    expect(runSelect(true)).toEqual({ n: 10n, s: 'aa' });
    expect(runSelect(false)).toEqual({ n: 20n, s: 'bb' });
  });
});

describe('arrays + cells', () => {
  test('len + index over an array arg; OOB → Panic 0x32', () => {
    const script = ir({
      name: 'idx',
      args: [
        { name: 'arr', type: 'uint256[]' },
        { name: 'i', type: 'uint256' },
      ],
      values: [vi('uint256[]'), vi('uint256'), vi('uint256'), vi('uint256')],
      body: [mk({ k: 'len', a: 0, out: 2 }), mk({ k: 'index', arr: 0, i: 1, out: 3 })],
      returns: [
        { name: 'n', type: 'uint256', value: 2 },
        { name: 'x', type: 'uint256', value: 3 },
      ],
    });
    expect(retOf(interpret(script, [[7n, 8n, 9n], 2n], deadChain))).toEqual({ n: 3n, x: 9n });
    expectPanic(interpret(script, [[7n, 8n, 9n], 3n], deadChain), 0x32);
  });

  test('len over string and bytes counts bytes', () => {
    const script = ir({
      name: 'lens',
      args: [
        { name: 's', type: 'string' },
        { name: 'b', type: 'bytes' },
      ],
      values: [vi('string'), vi('bytes'), vi('uint256'), vi('uint256')],
      body: [mk({ k: 'len', a: 0, out: 2 }), mk({ k: 'len', a: 1, out: 3 })],
      returns: [
        { name: 'sl', type: 'uint256', value: 2 },
        { name: 'bl', type: 'uint256', value: 3 },
      ],
    });
    // 'héllo' is 6 UTF-8 bytes
    expect(retOf(interpret(script, ['héllo', '0xdeadbeef'], deadChain))).toEqual({
      sl: 6n,
      bl: 4n,
    });
  });

  test('arrnew zero-fills; arrset/index round-trip; OOB set → 0x32; len ≥ 2^32 → 0x41', () => {
    const build = (len: bigint, setAt: bigint): ScriptIr =>
      ir({
        name: 'marr',
        values: [
          vi('uint256'),
          vi('uint8[]'),
          vi('uint256'),
          vi('uint8'),
          vi('uint8'),
          vi('uint8'),
          vi('uint256'),
        ],
        body: [
          mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(len) }, type: 'uint256' }),
          mk({ k: 'arrnew', elem: 'uint8', length: 0, out: 1 }),
          mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(setAt) }, type: 'uint256' }),
          mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(9n) }, type: 'uint8' }),
          mk({ k: 'arrset', arr: 1, i: 2, value: 3 }),
          mk({ k: 'index', arr: 1, i: 2, out: 4 }),
          mk({ k: 'const', out: 6, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint256' }),
          mk({ k: 'index', arr: 1, i: 6, out: 5 }),
        ],
        returns: [
          { name: 'set', type: 'uint8', value: 4 },
          { name: 'zero', type: 'uint8', value: 5 },
          { name: 'all', type: 'uint8[]', value: 1 },
        ],
      });
    expect(retOf(interpret(build(3n, 1n), [], deadChain))).toEqual({
      set: 9,
      zero: 0,
      all: [0, 9, 0],
    });
    expectPanic(interpret(build(3n, 3n), [], deadChain), 0x32);
    expectPanic(interpret(build(2n ** 32n, 0n), [], deadChain), 0x41);
  });

  test('memrefs have reference semantics through cells (arrset visible via every alias)', () => {
    const script = ir({
      name: 'alias',
      values: [
        vi('uint256'),
        vi('uint256[]'),
        vi('uint256[]'),
        vi('uint256'),
        vi('uint256'),
        vi('uint256'),
      ],
      cells: [{ type: 'uint256[]', loc: null }],
      body: [
        mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(2n) }, type: 'uint256' }),
        mk({ k: 'arrnew', elem: 'uint256', length: 0, out: 1 }),
        mk({ k: 'cellnew', cell: 0, init: 1 }),
        mk({ k: 'cellget', cell: 0, out: 2 }),
        mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint256' }),
        mk({ k: 'const', out: 4, data: { kind: 'word', hex: wordHex(7n) }, type: 'uint256' }),
        mk({ k: 'arrset', arr: 2, i: 3, value: 4 }), // write through the cell alias
        mk({ k: 'index', arr: 1, i: 3, out: 5 }), // read through the original handle
      ],
      returns: [{ name: 'r', type: 'uint256', value: 5 }],
    });
    expect(retOf(interpret(script, [], deadChain))).toEqual({ r: 7n });
  });
});

// ---------------------------------------------------------------------------
// control flow: if / while / break / continue / fncall
// ---------------------------------------------------------------------------

describe('control flow', () => {
  test('if takes the then-branch on true and the else-branch on false', () => {
    const script = ir({
      name: 'branch',
      args: [{ name: 'c', type: 'bool' }],
      values: [vi('bool'), vi('uint256'), vi('uint256'), vi('uint256'), vi('uint256')],
      cells: [{ type: 'uint256', loc: null }],
      body: [
        mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint256' }),
        mk({ k: 'cellnew', cell: 0, init: 1 }),
        mk({
          k: 'if',
          cond: 0,
          then: [
            mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint256' }),
            mk({ k: 'cellset', cell: 0, value: 2 }),
          ],
          else: [
            mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(2n) }, type: 'uint256' }),
            mk({ k: 'cellset', cell: 0, value: 3 }),
          ],
        }),
        mk({ k: 'cellget', cell: 0, out: 4 }),
      ],
      returns: [{ name: 'r', type: 'uint256', value: 4 }],
    });
    expect(retOf(interpret(script, [true], deadChain))).toEqual({ r: 1n });
    expect(retOf(interpret(script, [false], deadChain))).toEqual({ r: 2n });
  });

  /** architecture §15.3 — sum 0..n−1 with cells; header re-executed per iteration. */
  const sumScript = ir({
    name: 'sum',
    args: [{ name: 'n', type: 'uint256' }],
    values: [
      vi('uint256', 'n'), // v0
      vi('uint256'), // v1 const 0
      vi('uint256'), // v2 const 1
      vi('uint256'), // v3 header i
      vi('bool'), // v4 header lt
      vi('uint256'), // v5 total
      vi('uint256'), // v6 i
      vi('uint256'), // v7 total + i
      vi('uint256'), // v8 i
      vi('uint256'), // v9 i + 1
      vi('uint256'), // v10 final total
    ],
    cells: [
      { type: 'uint256', loc: null, debugName: 'total' },
      { type: 'uint256', loc: null, debugName: 'i' },
    ],
    body: [
      mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint256' }),
      mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint256' }),
      mk({ k: 'cellnew', cell: 0, init: 1 }),
      mk({ k: 'cellnew', cell: 1, init: 1 }),
      mk({
        k: 'while',
        header: [
          mk({ k: 'cellget', cell: 1, out: 3 }),
          mk({ k: 'bin', op: 'lt', a: 3, b: 0, out: 4 }),
        ],
        cond: 4,
        body: [
          mk({ k: 'cellget', cell: 0, out: 5 }),
          mk({ k: 'cellget', cell: 1, out: 6 }),
          mk({ k: 'bin', op: 'add', a: 5, b: 6, out: 7 }),
          mk({ k: 'cellset', cell: 0, value: 7 }),
          mk({ k: 'cellget', cell: 1, out: 8 }),
          mk({ k: 'bin', op: 'add', a: 8, b: 2, out: 9 }),
          mk({ k: 'cellset', cell: 1, value: 9 }),
        ],
      }),
      mk({ k: 'cellget', cell: 0, out: 10 }),
    ],
    returns: [{ name: 'sum', type: 'uint256', value: 10 }],
  });

  test('while: sum 0..n−1', () => {
    expect(retOf(interpret(sumScript, [10n], deadChain))).toEqual({ sum: 45n });
    expect(retOf(interpret(sumScript, [0n], deadChain))).toEqual({ sum: 0n });
  });

  test('break exits the loop at the right iteration', () => {
    const script = ir({
      name: 'brk',
      values: [
        vi('uint256'), // v0 const 0
        vi('uint256'), // v1 const 1
        vi('uint256'), // v2 const 5
        vi('uint256'), // v3 const 3
        vi('uint256'), // v4 header i
        vi('bool'), // v5 header lt
        vi('uint256'), // v6 body i
        vi('bool'), // v7 eq 3
        vi('uint256'), // v8 body i
        vi('uint256'), // v9 i+1
        vi('uint256'), // v10 final
      ],
      cells: [{ type: 'uint256', loc: null, debugName: 'i' }],
      body: [
        mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint256' }),
        mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint256' }),
        mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(5n) }, type: 'uint256' }),
        mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(3n) }, type: 'uint256' }),
        mk({ k: 'cellnew', cell: 0, init: 0 }),
        mk({
          k: 'while',
          header: [
            mk({ k: 'cellget', cell: 0, out: 4 }),
            mk({ k: 'bin', op: 'lt', a: 4, b: 2, out: 5 }),
          ],
          cond: 5,
          body: [
            mk({ k: 'cellget', cell: 0, out: 6 }),
            mk({ k: 'bin', op: 'eq', a: 6, b: 3, out: 7 }),
            mk({ k: 'if', cond: 7, then: [mk({ k: 'break' })], else: [] }),
            mk({ k: 'cellget', cell: 0, out: 8 }),
            mk({ k: 'bin', op: 'add', a: 8, b: 1, out: 9 }),
            mk({ k: 'cellset', cell: 0, value: 9 }),
          ],
        }),
        mk({ k: 'cellget', cell: 0, out: 10 }),
      ],
      returns: [{ name: 'i', type: 'uint256', value: 10 }],
    });
    expect(retOf(interpret(script, [], deadChain))).toEqual({ i: 3n });
  });

  test('continue re-executes the header and skips the rest of the body', () => {
    // i: 0→…→4; skip total += i when i == 2 ⇒ total = 1 + 3 + 4 = 8
    const script = ir({
      name: 'cont',
      values: [
        vi('uint256'), // v0 const 0
        vi('uint256'), // v1 const 1
        vi('uint256'), // v2 const 4
        vi('uint256'), // v3 const 2
        vi('uint256'), // v4 header i
        vi('bool'), // v5 header lt
        vi('uint256'), // v6 i
        vi('uint256'), // v7 i+1
        vi('uint256'), // v8 i (fresh)
        vi('bool'), // v9 eq 2
        vi('uint256'), // v10 total
        vi('uint256'), // v11 i
        vi('uint256'), // v12 total+i
        vi('uint256'), // v13 final
      ],
      cells: [
        { type: 'uint256', loc: null, debugName: 'i' },
        { type: 'uint256', loc: null, debugName: 'total' },
      ],
      body: [
        mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint256' }),
        mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint256' }),
        mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(4n) }, type: 'uint256' }),
        mk({ k: 'const', out: 3, data: { kind: 'word', hex: wordHex(2n) }, type: 'uint256' }),
        mk({ k: 'cellnew', cell: 0, init: 0 }),
        mk({ k: 'cellnew', cell: 1, init: 0 }),
        mk({
          k: 'while',
          header: [
            mk({ k: 'cellget', cell: 0, out: 4 }),
            mk({ k: 'bin', op: 'lt', a: 4, b: 2, out: 5 }),
          ],
          cond: 5,
          body: [
            mk({ k: 'cellget', cell: 0, out: 6 }),
            mk({ k: 'bin', op: 'add', a: 6, b: 1, out: 7 }),
            mk({ k: 'cellset', cell: 0, value: 7 }),
            mk({ k: 'cellget', cell: 0, out: 8 }),
            mk({ k: 'bin', op: 'eq', a: 8, b: 3, out: 9 }),
            mk({ k: 'if', cond: 9, then: [mk({ k: 'continue' })], else: [] }),
            mk({ k: 'cellget', cell: 1, out: 10 }),
            mk({ k: 'cellget', cell: 0, out: 11 }),
            mk({ k: 'bin', op: 'add', a: 10, b: 11, out: 12 }),
            mk({ k: 'cellset', cell: 1, value: 12 }),
          ],
        }),
        mk({ k: 'cellget', cell: 1, out: 13 }),
      ],
      returns: [{ name: 'total', type: 'uint256', value: 13 }],
    });
    expect(retOf(interpret(script, [], deadChain))).toEqual({ total: 8n });
  });

  test('fncall: body per call, fresh outs, no aliasing between callsites', () => {
    const script = ir({
      name: 'fns',
      args: [{ name: 'x', type: 'uint256' }],
      values: [
        vi('uint256', 'x'), // v0 arg
        vi('uint256', 'p'), // v1 fn param
        vi('uint256'), // v2 fn body double
        vi('uint256'), // v3 out of call 1
        vi('uint256'), // v4 out of call 2
      ],
      fns: [
        {
          name: 'double',
          params: [{ name: 'p', type: 'uint256', value: 1 }],
          results: [{ type: 'uint256' }],
          body: [mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 })],
          resultValues: [2],
          loc: null,
        },
      ],
      body: [
        mk({ k: 'fncall', fn: 0, args: [0], outs: [3] }),
        mk({ k: 'fncall', fn: 0, args: [3], outs: [4] }),
      ],
      returns: [
        { name: 'once', type: 'uint256', value: 3 },
        { name: 'twice', type: 'uint256', value: 4 },
      ],
    });
    expect(retOf(interpret(script, [10n], deadChain))).toEqual({ once: 20n, twice: 40n });
  });
});

// ---------------------------------------------------------------------------
// calls — calldata bytes, bubbling, decode bounds, normalization, tryCall
// ---------------------------------------------------------------------------

const TOKEN = '0x00000000000000000000000000000000000000aa';
const OWNER = '0x00000000000000000000000000000000000000bb';

const balanceOfAbi = fnAbi(
  'balanceOf',
  [{ name: 'who', type: 'address' }],
  [{ name: '', type: 'uint256' }],
);

/** strict single call: balanceOf(owner) on a token arg; returns the uint256. */
const callScript = ir({
  name: 'call1',
  args: [
    { name: 'token', type: 'address' },
    { name: 'owner', type: 'address' },
  ],
  values: [vi('address'), vi('address'), vi('uint256')],
  body: [
    mk({ k: 'call', target: 0, fnAbi: balanceOfAbi, args: [1], outs: [2], mode: 'strict' }, 7),
  ],
  returns: [{ name: 'bal', type: 'uint256', value: 2 }],
});

describe('call — strict mode', () => {
  test('sub-call calldata is byte-equal to viem encodeFunctionData', () => {
    const chain = chainOf(() => ({
      success: true,
      data: encodeAbiParameters([{ type: 'uint256' }], [123n]),
    }));
    const res = interpret(callScript, [TOKEN, OWNER], chain);
    expect(retOf(res)).toEqual({ bal: 123n });
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]?.to).toBe(TOKEN);
    expect(chain.calls[0]?.data).toBe(
      encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'balanceOf',
            stateMutability: 'view',
            inputs: [{ name: 'who', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }],
          },
        ],
        functionName: 'balanceOf',
        args: [OWNER],
      }),
    );
  });

  test('dynamic args (string + uint256[]) encode byte-equal to viem', () => {
    const echoAbi = fnAbi(
      'echo',
      [
        { name: 's', type: 'string' },
        { name: 'arr', type: 'uint256[]' },
        { name: 'n', type: 'uint8' },
      ],
      [],
    );
    const script = ir({
      name: 'dynargs',
      args: [
        { name: 'target', type: 'address' },
        { name: 's', type: 'string' },
        { name: 'arr', type: 'uint256[]' },
        { name: 'n', type: 'uint8' },
      ],
      values: [vi('address'), vi('string'), vi('uint256[]'), vi('uint8')],
      body: [
        mk({ k: 'call', target: 0, fnAbi: echoAbi, args: [1, 2, 3], outs: [], mode: 'strict' }),
      ],
      returns: [{ name: 'n', type: 'uint8', value: 3 }],
    });
    const chain = chainOf(() => ({ success: true, data: '0x' }));
    const res = interpret(script, [TOKEN, 'hello', [1n, 2n, 3n], 5n], chain);
    expect(retOf(res)).toEqual({ n: 5 });
    expect(chain.calls[0]?.data).toBe(
      encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'echo',
            stateMutability: 'view',
            inputs: [
              { name: 's', type: 'string' },
              { name: 'arr', type: 'uint256[]' },
              { name: 'n', type: 'uint8' },
            ],
            outputs: [],
          },
        ],
        functionName: 'echo',
        args: ['hello', [1n, 2n, 3n], 5],
      }),
    );
  });

  test('failure bubbles the callee revert payload verbatim (incl. empty)', () => {
    const errorPayload: Hex = `0x08c379a0${'ab'.repeat(64)}`; // shape is irrelevant — verbatim
    expect(
      revertData(
        interpret(
          callScript,
          [TOKEN, OWNER],
          chainOf(() => ({ success: false, data: errorPayload })),
        ),
      ),
    ).toBe(errorPayload);
    expect(
      revertData(
        interpret(
          callScript,
          [TOKEN, OWNER],
          chainOf(() => ({ success: false, data: '0x' })),
        ),
      ),
    ).toBe('0x');
  });

  test('gas operand is evaluated and tolerated', () => {
    const script = ir({
      name: 'gascap',
      args: [
        { name: 'token', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'gas', type: 'uint256' },
      ],
      values: [vi('address'), vi('address'), vi('uint256'), vi('uint256')],
      body: [
        mk({
          k: 'call',
          target: 0,
          fnAbi: balanceOfAbi,
          args: [1],
          outs: [3],
          mode: 'strict',
          gas: 2,
        }),
      ],
      returns: [{ name: 'bal', type: 'uint256', value: 3 }],
    });
    const chain = chainOf(() => ({
      success: true,
      data: encodeAbiParameters([{ type: 'uint256' }], [9n]),
    }));
    expect(retOf(interpret(script, [TOKEN, OWNER, 50_000n], chain))).toEqual({ bal: 9n });
  });
});

describe('call — word output normalization (normalize-don’t-revert)', () => {
  test('dirty high/low bits are masked / sign-extended / booleanized', () => {
    const dirtyAbi = fnAbi(
      'dirty',
      [],
      [
        { name: 'a', type: 'uint8' },
        { name: 'b', type: 'bool' },
        { name: 'c', type: 'address' },
        { name: 'd', type: 'int8' },
        { name: 'e', type: 'bytes4' },
      ],
    );
    const script = ir({
      name: 'norm',
      args: [{ name: 'target', type: 'address' }],
      values: [vi('address'), vi('uint8'), vi('bool'), vi('address'), vi('int8'), vi('bytes4')],
      body: [
        mk({
          k: 'call',
          target: 0,
          fnAbi: dirtyAbi,
          args: [],
          outs: [1, 2, 3, 4, 5],
          mode: 'strict',
        }),
      ],
      returns: [
        { name: 'a', type: 'uint8', value: 1 },
        { name: 'b', type: 'bool', value: 2 },
        { name: 'c', type: 'address', value: 3 },
        { name: 'd', type: 'int8', value: 4 },
        { name: 'e', type: 'bytes4', value: 5 },
      ],
    });
    const returndata: Hex = `0x${[
      wordHex(0x1ffn).slice(2), // uint8 ← masked to 0xff
      wordHex(2n).slice(2), // bool ← ISZERO ISZERO ⇒ true
      wordHex(2n ** 160n + 5n).slice(2), // address ← high 96 bits masked
      wordHex(0x80n).slice(2), // int8 ← SIGNEXTEND ⇒ −128
      `deadbeef${'ff'.repeat(28)}`, // bytes4 ← lane-masked to 0xdeadbeef
    ].join('')}`;
    const res = interpret(
      script,
      [TOKEN],
      chainOf(() => ({ success: true, data: returndata })),
    );
    expect(retOf(res)).toEqual({
      a: 255,
      b: true,
      c: '0x0000000000000000000000000000000000000005',
      d: -128,
      e: '0xdeadbeef',
    });
  });

  test('array outputs are normalized eagerly per element', () => {
    const listAbi = fnAbi('list', [], [{ name: '', type: 'uint8[]' }]);
    const script = ir({
      name: 'arrnorm',
      args: [{ name: 'target', type: 'address' }],
      values: [vi('address'), vi('uint8[]')],
      body: [mk({ k: 'call', target: 0, fnAbi: listAbi, args: [], outs: [1], mode: 'strict' })],
      returns: [{ name: 'xs', type: 'uint8[]', value: 1 }],
    });
    const returndata: Hex = `0x${[
      wordHex(0x20n).slice(2),
      wordHex(2n).slice(2),
      wordHex(0x1ffn).slice(2),
      wordHex(0xaa00n).slice(2),
    ].join('')}`;
    const res = interpret(
      script,
      [TOKEN],
      chainOf(() => ({ success: true, data: returndata })),
    );
    expect(retOf(res)).toEqual({ xs: [255, 0] });
  });

  test('dynamic string output decodes; non-UTF-8 payload survives byte-exactly in returndata', () => {
    const symbolAbi = fnAbi('symbol', [], [{ name: '', type: 'string' }]);
    const script = ir({
      name: 'sym',
      args: [{ name: 'target', type: 'address' }],
      values: [vi('address'), vi('string')],
      body: [mk({ k: 'call', target: 0, fnAbi: symbolAbi, args: [], outs: [1], mode: 'strict' })],
      returns: [{ name: 's', type: 'string', value: 1 }],
    });
    const weth = encodeAbiParameters([{ type: 'string' }], ['WETH']);
    const res = interpret(
      script,
      [TOKEN],
      chainOf(() => ({ success: true, data: weth })),
    );
    expect(retOf(res)).toEqual({ s: 'WETH' });
    expect(returnData(res)).toBe(
      encodeAbiParameters(
        [{ type: 'tuple', components: [{ name: 's', type: 'string' }] }],
        [{ s: 'WETH' }],
      ),
    );

    // raw 0xff byte in a "string": invalid UTF-8 must round-trip into the returndata untouched
    const raw: Hex = `0x${wordHex(0x20n).slice(2)}${wordHex(1n).slice(2)}ff${'00'.repeat(31)}`;
    const res2 = interpret(
      script,
      [TOKEN],
      chainOf(() => ({ success: true, data: raw })),
    );
    const data2 = returnData(res2);
    // [0x20 tuple offset][0x20 component offset][len 1][0xff…]
    expect(data2.slice(2 + 64 * 3, 2 + 64 * 3 + 2)).toBe('ff');
  });
});

describe('call — decode failure sites (§7.2 bounds)', () => {
  function strictDynScript(outType: EvsType, site: number): ScriptIr {
    const abi = fnAbi('get', [], [{ name: '', type: outType }]);
    return ir({
      name: 'bounds',
      args: [{ name: 'target', type: 'address' }],
      values: [vi('address'), vi(outType)],
      body: [mk({ k: 'call', target: 0, fnAbi: abi, args: [], outs: [1], mode: 'strict' }, site)],
      returns: [{ name: 'r', type: outType, value: 1 }],
    });
  }
  const run = (outType: EvsType, data: Hex, site = 9): InterpResult =>
    interpret(
      strictDynScript(outType, site),
      [TOKEN],
      chainOf(() => ({ success: true, data })),
    );

  test('rds < 32·nOutputs (staticMinSize guard) → EvsDecodeError(site)', () => {
    expect(revertData(run('uint256', '0x'))).toBe(decodeErrHex(9));
    expect(revertData(run('uint256', `0x${'00'.repeat(31)}`))).toBe(decodeErrHex(9));
    expect(revertData(run('string', '0x', 12))).toBe(decodeErrHex(12));
  });

  test('head offset > 2^64−1 → EvsDecodeError(site)', () => {
    expect(revertData(run('string', wordHex(2n ** 64n)))).toBe(decodeErrHex(9));
  });

  test('off + 32 > rds → EvsDecodeError(site)', () => {
    expect(revertData(run('string', wordHex(0x20n)))).toBe(decodeErrHex(9)); // head only
  });

  test('len > 2^64−1 → EvsDecodeError(site)', () => {
    const data: Hex = `0x${wordHex(0x20n).slice(2)}${wordHex(2n ** 64n).slice(2)}`;
    expect(revertData(run('bytes', data))).toBe(decodeErrHex(9));
  });

  test('off-by-one truncated tail → EvsDecodeError(site)', () => {
    // declares len 32 but ships 31 payload bytes
    const data: Hex = `0x${wordHex(0x20n).slice(2)}${wordHex(32n).slice(2)}${'aa'.repeat(31)}`;
    expect(revertData(run('bytes', data))).toBe(decodeErrHex(9));
    // exact fit is accepted
    const ok: Hex = `0x${wordHex(0x20n).slice(2)}${wordHex(32n).slice(2)}${'aa'.repeat(32)}`;
    expect(retOf(run('bytes', ok))).toEqual({ r: `0x${'aa'.repeat(32)}` });
  });

  test('array tail bounds use 32·len → EvsDecodeError(site)', () => {
    const data: Hex = `0x${wordHex(0x20n).slice(2)}${wordHex(2n).slice(2)}${wordHex(1n).slice(2)}`;
    expect(revertData(run('uint256[]', data))).toBe(decodeErrHex(9));
  });

  test('the failing call’s own site id is reported', () => {
    const abi = fnAbi('get', [], [{ name: '', type: 'uint256' }]);
    const script = ir({
      name: 'sites',
      args: [{ name: 'target', type: 'address' }],
      values: [vi('address'), vi('uint256'), vi('uint256')],
      body: [
        mk({ k: 'call', target: 0, fnAbi: abi, args: [], outs: [1], mode: 'strict' }, 3),
        mk({ k: 'call', target: 0, fnAbi: abi, args: [], outs: [2], mode: 'strict' }, 4),
      ],
      returns: [{ name: 'r', type: 'uint256', value: 2 }],
    });
    let n = 0;
    const chain = chainOf(() => {
      n += 1;
      return n === 1
        ? { success: true, data: encodeAbiParameters([{ type: 'uint256' }], [1n]) }
        : { success: true, data: '0x' }; // second call: malformed
    });
    expect(revertData(interpret(script, [TOKEN], chain))).toBe(decodeErrHex(4));
  });
});

describe('tryCall — zeroing', () => {
  const tryAbi = fnAbi(
    'meta',
    [],
    [
      { name: 'n', type: 'uint256' },
      { name: 's', type: 'string' },
      { name: 'xs', type: 'uint8[]' },
    ],
  );
  const tryScript = ir({
    name: 'try1',
    args: [{ name: 'target', type: 'address' }],
    values: [vi('address'), vi('uint256'), vi('string'), vi('uint8[]'), vi('bool')],
    body: [
      mk({
        k: 'call',
        target: 0,
        fnAbi: tryAbi,
        args: [],
        outs: [1, 2, 3],
        mode: 'try',
        successOut: 4,
      }),
    ],
    returns: [
      { name: 'ok', type: 'bool', value: 4 },
      { name: 'n', type: 'uint256', value: 1 },
      { name: 's', type: 'string', value: 2 },
      { name: 'xs', type: 'uint8[]', value: 3 },
    ],
  });

  test('call failure → success=false, zero words, empty memrefs', () => {
    const res = interpret(
      tryScript,
      [TOKEN],
      chainOf(() => ({ success: false, data: '0xdead' })),
    );
    expect(retOf(res)).toEqual({ ok: false, n: 0n, s: '', xs: [] });
  });

  test('malformed returndata → success=false, same zeroing (never a revert)', () => {
    const res = interpret(
      tryScript,
      [TOKEN],
      chainOf(() => ({ success: true, data: '0x' })),
    );
    expect(retOf(res)).toEqual({ ok: false, n: 0n, s: '', xs: [] });
    const truncated: Hex = `0x${wordHex(0x60n).slice(2)}${wordHex(0xa0n).slice(2)}${wordHex(2n ** 65n).slice(2)}`;
    const res2 = interpret(
      tryScript,
      [TOKEN],
      chainOf(() => ({ success: true, data: truncated })),
    );
    expect(retOf(res2)).toEqual({ ok: false, n: 0n, s: '', xs: [] });
  });

  test('success → success=true with decoded values', () => {
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'string' }, { type: 'uint8[]' }],
      [5n, 'ok', [1, 2]],
    );
    const res = interpret(
      tryScript,
      [TOKEN],
      chainOf(() => ({ success: true, data })),
    );
    expect(retOf(res)).toEqual({ ok: true, n: 5n, s: 'ok', xs: [1, 2] });
  });
});

// ---------------------------------------------------------------------------
// maxSteps guard + trace + host-misuse errors
// ---------------------------------------------------------------------------

describe('maxSteps + trace', () => {
  /** while(true) with an empty header and body — zero statements per iteration. */
  const infinite = ir({
    name: 'spin',
    values: [vi('bool')],
    body: [
      mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(1n) }, type: 'bool' }),
      mk({ k: 'while', header: [], cond: 0, body: [] }),
    ],
    returns: [{ name: 'r', type: 'bool', value: 0 }],
  });

  test('unbounded loops hit the step budget → EvsCompileError(COMPILE_LIMIT)', () => {
    expect(() => interpret(infinite, [], deadChain, { maxSteps: 1000 })).toThrowError(
      EvsCompileError,
    );
    expect(() => interpret(infinite, [], deadChain, { maxSteps: 1000 })).toThrowError(
      /exceeded maxSteps = 1000/,
    );
    expect(() => interpret(infinite, [], deadChain)).toThrowError(/maxSteps = 1000000/);
  });

  test('a finite script under a tight budget throws; with budget it succeeds', () => {
    const script = ir({
      name: 'tiny',
      values: [vi('uint256'), vi('uint256')],
      body: [
        mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint256' }),
        mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 1 }),
      ],
      returns: [{ name: 'r', type: 'uint256', value: 1 }],
    });
    expect(() => interpret(script, [], deadChain, { maxSteps: 1 })).toThrowError(EvsCompileError);
    expect(retOf(interpret(script, [], deadChain, { maxSteps: 2 }))).toEqual({ r: 2n });
  });

  test('invalid maxSteps → EvsTypeError', () => {
    expect(() => interpret(infinite, [], deadChain, { maxSteps: 0 })).toThrowError(EvsTypeError);
    expect(() => interpret(infinite, [], deadChain, { maxSteps: 1.5 })).toThrowError(EvsTypeError);
  });

  test('trace is opt-in and follows the walkStmts path convention', () => {
    const valid = ir({
      name: 'traced',
      args: [{ name: 'c', type: 'bool' }],
      values: [vi('bool'), vi('uint256'), vi('uint256')],
      cells: [{ type: 'uint256', loc: null }],
      body: [
        mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint256' }),
        mk({ k: 'cellnew', cell: 0, init: 1 }),
        mk({
          k: 'if',
          cond: 0,
          then: [mk({ k: 'cellset', cell: 0, value: 1 })],
          else: [],
        }),
        mk({ k: 'cellget', cell: 0, out: 2 }),
      ],
      returns: [{ name: 'r', type: 'uint256', value: 2 }],
    });
    const plain = interpret(valid, [true], deadChain);
    expect(plain.trace).toBeUndefined();
    const traced = interpret(valid, [true], deadChain, { trace: true });
    expect(traced.trace).toBeDefined();
    const paths = (traced.trace ?? []).map((t) => t.stmtPath.join('.'));
    expect(paths).toEqual(['0', '1', '2', '2.0.0', '3']);
    const notes = (traced.trace ?? []).map((t) => t.note);
    expect(notes).toEqual(['const uint256', 'cellnew #0', 'if', 'cellset #0', 'cellget #0']);
    expect((traced.trace ?? [])[0]?.loc).toEqual(LOC);
  });

  test('fn-body trace entries are prefixed with the fn name', () => {
    const script = ir({
      name: 'fntrace',
      args: [{ name: 'x', type: 'uint256' }],
      values: [vi('uint256'), vi('uint256', 'p'), vi('uint256'), vi('uint256')],
      fns: [
        {
          name: 'double',
          params: [{ name: 'p', type: 'uint256', value: 1 }],
          results: [{ type: 'uint256' }],
          body: [mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 })],
          resultValues: [2],
          loc: null,
        },
      ],
      body: [mk({ k: 'fncall', fn: 0, args: [0], outs: [3] })],
      returns: [{ name: 'r', type: 'uint256', value: 3 }],
    });
    const res = interpret(script, [3n], deadChain, { trace: true });
    const notes = (res.trace ?? []).map((t) => t.note);
    expect(notes).toEqual(['fncall fns[0]', 'fn "double": bin add']);
  });
});

describe('host misuse', () => {
  test('malformed MockChain replies → EvsTypeError', () => {
    const bad: MockChain = {
      staticcall: () => ({ success: true, data: '0xzz' as Hex }),
    };
    expect(() => interpret(callScript, [TOKEN, OWNER], bad)).toThrowError(EvsTypeError);
  });
});

// ---------------------------------------------------------------------------
// a width sweep pinning canonical results across every numeric class
// ---------------------------------------------------------------------------

describe('width sweep — canonical results across classes', () => {
  const cases: readonly { type: NumericType; a: bigint; b: bigint; op: BinOp; r: bigint }[] = [
    { type: 'uint8', op: 'add', a: 1n, b: 2n, r: 3n },
    { type: 'uint64', op: 'mul', a: 2n ** 32n - 1n, b: 2n ** 32n - 1n, r: (2n ** 32n - 1n) ** 2n },
    { type: 'uint128', op: 'sub', a: 2n ** 128n - 1n, b: 1n, r: 2n ** 128n - 2n },
    { type: 'uint192', op: 'div', a: 2n ** 191n, b: 2n, r: 2n ** 190n },
    { type: 'uint256', op: 'mod', a: 2n ** 255n, b: 7n, r: 2n ** 255n % 7n },
    { type: 'int8', op: 'add', a: -100n, b: -28n, r: -128n },
    { type: 'int128', op: 'mul', a: -(2n ** 63n), b: 2n ** 63n, r: -(2n ** 126n) },
    { type: 'int200', op: 'sub', a: -(2n ** 198n), b: 2n ** 198n, r: -(2n ** 199n) },
    { type: 'int256', op: 'div', a: -(2n ** 200n), b: -(2n ** 100n), r: 2n ** 100n },
  ];
  for (const c of cases) {
    test(`${c.type} ${c.op}(${c.a}, ${c.b}) = ${c.r}`, () => {
      expect(asBig(retOf(runBin(c.type, c.op, c.a, c.b)).r)).toBe(c.r);
    });
  }
});
