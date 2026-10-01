/* oxlint-disable typescript/no-unsafe-type-assertion --
 * these tests deliberately defeat the type surface (`as never`) to prove the RUNTIME checks
 * catch the same misuses; every assertion below is a seeded violation. */
/* oxlint-disable vitest/expect-expect --
 * every test asserts through the expectEvs()/catchEvs() helpers (class + code + message);
 * the rule only recognizes direct expect* calls. */
/**
 * Builder unit tests — the recording-time validation checklist:
 * every item asserts the error class, the error code and a message substring. Plus staging
 * traps, foreign/cross-scope handles, and LoopCtl
 * scoping.
 */
import { inspect } from 'node:util';

import type { Abi } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { compile } from '../compile.js';
import {
  EvsError,
  EvsScopeError,
  EvsStagingError,
  EvsTypeError,
  type EvsErrorCode,
} from '../core/errors.js';
import { namedArg, t, type Expr } from '../core/types.js';
import { validateIr } from '../ir/validate.js';
import { evscript, type LoopCtl, type ScriptBuilder } from './script.js';

const erc20Abi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const overloadedAbi = [
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

// a MALFORMED tuple-array output tag — every well-formed tuple array (`tuple[]`, `tuple[][]`,
// `tuple[2]`, …) is supported since #4; a bad tag must still raise ABI_SHAPE naming the parameter.
const tupleAbi = [
  {
    type: 'function',
    name: 'observe',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: 'data',
        type: 'tuple[0]',
        components: [{ name: 'a', type: 'uint256' }],
      },
    ],
  },
] as const satisfies Abi;

type AnyBuilder = ScriptBuilder;

/** The positional script args, surfaced as a named record for the throwaway recorder below. */
interface Args {
  readonly x: Expr<'uint256'>;
  readonly who: Expr<'address'>;
  readonly flag: Expr<'bool'>;
  readonly xs: Expr<'uint64[]'>;
  readonly s8: Expr<'int8'>;
}

/** Records a throwaway script whose body is expected to throw. Args arrive positionally after
 *  `s` and are repackaged into the legacy `s.args`-shaped `a` record for the seeded violations. */
function rec(body: (s: AnyBuilder, a: Args) => unknown): void {
  evscript({ name: 'tst', args: [t.uint256, t.address, t.bool, t.array(t.uint64), t.int8] }, ((
    s: AnyBuilder,
    x: Args['x'],
    who: Args['who'],
    flag: Args['flag'],
    xs: Args['xs'],
    s8: Args['s8'],
  ) => body(s, { x, who, flag, xs, s8 })) as never);
}

function catchEvs(fn: () => unknown): EvsError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EvsError);
    return e as EvsError;
  }
  throw new Error('expected an EvsError to be thrown');
}

/** class + code + message substring, in one assertion helper. */
function expectEvs(
  fn: () => unknown,
  cls: abstract new (...a: never[]) => EvsError,
  code: EvsErrorCode,
  msg: string | RegExp,
): EvsError {
  const e = catchEvs(fn);
  expect(e).toBeInstanceOf(cls);
  expect(e.code).toBe(code);
  expect(e.message).toMatch(msg);
  return e;
}

// ---------------------------------------------------------------------------
// arg declaration errors
// ---------------------------------------------------------------------------

describe('checklist: arg types + script name (args are positional, auto-named)', () => {
  test('unknown arg type (uint7)', () => {
    expectEvs(
      () =>
        evscript({ name: 'd', args: ['uint7' as never] }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /uint7/,
    );
  });

  test('one-level nested-array arg type is now accepted, read via .length()', () => {
    // `uint256[][]` arg decodes (read path). Return a derived WORD (composite-array encode is the
    // next milestone), so recording + the script build succeed.
    const script = evscript(
      { name: 'd', args: ['uint256[][]' as never] },
      (s: AnyBuilder, x: { length(): unknown }) => s.return({ rows: x.length() } as never),
    );
    expect(script).toBeDefined();
  });

  test('arrays nested deeper than [][] and fixed-size arrays are accepted args (issue #4)', () => {
    for (const type of ['uint256[][][]', 'uint256[2]', 'string[2][]', 'address[][3]']) {
      const script = evscript({ name: 'd', args: [type as never] }, (s: AnyBuilder, x: unknown) =>
        s.return({ x } as never),
      );
      expect(script.ir.args[0]?.type).toBe(type);
    }
  });

  test('STILL gated: an array nested deeper than MAX_ARRAY_DEPTH (4) → UNSUPPORTED_V0', () => {
    for (const type of ['uint256[][][][][]', 'string[2][][][][]']) {
      expectEvs(
        () =>
          evscript({ name: 'd', args: [type as never] }, (s: AnyBuilder, x: unknown) =>
            s.return({ x } as never),
          ),
        EvsTypeError,
        'UNSUPPORTED_V0',
        /nests arrays 5 levels deep — at most 4/,
      );
    }
    // four levels is the ceiling and still compiles
    expect(
      evscript({ name: 'd4', args: ['uint256[][][][]' as never] }, (s: AnyBuilder, x: unknown) =>
        s.return({ x } as never),
      ).ir.args[0]?.type,
    ).toBe('uint256[][][][]');
  });

  test('a malformed array suffix in an arg type → TYPE_MISMATCH', () => {
    expectEvs(
      () =>
        evscript({ name: 'd', args: ['uint256[0]' as never] }, (s: AnyBuilder, x: unknown) =>
          s.return({ x } as never),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /malformed array suffix/,
    );
  });

  test("a bad declarator name keeps each site's code, and evscript reports it before the callback", () => {
    // hand-built `{ name, type }` declarators (namedArg itself rejects the name): the three
    // surfaces share one normalizer, so they classify and check names identically
    const bad = { name: '1x', type: 'uint256' } as never;
    let ran = false;
    expectEvs(
      () =>
        evscript({ name: 'd', args: [t.address, bad] }, () => {
          ran = true;
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'ABI_SHAPE',
      /evscript "d" arg #1: invalid arg name "1x"/,
    );
    expect(ran).toBe(false);
    expectEvs(
      () => rec((s) => s.fn('f', [bad], () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.fn\("f"\) param #0: invalid param name "1x"/,
    );
    expectEvs(
      () => t.error('X', [bad]),
      EvsTypeError,
      'ERROR_DECL',
      /t\.error\("X"\) param #0: invalid param name "1x"/,
    );
  });

  test('a tuple ABI parameter with a malformed component is TYPE_MISMATCH at every site', () => {
    const malformed = {
      name: 'p',
      type: 'tuple',
      components: [{ name: 'x', type: 'uint7' }],
    } as never;
    const what = /#0 \("p"\): expected a type/;
    expectEvs(
      () =>
        evscript({ name: 'd', args: [malformed] }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      what,
    );
    expectEvs(
      () => rec((s) => s.fn('f', malformed, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      what,
    );
    expectEvs(() => t.error('X', malformed), EvsTypeError, 'TYPE_MISMATCH', what);
  });

  test('a tuple declarator with a bad member names that member in the message', () => {
    // a raw ABI struct parameter whose members carry no `name` (t.fromAbiParameter fills them)
    const nameless = { name: 'p', type: 'tuple', components: [{ type: 'uint256' }] } as never;
    const missing =
      /#0 \("p"\): .*got a tuple descriptor whose components\[0\] has no string `name`/;
    expectEvs(
      () =>
        evscript({ name: 'w', args: [nameless] }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      missing,
    );
    expectEvs(
      () => rec((s) => s.fn('f', nameless, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      missing,
    );
    expectEvs(() => t.error('X', nameless), EvsTypeError, 'TYPE_MISMATCH', missing);
    // nested members are located by path; namedArg reports the same way
    const nested = {
      type: 'tuple',
      components: [
        { name: 'a', type: 'uint8' },
        { name: 'b', type: 'tuple[]', components: [{ name: 'c', type: 'uint7' }] },
      ],
    } as never;
    expectEvs(
      () => namedArg('q', nested),
      EvsTypeError,
      'TYPE_MISMATCH',
      /argument "q": .*components\[1\]\.components\[0\] has an invalid type "uint7"/,
    );
    expectEvs(
      () => t.error('Y', [t.bool, nested]),
      EvsTypeError,
      'TYPE_MISMATCH',
      /param #1: .*components\[1\]\.components\[0\] has an invalid type "uint7"/,
    );
  });

  test('invalid script name', () => {
    expectEvs(
      () =>
        evscript({ name: 'not a name' as never, args: [] }, () => {
          throw new Error('unreachable');
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /script name/,
    );
  });

  test('a script name colliding with an error name in its ABI is ERROR_DECL (issue #63)', () => {
    // the artifact ABI would hold a function AND an error of that name: viem's getAbiItem
    // resolves the error, so encodeFunctionData/readContract fail with "Function not found"
    const cases = [
      ['EvsDecodeError', []],
      ['EvsInvalidCalldata', []],
      ['Boom', [t.error('Boom', [namedArg('x', t.uint256)])]],
    ] as const;
    for (const [name, errors] of cases) {
      expectEvs(
        () =>
          evscript({ name, args: [t.uint256], errors: errors as never }, (s, a) => s.return({ a })),
        EvsTypeError,
        'ERROR_DECL',
        new RegExp(`script name "${name}" collides with the error "${name}"`),
      );
    }
    // Solidity built-in error names are not ABI entries of the artifact: still callable
    for (const name of ['Panic', 'Error'] as const) {
      const script = evscript({ name, args: [t.uint256] }, (s, a) => s.return({ a }));
      expect(script.abi[0]).toMatchObject({ type: 'function', name });
    }
  });
});

// ---------------------------------------------------------------------------
// literal validation
// ---------------------------------------------------------------------------

describe('checklist: literal out of range / wrong hex length / unsafe number', () => {
  test('uint8 literal out of range', () => {
    expectEvs(() => rec((s) => s.lit(t.uint8, 256)), EvsTypeError, 'LITERAL_RANGE', /out of range/);
  });

  test('negative literal for an unsigned type', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, -1n)),
      EvsTypeError,
      'LITERAL_RANGE',
      /out of range/,
    );
  });

  test('unsafe JS number', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 2 ** 53)),
      EvsTypeError,
      'LITERAL_RANGE',
      /safe integer/,
    );
  });

  test('address literal with the wrong byte length', () => {
    expectEvs(
      () => rec((s) => s.lit(t.address, '0x1234')),
      EvsTypeError,
      'LITERAL_RANGE',
      /exactly 20 bytes/,
    );
  });

  test('bytes4 literal with the wrong byte length', () => {
    expectEvs(
      () => rec((s) => s.lit(t.bytes4, '0x1122')),
      EvsTypeError,
      'LITERAL_RANGE',
      /exactly 4 bytes/,
    );
  });

  test('odd-length hex for bytes', () => {
    expectEvs(
      () => rec((s) => s.lit(t.bytes, '0x123')),
      EvsTypeError,
      'LITERAL_RANGE',
      /even-length hex/,
    );
  });

  test('wrong literal kind (boolean for uint8)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint8, true as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /number or bigint/,
    );
  });

  test('array literal rules apply element-wise', () => {
    expectEvs(
      () => rec((s) => s.lit(t.array(t.uint8), [1n, 999n])),
      EvsTypeError,
      'LITERAL_RANGE',
      /uint8\[\]\[1\]/,
    );
  });

  test('a composite-array literal in s.lit now BUILDS at record time', () => {
    // `uint256[][]` is a valid composite-element array; s.lit builds it via arrnew + per-element
    // construction (no flat data segment) and returns a usable Expr.
    expect(() =>
      evscript({ name: 'lit2d' }, (s) =>
        s.return({ m: s.lit('uint256[][]' as never, [[1n, 2n], [3n]] as never) }),
      ),
    ).not.toThrow();
  });

  test('s.lit builds deeper-nested and fixed-size array literals (issue #4)', () => {
    expect(() =>
      evscript({ name: 'lit3d' }, (s) =>
        s.return({
          c: s.lit('uint256[][][]' as never, [[[1n], []], []] as never),
          p: s.lit('uint256[2]' as never, [1n, 2n] as never),
          n: s.lit('string[2]' as never, ['a', 'b'] as never),
        }),
      ),
    ).not.toThrow();
  });

  test('a fixed-size array literal of the wrong length → TYPE_MISMATCH', () => {
    expectEvs(
      () => rec((s) => s.lit('uint256[2]' as never, [1n] as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /exactly 2 element/,
    );
    expectEvs(
      () => rec((s) => s.lit('string[2]' as never, ['a', 'b', 'c'] as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /exactly 2 element/,
    );
  });
});

// ---------------------------------------------------------------------------
// operand type mismatches
// ---------------------------------------------------------------------------

describe('checklist: operand type mismatch (message suggests toUint/toInt)', () => {
  test('width mismatch between two numeric Exprs suggests an explicit conversion', () => {
    const e = expectEvs(
      () => rec((s, a) => s.add(a.x, s.lit(t.uint8, 1) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /operand types differ/,
    );
    expect(e.message).toMatch(/toUint|toInt/);
  });

  test('coercing an Expr against an expected type names both types', () => {
    const e = expectEvs(
      () => rec((s) => s.let(t.uint256, s.lit(t.uint8, 1) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expected 'uint256', got Expr<'uint8'>/,
    );
    expect(e.message).toMatch(/toUint\('uint256'\)/);
  });

  test('pow: the exponent must be unsigned, the base an Expr (issue #10)', () => {
    expectEvs(
      () => rec((s, a) => a.x.pow(a.s8 as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /exponent must be an unsigned Expr<'uintN'>.*got Expr<'int8'>/,
    );
    expectEvs(
      () => rec((s, a) => s.pow(2n as never, a.x)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /the base must be an Expr/,
    );
    expectEvs(
      () => rec((s, a) => a.x.pow(-1n)),
      EvsTypeError,
      'LITERAL_RANGE',
      /uint256 literal -1n is out of range/,
    );
    expectEvs(
      () => rec((s, a) => s.pow(a.who as never, 2n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be numeric/,
    );
  });

  test('addmod / mulmod take uint256 operands only (issue #10)', () => {
    expectEvs(
      () => rec((s, a) => (a.s8 as unknown as Expr<'uint256'>).mulmod(1n, 3n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /\.mulmod\(\) left operand.*expected 'uint256', got Expr<'int8'>/,
    );
    expectEvs(
      () => rec((s, a) => s.addmod(a.x, a.x, s.lit(t.uint128, 5n) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.addmod\(\) modulus/,
    );
  });

  test('arithmetic on a non-numeric type', () => {
    expectEvs(
      () => rec((s, a) => s.add(a.who as never, a.who as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be numeric/,
    );
  });

  test('eq between a memref and a word (memref equality is same-type only — #38)', () => {
    expectEvs(
      () => rec((s, a) => s.eq(a.xs, a.x)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /operand types differ \(Expr<'uint64\[\]'> vs Expr<'uint256'>\)/,
    );
  });

  test('eq between a memref and a literal of the wrong shape', () => {
    expectEvs(
      () => rec((s, a) => s.eq(a.xs, 'not-an-array' as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /uint64\[\] literal must be an array/,
    );
  });

  test('bool logic on a non-bool', () => {
    expectEvs(
      () => rec((s, a) => s.and(a.x as never, a.x as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /Expr<'bool'>/,
    );
  });

  test('bitwise on address', () => {
    expectEvs(
      () => rec((s, a) => s.bitAnd(a.who as never, a.who as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /uintN\/bytesN/,
    );
  });

  test('two plain literals: at least one operand must be an Expr', () => {
    expectEvs(
      () => rec((s) => s.add(1n, 2n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /at least one operand must be an Expr/,
    );
  });

  test('shift with a literal shiftee', () => {
    expectEvs(
      () => rec((s) => s.shl(1n as never, 1n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /shifted operand must be an Expr/,
    );
  });

  test('conversion source must be numeric', () => {
    // the receiver constraint rejects these at compile time too; the recorder is the backstop
    // for untyped callers
    expectEvs(
      // @ts-expect-error — an address receiver is not numeric
      () => rec((s, a) => a.who.toUint(t.uint256)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /\.toUint\(\): cannot convert from 'address' — the source must be numeric/,
    );
    expectEvs(
      // @ts-expect-error — a bool receiver is not numeric
      () => rec((s, a) => a.flag.toInt(t.int8)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /\.toInt\(\): cannot convert from 'bool' — the source must be numeric/,
    );
  });

  test('asAddress only from uint256/bytes32', () => {
    expectEvs(
      () => rec((s, a) => (a.s8 as never as Expr<'uint256'>).asAddress()),
      EvsTypeError,
      'TYPE_MISMATCH',
      /uint256'.*bytes32'/,
    );
  });

  test('.length() on a word type / .at() on a non-array', () => {
    expectEvs(
      () => rec((s, a) => (a.x as never as Expr<'bytes'>).length()),
      EvsTypeError,
      'TYPE_MISMATCH',
      /string\/bytes\/T\[\]/,
    );
    expectEvs(
      () => rec((s, a) => (a.x as never as Expr<'uint64[]'>).at(0n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /T\[\] array/,
    );
  });

  test('env with an unknown kind', () => {
    expectEvs(
      () => rec((s) => s.env('origin' as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /unknown kind/,
    );
  });

  test('newArray admits composite, fixed-size, and tuple-array elements (issue #4)', () => {
    // string is a valid composite element — s.newArray('string', n) builds a string[].
    expect(() =>
      evscript({ name: 'mkStrings' }, (s) => {
        const xs = s.newArray('string' as never, 2n);
        return s.return({ xs: xs.expr() });
      }),
    ).not.toThrow();
    // a fixed-size element → `uint256[2][]`; a tuple[] element → `tuple[][]`.
    const script = evscript({ name: 'mkNested' }, (s) => {
      const ps = s.newArray('uint256[2]' as never, 1n);
      const g = s.newArray(t.array(t.struct({ a: t.uint256 })) as never, 1n);
      return s.return({ ps: ps.expr(), g: g.expr() });
    });
    expect(script.ir.returns[0]?.type).toBe('uint256[2][]');
    expect(script.ir.returns[1]?.type).toEqual({
      type: 'tuple[][]',
      components: [{ name: 'a', type: 'uint256' }],
    });
    // a malformed element type is TYPE_MISMATCH
    expectEvs(
      () => rec((s) => s.newArray('uint256[0]' as never, 1n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /malformed array suffix/,
    );
    // an element that would push the array past MAX_ARRAY_DEPTH is still UNSUPPORTED_V0
    expectEvs(
      () => rec((s) => s.newArray('uint256[][][][]' as never, 1n)),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /at most 4/,
    );
    expectEvs(
      () =>
        rec((s) =>
          s.newArray(
            { type: 'tuple[][][][]', components: [{ name: 'a', type: 'uint256' }] } as never,
            1n,
          ),
        ),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /at most 4/,
    );
  });

  test('newArray({ fixed: true }) builds a fixed-size array from a literal length', () => {
    const script = evscript({ name: 'mkFixed' }, (s) => {
      const p = s.newArray(t.uint256, 2, { fixed: true });
      p.set(0n, 1n);
      return s.return({ p: p.expr() });
    });
    expect(script.ir.returns[0]?.type).toBe('uint256[2]');
    const arrnew = script.ir.body.find((st) => st.k === 'arrnew');
    expect(arrnew !== undefined && arrnew.k === 'arrnew' ? arrnew.fixed : null).toBe(2);
    // the length of a fixed array is part of its type — it must be a literal
    expectEvs(
      () => rec((s, a) => s.newArray(t.uint256, a.x as never, { fixed: true })),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be a literal/,
    );
    expectEvs(
      () => rec((s) => s.newArray(t.uint256, 0, { fixed: true })),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be a literal positive integer/,
    );
  });

  test('select: both branches literal', () => {
    expectEvs(
      () => rec((s, a) => s.select(a.flag, 1n, 2n)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /at least one branch must be an Expr/,
    );
  });

  test('select: branch type mismatch', () => {
    expectEvs(
      () => rec((s, a) => s.select(a.flag, a.x, a.who as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /branch types differ/,
    );
  });

  test('while: condition must be a thunk', () => {
    expectEvs(
      () => rec((s) => s.while(true as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /thunk/,
    );
  });

  test('for: range.type must be numeric; from/until required (type itself is optional)', () => {
    expectEvs(
      () => rec((s) => s.for({ type: t.address, from: 0n, until: 1n } as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be numeric/,
    );
    expectEvs(
      () => rec((s) => s.for({ type: t.uint256, from: 0n } as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /range\.from and range\.until/,
    );
    // omitting `type` defaults to uint256, so from/until are still validated against it
    expectEvs(
      () => rec((s) => s.for({ from: 0n } as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /range\.from and range\.until/,
    );
  });

  test('forEach: array must be a T[] Expr; body must be a callback (issue #12)', () => {
    expectEvs(
      () => rec((s, a) => s.forEach(a.x as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expected an Expr of a T\[\] array type/,
    );
    // a raw JS array is not a staged handle
    expectEvs(
      () => rec((s) => s.forEach([1n, 2n] as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expected an Expr of a T\[\] array type/,
    );
    // a bare MutArray handle is steered to .expr()
    expectEvs(
      () => rec((s) => s.forEach(s.newArray(t.uint256, 3n) as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /a MutArray is not an Expr/,
    );
    expectEvs(
      () => rec((s, a) => s.forEach(a.xs, 42 as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /body must be a callback/,
    );
  });

  test('s.let(expr) overload requires an Expr', () => {
    expectEvs(
      () => rec((s) => s.let(5n as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /init must be an Expr/,
    );
  });
});

// ---------------------------------------------------------------------------
// entry points the types accept must record (or fail with a user-facing error)
// ---------------------------------------------------------------------------

describe('checklist: composite s.let / s.lit, folded s.select, .length(), failed s.fn', () => {
  const Pair = t.struct({ a: t.uint256, b: t.address });
  const ONE = '0x0000000000000000000000000000000000000001';

  test('s.let(type, init) takes the typed form by arity, composite types included', () => {
    // each of these used to fall into the one-argument form ("init must be an Expr when no type is given")
    expect(() =>
      evscript({ name: 'cells', args: [t.uint256] }, (s, x) => {
        const lit = s.let(Pair, { a: 5n, b: ONE });
        const fromExpr = s.let(Pair, s.tuple(Pair, { a: x }).expr());
        const positional = s.let(t.tuple(t.uint256, t.address), [5n, ONE]);
        const empty = s.let(t.array(Pair), []);
        return s.return({
          lit: lit.get(),
          fromExpr: fromExpr.get(),
          positional: positional.get(),
          n: empty.get().length(),
        });
      }),
    ).not.toThrow();
  });

  test('s.let(type) without an init → TYPE_MISMATCH, for a string or a descriptor type', () => {
    for (const type of [t.uint256, Pair, t.array(Pair)]) {
      expectEvs(
        () => rec((s) => s.let(type as never)),
        EvsTypeError,
        'TYPE_MISMATCH',
        /s\.let\(type, init\): init value is required/,
      );
    }
  });

  test('s.let(badType) with one argument → the unknown-type diagnosis, not a missing init', () => {
    for (const bad of ['abc', 'uint7']) {
      expectEvs(
        () => rec((s) => s.let(bad as never)),
        EvsTypeError,
        'TYPE_MISMATCH',
        /s\.let\(\): unknown type/,
      );
    }
  });

  test('s.let(type, init): the type and the init are validated against each other', () => {
    expectEvs(
      () => rec((s) => s.let({ type: 'tuple' } as never, 1n as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.let\(\): type must be a `t` type .*got an object/,
    );
    expectEvs(
      () => rec((s) => s.let('uint7' as never, 1n as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.let\(\)/,
    );
    expectEvs(
      () => rec((s) => s.let(Pair, { a: -1n, b: ONE } as never)),
      EvsTypeError,
      'LITERAL_RANGE',
      /-1n is out of range/,
    );
    expectEvs(
      () => rec((s, a) => s.let(Pair, a.x as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.let\(\) init/,
    );
  });

  test('s.lit accepts struct and tuple[] types (same coercion as any value position)', () => {
    expect(() =>
      evscript({ name: 'lits', args: [] }, (s) =>
        s.return({
          p: s.lit(Pair, { a: 5n, b: ONE }),
          ps: s.lit(t.array(Pair), [
            { a: 1n, b: ONE },
            { a: 2n, b: ONE },
          ]),
        }),
      ),
    ).not.toThrow();
    expectEvs(
      () => rec((s) => s.lit(t.array(Pair, 2), [{ a: 1n }] as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /exactly 2 element/,
    );
    expectEvs(
      () => rec((s) => s.lit(new Map() as never, 1n as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.lit\(\): type must be a `t` type/,
    );
  });

  test('a folded s.select condition accepts every dropped literal the runtime path accepts', () => {
    const script = (cond: 'runtime' | 'host' | 'folded') =>
      evscript(
        { name: 'sel', args: [t.bool, t.array(t.string), t.uint256, t.array(Pair)] },
        (s, flag, names, x, items) => {
          const c =
            cond === 'runtime' ? flag : cond === 'host' ? true : s.lit(t.uint256, 3n).gt(2n);
          return s.return({
            names: s.select(c, names, ['a', 'b']),
            words: s.select(c, s.lit(t.array(t.uint256), [7n]), [x, 1n]),
            grid: s.select(s.not(c), [[1n], [2n, 3n]], s.lit(t.array(t.array(t.uint256)), [])),
            items: s.select(c, items, [{ a: 1n, b: ONE }]),
            item: s.select(c, s.tuple(Pair, { a: x }).expr(), { a: 1n, b: ONE }),
          });
        },
      );
    for (const cond of ['runtime', 'host', 'folded'] as const) {
      expect(() => script(cond)).not.toThrow();
    }
  });

  test('a folded s.select condition still rejects an invalid dropped literal, as the runtime path does', () => {
    const messages = [true, false].map((folded) => [
      expectEvs(
        () => rec((s, a) => s.select(folded ? true : a.flag, a.xs, [1n, -1n])),
        EvsTypeError,
        'LITERAL_RANGE',
        /-1n is out of range/,
      ).message,
      expectEvs(
        () =>
          rec((s, a) =>
            s.select(folded ? true : a.flag, s.tuple(Pair, { a: 1n }).expr(), {
              a: 1n,
              b: '0x12',
            } as never),
          ),
        EvsTypeError,
        'LITERAL_RANGE',
        /address literal must be exactly 20 bytes/,
      ).message,
    ]);
    expect(messages[0]).toEqual(messages[1]);
  });

  test('.length() on a plain tuple Expr → TYPE_MISMATCH at recording (not INTERNAL at compile)', () => {
    expectEvs(
      () => rec((s) => (s.tuple(Pair, { a: 1n }).expr() as never as Expr<'bytes'>).length()),
      EvsTypeError,
      'TYPE_MISMATCH',
      /\.length\(\) requires an Expr of string\/bytes\/T\[\], got '\{"type":"tuple"/,
    );
  });

  test('a failed s.fn is rolled back: catching its error and carrying on records the script', () => {
    const script = evscript({ name: 'fallback', args: [t.uint256] }, (s, x) => {
      expectEvs(
        () => s.fn('bad', [t.uint256], (a) => a.add(-1 as never)),
        EvsTypeError,
        'LITERAL_RANGE',
        /-1/,
      );
      expectEvs(
        () => s.fn('badResult', [t.uint256], () => 'not an expr' as never),
        EvsTypeError,
        'TYPE_MISMATCH',
        /must return an Expr/,
      );
      const inc = s.fn('inc', [t.uint256], (a) => a.add(1n));
      return s.return({ y: inc(x) });
    });
    expect(script.ir.fns.map((f) => f.name)).toEqual(['inc']);
  });

  test('a failed s.fn whose body defined a nested s.fn → SCOPE_VIOLATION when the script finishes', () => {
    expectEvs(
      () =>
        evscript({ name: 'nested', args: [t.uint256] }, (s, x) => {
          try {
            s.fn('outer', [t.uint256], (a) => {
              const inner = s.fn('inner', [t.uint256], (b) => b.add(1n));
              return inner(a).add(-1);
            });
          } catch {
            // caught by the script author: the nested definition keeps FnId 1, so the failed
            // FnId 0 cannot be rolled back
          }
          return s.return({ y: x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /s\.fn\("outer"\) failed to record after an s\.fn nested in its body was defined/,
    );
  });
});

// ---------------------------------------------------------------------------
// certain-panic folds (with the documented escape hatch in the message)
// ---------------------------------------------------------------------------

describe('checklist: all-literal certain-panic folds', () => {
  test('add overflow → Panic(0x11) with the cell escape hatch', () => {
    const e = expectEvs(
      () => rec((s) => s.lit(t.uint8, 255).add(1)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x11\)/,
    );
    expect(e.message).toContain('s.let(t.uint256, x).get()');
    expect(e.message).toContain('use the result');
  });

  test('sub underflow on unsigned', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint8, 0).sub(1)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /underflows uint8.*Panic\(0x11\)/s,
    );
  });

  test('division by literal zero → Panic(0x12)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 1n).div(0n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x12\)/,
    );
  });

  test('intN min / −1 → Panic(0x11)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.int8, -128n).div(-1n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /overflows int8/,
    );
  });

  test('modulo by literal zero → Panic(0x12)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 1n).mod(0n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x12\)/,
    );
  });

  test('pow overflow → Panic(0x11) (issue #10)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint8, 2).pow(8n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /2 \*\* 8 overflows uint8.*Panic\(0x11\)/s,
    );
    expectEvs(
      () => rec((s) => s.lit(t.int8, -2).pow(8n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /overflows int8/,
    );
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 2n).pow(1n << 200n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /overflows uint256/,
    );
    // in-range literal powers fold, including the int8 minimum and 0 ** 0
    expect(() =>
      rec((s) => s.return({ a: s.lit(t.int8, -2).pow(7n), z: s.lit(t.uint8, 0).pow(0n) })),
    ).not.toThrow();
  });

  test('addmod / mulmod by a literal zero modulus → Panic(0x12) (issue #10)', () => {
    expectEvs(
      () => rec((s) => s.mulmod(2n, 3n, 0n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /mulmod\(2, 3, 0\) takes modulo zero.*Panic\(0x12\)/s,
    );
    // with a runtime operand the zero modulus is recorded (a runtime Panic, like x.div(0n))
    expect(() => rec((s, a) => s.return({ r: a.x.addmod(1n, 0n) }))).not.toThrow();
  });

  test('out-of-range narrowing conversion → Panic(0x11)', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 300n).toUint(t.uint8)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /does not fit 'uint8'/,
    );
  });

  test('literal asAddress with dirty high bits', () => {
    expectEvs(
      () => rec((s) => s.lit(t.uint256, 2n ** 200n).asAddress()),
      EvsTypeError,
      'CERTAIN_PANIC',
      /does not fit 'address'/,
    );
  });

  test('literal newArray length ≥ 2^32 → Panic(0x41)', () => {
    expectEvs(
      () => rec((s) => s.newArray(t.uint256, 2n ** 32n)),
      EvsTypeError,
      'CERTAIN_PANIC',
      /Panic\(0x41\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// s.call / s.tryCall ABI checks
// ---------------------------------------------------------------------------

describe('checklist: call-site ABI validation', () => {
  test('abi has no function with that name', () => {
    expectEvs(
      () =>
        rec((s, a) => s.read({ address: a.who, abi: erc20Abi, functionName: 'symbol' as never })),
      EvsTypeError,
      'ABI_SHAPE',
      /no function named "symbol"/,
    );
  });

  test('non view/pure function rejected with its mutability', () => {
    expectEvs(
      () =>
        rec((s, a) =>
          s.read({
            address: a.who,
            abi: erc20Abi,
            functionName: 'transfer' as never,
            args: [a.who, 1n] as never,
          }),
        ),
      EvsTypeError,
      'ABI_SHAPE',
      /is nonpayable.*view\/pure/s,
    );
  });

  // issue #1 — the mutability filter is split per verb; the wrong bucket gets a steering error.
  test('s.read on a nonpayable function steers to s.call / s.simulate', () => {
    const e = expectEvs(
      () =>
        rec((s, a) =>
          s.read({
            address: a.who,
            abi: erc20Abi,
            functionName: 'transfer' as never,
            args: [a.who, 1n] as never,
          }),
        ),
      EvsTypeError,
      'ABI_SHAPE',
      /is nonpayable/,
    );
    expect(e.message).toMatch(/STATICCALL/);
    expect(e.message).toMatch(/s\.call.*s\.simulate/s);
  });

  test('s.call on a view function steers to s.read', () => {
    const e = expectEvs(
      () =>
        rec((s, a) => s.call({ address: a.who, abi: erc20Abi, functionName: 'decimals' as never })),
      EvsTypeError,
      'ABI_SHAPE',
      /is view/,
    );
    expect(e.message).toMatch(/runs under CALL/);
    expect(e.message).toMatch(/use s\.read/);
  });

  test('s.simulate on a view function steers to s.read', () => {
    expectEvs(
      () =>
        rec((s, a) =>
          s.simulate({
            address: a.who,
            abi: erc20Abi,
            functionName: 'balanceOf' as never,
            args: [a.who] as never,
          }),
        ),
      EvsTypeError,
      'ABI_SHAPE',
      /use s\.read/,
    );
  });

  test('overloaded name → resolved by the args (issue #4); no matching arity → TYPE_MISMATCH', () => {
    expect(() =>
      rec((s, a) => {
        s.read({ address: a.who, abi: overloadedAbi, functionName: 'get' });
        s.read({ address: a.who, abi: overloadedAbi, functionName: 'get', args: [a.x] });
        return s.return({ ok: a.flag });
      }),
    ).not.toThrow();
    const e = expectEvs(
      () =>
        rec((s, a) =>
          s.read({
            address: a.who,
            abi: overloadedAbi,
            functionName: 'get',
            args: [a.x, a.x] as never,
          }),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /no overload of "get" takes 2 argument/,
    );
    expect(e.message).toMatch(/get\(\), get\(uint256\)/);
  });

  test('malformed output type names the parameter', () => {
    const e = expectEvs(
      () => rec((s, a) => s.read({ address: a.who, abi: tupleAbi, functionName: 'observe' })),
      EvsTypeError,
      'ABI_SHAPE',
      /malformed tuple type/,
    );
    expect(e.message).toMatch(/output parameter "data"/);
    expect(e.message).toMatch(/"observe"/);
  });

  test('argument arity mismatch', () => {
    expectEvs(
      () =>
        rec((s, a) =>
          s.read({
            address: a.who,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [] as never,
          }),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expects 1 argument\(s\), got 0/,
    );
  });

  test('argument Expr type mismatch names the parameter', () => {
    expectEvs(
      () =>
        rec((s, a) =>
          s.read({
            address: a.who,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [a.x as never],
          }),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /args\[0\] \("owner"\).*expected 'address'/s,
    );
  });

  test('missing functionName / abi not an array / missing address', () => {
    expectEvs(
      () => rec((s, a) => s.read({ address: a.who, abi: erc20Abi } as never)),
      EvsTypeError,
      'ABI_SHAPE',
      /functionName/,
    );
    expectEvs(
      () => rec((s, a) => s.read({ address: a.who, abi: {}, functionName: 'x' } as never)),
      EvsTypeError,
      'ABI_SHAPE',
      /must be an ABI array/,
    );
    expectEvs(
      () => rec((s) => s.read({ abi: erc20Abi, functionName: 'decimals' } as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /`address` is required/,
    );
  });

  test('tryCall shares the same checks', () => {
    expectEvs(
      () =>
        rec((s, a) => s.tryRead({ address: a.who, abi: erc20Abi, functionName: 'nope' as never })),
      EvsTypeError,
      'ABI_SHAPE',
      /no function named "nope"/,
    );
  });
});

// ---------------------------------------------------------------------------
// foreign handles + scopes + sealing
// ---------------------------------------------------------------------------

describe('checklist: foreign handle / closed scope / use-after-seal', () => {
  test('cross-script Expr → FOREIGN_HANDLE naming both scripts', () => {
    let foreign: Expr<'uint256'> | undefined;
    evscript({ name: 'donor', args: [t.uint256] }, (s, v) => {
      foreign = v;
      return s.return({ v });
    });
    const e = expectEvs(
      () =>
        rec((s, a) => {
          if (foreign === undefined) throw new Error('unreachable');
          return s.add(a.x, foreign);
        }),
      EvsScopeError,
      'FOREIGN_HANDLE',
      /belongs to script "donor".*script "tst"/s,
    );
    expect(e.message).toMatch(/this Expr \(Expr<uint256> #\d+/);
  });

  test('forged handle-shaped object → FOREIGN_HANDLE', () => {
    expectEvs(
      () => rec((s, a) => s.add(a.x, { type: 'uint256' } as never)),
      EvsScopeError,
      'FOREIGN_HANDLE',
      /not created by this copy of evs/,
    );
  });

  test('if-branch value used after the branch closes', () => {
    const e = expectEvs(
      () =>
        rec((s, a) => {
          let leaked: Expr<'uint256'> | undefined;
          s.if(a.flag, () => {
            leaked = a.x.add(1n);
          });
          if (leaked === undefined) throw new Error('unreachable');
          return s.return({ leaked });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /if-then block that has finished recording/,
    );
    expect(e.message).toMatch(/cells \(s\.let\)/);
    expect(e.message).toMatch(/this value \(Expr<uint256> #\d+\)/);
  });

  test('while-body value used after the loop closes', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          let leaked: Expr<'uint256'> | undefined;
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(a.x),
            () => {
              leaked = i.get();
              i.set(a.x);
            },
          );
          if (leaked === undefined) throw new Error('unreachable');
          return s.return({ leaked });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /while-body block that has finished recording/,
    );
  });

  test('cell declared inside a branch used after it', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          let leaked: { get(): Expr<'uint256'> } | undefined;
          s.if(a.flag, () => {
            leaked = s.let(t.uint256, 1n);
          });
          if (leaked === undefined) throw new Error('unreachable');
          return s.return({ v: leaked.get() });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /cell \(Cell<uint256> #\d+\) was declared in a if-then block/,
    );
  });

  test('builder used after evscript returns → RECORDING_CLOSED', () => {
    let escaped: AnyBuilder | undefined;
    let escapedArg: Expr<'uint256'> | undefined;
    rec((s, a) => {
      escaped = s;
      escapedArg = a.x;
      return s.return({ x: a.x });
    });
    expectEvs(
      () => escaped?.add(escapedArg as Expr<'uint256'>, 1n),
      EvsScopeError,
      'RECORDING_CLOSED',
      /sealed — s\.return/,
    );
  });

  test('Expr method after seal → RECORDING_CLOSED', () => {
    let x: Expr<'uint256'> | undefined;
    rec((s, a) => {
      x = a.x;
      return s.return({ x: a.x });
    });
    expectEvs(() => x?.add(1n), EvsScopeError, 'RECORDING_CLOSED', /sealed/);
  });

  test('builder calls after s.return but inside the callback → RECORDING_CLOSED', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          const token = s.return({ x: a.x });
          s.lit(t.uint256, 1n); // sealed already
          return token;
        }),
      EvsScopeError,
      'RECORDING_CLOSED',
      /sealed/,
    );
  });
});

// ---------------------------------------------------------------------------
// s.return discipline
// ---------------------------------------------------------------------------

describe('checklist: s.return missing / duplicated / inside a block / bad keys', () => {
  test('missing s.return', () => {
    expectEvs(
      () => rec(() => undefined),
      EvsTypeError,
      'TYPE_MISMATCH',
      /completed without calling s\.return/,
    );
  });

  test('s.return inside s.if → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          s.if(a.flag, () => {
            s.return({ x: a.x });
          });
          return s.return({ x: a.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /cannot be recorded inside a if-then block/,
    );
  });

  test('s.return inside a while body → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          s.while(
            () => a.flag,
            () => {
              s.return({ x: a.x });
            },
          );
          return s.return({ x: a.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /while-body/,
    );
  });

  test('duplicated s.return → RECORDING_CLOSED', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          s.return({ x: a.x });
          return s.return({ x: a.x });
        }),
      EvsScopeError,
      'RECORDING_CLOSED',
      /sealed/,
    );
  });

  test('callback returning something other than its own s.return token', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          s.return({ x: a.x });
          return {};
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must return the value produced by THIS script's s\.return/,
    );
  });

  test('empty-string return key → ABI_SHAPE', () => {
    expectEvs(
      () => rec((s, a) => s.return({ '': a.x })),
      EvsTypeError,
      'ABI_SHAPE',
      /empty-string return keys/,
    );
  });

  test('empty return record → ABI_SHAPE (it would ABI-encode to 0x, issue #66)', () => {
    expectEvs(
      // the type-level guard rejects `{}` too; cast past it to reach the runtime check
      () => rec((s) => s.return({} as never)),
      EvsTypeError,
      'ABI_SHAPE',
      /at least one value[\s\S]*returned no data/,
    );
  });

  test('non-identifier return key → ABI_SHAPE', () => {
    expectEvs(
      () => rec((s, a) => s.return({ 'a b': a.x })),
      EvsTypeError,
      'ABI_SHAPE',
      /invalid return key/,
    );
  });

  test('literal return values are rejected (Exprs only)', () => {
    expectEvs(
      () => rec((s) => s.return({ x: 1n as never })),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must be an Expr/,
    );
  });

  test('composite literals in s.return are rejected, each with the constructor that fits', () => {
    // s.return infers the return ABI from handles and never coerces a literal: every literal
    // needs s.lit (or, by shape, s.tuple for a struct / s.newArray for a tuple[])
    const cases: readonly (readonly [unknown, RegExp])[] = [
      [
        [{ a: 1n }, { a: 2n }],
        /\(tuple\[\]\) literal with s\.lit\(t\.array\(type\), value\), or build one with s\.newArray\(type, n\)/,
      ],
      [
        { a: 1n },
        /struct literal with s\.lit\(type, value\) or build it with s\.tuple\(type, value\)/,
      ],
      [[[1n, 2n], [3n]], /type a literal with s\.lit\(type, value\)/],
      [['a', 'bc'], /type a literal with s\.lit\(type, value\)/],
    ];
    for (const [literal, fix] of cases) {
      const e = expectEvs(
        () => rec((s) => s.return({ v: literal as never })),
        EvsTypeError,
        'TYPE_MISMATCH',
        /s\.return\(\) value "v": must be an Expr, Tuple or MutArray handle/,
      );
      expect(e.message).toMatch(fix);
    }
  });

  test('call results in s.return get the call-result fix, not the literal one', () => {
    // a multi-output s.read result is a frozen array of handles and a try verb's result is a
    // { success, value } host object: neither is a literal, so neither may get the s.tuple /
    // s.newArray hint (or the "a literal has no type here" lead)
    const multiAbi = [
      {
        type: 'function',
        name: 'multi',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          { name: 'a', type: 'uint256' },
          { name: 'b', type: 'uint256' },
        ],
      },
    ] as const satisfies Abi;
    const cases: readonly (readonly [(s: AnyBuilder, a: Args) => unknown, RegExp])[] = [
      [
        (s, a) => s.read({ address: a.who, abi: multiAbi, functionName: 'multi' }),
        /array of handles \(such as a multi-output s\.read result\).*struct: true/,
      ],
      [
        (s) => [s.lit(t.uint256, 1n), s.lit(t.uint256, 2n)],
        /array of handles .*return each element under its own key/,
      ],
      [
        (s, a) => s.tryRead({ address: a.who, abi: erc20Abi, functionName: 'decimals' }),
        /try-verb result \(\{ success, value \}\).*return \.success and \.value/,
      ],
      [
        (s, a) => s.tryRead({ address: a.who, abi: multiAbi, functionName: 'multi' }),
        /try-verb result \(\{ success, value \}\)/,
      ],
    ];
    for (const [make, fix] of cases) {
      const e = expectEvs(
        () => rec((s, a) => s.return({ v: make(s, a) as never })),
        EvsTypeError,
        'TYPE_MISMATCH',
        /s\.return\(\) value "v": must be an Expr, Tuple or MutArray handle/,
      );
      expect(e.message).toMatch(fix);
      expect(e.message).not.toMatch(/a literal has no type|s\.tuple\(type, value\)|tuple\[\]/);
    }
  });
});

// ---------------------------------------------------------------------------
// LoopCtl scoping
// ---------------------------------------------------------------------------

describe('checklist: LoopCtl outside its loop', () => {
  test('escaped LoopCtl used after the loop → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          let escaped: LoopCtl | undefined;
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(a.x),
            (loop) => {
              escaped = loop;
              i.set(a.x);
            },
          );
          escaped?.break();
          return s.return({ x: a.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /outside its owning loop/,
    );
  });

  test("outer loop's LoopCtl used inside an inner loop → SCOPE_VIOLATION", () => {
    expectEvs(
      () =>
        rec((s, a) => {
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(a.x),
            (outer) => {
              s.while(
                () => i.get().lt(a.x),
                () => {
                  outer.break();
                },
              );
              i.set(a.x);
            },
          );
          return s.return({ x: a.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /belongs to an outer loop/,
    );
  });

  test('LoopCtl inside an s.fn body (isolated stack) → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          const i = s.let(t.uint256, 0n);
          s.while(
            () => i.get().lt(a.x),
            (loop) => {
              s.fn('f', [] as const, () => {
                loop.continue();
              });
              i.set(a.x);
            },
          );
          return s.return({ x: a.x });
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /outside its owning loop/,
    );
  });
});

// ---------------------------------------------------------------------------
// s.fn discipline
// ---------------------------------------------------------------------------

describe('checklist: s.fn capture / results / params / return-inside', () => {
  test('capturing an outer Expr → SCOPE_VIOLATION naming the captured value', () => {
    const e = expectEvs(
      () =>
        rec((s, a) =>
          s.fn('meta', [namedArg('token', t.address)] as const, (token) =>
            s.read({
              address: token,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [a.who], // outer capture!
            }),
          ),
        ),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /s\.fn\("meta"\) bodies cannot capture/,
    );
    expect(e.message).toMatch(/captured Expr<address> #\d+ ← args\.arg1/);
  });

  test('capturing an outer Cell → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s) => {
          const c = s.let(t.uint256, 0n);
          return s.fn('grab', [] as const, () => c.get());
        }),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /cannot capture cells/,
    );
  });

  test('fn body returning a literal → TYPE_MISMATCH', () => {
    expectEvs(
      () => rec((s) => s.fn('bad', [] as const, () => 5n as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /must return an Expr, a Tuple, a MutArray, a readonly array of those, or void/,
    );
  });

  test('fn call arity mismatch', () => {
    expectEvs(
      () =>
        rec((s) => {
          const f = s.fn(
            'two',
            [namedArg('a', t.uint256), namedArg('b', t.uint256)] as const,
            (a, b) => a.add(b),
          );
          return (f as (...args: unknown[]) => unknown)(1n);
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expects 2 argument\(s\), got 1/,
    );
  });

  test('duplicate / invalid fn param names; deferred param types', () => {
    expectEvs(
      () =>
        rec((s) =>
          s.fn('d', [namedArg('a', t.uint256), namedArg('a', t.uint8)] as const, () => {}),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /duplicate param name/,
    );
    // a tuple written as a STRING is a misuse (TYPE_MISMATCH); a composite param proper (a
    // t.struct / t.tuple descriptor) is supported (#37), pinned in script.test.ts
    expectEvs(
      () => rec((s) => s.fn('d', [{ name: 'a', type: 'tuple' }] as never, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /descriptor/,
    );
  });

  test('s.return inside an s.fn body → SCOPE_VIOLATION', () => {
    expectEvs(
      () =>
        rec((s) =>
          s.fn('r', [namedArg('a', t.uint256)] as const, (a) => {
            s.return({ a });
          }),
        ),
      EvsScopeError,
      'SCOPE_VIOLATION',
      /inside an s\.fn body/,
    );
  });

  test('invalid fn name', () => {
    expectEvs(
      () => rec((s) => s.fn('not a name', [] as const, () => {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /non-empty identifier/,
    );
  });
});

// ---------------------------------------------------------------------------
// staging traps
// ---------------------------------------------------------------------------

/* oxlint-disable typescript/restrict-template-expressions, typescript/no-base-to-string --
 * every flagged expression below is a deliberate staging MISUSE: the trap throwing is the test. */

describe('staging traps', () => {
  function withHandle(run: (x: Expr<'uint256'>) => void): void {
    rec((s, a) => {
      run(a.x);
      return s.return({ x: a.x });
    });
  }

  test('x + 1 (primitive coercion) throws EvsStagingError citing the recording site', () => {
    const e = expectEvs(
      () =>
        withHandle((x) => {
          // oxlint-disable-next-line no-unused-expressions -- the misuse IS the test
          (x as never) + 1;
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
    expect(e.message).toMatch(/Expr<uint256> #\d+/);
  });

  test('template literal interpolation throws', () => {
    expectEvs(
      () =>
        withHandle((x) => {
          void `${x as never}`;
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
  });

  test('JSON.stringify throws (toJSON trap)', () => {
    expectEvs(
      () =>
        withHandle((x) => {
          JSON.stringify(x);
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /toJSON/,
    );
  });

  test('String(x) throws (toString trap)', () => {
    expectEvs(
      () =>
        withHandle((x) => {
          String(x);
        }),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
  });

  test('a Tuple whose struct has toJSON / toString / valueOf FIELDS still trips the traps', () => {
    // the handle member wins over the field (the field is read through .at(i))
    const Traps = t.struct({ toJSON: t.uint8, toString: t.uint8, valueOf: t.uint8 });
    const misuse =
      (body: (h: never) => void): (() => unknown) =>
      () =>
        evscript({ name: 'traps', args: [Traps] }, (s, h) => {
          body(h as never);
          return s.return({ x: h.at(0).get() });
        });
    expectEvs(
      misuse((h) => JSON.stringify(h)),
      EvsStagingError,
      'STAGING_MISUSE',
      /toJSON/,
    );
    expectEvs(
      misuse((h) => void `${h}`),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
    expectEvs(
      misuse((h) => void (h + 1)),
      EvsStagingError,
      'STAGING_MISUSE',
      /staged handle/,
    );
  });

  test('node inspect (console.log) is NON-throwing and shows type/id/name', () => {
    rec((s, a) => {
      const printed = inspect(a.x);
      expect(printed).toMatch(/^Expr<uint256> #0 ← args\.arg0$/);
      const sym = s.read({
        address: a.who,
        abi: erc20Abi,
        functionName: 'decimals',
      });
      expect(inspect(sym)).toMatch(/^Expr<uint8> #\d+ ← s\.read\(decimals\)$/);
      return s.return({ x: a.x });
    });
  });

  test('a Cell or MutArray where an Expr is expected gets a targeted message', () => {
    expectEvs(
      () =>
        rec((s, a) => {
          const c = s.let(t.uint256, 0n);
          return s.add(a.x, c as never);
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /Cell is not an Expr.*\.get\(\)/s,
    );
    // A bare MutArray IS returnable now (issue #5 ask #5), but using it where a WORD value is
    // required (arithmetic) still gets the targeted "use .expr()" message — the guard is narrowed,
    // not deleted.
    expectEvs(
      () =>
        rec((s) => {
          const a = s.newArray(t.uint256, 1n);
          return s.return({ x: s.add(a as never, 1n) });
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /MutArray is not an Expr.*\.expr\(\)/s,
    );
  });
});

// ---------------------------------------------------------------------------
// tuple literals — unknown keys, staged handles, abitype's naming rule, own properties
// ---------------------------------------------------------------------------

describe('checklist: tuple literals', () => {
  const ALICE = '0x00000000000000000000000000000000000000a1';
  const Pair = t.struct({ token: t.address, fee: t.uint24 });
  const PairErr = t.error('PairErr', [namedArg('p', Pair)]);
  const PAIR = { name: 'p', type: 'tuple', components: Pair.components } as const;
  const pairAbi = [
    {
      type: 'function',
      name: 'take',
      stateMutability: 'view',
      inputs: [PAIR],
      outputs: [{ name: '', type: 'bool' }],
    },
    {
      type: 'function',
      name: 'takeMany',
      stateMutability: 'view',
      inputs: [{ ...PAIR, type: 'tuple[]' }],
      outputs: [{ name: '', type: 'bool' }],
    },
  ] as const satisfies Abi;
  // a tuple only partly named (common in verified ABIs): its literal is positional
  const Mixed = t.fromAbiParameter({
    name: 'm',
    type: 'tuple',
    components: [
      { name: 'amount', type: 'uint256' },
      { name: '', type: 'address' },
    ],
  });

  /** Records a throwaway script that declares `PairErr` (for the s.throw slot). */
  function recT(body: (s: AnyBuilder, who: Expr<'address'>) => unknown): void {
    evscript({ name: 'tstTuple', args: [t.address], errors: [PairErr] }, ((
      s: AnyBuilder,
      who: Expr<'address'>,
    ) => body(s, who)) as never);
  }

  /** Every position that coerces a value to the `Pair` struct, fed the value `make` builds. */
  const slots: readonly (readonly [
    string,
    (s: AnyBuilder, who: Expr<'address'>, make: (s: AnyBuilder) => unknown) => unknown,
  ])[] = [
    ['s.tuple init', (s, _who, make) => s.tuple(Pair, make(s) as never)],
    [
      'Field.set',
      (s, _who, make) => s.tuple(t.struct({ inner: Pair }), {}).inner.set(make(s) as never),
    ],
    ['Cell.set', (s, _who, make) => s.let(s.tuple(Pair, {}).expr()).set(make(s) as never)],
    ['MutArray.set', (s, _who, make) => s.newArray(Pair, 1n).set(0n, make(s) as never)],
    [
      'struct call arg',
      (s, who, make) =>
        s.read({ address: who, abi: pairAbi, functionName: 'take', args: [make(s) as never] }),
    ],
    [
      'tuple[] literal element',
      (s, who, make) =>
        s.read({
          address: who,
          abi: pairAbi,
          functionName: 'takeMany',
          args: [[make(s)] as never],
        }),
    ],
    ['s.fn param', (s, _who, make) => s.fn('feeOf', Pair, (p) => p.fee.get())(make(s) as never)],
    ['s.throw arg', (s, _who, make) => s.throw(PairErr, { p: make(s) } as never)],
  ];

  test.each(slots)('%s: an unknown key is TYPE_MISMATCH naming it', (_name, slot) => {
    expectEvs(
      () => recT((s, who) => slot(s, who, () => ({ token: who, fe: 3000 }))),
      EvsTypeError,
      'TYPE_MISMATCH',
      /unknown member "fe" \(expected: token, fee\)/,
    );
  });

  test.each(slots)('%s: a Cell / MutArray / Field is not a tuple', (_name, slot) => {
    expectEvs(
      () => recT((s, who) => slot(s, who, (b) => b.let(b.tuple(Pair, { token: who }).expr()))),
      EvsTypeError,
      'TYPE_MISMATCH',
      /a Cell is not a tuple — read it with \.get\(\)/,
    );
    expectEvs(
      () => recT((s, who) => slot(s, who, (b) => b.let(t.uint256, 1n))),
      EvsTypeError,
      'TYPE_MISMATCH',
      /a Cell is not a tuple/,
    );
    expectEvs(
      () => recT((s, who) => slot(s, who, (b) => b.newArray(t.uint256, 2n))),
      EvsTypeError,
      'TYPE_MISMATCH',
      /a MutArray is not a tuple/,
    );
    expectEvs(
      () => recT((s, who) => slot(s, who, (b) => b.tuple(t.struct({ inner: Pair }), {}).inner)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /a Field is not a tuple — read it with \.get\(\)/,
    );
  });

  test('s.tuple init: a Tuple / Expr handle is not a member literal', () => {
    expectEvs(
      () => recT((s, who) => s.tuple(Pair, s.tuple(Pair, { token: who }) as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.tuple\(\): init must be a literal of members, not a handle/,
    );
    expectEvs(
      () => recT((s, who) => s.tuple(Pair, s.tuple(Pair, { token: who }).expr() as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /not a handle/,
    );
  });

  test('a fully unnamed tuple rejects an index-keyed record (write the array)', () => {
    const P = t.tuple(t.uint256, t.address);
    expectEvs(
      () => recT((s, who) => s.tuple(P, { 0: 1n, 1: who } as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /takes a positional array of its 2 member\(s\) \(\[0\], \[1\]\), not a record/,
    );
  });

  test('a partly named tuple takes a positional array (abitype/viem rule)', () => {
    // records: the positional literal, a partial one (omitted → zero), and nested in a struct
    const script = evscript({ name: 'mixed', args: [t.address] }, (s, who) => {
      const m = s.tuple(Mixed, [1n, who]);
      const partial = s.tuple(Mixed, [2n]);
      const outer = s.tuple(t.struct({ m: Mixed, tag: t.uint8 }), { m: [3n, ALICE], tag: 7 });
      return s.return({ m, partial, outer });
    });
    const inits = script.ir.body.flatMap((st) => (st.k === 'tuplenew' ? [st.inits.length] : []));
    expect(inits).toEqual([2, 1, 2, 2]);
    expectEvs(
      () => recT((s) => s.tuple(Mixed, { amount: 1n } as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /a tuple with an unnamed member takes a positional array of its 2 member\(s\) \(amount, \[1\]\), not a record/,
    );
    expectEvs(
      () => recT((s, who) => s.tuple(Mixed, [1n, who, 3n] as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /too many members — this tuple has 2, got 3/,
    );
    // a fully-named struct still rejects the positional form
    expectEvs(
      () => recT((s, who) => s.tuple(Pair, [who, 3000] as never)),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expects a name-keyed init record, not a positional array/,
    );
  });

  test('members are read from own properties only (Object.prototype names zero-fill)', () => {
    const Odd = t.struct({
      toString: t.uint256,
      constructor: t.address,
      valueOf: t.uint256,
      hasOwnProperty: t.bool,
      x: t.uint256,
    });
    const script = evscript({ name: 'odd', args: [] }, (s) =>
      // `as never`: TS checks an omitted `toString` against Object's own method
      s.return({ o: s.tuple(Odd, { x: 1n } as never) }),
    );
    const tn = script.ir.body.find((st) => st.k === 'tuplenew');
    expect(tn?.k === 'tuplenew' ? tn.inits.map((i) => i.index) : null).toEqual([4]);
    // s.throw: a missing param named like an Object.prototype method is a missing arg
    const OddErr = t.error('OddErr', [namedArg('toString', t.uint256)]);
    expectEvs(
      () =>
        evscript({ name: 'oddErr', args: [], errors: [OddErr] }, (s) => {
          (s.throw as (...args: unknown[]) => void)(OddErr, {});
          return s.return({ ok: s.lit(t.bool, true) });
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /missing arg "toString"/,
    );
  });
});

// ---------------------------------------------------------------------------
// custom errors — t.error / errors: [...] / s.throw (issue #15)
// ---------------------------------------------------------------------------

describe('custom errors (issue #15)', () => {
  const NoBalance = t.error('NoBalance', [namedArg('balance', t.uint256)]);
  const NotOwner = t.error('NotOwner');
  const BadPair = t.error('BadPair', [t.address, t.address]);

  /** records a throwaway script DECLARING the three errors above. */
  function recErr(body: (s: AnyBuilder, a: Args) => unknown): void {
    evscript(
      {
        name: 'tstErr',
        args: [t.uint256, t.address, t.bool, t.array(t.uint64), t.int8],
        errors: [NoBalance, NotOwner, BadPair],
      },
      ((
        s: AnyBuilder,
        x: Args['x'],
        who: Args['who'],
        flag: Args['flag'],
        xs: Args['xs'],
        s8: Args['s8'],
      ) => body(s, { x, who, flag, xs, s8 })) as never,
    );
  }

  test('t.error: invalid / reserved names are ERROR_DECL', () => {
    expectEvs(() => t.error('' as never), EvsTypeError, 'ERROR_DECL', /non-empty identifier/);
    expectEvs(() => t.error('has space' as never), EvsTypeError, 'ERROR_DECL', /identifier/);
    for (const name of [
      'Panic',
      'Error',
      'EvsDecodeError',
      'EvsInvalidCalldata',
      '_',
      // built-in decode arms of decodeScriptError / matchScriptError (issue #62)
      'empty',
      'unknown',
    ] as const) {
      expectEvs(() => t.error(name as never), EvsTypeError, 'ERROR_DECL', /reserved/);
    }
  });

  test('t.error: bad param types / duplicate param names rejected', () => {
    expectEvs(
      () => t.error('X', ['uint7' as never]),
      EvsTypeError,
      'TYPE_MISMATCH',
      /unknown type/,
    );
    expectEvs(
      () => t.error('X', [namedArg('a', t.uint256), namedArg('a', t.address)] as never),
      EvsTypeError,
      'ERROR_DECL',
      /duplicate param name "a"/,
    );
    // a bare param at position 1 resolves to arg1 — colliding with an explicit "arg1" name
    expectEvs(
      () => t.error('X', [namedArg('arg1', t.uint256), t.address] as never),
      EvsTypeError,
      'ERROR_DECL',
      /duplicate param name "arg1"/,
    );
  });

  test('def errors: a non-t.error value is ERROR_DECL', () => {
    expectEvs(
      () =>
        evscript({ name: 'bad', errors: [{ nope: true }] as never }, (s: AnyBuilder) =>
          s.return({ ok: s.lit(t.bool, true) }),
        ),
      EvsTypeError,
      'ERROR_DECL',
      /expected an error declared with t\.error/,
    );
  });

  test('def errors: duplicate names are ERROR_DECL', () => {
    const dup = t.error('NoBalance', [namedArg('balance', t.uint256)]);
    expectEvs(
      () =>
        evscript({ name: 'bad', errors: [NoBalance, dup] as never }, (s: AnyBuilder) =>
          s.return({ ok: s.lit(t.bool, true) }),
        ),
      EvsTypeError,
      'ERROR_DECL',
      /duplicate error name "NoBalance"/,
    );
  });

  test('def errors: a 4-byte selector clash with another declared error is ERROR_DECL', () => {
    // a real collision: burn(uint256) and collate_propagate_storage(bytes16) share 0x42966c68
    expectEvs(
      () =>
        evscript(
          {
            name: 'bad',
            errors: [
              t.error('burn', [t.uint256]),
              t.error('collate_propagate_storage', [t.bytes16]),
            ],
          },
          (s: AnyBuilder) => s.return({ ok: s.lit(t.bool, true) }),
        ),
      EvsTypeError,
      'ERROR_DECL',
      /errors\[1\]: error "collate_propagate_storage" has the same 4-byte selector \(0x42966c68\) as declared error "burn"/,
    );
  });

  test('def errors: a 4-byte selector clash with a built-in error is ERROR_DECL', () => {
    // the reserved-name check lives in t.error; a hand-built value (a t.error spread with the
    // name swapped) gets past it, so the selector check is what keeps decodeScriptError /
    // explainRevert from confusing it with the built-in
    const cases = [
      [
        { ...t.error('Foo', [t.uint256]), name: 'Panic' },
        /\(0x4e487b71\) as the built-in Panic\(uint256\)/,
      ],
      [
        { ...t.error('Foo', [t.string]), name: 'Error' },
        /\(0x08c379a0\) as the built-in Error\(string\)/,
      ],
      [
        { ...t.error('Foo', [t.uint256]), name: 'EvsDecodeError' },
        /as the built-in EvsDecodeError\(uint256\)/,
      ],
      [{ ...t.error('Foo'), name: 'EvsInvalidCalldata' }, /as the built-in EvsInvalidCalldata\(\)/],
    ] as const;
    for (const [decl, msg] of cases) {
      expectEvs(
        () =>
          evscript({ name: 'bad', errors: [decl] as never }, (s: AnyBuilder) =>
            s.return({ ok: s.lit(t.bool, true) }),
          ),
        EvsTypeError,
        'ERROR_DECL',
        msg,
      );
    }
  });

  test('s.throw of an UNDECLARED error is ERROR_UNDECLARED (record-time backstop)', () => {
    const Other = t.error('Other', [t.uint256]);
    expectEvs(
      () => rec((s, a) => (s.throw as (...args: unknown[]) => void)(Other, [a.x])),
      EvsTypeError,
      'ERROR_UNDECLARED',
      /error "Other" is not declared by script "tst"/,
    );
  });

  test('s.throw of a same-name but different-shape error names the mismatch', () => {
    const impostor = t.error('NoBalance', [namedArg('balance', t.address)]);
    expectEvs(
      () =>
        recErr((s, a) => (s.throw as (...args: unknown[]) => void)(impostor, { balance: a.who })),
      EvsTypeError,
      'ERROR_UNDECLARED',
      /declared, but with different params/,
    );
  });

  test('s.throw of a non-error value is TYPE_MISMATCH', () => {
    expectEvs(
      () => recErr((s) => (s.throw as (...args: unknown[]) => void)('NoBalance')),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expected an error declared with t\.error/,
    );
  });

  test('s.throw: a structurally-equal re-created error IS accepted', () => {
    const clone = t.error('NoBalance', [namedArg('balance', t.uint256)]);
    expect(() =>
      recErr((s, a) => {
        s.throw(clone, { balance: a.x });
        return s.return({ x: a.x });
      }),
    ).not.toThrow();
  });

  test('s.throw named-record args: missing / unknown / wrong-typed members rejected', () => {
    expectEvs(
      () => recErr((s) => (s.throw as (...args: unknown[]) => void)(NoBalance, {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /missing arg "balance"/,
    );
    expectEvs(
      () =>
        recErr((s, a) =>
          (s.throw as (...args: unknown[]) => void)(NoBalance, { balance: a.x, extra: 1n }),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /unknown arg "extra"/,
    );
    expectEvs(
      () =>
        recErr((s, a) => (s.throw as (...args: unknown[]) => void)(NoBalance, { balance: a.who })),
      EvsTypeError,
      'TYPE_MISMATCH',
      /arg "balance"/,
    );
    expectEvs(
      () => recErr((s, a) => (s.throw as (...args: unknown[]) => void)(NoBalance, [a.x])),
      EvsTypeError,
      'TYPE_MISMATCH',
      /named args record/,
    );
  });

  test('s.throw positional args: wrong arity / shape rejected', () => {
    expectEvs(
      () => recErr((s, a) => (s.throw as (...args: unknown[]) => void)(BadPair, [a.who])),
      EvsTypeError,
      'TYPE_MISMATCH',
      /expects 2 arg\(s\), got 1/,
    );
    expectEvs(
      () => recErr((s, a) => (s.throw as (...args: unknown[]) => void)(BadPair, { a: a.who })),
      EvsTypeError,
      'TYPE_MISMATCH',
      /positional args tuple/,
    );
  });

  test('s.throw zero-param error rejects args', () => {
    expectEvs(
      () => recErr((s) => (s.throw as (...args: unknown[]) => void)(NotOwner, {})),
      EvsTypeError,
      'TYPE_MISMATCH',
      /declares no parameters/,
    );
  });

  test('s.throw after s.return is RECORDING_CLOSED', () => {
    expectEvs(
      () =>
        recErr((s, a) => {
          const ret = s.return({ x: a.x });
          s.throw(NotOwner as never);
          return ret;
        }),
      EvsScopeError,
      'RECORDING_CLOSED',
      /sealed/,
    );
  });

  test('a declared-but-never-thrown error is allowed (Solidity parity)', () => {
    expect(() => recErr((s, a) => s.return({ x: a.x }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// revertReturns (issue #35) — recording-time checks
// ---------------------------------------------------------------------------

describe('checklist: revertReturns (issue #35)', () => {
  const quoterAbi = [
    {
      type: 'function',
      name: 'quote',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: [{ name: 'amountOut', type: 'uint256' }],
    },
  ] as const satisfies Abi;

  test('accepted on s.call / s.tryCall with word, dynamic and struct types', () => {
    expect(() =>
      rec((s, a) => {
        s.call({
          address: a.who,
          abi: quoterAbi,
          functionName: 'quote',
          revertReturns: [t.uint256, t.string, t.array(t.uint8), t.struct({ x: t.uint256 })],
        });
        s.tryCall({ address: a.who, abi: quoterAbi, functionName: 'quote', revertReturns: [] });
        return s.return({ x: a.x });
      }),
    ).not.toThrow();
  });

  test('rejected on s.read / s.tryRead (steers: a read never carries its result in revert data)', () => {
    const p = { abi: erc20Abi, functionName: 'decimals', revertReturns: [t.uint8] } as const;
    const cases = [
      ['read', (s: AnyBuilder, a: Args) => s.read({ address: a.who, ...p } as never)],
      ['tryRead', (s: AnyBuilder, a: Args) => s.tryRead({ address: a.who, ...p } as never)],
    ] as const;
    for (const [verb, body] of cases) {
      const e = expectEvs(
        () => rec(body),
        EvsTypeError,
        'TYPE_MISMATCH',
        /`revertReturns` is only supported on s\.call \/ s\.tryCall/,
      );
      expect(e.message).toMatch(new RegExp(`^s\\.${verb}\\(\\)`));
      expect(e.message).toMatch(/view\/pure read/);
    }
  });

  test('rejected on s.simulate / s.trySimulate (the trampoline frames the revert itself)', () => {
    const p = { abi: quoterAbi, functionName: 'quote', revertReturns: [t.uint256] } as const;
    const cases = [
      ['simulate', (s: AnyBuilder, a: Args) => s.simulate({ address: a.who, ...p } as never)],
      ['trySimulate', (s: AnyBuilder, a: Args) => s.trySimulate({ address: a.who, ...p } as never)],
    ] as const;
    for (const [verb, body] of cases) {
      const e = expectEvs(
        () => rec(body),
        EvsTypeError,
        'TYPE_MISMATCH',
        /`revertReturns` is only supported on s\.call \/ s\.tryCall/,
      );
      expect(e.message).toMatch(new RegExp(`^s\\.${verb}\\(\\)`));
      expect(e.message).toMatch(/trampoline/);
    }
  });

  test('rejected together with struct: true', () => {
    expectEvs(
      () =>
        rec((s, a) =>
          s.call({
            address: a.who,
            abi: quoterAbi,
            functionName: 'quote',
            revertReturns: [t.uint256],
            struct: true,
          } as never),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /`struct: true` cannot be combined with `revertReturns`.*t\.struct/,
    );
  });

  test('must be an array of types; a bad entry is named by index', () => {
    expectEvs(
      () =>
        rec((s, a) =>
          s.call({
            address: a.who,
            abi: quoterAbi,
            functionName: 'quote',
            revertReturns: t.uint256,
          } as never),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /`revertReturns` must be an array of types.*got "uint256"/,
    );
    expectEvs(
      () =>
        rec((s, a) =>
          s.call({
            address: a.who,
            abi: quoterAbi,
            functionName: 'quote',
            revertReturns: [t.uint256, 'uint257'],
          } as never),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /revertReturns\[1\]: expected a type.*got "uint257"/,
    );
    expectEvs(
      () =>
        rec((s, a) =>
          s.call({
            address: a.who,
            abi: quoterAbi,
            functionName: 'quote',
            revertReturns: [42n],
          } as never),
        ),
      EvsTypeError,
      'TYPE_MISMATCH',
      /revertReturns\[0\]: expected a type.*got 42n/,
    );
    expectEvs(
      () =>
        rec((s, a) =>
          s.call({
            address: a.who,
            abi: quoterAbi,
            functionName: 'quote',
            revertReturns: [{ type: 'tuple', components: [] }],
          } as never),
        ),
      EvsTypeError,
      'ABI_SHAPE',
      /revertReturns\[0\]: tuple type carries no components/,
    );
  });
});

// ---------------------------------------------------------------------------
// pathological type sizes: a 50,000-suffix chain used to overflow the host stack (a raw
// RangeError) and a static size past 2^53 bytes reached the assembler (EvsInternalError INTERNAL)
// ---------------------------------------------------------------------------

describe('checklist: pathological type sizes', () => {
  const deep = `uint256${'[]'.repeat(50_000)}`;
  const getterAbi = (type: string, components?: readonly unknown[]) =>
    [
      {
        type: 'function',
        name: 'get',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type, ...(components === undefined ? {} : { components }) }],
      },
    ] as never;

  test('a 50,000-suffix chain in an arg or a JSON-ABI output → UNSUPPORTED_V0', () => {
    expectEvs(
      () =>
        compile(
          evscript({ name: 'p', args: [t.uint256, deep as never] }, (s: AnyBuilder, a: unknown) =>
            s.return({ a } as never),
          ),
        ),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /nests arrays 50000 levels deep/,
    );
    expectEvs(
      () => rec((s, a) => s.read({ address: a.who, abi: getterAbi(deep), functionName: 'get' })),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /nests arrays 50000 levels deep/,
    );
  });

  test('a static size of 2^32 bytes or more → UNSUPPORTED_V0 at recording, not INTERNAL', () => {
    const huge = 'uint256[100000000][100000000]'; // 3.2e17 bytes
    expectEvs(
      () => rec((s, a) => s.tryRead({ address: a.who, abi: getterAbi(huge), functionName: 'get' })),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /output parameter #0 \(unnamed\): .*ABI static size of 320000000000000000 bytes/,
    );
    expectEvs(
      () =>
        evscript({ name: 'q', args: [t.address, huge as never] }, (s: AnyBuilder, a: unknown) =>
          s.return({ a } as never),
        ),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /ABI static size of 320000000000000000 bytes/,
    );
    expectEvs(
      () => t.array(t.array(t.uint256, 100_000_000), 100_000_000),
      EvsTypeError,
      'UNSUPPORTED_V0',
      /ABI static size/,
    );
  });

  test('a tuple-array output too large in total → UNSUPPORTED_V0 from compile(), not INTERNAL', () => {
    // each component passes its own check at recording; the 3.2e12-byte total is caught when the
    // output's layout is built
    const script = evscript({ name: 'r', args: [t.address] }, (s: AnyBuilder, who: unknown) => {
      const r = s.tryRead({
        address: who as never,
        abi: getterAbi('tuple[100000000]', [{ name: 'a', type: 'uint256[100]' }]),
        functionName: 'get',
      }) as { success: unknown };
      return s.return({ ok: r.success } as never);
    });
    expectEvs(() => compile(script), EvsTypeError, 'UNSUPPORTED_V0', /ABI static size/);
  });
});

describe('checklist: `__proto__` is not a name', () => {
  // `{ [PROTO]: x }` (a computed key) is an own property, so the name check sees it; assigning
  // `__proto__` on a plain object replaces the prototype instead, so every name that becomes an
  // object key rejects it. A literal `{ __proto__: x }` key never becomes an entry: the
  // prototype guard and the `NoProtoKey` type guard cover it (tests below).
  const PROTO = '__proto__';
  const RESERVED = /`__proto__` is reserved: assigning it on a JavaScript object/;

  test('namedArg / t.struct field / s.fn param → TYPE_MISMATCH', () => {
    expectEvs(() => namedArg(PROTO, t.uint256), EvsTypeError, 'TYPE_MISMATCH', RESERVED);
    expectEvs(
      // @ts-expect-error -- `NoProtoKey`: a `__proto__` key is a type error too
      () => t.struct({ [PROTO]: t.uint256, b: t.uint256 }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /field name "__proto__" is rejected — `__proto__` is reserved/,
    );
    expectEvs(
      () =>
        rec((s, a) => {
          s.fn('f', [{ name: PROTO, type: t.uint256 }] as never, (p: Expr<'uint256'>) => p);
          return s.return({ x: a.x });
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /s\.fn\("f"\) param #0: invalid param name "__proto__": `__proto__` is reserved/,
    );
  });

  test('t.error name / param → ERROR_DECL', () => {
    expectEvs(() => t.error(PROTO), EvsTypeError, 'ERROR_DECL', RESERVED);
    expectEvs(
      () => t.error('E', [{ name: PROTO, type: t.uint256 }] as never),
      EvsTypeError,
      'ERROR_DECL',
      /invalid param name "__proto__": `__proto__` is reserved/,
    );
  });

  test('s.return key → ABI_SHAPE (viem would drop it from the result object)', () => {
    expectEvs(
      // @ts-expect-error -- `NoProtoKey`: a `__proto__` key is a type error too
      () => rec((s, a) => s.return({ [PROTO]: a.x, y: a.x })),
      EvsTypeError,
      'ABI_SHAPE',
      /invalid return key "__proto__": `__proto__` is reserved/,
    );
  });

  // the usual spelling: a LITERAL key. JS turns it into the prototype (object / null value) or
  // drops it (a primitive value), so it never reaches `Object.entries`.
  test('t.struct with a literal `__proto__` key: an object/null value is caught at runtime', () => {
    const Inner = t.struct({ a: t.uint256 });
    expectEvs(
      // @ts-expect-error -- `NoProtoKey`
      () => t.struct({ __proto__: Inner, b: t.uint256 }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /t\.struct\(\): expected a plain object literal.*prototype was replaced.*`__proto__` is reserved/,
    );
    expectEvs(
      // @ts-expect-error -- `NoProtoKey` (and `null` is not a type)
      () => t.struct({ __proto__: null, b: t.uint256 }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /prototype was replaced/,
    );
    // a primitive value is dropped by JS before evs sees the record: only the type guard
    // (`NoProtoKey`, the @ts-expect-error) can reject it
    // @ts-expect-error -- `NoProtoKey`
    const dropped = t.struct({ __proto__: t.uint256, b: t.uint256 });
    expect(dropped).toEqual({ type: 'tuple', components: [{ name: 'b', type: 'uint256' }] });
    // a widened record type passes the type guard
    const plain: Record<string, 'uint256'> = { a: t.uint256 };
    expect(t.struct(plain).components).toEqual([{ name: 'a', type: 'uint256' }]);
  });

  test('s.return with a literal `__proto__` key → ABI_SHAPE (handle or null value)', () => {
    expectEvs(
      // @ts-expect-error -- `NoProtoKey`
      () => rec((s, a) => s.return({ __proto__: a.x, y: a.x })),
      EvsTypeError,
      'ABI_SHAPE',
      /s\.return\(\): expected a plain object literal.*prototype was replaced.*`__proto__` is reserved/,
    );
    expectEvs(
      // @ts-expect-error -- `NoProtoKey`
      () => rec((s, a) => s.return({ __proto__: null, y: a.x })),
      EvsTypeError,
      'ABI_SHAPE',
      /prototype was replaced/,
    );
  });

  test('a third-party struct with a `__proto__` member cannot enter the script ABI', () => {
    const protoAbi = [
      {
        type: 'function',
        name: 'get',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          {
            name: '',
            type: 'tuple',
            components: [
              { name: '__proto__', type: 'uint256' },
              { name: 'b', type: 'uint256' },
            ],
          },
        ],
      },
    ] as const satisfies Abi;
    // reading it is fine (`.at(0)`), returning the whole struct is not: viem's decoder would
    // silently drop the member from the result
    expectEvs(
      () =>
        rec((s, a) =>
          s.return({ r: s.read({ address: a.who, abi: protoAbi, functionName: 'get' }) }),
        ),
      EvsTypeError,
      'ABI_SHAPE',
      /return component "r": tuple field #0 has an invalid name "__proto__": `__proto__` is reserved/,
    );
  });

  test('a name-keyed record never picks up an inherited member (`toString`, …)', () => {
    // a third-party struct with a `toString` member: an init / throw-args record that omits it
    // must not read `Object.prototype.toString` (the member is zero / reported missing). The
    // `as never` casts: an object literal's apparent `toString` method never fits a word member.
    const S = t.fromOutputs(
      [
        {
          type: 'function',
          name: 'f',
          stateMutability: 'view',
          inputs: [],
          outputs: [
            { name: 'toString', type: 'uint256' },
            { name: 'b', type: 'uint256' },
          ],
        },
      ] as const,
      'f',
    );
    const script = evscript({ name: 'init', args: [t.uint256] }, (s, x) =>
      s.return({ v: s.tuple(S, { b: x } as never) }),
    );
    expect(() => validateIr(script.ir)).not.toThrow();
    const E = t.error('E', [namedArg('toString', t.uint256)]);
    expectEvs(
      () =>
        evscript({ name: 'thr', args: [t.uint256], errors: [E] }, (s, x) => {
          s.throw(E, {} as never);
          return s.return({ x });
        }),
      EvsTypeError,
      'TYPE_MISMATCH',
      /missing arg "toString" for error "E"/,
    );
  });

  test('validateIr rejects a deserialized arg named `__proto__`', () => {
    const script = evscript({ name: 'ok', args: [namedArg('x', t.uint256)] }, (s, x) =>
      s.return({ x }),
    );
    const [arg] = script.ir.args;
    expect(() => validateIr({ ...script.ir, args: [{ ...arg!, name: PROTO }] })).toThrow(
      /args\[0\] has an invalid name "__proto__": `__proto__` is reserved/,
    );
  });
});
