/* oxlint-disable typescript/no-unsafe-type-assertion --
 * seeded-rejection fixtures deliberately smuggle malformed payloads behind the IR types. */
/* oxlint-disable vitest/expect-expect --
 * most rejection tests assert exclusively through the expectInvalid() helper, which wraps the
 * expect(...).toThrowError(...) pair. */
/* oxlint-disable unicorn/no-thenable --
 * the frozen IR schema (module-interfaces.md §M2) names the if-statement branch field `then`. */
import { describe, expect, test } from 'vitest';

import { EvsInternalError, type SourceLoc } from '../core/errors.js';
import type { EvsType, Hex, WordType } from '../core/types.js';
import { deserializeIr, serializeIr, type ScriptIr, type Stmt, type ValueInfo } from './nodes.js';
import { validateIr } from './validate.js';

// ---------------------------------------------------------------------------
// fixture builders
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
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** [len:32][payload zero-padded to a 32-byte boundary] memref hex. */
function dataHex(payload: string): Hex {
  const len = payload.length / 2;
  const padded = payload.padEnd(Math.ceil(len / 32) * 64, '0');
  return `0x${BigInt(len).toString(16).padStart(64, '0')}${padded}`;
}

const u256Const = (out: number, n: bigint): Stmt =>
  mk({ k: 'const', out, data: { kind: 'word', hex: wordHex(n) }, type: 'uint256' });
const boolConst = (out: number, v: boolean): Stmt =>
  mk({ k: 'const', out, data: { kind: 'word', hex: wordHex(v ? 1n : 0n) }, type: 'bool' });
const strConst = (out: number): Stmt =>
  mk({ k: 'const', out, data: { kind: 'data', hex: dataHex('616263') }, type: 'string' });

function expectInvalid(bad: ScriptIr, msg: RegExp): void {
  expect(() => validateIr(bad)).toThrowError(EvsInternalError);
  expect(() => validateIr(bad)).toThrowError(msg);
}

// ---------------------------------------------------------------------------
// the kitchen-sink ACCEPT fixture — every statement kind, valid end to end
// ---------------------------------------------------------------------------

const KITCHEN_SINK: ScriptIr = ir({
  name: 'kitchen',
  args: [
    { name: 'a', type: 'uint256' },
    { name: 'flag', type: 'bool' },
    { name: 'tokens', type: 'address[]' },
  ],
  values: [
    vi('uint256', 'a'), // v0 (arg)
    vi('bool', 'flag'), // v1 (arg)
    vi('address[]', 'tokens'), // v2 (arg)
    vi('uint256'), // v3 const 5
    vi('uint256'), // v4 add
    vi('bool'), // v5 not
    vi('address'), // v6 env caller
    vi('uint128'), // v7 convert (checked narrowing)
    vi('uint256'), // v8 select
    vi('uint256'), // v9 len
    vi('address'), // v10 index
    vi('uint256[]'), // v11 arrnew
    vi('uint256'), // v12 cellget
    vi('uint256'), // v13 call out
    vi('string'), // v14 tryCall out
    vi('bool'), // v15 tryCall successOut
    vi('bytes'), // v16 const data
    vi('uint256'), // v17 fncall out
    vi('uint256'), // v18 if-then const
    vi('uint256'), // v19 if-else const
    vi('uint256'), // v20 while-header cellget
    vi('bool'), // v21 while cond
    vi('bool'), // v22 eq
    vi('uint256'), // v23 bitand
    vi('uint256'), // v24 shl
    vi('uint256', 'x'), // v25 fn param
    vi('uint256'), // v26 fn body add
  ],
  cells: [{ type: 'uint256', loc: LOC, debugName: 'acc' }],
  fns: [
    {
      name: 'double',
      params: [{ name: 'x', type: 'uint256', value: 25 }],
      results: [{ type: 'uint256' }],
      body: [mk({ k: 'bin', op: 'add', a: 25, b: 25, out: 26 }, 20)],
      resultValues: [26],
      loc: LOC,
    },
  ],
  body: [
    u256Const(3, 5n),
    mk({ k: 'bin', op: 'add', a: 0, b: 3, out: 4 }, 2),
    mk({ k: 'un', op: 'not', a: 1, out: 5 }, 3),
    mk({ k: 'env', op: 'caller', out: 6 }, 4),
    mk({ k: 'convert', a: 4, out: 7 }, 5),
    mk({ k: 'select', cond: 1, a: 4, b: 3, out: 8 }, 6),
    mk({ k: 'len', a: 2, out: 9 }, 7),
    mk({ k: 'index', arr: 2, i: 3, out: 10 }, 8),
    mk({ k: 'arrnew', elem: 'uint256', length: 9, out: 11 }, 9),
    mk({ k: 'arrset', arr: 11, i: 3, value: 4 }, 10),
    mk({ k: 'cellnew', cell: 0, init: 4 }, 11),
    mk({ k: 'cellget', cell: 0, out: 12 }, 12),
    mk({ k: 'cellset', cell: 0, value: 12 }, 13),
    mk(
      {
        k: 'call',
        target: 6,
        fnAbi: {
          name: 'balanceOf',
          selector: '0x70a08231',
          inputs: [{ name: 'owner', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
        args: [10],
        outs: [13],
        mode: 'strict',
        gas: 4,
      },
      14,
    ),
    mk(
      {
        k: 'call',
        target: 10,
        fnAbi: {
          name: 'symbol',
          selector: '0x95d89b41',
          inputs: [],
          outputs: [{ name: '', type: 'string' }],
        },
        args: [],
        outs: [14],
        mode: 'try',
        successOut: 15,
      },
      15,
    ),
    mk({ k: 'const', out: 16, data: { kind: 'data', hex: dataHex('abcdef') }, type: 'bytes' }, 16),
    mk({ k: 'fncall', fn: 0, args: [4], outs: [17] }, 17),
    mk({ k: 'if', cond: 1, then: [u256Const(18, 1n)], else: [u256Const(19, 2n)] }, 18),
    mk(
      {
        k: 'while',
        header: [
          mk({ k: 'cellget', cell: 0, out: 20 }),
          mk({ k: 'bin', op: 'lt', a: 20, b: 4, out: 21 }),
        ],
        cond: 21,
        body: [
          mk({ k: 'cellset', cell: 0, value: 12 }),
          // header value v21 is visible in the body (header dominates body)
          mk({ k: 'if', cond: 21, then: [mk({ k: 'break' })], else: [mk({ k: 'continue' })] }),
        ],
      },
      19,
    ),
    mk({ k: 'bin', op: 'eq', a: 6, b: 10, out: 22 }, 20),
    mk({ k: 'bin', op: 'bitand', a: 4, b: 3, out: 23 }, 21),
    mk({ k: 'bin', op: 'shl', a: 23, b: 3, out: 24 }, 22),
    // custom errors (issue #15): a with-args and a zero-arg throw, guarded by the flag
    mk(
      {
        k: 'if',
        cond: 1,
        then: [mk({ k: 'throw', error: 0, args: [4] })],
        else: [mk({ k: 'throw', error: 1, args: [] })],
      },
      23,
    ),
  ],
  errors: [
    { name: 'NoBalance', selector: '0xa6cccb45', inputs: [{ name: 'balance', type: 'uint256' }] },
    { name: 'NotOwner', selector: '0x30cd7471', inputs: [] },
  ],
  returns: [
    { name: 'sum', type: 'uint256', value: 4 },
    { name: 'sym', type: 'string', value: 14 },
    { name: 'arr', type: 'uint256[]', value: 11 },
  ],
  loc: LOC,
});

describe('validateIr — accepts', () => {
  test('the kitchen-sink IR (every stmt kind) validates', () => {
    expect(() => validateIr(KITCHEN_SINK)).not.toThrow();
  });

  test('a deserialized round trip of the kitchen sink still validates', () => {
    expect(() => validateIr(deserializeIr(serializeIr(KITCHEN_SINK)))).not.toThrow();
  });

  test('an empty script validates', () => {
    expect(() => validateIr(ir({}))).not.toThrow();
  });

  test('a while condition defined before the loop is visible', () => {
    const fixture = ir({
      values: [vi('bool')],
      body: [boolConst(0, false), mk({ k: 'while', header: [], cond: 0, body: [] })],
    });
    expect(() => validateIr(fixture)).not.toThrow();
  });

  test('break in an inner-loop header nested inside an outer loop body is legal', () => {
    const fixture = ir({
      values: [vi('bool')],
      body: [
        boolConst(0, true),
        mk({
          k: 'while',
          header: [],
          cond: 0,
          body: [mk({ k: 'while', header: [mk({ k: 'break' })], cond: 0, body: [] })],
        }),
      ],
    });
    expect(() => validateIr(fixture)).not.toThrow();
  });

  test('bitwise/shift ops accept intN and bytesN operands (architecture §6)', () => {
    const fixture = ir({
      values: [
        vi('int128'),
        vi('int128'),
        vi('bytes32'),
        vi('uint256'),
        vi('bytes32'),
        vi('int128'),
      ],
      body: [
        mk({
          k: 'const',
          out: 0,
          data: { kind: 'word', hex: `0x${'f'.repeat(64)}` },
          type: 'int128',
        }),
        mk({ k: 'un', op: 'bitnot', a: 0, out: 1 }),
        mk({ k: 'const', out: 2, data: { kind: 'word', hex: wordHex(0n) }, type: 'bytes32' }),
        u256Const(3, 4n),
        mk({ k: 'bin', op: 'shr', a: 2, b: 3, out: 4 }),
        mk({ k: 'bin', op: 'bitxor', a: 0, b: 1, out: 5 }),
      ],
    });
    expect(() => validateIr(fixture)).not.toThrow();
  });

  test('canonical word consts of every shape are accepted', () => {
    const cases: readonly [WordType, bigint][] = [
      ['int8', BigInt(`0x${'f'.repeat(64)}`)], // −1 sign-extended
      ['bytes4', 0xdeadbeefn << 224n], // left-aligned
      ['address', (1n << 160n) - 1n],
      ['bool', 1n],
      ['uint8', 255n],
    ];
    for (const [type, value] of cases) {
      const fixture = ir({
        values: [vi(type)],
        body: [mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(value) }, type })],
      });
      expect(() => validateIr(fixture)).not.toThrow();
    }
  });

  test('bytes/string data consts may be tightly sized (no padding) or padded', () => {
    const tight = ir({
      values: [vi('bytes')],
      body: [
        mk({
          k: 'const',
          out: 0,
          data: { kind: 'data', hex: `0x${wordHex(3n).slice(2)}aabbcc` },
          type: 'bytes',
        }),
      ],
    });
    const empty = ir({
      values: [vi('string')],
      body: [mk({ k: 'const', out: 0, data: { kind: 'data', hex: wordHex(0n) }, type: 'string' })],
    });
    expect(() => validateIr(tight)).not.toThrow();
    expect(() => validateIr(empty)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tables: values / cells / args / fn signatures
// ---------------------------------------------------------------------------

describe('validateIr — table rules', () => {
  test('rejects a non-v0 value type', () => {
    expectInvalid(ir({ values: [vi('uint7' as EvsType)] }), /values\[0\].*non-v0/);
  });

  test('rejects a non-v0 cell type', () => {
    expectInvalid(ir({ cells: [{ type: 'tuple' as EvsType, loc: null }] }), /cells\[0\].*non-v0/);
  });

  test('rejects a non-v0 fn param / result type', () => {
    const fn = { name: 'f', params: [], results: [], body: [], resultValues: [], loc: null };
    expectInvalid(
      ir({
        values: [vi('uint256')],
        fns: [{ ...fn, params: [{ name: 'x', type: 'uint256[2]' as EvsType, value: 0 }] }],
      }),
      /fns\[0\]\.params\[0\].*non-v0/,
    );
    expectInvalid(
      ir({ fns: [{ ...fn, results: [{ type: 'tuple' as EvsType }], resultValues: [0] }] }),
      /fns\[0\]\.results\[0\].*non-v0/,
    );
  });

  test('rejects invalid / empty / duplicate arg names', () => {
    expectInvalid(
      ir({ args: [{ name: '', type: 'uint256' }], values: [vi('uint256')] }),
      /args\[0\] has an invalid name/,
    );
    expectInvalid(
      ir({ args: [{ name: 'foo-bar', type: 'uint256' }], values: [vi('uint256')] }),
      /invalid name/,
    );
    expectInvalid(
      ir({
        args: [
          { name: 'a', type: 'uint256' },
          { name: 'a', type: 'bool' },
        ],
        values: [vi('uint256'), vi('bool')],
      }),
      /duplicate arg name "a"/,
    );
  });

  test('rejects a non-v0 arg type', () => {
    expectInvalid(
      ir({ args: [{ name: 'a', type: 'uint7' as EvsType }], values: [vi('uint256')] }),
      /args\[0\].*non-v0/,
    );
  });

  test('rejects args without a positional backing value (ValueIds 0…n−1)', () => {
    expectInvalid(ir({ args: [{ name: 'a', type: 'uint256' }] }), /no backing value/);
  });

  test('rejects an arg whose backing value has a different type', () => {
    expectInvalid(
      ir({ args: [{ name: 'a', type: 'uint256' }], values: [vi('bool')] }),
      /declared 'uint256' but its backing values\[0\] is 'bool'/,
    );
  });
});

// ---------------------------------------------------------------------------
// const — kind / hex shape / canonical word invariant
// ---------------------------------------------------------------------------

describe('validateIr — const rules', () => {
  function constIr(
    type: EvsType,
    data: { kind: 'word' | 'data'; hex: string },
    outType = type,
  ): ScriptIr {
    return ir({
      values: [vi(outType)],
      body: [
        mk({
          k: 'const',
          out: 0,
          data: data as Stmt extends never ? never : { kind: 'word'; hex: Hex },
          type,
        }),
      ],
    });
  }

  test('rejects a const whose declared type differs from its out value', () => {
    expectInvalid(
      constIr('uint256', { kind: 'word', hex: wordHex(1n) }, 'bool'),
      /declared 'bool' but the statement produces 'uint256'/,
    );
  });

  test("rejects kind 'word' for dynamic types and kind 'data' for word types", () => {
    expectInvalid(constIr('bytes', { kind: 'word', hex: wordHex(0n) }), /must carry kind 'data'/);
    expectInvalid(constIr('uint256', { kind: 'data', hex: wordHex(0n) }), /must carry kind 'word'/);
  });

  test('rejects word consts that are not exactly 32 bytes', () => {
    expectInvalid(
      constIr('uint256', { kind: 'word', hex: `0x${'00'.repeat(31)}` }),
      /exactly 32 bytes/,
    );
    expectInvalid(
      constIr('uint256', { kind: 'word', hex: `0x${'00'.repeat(33)}` }),
      /exactly 32 bytes/,
    );
    expectInvalid(
      constIr('uint256', { kind: 'word', hex: `0x${'zz'.repeat(32)}` }),
      /exactly 32 bytes/,
    );
  });

  test('rejects non-canonical words per type', () => {
    expectInvalid(
      constIr('uint8', { kind: 'word', hex: wordHex(256n) }),
      /not a canonical 'uint8'/,
    );
    expectInvalid(constIr('bool', { kind: 'word', hex: wordHex(2n) }), /not a canonical 'bool'/);
    // int8 −128 must be sign-extended; a bare 0x…80 is not canonical
    expectInvalid(constIr('int8', { kind: 'word', hex: wordHex(0x80n) }), /not a canonical 'int8'/);
    // bytes4 is left-aligned; a right-aligned value is not canonical
    expectInvalid(
      constIr('bytes4', { kind: 'word', hex: wordHex(1n) }),
      /not a canonical 'bytes4'/,
    );
    expectInvalid(
      constIr('address', { kind: 'word', hex: wordHex(1n << 160n) }),
      /not a canonical 'address'/,
    );
  });

  test('rejects data consts shorter than the 32-byte length word', () => {
    expectInvalid(constIr('bytes', { kind: 'data', hex: '0x00' }), /32-byte length word/);
  });

  test('rejects malformed data const hex', () => {
    expectInvalid(constIr('bytes', { kind: 'data', hex: `0x${'g'.repeat(64)}` }), /malformed/);
  });

  test('rejects array data consts whose payload disagrees with len', () => {
    // len = 2 but a single element word follows
    expectInvalid(
      constIr('uint256[]', {
        kind: 'data',
        hex: `0x${wordHex(2n).slice(2)}${wordHex(1n).slice(2)}`,
      }),
      /array memref payload/,
    );
  });

  test('rejects array data consts with non-canonical elements', () => {
    expectInvalid(
      constIr('address[]', {
        kind: 'data',
        hex: `0x${wordHex(1n).slice(2)}${wordHex(1n << 200n).slice(2)}`,
      }),
      /element 0 is not a canonical 'address'/,
    );
  });

  test('rejects bytes/string data consts with inconsistent declared length', () => {
    // declared len 40 but only 32 payload bytes present
    expectInvalid(
      constIr('bytes', { kind: 'data', hex: `0x${wordHex(40n).slice(2)}${'00'.repeat(32)}` }),
      /memref payload/,
    );
    // declared len 3 but 64 payload bytes (beyond the 32-byte ceil boundary)
    expectInvalid(
      constIr('bytes', { kind: 'data', hex: `0x${wordHex(3n).slice(2)}${'00'.repeat(64)}` }),
      /memref payload/,
    );
  });
});

// ---------------------------------------------------------------------------
// bin / un / env op table
// ---------------------------------------------------------------------------

describe('validateIr — bin/un/env op table', () => {
  test('rejects arithmetic on non-numeric operands', () => {
    expectInvalid(
      ir({
        values: [vi('bool'), vi('bool'), vi('bool')],
        body: [
          boolConst(0, true),
          boolConst(1, false),
          mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 }),
        ],
      }),
      /operands must be numeric/,
    );
  });

  test('rejects mixed operand widths', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint8'), vi('uint256')],
        body: [
          u256Const(0, 1n),
          mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint8' }),
          mk({ k: 'bin', op: 'add', a: 0, b: 1, out: 2 }),
        ],
      }),
      /operand type mismatch/,
    );
  });

  test('rejects an arithmetic out whose declared type differs from the operands', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bool')],
        body: [u256Const(0, 1n), mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 1 })],
      }),
      /produces 'uint256'/,
    );
  });

  test('rejects a comparison out that is not bool', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256')],
        body: [u256Const(0, 1n), mk({ k: 'bin', op: 'lt', a: 0, b: 0, out: 1 })],
      }),
      /produces 'bool'/,
    );
  });

  test('rejects eq/neq on memref (dynamic) operands', () => {
    expectInvalid(
      ir({
        values: [vi('string'), vi('bool')],
        body: [strConst(0), mk({ k: 'bin', op: 'eq', a: 0, b: 0, out: 1 })],
      }),
      /word-type-only/,
    );
  });

  test('rejects and/or on non-bool operands', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bool')],
        body: [u256Const(0, 1n), mk({ k: 'bin', op: 'and', a: 0, b: 0, out: 1 })],
      }),
      /operand type mismatch/,
    );
  });

  test('rejects bitwise ops on address/bool operands', () => {
    expectInvalid(
      ir({
        values: [vi('address'), vi('address')],
        body: [
          mk({ k: 'env', op: 'caller', out: 0 }),
          mk({ k: 'bin', op: 'bitand', a: 0, b: 0, out: 1 }),
        ],
      }),
      /must be uintN\/intN\/bytesN/,
    );
    expectInvalid(
      ir({
        values: [vi('bool'), vi('bool')],
        body: [boolConst(0, true), mk({ k: 'bin', op: 'bitor', a: 0, b: 0, out: 1 })],
      }),
      /must be uintN\/intN\/bytesN/,
    );
  });

  test('rejects a shift amount that is not uint256', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint8'), vi('uint256')],
        body: [
          u256Const(0, 1n),
          mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(1n) }, type: 'uint8' }),
          mk({ k: 'bin', op: 'shl', a: 0, b: 1, out: 2 }),
        ],
      }),
      /shift amount.*expected 'uint256'/,
    );
  });

  test('rejects unknown ValueIds and forward references', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256')],
        body: [u256Const(0, 1n), mk({ k: 'bin', op: 'add', a: 0, b: 99, out: 1 })],
      }),
      /unknown ValueId 99/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256')],
        body: [mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 1 }), u256Const(0, 1n)],
      }),
      /used before it is defined/,
    );
  });

  test('rejects un ops on the wrong operand domain', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bool')],
        body: [u256Const(0, 1n), mk({ k: 'un', op: 'not', a: 0, out: 1 })],
      }),
      /operand type mismatch/,
    );
    expectInvalid(
      ir({
        values: [vi('bool'), vi('bool')],
        body: [boolConst(0, true), mk({ k: 'un', op: 'bitnot', a: 0, out: 1 })],
      }),
      /must be uintN\/intN\/bytesN/,
    );
    expectInvalid(
      ir({
        values: [vi('string'), vi('bool')],
        body: [strConst(0), mk({ k: 'un', op: 'iszero', a: 0, out: 1 })],
      }),
      /must be a word type/,
    );
  });

  test('rejects env outs with the wrong type', () => {
    expectInvalid(
      ir({ values: [vi('uint256')], body: [mk({ k: 'env', op: 'caller', out: 0 })] }),
      /produces 'address'/,
    );
    expectInvalid(
      ir({ values: [vi('address')], body: [mk({ k: 'env', op: 'timestamp', out: 0 })] }),
      /produces 'uint256'/,
    );
  });
});

// ---------------------------------------------------------------------------
// convert table
// ---------------------------------------------------------------------------

describe('validateIr — convert table', () => {
  function convertIr(from: EvsType, to: EvsType): ScriptIr {
    const def: Stmt =
      typeof from !== 'string' || from === 'string' || from === 'bytes' || from.endsWith('[]')
        ? mk({ k: 'const', out: 0, data: { kind: 'data', hex: wordHex(0n) }, type: from })
        : mk({ k: 'const', out: 0, data: { kind: 'word', hex: wordHex(0n) }, type: from });
    return ir({ values: [vi(from), vi(to)], body: [def, mk({ k: 'convert', a: 0, out: 1 })] });
  }

  const ACCEPTED: readonly [EvsType, EvsType][] = [
    ['uint256', 'uint8'], // checked narrowing
    ['uint8', 'uint16'], // free widening
    ['int8', 'int256'],
    ['int256', 'int8'],
    ['uint8', 'int16'], // cross-sign numeric
    ['uint256', 'address'], // asAddress
    ['bytes32', 'address'], // asAddress
    ['bytes32', 'uint256'], // reinterpret
    ['uint256', 'bytes32'], // reinterpret
  ];
  test.each(ACCEPTED)('accepts %s → %s', (from, to) => {
    expect(() => validateIr(convertIr(from, to))).not.toThrow();
  });

  const REJECTED: readonly [EvsType, EvsType][] = [
    ['string', 'uint256'],
    ['uint256', 'string'],
    ['address', 'uint256'],
    ['bytes16', 'uint128'],
    ['bool', 'uint8'],
    ['address[]', 'uint256'],
    ['bytes32', 'bytes4'],
  ];
  test.each(REJECTED)('rejects %s → %s', (from, to) => {
    expectInvalid(convertIr(from, to), /no v0 conversion/);
  });
});

// ---------------------------------------------------------------------------
// select / index / len / arrnew / arrset
// ---------------------------------------------------------------------------

describe('validateIr — select/index/len/array rules', () => {
  const arrConst = (out: number): Stmt =>
    mk({ k: 'const', out, data: { kind: 'data', hex: wordHex(0n) }, type: 'uint256[]' });

  test('select: cond must be bool, branches and out must agree', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256')],
        body: [u256Const(0, 1n), mk({ k: 'select', cond: 0, a: 0, b: 0, out: 1 })],
      }),
      /operand type mismatch/,
    );
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256'), vi('uint256')],
        body: [
          boolConst(0, true),
          u256Const(1, 1n),
          mk({ k: 'select', cond: 0, a: 1, b: 0, out: 2 }),
        ],
      }),
      /operand type mismatch/,
    );
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256'), vi('bool')],
        body: [
          boolConst(0, true),
          u256Const(1, 1n),
          mk({ k: 'select', cond: 0, a: 1, b: 1, out: 2 }),
        ],
      }),
      /produces 'uint256'/,
    );
  });

  test('index: operand must be an array, i must be uint256, out must be the element type', () => {
    expectInvalid(
      ir({
        values: [vi('string'), vi('uint256'), vi('uint256')],
        body: [strConst(0), u256Const(1, 0n), mk({ k: 'index', arr: 0, i: 1, out: 2 })],
      }),
      /must be a T\[\] array/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256[]'), vi('uint8'), vi('uint256')],
        body: [
          arrConst(0),
          mk({ k: 'const', out: 1, data: { kind: 'word', hex: wordHex(0n) }, type: 'uint8' }),
          mk({ k: 'index', arr: 0, i: 1, out: 2 }),
        ],
      }),
      /operand type mismatch/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256[]'), vi('uint256'), vi('address')],
        body: [arrConst(0), u256Const(1, 0n), mk({ k: 'index', arr: 0, i: 1, out: 2 })],
      }),
      /produces 'uint256'/,
    );
  });

  test('len: operand must be dynamic, out must be uint256', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256')],
        body: [u256Const(0, 1n), mk({ k: 'len', a: 0, out: 1 })],
      }),
      /must be string\/bytes\/T\[\]/,
    );
    expectInvalid(
      ir({
        values: [vi('string'), vi('address')],
        body: [strConst(0), mk({ k: 'len', a: 0, out: 1 })],
      }),
      /produces 'uint256'/,
    );
  });

  test('arrnew: element admits word|string|bytes|one-level T[]|tuple, length uint256, out the matching array type', () => {
    // a fixed-size element (`uint256[2]`) is still rejected (deferred shape) by checkElemType.
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256[]')],
        body: [
          u256Const(0, 1n),
          mk({ k: 'arrnew', elem: 'uint256[2]' as WordType, length: 0, out: 1 }),
        ],
      }),
      /not supported/,
    );
    // a string array nested deeper than one level (`uint256[][]` element → `uint256[][][]`) rejected.
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256[]')],
        body: [
          u256Const(0, 1n),
          mk({ k: 'arrnew', elem: 'uint256[][]' as WordType, length: 0, out: 1 }),
        ],
      }),
      /nests deeper than one level/,
    );
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256[]')],
        body: [boolConst(0, true), mk({ k: 'arrnew', elem: 'uint256', length: 0, out: 1 })],
      }),
      /operand type mismatch/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('address[]')],
        body: [u256Const(0, 1n), mk({ k: 'arrnew', elem: 'uint256', length: 0, out: 1 })],
      }),
      /produces 'uint256\[\]'/,
    );
  });

  test('arrset: operand must be an array and the value must match the element type', () => {
    expectInvalid(
      ir({
        values: [vi('string'), vi('uint256')],
        body: [strConst(0), u256Const(1, 0n), mk({ k: 'arrset', arr: 0, i: 1, value: 1 })],
      }),
      /must be a T\[\] array/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256[]'), vi('uint256'), vi('bool')],
        body: [
          arrConst(0),
          u256Const(1, 0n),
          boolConst(2, true),
          mk({ k: 'arrset', arr: 0, i: 1, value: 2 }),
        ],
      }),
      /operand type mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// encode / keccak256 (issue #17)
// ---------------------------------------------------------------------------

describe('validateIr — encode/keccak256 rules', () => {
  const struct = { type: 'tuple', components: [{ name: 'x', type: 'uint256' }] } as const;

  test('accepts abi encode over words, dynamics, arrays, and tuples', () => {
    const fixture = ir({
      args: [
        { name: 'a', type: 'uint8' },
        { name: 's', type: 'string' },
        { name: 'arr', type: 'uint256[]' },
        { name: 'st', type: struct },
        { name: 'nested', type: 'uint256[][]' },
      ],
      values: [
        vi('uint8'),
        vi('string'),
        vi('uint256[]'),
        vi(struct),
        vi('uint256[][]'),
        vi('bytes'),
      ],
      body: [mk({ k: 'encode', mode: 'abi', args: [0, 1, 2, 3, 4], out: 5 })],
      returns: [{ name: 'out', type: 'bytes', value: 5 }],
    });
    expect(() => validateIr(fixture)).not.toThrow();
  });

  test('accepts packed encode over words, string/bytes, and word-element arrays', () => {
    const fixture = ir({
      args: [
        { name: 'a', type: 'int64' },
        { name: 'b', type: 'bytes' },
        { name: 'arr', type: 'address[]' },
      ],
      values: [vi('int64'), vi('bytes'), vi('address[]'), vi('bytes')],
      body: [mk({ k: 'encode', mode: 'packed', args: [0, 1, 2], out: 3 })],
      returns: [{ name: 'out', type: 'bytes', value: 3 }],
    });
    expect(() => validateIr(fixture)).not.toThrow();
  });

  test('accepts keccak256 over bytes and string operands', () => {
    const fixture = ir({
      args: [
        { name: 'b', type: 'bytes' },
        { name: 's', type: 'string' },
      ],
      values: [vi('bytes'), vi('string'), vi('bytes32'), vi('bytes32')],
      body: [mk({ k: 'keccak256', a: 0, out: 2 }), mk({ k: 'keccak256', a: 1, out: 3 }, 1)],
      returns: [{ name: 'h', type: 'bytes32', value: 2 }],
    });
    expect(() => validateIr(fixture)).not.toThrow();
  });

  test('rejects an empty encode arg list', () => {
    expectInvalid(
      ir({ values: [vi('bytes')], body: [mk({ k: 'encode', mode: 'abi', args: [], out: 0 })] }),
      /at least one value/,
    );
  });

  test('rejects packed encode over tuples, nested arrays, and string arrays', () => {
    const packedOver = (type: EvsType): ScriptIr =>
      ir({
        args: [{ name: 'v', type }],
        values: [vi(type), vi('bytes')],
        body: [mk({ k: 'encode', mode: 'packed', args: [0], out: 1 })],
      });
    expectInvalid(packedOver(struct), /cannot be packed-encoded/);
    expectInvalid(packedOver('uint256[][]'), /cannot be packed-encoded/);
    expectInvalid(packedOver('string[]'), /cannot be packed-encoded/);
  });

  test('rejects a non-bytes encode out value', () => {
    expectInvalid(
      ir({
        args: [{ name: 'x', type: 'uint256' }],
        values: [vi('uint256'), vi('uint256')],
        body: [mk({ k: 'encode', mode: 'abi', args: [0], out: 1 })],
      }),
      /declared 'uint256' but the statement produces 'bytes'/,
    );
  });

  test('rejects a keccak256 word operand and a non-bytes32 out', () => {
    expectInvalid(
      ir({
        args: [{ name: 'x', type: 'uint256' }],
        values: [vi('uint256'), vi('bytes32')],
        body: [mk({ k: 'keccak256', a: 0, out: 1 })],
      }),
      /operand must be bytes\/string/,
    );
    expectInvalid(
      ir({
        args: [{ name: 'b', type: 'bytes' }],
        values: [vi('bytes'), vi('uint256')],
        body: [mk({ k: 'keccak256', a: 0, out: 1 })],
      }),
      /declared 'uint256' but the statement produces 'bytes32'/,
    );
  });

  test('rejects encode args used before definition', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bytes')],
        body: [mk({ k: 'encode', mode: 'abi', args: [0], out: 1 })],
      }),
      /used before it is defined/,
    );
  });
});

// ---------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------

describe('validateIr — cell rules', () => {
  test('rejects unknown CellIds', () => {
    expectInvalid(
      ir({
        values: [vi('uint256')],
        body: [u256Const(0, 1n), mk({ k: 'cellnew', cell: 5, init: 0 })],
      }),
      /unknown CellId 5/,
    );
    expectInvalid(
      ir({ values: [vi('uint256')], body: [mk({ k: 'cellget', cell: 0, out: 0 })] }),
      /unknown CellId 0/,
    );
  });

  test('rejects a cellnew init type mismatch', () => {
    expectInvalid(
      ir({
        values: [vi('bool')],
        cells: [{ type: 'uint256', loc: null }],
        body: [boolConst(0, true), mk({ k: 'cellnew', cell: 0, init: 0 })],
      }),
      /operand type mismatch/,
    );
  });

  test('rejects a duplicate cellnew', () => {
    expectInvalid(
      ir({
        values: [vi('uint256')],
        cells: [{ type: 'uint256', loc: null }],
        body: [
          u256Const(0, 1n),
          mk({ k: 'cellnew', cell: 0, init: 0 }),
          mk({ k: 'cellnew', cell: 0, init: 0 }),
        ],
      }),
      /more than once/,
    );
  });

  test('rejects cellget/cellset before cellnew', () => {
    expectInvalid(
      ir({
        values: [vi('uint256')],
        cells: [{ type: 'uint256', loc: null }],
        body: [mk({ k: 'cellget', cell: 0, out: 0 })],
      }),
      /before its cellnew/,
    );
  });

  test('rejects cellget/cellset type mismatches', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bool')],
        cells: [{ type: 'uint256', loc: null }],
        body: [
          u256Const(0, 1n),
          mk({ k: 'cellnew', cell: 0, init: 0 }),
          mk({ k: 'cellget', cell: 0, out: 1 }),
        ],
      }),
      /produces 'uint256'/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bool')],
        cells: [{ type: 'uint256', loc: null }],
        body: [
          u256Const(0, 1n),
          boolConst(1, true),
          mk({ k: 'cellnew', cell: 0, init: 0 }),
          mk({ k: 'cellset', cell: 0, value: 1 }),
        ],
      }),
      /operand type mismatch/,
    );
  });

  test('rejects use of a cell outside its defining scope', () => {
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256'), vi('uint256')],
        cells: [{ type: 'uint256', loc: null }],
        body: [
          boolConst(0, true),
          u256Const(1, 1n),
          mk({ k: 'if', cond: 0, then: [mk({ k: 'cellnew', cell: 0, init: 1 })], else: [] }),
          mk({ k: 'cellget', cell: 0, out: 2 }),
        ],
      }),
      /outside its defining scope/,
    );
  });
});

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

describe('validateIr — call rules', () => {
  const ABI = {
    name: 'balanceOf',
    selector: '0x70a08231',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  } as const;

  /** values: v0 address target, v1 address arg, v2 uint256 out, then extras. */
  function callIr(
    patch: Partial<Extract<Stmt, { k: 'call' }>>,
    extraValues: ValueInfo[] = [],
  ): ScriptIr {
    return ir({
      values: [vi('address'), vi('address'), vi('uint256'), ...extraValues],
      body: [
        mk({ k: 'env', op: 'caller', out: 0 }),
        mk({ k: 'env', op: 'address', out: 1 }),
        {
          ...mk({ k: 'call', target: 0, fnAbi: ABI, args: [1], outs: [2], mode: 'strict' }),
          ...patch,
        } as Stmt,
      ],
    });
  }

  test('rejects a non-address target', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('address'), vi('uint256')],
        body: [
          u256Const(0, 1n),
          mk({ k: 'env', op: 'address', out: 1 }),
          mk({ k: 'call', target: 0, fnAbi: ABI, args: [1], outs: [2], mode: 'strict' }),
        ],
      }),
      /target.*expected 'address'/,
    );
  });

  test('rejects a malformed selector and an empty fnAbi name', () => {
    expectInvalid(
      callIr({ fnAbi: { ...ABI, selector: '0x1234' } }),
      /selector must be a 4-byte hex/,
    );
    expectInvalid(callIr({ fnAbi: { ...ABI, name: '' } }), /fnAbi\.name must be non-empty/);
  });

  test('rejects fnAbi params outside the supported type set', () => {
    // a fixed-size array is outside the supported EvsType set
    expectInvalid(
      callIr({ fnAbi: { ...ABI, outputs: [{ name: '', type: 'uint256[2]' }] } }),
      /type outside the supported set/,
    );
  });

  test('rejects a tuple param with no components, and a non-tuple param carrying components', () => {
    // a 'tuple' type MUST carry components (composite types are supported now)
    expectInvalid(
      callIr({ fnAbi: { ...ABI, inputs: [{ name: 'owner', type: 'tuple' }] } }),
      /tuple type carries no components/,
    );
    // a non-tuple param must NOT carry components
    expectInvalid(
      callIr({
        fnAbi: { ...ABI, inputs: [{ name: 'o', type: 'address', components: [] }] },
      }),
      /must not carry components/,
    );
  });

  test('accepts fnAbi params carrying a valid tuple type', () => {
    // a tuple OUTPUT decoded into a tuple-typed out value (the arg stays the default address)
    const tupleType = {
      type: 'tuple',
      components: [{ name: 'x', type: 'uint256' }],
    } as const;
    expect(() =>
      validateIr(
        callIr(
          {
            fnAbi: { ...ABI, outputs: [{ name: 'data', ...tupleType }] },
            outs: [3],
          },
          [vi(tupleType)],
        ),
      ),
    ).not.toThrow();
  });

  test('rejects args/outs arity mismatches', () => {
    expectInvalid(callIr({ args: [] }), /arity mismatch — 0 args for 1 ABI inputs/);
    expectInvalid(callIr({ outs: [2, 2] }), /arity mismatch — 2 outs for 1 ABI outputs/);
  });

  test('rejects arg and out type mismatches', () => {
    expectInvalid(
      ir({
        values: [vi('address'), vi('uint256'), vi('uint256')],
        body: [
          mk({ k: 'env', op: 'caller', out: 0 }),
          u256Const(1, 1n),
          mk({ k: 'call', target: 0, fnAbi: ABI, args: [1], outs: [2], mode: 'strict' }),
        ],
      }),
      /arg 0.*expected 'address'/,
    );
    expectInvalid(callIr({ outs: [3] }, [vi('bool')]), /out 0.*produces 'uint256'/);
  });

  test("successOut is present iff mode === 'try'", () => {
    expectInvalid(callIr({ successOut: 3 }, [vi('bool')]), /only legal when mode === 'try'/);
    expectInvalid(callIr({ mode: 'try' }), /must define successOut/);
  });

  test('successOut must be bool', () => {
    expectInvalid(
      callIr({ mode: 'try', successOut: 3 }, [vi('uint256')]),
      /successOut.*produces 'bool'/,
    );
  });

  test('gas must be uint256', () => {
    expectInvalid(callIr({ gas: 1 }), /gas.*expected 'uint256'/);
  });
});

// ---------------------------------------------------------------------------
// fncall + fn bodies + call graph
// ---------------------------------------------------------------------------

describe('validateIr — fn rules', () => {
  const FN0 = {
    name: 'double',
    params: [{ name: 'x', type: 'uint256', value: 1 }],
    results: [{ type: 'uint256' }],
    body: [mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 })],
    resultValues: [2],
    loc: null,
  } as const;

  test('rejects an unknown FnId', () => {
    expectInvalid(
      ir({ values: [vi('uint256')], body: [mk({ k: 'fncall', fn: 3, args: [], outs: [] })] }),
      /unknown FnId 3/,
    );
  });

  test('rejects fncall arity and type mismatches', () => {
    const base = {
      values: [vi('uint256'), vi('uint256', 'x'), vi('uint256'), vi('uint256')],
      fns: [FN0],
    };
    expectInvalid(
      ir({ ...base, body: [u256Const(0, 1n), mk({ k: 'fncall', fn: 0, args: [], outs: [3] })] }),
      /arity mismatch — 0 args/,
    );
    expectInvalid(
      ir({ ...base, body: [u256Const(0, 1n), mk({ k: 'fncall', fn: 0, args: [0], outs: [] })] }),
      /arity mismatch — 0 outs/,
    );
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256', 'x'), vi('uint256'), vi('uint256')],
        fns: [FN0],
        body: [boolConst(0, true), mk({ k: 'fncall', fn: 0, args: [0], outs: [3] })],
      }),
      /arg 0.*expected 'uint256'/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256', 'x'), vi('uint256'), vi('bool')],
        fns: [FN0],
        body: [u256Const(0, 1n), mk({ k: 'fncall', fn: 0, args: [0], outs: [3] })],
      }),
      /out 0.*produces 'uint256'/,
    );
  });

  test('rejects a param whose backing value has a different type', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bool'), vi('uint256')],
        fns: [{ ...FN0, body: [], resultValues: [0] }],
      }),
      /params\[0\].*produces 'uint256'/,
    );
  });

  test('rejects resultValues arity and type mismatches', () => {
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256', 'x'), vi('uint256')],
        fns: [{ ...FN0, resultValues: [] }],
      }),
      /0 resultValues for 1 results/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('bool'), vi('uint256')],
        fns: [
          { ...FN0, params: [{ name: 'x', type: 'bool', value: 1 }], resultValues: [1], body: [] },
        ],
      }),
      /resultValues\[0\].*expected 'uint256'/,
    );
  });

  test('rejects a resultValue recorded inside a nested block', () => {
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256')],
        fns: [
          {
            name: 'f',
            params: [{ name: 'c', type: 'bool', value: 0 }],
            results: [{ type: 'uint256' }],
            body: [mk({ k: 'if', cond: 0, then: [u256Const(1, 1n)], else: [] })],
            resultValues: [1],
            loc: null,
          },
        ],
      }),
      /outside its defining scope/,
    );
  });

  test('fn bodies are isolated: no capture of main values, no leak of fn values', () => {
    // fn body uses a main value
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256')],
        fns: [
          {
            name: 'f',
            params: [],
            results: [{ type: 'uint256' }],
            body: [mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 1 })],
            resultValues: [1],
            loc: null,
          },
        ],
        body: [u256Const(0, 1n)],
      }),
      /outside its defining scope/,
    );
    // main uses a fn param value
    expectInvalid(
      ir({
        values: [vi('uint256'), vi('uint256')],
        fns: [
          {
            name: 'f',
            params: [{ name: 'x', type: 'uint256', value: 0 }],
            results: [],
            body: [],
            resultValues: [],
            loc: null,
          },
        ],
        body: [mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 1 })],
      }),
      /used before it is defined/,
    );
  });

  test('rejects call-graph cycles (mutual and self)', () => {
    const emptyFn = (name: string, callee: number) => ({
      name,
      params: [],
      results: [],
      body: [mk({ k: 'fncall', fn: callee, args: [], outs: [] })],
      resultValues: [],
      loc: null,
    });
    expectInvalid(ir({ fns: [emptyFn('f0', 1), emptyFn('f1', 0)] }), /call-graph cycle/);
    expectInvalid(ir({ fns: [emptyFn('f0', 0)] }), /call-graph cycle/);
  });

  test('accepts an acyclic chain (f1 calls f0)', () => {
    const leaf = { name: 'leaf', params: [], results: [], body: [], resultValues: [], loc: null };
    const caller = {
      name: 'caller',
      params: [],
      results: [],
      body: [mk({ k: 'fncall', fn: 0, args: [], outs: [] })],
      resultValues: [],
      loc: null,
    };
    expect(() => validateIr(ir({ fns: [leaf, caller] }))).not.toThrow();
  });

  test('rejects break inside a fn body without a loop', () => {
    expectInvalid(
      ir({
        fns: [
          {
            name: 'f',
            params: [],
            results: [],
            body: [mk({ k: 'break' })],
            resultValues: [],
            loc: null,
          },
        ],
      }),
      /'break' outside a while body/,
    );
  });
});

// ---------------------------------------------------------------------------
// control flow + the scope rule
// ---------------------------------------------------------------------------

describe('validateIr — control flow and scoping', () => {
  test('if/while conditions must be bool', () => {
    expectInvalid(
      ir({
        values: [vi('uint256')],
        body: [u256Const(0, 1n), mk({ k: 'if', cond: 0, then: [], else: [] })],
      }),
      /operand type mismatch/,
    );
    expectInvalid(
      ir({
        values: [vi('uint256')],
        body: [u256Const(0, 1n), mk({ k: 'while', header: [], cond: 0, body: [] })],
      }),
      /operand type mismatch/,
    );
  });

  test('if branches are isolated from each other', () => {
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256'), vi('uint256')],
        body: [
          boolConst(0, true),
          mk({
            k: 'if',
            cond: 0,
            then: [u256Const(1, 1n)],
            else: [mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 })],
          }),
        ],
      }),
      /outside its defining scope/,
    );
  });

  test('branch values do not escape the if', () => {
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256'), vi('uint256')],
        body: [
          boolConst(0, true),
          mk({ k: 'if', cond: 0, then: [u256Const(1, 1n)], else: [] }),
          mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 }),
        ],
      }),
      /outside its defining scope/,
    );
  });

  test('the while condition must be visible after the header (not defined in the body)', () => {
    expectInvalid(
      ir({
        values: [vi('bool')],
        body: [mk({ k: 'while', header: [], cond: 0, body: [boolConst(0, true)] })],
      }),
      /used before it is defined/,
    );
  });

  test('neither header nor body values escape the loop', () => {
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256'), vi('uint256')],
        body: [
          boolConst(0, false),
          mk({ k: 'while', header: [u256Const(1, 1n)], cond: 0, body: [] }),
          mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 }),
        ],
      }),
      /outside its defining scope/,
    );
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256'), vi('uint256')],
        body: [
          boolConst(0, false),
          mk({ k: 'while', header: [], cond: 0, body: [u256Const(1, 1n)] }),
          mk({ k: 'bin', op: 'add', a: 1, b: 1, out: 2 }),
        ],
      }),
      /outside its defining scope/,
    );
  });

  test('break/continue are rejected outside a while body', () => {
    expectInvalid(ir({ body: [mk({ k: 'break' })] }), /'break' outside a while body/);
    expectInvalid(ir({ body: [mk({ k: 'continue' })] }), /'continue' outside a while body/);
    // inside an if at the top level is still outside a loop
    expectInvalid(
      ir({
        values: [vi('bool')],
        body: [boolConst(0, true), mk({ k: 'if', cond: 0, then: [mk({ k: 'break' })], else: [] })],
      }),
      /'break' outside a while body/,
    );
    // a top-level while HEADER is not the loop body
    expectInvalid(
      ir({
        values: [vi('bool')],
        body: [
          boolConst(0, true),
          mk({ k: 'while', header: [mk({ k: 'break' })], cond: 0, body: [] }),
        ],
      }),
      /'break' outside a while body/,
    );
  });

  test('every ValueId has a single static assignment', () => {
    expectInvalid(
      ir({ values: [vi('uint256')], body: [u256Const(0, 1n), u256Const(0, 2n)] }),
      /defined more than once/,
    );
    // a fn param may not rebind a script arg's ValueId
    expectInvalid(
      ir({
        args: [{ name: 'a', type: 'uint256' }],
        values: [vi('uint256')],
        fns: [
          {
            name: 'f',
            params: [{ name: 'x', type: 'uint256', value: 0 }],
            results: [],
            body: [],
            resultValues: [],
            loc: null,
          },
        ],
      }),
      /defined more than once/,
    );
  });
});

// ---------------------------------------------------------------------------
// returns
// ---------------------------------------------------------------------------

describe('validateIr — return rules', () => {
  function retIr(returns: ScriptIr['returns']): ScriptIr {
    return ir({ values: [vi('uint256')], body: [u256Const(0, 1n)], returns });
  }

  test('rejects empty and duplicate return names', () => {
    expectInvalid(retIr([{ name: '', type: 'uint256', value: 0 }]), /empty name/);
    expectInvalid(
      retIr([
        { name: 'x', type: 'uint256', value: 0 },
        { name: 'x', type: 'uint256', value: 0 },
      ]),
      /duplicate return name "x"/,
    );
  });

  test('rejects unknown / mistyped / out-of-scope return values', () => {
    expectInvalid(retIr([{ name: 'x', type: 'uint256', value: 9 }]), /unknown ValueId 9/);
    expectInvalid(retIr([{ name: 'x', type: 'bool', value: 0 }]), /operand type mismatch/);
    expectInvalid(retIr([{ name: 'x', type: 'uint7' as EvsType, value: 0 }]), /non-v0 type/);
    expectInvalid(
      ir({
        values: [vi('bool'), vi('uint256')],
        body: [boolConst(0, true), mk({ k: 'if', cond: 0, then: [u256Const(1, 1n)], else: [] })],
        returns: [{ name: 'x', type: 'uint256', value: 1 }],
      }),
      /outside its defining scope/,
    );
  });
});

// ---------------------------------------------------------------------------
// error shape
// ---------------------------------------------------------------------------

describe('validateIr — error shape', () => {
  test('failures are EvsInternalError with the bug-report marker and the stmt loc', () => {
    const bad = ir({
      values: [vi('uint256')],
      body: [mk({ k: 'bin', op: 'add', a: 0, b: 0, out: 0 }, 4)],
    });
    let caught: unknown;
    try {
      validateIr(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvsInternalError);
    const err = caught as EvsInternalError;
    expect(err.message).toContain('bug in evs, please report');
    expect(err.message).toContain('invalid ScriptIr "fixture"');
    expect(err.loc).toEqual(LOC);
  });
});

// ---------------------------------------------------------------------------
// custom errors (issue #15)
// ---------------------------------------------------------------------------

describe('validateIr — custom errors (issue #15)', () => {
  const ERRORS = [
    { name: 'NoBalance', selector: '0xa6cccb45', inputs: [{ name: 'balance', type: 'uint256' }] },
    { name: 'NotOwner', selector: '0x30cd7471', inputs: [] },
  ] as const;

  test('valid throws accept (with-args and zero-arg)', () => {
    expect(() =>
      validateIr(
        ir({
          args: [{ name: 'x', type: 'uint256' }],
          values: [vi('uint256', 'x')],
          errors: ERRORS,
          body: [
            mk({ k: 'throw', error: 0, args: [0] }),
            mk({ k: 'throw', error: 1, args: [] }, 1),
          ],
        }),
      ),
    ).not.toThrow();
  });

  test('throw with an unknown error index is rejected', () => {
    expectInvalid(
      ir({ errors: ERRORS, body: [mk({ k: 'throw', error: 5, args: [] })] }),
      /unknown error index 5/,
    );
  });

  test('throw with no errors table at all is rejected', () => {
    expectInvalid(ir({ body: [mk({ k: 'throw', error: 0, args: [] })] }), /unknown error index 0/);
  });

  test('throw arity mismatch is rejected', () => {
    expectInvalid(
      ir({ errors: ERRORS, body: [mk({ k: 'throw', error: 0, args: [] })] }),
      /arity mismatch — 0 args for 1 declared inputs/,
    );
  });

  test('throw arg type mismatch is rejected', () => {
    expectInvalid(
      ir({
        values: [vi('bool')],
        errors: ERRORS,
        body: [boolConst(0, true), mk({ k: 'throw', error: 0, args: [0] }, 1)],
      }),
      /throw "NoBalance".*arg 0/,
    );
  });

  test('duplicate error names are rejected', () => {
    expectInvalid(ir({ errors: [ERRORS[1], ERRORS[1]] }), /duplicate error name "NotOwner"/);
  });

  test('a malformed selector is rejected', () => {
    expectInvalid(
      ir({ errors: [{ name: 'X', selector: '0x1234', inputs: [] }] }),
      /selector must be a 4-byte hex string/,
    );
  });

  test('an empty/duplicate input name is rejected (decode utilities key args by name)', () => {
    expectInvalid(
      ir({
        errors: [{ name: 'X', selector: '0xa6cccb45', inputs: [{ name: '', type: 'uint256' }] }],
      }),
      /input #0 has an invalid name/,
    );
    expectInvalid(
      ir({
        errors: [
          {
            name: 'X',
            selector: '0xa6cccb45',
            inputs: [
              { name: 'a', type: 'uint256' },
              { name: 'a', type: 'address' },
            ],
          },
        ],
      }),
      /duplicate input name "a"/,
    );
  });

  test('a non-v0 input type is rejected', () => {
    expectInvalid(
      ir({
        errors: [{ name: 'X', selector: '0xa6cccb45', inputs: [{ name: 'a', type: 'uint7' }] }],
      }),
      /type outside the supported set/,
    );
  });
});
